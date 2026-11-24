import type { DuckDBConnection } from "@duckdb/node-api";
import { sql, type Kysely } from "kysely";
import type { Database } from "./model.js";

/**
 * The one place a sample's method row and trap count are written (beeline-ni5m.15).
 *
 * `sample_method.trap_count` is the trap count: nothing reads one from anywhere else, and nothing writes one but this.
 * It belongs to a method that is a trap, so it is null for any other. `sample.sampling_effort` is written here and
 * nowhere else, from the stored count and method, for no purpose but to keep that old column filled until it is
 * retired, and nothing reads it but the API's read of a sample and the change log: the text `trapEffort` writes when there
 * is a count, null when there is none. The view
 * `sample_method_out_of_step` asserts all of it.
 */

/** A raw DuckDB connection or a Kysely handle, each inside the caller's transaction. */
export type MethodTarget = DuckDBConnection | Kysely<Database>;

/**
 * The text kept in the old `sampling_effort` column for a count of traps of a method: the count and the method,
 * plural where there is more than one ("6 vane traps", "1 pan trap"). The view `sample_method_out_of_step` spells the
 * same text in SQL, and test/sample-method-row.test.ts holds the two together.
 */
export const trapEffort = (count: number, method: string): string =>
  `${count} ${method}${count === 1 || /s$/i.test(method) ? "" : "s"}`;

/** One statement on either kind of target; `$1`, `$2` … appear in order, once each. */
async function run(target: MethodTarget, text: string, params: Array<string | number | null>): Promise<Record<string, unknown>[]> {
  if ("runAndReadAll" in target) return (await target.runAndReadAll(text, params as never)).getRowObjectsJS() as Record<string, unknown>[];
  const parts = text.split(/\$\d+/);
  const strings = Object.assign([...parts], { raw: [...parts] }) as unknown as TemplateStringsArray;
  return (await sql<Record<string, unknown>>(strings, ...params).execute(target)).rows;
}

/**
 * Give a sample the method `code` and the trap count `count` (null for none), in the caller's transaction, making the
 * method's row where the sample has none. A method that is not a trap takes no count, so the count is dropped for it.
 * Then the old effort column is written from what is stored.
 */
export async function setSampleMethodRow(target: MethodTarget, sampleId: number, code: string, count: number | null): Promise<void> {
  const trap = (await run(target, `SELECT is_trap FROM method WHERE code = $1`, [code]))[0]?.is_trap === true;
  const kept = trap ? count : null;
  await run(
    target,
    `INSERT INTO sample_method (sample_id, method_code, trap_count) VALUES ($1, $2, $3)
     ON CONFLICT (sample_id) DO UPDATE SET method_code = excluded.method_code, trap_count = excluded.trap_count`,
    [sampleId, code, kept],
  );
  await run(target, `UPDATE sample SET sampling_effort = $1 WHERE entity_id = $2`, [kept === null ? null : trapEffort(kept, code), sampleId]);
}

/** Write the old effort column of samples that already have their method row, from it: for the rows a SQL statement made. */
export async function fillEffortFromStored(target: MethodTarget, sampleIds: readonly number[]): Promise<void> {
  for (const id of sampleIds) {
    const row = (await run(target, `SELECT method_code, trap_count FROM sample_method WHERE sample_id = $1`, [id]))[0];
    if (row === undefined) continue;
    await setSampleMethodRow(target, id, String(row.method_code), row.trap_count === null ? null : Number(row.trap_count));
  }
}
