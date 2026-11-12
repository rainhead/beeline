import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { writeLegacyExport } from "../src/legacy-export.js";
import { readOldVolunteerRecords, recordOldVolunteerDeterminations } from "../src/legacy-volunteer-import.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { describeSkippedRepair, REMARK_SOURCE, REMARK_STATED_BY, repairSkippedLegacyRecords } from "../src/repair-legacy-skipped.js";
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
 * and records refused for a missing detail (beeline-iuva, GitHub #303):
 *   Cleo_Cortez:18.008.001, 002 kept: sample 8 of 2018, in the 2017–2018
 *     field numbering whose last part is the specimen
 *   Cleo_Cortez:19.008.001, no specimen number, method or coordinates, an
 *     expert's identification: a second record of 18.008.001
 *   Cleo_Cortez:18.008.004, no specimen number and only a year: a gap in sample 8
 *   2127399, specimen 0 in sample 7, which holds all it counts: left out
 *   2050001, specimen 0 on observation 56370000, a sample counting one and holding none
 */
const FIXTURE = new URL("./fixtures/legacy-skipped.jsonl", import.meta.url).pathname;

let conn: DuckDBConnection;
let observedSample: number;
let countedSample: number;

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
  // A sample whose observation counts one bee, of which Beeline holds none.
  countedSample = await insertCleanSample(conn, {
    sample_number: "'3'",
    inat_observation_id: "56370000",
    specimen_count: "1",
    collector_id: "(SELECT entity_id FROM person WHERE display_name = 'Cleo Cortez')",
  });
});

const remarkOf = async (fieldNumber: string) =>
  rows(
    conn,
    `SELECT d.remarks FROM specimen_disposition d JOIN specimen sp ON sp.entity_id = d.specimen_id WHERE sp.field_number = '${fieldNumber}'`,
  );

