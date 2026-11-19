import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { migrate, migrationNeeds, MIGRATIONS_DIR } from "../src/migrate.js";
import { createMemoryDb, rows } from "./helpers.js";
import { promotedStore } from "./promoted-store.js";

/**
 * migrations/0109 recreates legacy promotion's three correction views with
 * recordedBy known (beeline-kgyd.4.5), since production is never promoted
 * again, and does nothing on a store nothing was promoted into.
 */

const FILE = "0109-collectors-in-old-records.sql";
const VIEWS = ["legacy_correction_state", "legacy_correction_pivot", "legacy_occurrence_corrected"];

/** A folder holding only this migration, under a name no store has recorded. */
async function onlyThisMigration(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "migration-0109-"));
  await copyFile(join(MIGRATIONS_DIR, FILE), join(dir, "9999-under-test.sql"));
  return dir;
}

const definitions = async (conn: DuckDBConnection) =>
  rows(conn, `SELECT view_name, sql FROM duckdb_views() WHERE view_name IN (${VIEWS.map((v) => `'${v}'`).join(", ")}) ORDER BY 1`);

const statusOfARecordedByEvent = async (conn: DuckDBConnection) => {
  await conn.run(`DELETE FROM legacy_correction WHERE field = 'recordedBy'`);
  await conn.run(
    `INSERT INTO legacy_correction (_id, field, base_value, new_value, author, reason)
     VALUES ('bbbb2222', 'recordedBy', 'Bea Trapper', 'Ada Collector | Bea Trapper', 'samstaff', 'test')`,
  );
  const [[status]] = (await rows(conn, `SELECT status FROM legacy_correction_state WHERE field = 'recordedBy'`)) as [[string]];
  const [[recordedBy]] = (await rows(conn, `SELECT "recordedBy" FROM legacy_occurrence_corrected WHERE _id = 'bbbb2222'`)) as [[string]];
  return [status, recordedBy];
};

describe("migration 0109: recordedBy in the old records' corrections", () => {
  it("names what it needs on its first line", async () => {
    expect(migrationNeeds(await readFile(join(MIGRATIONS_DIR, FILE), "utf8"))).toEqual(VIEWS);
    expect(migrationNeeds("-- Migration for something\nCREATE TABLE x (y INTEGER);")).toEqual([]);
  });

  it("on a store promotion left, as production's was, makes a recordedBy correction apply", async () => {
    const { conn } = await promotedStore("occurrences");
    // Production's views, made before recordedBy was correctable: the same, without it.
    const before = (await readFile(join(MIGRATIONS_DIR, FILE), "utf8"))
      .split("\n")
      .filter((line) => !line.includes("recordedBy"))
      .join("\n")
      .replace(/fieldNumber,\n/g, "fieldNumber\n");
    await conn.run(before);
    expect(await statusOfARecordedByEvent(conn)).toEqual(["invalid_field", "Bea Trapper"]);

    expect(await migrate(conn, { dir: await onlyThisMigration() })).toEqual(["9999-under-test.sql"]);
    expect(await statusOfARecordedByEvent(conn)).toEqual(["applies", "Ada Collector | Bea Trapper"]);
  });

  it("holds the views exactly as ingest/promote-legacy.sql makes them", async () => {
    const promotion = await readFile(new URL("../ingest/promote-legacy.sql", import.meta.url), "utf8");
    const migration = await readFile(join(MIGRATIONS_DIR, FILE), "utf8");
    const views = promotion.slice(promotion.indexOf("CREATE OR REPLACE VIEW legacy_correction_state"), promotion.indexOf("-- ── Parsing")).trimEnd();
    expect(migration.slice(migration.indexOf("CREATE OR REPLACE VIEW legacy_correction_state")).trimEnd()).toBe(views);
  });

  it("on a store nothing was promoted into, is recorded and changes nothing", async () => {
    const { conn } = await createMemoryDb();
    expect(await migrate(conn, { dir: await onlyThisMigration() })).toEqual(["9999-under-test.sql"]);
    expect(await definitions(conn)).toEqual([]);
    expect(await rows(conn, `SELECT count(*) FROM schema_migration WHERE name = '9999-under-test.sql'`)).toEqual([[1n]]);
  });

  it("a migration that needs something a store lacks is recorded without running", async () => {
    const { conn } = await createMemoryDb();
    const dir = await mkdtemp(join(tmpdir(), "migration-needs-"));
    await writeFile(join(dir, "9998-needs.sql"), "-- needs: no_such_view\nSELECT * FROM no_such_view;\n");
    expect(await migrate(conn, { dir })).toEqual(["9998-needs.sql"]);
  });
});
