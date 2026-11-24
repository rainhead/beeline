import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * Fail when a sample's stored method disagrees with what its method as written
 * gives, by counting `sample_method_text_mismatch` (schema/121). Every writer of
 * `sample.protocol` writes `sample_method` in the same transaction, so the view
 * is always empty; a row in it is a writer that forgot. The nightly's last step
 * runs it (src/app/jobs/registry.ts, `pipelineTail`), as it runs
 * `checkObservationFields`. Throws with the number of samples and never names
 * them, since a sample's number and method are not for a job's log; returns
 * normally when the two agree.
 */
export async function checkSampleMethods(conn: DuckDBConnection): Promise<void> {
  const [[n]] = (await (await conn.run("SELECT count(*) FROM sample_method_text_mismatch")).getRows()) as [[bigint | number]];
  if (Number(n) === 0) return;
  throw new Error(`${Number(n)} sample(s) have a stored method that disagrees with their method as written`);
}
