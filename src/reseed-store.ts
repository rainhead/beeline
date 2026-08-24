import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { applySchema } from "./schema.js";

/**
 * Rebuild a deployed store's model from the staging it already holds.
 *
 * The blow-away stance (docs/roadmap.md) covers a change to the schema, which
 * reaches a store nobody rebuilds as a migration (ADR 0006). It does not cover
 * a change to PROMOTION — the rules that derive the model from staged rows.
 * Those leave a deployed store shaped correctly and derived wrongly, which
 * `db:migrate --check` cannot see, because nothing has drifted: the tables are
 * right and the rows in them are stale. beeline-eyk was the first of these
 * (person identity and who collected each sample), and there will be more
 * before cutover.
 *
 * Re-promoting is the answer, and re-fetching is not: the staged sources are
 * already in the file. So this builds a fresh database from `schema/*.sql`,
 * exactly as `db:build` does, and carries across only what nothing can
 * re-derive — the staged legacy dump, and the iNat sync history whose
 * presence rows are the proof deletion detection reads (beeline-3hj).
 * Everything else is a pure function of those, and promotion recomputes it.
 *
 * What does NOT come across, deliberately: every model table, since deriving
 * them again is the point, and every intermediate table promotion builds
 * (legacy_person_map and friends), since promotion CREATEs them and would
 * fail on a second run. The taxonomy CSV is an input, not state — pass its
 * path to promotion the way a fresh ingest does.
 *
 * Sequence-drawn ids come across unchanged, so the sequence has to be moved
 * past them or the first promoted row collides with a sync run.
 */

/**
 * Staged and synced state, in an order that satisfies the foreign keys:
 * observation_load and observation_seen both point at sync_run.
 *
 * job_run is here for a softer reason — it is history rather than state, and
 * losing it would make /jobs claim the pipeline had never run.
 */
export const CARRIED_TABLES = [
  "legacy_occurrence",
  "sync_run",
  "observation_load",
  "observation_seen",
  "job_run",
] as const;

/** Tables holding an entity_id drawn from the shared sequence (ADR 0002). */
const SEQUENCE_DRAWN = ["sync_run", "observation_load", "job_run"] as const;

export interface ReseedCounts {
  carried: Record<string, number>;
  /** Where entity_id_seq was left, so promotion cannot collide with what came across. */
  sequenceRestartedAt: number;
}

const scalar = async (conn: DuckDBConnection, sql: string): Promise<number> => {
  const [[v]] = (await (await conn.run(sql)).getRows()) as [[bigint | number | null]];
  return Number(v ?? 0);
};

// duckdb_tables() rather than information_schema, which reports the attached
// catalog under table_catalog and would need the schema name as well.
const tableExists = async (conn: DuckDBConnection, database: string, name: string) =>
  (await scalar(
    conn,
    `SELECT count(*) FROM duckdb_tables()
     WHERE database_name = '${database}' AND table_name = '${name}'`,
  )) > 0;

/**
 * Copy staged and synced state from `sourcePath` into an open connection to a
 * freshly built store. Missing source tables are skipped rather than fatal: a
 * store that never synced has no observation_load, and that is not an error.
 */
export async function carryStaging(
  conn: DuckDBConnection,
  sourcePath: string,
): Promise<ReseedCounts> {
  // Everything below this the fresh build has already handed out — the seed
  // rows the schema inserts. Carried ids have to sit above it, and on a real
  // store they do, having been drawn long after those seeds.
  const firstFree =
    (await scalar(
      conn,
      `SELECT coalesce(max(last_value), 0) FROM duckdb_sequences() WHERE sequence_name = 'entity_id_seq'`,
    )) + 1;

  // The target's catalog is named after its file, so ask rather than assume.
  const [[target]] = (await (await conn.run(`SELECT current_database()`)).getRows()) as [[string]];
  await conn.run(`ATTACH '${sourcePath.replaceAll("'", "''")}' AS old (READ_ONLY)`);
  try {
    const carried: Record<string, number> = {};
    for (const table of CARRIED_TABLES) {
      if (!(await tableExists(conn, "old", table))) continue;
      // Two shapes here. sync_run and friends are schema tables, so the fresh
      // build already has them empty and BY NAME fills them — a column added
      // to the schema since the source was built takes its default instead of
      // shifting every value one to the left. legacy_occurrence is not in the
      // schema at all (load-legacy makes it), so it arrives whole.
      await conn.run(
        (await tableExists(conn, target, table))
          ? `INSERT INTO ${table} BY NAME SELECT * FROM old.${table}`
          : `CREATE TABLE ${table} AS SELECT * FROM old.${table}`,
      );
      carried[table] = await scalar(conn, `SELECT count(*) FROM ${table}`);
    }
    // Past the highest id that came across, or promotion's first draw reuses
    // a sync run's id and the foreign keys start pointing at samples.
    let highest = 0;
    for (const table of SEQUENCE_DRAWN) {
      if (!carried[table]) continue;
      const [[lo, hi]] = (await (
        await conn.run(`SELECT min(entity_id), max(entity_id) FROM ${table}`)
      ).getRows()) as [[bigint, bigint]];
      if (Number(lo) < firstFree) {
        throw new Error(
          `${table} carries entity_id ${lo}, which the rebuilt store already gave to a seed row — ` +
            `ids are globally unique (ADR 0002), so this source cannot be reseeded as is`,
        );
      }
      highest = Math.max(highest, Number(hi));
    }
    // No ALTER SEQUENCE in DuckDB and no dropping one three dozen tables
    // default from, so the sequence is drawn forward instead.
    const restartAt = Math.max(highest + 1, firstFree);
    if (restartAt > firstFree) {
      await conn.run(`SELECT max(nextval('entity_id_seq')) FROM range(${restartAt - firstFree})`);
    }
    return { carried, sequenceRestartedAt: restartAt };
  } finally {
    await conn.run(`DETACH old`);
  }
}

/**
 * Build `targetPath` from the schema and carry `sourcePath`'s staging into it.
 * The target is replaced if it exists; the source is only ever read.
 */
export async function reseedStore(sourcePath: string, targetPath: string): Promise<ReseedCounts> {
  if (sourcePath === targetPath) {
    throw new Error("reseed writes a new store beside the old one — give it a different target path");
  }
  await rm(targetPath, { force: true });
  const instance = await DuckDBInstance.create(targetPath);
  const conn = await instance.connect();
  try {
    await applySchema(conn);
    // Built from the schema, so current by construction (ADR 0006): stamp the
    // migrations rather than run them, exactly as db:build does.
    const { baseline } = await import("./migrate.js");
    await baseline(conn);
    return await carryStaging(conn, sourcePath);
  } finally {
    conn.closeSync();
  }
}

// CLI: pnpm db:reseed <source.duckdb> <target.duckdb>
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [source, target] = process.argv.slice(2);
  if (!source || !target) {
    console.error("usage: pnpm db:reseed <source.duckdb> <target.duckdb>");
    console.error("The source must not be open — one process owns a store (ADR 0005).");
    process.exit(2);
  }
  const counts = await reseedStore(source, target);
  console.log(JSON.stringify(counts, null, 2));
  console.log(
    `\n${target} has the schema and ${source}'s staging, and no model.\n` +
      `Derive it: pnpm legacy:promote ${target} && pnpm inat:promote ${target} && ` +
      `pnpm inat:backfill-accounts ${target} && pnpm elevation:derive ${target}`,
  );
}
