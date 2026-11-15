import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { carryOverLegacyRecords } from "../src/carry-over-legacy.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { createMemoryDb, FIXTURE_INPUTS, rows } from "./helpers.js";
import { openCopy, writeCopy } from "./promoted-store.js";

/**
 * Carrying over old records that a correction in git has made whole
 * (beeline-n7gt), checked against what promotion makes of the same corrected
 * records. Synthetic records, shaped on the two groups the repair was written
 * for on production (Lincoln Best's OBAS-01087 and Paul Moschetti's sample 13
 * of 2019, whose end dates were written before their start):
 *   T-1, two records of a trap sample at Big Lake, written 19/8/2018 to
 *     23/7/2018 and corrected to 23/8/2018: carried over.
 *   T-2, one record written the same way but carrying an expert's
 *     identification: corrected, and still held back, since identifications
 *     are not carried over yet.
 *   T-3, one record with no specimen number, which no correction touches:
 *     held back as before.
 *   T-4 and T-5, written the same way and corrected, one citing an
 *     iNaturalist observation and one identified only to order: still held
 *     back, since neither is carried over yet.
 * and T-0, an ordinary sample of his that promotion takes, so that he is a
 * person in Beeline, as he is on production.
 */
const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;

let staged: string;
let corrections: string;
/** The records promoted without the correction, written once and copied for each test. */
let template: string;
/** And promoted with it: what the repair must make. */
let reference: DuckDBConnection;

/** One record in the fixture's shape, every column blank but those given. */
async function record(fields: Record<string, string>): Promise<string> {
  const [first] = (await readFile(FIXTURE, "utf8")).split("\n");
  const blank = Object.fromEntries(Object.keys(JSON.parse(first!)).map((k) => [k, ""]));
  return JSON.stringify({ ...blank, ...fields });
}

const trap = (id: string, fieldNumber: string, sample: string, specimen: string, extra: Record<string, string> = {}) =>
  record({
    _id: id,
    fieldNumber,
    firstName: "Lincoln",
    lastName: "Best",
    recordedBy: "Lincoln Best",
    sampleId: sample,
    specimenId: specimen,
    day: "19",
    month: "8",
    year: "2018",
    day2: "23",
    month2: "7",
    year2: "2018",
    country: "USA",
    stateProvince: "OR",
    county: "Linn",
    locality: "Big Lake",
    decimalLatitude: "44.3850",
    decimalLongitude: "-121.8640",
    verbatimElevation: "1432",
    samplingProtocol: "vane traps",
    dateLabelPrint: "31-Dec-18",
    ...extra,
  });

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "beeline-carry-over-"));
  staged = join(dir, "legacy.jsonl");
  const original = (await readFile(FIXTURE, "utf8")).split("\n").filter((l) => l.trim() !== "");
  await writeFile(
    staged,
    [
      ...original,
      // One of his samples promotion takes, so he is a person in Beeline, as he is on production.
      await trap("carry-0", "2461800", "T-0", "1", { day: "12", day2: "12", month2: "8" }),
      await trap("carry-1", "2461832", "T-1", "1"),
      await trap("carry-2", "2461833", "T-1", "2"),
      await trap("carry-3", "2461900", "T-2", "1", { genus: "Bombus", specificEpithet: "mixtus", identifiedBy: "Lincoln Best" }),
      await trap("carry-4", "2461950", "T-3", "", { day2: "", month2: "", year2: "" }),
      await trap("carry-5", "2461960", "T-4", "1", { url: "https://www.inaturalist.org/observations/250009999" }),
      await trap("carry-6", "2461970", "T-5", "1", { order: "Hymenoptera" }),
    ].join("\n") + "\n",
  );
  corrections = join(dir, "corrections.csv");
  await writeFile(
    corrections,
    [
      "_id,field,base_value,new_value,author,reason",
      ...["carry-1", "carry-2", "carry-3", "carry-5", "carry-6"].map((id) => `${id},month2,7,8,Test,"the month is mistyped"`),
    ].join("\n") + "\n",
  );
  // Promotion costs seconds however few the records, so twice for the file, not once a test.
  template = join(dir, "promoted.duckdb");
  await writeCopy(await promoted(await empty()), template);
  reference = await promoted(corrections);
});

