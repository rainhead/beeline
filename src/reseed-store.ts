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
 * Ids are NOT carried. This builds a new database, so entity_id_seq starts at
 * 1 and every person, sample and specimen is renumbered anyway — there is no
 * sense in which a sync run's id is more permanent than a person's. ADR 0002
 * says as much: an entity_id is a per-store sequence draw, which is why the
 * person overlay refuses to key on one. Carrying them verbatim only forced
 * the sequence past ~700k, and every later reseed past the one before, so a
 * store's ids climbed by a million each time for no reason (beeline-eyk).
 *
 * The one thing that has to survive is the ASSOCIATION between a sync run and
 * the loads and presence rows that point at it, and that is 18 rows to remap.
 * Anything anchoring on staged observations later must key on inat_id and
 * content_hash for the same reason the overlay keys on names.
 */

/**
 * What comes across: the staged legacy dump, the iNat sync history, the job
 * log, and the places cache. Everything else in the store is a pure function
 * of these, and promotion recomputes it.
 *
 * inat_place is here because it is the one carried table promotion CANNOT
 * recompute: it comes from an outbound HTTP fetch, not from anything in the
 * store (src/fetch-places.ts, beeline-2yt). Leaving it out would be silent —
 * a reseeded store would resolve no observation to a state, and so give
 * nothing an atlas, until somebody noticed and ran the fetch again.
 */
export const CARRIED_TABLES = [
  "legacy_occurrence",
  "sync_run",
  "observation_load",
  "observation_seen",
  "job_run",
  "inat_place",
] as const;

export interface ReseedCounts {
  carried: Record<string, number>;
  /** The next id promotion will draw — where the carried rows left off. */
  sequenceAt: number;
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
  // The target's catalog is named after its file, so ask rather than assume.
  const [[target]] = (await (await conn.run(`SELECT current_database()`)).getRows()) as [[string]];
  await conn.run(`ATTACH '${sourcePath.replaceAll("'", "''")}' AS old (READ_ONLY)`);
  try {
    const carried: Record<string, number> = {};
    const has = (table: string) => tableExists(conn, "old", table);
    const count = async (table: string) => {
      carried[table] = await scalar(conn, `SELECT count(*) FROM ${table}`);
    };

    // Not a schema table — load-legacy makes it — so it arrives whole. It
    // carries no ids of its own.
    if (await has("legacy_occurrence")) {
      await conn.run(`CREATE TABLE legacy_occurrence AS SELECT * FROM old.legacy_occurrence`);
      await count("legacy_occurrence");
    }

    if (await has("sync_run")) {
      // The one association worth keeping: loads and presence rows point at
      // their run. Eighteen rows on a real store, so remapping them is cheaper
      // than the id arithmetic that preserving them used to cost.
      await conn.run(`CREATE OR REPLACE TEMP TABLE sync_run_id_map AS
        SELECT entity_id AS old_id, nextval('entity_id_seq') AS new_id FROM old.sync_run`);
      await conn.run(`INSERT INTO sync_run BY NAME
        SELECT s.* REPLACE (m.new_id AS entity_id)
        FROM old.sync_run s JOIN sync_run_id_map m ON m.old_id = s.entity_id`);
      await count("sync_run");

      // BY NAME with entity_id excluded, so the column's own default draws it.
      if (await has("observation_load")) {
        await conn.run(`INSERT INTO observation_load BY NAME
          SELECT o.* EXCLUDE (entity_id) REPLACE (m.new_id AS sync_run_id)
          FROM old.observation_load o JOIN sync_run_id_map m ON m.old_id = o.sync_run_id`);
        await count("observation_load");
      }
      // Not an entity (ADR 0002): a presence row is keyed by what it witnesses,
      // so only the run it points at is rewritten.
      if (await has("observation_seen")) {
        await conn.run(`INSERT INTO observation_seen BY NAME
          SELECT o.* REPLACE (m.new_id AS sync_run_id)
          FROM old.observation_seen o JOIN sync_run_id_map m ON m.old_id = o.sync_run_id`);
        await count("observation_seen");
      }
      await conn.run(`DROP TABLE sync_run_id_map`);
    }

    // Nothing points at a job run, so it simply takes a new id.
    if (await has("job_run")) {
      await conn.run(`INSERT INTO job_run BY NAME SELECT * EXCLUDE (entity_id) FROM old.job_run`);
      await count("job_run");
    }

    // Scoped to the target: both catalogs are attached and both have a
    // sequence by this name, and reading the source's reported a number seven
    // hundred thousand too high while the store itself was fine.
    const sequenceAt =
      (await scalar(
        conn,
        `SELECT coalesce(max(last_value), 0) FROM duckdb_sequences()
         WHERE database_name = '${target}' AND sequence_name = 'entity_id_seq'`,
      )) + 1;
    return { carried, sequenceAt };
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
      `Derive it: pnpm legacy:promote ${target} && pnpm inat:fetch-places ${target} && ` +
      `pnpm inat:promote ${target} && pnpm inat:backfill-accounts ${target} && ` +
      `pnpm elevation:derive ${target}`,
  );
}
