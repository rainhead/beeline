import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { ensureCorrectionsFile, parseCsv, upsertCorrections, type CorrectionEvent } from "../src/corrections.js";

const event = (over: Partial<CorrectionEvent>): CorrectionEvent => ({
  _id: "aaaa1111",
  field: "locality",
  base_value: "old",
  new_value: "new",
  author: "tester",
  reason: "test",
  ...over,
});

async function scratchFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "beeline-corrections-")), "corrections.csv");
}

describe("app correction store", () => {
  test("ensure creates the header once and never truncates an existing file", async () => {
    const path = await scratchFile();
    await ensureCorrectionsFile(path);
    expect(await readFile(path, "utf8")).toBe("_id,field,base_value,new_value,author,reason\n");
    await upsertCorrections(path, [event({})]);
    await ensureCorrectionsFile(path);
    expect(await readFile(path, "utf8")).toContain("aaaa1111");
  });

  test("a later event for the same (_id, field) replaces the row; others accumulate", async () => {
    const path = await scratchFile();
    await upsertCorrections(path, [event({ new_value: "first try" }), event({ field: "county", new_value: "BentonCo" })]);
    await upsertCorrections(path, [event({ new_value: "second try" })]);
    const records = parseCsv(await readFile(path, "utf8")).slice(1);
    expect(records).toHaveLength(2);
    const locality = records.find((r) => r[1] === "locality");
    expect(locality?.[3]).toBe("second try");
    expect(records.find((r) => r[1] === "county")?.[3]).toBe("BentonCo");
  });

  test("values with commas, quotes, and newlines survive the round trip DuckDB reads", async () => {
    const path = await scratchFile();
    const gnarly = '5th St, "the mill"\nnear the river';
    await upsertCorrections(path, [event({ base_value: gnarly, new_value: "Corvallis, OR" })]);
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    const result = await conn.run(
      `SELECT base_value, new_value FROM read_csv('${path.replaceAll("'", "''")}', header = true)`,
    );
    expect(await result.getRows()).toEqual([[gnarly, "Corvallis, OR"]]);
    conn.closeSync();
  });
});
