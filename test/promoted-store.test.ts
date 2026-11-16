import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { createMemoryDb } from "./helpers.js";
import { openCopy, PROMOTED_STORES, promotedStore, writeCopy } from "./promoted-store.js";

/**
 * Everything a test can see in a store, as plain values: each table's and
 * view's columns and rows, and the rest of the catalog. A view is compared by
 * what it returns, not by its text, which DuckDB prints with the names in an
 * EXCLUDE or REPLACE list in no fixed order.
 */
async function contents(conn: DuckDBConnection) {
  const read = async (sql: string) => JSON.stringify((await conn.runAndReadAll(sql)).getRows(), (_, v) => (typeof v === "bigint" ? v.toString() : v));
  const relations = JSON.parse(
    await read(`SELECT table_name FROM duckdb_tables() WHERE database_name = 'memory'
                UNION ALL SELECT view_name FROM duckdb_views() WHERE database_name = 'memory' AND NOT internal ORDER BY 1`),
  ) as [string][];
  const rows: Record<string, string> = {};
  for (const [relation] of relations) rows[relation] = await read(`SELECT * FROM "${relation}" ORDER BY ALL`);
  return {
    rows,
    columns: await read(
      `SELECT table_name, column_index, column_name, data_type, is_nullable, column_default
       FROM duckdb_columns() WHERE database_name = 'memory' ORDER BY ALL`,
    ),
    macros: await read(
      `SELECT function_name, parameters FROM duckdb_functions()
       WHERE database_name = 'memory' AND function_type LIKE '%macro' AND NOT internal ORDER BY ALL`,
    ),
    indexes: await read(`SELECT index_name, sql FROM duckdb_indexes() WHERE database_name = 'memory' ORDER BY 1`),
    constraints: await read(`SELECT table_name, constraint_text FROM duckdb_constraints() WHERE database_name = 'memory' ORDER BY ALL`),
    nextEntityId: await read(`SELECT nextval('entity_id_seq')`),
  };
}

describe("a copy of a promoted store", () => {
  test("holds everything the store it was copied from held, down to the next entity id", async () => {
    // Compared with the store it was copied from, not with a second
    // promotion: promotion hands out entity ids in no fixed order, so two
    // promotions of one fixture number their specimens differently.
    const { staging, inputs } = PROMOTED_STORES.corrected;
    const { conn: promoted } = await createMemoryDb();
    await loadLegacyStaging(promoted, staging);
    await promoteLegacy(promoted, inputs);
    const file = join(await mkdtemp(join(tmpdir(), "beeline-promoted-")), "copy.duckdb");
    await writeCopy(promoted, file);
    const { conn: copied } = await openCopy(file);
    const [want, got] = [await contents(promoted), await contents(copied)];
    // The animal tree is the one table copied a level at a time: say so if it ever has nothing to copy.
    expect(want.rows.animal).not.toBe("[]");
    expect(Object.keys(got.rows)).toEqual(Object.keys(want.rows));
    for (const name of Object.keys(want.rows)) expect(got.rows[name], name).toBe(want.rows[name]);
    expect(got).toEqual(want);
  });

  test("is a store of the test's own, which another copy does not see", async () => {
    const { conn: one } = await promotedStore("occurrences");
    const { conn: two } = await promotedStore("occurrences");
    await one.run(`INSERT INTO person (display_name) VALUES ('Only In One')`);
    const count = async (conn: DuckDBConnection) =>
      (await conn.runAndReadAll(`SELECT count(*) FROM person WHERE display_name = 'Only In One'`)).getRows();
    expect(await count(one)).toEqual([[1n]]);
    expect(await count(two)).toEqual([[0n]]);
  });

  test("creates the test's corrections file, and refuses one that already holds corrections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beeline-promoted-"));
    const path = join(dir, "corrections.csv");
    await promotedStore("occurrences", { appCorrections: path });
    expect(await readFile(path, "utf8")).toBe("_id,field,base_value,new_value,author,reason\n");
    await writeFile(path, "_id,field,base_value,new_value,author,reason\nbbbb2222,locality,a,b,someone,why\n");
    await expect(promotedStore("occurrences", { appCorrections: path })).rejects.toThrow(/already holds corrections/);
  });
});
