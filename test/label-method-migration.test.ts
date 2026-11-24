import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, MIGRATIONS_DIR, schemaDrift } from "../src/migrate.js";
import { createMemoryDb, rows } from "./helpers.js";

/**
 * migrations/0125 replaces printed_label_out_of_date so that the method word
 * it compares comes from the sample's method (beeline-ni5m.15; 0122 had it
 * from the method text, beeline-lmlh, and 0119 first made it compare the
 * method, beeline-5rqm). Checked by putting the view back as migration 0074
 * made it, migrating, and finding the store as a fresh build.
 */

const FILE = "0125-readers-of-the-method-use-the-method.sql";
const definition = async (conn: Awaited<ReturnType<typeof createMemoryDb>>["conn"]) =>
  rows(conn, `SELECT sql, comment FROM duckdb_views() WHERE view_name = 'printed_label_out_of_date'`);

describe("migration 0125: a label out of date for its method", () => {
  it("leaves a deployed store as the schema makes it", async () => {
    const { conn } = await createMemoryDb();
    const built = await definition(conn);
    // The view as it was deployed, from the migration that made it.
    const text = await readFile(join(MIGRATIONS_DIR, "0074-labels-out-of-date.sql"), "utf8");
    await conn.run("DROP VIEW printed_label_out_of_date");
    await conn.run(text.slice(text.indexOf("CREATE VIEW printed_label_out_of_date")));
    expect(await definition(conn)).not.toEqual(built);

    const dir = await mkdtemp(join(tmpdir(), "migration-0125-"));
    await copyFile(join(MIGRATIONS_DIR, FILE), join(dir, "9999-under-test.sql"));
    expect(await migrate(conn, { dir })).toEqual(["9999-under-test.sql"]);
    expect(await definition(conn)).toEqual(built);
    expect(await schemaDrift(conn)).toEqual([]);
  });
});
