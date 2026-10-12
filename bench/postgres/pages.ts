/**
 * `tsx bench/postgres/pages.ts <store.duckdb> <postgres-url> [--n=5] [--out=file.json]`
 *
 * What each page of the app would cost on Postgres. The app runs only on
 * DuckDB, so this records the SQL each page sends — every case of
 * `bench:pages`, rendered once against a copy of the store, with every query
 * and its parameters captured on the way to DuckDB — then replays each read
 * on both engines: DuckDB on the copy, Postgres on the same rows loaded by
 * bench/postgres/load.ts, rewritten by src/postgres-port.ts. A page's cost
 * is the sum of its queries, each the median of n runs.
 *
 * It measures the database's share of a page and nothing else: no rendering,
 * no network, and Postgres's wire transfer included where DuckDB, in process,
 * has none — which is the trade a move would actually make.
 *
 * Writes are not replayed. The session resolver's writes, and anything else
 * a page writes, would change what the next query reads.
 */
import pg from "pg";
import { DuckDBConnection } from "@duckdb/node-api";
import { writeFile } from "node:fs/promises";
import { args, openBench, pageCases } from "../lib.js";
import { numberPlaceholders, toPostgres } from "../../src/postgres-port.js";

interface Captured {
  sql: string;
  params: unknown[];
}

const { positional, flags } = args(process.argv.slice(2));
const [storePath, url] = positional;
if (!storePath || !url) {
  console.error("usage: tsx bench/postgres/pages.ts <store.duckdb> <postgres-url> [--n=5] [--out=file.json]");
  process.exit(2);
}
const n = Number(flags.n ?? 5);

// ── Capture ───────────────────────────────────────────────────────────────

let recording: Captured[] | null = null;
const proto = DuckDBConnection.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
for (const method of ["run", "runAndRead", "runAndReadAll", "stream", "streamAndRead", "streamAndReadAll"]) {
  const original = proto[method];
  proto[method] = function (this: unknown, sql: unknown, values?: unknown, ...rest: unknown[]) {
    if (recording && typeof sql === "string") {
      recording.push({ sql, params: Array.isArray(values) ? values.map(plain) : [] });
    }
    return original!.call(this, sql, values, ...rest);
  };
}

function plain(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === "object" && "toString" in v) return String(v);
  return v;
}

const isRead = (sql: string) => /^\s*(\(\s*)?(SELECT|WITH)\b/i.test(sql.replace(/^\s*--.*$/gm, ""));

const bench = await openBench(storePath);
const pages: { name: string; who: string; path: string; status: number; queries: Captured[] }[] = [];
try {
  for (const c of await pageCases(bench)) {
    // Once unrecorded so the session's first-request writes and any cache
    // fill are out of the way, then once recorded.
    await bench.app.request(`http://bench.invalid${c.path}`, { headers: { cookie: bench[c.who].cookie } });
    recording = [];
    const res = await bench.app.request(`http://bench.invalid${c.path}`, { headers: { cookie: bench[c.who].cookie } });
    await res.arrayBuffer();
    pages.push({ ...c, status: res.status, queries: recording.filter((q) => isRead(q.sql)) });
    recording = null;
  }

  // ── Replay ──────────────────────────────────────────────────────────────

  for (const oid of Object.values(pg.types.builtins)) pg.types.setTypeParser(oid as number, (v: string) => v);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("SET search_path = public, private");
  const duck = await bench.instance.connect();

  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const report: unknown[] = [];
  console.log(`${"page".padEnd(42)} ${"who".padEnd(9)} queries   duckdb   postgres   slowest on postgres`);
  for (const page of pages) {
    let duckTotal = 0;
    let pgTotal = 0;
    let slowest = { ms: 0, sql: "" };
    const failures: string[] = [];
    const perQuery: { sql: string; params: unknown[]; duckMs: number; pgMs: number }[] = [];
    for (const q of page.queries) {
      let ported: string;
      try {
        ported = numberPlaceholders(toPostgres(q.sql));
      } catch (err) {
        failures.push(`no port rule: ${(err as Error).message}`);
        continue;
      }
      const d: number[] = [];
      const p: number[] = [];
      try {
        for (let i = 0; i < n; i++) {
          let t = performance.now();
          await duck.runAndReadAll(q.sql, q.params as never);
          d.push(performance.now() - t);
          t = performance.now();
          await client.query({ text: ported, values: q.params as unknown[] });
          p.push(performance.now() - t);
        }
      } catch (err) {
        failures.push(`${(err as Error).message.split("\n")[0]} :: ${ported.replace(/\s+/g, " ").slice(0, 160)}`);
        continue;
      }
      const dm = median(d);
      const pm = median(p);
      duckTotal += dm;
      pgTotal += pm;
      perQuery.push({ sql: q.sql, params: q.params, duckMs: dm, pgMs: pm });
      if (pm > slowest.ms) slowest = { ms: pm, sql: q.sql };
    }
    console.log(
      `${page.name.padEnd(42)} ${page.who.padEnd(9)} ${String(page.queries.length).padStart(7)} ${duckTotal.toFixed(0).padStart(6)} ms ${pgTotal.toFixed(0).padStart(7)} ms   ${slowest.ms.toFixed(0).padStart(5)} ms ${slowest.sql.replace(/\s+/g, " ").slice(0, 70)}`,
    );
    for (const f of failures) console.log(`    FAILED ${f}`);
    report.push({ name: page.name, who: page.who, path: page.path.replace(/\/\d+/g, "/:id"), status: page.status, duckMs: duckTotal, pgMs: pgTotal, failures: failures.length, queries: perQuery });
  }
  if (flags.out) await writeFile(String(flags.out), JSON.stringify(report, null, 2));
  duck.closeSync();
  await client.end();
} finally {
  await bench.close();
}
