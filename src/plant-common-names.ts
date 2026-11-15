import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * Copy the rows of `plant_taxon_common_name` (schema/114) into
 * `plant_common_name_cache` (schema/068), whole, in one transaction, and say
 * how many taxa have a name.
 *
 * A page reads one taxon's name in a lookup there, where working the name out
 * from the plant list takes about 20 milliseconds (schema/068 says why). The
 * copy is only as fresh as the last time this ran, so everything that changes
 * what the view says runs it when it finishes: the list's load
 * (`loadPlantList`), the plant-names fetch and the taxa fetch. A reader that
 * joins the cache and a writer that refreshes it never wait for each other:
 * the swap is one transaction.
 */
export async function refreshPlantCommonNames(conn: DuckDBConnection): Promise<number> {
  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run("DELETE FROM plant_common_name_cache");
    await conn.run(
      `INSERT INTO plant_common_name_cache (inat_taxon_id, common_name, source, list_entry, list_entry_depth)
       SELECT inat_taxon_id, common_name, source, list_entry, list_entry_depth FROM plant_taxon_common_name`,
    );
    const [[n]] = (await (await conn.run("SELECT count(*) FROM plant_common_name_cache")).getRows()) as [[bigint]];
    await conn.run("COMMIT");
    return Number(n);
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}

/**
 * Run `work`, then refresh the copy, even when `work` stopped half way: what a
 * fetch stored before the deadline or an error is in the cache, so the names
 * should follow it. A refresh that fails after a failure is logged and the
 * first error is the one thrown; after a success its failure is the failure.
 */
export async function thenRefreshPlantCommonNames<T>(conn: DuckDBConnection, work: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (err) {
    await refreshPlantCommonNames(conn).catch((refreshErr: unknown) =>
      console.error(`could not refresh the plant common names after a failure: ${String(refreshErr)}`),
    );
    throw err;
  }
  await refreshPlantCommonNames(conn);
  return result;
}
