import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { writeLegacyExport } from "../src/legacy-export.js";
import { readOldVolunteerRecords, recordOldVolunteerDeterminations } from "../src/legacy-volunteer-import.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { describeSkippedRepair, repairSkippedLegacyRecords } from "../src/repair-legacy-skipped.js";
import { FakeOldBeeline } from "./fake-old-beeline.js";
import { createMemoryDb, FIXTURE_INPUTS, insertCleanSample, rows } from "./helpers.js";

/**
 * Synthetic records, shaped on what the store of 9 November 2026 showed
 * (beeline-iuva): one collector's sample of 2021 printed twice under two runs
 * of field numbers, whose seven pairs are each kind the repair meets, and a
 * sample of 2020 whose end date was written before its start, on an
 * observation Beeline holds.
 *   2127319 kept, nothing   / 2127004 set aside, expert and volunteer
 *   2127320 kept, expert    / 2127005 set aside, an expert's different bee
 *   2127321 kept, volunteer / 2127006 set aside, expert and the same volunteer
 *   2127322 kept, expert    / 2127007 set aside, an expert's refinement of it
 *   2127323 kept, nothing   / 2127008 set aside, expert, but pan-trapped
 *   2127324 kept, a female  / 2127009 set aside, the same species, a male
 *   2127325 kept, nothing   / 2127010 set aside, expert, 11 km away
 *   2037759, 2037760 on observation 56359335; 2037900 on one Beeline lacks
 */
const FIXTURE = new URL("./fixtures/legacy-skipped.jsonl", import.meta.url).pathname;

let conn: DuckDBConnection;
let observedSample: number;

const specimenOf = async (fieldNumber: string): Promise<number> =>
  ((await rows(conn, `SELECT entity_id FROM specimen WHERE field_number = '${fieldNumber}'`)) as [[number]])[0][0];

const dets = async (fieldNumber: string) =>
  rows(
    conn,
    `SELECT a.scientific_name, d.is_expert, d.sex, p.display_name, d.channel
     FROM determination d JOIN specimen sp ON sp.entity_id = d.specimen_id JOIN animal a ON a.entity_id = d.animal_id
     LEFT JOIN person p ON p.entity_id = d.determiner_id
     WHERE sp.field_number = '${fieldNumber}' ORDER BY d.is_expert DESC, a.scientific_name`,
  );

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await loadLegacyStaging(conn, FIXTURE);
  await promoteLegacy(conn, FIXTURE_INPUTS);
  // The 2020 sample as the nightly sync made it from its observation, with no specimens.
  observedSample = await insertCleanSample(conn, {
    sample_number: "'02viii20.1'",
    inat_observation_id: "56359335",
    collector_id: "(SELECT entity_id FROM person WHERE display_name = 'Cleo Cortez')",
  });
});

