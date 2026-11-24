import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, it } from "vitest";
import { checkTrapSample, createTrapSample, findNumberHolder, readNumberHolders, startMoveHolder, type NumberScope, type TrapSampleForm } from "../src/trap-sample.js";
import { createMemoryDb, CURRENT_SEASON, insertCleanSample, rows } from "./helpers.js";

// A sample number is unique by what it is held to (beeline-ni5m.16): a series number within its program, a plain
// number for its primary collector on the start day. Neither reads the sample's kind or method.

let conn: DuckDBConnection;
let dan: number;
let eve: number;
let oba: number;
let waba: number;
const DAY = `${CURRENT_SEASON}-06-16`;
const OTHER_DAY = `${CURRENT_SEASON}-06-17`;

const form = (over: Partial<TrapSampleForm> = {}): TrapSampleForm => ({
  sample_number: "OBAS-20300",
  collectors: ["Dan"],
  date_start: DAY,
  date_end: DAY,
  method: "vane trap",
  trap_count: "12",
  specimen_count: "",
  latitude: "42.005",
  longitude: "-118.592",
  uncertainty: "5",
  country: "USA",
  state_province: "OR",
  county: "Malheur",
  locality: "Fields-Denio N",
  ...over,
});

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  const people = await rows(conn, `INSERT INTO person (display_name) VALUES ('Dan'), ('Eve') RETURNING entity_id`);
  [dan, eve] = people.map((r) => r[0] as number) as [number, number];
  const programs = await rows(conn, `SELECT code, entity_id FROM program WHERE code IN ('OBA', 'WaBA')`);
  oba = programs.find((r) => r[0] === "OBA")![1] as number;
  waba = programs.find((r) => r[0] === "WaBA")![1] as number;
});

const made = (number: string, collector: number, day: string, program: number | null, kind: "net" | "trap" = "net") =>
  insertCleanSample(conn, {
    kind: `'${kind}'`,
    sample_number: `'${number}'`,
    collector_id: String(collector),
    date_start: `DATE '${day}'`,
    date_end: `DATE '${day}'`,
    ...(program === null ? {} : { atlas_id: String(program) }),
  });

const problemOf = async (over: Partial<TrapSampleForm>, sampleId: number | null = null) => {
  const checked = await checkTrapSample(conn, form(over), sampleId);
  return "problems" in checked ? (checked.problems.sample_number ?? null) : null;
};