/** A test's own copy of the store promoted without the correction. */
const fresh = async () => (await openCopy(template)).conn;

/** A store promoted from the records with the git file the test says. */
async function promoted(legacyCorrections: string): Promise<DuckDBConnection> {
  const { conn } = await createMemoryDb();
  await loadLegacyStaging(conn, staged);
  await promoteLegacy(conn, { ...FIXTURE_INPUTS, legacyCorrections });
  return conn;
}

const empty = async () => {
  const path = join(await mkdtemp(join(tmpdir(), "beeline-carry-empty-")), "none.csv");
  await writeFile(path, "_id,field,base_value,new_value,author,reason\n");
  return path;
};

/** Everything a sample made from these records says, keyed by the records rather than by ids two stores draw differently. */
async function sampleOf(conn: DuckDBConnection, recordId: string) {
  const [[sampleId]] = (await rows(conn, `SELECT sample_id FROM legacy_specimen_number WHERE _id = '${recordId}'`)) as [[number]];
  const sample = await rows(
    conn,
    `SELECT kind, sample_number, CAST(date_start AS VARCHAR), CAST(date_end AS VARCHAR), specimen_count, inat_observation_id,
            country, state_province, county, locality, protocol, host_name_as_observed
     FROM sample WHERE entity_id = ${sampleId}`,
  );
  const location = await rows(
    conn,
    `SELECT l.latitude, l.longitude, l.coordinate_uncertainty_m, l.elevation_m, l.elevation_latitude, l.elevation_longitude,
            l.source, e.description
     FROM sample_location l LEFT JOIN elevation_source e ON e.entity_id = l.elevation_source_id WHERE l.sample_id = ${sampleId}`,
  );
  const collectors = await rows(
    conn,
    `SELECT p.display_name, c.position FROM sample_collector c JOIN person p ON p.entity_id = c.person_id
     WHERE c.sample_id = ${sampleId} ORDER BY c.position`,
  );
  const atlas = await rows(conn, `SELECT p.code FROM sample_atlas a JOIN program p ON p.entity_id = a.atlas_id WHERE a.sample_id = ${sampleId}`);
  const specimens = await rows(
    conn,
    `SELECT n._id, sp.specimen_number, sp.field_number FROM legacy_specimen_number n
     JOIN specimen sp ON sp.sample_id = n.sample_id AND sp.specimen_number = n.specimen_number
     WHERE n.sample_id = ${sampleId} ORDER BY sp.specimen_number`,
  );
  const entered = await rows(conn, `SELECT count(*) FROM sample_entry WHERE sample_id = ${sampleId}`);
  return { sample, location, collectors, atlas, specimens, entered };
}

