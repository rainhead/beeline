import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { migrate, MIGRATIONS_DIR, schemaDrift } from "../src/migrate.js";
import { createMemoryDb, insertCleanSample, rows, SETTLED_SEASON } from "./helpers.js";

/**
 * migrations/0110 brings a deployed store to the schema's release for
 * printing (beeline-3vs.7): the table, the view of settled samples that never
 * print, and the three views that read it. Checked by making the store as it
 * was and migrating it.
 */

const FILE = "0110-settled-samples-print-once-released.sql";
const VIEWS = ["settled_unreleased_sample", "pending_print_sample", "sample_labels_waiting", "sample_coordinate_limit"];

async function onlyThisMigration(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "migration-0110-"));
  await copyFile(join(MIGRATIONS_DIR, FILE), join(dir, "9999-under-test.sql"));
  return dir;
}

const definitions = async (conn: DuckDBConnection) =>
  rows(conn, `SELECT view_name, sql FROM duckdb_views() WHERE view_name IN (${VIEWS.map((v) => `'${v}'`).join(", ")}) ORDER BY 1`);
const columns = async (conn: DuckDBConnection) =>
  rows(conn, `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'sample_print_release' ORDER BY ordinal_position`);

/** The store as a deployed one was before the migration: the three views read `settled_sample`, and nothing else exists. */
async function asBefore(conn: DuckDBConnection): Promise<void> {
  const migration = await readFile(join(MIGRATIONS_DIR, FILE), "utf8");
  const views = migration.slice(migration.indexOf("CREATE OR REPLACE VIEW pending_print_sample"));
  await conn.run(views.replaceAll("settled_unreleased_sample", "settled_sample"));
  await conn.run("DROP VIEW settled_unreleased_sample");
  await conn.run("DROP TABLE sample_print_release");
}

describe("migration 0110: a settled sample prints once staff have released it", () => {
  it("leaves a deployed store as the schema makes it, and a released sample then prints", async () => {
    const { conn } = await createMemoryDb();
    const built = { views: await definitions(conn), columns: await columns(conn) };
    await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Ash')`);
    const sample = await insertCleanSample(conn, {
      kind: "'trap'",
      date_start: `DATE '${SETTLED_SEASON}-07-14'`,
      date_end: `DATE '${SETTLED_SEASON}-07-14'`,
    });

    await asBefore(conn);
    expect(await definitions(conn)).not.toEqual(built.views);
    expect(await rows(conn, "SELECT sample_id FROM pending_print_sample")).toEqual([]);

    expect(await migrate(conn, { dir: await onlyThisMigration() })).toEqual(["9999-under-test.sql"]);
    expect(await definitions(conn)).toEqual(built.views);
    expect(await columns(conn)).toEqual(built.columns);
    expect(await schemaDrift(conn)).toEqual([]);
    // Nothing is released by the migration itself.
    expect(await rows(conn, "SELECT count(*) FROM sample_print_release")).toEqual([[0n]]);
    expect(await rows(conn, "SELECT sample_id FROM pending_print_sample")).toEqual([]);
    await conn.run(`INSERT INTO sample_print_release (sample_id) VALUES (${sample})`);
    expect(await rows(conn, "SELECT sample_id, pending_count FROM pending_print_sample")).toEqual([[sample, 3]]);
  });
});
