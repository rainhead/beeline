import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * Refreshing `observation_field` — the stored form of the projection
 * `observation_current_fields` defines (schema/060, schema/105).
 *
 * Shredding the JSON is expensive and its input is not, and three QC rules
 * read it — which is why the whole `qc_finding` union cost ~670 ms and the
 * flagship page, both listings, printability and the record pages each paid
 * it once. Storing the shred takes the union to ~205 ms (beeline-2c3.36).
 *
 * It is expensive in memory as well as time, and that is what to watch when
 * changing the view: a refresh reads every observation, not one night's. On
 * the production store of 2026-11-07 (65,939 observations) the refresh raised
 * the process's peak memory by about 1.1 GB, most of it outside DuckDB's
 * memory_limit, because the view parsed each load once per field it read.
 * It now parses each load once and adds about 120 MB in 0.3 s (beeline-dmoi;
 * schema/105 has the measurements).
 *
 * The rule, in two halves that are not the same rule twice:
 *
 * 1. Whatever changes `observation_load` refreshes this in the same
 *    transaction — today only a sync run (src/sync-inat.ts). That is what
 *    makes "the loads and their shredded form agree" true at every commit
 *    boundary, which is in turn what lets `observation_field_stale`
 *    (schema/105) be a real alarm rather than something that cries wolf for
 *    the minutes between a sync and a promotion.
 * 2. Promotion refreshes before it reads (src/promote-observations.ts),
 *    because promotion is the entry point for every store whose loads
 *    arrived some other way: `pnpm db:reseed` carries `observation_load`
 *    across and tells you to promote, a test stages loads by hand, someone
 *    rebuilds and re-promotes. Reading a stale projection there would not
 *    merely show an old flag — promotion writes believed-true coordinates
 *    onto samples from it, and an empty table writes none at all, silently.
 *
 * So the second is not redundancy to delete. It costs one extra shred in a
 * night-window job and removes the whole class of "the store looked fine and
 * had promoted nothing".
 *
 * Every row is compared, but only changed rows are written. A load can
 * change any row and deletion detection means rows also go away, so the
 * refresh reads the whole projection each time; the bookkeeping an
 * incremental refresh would need buys nothing and could be wrong. What it
 * writes is another matter. Deleting every row and inserting them again
 * while a page request holds a read transaction open leaves about 3.4 MB
 * (12 to 16 blocks of 256 KB) in use in the file that no checkpoint frees,
 * on every refresh: production's store grew about 21 MB a day (beeline-kh13).
 * Measured on the backup of 2026-11-22 (66,047 rows): four refreshes under an
 * open reader with nothing changed took the blocks in use from 1,440 to 1,496
 * that way, and left them at 1,440 with MERGE, which also took about 280 ms
 * against about 600 ms.
 */
export async function refreshObservationFields(conn: DuckDBConnection): Promise<number> {
  // MERGE rather than DELETE + INSERT (see above), and rather than CREATE OR
  // REPLACE TABLE, which would drop the QC rule views that depend on this
  // table. `f IS DISTINCT FROM s` compares the two rows as structs, field by
  // field in column order, and treats NULL as equal to NULL, so a row is
  // rewritten only when some column differs, including a change from NULL to a
  // value. `UPDATE SET *` and `INSERT *` match columns by name; the struct
  // comparison still goes by position, which is why new columns go last and in
  // the same order in both places (schema/060, schema/105).
  await conn.run(
    `MERGE INTO observation_field f USING observation_current_fields s ON f.inat_id = s.inat_id
     WHEN MATCHED AND f IS DISTINCT FROM s THEN UPDATE SET *
     WHEN NOT MATCHED THEN INSERT *
     WHEN NOT MATCHED BY SOURCE THEN DELETE`,
  );
  const [[n]] = (await (await conn.run("SELECT count(*) FROM observation_field")).getRows()) as [[bigint | number]];
  return Number(n);
}
