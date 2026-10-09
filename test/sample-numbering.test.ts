import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { numberRuns } from "../src/app/views/qc.js";

/**
 * Sample numbers that never reached Beeline (schema/109): an observation in
 * the project with its number left blank (beeline-a04), and a number missing
 * from a day's run (beeline-virz). Built on observation_field directly, since
 * what is under test is the views and not the shred.
 */

let conn: DuckDBConnection;
let ada: number;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  const [[id]] = (await rows(conn, "INSERT INTO person (display_name) VALUES ('Ada Collector') RETURNING entity_id")) as [
    [number],
  ];
  ada = id;
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${ada}, 100, 'adacollects')`);
});

let nextId = 1000;
/** One observation as the projection stores it: Ada's unless told otherwise. */
async function observation(o: {
  on: string;
  number?: string | null;
  attached?: boolean;
  notes?: string;
  user?: number;
}): Promise<number> {
  const id = nextId++;
  const number = o.number === undefined || o.number === null ? "NULL" : `'${o.number}'`;
  const attached = o.attached ?? (o.number !== undefined && o.number !== null);
  await conn.run(
    `INSERT INTO observation_field (inat_id, observed_on, user_id, user_login, sample_number_raw, specimen_count_raw,
                                    notes, sample_number_field_attached)
     VALUES (${id}, DATE '${o.on}', ${o.user ?? 100}, 'adacollects', ${number}, '1',
             ${o.notes === undefined ? "NULL" : `'${o.notes}'`}, ${attached})`,
  );
  return id;
}

/** A day's numbers, one observation each. */
async function day(on: string, numbers: string[]): Promise<void> {
  for (const number of numbers) await observation({ on, number });
}

const gaps = async () =>
  (await rows(conn, "SELECT CAST(collected_on AS TEXT), sample_number FROM sample_number_gap ORDER BY 1, 2")).map(
    ([d, n]) => [d, Number(n)],
  );

describe("an observation with its sample number left blank", () => {
  test("is named, with its notes, when the field is attached and empty", async () => {
    // The open-season shape from the API: the field there, the value empty,
    // and the number in the notes in the collector's own words.
    const id = await observation({ on: "2026-05-23", attached: true, notes: "1C red cuckoo" });
    expect(await rows(conn, "SELECT inat_id, person_id, notes FROM observation_unnumbered")).toEqual([
      [BigInt(id), ada, "1C red cuckoo"],
    ]);
  });

  test("is named without notes too, since the empty field is the evidence", async () => {
    await observation({ on: "2026-04-24", attached: true });
    expect(await rows(conn, "SELECT count(*) FROM observation_unnumbered")).toEqual([[1n]]);
  });

  test("is not one with no sample-number field at all, or with a number", async () => {
    await observation({ on: "2026-05-23", attached: false, notes: "Sample 2" });
    await observation({ on: "2026-05-23", number: "2" });
    expect(await rows(conn, "SELECT count(*) FROM observation_unnumbered")).toEqual([[0n]]);
  });

  test("is not asked of an observer who is nobody here, since nobody can sign in to be asked", async () => {
    await observation({ on: "2026-05-23", attached: true, user: 999 });
    expect(await rows(conn, "SELECT count(*) FROM observation_unnumbered")).toEqual([[0n]]);
  });

  test("is not one that is already a sample, by its link or by a legacy record naming it", async () => {
    const linked = await observation({ on: "2026-05-23", attached: true });
    const named = await observation({ on: "2026-05-23", attached: true });
    await insertCleanSample(conn, { inat_observation_id: String(linked) });
    const legacy = await insertCleanSample(conn, { sample_number: "'2'" });
    await conn.run(`INSERT INTO sample_legacy_observation (sample_id, inat_observation_id) VALUES (${legacy}, ${named})`);
    expect(await rows(conn, "SELECT count(*) FROM observation_unnumbered")).toEqual([[0n]]);
  });
});

describe("a number missing from a day's run", () => {
  test("names the number a day skips, and the numbers before a day's first", async () => {
    await day("2026-06-01", ["1", "2", "4"]);
    await day("2026-06-02", ["3"]);
    await day("2026-06-03", ["1", "2"]);
    await day("2026-06-04", ["1"]);
    expect(await gaps()).toEqual([
      ["2026-06-01", 3],
      ["2026-06-02", 1],
      ["2026-06-02", 2],
    ]);
  });

  test("reads a jump of more than three as a second run, not as missed samples", async () => {
    // The corpus's shape: a second series at 101 on the same day.
    await day("2026-06-01", ["1", "2", "3", "101", "102"]);
    await day("2026-06-02", ["1", "6"]);
    await day("2026-06-03", ["1", "5"]);
    expect(await gaps()).toEqual([
      ["2026-06-03", 2],
      ["2026-06-03", 3],
      ["2026-06-03", 4],
    ]);
  });

  test("judges only collectors who number per day", async () => {
    // A running series across days: no day starts at 1, so none is judged.
    await day("2026-06-01", ["251", "252", "254"]);
    await day("2026-06-02", ["255", "256"]);
    await day("2026-06-03", ["1", "3"]);
    expect(await gaps()).toEqual([]);
  });

  test("skips a day carrying a number it cannot place", async () => {
    await day("2026-06-01", ["1", "2a", "4"]);
    await day("2026-06-02", ["1", "007"]);
    await day("2026-06-03", ["1", "3"]);
    await day("2026-06-04", ["1", "2"]);
    expect(await gaps()).toEqual([["2026-06-03", 2]]);
  });

  test("counts an imported sample's number, which has no observation", async () => {
    await day("2026-06-01", ["1", "3"]);
    await insertCleanSample(conn, {
      sample_number: "'2'",
      date_start: "DATE '2026-06-01'",
      date_end: "DATE '2026-06-01'",
    });
    expect(await gaps()).toEqual([]);
  });

  test("leaves out a day its unnumbered observations already explain", async () => {
    await day("2026-06-01", ["1", "3"]);
    await observation({ on: "2026-06-01", attached: true, notes: "2" });
    // Two missing and one unnumbered: not explained, so both are asked about.
    await day("2026-06-02", ["1", "4"]);
    await observation({ on: "2026-06-02", attached: true });
    expect(await gaps()).toEqual([
      ["2026-06-02", 2],
      ["2026-06-02", 3],
    ]);
  });

  test("keeps each collector's numbers their own", async () => {
    const [[bea]] = (await rows(conn, "INSERT INTO person (display_name) VALUES ('Bea') RETURNING entity_id")) as [[number]];
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${bea}, 200, 'bea')`);
    await day("2026-06-01", ["1", "3"]);
    await observation({ on: "2026-06-01", number: "2", user: 200 });
    expect(await rows(conn, "SELECT person_id, sample_number FROM sample_number_gap")).toEqual([[ada, 2]]);
  });
});

describe("a day's skipped numbers, as the page says them", () => {
  test("runs of three or more become a range, and two in a row stay two numbers", () => {
    expect(numberRuns([3])).toEqual(["3"]);
    expect(numberRuns([7, 3, 5, 6])).toEqual(["3", "5–7"]);
    expect(numberRuns([3, 4])).toEqual(["3", "4"]);
    expect(numberRuns([1, 2, 3, 9])).toEqual(["1–3", "9"]);
    expect(numberRuns([])).toEqual([]);
  });
});
