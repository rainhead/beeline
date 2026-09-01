import { DuckDBInstance } from "@duckdb/node-api";
import { Kysely, type Dialect } from "kysely";
import { DuckDbDialect } from "kysely-duckdb";
import type { Database } from "./model.js";

/** Kysely over an already-open DuckDB instance (single-writer: share it). */
export function createKysely(instance: DuckDBInstance): Kysely<Database> {
  // kysely-duckdb's published types resolve kysely's CJS declarations while we
  // resolve the ESM ones — structurally identical, nominally incompatible.
  const dialect = new DuckDbDialect({ database: instance, tableMappings: {} }) as unknown as Dialect;
  return new Kysely<Database>({ dialect });
}

/**
 * Open the store, with DuckDB's memory and thread budgets stated rather than
 * detected.
 *
 * Left alone, DuckDB sizes both from the machine it believes it is on: roughly
 * 80% of RAM, and one thread per core. On a workstation that is the right
 * answer and these variables stay unset, which is why the default here is to
 * pass nothing at all. In a container it is a guess about a cgroup, and the
 * consequence of guessing high is not slowness but death — DuckDB plans a
 * query against memory the machine will not give it, and the kernel kills the
 * process rather than letting it spill.
 *
 * Stated, the failure mode is much better. Measured against the dev store, a
 * full legacy promotion (383,032 staged rows, heavier than any nightly) with
 * memory_limit at 244 MiB took 18.4s against 15.8s uncapped — DuckDB spilled
 * to disk and finished, 16% slower, in a window with no interactivity SLA.
 * So on a small machine these are set, and a 2am OOM loop becomes two extra
 * seconds of work.
 */
export function duckDbConfig(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const config: Record<string, string> = {};
  if (env.BEELINE_DUCKDB_MEMORY_LIMIT) config.memory_limit = env.BEELINE_DUCKDB_MEMORY_LIMIT;
  if (env.BEELINE_DUCKDB_THREADS) config.threads = env.BEELINE_DUCKDB_THREADS;
  return config;
}

/** Every store this project opens goes through here, so the budgets above apply everywhere. */
export function openDuckDb(path: string): Promise<DuckDBInstance> {
  return DuckDBInstance.create(path, duckDbConfig());
}
