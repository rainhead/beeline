import type { DuckDBConnection } from "@duckdb/node-api";
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { compareLegacyExport, DIFFERENCE_KIND_SQL, writeDifferences } from "../src/compare-legacy-export.js";
import { parseRulings, RULING_COLUMNS, type Ruling } from "../src/legacy-export-rulings.js";
import { writeLegacyExport } from "../src/legacy-export.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { createMemoryDb, FIXTURE_INPUTS } from "./helpers.js";

const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;

describe("the kind of a difference", () => {
  // Every pair but the two marked synthetic is lifted from the dev store's
  // comparison against the 2026-09-28 pull: (column, as exported, as the legacy record has it).
  const cases: [string, string, string, string][] = [
    ["phylum", "Arthropoda", "", "filled"],
    ["subgenus", "", "Lasioglossum (Dialictus)", "blanked"],
    ["locality", "Mary's  Peak", "Mary's Peak", "whitespace"], // synthetic
    ["sex", "male", "Male", "case"],
    ["coordinateUncertaintyInMeters", "10", "10.0", "number_form"], // synthetic
    ["month", "6", "VI", "date_form"],
    ["verbatimEventDate", "2022-6-26/2022-7-29", "2022-VI-26/2022-VII-29", "date_form"],
    ["verbatimEventDate", "5/17/2018", "2018-5-17/2018-5-17", "date_form"],
    ["verbatimEventDate", "2020-4-28/2020-4-29", "2020-4-28/2020-4-28", "changed"],
    ["country", "CA", "CAN", "country_code"],
    ["country", "USA", "CAN", "changed"],
    ["subgenus", "Lasioglossum (Dialictus)", "Dialictus", "subgenus_form"],
    ["genus", "Lasioglossum", "Lasioglossum (Dialictus)", "subgenus_form"],
    ["scientificName", "Halictus ligatus", "Halictus ligatus Say, 1837", "authorship"],
    ["scientificName", "Lasioglossum titusi", "Lasioglossum titusi (Crawford, 1902)", "authorship"],
    ["verbatimElevation", "61", "65", "changed"],
    ["stateProvince", "WA", "OR", "changed"],
  ];

  test.each(cases)("%s: '%s' exported against '%s' is %s", async (column, exported, legacy, kind) => {
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
    const reader = await conn.runAndReadAll(
      `SELECT ${DIFFERENCE_KIND_SQL} FROM (SELECT ${lit(column)} AS "column", ${lit(exported)} AS exported, ${lit(legacy)} AS legacy)`,
    );
    expect(reader.getRows()[0]![0]).toBe(kind);
    conn.closeSync();
  });
});

describe("the rulings file", () => {
  const header = RULING_COLUMNS.join(",");
  const row = (o: Partial<Ruling> = {}) =>
    RULING_COLUMNS.map((c) => ({ field_number: "", column: "sex", kind: "case", outcome: "expected", reason: "normalised",
                                 source: "beeline-6q8", decided_by: "P. Abrahamsen", decided_on: "2026-10-04", ...o })[c]).join(",");

  test("reads a well-formed ruling", () => {
    expect(parseRulings(`${header}\n${row()}\n`, "t")).toEqual([
      { field_number: "", column: "sex", kind: "case", outcome: "expected", reason: "normalised",
        source: "beeline-6q8", decided_by: "P. Abrahamsen", decided_on: "2026-10-04" },
    ]);
  });

  test.each([
    [{ column: "sexx" }, "neither an exported column"],
    [{ kind: "capitals" }, "not a kind of difference"],
    [{ outcome: "fine" }, "outcome 'fine'"],
    [{ reason: "" }, "says why"],
    [{ source: "" }, "where the call was made"],
    [{ decided_by: "" }, "who decided"],
    [{ decided_on: "4 Oct" }, "not a date"],
  ] as [Partial<Ruling>, string][])("refuses %o", (o, message) => {
    expect(() => parseRulings(`${header}\n${row(o)}\n`, "t")).toThrow(message);
  });

  test("accepts any promotion finding as a record kind", () => {
    expect(parseRulings(`${header}\n${row({ column: "(record)", kind: "duplicate_specimen" })}\n`, "t")).toHaveLength(1);
  });

  test("refuses the same column, kind and record ruled on twice", () => {
    expect(() => parseRulings(`${header}\n${row()}\n${row({ reason: "again" })}\n`, "t")).toThrow("twice");
  });
});