describe("carrying over old records a correction made whole", { timeout: 120_000 }, () => {
  it("makes of them what promotion makes of the corrected records", async () => {
    const conn = await fresh();
    // Before: all four held back, and only his ordinary sample taken.
    expect(await rows(conn, `SELECT _id FROM legacy_specimen_number WHERE _id LIKE 'carry-%'`)).toEqual([["carry-0"]]);

    const result = await carryOverLegacyRecords(conn, { correctionsCsv: corrections });
    expect(result.correctionsAdded).toBe(5);
    expect(result.correctionsNotAdded).toEqual([]);
    expect(result.samples).toEqual([
      expect.objectContaining({ collector: "Lincoln Best", sampleNumber: "T-1", dateStart: "2018-08-19", dateEnd: "2018-08-23", fieldNumbers: ["2461832", "2461833"] }),
    ]);
    expect(result.refused).toEqual([
      expect.objectContaining({ sampleNumber: "T-2", fieldNumbers: ["2461900"], why: expect.stringContaining("identification") }),
      expect.objectContaining({ sampleNumber: "T-4", fieldNumbers: ["2461960"], why: expect.stringContaining("iNaturalist observation") }),
      expect.objectContaining({ sampleNumber: "T-5", fieldNumbers: ["2461970"], why: expect.stringContaining("identification") }),
    ]);

    const made = await sampleOf(conn, "carry-1");
    expect(made).toEqual(await sampleOf(reference, "carry-1"));
    // Spelled out, so a fault both share does not pass unseen.
    expect(made.sample).toEqual([["trap", "T-1", "2018-08-19", "2018-08-23", 2, null, "USA", "OR", "Linn", "Big Lake", "vane traps", null]]);
    expect(made.location).toEqual([[44.385, -121.864, null, 1432, 44.385, -121.864, "legacy_import", expect.stringContaining("legacy verbatimElevation")]]);
    expect(made.collectors).toEqual([["Lincoln Best", 1]]);
    expect(made.atlas).toEqual([["OBA"]]);
    expect(made.specimens).toEqual([["carry-1", 1, "2461832"], ["carry-2", 2, "2461833"]]);
    expect(made.entered).toEqual([[0n]]);

    // The corrections are the store's now, so the views promotion left read the dates as corrected.
    expect(await rows(conn, `SELECT count(*) FROM legacy_promotion_finding WHERE _id LIKE 'carry-%' AND rule = 'bad_date'`)).toEqual([[0n]]);
    expect(await rows(conn, `SELECT _id FROM legacy_promotion_finding WHERE _id LIKE 'carry-%' AND severity = 'blocking' ORDER BY 1`)).toEqual([["carry-4"]]);
  });

  it("does nothing the second time, and nothing at all as a dry run", async () => {
    const conn = await fresh();
    const dry = await carryOverLegacyRecords(conn, { correctionsCsv: corrections, dryRun: true });
    expect(dry.samples).toHaveLength(1);
    expect(await rows(conn, `SELECT count(*) FROM legacy_correction WHERE _id LIKE 'carry-%'`)).toEqual([[0n]]);
    expect(await rows(conn, `SELECT count(*) FROM specimen WHERE field_number = '2461832'`)).toEqual([[0n]]);

    await carryOverLegacyRecords(conn, { correctionsCsv: corrections });
    const again = await carryOverLegacyRecords(conn, { correctionsCsv: corrections });
    expect(again).toMatchObject({ correctionsAdded: 0, samples: [] });
    expect(await rows(conn, `SELECT count(*) FROM specimen WHERE field_number = '2461832'`)).toEqual([[1n]]);
  });

  it("adds no correction for a record already carried over, or for one that does not exist", async () => {
    const conn = await fresh();
    const file = join(await mkdtemp(join(tmpdir(), "beeline-carry-file-")), "corrections.csv");
    await writeFile(
      file,
      ["_id,field,base_value,new_value,author,reason", "carry-0,locality,Big Lake,Elsewhere,Test,carried", "no-such,day,1,2,Test,typo"].join("\n") + "\n",
    );
    const result = await carryOverLegacyRecords(conn, { correctionsCsv: file });
    expect(result.correctionsAdded).toBe(0);
    expect(result.correctionsNotAdded).toEqual([
      { id: "carry-0", field: "locality", why: expect.stringContaining("already a specimen") },
      { id: "no-such", field: "day", why: expect.stringContaining("no old record") },
    ]);
    expect(await rows(conn, `SELECT count(*) FROM legacy_correction WHERE _id IN ('carry-0', 'no-such')`)).toEqual([[0n]]);
  });

  it("leaves a group alone whose sample already exists, and a correction an in-app edit already made", async () => {
    const conn = await fresh();
    // A sample of Lincoln Best's, numbered T-1, on 19 August 2018, made by someone since.
    await conn.run(
      `INSERT INTO sample (kind, sample_number, date_start, date_end, specimen_count) VALUES ('trap', 'T-1', DATE '2018-08-19', DATE '2018-08-23', 0)`,
    );
    await conn.run(
      `INSERT INTO sample_collector (sample_id, person_id, position)
       SELECT (SELECT max(entity_id) FROM sample), entity_id, 1 FROM person WHERE display_name = 'Lincoln Best'`,
    );
    // And an in-app correction of one record's month, which wins over the file.
    await conn.run(`INSERT INTO legacy_correction VALUES ('carry-2', 'month2', '7', '8', 'staff', 'in the app')`);
    const result = await carryOverLegacyRecords(conn, { correctionsCsv: corrections });
    expect(result.correctionsAdded).toBe(4);
    expect(result.samples).toEqual([]);
    expect(result.refused.map((g) => [g.sampleNumber, g.why])).toContainEqual(["T-1", expect.stringContaining("already exists")]);
    expect(await rows(conn, `SELECT author FROM legacy_correction WHERE _id = 'carry-2' AND field = 'month2'`)).toEqual([["staff"]]);
  });
});