describe("a plain number is unique for its primary collector on the start day", () => {
  it("refuses the same collector on the same day, whatever either sample's kind", async () => {
    await made("3", dan, DAY, null, "net");
    expect(await problemOf({ sample_number: "3" })).toBe(`Dan already has a sample numbered 3 on ${DAY}.`);
    // A trap sample clashes as a net sample does.
    await made("4", dan, DAY, null, "trap");
    expect(await problemOf({ sample_number: "4" })).toContain("already has a sample numbered 4");
  });

  it("allows the same number on another day, or for another collector", async () => {
    await made("3", dan, DAY, null);
    expect(await problemOf({ sample_number: "3", date_start: OTHER_DAY, date_end: OTHER_DAY })).toBeNull();
    expect(await problemOf({ sample_number: "3", collectors: ["Eve"] })).toBeNull();
    // Only the primary collector counts: Eve second on a sample of Dan's is no clash for Eve.
    const id = await made("5", dan, DAY, null);
    await conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${id}, ${eve}, 2)`);
    expect(await problemOf({ sample_number: "5", collectors: ["Eve"] })).toBeNull();
  });

  it("compares the number exactly, as the iNaturalist rule does", async () => {
    await made("A3", dan, DAY, null);
    expect(await problemOf({ sample_number: "a3" })).toBeNull();
  });

  it("holds a sample start day, not its end", async () => {
    await made("3", dan, DAY, null);
    expect(await problemOf({ sample_number: "3", date_start: OTHER_DAY, date_end: `${CURRENT_SEASON}-06-20` })).toBeNull();
  });
});

describe("a series number is unique within its program", () => {
  it("refuses a number another sample of the program has, of any kind, and names the program", async () => {
    await made("OBAS-20300", eve, OTHER_DAY, oba, "net");
    expect(await problemOf({})).toBe("Sample number OBAS-20300 is already used by another sample in Oregon Bee Atlas.");
    await made("YPT-1", eve, OTHER_DAY, oba, "trap");
    expect(await problemOf({ sample_number: "YPT-1" })).toContain("YPT-1 is already used");
  });

  it("compares the program's own series folded", async () => {
    await made("OBAS 20300", eve, OTHER_DAY, oba);
    expect(await problemOf({ sample_number: "OBAS-20300" })).toContain("already used");
  });

  it("allows the same number in another program, or where the sample files under none", async () => {
    await made("OBAS-20300", eve, DAY, waba);
    expect(await problemOf({})).toBeNull();
    await made("YPT-2", eve, DAY, null);
    expect(await problemOf({ sample_number: "YPT-2" })).toBeNull();
    // The program follows the state: the same number in Washington meets the Washington sample.
    expect(await problemOf({ state_province: "WA" })).toContain("Washington Bee Atlas");
  });
});

describe("a sample that already shares its number stays editable", () => {
  it("is not judged while its number, program, collector and day are unchanged, and is when its number moves onto another's", async () => {
    const a = await made("OBAS-00366", dan, DAY, oba);
    await made("OBAS-00366", eve, OTHER_DAY, oba);
    await made("OBAS-00400", eve, OTHER_DAY, oba);
    expect(await problemOf({ sample_number: "OBAS-00366", locality: "Elsewhere" }, a)).toBeNull();
    expect(await problemOf({ sample_number: "OBAS-00400" }, a)).toContain("already used");
  });

  it("is judged when only the start day of a plain number moves", async () => {
    await made("3", dan, DAY, null);
    const b = await made("3", dan, OTHER_DAY, null);
    expect(await startMoveHolder(conn, b, OTHER_DAY)).toBeNull();
    expect(await startMoveHolder(conn, b, DAY)).toMatchObject({ kind: "net" });
    expect(await startMoveHolder(conn, b, `${CURRENT_SEASON}-06-18`)).toBeNull();
    // A series number is held to its program, which a day does not change.
    const c = await made("OBAS-00500", dan, DAY, oba);
    await made("OBAS-00500", eve, OTHER_DAY, waba);
    expect(await startMoveHolder(conn, c, OTHER_DAY)).toBeNull();
  });
});

describe("the check made when the sample is written", () => {
  it("refuses under the lock what the form let through", async () => {
    const checked = await checkTrapSample(conn, form({ sample_number: "9" }));
    if (!("sample" in checked)) throw new Error("unexpected problems");
    await made("9", dan, DAY, null);
    expect(await createTrapSample(conn, checked.sample, null)).toBe("taken");
    const other = await checkTrapSample(conn, form({ sample_number: "9", collectors: ["Eve"] }));
    if (!("sample" in other)) throw new Error("unexpected problems");
    expect(typeof (await createTrapSample(conn, other.sample, null))).toBe("number");
  });
});

describe("the upload's batched read", () => {
  it("answers as the single check does, for every kind of number", async () => {
    await made("OBAS-00700", dan, DAY, oba);
    await made("OBAS 00701", dan, DAY, oba);
    await made("YPT-3", dan, DAY, waba);
    await made("3", dan, DAY, null);
    await made("3", eve, OTHER_DAY, null);
    const numbers = ["OBAS-00700", "OBAS00701", "YPT-3", "3", "4", "OBAS-00702"];
    const holders = await readNumberHolders(conn, numbers);
    const scopes: NumberScope[] = [];
    for (const sampleNumber of numbers) {
      for (const programId of [null, oba, waba]) {
        for (const collectorId of [dan, eve]) {
          for (const dateStart of [DAY, OTHER_DAY]) scopes.push({ sampleNumber, programId, collectorId, dateStart });
        }
      }
    }
    scopes.push({ sampleNumber: "3", programId: null, collectorId: null, dateStart: DAY });
    for (const scope of scopes) expect(holders(scope), JSON.stringify(scope)).toEqual(await findNumberHolder(conn, scope));
    expect(holders({ sampleNumber: "OBAS-00700", programId: oba, collectorId: eve, dateStart: DAY })).toMatchObject({ kind: "net" });
    expect(holders({ sampleNumber: "3", programId: null, collectorId: dan, dateStart: DAY })).not.toBeNull();
    expect(holders({ sampleNumber: "3", programId: null, collectorId: dan, dateStart: OTHER_DAY })).toBeNull();
  });
});
