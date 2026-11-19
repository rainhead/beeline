import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";
import { createMemoryDb as buildFromSchema } from "../src/schema.js";

/**
 * What existsSync answers for a path, where a test needs to say: undefined
 * asks the file system. It lets a test put an event between templateFile
 * looking for its template and reading the lock, which no real timing can
 * arrange reliably.
 */
const existsOverride = vi.hoisted(() => ({ answer: (_path: string): boolean | undefined => undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const existsSync = (path: import("node:fs").PathLike) => existsOverride.answer(String(path)) ?? fs.existsSync(path);
  return { ...fs, existsSync, default: { ...fs, existsSync } };
});
import { createMemoryDb } from "./helpers.js";
import { sessionState, storeContents, templateFile } from "./store-template.js";

// Nearly every test runs on the copy createMemoryDb hands out rather than on
// a store built from schema/*.sql (beeline-tl4q), so this is the test that
// stands between the suite and a copy that quietly lost part of the schema.
describe("the copy of the schema that createMemoryDb hands out", () => {
  test("is the store schema/*.sql builds, in the catalog and in every row, down to the next entity id", async () => {
    const { conn: built } = await buildFromSchema();
    const { conn: copied } = await createMemoryDb();
    const [want, got] = [await storeContents(built), await storeContents(copied)];
    // Compared piece by piece first, so a failure names what the copy lost.
    for (const [part, entries] of Object.entries(want.catalog)) {
      expect(got.catalog[part as keyof typeof got.catalog], part).toEqual(entries);
    }
    for (const [relation, rows] of Object.entries(want.rows)) expect(got.rows[relation], relation).toBe(rows);
    expect(got).toEqual(want);
  });

  test("sets, loads and keeps aside nothing a store built from the schema does not", async () => {
    const { conn: built } = await buildFromSchema();
    const { conn: copied } = await createMemoryDb();
    const [want, got] = [await sessionState(built), await sessionState(copied)];
    for (const [part, entries] of Object.entries(want)) expect(got[part as keyof typeof got], part).toEqual(entries);
    // Not vacuous: DuckDB has well over a hundred settings, and loads some extensions itself.
    expect(want.settings.length).toBeGreaterThan(100);
    expect(want.extensions.length).toBeGreaterThan(0);
  });

  test("compares a schema that has each thing a copy could lose", async () => {
    // Without this, a catalog query that matched nothing would compare two
    // empty lists and pass.
    const { conn } = await buildFromSchema();
    const { catalog, rows } = await storeContents(conn);
    expect(catalog.database).toEqual([{ name: "memory", schema: "main" }]);
    const constraintTypes = new Set(catalog.constraints.map((c) => c.constraint_type));
    for (const type of ["CHECK", "NOT NULL", "PRIMARY KEY", "UNIQUE", "FOREIGN KEY"]) expect(constraintTypes, type).toContain(type);
    expect(catalog.columns.some((c) => c.column_default !== null)).toBe(true);
    expect(catalog.columns.some((c) => typeof c.column_default === "string" && c.column_default.includes("nextval"))).toBe(true);
    expect(catalog.tables.some((t) => t.comment !== null)).toBe(true);
    expect(catalog.columns.some((c) => c.comment !== null)).toBe(true);
    expect(catalog.views.some((v) => v.comment !== null)).toBe(true);
    expect(catalog.views.length).toBeGreaterThan(0);
    expect(catalog.macros.length).toBeGreaterThan(0);
    expect(catalog.indexes.length).toBeGreaterThan(0);
    expect(catalog.sequences.map((s) => s.sequence_name)).toEqual(["entity_id_seq"]);
    // The schema seeds rows (programs, atlas regions, QC rules), some drawing on entity_id_seq.
    expect(Object.values(rows).some((r) => r !== "[]")).toBe(true);
    expect(catalog.sequences[0]!.last_value).not.toBeNull();
  });
});

describe("the lock on a template being built", () => {
  // Named for this process, so no other test or worker builds the same file.
  const files = async (name: string) => {
    const dir = join(process.env.BEELINE_TEST_RUN_DIR!, "store-templates");
    await mkdir(dir, { recursive: true });
    return { done: join(dir, `${name}.duckdb`), lock: join(dir, `${name}.lock`) };
  };

  test("left by a process that is no longer running is reported at once, not waited out", async () => {
    const name = `stale-${process.pid}`;
    const { lock } = await files(name);
    const gone = spawnSync(process.execPath, ["-e", ""]).pid!;
    await writeFile(lock, String(gone));
    const build = vi.fn(async () => {});
    await expect(templateFile(name, build)).rejects.toThrow(`was left by process ${gone}, which is no longer running`);
    expect(build).not.toHaveBeenCalled();
    await rm(lock);
  });

  test("left by a builder that published the template and exited is no fault: the waiter takes the template", async () => {
    const name = `published-${process.pid}`;
    const { done, lock } = await files(name);
    // The order CodeRabbit found: the waiter looks for the template and finds
    // none; the builder renames it into place and exits, its lock still
    // there for the moment; the waiter then reads the lock and finds its
    // process gone.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid!;
    await writeFile(lock, String(gone));
    await writeFile(done, "");
    let looked = 0;
    existsOverride.answer = (path) => (path === done && looked++ === 0 ? false : undefined);
    try {
      const build = vi.fn(async () => {});
      await expect(templateFile(name, build)).resolves.toBe(done);
      expect(build).not.toHaveBeenCalled();
      expect(looked).toBeGreaterThan(1);
    } finally {
      existsOverride.answer = () => undefined;
      await rm(lock, { force: true });
    }
  });

  test("is waited on without timers, so a test that fakes them still gets its template", async () => {
    const name = `fake-timers-${process.pid}`;
    const { done, lock } = await files(name);
    // Held by a live process, this one, as though another test in it were building.
    await writeFile(lock, String(process.pid));
    vi.useFakeTimers();
    try {
      const waiting = templateFile(name, async () => {
        throw new Error("the waiter must not build while the lock is held");
      });
      await sleep(300);
      await writeFile(done, "");
      await rm(lock);
      await expect(waiting).resolves.toBe(done);
    } finally {
      vi.useRealTimers();
    }
  });
});
