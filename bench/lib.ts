import { execSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { Kysely } from "kysely";
import { attachPrivateStore } from "../src/app/db.js";
import { createApp } from "../src/app/server.js";
import { cookieSessionResolver, createSession, SESSION_COOKIE } from "../src/app/session.js";
import { createKysely, duckDbConfig, openDuckDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import type { Database } from "../src/model.js";

/**
 * What both benchmarks share: a store to abuse, an app to ask, and a way to
 * say how long things took.
 *
 * The store is always a COPY. The benchmarks write — sessions slide, samples
 * are edited, promotion runs — and exactly one process may hold a store
 * (ADR 0005), so pointing this at the file an app has open would fail at best.
 * The copy is taken file-then-WAL without the owner's cooperation, so on a
 * busy store it can be torn; it opens or it does not, and a store that does
 * not open is copied again.
 *
 * The app is the real one, asked through `app.request`: every route, its
 * session gate, its SSR. What is measured is therefore what a person waits
 * for minus the network, which is the part of it a change to this repository
 * can move. Sessions are real rows behind the real resolver rather than a
 * stub, because the resolver writes on every request (`last_seen_at` slides)
 * and a benchmark that skipped the one write every page makes would be
 * measuring a read-only app that does not exist.
 */

export interface Subject {
  personId: number;
  inatUserId: number;
  cookie: string;
}

export interface Bench {
  dir: string;
  instance: DuckDBInstance;
  db: Kysely<Database>;
  app: ReturnType<typeof createApp>;
  /** The connection the nightly would run on. */
  jobConn: DuckDBConnection;
  /** Its most prolific collector who holds no admin row: the worst case for `mine`. */
  volunteer: Subject;
  /** Somebody with a person_admin row — granted on the copy if the store has none. */
  staff: Subject;
  paths: { corrections: string; sampleLog: string; sampleState: string; personChanges: string };
  close(): Promise<void>;
}

export const ORIGIN = "http://bench.invalid";

export async function rows<T = Record<string, unknown>>(conn: DuckDBConnection, sql: string): Promise<T[]> {
  return (await (await conn.run(sql)).getRowObjectsJson()) as T[];
}

export async function openBench(sourcePath: string): Promise<Bench> {
  const base = process.env.BENCH_TMP ?? tmpdir();
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "beeline-bench-"));
  const dbPath = join(dir, "beeline.duckdb");
  await copyFile(sourcePath, dbPath);
  await copyFile(`${sourcePath}.wal`, `${dbPath}.wal`).catch(() => undefined);

  const instance = await openDuckDb(dbPath);
  await attachPrivateStore(instance, { path: join(dir, "private.duckdb"), key: null });
  const db = createKysely(instance);
  const jobConn = await instance.connect();
  // A copy of an older store is brought forward the way a deploy would bring
  // the real one (ADR 0006), so a stale local file benchmarks today's code
  // rather than failing on a table it predates.
  const applied = await migrate(jobConn);
  if (applied.length > 0) console.error(`migrated the copy forward: ${applied.join(", ")}`);

  const pick = async (sql: string): Promise<{ person_id: number; inat_user_id: number } | undefined> =>
    (await rows<{ person_id: number; inat_user_id: number }>(jobConn, sql))[0];
  const byVolume = (admin: "IS NULL" | "IS NOT NULL") => `
    SELECT a.person_id, a.inat_user_id
      FROM inat_account a
      JOIN sample_collector sc ON sc.person_id = a.person_id
      LEFT JOIN person_admin pa ON pa.person_id = a.person_id
     WHERE pa.person_id ${admin}
     GROUP BY ALL ORDER BY count(*) DESC, a.person_id LIMIT 1`;
  const volunteerRow = await pick(byVolume("IS NULL"));
  if (volunteerRow === undefined) throw new Error("no collector with an iNat account in this store");
  let staffRow = await pick(byVolume("IS NOT NULL"));
  if (staffRow === undefined) {
    staffRow = await pick(
      `SELECT person_id, inat_user_id FROM inat_account WHERE person_id <> ${volunteerRow.person_id} ORDER BY person_id LIMIT 1`,
    );
    if (staffRow === undefined) throw new Error("no second account to make staff of");
    await jobConn.run(`INSERT INTO person_admin (person_id, granted_by) VALUES (${staffRow.person_id}, 'bench')`);
  }
  const subject = async (r: { person_id: number; inat_user_id: number }): Promise<Subject> => ({
    personId: Number(r.person_id),
    inatUserId: Number(r.inat_user_id),
    cookie: `${SESSION_COOKIE}=${await createSession(db, Number(r.inat_user_id))}`,
  });

  const paths = {
    corrections: join(dir, "corrections.csv"),
    sampleLog: join(dir, "sample-change.csv"),
    sampleState: join(dir, "sample-state.csv"),
    personChanges: join(dir, "person-change.csv"),
  };
  const app = createApp({
    db,
    config: { environment: "sandbox", origin: ORIGIN },
    inat: undefined as never,
    resolveSession: cookieSessionResolver(db),
    correctionsPath: paths.corrections,
    personOverlayPath: join(dir, "person-overlay.csv"),
    personChangesPath: paths.personChanges,
    sampleChangesPath: paths.sampleLog,
    sampleStatePath: paths.sampleState,
    conn: jobConn,
    printRunsDir: join(dir, "print-runs"),
  });

  return {
    dir,
    instance,
    db,
    app,
    jobConn,
    volunteer: await subject(volunteerRow),
    staff: await subject(staffRow),
    paths,
    async close() {
      jobConn.closeSync();
      await db.destroy();
      instance.closeSync();
      if (process.env.BENCH_KEEP !== "1") await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A fresh session for somebody: its own row in the private store, so its own row to slide. */
export async function sessionFor(bench: Bench, who: Pick<Subject, "personId" | "inatUserId">): Promise<Subject> {
  return { ...who, cookie: `${SESSION_COOKIE}=${await createSession(bench.db, who.inatUserId)}` };
}

export interface Timing {
  ms: number;
  status: number;
  bytes: number;
  error?: string;
}

/** One request, body read to the end: a streamed CSV is not done when its headers are. */
export async function timed(bench: Bench, who: Subject, path: string, init: RequestInit = {}): Promise<Timing> {
  const started = performance.now();
  try {
    const res = await bench.app.request(path, {
      ...init,
      headers: { cookie: who.cookie, origin: ORIGIN, ...(init.headers as Record<string, string> | undefined) },
    });
    const body = await res.arrayBuffer();
    const t: Timing = { ms: performance.now() - started, status: res.status, bytes: body.byteLength };
    if (res.status >= 500) t.error = new TextDecoder().decode(body).slice(0, 300);
    return t;
  } catch (err) {
    return { ms: performance.now() - started, status: 0, bytes: 0, error: (err as Error).message.slice(0, 300) };
  }
}

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export function summarize(ms: number[]): Summary {
  if (ms.length === 0) return { n: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const sorted = [...ms].sort((a, b) => a - b);
  // Nearest-rank: with a few dozen samples an interpolated p95 invents a
  // number nobody measured.
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]!),
    mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
  };
}

/**
 * An error message fit to commit to a public repository: its first line, with
 * everything quoted taken out. DuckDB quotes the offending value in a
 * constraint error — `duplicate key "display_name: …"` — and the store under
 * test is real people's records. What is left is the class of failure, which
 * is what the result is for.
 */
export function publishable(message: string): string {
  return (message.split("\n")[0] ?? "")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<…>")
    .replace(/\d{3,}/g, "<n>")
    .slice(0, 160);
}

/** Timings as they were taken, to a tenth of a millisecond: a later reader can compute the statistic we did not. */
export const samples = (ms: number[]) => ms.map((x) => Math.round(x * 10) / 10);

/** How many requests answered with each status. */
export function statusCounts(timings: Timing[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of timings) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return counts;
}

/** DuckDB says a write-write collision in several voices; all of them say "conflict". */
export const isConflict = (message: string | undefined) => message !== undefined && /conflict/i.test(message);

/** Everything a later reader needs to decide whether two result files are comparable. */
export async function environment(bench: Bench, sourcePath: string) {
  const one = async (sql: string) => Object.values((await rows(bench.jobConn, sql))[0] ?? {})[0];
  const git = (cmd: string) => {
    try {
      return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return null;
    }
  };
  const counts: Record<string, number> = {};
  for (const table of ["sample", "specimen", "determination", "observation_field", "person", "animal", "printed_label"]) {
    counts[table] = Number(await one(`SELECT count(*) FROM ${table}`));
  }
  return {
    at: new Date().toISOString(),
    // Which KIND of machine, never its name: a hostname is usually somebody's
    // (CodeRabbit on PR #84). BENCH_HOST names one where "workstation" is too vague.
    host: process.env.FLY_MACHINE_ID
      ? `fly:${process.env.FLY_APP_NAME}:${process.env.FLY_REGION}`
      : (process.env.BENCH_HOST ?? "workstation"),
    // The flags as given, their values only where they are numbers: every
    // other value is a path (`--compare`, `--out`), and a path names a home
    // directory (CodeRabbit on PR #84).
    argv: process.argv.slice(2).map((a) =>
      a.startsWith("--") ? a.replace(/=(?!\d+(\.\d+)?$).*$/, "=<path>") : "<store>",
    ),
    // The image has no .git; a Fly machine says which image it is running instead.
    commit: git("git rev-parse --short HEAD") ?? process.env.FLY_IMAGE_REF?.split(":").pop() ?? null,
    dirty: git("git status --porcelain") === null ? null : git("git status --porcelain") !== "",
    node: process.version,
    duckdb: String(await one("SELECT version()")),
    duckdbThreads: Number(await one("SELECT current_setting('threads')")),
    duckdbMemoryLimit: String(await one("SELECT current_setting('memory_limit')")),
    duckdbConfig: duckDbConfig(),
    cpu: `${cpus()[0]?.model ?? "unknown"} x${cpus().length}`,
    memoryMb: Math.round(totalmem() / 2 ** 20),
    storeMb: Math.round((await stat(sourcePath)).size / 2 ** 20),
    rows: counts,
  };
}

export function table(headers: string[], body: (string | number)[][]): string {
  const cells = [headers, ...body.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(cells[0]!), widths.map((w) => "-".repeat(w)).join("  "), ...cells.slice(1).map(line)].join("\n");
}

export async function writeResult(name: string, result: unknown, out: string | undefined): Promise<string> {
  const path = out ?? join("bench", "results", `${name}-${new Date().toISOString().slice(0, 10)}.json`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
}

export function args(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]!] = m[2] ?? "1";
    else positional.push(a);
  }
  return { positional, flags };
}

