import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, buildStore } from "../src/build-db.js";
import { countRegistryAt, PrintedStoreRefused } from "../src/registry-guard.js";
import { rows } from "./helpers.js";

/**
 * `db:build` deletes whatever is at its target before building, so on
 * production `pnpm db:build data/beeline.duckdb` would delete the live store's
 * print runs and minted numbers (beeline-83b8.13). It refuses a target that
 * has printed, and builds over anything else as it always has. File-backed,
 * because a file at the target path is what is under test.
 */

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "beeline-build-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A store built from the schema, with what `sql` adds to it. */
async function store(name: string, sql: string[] = []): Promise<string> {
  const path = join(dir, name);
  const instance = await DuckDBInstance.create(path);
  const conn = await instance.connect();
  await applySchema(conn);
  for (const statement of sql) await conn.run(statement);
  conn.closeSync();
  instance.closeSync();
  return path;
}

const PERSON = `INSERT INTO person (display_name) VALUES ('Ada Ash')`;
const RUN = `INSERT INTO print_run (prepared_by) SELECT min(entity_id) FROM person`;
const MINTED = `INSERT INTO minted_field_number (field_number, print_run_id) SELECT '26072092', min(entity_id) FROM print_run`;

describe("building over a store", () => {
  test("a target that has printed is refused, and left as it was", async () => {
    const live = await store("printed.duckdb", [PERSON, RUN, MINTED]);
    await expect(buildStore(live)).rejects.toThrow(PrintedStoreRefused);
    await expect(buildStore(live)).rejects.toThrow(/Nothing was deleted/);
    expect(await countRegistryAt(live)).toEqual({ print_run: 1, minted_field_number: 1 });
  });

  test("a print run with no minted number is enough to refuse", async () => {
    // The schema allows a run with no minted number, so a guard reading
    // only one table must fail here.
    const live = await store("run-only.duckdb", [PERSON, RUN]);
    await expect(buildStore(live)).rejects.toThrow(/1 print run\(s\) and 0 minted field number\(s\)/);
  });

  test("a store with an empty registry is rebuilt, as before", async () => {
    const path = await store("unprinted.duckdb", [PERSON]);
    const stamped = await buildStore(path);
    expect(stamped.length).toBeGreaterThan(0);
    const instance = await DuckDBInstance.create(path);
    const conn = await instance.connect();
    expect(await rows(conn, `SELECT count(*) FROM person`)).toEqual([[0n]]);
    conn.closeSync();
  });

  test("a store from before print runs had tables counts as having printed nothing", async () => {
    // schema/035 made print_run and minted_field_number; an older store has
    // neither, and asking must not fail on the missing tables.
    const path = join(dir, "before-035.duckdb");
    const instance = await DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(`CREATE TABLE person (entity_id INTEGER PRIMARY KEY, display_name TEXT)`);
    conn.closeSync();
    instance.closeSync();
    expect(await countRegistryAt(path)).toEqual({ print_run: 0, minted_field_number: 0 });
    await expect(buildStore(path)).resolves.toBeInstanceOf(Array);
  });

  test("a path with nothing at it is built", async () => {
    await expect(buildStore(join(dir, "new.duckdb"))).resolves.toBeInstanceOf(Array);
  });
});
