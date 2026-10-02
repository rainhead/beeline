import { afterEach, describe, expect, test, vi } from "vitest";
import { BUDGET, budgetProblems, describeUsage, measureFlyUsage, type UsageSummary } from "../src/fly-usage.js";
import { buildJobs } from "../src/app/jobs/registry.js";
import { configFromEnv } from "../src/app/config.js";

/**
 * The machine's usage against its limits (src/fly-usage.ts). Fly's metrics
 * API is a Prometheus store; the fake below answers each query by what it
 * asks for, in Prometheus's own response shape. The numbers are the shape of
 * the sandbox's 2026-10-01: a reseed day, the burst balance spent for a while,
 * memory peaking at 1.3 GB of 2 GB.
 */

const MB = 1024 * 1024;
const NOW = new Date("2026-10-02T12:00:00Z");
const T0 = NOW.getTime() / 1000 - 3 * 60;

type Series = Array<{ metric: Record<string, string>; values?: Array<[number, string]>; value?: [number, string] }>;
const over = (vals: number[], metric: Record<string, string> = {}) => ({ metric, values: vals.map((v, i) => [T0 + 60 * i, String(v)] as [number, string]) });
const at = (v: number) => [{ metric: {}, value: [NOW.getTime() / 1000, String(v)] as [number, string] }];

function fakeFly(answers: Array<[RegExp, Series]>) {
  const asked: string[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => {
    const query = new URL(url).searchParams.get("query") ?? "";
    asked.push(query);
    expect(init.headers.Authorization).toBe("FlyV1 read-only");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const hit = answers.find(([re]) => re.test(query));
    if (hit === undefined) throw new Error(`unexpected query ${query}`);
    return { ok: true, status: 200, json: async () => ({ status: "success", data: { result: hit[1] } }), text: async () => "" };
  };
  return { fetchImpl, asked };
}

const RESEED_DAY: Array<[RegExp, Series]> = [
  // A machine replaced mid-window reports under a second instance: one
  // timestamp, one value — the larger.
  [/fly_instance_cpu\{/, [over([0.002, 0.48, 0.003]), over([0.001, 0.3, 0.004], { instance: "new" })]],
  [/cpu_balance/, [over([100000, 1, 1])]],
  [/mem_available/, [over([600 * MB, 1302 * MB, 700 * MB])]],
  [/swap_free/, [over([0, 5 * MB, 2 * MB])]],
  [/max\(fly_instance_memory_mem_total/, [over([1968 * MB, 1968 * MB, 1968 * MB])]],
  [/exit_oom/, at(0)],
  // The peak across the window: an export written and removed before 4am still filled the disk.
  [/blocks_avail/, [over([2.36e9, 2.9e9, 2.36e9])]],
  [/filesystem_blocks\{[^}]*\} \* /, [over([10.45e9, 10.45e9, 10.45e9])]],
];

const target = { token: "FlyV1 read-only", org: "osu-mm", app: "beeline" };

describe("measuring", () => {
  test("summarises a window of Fly's metrics", async () => {
    const { fetchImpl, asked } = fakeFly(RESEED_DAY);
    expect(await measureFlyUsage(target, { now: NOW, fetchImpl })).toEqual({
      hours: 24,
      cpu: { meanCores: 0.162, p95Cores: 0.004, peakCores: 0.48, balanceEmptyMinutes: 2 },
      memory: { totalMb: 1968, peakUsedMb: 1302, peakSwapMb: 5, oomExits: 0 },
      disk: { totalGb: 10.45, usedGb: 2.9 },
    });
    // fly_instance_cpu counts clock ticks: read as seconds it says 100× the load.
    expect(asked.find((q) => q.includes("fly_instance_cpu{"))).toMatch(/\/ 100$/);
    expect(asked.every((q) => q.includes('app="beeline"'))).toBe(true);
  });

  test("a metric with no samples is an error, never a zero inside the limit", async () => {
    const { fetchImpl } = fakeFly(RESEED_DAY.map(([re, s]) => [re, /mem_available/.test(re.source) ? [] : s]));
    await expect(measureFlyUsage(target, { now: NOW, fetchImpl })).rejects.toThrow("Fly metrics have no memory samples for the last 24h");
  });

  test("no exit recorded is no OOM kill", async () => {
    const { fetchImpl } = fakeFly(RESEED_DAY.map(([re, s]) => [re, /exit_oom/.test(re.source) ? [] : s]));
    expect((await measureFlyUsage(target, { now: NOW, fetchImpl })).memory.oomExits).toBe(0);
  });

  test("an answer that is not a success is an error naming the query", async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "unauthorized" });
    await expect(measureFlyUsage(target, { now: NOW, fetchImpl })).rejects.toThrow("Fly metrics answered 401 for cpu: unauthorized");
  });
});