describe("repairing what legacy promotion set aside", () => {
  test("promotion kept one record of each pair, and refused the 2020 sample's", async () => {
    expect(await rows(conn, `SELECT field_number FROM specimen ORDER BY 1`)).toEqual(
      ["2127319", "2127320", "2127321", "2127322", "2127323", "2127324", "2127325"].map((n) => [n]),
    );
    expect(await dets("2127319")).toEqual([]);
  });

  test("a dry run says what it would do, and does nothing", async () => {
    const r = await repairSkippedLegacyRecords(conn, { dryRun: true });
    expect(r).toEqual({
      tied: 3,
      leftAlone: [
        { reason: "a different sex or caste", pairs: 1 },
        { reason: "caught by a different method", pairs: 1 },
        { reason: "recorded more than a kilometre apart", pairs: 1 },
        { reason: "the experts named different bees", pairs: 1 },
      ],
      carriedExpert: 2,
      carriedVolunteer: 1,
      attached: [{ observation: 56359335, sampleId: observedSample, specimens: 2 }],
      newSpecimenDeterminations: 1,
      unresolved: [],
      dryRun: true,
    });
    expect(describeSkippedRepair(r)).toContain("3 set-aside second print(s) would be tied to their specimen");
    expect(await rows(conn, `SELECT count(*) FROM legacy_duplicate_record`)).toEqual([[0n]]);
    expect(await rows(conn, `SELECT count(*) FROM specimen`)).toEqual([[7n]]);
  });

  test("carries what each specimen lacks from its set-aside second print, as promotion would have recorded it", async () => {
    await repairSkippedLegacyRecords(conn);
    // Nothing on the kept record: both identifications come over, the
    // expert's to its determiner and the volunteer's to the collector.
    expect(await dets("2127319")).toEqual([
      ["Bombus vosnesenskii", true, "female", "Lincoln Best", "legacy_import"],
      ["Bombus", false, "female", "Cleo Cortez", "legacy_import"],
    ]);
    // A volunteer identification already there: only the expert's comes over.
    expect(await dets("2127321")).toEqual([
      ["Bombus vosnesenskii", true, null, "Lincoln Best", "legacy_import"],
      ["Bombus", false, "female", "Cleo Cortez", "legacy_import"],
    ]);
    // An expert identification already there, which the set-aside record's
    // refines: one bee, and the specimen keeps the one it has.
    expect(await dets("2127322")).toEqual([["Lasioglossum", true, null, "Lincoln Best", "legacy_import"]]);
    expect(await rows(conn, `SELECT d._id, sp.field_number FROM legacy_duplicate_record d JOIN specimen sp ON sp.entity_id = d.specimen_id ORDER BY 1`)).toEqual([
      ["d1000001", "2127319"],
      ["d1000003", "2127321"],
      ["d1000004", "2127322"],
    ]);
  });

  test("leaves alone a pair that may be two collections or two bees: nothing carried, tied or made", async () => {
    for (const n of ["2127323", "2127325"]) expect(await dets(n)).toEqual([]);
    expect(await dets("2127324")).toEqual([["Bombus vosnesenskii", true, "female", "Lincoln Best", "legacy_import"]]);
    // Nor are a pair whose experts named different bees made two specimens.
    expect(await dets("2127320")).toEqual([["Lasioglossum titusi", true, null, "Lincoln Best", "legacy_import"]]);
    expect(
      await rows(conn, `SELECT count(*) FROM legacy_duplicate_record WHERE _id IN ('d1000002', 'd1000005', 'd1000006', 'd1000007')`),
    ).toEqual([[0n]]);
    expect(
      await rows(conn, `SELECT count(*) FROM specimen WHERE field_number IN ('2127005', '2127008', '2127009', '2127010')`),
    ).toEqual([[0n]]);
    expect(await rows(conn, `SELECT s.specimen_count FROM sample s JOIN specimen sp ON sp.sample_id = s.entity_id WHERE sp.field_number = '2127320'`)).toEqual([[7]]);
  });

  test("gives the 2020 sample its specimens, and leaves a record whose observation Beeline lacks", async () => {
    expect(
      await rows(conn, `SELECT specimen_number, field_number FROM specimen WHERE sample_id = ${observedSample} ORDER BY 1`),
    ).toEqual([[1, "2037759"], [2, "2037760"]]);
    expect(await dets("2037759")).toEqual([["Bombus vosnesenskii", true, null, "Lincoln Best", "legacy_import"]]);
    expect(await rows(conn, `SELECT count(*) FROM specimen WHERE field_number = '2037900'`)).toEqual([[0n]]);
  });

  test("a second run finds nothing left to do", async () => {
    expect(await repairSkippedLegacyRecords(conn)).toMatchObject({
      tied: 0, carriedExpert: 0, carriedVolunteer: 0, attached: [], newSpecimenDeterminations: 0,
    });
  });

  test("refuses, writing nothing, when one specimen has two set-aside records", async () => {
    // A third print of 2127322's specimen, set aside like the second.
    await conn.run(`DELETE FROM legacy_duplicate_record WHERE _id = 'd1000004'`);
    await conn.run(
      `INSERT INTO legacy_occurrence SELECT * REPLACE ('d1000099' AS _id, '2127099' AS "fieldNumber", '30-Dec-21' AS "dateLabelPrint")
       FROM legacy_occurrence WHERE _id = 'd1000004'`,
    );
    await expect(repairSkippedLegacyRecords(conn)).rejects.toThrow(/2127007 and 2127099/);
    expect(await rows(conn, `SELECT count(*) FROM legacy_duplicate_record WHERE _id IN ('d1000004', 'd1000099')`)).toEqual([[0n]]);
    await conn.run(`DELETE FROM legacy_occurrence WHERE _id = 'd1000099'`);
    await conn.run(`INSERT INTO legacy_duplicate_record (_id, specimen_id) SELECT 'd1000004', entity_id FROM specimen WHERE field_number = '2127322'`);
  });

  test("the legacy-format export still writes one row for each specimen", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "beeline-repair-")), "occurrences.csv");
    const { rows: written } = await writeLegacyExport(conn, path);
    const [[specimens]] = (await rows(conn, `SELECT count(*) FROM specimen`)) as [[bigint]];
    expect(written).toBe(Number(specimens));
    const numbers = (await readFile(path, "utf8")).split("\n").filter((l) => l.includes("2037759"));
    expect(numbers).toHaveLength(1);
  });
});

describe("the nightly import, after the repair", () => {
  let old: FakeOldBeeline;
  afterAll(() => old.server.close());

  test("follows a set-aside second print to the specimen it was tied to", async () => {
    old = new FakeOldBeeline();
    const creds = await old.start();
    old.records.set("d1000004", { _id: "d1000004", fieldNumber: "2127007", familyVolDet: "Halictidae", genusVolDet: "Lasioglossum", sexVolDet: "female" });
    const r = await recordOldVolunteerDeterminations(conn, await readOldVolunteerRecords(creds));
    expect(r).toMatchObject({ recorded: 1, notInBeeline: [] });
    expect((await dets("2127322")).at(-1)).toEqual(["Lasioglossum", false, "female", "Cleo Cortez", "legacy_import"]);
  });
});
