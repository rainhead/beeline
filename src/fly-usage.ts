import { pathToFileURL } from "node:url";

/**
 * What the machine used, against what it has (Peter, 2026-10-01).
 *
 * Fly keeps per-machine metrics in a Prometheus store reachable with a
 * read-only org token. This reads a window of them and says how close the
 * machine came to each of its limits; the `resource-budget` job runs it daily
 * and fails when a limit was crossed, which is what makes /healthz/jobs and
 * the job's Sentry check-in say so.
 *
 * Measured over 2026-09-12 to 10-01 on shared-cpu-2x, 2 GB, 10 GB volume: a
 * normal day uses ~0.003 cores, peaks at ~0.65 GB of memory, never touches
 * swap and holds ~2.5 GB on the volume. The one limit actually reached is the
 * CPU burst balance: shared vCPUs may run above their baseline only while the
 * balance lasts, and heavy batch work — a reseed, a big manual load — empties
 * it and is throttled for the rest of the run (15–40 minutes on the three days
 * it happened). So the balance is watched directly, rather than inferred from
 * usage against a baseline whose unit Fly does not state.
 */

export interface FlyMetricsTarget {
  /** A read-only org token (`fly tokens create readonly <org>`). */
  token: string;
  org: string;
  app: string;
}

export interface UsageSummary {
  hours: number;
  cpu: {
    meanCores: number;
    p95Cores: number;
    peakCores: number;
    /** Minutes in the window the burst balance was empty, i.e. the machine was held to its baseline. */
    balanceEmptyMinutes: number;
  };
  memory: { totalMb: number; peakUsedMb: number; peakSwapMb: number; oomExits: number };
  disk: { totalGb: number; usedGb: number };
}

/**
 * The limits the job fails on, in one place. Disk stops short of the 80% at
 * which Fly grows the volume (fly.toml), because growing it costs money and
 * is a decision, not a reflex. An hour of empty balance in a day is sustained
 * throttling rather than one reseed's worth.
 */
export const BUDGET = {
  memoryPeakFraction: 0.85,
  swapMb: 256,
  diskFraction: 0.7,
  balanceEmptyMinutes: 60,
} as const;

/**
 * Below this the balance is spent. It bottoms out at 1, not 0, and on a day
 * it is never spent its minimum is in the thousands (cap 100,000).
 */
const BALANCE_EMPTY = 100;

/** One sample per minute. */
const STEP_S = 60;

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

interface PromResult {
  status: string;
  data: { result: Array<{ metric: Record<string, string>; values?: Array<[number, string]>; value?: [number, string] }> };
}

