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

/**
 * A `TIMESTAMP` column holds a wall-clock time with no zone, and this store's
 * mean UTC — in every process, wherever it runs, not only on the Fly machine.
 *
 * DuckDB's session zone defaults to the machine's. Under it `current_timestamp`
 * stored Pacific wall-clock time on a workstation, while a JavaScript instant
 * written as `toISOString()` (print runs, determination drafts, the Ecdysis
 * and worksheet loads) stored UTC, so one column held two meanings seven hours
 * apart wherever the process was not in UTC (beeline-j0aj). Fly runs in UTC,
 * which is why production never showed it. Pinning the session zone makes
 * every process store what production stores; reading the value back as UTC
 * is the other half, in `patches/kysely-duckdb.patch`, which can go when
 * kysely-duckdb offers that as an option
 * (https://github.com/runoshun/kysely-duckdb/issues/15).
 */
const STORE_TIME_ZONE = { TimeZone: "UTC" };

/**
 * DuckDB 2.0 plans a correlated subquery differently by default
 * (`delim_join_as_cte`), and the new plan copies the subquery's outer side
 * once per subquery instead of sharing it. Beeline's name parsing hides a
 * correlated subquery in each alias macro (`legacy_genus_alias`,
 * `legacy_species_alias`, ingest/parse-names.sql), and the nested macros
 * repeat it several times per row, so under the new plan `legacy_det_taxa`
 * evaluated the staging views over and over: counting its five rows on the
 * test fixture took 1.5 s against 82 ms on 1.5, and a legacy promotion 100 s
 * against 3.5 s. With the old plan restored, 2.0 is back to about 1.5's speed.
 */
const PLANNER = { delim_join_as_cte: "false" };

/**
 * Every DuckDB this project opens goes through here or through
 * {@link openMemoryDuckDb}, so the budgets above, the store's time zone and
 * the planner setting apply everywhere — and `test/duckdb-openers.test.ts`
 * holds that true, because the first attempt at this refactor missed two call
 * sites to a `grep | head` and nothing noticed.
 */
export function openDuckDb(path: string): Promise<DuckDBInstance> {
  return DuckDBInstance.create(path, { ...duckDbConfig(), ...STORE_TIME_ZONE, ...PLANNER });
}

/**
 * What {@link openQueryCopy} is given besides the path.
 */
export interface QueryCopyBudget {
  /** DuckDB's memory ceiling for this instance, e.g. "256MB". */
  memoryLimit: string;
}

/**
 * Open the copy of the store that people's SQL runs against
 * (src/query-copy.ts, beeline-pnqr.4) as an instance of its own, beside the
 * live one in this process.
 *
 * Read-only, so no statement can change the file; with external access off
 * afterwards, so none can read or write any other file or load an extension;
 * and with the configuration locked, so none can undo either by a `SET`. The
 * session zone is the store's UTC, like every other opener here. One thread
 * and a stated memory limit keep it from taking the machine from the live
 * instance.
 *
 * The temporary directory is a path that cannot be created, on purpose.
 * Measured on DuckDB 2.0.0: a read-only instance with external access off
 * still spills a large sort or aggregate to a `.tmp` folder beside the file,
 * and `max_temp_directory_size` is not enforced there (a 1 MB limit let one
 * query write 1 GB), so on a small volume that shared with the live store a
 * runaway query could fill the disk the store writes to. Pointing the
 * directory below the copy file itself, which is not a folder, makes a query
 * that needs more than the memory limit fail with an ordinary error saying it
 * could not create the directory, and writes nothing.
 *
 * The options are set in this order for a reason: the time zone needs the ICU
 * extension, which cannot be loaded once external access is off, and
 * `temp_directory` cannot be given after that either, so the lock-down comes
 * last and is a statement rather than an option.
 */
export async function openQueryCopy(path: string, budget: QueryCopyBudget): Promise<DuckDBInstance> {
  const instance = await DuckDBInstance.create(path, {
    access_mode: "READ_ONLY",
    ...STORE_TIME_ZONE,
    ...PLANNER,
    memory_limit: budget.memoryLimit,
    threads: "1",
    temp_directory: `${path}/no-spill`,
  });
  const conn = await instance.connect();
  try {
    await conn.run("SET enable_external_access = false");
    await conn.run("SET lock_configuration = true");
  } catch (err) {
    instance.closeSync();
    throw err;
  } finally {
    conn.closeSync();
  }
  return instance;
}

/** The in-memory case (tests, the migration tool's drift check). */
export function openMemoryDuckDb(): Promise<DuckDBInstance> {
  return DuckDBInstance.create(":memory:", { ...duckDbConfig(), ...STORE_TIME_ZONE, ...PLANNER });
}

/**
 * Load DuckDB's spatial extension on a connection, for the two things that
 * read outlines: building the gazetteer and naming a sample's locality from
 * its coordinates (beeline-7i6). The store holds no geometry, so it is loaded
 * where it is used rather than at every open. The image installs it at build
 * time (Dockerfile), so the machine needs no network here; a
 * workstation or CI fetches it into ~/.duckdb on first use.
 */
export async function loadSpatial(conn: { run(sql: string): Promise<unknown> }): Promise<void> {
  try {
    await conn.run("LOAD spatial");
  } catch {
    await conn.run("INSTALL spatial");
    await conn.run("LOAD spatial");
  }
}