describe("comparing against rulings", () => {
  let conn: DuckDBConnection;
  let exportPath: string;
  let dir: string;
  let numbers: string[];

  // Differences are planted by editing staging after the export is written:
  // one record's sex recapitalised, another's taxonomic notes filled, and a
  // third record dropped from staging, so the export holds it alone.
  beforeAll(async () => {
    ({ conn } = await createMemoryDb());
    await loadLegacyStaging(conn, FIXTURE);
    await promoteLegacy(conn, FIXTURE_INPUTS);
    dir = await mkdtemp(join(tmpdir(), "compare-legacy-"));
    exportPath = join(dir, "occurrences.csv");
    await writeLegacyExport(conn, exportPath);
    numbers = ((await conn.runAndReadAll(
      `SELECT "fieldNumber" FROM legacy_occurrence WHERE sex <> '' AND "fieldNumber" <> '' ORDER BY 1`,
    )).getRows() as [string][]).map(([n]) => n);
    const other = ((await conn.runAndReadAll(
      `SELECT "fieldNumber" FROM legacy_occurrence WHERE sex = '' AND "fieldNumber" <> '' ORDER BY 1 LIMIT 2`,
    )).getRows() as [string][]).map(([n]) => n);
    numbers.push(...other);
    await conn.run(`UPDATE legacy_occurrence SET sex = upper(sex) WHERE "fieldNumber" = '${numbers[0]}'`);
    await conn.run(`UPDATE legacy_occurrence SET "taxonomicNotes" = 'planted' WHERE "fieldNumber" = '${numbers.at(-2)}'`);
    await conn.run(`DELETE FROM legacy_occurrence WHERE "fieldNumber" = '${numbers.at(-1)}'`);
  });

  const ruling = (o: Partial<Ruling>): Ruling => ({
    field_number: "", column: "sex", kind: "", outcome: "expected", reason: "test", source: "test",
    decided_by: "test", decided_on: "2026-10-04", ...o,
  });

  /** Every difference the comparison reports unexplained, as `number column kind`. */
  async function unexplained(rulings: Ruling[]): Promise<string[]> {
    await compareLegacyExport(conn, exportPath, rulings);
    const path = join(dir, `differences-${Math.random()}.csv`);
    await writeDifferences(conn, rulings, path);
    const rows = (await conn.runAndReadAll(
      `SELECT field_number, "column", kind FROM read_csv('${path}', header = true, all_varchar = true)
       WHERE coalesce(outcome, '') = '' ORDER BY ALL`,
    )).getRows() as [string, string, string][];
    return rows.map((r) => r.join(" "));
  }

  test("finds each planted difference, with its kind", async () => {
    const found = await unexplained([]);
    expect(found).toContain(`${numbers[0]} sex case`);
    expect(found).toContain(`${numbers.at(-2)} taxonomicNotes blanked`);
    expect(found).toContain(`${numbers.at(-1)} (record) not_in_legacy`);
  });

  test("a ruling explains exactly the differences it names and nothing else", async () => {
    const before = await unexplained([]);
    const after = await unexplained([ruling({ field_number: numbers[0]!, kind: "case" })]);
    expect(before.filter((d) => !after.includes(d))).toEqual([`${numbers[0]} sex case`]);
    expect(after.filter((d) => !before.includes(d))).toEqual([]);
  });

  test("the most specific ruling is the one that explains", async () => {
    const rulings = [ruling({ outcome: "expected" }), ruling({ field_number: numbers[0]!, outcome: "beeline-wrong" })];
    const r = await compareLegacyExport(conn, exportPath, rulings);
    expect(r.rulings.map((x) => [x.ruling.outcome, x.open + x.settled])).toEqual([["expected", 0], ["beeline-wrong", 1]]);
  });

  test("a beeline-wrong ruling that matches nothing is retired, any other matches nothing", async () => {
    const r = await compareLegacyExport(conn, exportPath, [
      ruling({ column: "caste", outcome: "beeline-wrong" }),
      ruling({ column: "caste", kind: "changed", outcome: "expected" }),
      ruling({ kind: "case", outcome: "beeline-wrong" }),
    ]);
    expect(r.rulings.map((x) => x.status)).toEqual(["retired", "matches-nothing", "explains"]);
  });

  test("the same staging and export give the same answer", async () => {
    const a = await compareLegacyExport(conn, exportPath, []);
    const b = await compareLegacyExport(conn, exportPath, []);
    expect(b).toEqual(a);
    expect(a.reference.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });
});