export async function measureFlyUsage(
  target: FlyMetricsTarget,
  opts: { hours?: number; now?: Date; fetchImpl?: Fetch; step?: <T>(label: string, fn: () => Promise<T>) => Promise<T> } = {},
): Promise<UsageSummary> {
  const hours = opts.hours ?? 24;
  const end = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const start = end - hours * 3600;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as Fetch);
  const step = opts.step ?? (<T>(_label: string, fn: () => Promise<T>) => fn());
  const base = `https://api.fly.io/prometheus/${encodeURIComponent(target.org)}/api/v1`;
  const app = `app="${target.app}"`;

  const ask = async (label: string, path: string, params: Record<string, string>) =>
    step(label, async () => {
      const res = await fetchImpl(`${base}/${path}?${new URLSearchParams(params)}`, { headers: { Authorization: target.token } });
      if (!res.ok) throw new Error(`Fly metrics answered ${res.status} for ${label}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as PromResult;
      if (body.status !== "success") throw new Error(`Fly metrics refused ${label}`);
      return body.data.result;
    });
  const range = (label: string, query: string) =>
    ask(label, "query_range", { query, start: String(start), end: String(end), step: String(STEP_S) });
  const instant = async (label: string, query: string) =>
    Number((await ask(label, "query", { query, time: String(end) }))[0]?.value?.[1] ?? 0);
  /** One value per timestamp: the largest across series, so a machine replaced mid-window counts once. */
  const merged = (result: PromResult["data"]["result"]) => {
    const at = new Map<number, number>();
    for (const r of result) for (const [t, v] of r.values ?? []) at.set(t, Math.max(at.get(t) ?? -Infinity, Number(v)));
    return [...at.values()];
  };

  // fly_instance_cpu counts clock ticks (USER_HZ, a hundredth of a second),
  // not seconds: verified on 2026-10-01 against the machine's own /proc/stat,
  // which it matches tick for tick. Read as seconds it reports 100× the load.
  const cpu = merged(
    await range("cpu", `sum by (instance) (rate(fly_instance_cpu{${app},mode!~"idle|iowait|steal|guest|guest_nice"}[5m])) / 100`),
  ).sort((a, b) => a - b);
  const balance = merged(await range("cpu balance", `min(fly_instance_cpu_balance{${app}})`));
  const memUsed = merged(await range("memory", `max(fly_instance_memory_mem_total{${app}} - fly_instance_memory_mem_available{${app}})`));
  const swapUsed = merged(await range("swap", `max(fly_instance_memory_swap_total{${app}} - fly_instance_memory_swap_free{${app}})`));
  const memTotal = await instant("memory total", `max(fly_instance_memory_mem_total{${app}})`);
  const oom = await instant("oom exits", `max(max_over_time(fly_instance_exit_oom{${app}}[${hours}h]))`);
  const disk = `${app},mount="/app/data"`;
  const diskUsed = await instant(
    "disk used",
    `max((fly_instance_filesystem_blocks{${disk}} - fly_instance_filesystem_blocks_avail{${disk}}) * fly_instance_filesystem_block_size{${disk}})`,
  );
  const diskTotal = await instant("disk total", `max(fly_instance_filesystem_blocks{${disk}} * fly_instance_filesystem_block_size{${disk}})`);

  const MB = 1024 * 1024;
  const round = (n: number, places: number) => Number(n.toFixed(places));
  return {
    hours,
    cpu: {
      meanCores: round(cpu.reduce((a, v) => a + v, 0) / (cpu.length || 1), 4),
      p95Cores: round(cpu[Math.floor(0.95 * Math.max(cpu.length - 1, 0))] ?? 0, 4),
      peakCores: round(cpu.at(-1) ?? 0, 2),
      balanceEmptyMinutes: (balance.filter((b) => b < BALANCE_EMPTY).length * STEP_S) / 60,
    },
    memory: {
      totalMb: Math.round(memTotal / MB),
      peakUsedMb: Math.round(Math.max(0, ...memUsed) / MB),
      peakSwapMb: Math.round(Math.max(0, ...swapUsed) / MB),
      oomExits: oom,
    },
    disk: { totalGb: round(diskTotal / 1e9, 2), usedGb: round(diskUsed / 1e9, 2) },
  };
}

/** Each limit the window crossed, in words; empty when it stayed inside all of them. */
export function budgetProblems(s: UsageSummary): string[] {
  const out: string[] = [];
  if (s.memory.oomExits > 0) out.push(`the machine was killed for running out of memory (${s.memory.oomExits} time(s))`);
  if (s.memory.totalMb > 0 && s.memory.peakUsedMb >= BUDGET.memoryPeakFraction * s.memory.totalMb) {
    out.push(`memory peaked at ${s.memory.peakUsedMb} MB of ${s.memory.totalMb} MB`);
  }
  if (s.memory.peakSwapMb >= BUDGET.swapMb) out.push(`${s.memory.peakSwapMb} MB of swap in use`);
  if (s.disk.totalGb > 0 && s.disk.usedGb >= BUDGET.diskFraction * s.disk.totalGb) {
    out.push(`the volume is ${Math.round((100 * s.disk.usedGb) / s.disk.totalGb)}% full (${s.disk.usedGb} of ${s.disk.totalGb} GB); Fly grows it at 80%`);
  }
  if (s.cpu.balanceEmptyMinutes >= BUDGET.balanceEmptyMinutes) {
    out.push(`the CPU burst balance was empty for ${s.cpu.balanceEmptyMinutes} minutes, holding the machine to its baseline`);
  }
  return out;
}

/** One line for job_run.detail. */
export function describeUsage(s: UsageSummary): string {
  return (
    `last ${s.hours}h: CPU mean ${s.cpu.meanCores} cores, p95 ${s.cpu.p95Cores}, peak ${s.cpu.peakCores}; ` +
    `burst balance empty ${s.cpu.balanceEmptyMinutes} min; memory peak ${s.memory.peakUsedMb}/${s.memory.totalMb} MB, ` +
    `swap ${s.memory.peakSwapMb} MB, OOM exits ${s.memory.oomExits}; volume ${s.disk.usedGb}/${s.disk.totalGb} GB`
  );
}

// CLI: FLY_METRICS_TOKEN=... pnpm fly:usage [hours]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const token = process.env.FLY_METRICS_TOKEN;
  if (token === undefined || token === "") {
    console.error("FLY_METRICS_TOKEN must hold a read-only org token: fly tokens create readonly osu-mm --expiry 24h");
    process.exit(2);
  }
  const hours = Number(process.argv[2] ?? 24);
  const summary = await measureFlyUsage(
    { token, org: process.env.BEELINE_FLY_ORG ?? "osu-mm", app: process.env.FLY_APP_NAME ?? "beeline" },
    { hours },
  );
  console.log(JSON.stringify({ ...summary, problems: budgetProblems(summary) }, null, 2));
}
