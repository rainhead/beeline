import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * Give each sample in `sample_locality_fallback` (schema/174) the locality
 * Beeline names from its coordinates, and say how many changed (beeline-pimo).
 *
 * Two callers, because a suggestion and an unfit locality arrive at
 * different moments. Observation promotion re-applies it after the follow
 * rule has written the observation's own name again (the view is the
 * difference between the two, so the net change on a sample already
 * carrying its suggestion is none). Naming localities applies it after
 * naming, because a sample Beeline created tonight has no suggestion until
 * then.
 *
 * One statement, so it runs inside a caller's transaction or as its own.
 */
export async function applyLocalityFallback(conn: DuckDBConnection): Promise<number> {
  const result = await conn.run(
    `UPDATE sample SET locality = fb.locality
     FROM sample_locality_fallback fb
     WHERE sample.entity_id = fb.sample_id`,
  );
  return Number(result.rowsChanged);
}
