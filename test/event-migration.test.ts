import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { migrate, MIGRATIONS_DIR, schemaDrift } from "../src/migrate.js";
import { createEvent } from "../src/event.js";
import { createMemoryDb, currentSeasonDate, rows } from "./helpers.js";

/**
 * migrations/0112 brings a deployed store to the schema's event tables (beeline-2zej.1.4), checked by making the
 * store as it was, without them, and migrating it. A deployed store gets the CHECKs because they are written in
 * the CREATE TABLE statements; the last test shows that they are there.
 */

const FILE = "0112-events.sql";
const TABLES = ["event", "event_kind", "event_place", "event_online", "event_registration", "event_change"];

async function onlyThisMigration(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "migration-0112-"));
  await copyFile(join(MIGRATIONS_DIR, FILE), join(dir, "9999-under-test.sql"));
  return dir;
}

const list = (names: string[]) => names.map((n) => `'${n}'`).join(", ");
const columns = (conn: DuckDBConnection) =>
  rows(
    conn,
    `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default, d.comment
     FROM information_schema.columns c
     LEFT JOIN duckdb_columns() d ON d.table_name = c.table_name AND d.column_name = c.column_name
     WHERE c.table_name IN (${list([...TABLES, "event_kind_unlisted"])}) ORDER BY c.table_name, c.ordinal_position`,
  );
const comments = (conn: DuckDBConnection) =>
  rows(
    conn,
    `SELECT table_name, comment FROM duckdb_tables() WHERE table_name IN (${list(TABLES)})
     UNION ALL SELECT view_name, comment FROM duckdb_views() WHERE view_name = 'event_kind_unlisted' ORDER BY 1`,
  );
const view = (conn: DuckDBConnection) => rows(conn, `SELECT sql FROM duckdb_views() WHERE view_name = 'event_kind_unlisted'`);
const constraints = (conn: DuckDBConnection) =>
  rows(
    conn,
    `SELECT table_name, constraint_type, constraint_text FROM duckdb_constraints()
     WHERE table_name IN (${list(TABLES)}) AND constraint_type IN ('CHECK', 'PRIMARY KEY', 'FOREIGN KEY') ORDER BY 1, 2, 3`,
  );

async function withoutEvents(conn: DuckDBConnection): Promise<void> {
  await conn.run("DROP VIEW event_kind_unlisted");
  for (const table of ["event_change", "event_registration", "event_online", "event_place", "event", "event_kind"]) await conn.run(`DROP TABLE ${table}`);
}

describe("migration 0112: the event tables", () => {
  it("leaves a deployed store as the schema makes it, comments and constraints included", async () => {
    const { conn } = await createMemoryDb();
    const built = { columns: await columns(conn), comments: await comments(conn), view: await view(conn), constraints: await constraints(conn), kinds: await rows(conn, "SELECT code, name FROM event_kind ORDER BY code") };
    expect(built.columns.length).toBeGreaterThan(30);

    await withoutEvents(conn);
    expect(await columns(conn)).toEqual([]);

    expect(await migrate(conn, { dir: await onlyThisMigration() })).toEqual(["9999-under-test.sql"]);
    expect(await columns(conn)).toEqual(built.columns);
    expect(await comments(conn)).toEqual(built.comments);
    expect(await view(conn)).toEqual(built.view);
    expect(await constraints(conn)).toEqual(built.constraints);
    expect(await schemaDrift(conn)).toEqual([]);
    expect(await rows(conn, "SELECT code, name FROM event_kind ORDER BY code")).toEqual(built.kinds);
    expect(built.kinds).toEqual([
      ["conference", "Conference"],
      ["course", "Course"],
      ["deadline", "Deadline"],
      ["field day", "Field day"],
      ["meeting", "Meeting"],
      ["microscope session", "Microscope session"],
      ["other", "Other"],
      ["outreach", "Outreach"],
      ["talk", "Talk"],
    ]);
  });

  it("gives the migrated store the CHECKs, so it refuses what a fresh build refuses", async () => {
    const { conn } = await createMemoryDb();
    await withoutEvents(conn);
    await migrate(conn, { dir: await onlyThisMigration() });
    const [[person]] = (await rows(conn, "INSERT INTO person (display_name) VALUES ('Ada Organizer') RETURNING entity_id")) as [[number]];
    const [[mm]] = (await rows(conn, "SELECT entity_id FROM program WHERE code = 'MM'")) as [[number]];
    const e = { programId: mm, kind: "deadline", collecting: false, name: "Due", dateStart: currentSeasonDate(10, 30) };
    await expect(createEvent(conn, { ...e, dateEnd: currentSeasonDate(10, 1) }, person)).rejects.toThrow(/CHECK constraint/);
    await expect(createEvent(conn, { ...e, timeStart: "09:00" }, person)).rejects.toThrow(/CHECK constraint/);
    await expect(createEvent(conn, { ...e, place: { name: "A park", latitude: 91, longitude: 0 } }, person)).rejects.toThrow(/CHECK constraint/);
    await expect(conn.run(`INSERT INTO event (program_id, kind, collecting, name, date_start, date_end, created_by) VALUES (${mm}, 'talk', false, '', DATE '${currentSeasonDate(6, 1)}', DATE '${currentSeasonDate(6, 1)}', ${person})`)).rejects.toThrow(/CHECK constraint/);
    await expect(createEvent(conn, { ...e, timeEnd: "09:00" }, person)).rejects.toThrow(/CHECK constraint/);
    await expect(createEvent(conn, { ...e, place: { name: "A park", latitude: 44 } }, person)).rejects.toThrow(/CHECK constraint/);
    await createEvent(conn, e, person);
    expect(await rows(conn, "SELECT count(*) FROM event_kind_unlisted")).toEqual([[0n]]);
  });
});