/** A page as one of the two kinds of people who open it (bench:pages, bench/postgres). */
export interface Case {
  name: string;
  who: "volunteer" | "staff";
  path: string;
}

export async function pageCases(bench: Bench): Promise<Case[]> {
  const one = async (sql: string) => Object.values((await rows(bench.jobConn, sql))[0] ?? {})[0];
  const mine = bench.volunteer.personId;
  const ownSample = await one(
    `SELECT s.entity_id FROM sample s JOIN sample_collector sc ON sc.sample_id = s.entity_id
      WHERE sc.person_id = ${mine} ORDER BY s.date_end DESC, s.entity_id LIMIT 1`,
  );
  const ownSpecimen = await one(
    `SELECT sp.entity_id FROM specimen sp JOIN sample_collector sc ON sc.sample_id = sp.sample_id
      WHERE sc.person_id = ${mine} ORDER BY sp.entity_id DESC LIMIT 1`,
  );
  const biggestSample = await one(`SELECT sample_id FROM specimen GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`);
  // The specimen with the longest determination history: the page that exists to show one.
  const busiestSpecimen = await one(`SELECT specimen_id FROM determination GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`);
  const genus = await one(
    `SELECT g.scientific_name FROM determination_of_record d
       JOIN animal a ON a.entity_id = d.animal_id
       JOIN animal g ON g.entity_id = a.parent_id AND g.rank = 'genus'
      GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`,
  );
  const state = await one(`SELECT state_province FROM sample WHERE state_province IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`);
  const run = await one(`SELECT print_run_id FROM printed_label GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`);
  const enc = (v: unknown) => encodeURIComponent(String(v));

  const list: (Case | null)[] = [
    { name: "front page", who: "volunteer", path: "/" },
    { name: "samples, mine", who: "volunteer", path: "/samples" },
    { name: "samples, mine, flagged", who: "volunteer", path: "/samples?qc=flagged" },
    { name: "samples, mine, page 5", who: "volunteer", path: "/samples?page=5" },
    { name: "specimens, mine", who: "volunteer", path: "/specimens" },
    genus ? { name: "specimens, mine, by genus", who: "volunteer", path: `/specimens?taxon=${enc(genus)}` } : null,
    { name: "samples.csv, mine", who: "volunteer", path: "/samples.csv" },
    ownSample ? { name: "sample page, own", who: "volunteer", path: `/samples/${ownSample}` } : null,
    ownSpecimen ? { name: "specimen page, own", who: "volunteer", path: `/specimens/${ownSpecimen}` } : null,
    { name: "glossary", who: "volunteer", path: "/glossary" },
    { name: "taxonomy index", who: "volunteer", path: "/taxonomy" },
    genus ? { name: "taxonomy, top genus", who: "volunteer", path: `/taxonomy/genus/${enc(genus)}` } : null,
    { name: "taxonomy search", who: "volunteer", path: "/taxonomy?q=bombus" },

    { name: "front page", who: "staff", path: "/" },
    { name: "samples, all", who: "staff", path: "/samples?scope=all" },
    { name: "samples, all, flagged", who: "staff", path: "/samples?scope=all&qc=flagged" },
    { name: "samples, all, by number", who: "staff", path: "/samples?scope=all&sort=number" },
    { name: "samples, all, last page", who: "staff", path: "/samples?scope=all&page=100000" },
    state ? { name: "samples, all, by place", who: "staff", path: `/samples?scope=all&place=${enc(state)}` } : null,
    { name: "samples, all, search", who: "staff", path: "/samples?scope=all&q=26" },
    { name: "specimens, all", who: "staff", path: "/specimens?scope=all" },
    genus ? { name: "specimens, all, by genus", who: "staff", path: `/specimens?scope=all&taxon=${enc(genus)}` } : null,
    { name: "specimens, all, undetermined", who: "staff", path: "/specimens?scope=all&det=undetermined" },
    biggestSample ? { name: "sample page, largest", who: "staff", path: `/samples/${biggestSample}` } : null,
    busiestSpecimen ? { name: "specimen page, longest history", who: "staff", path: `/specimens/${busiestSpecimen}` } : null,
    { name: "people", who: "staff", path: "/people" },
    { name: "people.csv", who: "staff", path: "/people.csv" },
    { name: "person page", who: "staff", path: `/people/${mine}` },
    { name: "jobs", who: "staff", path: "/jobs" },
    { name: "print runs", who: "staff", path: "/print-runs" },
    run ? { name: "print run, largest", who: "staff", path: `/print-runs/${run}` } : null,
  ];
  return list.filter((c): c is Case => c !== null);
}
