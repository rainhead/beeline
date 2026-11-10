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
 * of field numbers, whose four pairs are each kind the repair meets, and a
 * trap sample of 2020 whose end date was written before its start, on an
 * observation Beeline holds.
 *   2127319 kept, nothing   / 2127004 set aside, expert and volunteer
 *   2127320 kept, expert    / 2127005 set aside, another expert's bee
 *   2127321 kept, volunteer / 2127006 set aside, expert and the same volunteer
 *   2127322 kept, expert    / 2127007 set aside, an expert's refinement of it
 *   2037759, 2037760 on observation 56359335; 2037900 on one Beeline lacks
 */
const FIXTURE = new URL("./fixtures/legacy-skipped.jsonl", import.meta.url).pathname;

let conn: DuckDBConnection;
let tripSample: number;

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
  // The trap sample as the nightly sync made it from its observation, with no specimens.
  tripSample = await insertCleanSample(conn, {
    sample_number: "'02viii20.1'",
    inat_observation_id: "56359335",
    collector_id: "(SELECT entity_id FROM person WHERE display_name = 'Cleo Cortez')",
  });
});

describe("repairing what legacy promotion set aside", () => {
  test("promotion kept one record of each pair, and refused the trap sample's", async () => {
    expect(await rows(conn, `SELECT field_number FROM specimen ORDER BY 1`)).toEqual([["2127319"], ["2127320"], ["2127321"], ["2127322"]]);
    expect(await dets("2127319")).toEqual([]);
  });

  test("a dry run says what it would do, and does nothing", async () => {
    const r = await repairSkippedLegacyRecords(conn, { dryRun: true });
    expect(r).toEqual({
      tied: 3,
      carriedExpert: 2,
      carriedVolunteer: 1,
      separated: [{ fieldNumber: "2127005", keptFieldNumber: "2127320" }],
      attached: [{ observation: 56359335, sampleId: tripSample, specimens: 2 }],
      newSpecimenDeterminations: 2,
      unresolved: [],
      dryRun: true,
    });
    expect(describeSkippedRepair(r)).toContain("3 set-aside second print(s) would be tied to their specimen");
    expect(await rows(conn, `SELECT count(*) FROM legacy_duplicate_record`)).toEqual([[0n]]);
    expect(await rows(conn, `SELECT count(*) FROM specimen`)).toEqual([[4n]]);
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

  test("makes the second bee of a pair a specimen of its own, numbered after the sample's last", async () => {
    expect(await dets("2127005")).toEqual([["Bombus caliginosus", true, null, "Lincoln Best", "legacy_import"]]);
    expect(await dets("2127320")).toEqual([["Lasioglossum titusi", true, null, "Lincoln Best", "legacy_import"]]);
    expect(
      await rows(
        conn,
        `SELECT sp.specimen_number, n._id FROM specimen sp JOIN legacy_specimen_number n
           ON n.sample_id = sp.sample_id AND n.specimen_number = sp.specimen_number
         WHERE sp.field_number = '2127005'`,
      ),
    ).toEqual([[5, "d1000002"]]);
  });

  test("gives the trap sample its specimens, and leaves a record whose observation Beeline lacks", async () => {
    expect(
      await rows(conn, `SELECT specimen_number, field_number FROM specimen WHERE sample_id = ${tripSample} ORDER BY 1`),
    ).toEqual([[1, "2037759"], [2, "2037760"]]);
    expect(await dets("2037759")).toEqual([["Bombus vosnesenskii", true, null, "Lincoln Best", "legacy_import"]]);
    expect(await rows(conn, `SELECT count(*) FROM specimen WHERE field_number = '2037900'`)).toEqual([[0n]]);
  });

  test("a second run finds nothing left to do", async () => {
    expect(await repairSkippedLegacyRecords(conn)).toMatchObject({
      tied: 0, carriedExpert: 0, carriedVolunteer: 0, separated: [], attached: [], newSpecimenDeterminations: 0,
    });
  });

  test("the legacy-format export still writes one row for each specimen", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "beeline-repair-")), "occurrences.csv");
    const { rows: written } = await writeLegacyExport(conn, path);
    const [[specimens]] = (await rows(conn, `SELECT count(*) FROM specimen`)) as [[bigint]];
    expect(written).toBe(Number(specimens));
    const numbers = (await readFile(path, "utf8")).split("\n").filter((l) => l.includes("2127005"));
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