const QUIET: UsageSummary = {
  hours: 24,
  cpu: { meanCores: 0.003, p95Cores: 0.004, peakCores: 0.08, balanceEmptyMinutes: 0 },
  memory: { totalMb: 1968, peakUsedMb: 640, peakSwapMb: 0, oomExits: 0 },
  disk: { totalGb: 10.45, usedGb: 2.4 },
};

describe("the budget", () => {
  test("a normal day is inside every limit, and a reseed's spent balance is too", () => {
    expect(budgetProblems(QUIET)).toEqual([]);
    expect(budgetProblems({ ...QUIET, cpu: { ...QUIET.cpu, balanceEmptyMinutes: 40 } })).toEqual([]);
  });

  test("each limit is named when it is crossed", () => {
    expect(
      budgetProblems({
        ...QUIET,
        cpu: { ...QUIET.cpu, balanceEmptyMinutes: BUDGET.balanceEmptyMinutes },
        memory: { totalMb: 1968, peakUsedMb: 1700, peakSwapMb: 300, oomExits: 1 },
        disk: { totalGb: 10, usedGb: 7.5 },
      }),
    ).toEqual([
      "the machine was killed for running out of memory (1 time(s))",
      "memory peaked at 1700 MB of 1968 MB",
      "300 MB of swap in use",
      "the volume reached 75% full (7.5 of 10 GB); Fly grows it at 80%",
      "the CPU burst balance was empty for 60 minutes, holding the machine to its baseline",
    ]);
  });
});

describe("the resource-budget job", () => {
  afterEach(() => vi.unstubAllGlobals());
  const config = { syncProjects: [], sweepDays: 365, personChangesPath: "x", sampleChangesPath: "x", sampleStatePath: "x" };
  const job = (flyMetrics: typeof target | null) => buildJobs({ ...config, flyMetrics }).find((j) => j.name === "resource-budget")!;
  const ctx = { step: <T>(_l: string, fn: () => Promise<T>) => fn(), signal: new AbortController().signal } as never;

  test("off Fly it says there is nothing to measure", async () => {
    expect(await job(null).run(ctx)).toMatch(/^not on Fly/);
  });

  test("says what the day used, and fails when a limit was crossed", async () => {
    vi.stubGlobal("fetch", fakeFly(RESEED_DAY).fetchImpl);
    expect(await job(target).run(ctx)).toBe(describeUsage(await measureFlyUsage(target, { fetchImpl: fakeFly(RESEED_DAY).fetchImpl })));
    const full: Array<[RegExp, Series]> = RESEED_DAY.map(([re, s]) => [re, /blocks_avail/.test(re.source) ? [over([2e9, 8e9, 2e9])] : s]);
    vi.stubGlobal("fetch", fakeFly(full).fetchImpl);
    await expect(job(target).run(ctx)).rejects.toThrow(/^the volume reached 77% full/);
  });

  test("is configured only where Fly runs it with a token", () => {
    const base = { BEELINE_ENV: "development" };
    expect(configFromEnv(base).flyMetrics).toBeNull();
    expect(configFromEnv({ ...base, FLY_METRICS_TOKEN: "FlyV1 x" }).flyMetrics).toBeNull();
    expect(configFromEnv({ ...base, FLY_METRICS_TOKEN: "FlyV1 x", FLY_APP_NAME: "beeline" }).flyMetrics).toEqual({
      token: "FlyV1 x",
      org: "osu-mm",
      app: "beeline",
    });
  });
});
