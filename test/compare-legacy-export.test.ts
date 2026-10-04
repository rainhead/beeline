import type { DuckDBConnection } from "@duckdb/node-api";
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { compareLegacyExport, DIFFERENCE_KIND_SQL, seasonDate, writeDifferences } from "../src/compare-legacy-export.js";
import { parseRulings, RULING_COLUMNS, type Ruling } from "../src/legacy-export-rulings.js";
import { writeLegacyExport } from "../src/legacy-export.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { createMemoryDb, FIXTURE_INPUTS } from "./helpers.js";

const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;

describe("the date a record's season is judged on", () => {
  // The end where there is one, as a sample is judged on date_end: a trap
  // set before 1 March and emptied after it is the open season's. Roman
  // months are the legacy file's own (2022-VI-26/2022-VII-29 in the corpus).
  test.each([
    [["2026", "II", "20", "2026", "III", "5"], "2026-03-05"],
    [["2026", "2", "20", "", "", ""], "2026-02-20"],
    [["2022", "VI", "26", "2022", "VII", "29"], "2022-07-29"],
  ])("%j is judged on %s", async ([year, month, day, year2, month2, day2], expected) => {
    const conn = await (await DuckDBInstance.create(":memory:")).connect();
    const reader = await conn.runAndReadAll(
      `SELECT strftime(${seasonDate("t")}, '%Y-%m-%d') FROM (SELECT '${year}' AS "year", '${month}' AS "month", '${day}' AS "day",
              '${year2}' AS "year2", '${month2}' AS "month2", '${day2}' AS "day2") t`,
    );
    expect(reader.getRows()[0]![0]).toBe(expected);
    conn.closeSync();
  });
});

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

describe("what the store knows about a difference", () => {
  let conn: DuckDBConnection;
  let dir: string;
  let exportPath: string;

  // Synthetic, in the shapes found on the sandbox: a collector the old system
  // misspelled, a login renamed on iNaturalist, and a sample whose legacy rows
  // named different places.
  beforeAll(async () => {
    ({ conn } = await createMemoryDb());
    await loadLegacyStaging(conn, FIXTURE);
    await promoteLegacy(conn, FIXTURE_INPUTS);
    dir = await mkdtemp(join(tmpdir(), "compare-store-"));
    exportPath = join(dir, "occurrences.csv");
    await writeLegacyExport(conn, exportPath);
    await conn.run(`INSERT INTO legacy_collector_alias (alias, person, basis) VALUES ('Ada Colector', 'Ada Collector', 'test')`);
    // The misspelling, in the name and the part it spells.
    await conn.run(`UPDATE legacy_occurrence SET "recordedBy" = 'Ada Colector', "lastName" = 'Colector' WHERE "fieldNumber" = '25000001'`);
    // The same misspelling, and a first name wrong some other way besides.
    await conn.run(`UPDATE legacy_occurrence SET "recordedBy" = 'Ada Colector', "firstName" = 'Adda', "lastName" = 'Colector' WHERE "fieldNumber" = '25000003'`);
    await conn.run(`UPDATE legacy_occurrence SET "userLogin" = 'an_old_login' WHERE "fieldNumber" = '25000002'`);
    await conn.run(`UPDATE legacy_occurrence SET "userId" = '1', "userLogin" = 'someone_else' WHERE "fieldNumber" = '25000005'`);
    // A sample whose rows disagreed between what Beeline wrote and 'There'.
    await conn.run(
      `INSERT INTO sample_promotion_finding (sample_id, rule_name, details)
       SELECT s.entity_id, 'within_sample_disagreement', concat('locality: ', s.locality, ' | There')
       FROM specimen sp JOIN sample s ON s.entity_id = sp.sample_id WHERE sp.field_number = '25000003'`,
    );
    await conn.run(`UPDATE legacy_occurrence SET locality = 'There' WHERE "fieldNumber" = '25000003'`);
    // One whose rows disagreed between two other values: what Beeline wrote is not the merge's doing.
    await conn.run(
      `INSERT INTO sample_promotion_finding (sample_id, rule_name, details)
       SELECT sample_id, 'within_sample_disagreement', 'locality: Here | Somewhere else' FROM specimen WHERE field_number = '25000002'`,
    );
    await conn.run(`UPDATE legacy_occurrence SET locality = 'Somewhere else' WHERE "fieldNumber" = '25000002'`);
  });

  test("labels each difference the store can account for, and leaves the rest as changed", async () => {
    await compareLegacyExport(conn, exportPath, []);
    const path = join(dir, "differences.csv");
    await writeDifferences(conn, [], path);
    const kinds = (await conn.runAndReadAll(
      `SELECT field_number, "column", kind FROM read_csv('${path}', header = true, all_varchar = true)
       WHERE (field_number IN ('25000001', '25000003') AND "column" IN ('recordedBy', 'firstName', 'lastName'))
          OR (field_number IN ('25000002', '25000005') AND "column" = 'userLogin')
          OR (field_number IN ('25000002', '25000003') AND "column" = 'locality')
       ORDER BY 1, 2`,
    )).getRows();
    expect(kinds).toEqual([
      ["25000001", "lastName", "collector_alias"],
      ["25000001", "recordedBy", "collector_alias"],
      ["25000002", "locality", "changed"], // Beeline wrote neither of the values the rows disagreed between
      ["25000002", "userLogin", "login_renamed"],
      // The parts no longer spell the misspelled name, so the alias explains neither.
      ["25000003", "firstName", "changed"],
      ["25000003", "lastName", "changed"],
      ["25000003", "locality", "sample_disagreement"],
      ["25000003", "recordedBy", "collector_alias"],
      ["25000005", "userLogin", "changed"], // another user id: not a rename
    ]);
  });
});
