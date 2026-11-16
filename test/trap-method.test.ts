import { DuckDBInstance } from "@duckdb/node-api";
import { describe, expect, test } from "vitest";
import { methodNamesTrap, methodNamesTrapSql, plantRelationship } from "../src/trap-method.js";

describe("whether a sample's method names a trap (beeline-vjqy)", () => {
  // Methods as samples on production gave them on 16 November 2026.
  const methods: [string | null, boolean][] = [
    ["pan traps", true],
    ["pantrap", true],
    ["Pan trap", true],
    ["6 Vane Traps", true],
    ["blue vane trap", true],
    ["white bottle trap", true],
    ["trap nest", true],
    ["pan traps and vane traps", true],
    ["aerial net", false],
    ["net", false],
    ["vacuum", false],
    ["", false],
    [null, false],
  ];

  test.each(methods)("%j names a trap: %s", (method, expected) => {
    expect(methodNamesTrap(method)).toBe(expected);
    expect(plantRelationship(method)).toBe(expected ? "near" : "visits flowers of");
  });

  test("reads the same in SQL", async () => {
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    const values = methods.map(([m], i) => `(${m === null ? "NULL" : `'${m}'`}, ${i})`).join(", ");
    const rows = (await conn.runAndReadAll(`SELECT ${methodNamesTrapSql("m")} FROM (VALUES ${values}) t(m, i) ORDER BY i`)).getRows();
    expect(rows.map(([v]) => v)).toEqual(methods.map(([, e]) => e));
    conn.closeSync();
  });
});
