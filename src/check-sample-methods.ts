import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * Fail when a sample's method, trap count or old effort column is out of step with what the sample says, by counting
 * `sample_method_out_of_step` (schema/121) by the clause each row fails. Every writer keeps all three in one
 * transaction (src/sample-method-row.ts), so the view is always empty; a row in it is a writer that forgot. The
 * nightly's last step runs it (src/app/jobs/registry.ts, `pipelineTail`), as it runs `checkObservationFields`. Throws
 * with the numbers and never names a sample, since a sample's number and method are not for a job's log; returns
 * normally when nothing is out of step.
 */
export async function checkSampleMethods(conn: DuckDBConnection): Promise<void> {
  const found = (await (await conn.run("SELECT clause, count(*) FROM sample_method_out_of_step GROUP BY clause ORDER BY clause")).getRows()) as [string, bigint | number][];
  if (found.length === 0) return;
  const total = found.reduce((n, [, k]) => n + Number(k), 0);
  throw new Error(`${total} sample(s) have a method, trap count or effort out of step with what they say (${found.map(([c, k]) => `${c}: ${Number(k)}`).join(", ")})`);
}
