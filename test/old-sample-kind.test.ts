import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, FIXTURE_INPUTS, rows } from "./helpers.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { oldSampleKindSql } from "../src/old-sample-kind.js";

/**
 * The kind of a sample made from the old Beeline's records (beeline-lmlh,
 * src/old-sample-kind.ts): a trap sample when some old record gives an end
 * date, unless every end date equals that record's start and every record's
 * method is a netting method. Each case below is a sample of its own, made by
 * copying Ada's first record of the shared fixture with the dates and method
 * the case needs.
 */
const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;

/** One old record: its sample number, and its end ("same" as the start, "later", or none) and method. */
interface Record {
  sid: string;
  end: "same" | "later" | "none";
  method: string;
}

const CASES: { name: string; sid: string; records: Omit<Record, "sid">[]; kind: "net" | "trap" }[] = [
  { name: "a single day, method names a trap: stays a trap", sid: "201", records: [{ end: "same", method: "pan traps" }], kind: "trap" },
  { name: "a net spanning days: stays a trap", sid: "202", records: [{ end: "later", method: "aerial net" }], kind: "trap" },
  { name: "a trap-worded sample with no end date: stays a net", sid: "203", records: [{ end: "none", method: "pan traps" }], kind: "net" },
  {
    name: "records that disagree (an end equal to the start, and none), a netting method: a net",
    sid: "204",
    records: [{ end: "same", method: "aerial net" }, { end: "none", method: "aerial net" }],
    kind: "net",
  },
  { name: "no method and an end on its start day: stays a trap", sid: "205", records: [{ end: "same", method: "" }], kind: "trap" },
  { name: "a netting method written with a capital and a space: a net", sid: "206", records: [{ end: "same", method: " Net " }], kind: "net" },
  {
    name: "one record names a trap although another is netted with an end on its start day: a trap",
    sid: "207",
    records: [{ end: "same", method: "aerial net" }, { end: "none", method: "pan traps" }],
    kind: "trap",
  },
  { name: "an end equal to the start, a netting method: a net", sid: "208", records: [{ end: "same", method: "aerial net" }], kind: "net" },
  { name: "no end date, a netting method: a net", sid: "209", records: [{ end: "none", method: "aerial net" }], kind: "net" },
  {
    name: "one record's end is its start and another's is later: a trap",
    sid: "210",
    records: [{ end: "same", method: "aerial net" }, { end: "later", method: "aerial net" }],
    kind: "trap",
  },
];

let conn: DuckDBConnection;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await loadLegacyStaging(conn, FIXTURE);
  const q = (v: string) => `'${v.replaceAll("'", "''")}'`;
  let n = 0;
  for (const c of CASES) {
    for (const [i, r] of c.records.entries()) {
      n += 1;
      const end = r.end === "none" ? ["", "", ""] : r.end === "same" ? ["14", "VII", "2025"] : ["16", "VII", "2025"];
      await conn.run(`INSERT INTO legacy_occurrence
        SELECT * REPLACE (${q(`kind-${c.sid}-${i}`)} AS _id, ${q(`9${n}`)} AS "fieldNumber", ${q(c.sid)} AS "sampleId", '' AS url,
                          ${q(String(i + 1))} AS "specimenId", ${q(r.method)} AS "samplingProtocol",
                          ${q(end[0]!)} AS day2, ${q(end[1]!)} AS month2, ${q(end[2]!)} AS year2,
                          '' AS "genusPlant", '' AS "speciesPlant", '' AS "familyPlant", '' AS "orderPlant", '' AS "phylumPlant")
        FROM legacy_occurrence WHERE "fieldNumber" = '25000001'`);
    }
  }
  await promoteLegacy(conn, FIXTURE_INPUTS);
}, 60_000);

describe("the kind promotion gives a sample from old records", () => {
  test.each(CASES)("$name", async (c) => {
    expect(await rows(conn, `SELECT kind FROM sample WHERE sample_number = '${c.sid}'`)).toEqual([[c.kind]]);
  });

  test("every case was promoted as one sample", async () => {
    expect(await rows(conn, `SELECT count(*) FROM sample WHERE sample_number IN (${CASES.map((c) => `'${c.sid}'`).join(",")})`)).toEqual([[BigInt(CASES.length)]]);
  });

  test("a trap's end is still the latest end its records give", async () => {
    expect(await rows(conn, `SELECT CAST(date_end AS VARCHAR) FROM sample WHERE sample_number = '202'`)).toEqual([["2025-07-16"]]);
  });
});

describe("the rule as the carry-over states it", () => {
  test("gives the same kinds over records written in the carry-over's own columns", async () => {
    const { conn: scratch } = await createMemoryDb();
    await scratch.run(`CREATE TEMP TABLE r (sid TEXT, p_date_start DATE, p_date_end DATE, "samplingProtocol" TEXT)`);
    const d = (s: string | null) => (s === null ? "NULL" : `DATE '${s}'`);
    const q = (v: string) => `'${v.replaceAll("'", "''")}'`;
    for (const c of CASES) {
      for (const r of c.records) {
        const end = r.end === "none" ? null : r.end === "same" ? "2025-07-14" : "2025-07-16";
        await scratch.run(`INSERT INTO r VALUES (${q(c.sid)}, DATE '2025-07-14', ${d(end)}, ${r.method === "" ? "NULL" : q(r.method)})`);
      }
    }
    const kinds = await rows(
      scratch,
      `SELECT sid, ${oldSampleKindSql({ end: "p_date_end", start: "p_date_start", method: '"samplingProtocol"' })} FROM r GROUP BY sid ORDER BY sid`,
    );
    expect(kinds).toEqual(CASES.map((c) => [c.sid, c.kind]));
  });
});
