import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * Refreshing `observation_field` — the stored form of the projection
 * `observation_current_fields` defines (schema/060, schema/105).
 *
 * Shredding the JSON is expensive and its input is not: 63k observations
 * take ~200 ms, almost all of it in the two correlated `$.ofvs` subqueries,
 * and three QC rules read it — which is why the whole `qc_finding` union
 * cost ~670 ms and the flagship page, both listings, printability and the
 * record pages each paid it once. Storing the shred takes the union to
 * ~205 ms (beeline-2c3.36).
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
 * Whole-table, not incremental. A load can change any row, deletion
 * detection means rows also go away, and the whole refresh costs about as
 * much as one scan of the view it replaces — so the bookkeeping an
 * incremental refresh would need buys nothing and could be wrong.
 */
export async function refreshObservationFields(conn: DuckDBConnection): Promise<number> {
  // DELETE + INSERT rather than CREATE OR REPLACE TABLE: the QC rule views
  // depend on this table, and replacing it would drop them.
  await conn.run("DELETE FROM observation_field");
  await conn.run("INSERT INTO observation_field SELECT * FROM observation_current_fields");
  const [[n]] = (await (await conn.run("SELECT count(*) FROM observation_field")).getRows()) as [[bigint | number]];
  return Number(n);
}
