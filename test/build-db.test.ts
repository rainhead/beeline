import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, buildStore } from "../src/build-db.js";
import { countRegistryAt, PrintedStoreRefused, StoreRefused } from "../src/registry-guard.js";
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
    // One argument, so no word about their order.
    await expect(buildStore(live)).rejects.toThrow(/Nothing was deleted, and there is no override\. See /);
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

  test("a file that is not a store is refused rather than replaced", async () => {
    // It used to be deleted and built over. It cannot be read to ask whether
    // it has printed, so it is left for a person to move aside.
    for (const [name, content] of [["empty.duckdb", ""], ["notes.duckdb", "not a database\n"]] as const) {
      const path = join(dir, name);
      await writeFile(path, content);
      await expect(buildStore(path)).rejects.toThrow(StoreRefused);
      await expect(buildStore(path)).rejects.toThrow(/not a store Beeline can read.*Move it aside/);
      expect(await readFile(path, "utf8")).toBe(content);
    }
  });

  test("a WAL with no store beside it is refused, not discarded", async () => {
    const path = join(dir, "wal-only.duckdb");
    await writeFile(`${path}.wal`, "a WAL a store was never checkpointed from");
    await expect(buildStore(path)).rejects.toThrow(/a WAL is beside it with no store.*Nothing was deleted/);
    expect(existsSync(`${path}.wal`)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("a path with nothing at it is built", async () => {
    await expect(buildStore(join(dir, "new.duckdb"))).resolves.toBeInstanceOf(Array);
  });
});
