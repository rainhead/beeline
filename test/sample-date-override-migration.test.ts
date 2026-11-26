import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { migrate, MIGRATIONS_DIR, schemaDrift } from "../src/migrate.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

/**
 * migrations/0128 brings a deployed store to the schema's table of samples whose dates staff set (beeline-qu2c).
 * Checked by making the store as it was, without the table, and migrating it.
 */

const columns = (conn: DuckDBConnection) =>
  rows(
    conn,
    `SELECT c.column_name, c.data_type, c.is_nullable, d.comment
     FROM information_schema.columns c
     LEFT JOIN duckdb_columns() d ON d.table_name = c.table_name AND d.column_name = c.column_name
     WHERE c.table_name = 'sample_date_override' ORDER BY c.ordinal_position`,
  );
const tableComment = (conn: DuckDBConnection) => rows(conn, `SELECT comment FROM duckdb_tables() WHERE table_name = 'sample_date_override'`);

it("leaves a deployed store as the schema makes it, comments included, and the new table works", async () => {
  const { conn } = await createMemoryDb();
  const built = { columns: await columns(conn), table: await tableComment(conn) };
  expect(built.columns).toHaveLength(4);
  await conn.run("DROP TABLE sample_date_override");
  expect(await columns(conn)).toEqual([]);

  const dir = await mkdtemp(join(tmpdir(), "migration-0128-"));
  await copyFile(join(MIGRATIONS_DIR, "0128-staff-set-dates-stay.sql"), join(dir, "9999-under-test.sql"));
  expect(await migrate(conn, { dir })).toEqual(["9999-under-test.sql"]);
  expect(await columns(conn)).toEqual(built.columns);
  expect(await tableComment(conn)).toEqual(built.table);
  expect(await schemaDrift(conn)).toEqual([]);
  expect(await rows(conn, "SELECT count(*) FROM sample_date_override")).toEqual([[0n]]);
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Ash')");
  const sample = await insertCleanSample(conn);
  await conn.run(`INSERT INTO sample_date_override (sample_id, reason) VALUES (${sample}, 'x')`);
  expect(await rows(conn, "SELECT reason FROM sample_date_override")).toEqual([["x"]]);
});
