import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { appliedMigrations, baseline, migrate, migrationFiles, pendingMigrations, schemaDrift } from "../src/migrate.js";
import { createMemoryDb, rows } from "./helpers.js";

let conn: DuckDBConnection;
let dir: string;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  dir = await mkdtemp(join(tmpdir(), "beeline-migrations-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (name: string, sql: string) => writeFile(join(dir, name), sql);

describe("the migration ledger", () => {
  test("the real migrations directory is what a fresh build stamps", async () => {
    // createMemoryDb applies schema/*.sql only; the CLI's build stamps after.
    expect(await pendingMigrations(conn)).toEqual(await migrationFiles());
    const stamped = await baseline(conn);
    expect(stamped).toEqual(await migrationFiles());
    expect(await pendingMigrations(conn)).toEqual([]);
  });

  test("stamping records a migration without running it", async () => {
    await write("0001-would-fail.sql", "SELECT this_would_not_parse FROM nowhere;");
    await baseline(conn, dir);
    expect([...(await appliedMigrations(conn))]).toContain("0001-would-fail.sql");
  });

  test("a store with no ledger gets one, and migrations run in filename order", async () => {
    await conn.run("DROP TABLE schema_migration");
    await write("0002-second.sql", "CREATE TABLE second (id INTEGER);");
    await write("0001-first.sql", "CREATE TABLE first (id INTEGER);");
    expect(await migrate(conn, { dir })).toEqual(["0001-first.sql", "0002-second.sql"]);
    const order = await rows(conn, "SELECT name FROM schema_migration ORDER BY applied_at, name");
    expect(order.flat()).toEqual(["0001-first.sql", "0002-second.sql"]);
  });

  test("a second run is a no-op", async () => {
    await write("0001-once.sql", "CREATE TABLE once (id INTEGER);");
    expect(await migrate(conn, { dir })).toEqual(["0001-once.sql"]);
    // Re-running the CREATE would throw; it must not be attempted.
    expect(await migrate(conn, { dir })).toEqual([]);
  });

  test("a failing migration rolls back whole, and does not block a fix", async () => {
    await write("0001-broken.sql", "CREATE TABLE half (id INTEGER); CREATE TABLE half (id INTEGER);");
    await expect(migrate(conn, { dir })).rejects.toThrow(/0001-broken\.sql/);
    expect(await rows(conn, `SELECT 1 FROM information_schema.tables WHERE table_name = 'half'`)).toHaveLength(0);
    expect([...(await appliedMigrations(conn))]).not.toContain("0001-broken.sql");

    await write("0001-broken.sql", "CREATE TABLE half (id INTEGER);");
    expect(await migrate(conn, { dir })).toEqual(["0001-broken.sql"]);
  });

  test("a later migration does not run when an earlier one fails", async () => {
    await write("0001-broken.sql", "SELECT this_would_not_parse FROM nowhere;");
    await write("0002-fine.sql", "CREATE TABLE fine (id INTEGER);");
    await expect(migrate(conn, { dir })).rejects.toThrow();
    expect(await rows(conn, `SELECT 1 FROM information_schema.tables WHERE table_name = 'fine'`)).toHaveLength(0);
  });
});

describe("drift against the schema", () => {
  test("a database built from the schema has none", async () => {
    expect(await schemaDrift(conn)).toEqual([]);
  });

  test("a missing view — the forgotten-migration case — is named", async () => {
    await conn.run("DROP VIEW pending_print_sample");
    expect(await schemaDrift(conn)).toEqual(["missing: pending_print_sample"]);
  });

  test("a missing column on a table the schema declares is named", async () => {
    await conn.run("ALTER TABLE job_run DROP COLUMN detail");
    expect(await schemaDrift(conn)).toEqual(["missing: job_run.detail"]);
  });

  test("an extra column on a table the schema declares is named", async () => {
    await conn.run("ALTER TABLE sample ADD COLUMN hand_added TEXT");
    expect(await schemaDrift(conn)).toEqual(["not in the schema: sample.hand_added"]);
  });

  test("tables the schema never declared are not drift — the pipeline makes those", async () => {
    // A real store also holds the legacy load's staging tables (ingest/*.sql).
    await conn.run("CREATE TABLE legacy_staging_whatever (id INTEGER)");
    expect(await schemaDrift(conn)).toEqual([]);
  });
});
