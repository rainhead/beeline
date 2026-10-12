/**
 * `tsx bench/postgres/promotion.ts <store.duckdb> <postgres-url> [--n=3]`
 *
 * The nightly's observation promotion, step by step, on both engines: the
 * observation_field refresh, then the three ingest files in the order
 * src/promote-observations.ts runs them. Each run is one transaction, rolled
 * back, so every run starts from the same rows. DuckDB runs on a copy of the
 * store; Postgres on the rows bench/postgres/load.ts loaded, with the ingest
 * SQL rewritten by src/postgres-port.ts.
 *
 * This is the batch half of the workload, which the page benchmark does not
 * see: whole-table statements that DuckDB was chosen for.
 */
import pg from "pg";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { args } from "../lib.js";
import { toPostgres } from "../../src/postgres-port.js";

const { positional, flags } = args(process.argv.slice(2));
const [storePath, url] = positional;
if (!storePath || !url) {
  console.error("usage: tsx bench/postgres/promotion.ts <store.duckdb> <postgres-url> [--n=3]");
  process.exit(2);
}
const n = Number(flags.n ?? 3);

const ingest = (f: string) => readFile(new URL(`../../ingest/${f}`, import.meta.url), "utf8");
const steps: { name: string; sql: string }[] = [
  { name: "refresh observation_field", sql: "DELETE FROM observation_field; INSERT INTO observation_field SELECT * FROM observation_current_fields;" },
  { name: "harvest-inat-accounts.sql", sql: await ingest("harvest-inat-accounts.sql") },
  { name: "mint-samples.sql", sql: await ingest("mint-samples.sql") },
  { name: "promote-observations.sql", sql: await ingest("promote-observations.sql") },
];

const dir = await mkdtemp(join(tmpdir(), "beeline-pg-promotion-"));
const copy = join(dir, "store.duckdb");
await copyFile(storePath, copy);
// Commits not yet checkpointed live in the WAL; without it the copy is older
// than the rows load.ts gave Postgres.
await copyFile(`${storePath}.wal`, `${copy}.wal`).catch(() => undefined);
const instance = await DuckDBInstance.create(copy);
const duck = await instance.connect();
const client = new pg.Client({ connectionString: url });
await client.connect();

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const times = steps.map(() => ({ duck: [] as number[], pg: [] as number[] }));
for (let run = 0; run < n; run++) {
  await duck.run("BEGIN TRANSACTION");
  for (const [k, step] of steps.entries()) {
    const t = performance.now();
    await duck.run(step.sql);
    times[k]!.duck.push(performance.now() - t);
  }
  await duck.run("ROLLBACK");

  await client.query("BEGIN");
  for (const [k, step] of steps.entries()) {
    const t = performance.now();
    await client.query(toPostgres(step.sql));
    times[k]!.pg.push(performance.now() - t);
  }
  await client.query("ROLLBACK");
}

let duckTotal = 0;
let pgTotal = 0;
for (const [k, step] of steps.entries()) {
  const d = median(times[k]!.duck);
  const p = median(times[k]!.pg);
  duckTotal += d;
  pgTotal += p;
  console.log(`${step.name.padEnd(30)} duckdb ${d.toFixed(0).padStart(6)} ms   postgres ${p.toFixed(0).padStart(7)} ms`);
}
console.log(`${"total".padEnd(30)} duckdb ${duckTotal.toFixed(0).padStart(6)} ms   postgres ${pgTotal.toFixed(0).padStart(7)} ms`);

duck.closeSync();
instance.closeSync();
await client.end();
await rm(dir, { recursive: true, force: true });
