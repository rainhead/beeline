import { describe, expect, test } from "vitest";
import { createMemoryDb as buildFromSchema } from "../src/schema.js";
import { createMemoryDb } from "./helpers.js";
import { storeContents } from "./store-template.js";

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