describe("repairing what legacy promotion set aside", () => {
  test("promotion kept one record of each pair, and refused the 2020 sample's", async () => {
    expect(await rows(conn, `SELECT field_number FROM specimen ORDER BY 1`)).toEqual(
      ["2127319", "2127320", "2127321", "2127322", "2127323", "2127324", "2127325", "Cleo_Cortez:18.008.001", "Cleo_Cortez:18.008.002"].map(
        (n) => [n],
      ),
    );
    expect(await dets("2127319")).toEqual([]);
  });

  test("a dry run says what it would do, and does nothing", async () => {
    const r = await repairSkippedLegacyRecords(conn, { dryRun: true });
    expect(r).toEqual({
      tied: 4,
      tiedRefused: 1,
      leftAlone: [
        { reason: "a different sex or caste", pairs: 1 },
        { reason: "caught by a different method", pairs: 1 },
        { reason: "recorded more than a kilometre apart", pairs: 1 },
        { reason: "the experts named different bees", pairs: 1 },
      ],
      carriedExpert: 3,
      carriedVolunteer: 1,
      attached: [{ observation: 56359335, sampleId: observedSample, specimens: 2 }],
      placed: 2,
      newSpecimenDeterminations: 1,
      remarked: [
        { kind: "placed", specimens: 2 },
        { kind: "pin", specimens: 3 },
        { kind: "pair", specimens: 4 },
      ],
      remarkLeftAlone: 0,
      unresolved: [],
      dryRun: true,
    });
    expect(describeSkippedRepair(r)).toContain("4 set-aside second print(s) would be tied to their specimen");
    expect(describeSkippedRepair(r)).toContain("9 specimen(s) would be given a remark: 2 placed, 3 pin, 4 pair");
    expect(await rows(conn, `SELECT count(*) FROM legacy_duplicate_record`)).toEqual([[0n]]);
    expect(await rows(conn, `SELECT count(*) FROM specimen`)).toEqual([[9n]]);
    expect(await rows(conn, `SELECT count(*) FROM specimen_disposition`)).toEqual([[0n]]);
  });

  test("carries what each specimen lacks from its set-aside second print, as promotion would have recorded it", async () => {
    await repairSkippedLegacyRecords(conn, { statedOn: "2026-11-12" });
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
      ["e4000003", "Cleo_Cortez:18.008.001"],
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

  test("ties a record refused for a missing detail to the specimen it is a second record of, and carries its identification", async () => {
    // Cleo_Cortez:19.008.001 has no specimen number, method or coordinates;
    // its field number says specimen 1 of sample 8, which Beeline holds.
    expect(await dets("Cleo_Cortez:18.008.001")).toEqual([["Bombus vosnesenskii", true, null, "Lincoln Best", "legacy_import"]]);
    expect(await rows(conn, `SELECT count(*) FROM specimen WHERE field_number = 'Cleo_Cortez:19.008.001'`)).toEqual([[0n]]);
  });

  test("places a refused record where one assumption puts it in one sample, and leaves out one that would be a bee too many", async () => {
    // A gap in sample 8: its number from its field number, after the sample's last.
    expect(
      await rows(
        conn,
        `SELECT sp.specimen_number, sp.field_number, s.specimen_count FROM specimen sp JOIN sample s ON s.entity_id = sp.sample_id
         WHERE s.entity_id = (SELECT sample_id FROM specimen WHERE field_number = 'Cleo_Cortez:18.008.001') ORDER BY 1`,
      ),
    ).toEqual([[1, "Cleo_Cortez:18.008.001", 3], [2, "Cleo_Cortez:18.008.002", 3], [3, "Cleo_Cortez:18.008.004", 3]]);
    // The one bee a sample counts and Beeline lacked.
    expect(await rows(conn, `SELECT specimen_number, field_number FROM specimen WHERE sample_id = ${countedSample}`)).toEqual([[1, "2050001"]]);
    // Sample 7 holds every specimen it counts, so a record numbered 0 is not another.
    expect(await rows(conn, `SELECT count(*) FROM specimen WHERE field_number = '2127399'`)).toEqual([[0n]]);
  });

  test("says on each specimen what about its old records is in doubt, as occurrenceRemarks", async () => {
    expect(await remarkOf("Cleo_Cortez:18.008.004")).toEqual([
      [
        "Old Beeline's record of this specimen, field number Cleo_Cortez:18.008.004, gives only the year it was collected, 2018, and has no specimen number, so new Beeline placed it with the collector's other specimens of sample 8 from 15 May 2018, reading its specimen number, 4, from its field number.",
      ],
    ]);
    expect(await remarkOf("2050001")).toEqual([
      [
        "Old Beeline's record of this specimen, field number 2050001, gives its specimen number as 0, so new Beeline placed it in the sample of its iNaturalist observation, as the specimen that sample counted but Beeline did not hold.",
      ],
    ]);
    expect(await remarkOf("2127319")).toEqual([
      ["Old Beeline recorded this specimen twice, as 2127319 and 2127004. Its identifications were entered under 2127004, so that is probably the number on the pin."],
    ]);
    expect(await remarkOf("2127321")).toEqual([
      ["Old Beeline recorded this specimen twice, as 2127321 and 2127006. Its expert identification was entered under 2127006, so that is probably the number on the pin."],
    ]);
    expect(await remarkOf("Cleo_Cortez:18.008.001")).toEqual([
      [
        "Old Beeline recorded this specimen twice, as Cleo_Cortez:18.008.001 and Cleo_Cortez:19.008.001. Its expert identification was entered under Cleo_Cortez:19.008.001, so that is probably the number on the pin.",
      ],
    ]);
    // Its expert's identification refines the kept record's: nothing in doubt.
    expect(await remarkOf("2127322")).toEqual([]);
    expect(await remarkOf("2127323")).toEqual([
      [
        "Old Beeline also has field number 2127008 for this collector, date, sample number and specimen number, but that record says pan traps and this one net, so it may be a second bee. That record identifies it as Bombus vosnesenskii (expert).",
      ],
    ]);
    expect(await remarkOf("2127324")).toEqual([
      [
        "Old Beeline also has field number 2127009 for this collector, date, sample number and specimen number, but the two give the bee a different sex or caste, so it may be a second bee. That record identifies it as Bombus vosnesenskii, male (expert).",
      ],
    ]);
    expect(await remarkOf("2127325")).toEqual([
      [
        "Old Beeline also has field number 2127010 for this collector, date, sample number and specimen number, but the two were recorded 11.1 km apart, so it may be a second bee. That record identifies it as Bombus vosnesenskii (expert).",
      ],
    ]);
    expect(await remarkOf("2127320")).toEqual([
      [
        "Old Beeline also has field number 2127005 for this collector, date, sample number and specimen number, but their experts named different bees, so it may be a second bee. That record identifies it as Bombus caliginosus (expert).",
      ],
    ]);
    expect(await rows(conn, `SELECT DISTINCT disposition, stated_by, CAST(stated_on AS VARCHAR), source FROM specimen_disposition`)).toEqual([
      [null, REMARK_STATED_BY, "2026-11-12", REMARK_SOURCE],
    ]);
  });

  test("a second run finds nothing left to do", async () => {
    expect(await repairSkippedLegacyRecords(conn)).toMatchObject({
      tied: 0, carriedExpert: 0, carriedVolunteer: 0, attached: [], placed: 0, newSpecimenDeterminations: 0, remarked: [],
    });
  });

  test("leaves a specimen's remark from somewhere else as it is", async () => {
    const [[specimen]] = (await rows(conn, `SELECT entity_id FROM specimen WHERE field_number = '2127323'`)) as [[number]];
    await conn.run(`UPDATE specimen_disposition SET source = 'inventory.xlsx', remarks = 'PHANTOM RECORD' WHERE specimen_id = ${specimen}`);
    expect(await repairSkippedLegacyRecords(conn, { dryRun: true })).toMatchObject({ remarked: [], remarkLeftAlone: 1 });
    expect(await remarkOf("2127323")).toEqual([["PHANTOM RECORD"]]);
    await conn.run(`DELETE FROM specimen_disposition WHERE specimen_id = ${specimen}`);
    await repairSkippedLegacyRecords(conn, { statedOn: "2026-11-12" });
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
    const lines = (await readFile(path, "utf8")).split("\n");
    expect(lines.filter((l) => l.includes("2037759"))).toHaveLength(1);
    // And carries the remark, as occurrenceRemarks.
    expect(lines.find((l) => l.includes("2127323"))).toContain("so it may be a second bee");
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
