import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { LEGACY_EXPORT_COLUMNS, writeLegacyExport } from "../src/legacy-export.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths } from "./helpers.js";
import { promotedStore } from "./promoted-store.js";
import { createKysely } from "../src/db.js";
import { applySampleOverlay } from "../src/apply-sample-overlay.js";
import { createApp } from "../src/app/server.js";

let conn: DuckDBConnection;
let path: string;
let bytes: Buffer;

/**
 * A store of its own for each test that uses `conn`: many of them edit the
 * staged records or the model before writing another export, and none may
 * start from what another changed. A copy of the promoted store is the same
 * store every time (about 0.2 s), so `path` and `bytes`, written once from
 * the first, describe every test's store.
 */
const freshStore = async () => {
  ({ conn } = await promotedStore("occurrences"));
};

beforeAll(async () => {
  await freshStore();
  path = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
  await writeLegacyExport(conn, path);
  bytes = await readFile(path);
});

/** The export read back as the legacy file's own consumers would: every value text, blank as ''. */
async function exported(): Promise<Record<string, string>[]> {
  const result = await conn.runAndReadAll(
    `SELECT * FROM read_csv('${path}', header = true, all_varchar = true, quote = '"', escape = '"')`,
  );
  return result.getRowObjectsJson().map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, (v as string | null) ?? ""])));
}

describe("the legacy-format export", () => {
  beforeEach(freshStore);

  test("opens with a byte order mark and the legacy header, in order", () => {
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const header = bytes.subarray(3).toString("utf8").split("\n")[0];
    expect(header).toBe(LEGACY_EXPORT_COLUMNS.join(","));
    // The template's 63, and occurrenceRemarks after them (beeline-fud5).
    expect(LEGACY_EXPORT_COLUMNS).toHaveLength(64);
    expect(LEGACY_EXPORT_COLUMNS.at(-1)).toBe("occurrenceRemarks");
  });

  test("writes the inventory's remark on a specimen as occurrenceRemarks, and nothing where there is none", async () => {
    await conn.run(
      `INSERT INTO specimen_disposition (specimen_id, disposition, remarks, stated_by, stated_on, source)
       SELECT entity_id, 'missing', 'LOST SPECIMEN: No specimen in complete OR inventory.', 'Inez Inventory', DATE '2026-11-03', 'inventory.xlsx'
       FROM specimen WHERE field_number = '25000002'`,
    );
    const again = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
    await writeLegacyExport(conn, again);
    const result = await conn.runAndReadAll(
      `SELECT "fieldNumber", "occurrenceRemarks" FROM read_csv('${again}', header = true, all_varchar = true) ORDER BY 1`,
    );
    const byNumber = new Map(result.getRows().map(([n, r]) => [n, r]));
    expect(byNumber.get("25000002")).toBe("LOST SPECIMEN: No specimen in complete OR inventory.");
    expect(byNumber.get("25000001")).toBeNull();
    await conn.run(`DELETE FROM specimen_disposition`);
  });

  test("writes a blank as nothing, never as an empty quoted string", () => {
    expect(bytes.toString("utf8")).not.toContain('""');
  });

  test("has one row per specimen, in the legacy file's order", async () => {
    const out = await exported();
    const [[specimens]] = (await rows(conn, "SELECT count(*) FROM specimen")) as [[bigint]];
    expect(out).toHaveLength(Number(specimens));
    expect(out.map((r) => r.fieldNumber)).toEqual(["25000001", "25000002", "25000003", "25000005", "25000009"]);
  });

  test("carries what Beeline does not model exactly as the legacy record had it, blanks included", async () => {
    const byNumber = new Map((await exported()).map((r) => [r.fieldNumber, r]));
    expect(byNumber.get("25000001")).toMatchObject({
      occurrenceID: "https://osac.oregonstate.edu/OBS/OBA_25000001",
      dateLabelPrint: "17-Aug-25",
      specimenId: "1",
    });
  });

  test("writes what Beeline owns from the model, in the legacy formats", async () => {
    const byNumber = new Map((await exported()).map((r) => [r.fieldNumber, r]));
    // A Roman-numeral month is normalised; a single day is M/D/YYYY.
    expect(byNumber.get("25000001")).toMatchObject({
      month: "7",
      verbatimEventDate: "7/14/2025",
      recordedBy: "Ada Collector",
      firstNameInitial: "A.",
      genus: "Bombus",
      specificEpithet: "vosnesenskii",
      scientificName: "Bombus vosnesenskii",
      taxonRank: "Species",
      identifiedBy: "Lincoln Best",
    });
    // A trap sample's range is the legacy's unpadded YYYY-M-D/YYYY-M-D, with the end date apart.
    expect(byNumber.get("25000005")).toMatchObject({
      verbatimEventDate: "2025-7-1/2025-7-14",
      day2: "14",
      month2: "7",
      year2: "2025",
      startDayofYear: "182",
      endDayofYear: "195",
      recordedBy: "Bea Trapper | Ada Collector",
    });
    // An open-nomenclature qualifier stays inside the name, as the determiner wrote it.
    expect(byNumber.get("25000009")?.scientificName).toBe("Lasioglossum nr. tenax");
  });

  test("writes each row's own elevation and uncertainty beside its own coordinates, and a volunteer's word where Beeline holds none", async () => {
    // Synthetic, in the shape of the 2026 sandbox's merged samples: one
    // sample whose legacy rows were taken at different points. Staging is
    // edited after promotion, so the sample keeps its one location.
    const [[sampleId]] = (await conn.runAndReadAll(
      `SELECT sp.sample_id FROM specimen sp JOIN sample_location loc ON loc.sample_id = sp.sample_id
       WHERE loc.source = 'legacy_import' AND loc.elevation_m IS NOT NULL
       GROUP BY 1 HAVING count(*) >= 2 ORDER BY 1 LIMIT 1`,
    )).getRows() as [[number]];
    const specimens = (await conn.runAndReadAll(
      `SELECT sp.field_number, n._id FROM specimen sp
       JOIN legacy_specimen_number n ON n.sample_id = sp.sample_id AND n.specimen_number = sp.specimen_number
       WHERE sp.sample_id = ${sampleId} ORDER BY sp.specimen_number`,
    )).getRows() as [string, string][];
    const [[lat, lon, elevation, uncertainty]] = (await conn.runAndReadAll(
      `SELECT latitude, longitude, elevation_m, coordinate_uncertainty_m FROM sample_location WHERE sample_id = ${sampleId}`,
    )).getRows() as [[number, number, number, number]];
    const [[first, firstId], [second, secondId]] = specimens as [[string, string], [string, string]];
    const saved = (await conn.runAndReadAll(`SELECT * FROM legacy_occurrence WHERE _id IN ('${firstId}', '${secondId}')`)).getRowObjectsJson();
    try {
      // The first row: another point, with an elevation and no uncertainty of its own.
      await conn.run(`UPDATE legacy_occurrence SET "decimalLatitude" = '${(lat + 0.0882).toFixed(4)}', "verbatimElevation" = '918',
                      "coordinateUncertaintyInMeters" = '', "sexVolDet" = 'female' WHERE _id = '${firstId}'`);
      // The second row: the sample's own point, with no elevation or uncertainty of its own.
      await conn.run(`UPDATE legacy_occurrence SET "decimalLatitude" = '${lat.toFixed(4)}', "decimalLongitude" = '${lon.toFixed(4)}',
                      "verbatimElevation" = '', "coordinateUncertaintyInMeters" = '', "sexVolDet" = '' WHERE _id = '${secondId}'`);
      const other = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
      await writeLegacyExport(conn, other);
      const out = (await conn.runAndReadAll(
        `SELECT "fieldNumber", "verbatimElevation", "coordinateUncertaintyInMeters", "sexVolDet"
         FROM read_csv('${other}', header = true, all_varchar = true, quote = '"', escape = '"')
         WHERE "fieldNumber" IN ('${first}', '${second}') ORDER BY 1`,
      )).getRows();
      expect([first, second]).toEqual(["25000001", "25000003"]);
      expect([elevation, uncertainty]).toEqual([72, 30]);
      expect(out).toEqual([
        // Its own elevation; no uncertainty, since the sample's describes
        // another point; and the volunteer's sex from the legacy row, since
        // Beeline holds no volunteer identification of this specimen.
        ["25000001", "918", null, "female"],
        // At the sample's own point, the model's values fill the row's blanks.
        ["25000003", "72", "30", null],
      ]);
    } finally {
      for (const row of saved) {
        const r = row as Record<string, string | null>;
        await conn.run(`UPDATE legacy_occurrence SET "decimalLatitude" = ?, "decimalLongitude" = ?, "verbatimElevation" = ?,
                        "coordinateUncertaintyInMeters" = ?, "sexVolDet" = ? WHERE _id = ?`,
          [r.decimalLatitude, r.decimalLongitude, r.verbatimElevation, r.coordinateUncertaintyInMeters, r.sexVolDet, r._id] as never);
      }
    }
  });

  test("writes each row's own method, end date and place where its sample's rows disagree", async () => {
    // Synthetic, in the shape of the sandbox's 2019 Portland sample: rows
    // numbered as one sample, some netted and some from pan traps emptied the
    // next day. Staging is edited after promotion, so the sample keeps one
    // value of each; 25000001 and 25000003 are Ada's sample 1.
    const fields = ["samplingProtocol", "locality", "verbatimEventDate", "day2", "month2", "year2", "startDayofYear", "endDayofYear"];
    const saved = (await conn.runAndReadAll(
      `SELECT _id, ${fields.map((f) => `"${f}"`).join(", ")} FROM legacy_occurrence WHERE "fieldNumber" IN ('25000001', '25000003')`,
    )).getRowObjectsJson();
    const [[sampleLocality]] = (await conn.runAndReadAll(
      `SELECT s.locality FROM sample s JOIN specimen sp ON sp.sample_id = s.entity_id WHERE sp.field_number = '25000003'`,
    )).getRows() as [[string]];
    try {
      await conn.run(`UPDATE legacy_occurrence SET "samplingProtocol" = 'pan traps', locality = 'Elsewhere',
                      "verbatimEventDate" = '2025-VII-14/2025-VII-15', year2 = '2025', month2 = 'VII', day2 = '15',
                      "startDayofYear" = '195', "endDayofYear" = '196' WHERE "fieldNumber" = '25000003'`);
      const other = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
      await writeLegacyExport(conn, other);
      const out = (await conn.runAndReadAll(
        `SELECT "fieldNumber", ${fields.map((f) => `"${f}"`).join(", ")}
         FROM read_csv('${other}', header = true, all_varchar = true, quote = '"', escape = '"')
         WHERE "fieldNumber" IN ('25000001', '25000003', '25000005') ORDER BY 1`,
      )).getRows();
      const staged = (await conn.runAndReadAll(
        `SELECT "fieldNumber", ${fields.map((f) => `nullif("${f}", '')`).join(", ")} FROM legacy_occurrence
         WHERE "fieldNumber" IN ('25000001', '25000003') ORDER BY 1`,
      )).getRows();
      // Each row of the disagreeing sample says what its own record said.
      expect(out.slice(0, 2)).toEqual(staged);
      expect(out[1]).toEqual(["25000003", "pan traps", "Elsewhere", "2025-VII-14/2025-VII-15", "15", "VII", "2025", "195", "196"]);
      // A sample whose rows agree is written from the model, as before.
      const [[protocol]] = (await conn.runAndReadAll(
        `SELECT s.protocol FROM sample s JOIN specimen sp ON sp.sample_id = s.entity_id WHERE sp.field_number = '25000005'`,
      )).getRows() as [[string]];
      expect(out[2]![1]).toBe(protocol);
      // A locality staff set on the sample wins over what its rows said. The
      // override and the sample beside it, as src/apply-sample-overlay.ts writes them.
      await conn.run(`INSERT INTO sample_locality_override (sample_id, locality)
        SELECT sample_id, 'Staff Place' FROM specimen WHERE field_number = '25000003'`);
      await conn.run(`UPDATE sample SET locality = 'Staff Place'
        WHERE entity_id = (SELECT sample_id FROM specimen WHERE field_number = '25000003')`);
      const again = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
      await writeLegacyExport(conn, again);
      expect(await rows(conn, `SELECT "fieldNumber", locality FROM read_csv('${again}', header = true, all_varchar = true, quote = '"', escape = '"')
                               WHERE "fieldNumber" IN ('25000001', '25000003') ORDER BY 1`)).toEqual([
        ["25000001", "Staff Place"],
        ["25000003", "Staff Place"],
      ]);
    } finally {
      await conn.run(`DELETE FROM sample_locality_override`);
      await conn.run(`UPDATE sample SET locality = ?
        WHERE entity_id = (SELECT sample_id FROM specimen WHERE field_number = '25000003')`, [sampleLocality] as never);
      for (const row of saved) {
        const r = row as Record<string, string | null>;
        await conn.run(`UPDATE legacy_occurrence SET ${fields.map((f) => `"${f}" = ?`).join(", ")} WHERE _id = ?`,
          [...fields.map((f) => r[f]), r._id] as never);
      }
    }
  });

  test("writes the legacy row's subgenus while its determination is the record, and the model's after", async () => {
    // Synthetic, in the shape of 2,427 sandbox records: a species the tree
    // files under its genus, which the legacy determination placed in a subgenus.
    const subgenusOf = async () => {
      const other = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
      await writeLegacyExport(conn, other);
      const [[subgenus]] = (await conn.runAndReadAll(
        `SELECT subgenus FROM read_csv('${other}', header = true, all_varchar = true, quote = '"', escape = '"')
         WHERE "fieldNumber" = '25000001'`,
      )).getRows() as [[string | null]];
      return subgenus;
    };
    const [[saved]] = (await conn.runAndReadAll(`SELECT subgenus FROM legacy_occurrence WHERE "fieldNumber" = '25000001'`)).getRows() as [[string]];
    try {
      await conn.run(`UPDATE legacy_occurrence SET subgenus = 'Pyrobombus' WHERE "fieldNumber" = '25000001'`);
      expect(await subgenusOf()).toBe("Pyrobombus");
      // A newer expert determination, as Ecdysis brings, is the model's to write.
      await conn.run(`INSERT INTO determination (specimen_id, animal_id, verbatim_identification, is_expert, channel, recorded_at)
        SELECT d.specimen_id, d.animal_id, 'Bombus vosnesenskii', true, 'ecdysis_import', d.recorded_at + INTERVAL 1 DAY
        FROM determination d JOIN specimen sp ON sp.entity_id = d.specimen_id
        WHERE sp.field_number = '25000001' AND d.is_expert`);
      expect(await subgenusOf()).toBeNull();
    } finally {
      await conn.run(`DELETE FROM determination WHERE channel = 'ecdysis_import'`);
      await conn.run(`UPDATE legacy_occurrence SET subgenus = ? WHERE "fieldNumber" = '25000001'`, [saved] as never);
    }
  });

  test("writes the legacy row's identification where Beeline holds no expert determination", async () => {
    // As on 88 sandbox records: a determiner named, and no name to determine.
    const [[saved]] = (await conn.runAndReadAll(`SELECT "identifiedBy" FROM legacy_occurrence WHERE "fieldNumber" = '25000003'`)).getRows() as [[string]];
    expect(await rows(conn, `SELECT count(*) FROM determination d JOIN specimen sp ON sp.entity_id = d.specimen_id
                             WHERE sp.field_number = '25000003' AND d.is_expert`)).toEqual([[0n]]);
    try {
      await conn.run(`UPDATE legacy_occurrence SET "identifiedBy" = 'L.R.Best' WHERE "fieldNumber" = '25000003'`);
      const other = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
      await writeLegacyExport(conn, other);
      expect(await rows(conn, `SELECT "identifiedBy" FROM read_csv('${other}', header = true, all_varchar = true, quote = '"', escape = '"')
                               WHERE "fieldNumber" = '25000003'`)).toEqual([["L.R.Best"]]);
    } finally {
      await conn.run(`UPDATE legacy_occurrence SET "identifiedBy" = ? WHERE "fieldNumber" = '25000003'`, [saved] as never);
    }
  });

  test("never writes one coordinate from the legacy row and the other from the model", async () => {
    // Synthetic: no exported row on the sandbox holds half a point (2026-10-04).
    const [[savedLat, savedLon]] = (await conn.runAndReadAll(
      `SELECT "decimalLatitude", "decimalLongitude" FROM legacy_occurrence WHERE "fieldNumber" = '25000003'`,
    )).getRows() as [[string, string]];
    try {
      await conn.run(`UPDATE legacy_occurrence SET "decimalLatitude" = '1.2345', "decimalLongitude" = '' WHERE "fieldNumber" = '25000003'`);
      const other = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
      await writeLegacyExport(conn, other);
      const [[lat, lon]] = (await conn.runAndReadAll(
        `SELECT "decimalLatitude", "decimalLongitude" FROM read_csv('${other}', header = true, all_varchar = true, quote = '"', escape = '"')
         WHERE "fieldNumber" = '25000003'`,
      )).getRows() as [[string, string]];
      const [[modelLat, modelLon]] = (await conn.runAndReadAll(
        `SELECT printf('%.4f', latitude), printf('%.4f', longitude) FROM sample_location
         WHERE sample_id = (SELECT sample_id FROM specimen WHERE field_number = '25000003')`,
      )).getRows() as [[string, string]];
      expect([lat, lon]).toEqual([modelLat, modelLon]);
    } finally {
      await conn.run(`UPDATE legacy_occurrence SET "decimalLatitude" = ?, "decimalLongitude" = ? WHERE "fieldNumber" = '25000003'`,
        [savedLat, savedLon] as never);
    }
  });

  test("writes the initials a label_name gives, as the person's labels do", async () => {
    // Synthetic: the fixture's collector given the shape of a real register
    // override (J.M. for a given name of Juan Manuel).
    // Stray whitespace around it, as an overlay value can carry, is trimmed as
    // the label's JavaScript trim() trims it: a tab, and the two characters
    // RE2's \s and \p{Z} both miss, a vertical tab and U+FEFF.
    await conn.run(`UPDATE person SET label_name = concat(chr(9), chr(11), 'A.B. Collector', chr(65279), chr(9))
                    WHERE display_name = 'Ada Collector'`);
    try {
      const other = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
      await writeLegacyExport(conn, other);
      const rows = (await conn.runAndReadAll(
        `SELECT "fieldNumber", "firstNameInitial" FROM read_csv('${other}', header = true, all_varchar = true, quote = '"', escape = '"')
         WHERE "fieldNumber" IN ('25000001', '25000005') ORDER BY 1`,
      )).getRows();
      expect(rows).toEqual([["25000001", "A.B."], ["25000005", "B. | A.B."]]);
    } finally {
      await conn.run(`UPDATE person SET label_name = NULL WHERE display_name = 'Ada Collector'`);
    }
  });

  test("gives a specimen Beeline created its own identifiers and host, and no legacy residue", async () => {
    const { conn: fresh } = await createMemoryDb();
    await fresh.run(`INSERT INTO person (display_name, given_name, family_name) VALUES ('Cy Newcomer', 'Cy', 'Newcomer')`);
    const sampleId = await insertCleanSample(fresh, {
      inat_observation_id: "123456",
      host_name_as_observed: "'Ericameria nauseosa'",
      host_rank: "'species'",
      protocol: "'aerial net'",
    }, { latitude: "44.123456789", longitude: "-123.987654321", coordinate_uncertainty_m: "8", source: "'inat_trusted'" });
    await fresh.run(
      `INSERT INTO specimen (sample_id, specimen_number, field_number)
       VALUES (${sampleId}, 1, '26090001')`,
    );
    const out = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
    const { staged } = await writeLegacyExport(fresh, out);
    expect(staged).toBe(false);
    const [row] = (
      await fresh.runAndReadAll(`SELECT * FROM read_csv('${out}', header = true, all_varchar = true)`)
    ).getRowObjectsJson() as Record<string, string | null>[];
    expect(row).toMatchObject({
      fieldNumber: "26090001",
      // Beeline mints no occurrenceID (ADR 0008, amended 2026-10-23).
      occurrenceID: null,
      resourceID: null,
      specimenId: "1",
      firstName: "Cy",
      lastName: "Newcomer",
      recordedBy: "Cy Newcomer",
      decimalLatitude: "44.1235",
      decimalLongitude: "-123.9877",
      coordinateUncertaintyInMeters: "8",
      coordinateSource: "private",
      relationshipOfResource: "visits flowers of",
      genusPlant: "Ericameria",
      speciesPlant: "Ericameria nauseosa",
      taxonRankPlant: "species",
      url: "https://www.inaturalist.org/observations/123456",
    });
    expect(row!.dateLabelPrint).toBeNull();
    expect(row!.catalogNumber).toBeNull();
  });

  test("says a trap's plant was near it, not visited, whatever the old record said (beeline-vjqy)", async () => {
    // Synthetic, in the shape of 2000117 on production (2026-11-16): a pan-trap
    // sample whose observation is identified as a plant beside the trap, and
    // whose old record said its bees visited flowers of it.
    const { conn: fresh } = await createMemoryDb();
    await fresh.run(`INSERT INTO person (display_name, given_name, family_name) VALUES ('Cy Newcomer', 'Cy', 'Newcomer')`);
    const sampleId = await insertCleanSample(fresh, {
      inat_observation_id: "123457",
      host_name_as_observed: "'Ceanothus'",
      host_rank: "'genus'",
      protocol: "'pan traps'",
    });
    await fresh.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sampleId}, 1, '26090003')`);
    const out = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
    await writeLegacyExport(fresh, out);
    const [row] = (await fresh.runAndReadAll(`SELECT * FROM read_csv('${out}', header = true, all_varchar = true)`)).getRowObjectsJson() as Record<string, string | null>[];
    expect(row).toMatchObject({ relationshipOfResource: "near", genusPlant: "Ceanothus", taxonRankPlant: "genus" });

    const [[sample]] = (await conn.runAndReadAll(`SELECT sp.sample_id FROM specimen sp WHERE sp.field_number = '25000001'`)).getRows() as [[number]];
    const [[before]] = (await conn.runAndReadAll(`SELECT protocol FROM sample WHERE entity_id = ${sample}`)).getRows() as [[string | null]];
    const [hostBefore] = (await conn.runAndReadAll(
      `SELECT host_inat_taxon_id, host_name_as_observed, host_rank FROM sample WHERE entity_id = ${sample}`,
    )).getRows() as [[bigint | null, string | null, string | null]];
    await conn.run(`CREATE TEMP TABLE trap_test_before AS SELECT * FROM legacy_occurrence WHERE "fieldNumber" IN ('25000001', '25000003', '25000009')`);
    await conn.run(`UPDATE legacy_occurrence SET "samplingProtocol" = 'pan traps', "relationshipOfResource" = 'visits flowers of', "genusPlant" = 'Ceanothus',
                    "speciesPlant" = '', "familyPlant" = '', "orderPlant" = '', "phylumPlant" = '', "taxonRankPlant" = 'genus'
                    WHERE "fieldNumber" IN ('25000001', '25000003', '25000009')`);
    await conn.run(`UPDATE sample SET protocol = 'pan traps' WHERE entity_id = ${sample}`);
    const exported = async () => {
      const path = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
      await writeLegacyExport(conn, path);
      return (await conn.runAndReadAll(
        `SELECT "relationshipOfResource" FROM read_csv('${path}', header = true, all_varchar = true) WHERE "fieldNumber" = '25000001'`,
      )).getRows();
    };
    try {
      expect(await exported()).toEqual([["near"]]);
      // A number there, as the 2026 vane-trap records hold, is not the claim and stays.
      await conn.run(`UPDATE legacy_occurrence SET "relationshipOfResource" = '10' WHERE "fieldNumber" = '25000001'`);
      expect(await exported()).toEqual([["10"]]);
      // The plant is the sample's host, whatever plant the old records of the sample name when they agree.
      await conn.run(`UPDATE legacy_occurrence SET "relationshipOfResource" = 'visits flowers of', "genusPlant" = '', "speciesPlant" = '',
                        "familyPlant" = '', "orderPlant" = 'Rosales', "phylumPlant" = '' WHERE "fieldNumber" IN ('25000001', '25000003', '25000009')`);
      expect(await exported()).toEqual([["near"]]);
      // And where the sample has no host there is nothing to be near, whatever the old record names.
      await conn.run(`UPDATE legacy_occurrence SET "relationshipOfResource" = '', "orderPlant" = 'Rosales' WHERE "fieldNumber" IN ('25000001', '25000003', '25000009')`);
      await conn.run(`UPDATE sample SET host_inat_taxon_id = NULL, host_name_as_observed = NULL, host_rank = NULL WHERE entity_id = ${sample}`);
      expect(await exported()).toEqual([[null]]);
    } finally {
      await conn.run(`UPDATE sample SET host_inat_taxon_id = ${hostBefore![0] === null ? "NULL" : hostBefore![0]},
                        host_name_as_observed = ${hostBefore![1] === null ? "NULL" : `'${hostBefore![1]}'`},
                        host_rank = ${hostBefore![2] === null ? "NULL" : `'${hostBefore![2]}'`} WHERE entity_id = ${sample}`);
      await conn.run(`UPDATE sample SET protocol = ${before === null ? "NULL" : `'${before}'`} WHERE entity_id = ${sample}`);
      await conn.run(`UPDATE legacy_occurrence o SET "samplingProtocol" = b."samplingProtocol", "relationshipOfResource" = b."relationshipOfResource",
                        "genusPlant" = b."genusPlant", "speciesPlant" = b."speciesPlant", "familyPlant" = b."familyPlant",
                        "orderPlant" = b."orderPlant", "phylumPlant" = b."phylumPlant", "taxonRankPlant" = b."taxonRankPlant"
                      FROM trap_test_before b WHERE o._id = b._id`);
      await conn.run(`DROP TABLE trap_test_before`);
    }
  });

  test("writes coordinates to four places and sorts as the reference's composite_sort does", async () => {
    const { conn: fresh } = await createMemoryDb();
    await fresh.run(`INSERT INTO person (display_name, given_name, family_name) VALUES ('Cy Newcomer', 'Cy', 'Newcomer')`);
    const sampleId = await insertCleanSample(fresh, {}, { latitude: "44.5", longitude: "-123", source: "'inat_public'" });
    // A number sorts by its value, padded; a blank or a non-number (the E and
    // Name: eras) sorts after every number, and then by name, date and sample.
    for (const [n, fn] of [[1, "'E2332481'"], [2, "NULL"], [3, "'26090002'"], [4, "'9'"], [5, "'26090001'"]] as const) {
      await fresh.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sampleId}, ${n}, ${fn})`);
    }
    const out = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
    await writeLegacyExport(fresh, out);
    const got = (
      await fresh.runAndReadAll(`SELECT "fieldNumber", "specimenId", "decimalLatitude", "decimalLongitude", "coordinateSource"
                                 FROM read_csv('${out}', header = true, all_varchar = true)`)
    ).getRowObjectsJson() as Record<string, string | null>[];
    expect(got.map((r) => r.fieldNumber)).toEqual(["9", "26090001", "26090002", "E2332481", null]);
    expect(got[0]).toMatchObject({ decimalLatitude: "44.5000", decimalLongitude: "-123.0000", coordinateSource: "public" });
  });

  test("carries the old record's sex only where it names an expert identification (beeline-eznn)", async () => {
    // From 2023 the old Beeline wrote "male" on records nobody had identified,
    // as an entry default: 24,434 of them on the production store of
    // 2026-11-15, and experts in Ecdysis found half of those bees female.
    const [[sex, caste, genus, family, epithet, name]] = (await conn.runAndReadAll(
      `SELECT sex, caste, genus, family, "specificEpithet", "scientificName" FROM legacy_occurrence WHERE "fieldNumber" = '25000003'`,
    )).getRows() as [[string, string, string, string, string, string]];
    expect(await rows(conn, `SELECT count(*) FROM determination d JOIN specimen sp ON sp.entity_id = d.specimen_id
                             WHERE sp.field_number = '25000003' AND d.is_expert`)).toEqual([[0n]]);
    const sexOf = async () => {
      const out = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
      await writeLegacyExport(conn, out);
      return rows(conn, `SELECT sex, caste FROM read_csv('${out}', header = true, all_varchar = true, quote = '"', escape = '"')
                         WHERE "fieldNumber" = '25000003'`);
    };
    try {
      await conn.run(`UPDATE legacy_occurrence SET sex = 'male', caste = 'drone', genus = '', family = '', "specificEpithet" = '', "scientificName" = ''
                      WHERE "fieldNumber" = '25000003'`);
      expect(await sexOf()).toEqual([[null, null]]);
      // Where the old record names the bee, its sex is the expert's and stays.
      await conn.run(`UPDATE legacy_occurrence SET genus = 'Bombus' WHERE "fieldNumber" = '25000003'`);
      expect(await sexOf()).toEqual([["male", "drone"]]);
    } finally {
      await conn.run(
        `UPDATE legacy_occurrence SET sex = ?, caste = ?, genus = ?, family = ?, "specificEpithet" = ?, "scientificName" = ? WHERE "fieldNumber" = '25000003'`,
        [sex, caste, genus, family, epithet, name] as never,
      );
    }
  });

  test("keeps the sex an earlier determination stated when a newer one, as from Ecdysis, states none", async () => {
    await conn.run(`
      INSERT INTO determination (specimen_id, animal_id, verbatim_identification, determiner_name, is_expert, channel, recorded_at)
      SELECT sp.entity_id, d.animal_id, 'Bombus vosnesenskii', 'Someone Newer', true, 'ecdysis_import', now()
      FROM specimen sp JOIN determination d ON d.specimen_id = sp.entity_id
      WHERE sp.field_number = '25000001' LIMIT 1`);
    const out = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
    await writeLegacyExport(conn, out);
    const [row] = (
      await conn.runAndReadAll(`SELECT "sex", "identifiedBy" FROM read_csv('${out}', header = true, all_varchar = true) WHERE "fieldNumber" = '25000001'`)
    ).getRowObjectsJson();
    expect(row).toEqual({ sex: "female", identifiedBy: "Someone Newer" });
  });

  test("keeps the legacy row's coordinateSource for a point Beeline has not replaced", async () => {
    await conn.run(`UPDATE legacy_occurrence SET "coordinateSource" = 'private' WHERE "fieldNumber" = '25000001'`);
    await conn.run(`UPDATE sample_location SET source = 'legacy_import'`);
    const out = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
    await writeLegacyExport(conn, out);
    const [row] = (
      await conn.runAndReadAll(`SELECT "coordinateSource" FROM read_csv('${out}', header = true, all_varchar = true) WHERE "fieldNumber" = '25000001'`)
    ).getRowObjectsJson();
    expect(row).toEqual({ coordinateSource: "private" });
  });
});

describe("the plant: the sample's floral host as the store holds it (beeline-qpys)", () => {
  const TRACHEOPHYTA = 211194;
  // A small lineage, names a plant's own: [id, name, rank, ancestors outermost first].
  const TAXA: [number, string, string, number[]][] = [
    [TRACHEOPHYTA, "Tracheophyta", "phylum", []],
    [701, "Boraginales", "order", [TRACHEOPHYTA]],
    [702, "Boraginaceae", "family", [TRACHEOPHYTA, 701]],
    [703, "Nemophila", "genus", [TRACHEOPHYTA, 701, 702]],
    [704, "Nemophila menziesii", "species", [TRACHEOPHYTA, 701, 702, 703]],
    [705, "Nemophila menziesii atomaria", "variety", [TRACHEOPHYTA, 701, 702, 703, 704]],
    [711, "Asterales", "order", [TRACHEOPHYTA]],
    [712, "Asteraceae", "family", [TRACHEOPHYTA, 711]],
    [713, "Astereae", "tribe", [TRACHEOPHYTA, 711, 712]],
    [714, "Ericameria", "genus", [TRACHEOPHYTA, 711, 712, 713]],
    [715, "Ericameria nauseosa", "species", [TRACHEOPHYTA, 711, 712, 713, 714]],
    [721, "Caryophyllales", "order", [TRACHEOPHYTA]],
    [722, "Montiaceae", "family", [TRACHEOPHYTA, 721]],
    [723, "Claytonia", "genus", [TRACHEOPHYTA, 721, 722]],
    [724, "Limnia", "section", [TRACHEOPHYTA, 721, 722, 723]],
    [731, "Lamiales", "order", [TRACHEOPHYTA]],
    [732, "Oleaceae", "family", [TRACHEOPHYTA, 731]],
    [733, "Osmanthus", "genus", [TRACHEOPHYTA, 731, 732]],
    [734, "Osmanthus × burkwoodii", "hybrid", [TRACHEOPHYTA, 731, 732, 733]],
  ];
  const PLANT_COLUMNS = ["taxonRankPlant", "genusPlant", "speciesPlant", "familyPlant", "orderPlant", "phylumPlant", "relationshipOfResource"] as const;

  let c: DuckDBConnection;
  let sampleId: number;

  beforeEach(async () => {
    ({ conn: c } = await promotedStore("occurrences"));
    for (const [id, name, rank, above] of TAXA) {
      await c.run(`INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active) VALUES (${id}, '${name}', '${rank}', 10, true)`);
      for (const [d, a] of [...above].reverse().entries()) await c.run(`INSERT INTO inat_taxon_ancestor VALUES (${id}, ${a}, ${d + 1})`);
      await c.run(`INSERT INTO inat_taxon_ancestor VALUES (${id}, ${id}, 0)`);
    }
    const [[id]] = (await rows(c, `SELECT sample_id FROM specimen WHERE field_number = '25000001'`)) as [[number]];
    sampleId = Number(id);
    // The old records of this sample name one plant, so that it is the sample's host the file writes: where they
    // name different plants each row keeps its own, which is the next group of tests.
    await c.run(`UPDATE legacy_occurrence o SET "genusPlant" = b."genusPlant", "speciesPlant" = b."speciesPlant", "familyPlant" = b."familyPlant",
                   "orderPlant" = b."orderPlant", "phylumPlant" = b."phylumPlant", "taxonRankPlant" = b."taxonRankPlant",
                   "relationshipOfResource" = b."relationshipOfResource"
                 FROM legacy_occurrence b WHERE o."fieldNumber" IN ('25000003', '25000009') AND b."fieldNumber" = '25000001'`);
  });

  const setHost = (id: number | null, name: string | null, rank: string | null) =>
    c.run(`UPDATE sample SET host_inat_taxon_id = ${id ?? "NULL"}, host_name_as_observed = ${name === null ? "NULL" : `'${name}'`},
                  host_rank = ${rank === null ? "NULL" : `'${rank}'`} WHERE entity_id = ${sampleId}`);

  async function rowOf(fieldNumber: string): Promise<Record<string, string>> {
    const out = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
    await writeLegacyExport(c, out);
    const all = (await c.runAndReadAll(`SELECT * FROM read_csv('${out}', header = true, all_varchar = true)`)).getRowObjectsJson();
    const row = all.find((r) => r.fieldNumber === fieldNumber)!;
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, (v as string | null) ?? ""]));
  }
  const plantOf = async (fieldNumber: string) => {
    const row = await rowOf(fieldNumber);
    return Object.fromEntries(PLANT_COLUMNS.map((k) => [k, row[k]]));
  };

  const ERICAMERIA = {
    taxonRankPlant: "species", genusPlant: "Ericameria", speciesPlant: "Ericameria nauseosa",
    familyPlant: "Asteraceae", orderPlant: "Asterales", phylumPlant: "Tracheophyta", relationshipOfResource: "visits flowers of",
  };

  test("writes the sample's host to a specimen old Beeline held, not the plant its record named, with the lineage from the taxon cache", async () => {
    // The old record of 25000001 names Salvia officinalis, in Lamiaceae.
    expect((await rowOf("25000001")).genusPlant).toBe("Salvia");
    await setHost(715, "Ericameria nauseosa", "species");
    expect(await plantOf("25000001")).toEqual(ERICAMERIA);
    // So is it for 25000003 of the same sample, whose old record is aligned with the first's in beforeEach.
    expect(await plantOf("25000003")).toEqual(ERICAMERIA);
  });

  test("writes a host that followed its observation", async () => {
    await c.run(`UPDATE sample SET inat_observation_id = 777 WHERE entity_id = ${sampleId}`);
    await c.run(
      `INSERT INTO observation_field (inat_id, user_id, host_taxon_id, host_taxon_name, host_taxon_rank, host_is_tracheophyte)
       VALUES (777, 1, 715, 'Ericameria nauseosa', 'species', true)`,
    );
    // The follow rule's own statement, as ingest/mint-samples.sql runs it on every promotion.
    const mint = await readFile(new URL("../ingest/mint-samples.sql", import.meta.url), "utf8");
    const followRule = mint.slice(mint.indexOf("UPDATE sample SET\n  host_inat_taxon_id    = f.host_taxon_id"));
    await c.run(followRule.slice(0, followRule.indexOf(";") + 1));
    expect(await plantOf("25000001")).toEqual(ERICAMERIA);
  });

  test("writes a host staff set, with the lineage of the taxon they gave, and no old plant", async () => {
    await c.run(`INSERT INTO person (display_name) VALUES ('Sam Staff')`);
    await c.run(`INSERT INTO inat_account (person_id, inat_user_id, login) SELECT entity_id, 3, 'samstaff' FROM person WHERE display_name = 'Sam Staff'`);
    const [[legacyId]] = (await rows(c, `SELECT min(_id) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[string]];
    await applySampleOverlay(c, [{
      sample_ref: `legacy:${legacyId}`, field: "host", base_value: "", value: "704 species Nemophila menziesii",
      author: "samstaff", reason: "the bees are on the baby blue eyes",
    }]);
    expect(await plantOf("25000001")).toEqual({
      taxonRankPlant: "species", genusPlant: "Nemophila", speciesPlant: "Nemophila menziesii",
      familyPlant: "Boraginaceae", orderPlant: "Boraginales", phylumPlant: "Tracheophyta", relationshipOfResource: "visits flowers of",
    });
  });

  test.each([
    ["genus", 703, "Nemophila", { genusPlant: "Nemophila", speciesPlant: "", familyPlant: "Boraginaceae", orderPlant: "Boraginales" }],
    // A family names no genus and a species, and keeps its family, order and phylum.
    ["family", 702, "Boraginaceae", { genusPlant: "", speciesPlant: "", familyPlant: "Boraginaceae", orderPlant: "Boraginales" }],
    ["tribe", 713, "Astereae", { genusPlant: "", speciesPlant: "", familyPlant: "Asteraceae", orderPlant: "Asterales" }],
    // A section is below a genus the lineage names, so it has one.
    ["section", 724, "Limnia", { genusPlant: "Claytonia", speciesPlant: "", familyPlant: "Montiaceae", orderPlant: "Caryophyllales" }],
    // A variety is written as iNaturalist names it, with no rank marker.
    ["variety", 705, "Nemophila menziesii atomaria", {
      genusPlant: "Nemophila", speciesPlant: "Nemophila menziesii atomaria", familyPlant: "Boraginaceae", orderPlant: "Boraginales",
    }],
    ["hybrid", 734, "Osmanthus × burkwoodii", {
      genusPlant: "Osmanthus", speciesPlant: "Osmanthus × burkwoodii", familyPlant: "Oleaceae", orderPlant: "Lamiales",
    }],
  ] as const)("writes a host at %s rank as old Beeline wrote it", async (rank, id, name, expected) => {
    await setHost(id, name, rank);
    expect(await plantOf("25000003")).toEqual({
      taxonRankPlant: rank, phylumPlant: "Tracheophyta", relationshipOfResource: "visits flowers of", ...expected,
    });
  });

  // The old rows of one sample, and a host that is no improvement on them (Peter, 2026-11-21): a record stays
  // faithful to its old record unless the sample's data and judgment improve it.
  const NEMOPHILA = {
    taxonRankPlant: "species", genusPlant: "Nemophila", speciesPlant: "Nemophila menziesii",
    familyPlant: "Boraginaceae", orderPlant: "Boraginales", phylumPlant: "Tracheophyta", relationshipOfResource: "near",
  };
  const SALVIA = {
    taxonRankPlant: "species", genusPlant: "Salvia", speciesPlant: "Salvia officinalis",
    familyPlant: "Lamiaceae", orderPlant: "Lamiales", phylumPlant: "Tracheophyta", relationshipOfResource: "",
  };
  // 25000003 names another plant than 25000001 and 25000009, which name Salvia officinalis.
  const nameNemophilaOn3 = () =>
    c.run(`UPDATE legacy_occurrence SET "genusPlant" = 'Nemophila', "speciesPlant" = 'Nemophila menziesii', "familyPlant" = 'Boraginaceae',
             "orderPlant" = 'Boraginales', "phylumPlant" = 'Tracheophyta', "taxonRankPlant" = 'species', "relationshipOfResource" = 'near'
           WHERE "fieldNumber" = '25000003'`);

  test("writes each old row's own plant and relationship where the rows of a sample name different plants", async () => {
    await setHost(715, "Ericameria nauseosa", "species");
    await nameNemophilaOn3();
    expect(await plantOf("25000003")).toEqual(NEMOPHILA);
    // Its sibling's old record says nothing of how the bees came to the plant, and the file says nothing either.
    expect(await plantOf("25000001")).toEqual(SALVIA);
    expect(await plantOf("25000009")).toEqual(SALVIA);
  });

  test("writes no plant for an old row that names none, where the other rows of the sample name one", async () => {
    await setHost(715, "Ericameria nauseosa", "species");
    await c.run(`UPDATE legacy_occurrence SET "genusPlant" = '', "speciesPlant" = '', "familyPlant" = '', "orderPlant" = '', "phylumPlant" = '',
                   "taxonRankPlant" = '', "relationshipOfResource" = '' WHERE "fieldNumber" = '25000003'`);
    expect(await plantOf("25000003")).toEqual({
      taxonRankPlant: "", genusPlant: "", speciesPlant: "", familyPlant: "", orderPlant: "", phylumPlant: "", relationshipOfResource: "",
    });
    expect((await plantOf("25000001")).genusPlant).toBe("Salvia");
  });

  test("writes a host staff set to every row of the sample, whatever plants the old rows name", async () => {
    await nameNemophilaOn3();
    await c.run(`INSERT INTO person (display_name) VALUES ('Sam Staff')`);
    await c.run(`INSERT INTO inat_account (person_id, inat_user_id, login) SELECT entity_id, 3, 'samstaff' FROM person WHERE display_name = 'Sam Staff'`);
    const [[legacyId]] = (await rows(c, `SELECT min(_id) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[string]];
    await applySampleOverlay(c, [{
      sample_ref: `legacy:${legacyId}`, field: "host", base_value: "", value: "715 species Ericameria nauseosa",
      author: "samstaff", reason: "the bees are on the rabbitbrush",
    }]);
    expect(await plantOf("25000001")).toEqual(ERICAMERIA);
    // The relationship is the old record's own, which the rule for a stated one keeps.
    expect(await plantOf("25000003")).toEqual({ ...ERICAMERIA, relationshipOfResource: "near" });
  });

  test("keeps the host that follows the sample's observation, whatever plants the old rows name", async () => {
    await nameNemophilaOn3();
    await c.run(`UPDATE sample SET inat_observation_id = 777 WHERE entity_id = ${sampleId}`);
    await c.run(
      `INSERT INTO observation_field (inat_id, user_id, host_taxon_id, host_taxon_name, host_taxon_rank, host_is_tracheophyte)
       VALUES (777, 1, 715, 'Ericameria nauseosa', 'species', true)`,
    );
    await c.run(`UPDATE sample SET host_inat_taxon_id = 715, host_name_as_observed = 'Ericameria nauseosa', host_rank = 'species' WHERE entity_id = ${sampleId}`);
    expect(await plantOf("25000003")).toEqual({ ...ERICAMERIA, relationshipOfResource: "near" });
  });

  test("does not take two spellings of one plant's lineage for a disagreement", async () => {
    await setHost(715, "Ericameria nauseosa", "species");
    // Salvia officinalis in the species column beside its genus, and as the whole name in the genus column.
    await c.run(`UPDATE legacy_occurrence SET "genusPlant" = ' Salvia officinalis', "speciesPlant" = '' WHERE "fieldNumber" = '25000003'`);
    expect(await plantOf("25000003")).toEqual(ERICAMERIA);
    expect(await plantOf("25000001")).toEqual(ERICAMERIA);
  });

  // Where the sample's host does not follow an observation and the store holds the old record's plant less exactly.
  const oldNamesAsteraceae = (rank: string) =>
    c.run(`UPDATE legacy_occurrence SET "genusPlant" = '', "speciesPlant" = '', "familyPlant" = 'Asteraceae', "orderPlant" = 'Compositales',
             "phylumPlant" = 'Tracheophyta', "taxonRankPlant" = '${rank}', "relationshipOfResource" = 'visits flowers of'`);

  test("writes the old record's plant where it names a tribe and the sample holds the family", async () => {
    await oldNamesAsteraceae("tribe");
    await setHost(712, "Asteraceae", "family");
    const expected = {
      taxonRankPlant: "tribe", genusPlant: "", speciesPlant: "", familyPlant: "Asteraceae", orderPlant: "Compositales",
      phylumPlant: "Tracheophyta", relationshipOfResource: "visits flowers of",
    };
    expect(await plantOf("25000001")).toEqual(expected);
    // Also where the sample has an observation that gives the host no plant: the host is what the import stated.
    await c.run(`UPDATE sample SET inat_observation_id = 778 WHERE entity_id = ${sampleId}`);
    expect(await plantOf("25000003")).toEqual(expected);
  });

  test("writes the old record's plant where it names a hybrid and the sample holds a species", async () => {
    await c.run(`UPDATE legacy_occurrence SET "genusPlant" = 'Osmanthus', "speciesPlant" = 'Osmanthus × burkwoodii', "familyPlant" = 'Oleaceae',
                   "orderPlant" = 'Lamiales', "phylumPlant" = 'Tracheophyta', "taxonRankPlant" = 'hybrid', "relationshipOfResource" = 'visits flowers of'`);
    await setHost(null, "Osmanthus × burkwoodii", "species");
    expect((await plantOf("25000001")).taxonRankPlant).toBe("hybrid");
  });

  test("writes the old record's rank where it names a suborder and the sample holds the order", async () => {
    await c.run(`UPDATE legacy_occurrence SET "genusPlant" = '', "speciesPlant" = '', "familyPlant" = '', "orderPlant" = 'Asterales',
                   "phylumPlant" = 'Tracheophyta', "taxonRankPlant" = 'suborder', "relationshipOfResource" = 'visits flowers of'`);
    await setHost(711, "Asterales", "order");
    expect((await plantOf("25000001")).taxonRankPlant).toBe("suborder");
  });

  test("reads a tab or a run of spaces inside the old record's plant name as one space", async () => {
    await setHost(null, "Salvia officinalis", "species");
    await c.run(`UPDATE legacy_occurrence SET "genusPlant" = 'Salvia', "speciesPlant" = 'Salvia\tofficinalis', "familyPlant" = 'Oldfamily'
                 WHERE "fieldNumber" = '25000001'`);
    // The same plant, so the old family stands in where the cache cannot give the lineage.
    expect((await plantOf("25000001")).familyPlant).toBe("Oldfamily");
  });

  test("keeps the store's rank where the old record's is a dash or blank, and where a host staff set is the same plant", async () => {
    await oldNamesAsteraceae("-");
    await setHost(712, "Asteraceae", "family");
    expect(await plantOf("25000001")).toEqual({
      taxonRankPlant: "family", genusPlant: "", speciesPlant: "", familyPlant: "Asteraceae", orderPlant: "Asterales",
      phylumPlant: "Tracheophyta", relationshipOfResource: "visits flowers of",
    });
    await oldNamesAsteraceae("tribe");
    await c.run(`INSERT INTO person (display_name) VALUES ('Sam Staff')`);
    await c.run(`INSERT INTO inat_account (person_id, inat_user_id, login) SELECT entity_id, 3, 'samstaff' FROM person WHERE display_name = 'Sam Staff'`);
    const [[legacyId]] = (await rows(c, `SELECT min(_id) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[string]];
    await applySampleOverlay(c, [{
      sample_ref: `legacy:${legacyId}`, field: "host", base_value: "", value: "712 family Asteraceae",
      author: "samstaff", reason: "the family is as exact as it gets",
    }]);
    expect((await plantOf("25000001")).taxonRankPlant).toBe("family");
  });

  test("takes the old record's family, order and phylum only where it names the same plant and the cache cannot give the lineage", async () => {
    // The old record of 25000001 names Salvia officinalis, in Lamiaceae, Lamiales and Tracheophyta; the cache holds
    // neither the sample's plant nor anything above it.
    await setHost(null, "Salvia officinalis", "species");
    expect(await plantOf("25000001")).toEqual({
      taxonRankPlant: "species", genusPlant: "Salvia", speciesPlant: "Salvia officinalis",
      familyPlant: "Lamiaceae", orderPlant: "Lamiales", phylumPlant: "Tracheophyta", relationshipOfResource: "visits flowers of",
    });
    // Another plant: never its genus beside the old record's family.
    await setHost(null, "Salvia pratensis", "species");
    expect(await plantOf("25000001")).toEqual({
      taxonRankPlant: "species", genusPlant: "Salvia", speciesPlant: "Salvia pratensis",
      familyPlant: "", orderPlant: "", phylumPlant: "", relationshipOfResource: "visits flowers of",
    });
    // A taxon the cache has not read yet is the same: the plant is its name, and nothing is known above it.
    await setHost(999999, "Salvia officinalis", "species");
    expect((await plantOf("25000001")).familyPlant).toBe("Lamiaceae");
    await setHost(999999, "Salvia pratensis", "species");
    expect((await plantOf("25000001")).familyPlant).toBe("");
    // A taxon the cache holds, with an ancestor it has not read, gives no lineage either, never half of one.
    await c.run(`DELETE FROM inat_taxon WHERE inat_taxon_id = 712`);
    await setHost(715, "Ericameria nauseosa", "species");
    expect(await plantOf("25000001")).toMatchObject({ genusPlant: "Ericameria", familyPlant: "", orderPlant: "", phylumPlant: "" });
  });

  test("where the lineage is known it wins over an old record naming the same plant", async () => {
    await c.run(`UPDATE legacy_occurrence SET "familyPlant" = 'Compositae' WHERE "fieldNumber" = '25000001'`);
    await c.run(`UPDATE legacy_occurrence SET "genusPlant" = 'Ericameria', "speciesPlant" = 'Ericameria nauseosa' WHERE "fieldNumber" = '25000001'`);
    await setHost(715, "Ericameria nauseosa", "species");
    expect((await plantOf("25000001")).familyPlant).toBe("Asteraceae");
  });

  test("writes no plant where the sample has none, whatever the old record names, and keeps the old record's own relationship", async () => {
    await setHost(null, null, null);
    // 25000001's old record names Salvia officinalis and says nothing of how the bees came to it.
    expect(await plantOf("25000001")).toEqual({
      taxonRankPlant: "", genusPlant: "", speciesPlant: "", familyPlant: "", orderPlant: "", phylumPlant: "", relationshipOfResource: "",
    });
    // A claim of a visit, or of a plant near the trap, with no plant to claim it of: blank. Any other value is the old record's own.
    await c.run(`UPDATE legacy_occurrence SET "relationshipOfResource" = 'visits flowers of' WHERE "fieldNumber" = '25000001'`);
    expect((await plantOf("25000001")).relationshipOfResource).toBe("");
    await c.run(`UPDATE legacy_occurrence SET "relationshipOfResource" = ' near ' WHERE "fieldNumber" = '25000001'`);
    expect((await plantOf("25000001")).relationshipOfResource).toBe("");
    await c.run(`UPDATE legacy_occurrence SET "relationshipOfResource" = '10' WHERE "fieldNumber" = '25000001'`);
    expect((await plantOf("25000001")).relationshipOfResource).toBe("10");
  });

  test("writes a replaced taxon's old name beside today's family", async () => {
    await c.run(`INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active) VALUES
      (750, 'Mahonia aquifolium', 'species', 10, false), (751, 'Berberis aquifolium', 'species', 10, true),
      (752, 'Berberidaceae', 'family', 30, true), (753, 'Ranunculales', 'order', 40, true), (754, 'Berberis', 'genus', 20, true)`);
    await c.run(`INSERT INTO inat_taxon_ancestor VALUES (751, ${TRACHEOPHYTA}, 4), (751, 753, 3), (751, 752, 2), (751, 754, 1), (751, 751, 0),
      (752, ${TRACHEOPHYTA}, 2), (752, 753, 1), (752, 752, 0), (753, ${TRACHEOPHYTA}, 1), (753, 753, 0), (754, ${TRACHEOPHYTA}, 3), (754, 753, 2), (754, 752, 1), (754, 754, 0),
      (750, 750, 0)`);
    await c.run(`INSERT INTO inat_taxon_replacement VALUES (750, 751)`);
    await setHost(750, "Mahonia aquifolium", "species");
    expect(await plantOf("25000001")).toEqual({
      taxonRankPlant: "species", genusPlant: "Mahonia", speciesPlant: "Mahonia aquifolium",
      familyPlant: "Berberidaceae", orderPlant: "Ranunculales", phylumPlant: "Tracheophyta", relationshipOfResource: "visits flowers of",
    });
  });

  test("writes the lineage of a host with no id that resolves by its name", async () => {
    await setHost(null, "Ericameria nauseosa", "species");
    await c.run(`INSERT INTO host_name_taxon_cache (host_name, inat_taxon_id) VALUES ('Ericameria nauseosa', 715)`);
    // The old record of 25000001 names Salvia: the lineage is the host's, and nothing of the old record's.
    expect(await plantOf("25000001")).toEqual(ERICAMERIA);
  });

  test("ignores spaces around the old record's genus and species when it names the same plant", async () => {
    await setHost(null, "Salvia officinalis", "species");
    await c.run(`UPDATE legacy_occurrence SET "genusPlant" = ' Salvia ', "speciesPlant" = 'officinalis ' WHERE "fieldNumber" = '25000001'`);
    expect((await plantOf("25000001")).familyPlant).toBe("Lamiaceae");
  });

  test("says what a specimen with no old record is told where the old record's relationship is blank, and keeps one that is not", async () => {
    await setHost(715, "Ericameria nauseosa", "species");
    expect((await plantOf("25000001")).relationshipOfResource).toBe("visits flowers of");
    await c.run(`UPDATE legacy_occurrence SET "relationshipOfResource" = '10' WHERE "fieldNumber" = '25000001'`);
    expect((await plantOf("25000001")).relationshipOfResource).toBe("10");
  });
});

describe("the Exports page", () => {
  beforeEach(freshStore);

  const inat = {
    authorizeUrl: () => "unused",
    exchangeCode: () => Promise.reject(new Error("not under test")),
    identity: () => Promise.reject(new Error("not under test")),
  };
  const appWith = async (admin: boolean, exportsDir: string) => {
    const { instance, conn: c } = await createMemoryDb();
    await c.run(`INSERT INTO person (entity_id, display_name) VALUES (1, 'A Person')`);
    if (admin) await c.run(`INSERT INTO person_admin (person_id) VALUES (1)`);
    return createApp({
      ...(await scratchPaths()),
      db: createKysely(instance),
      config: { environment: "sandbox", origin: "https://beeline.example", exportsDir },
      inat,
      resolveSession: async () => ({ personId: 1, login: "someone", iconUrl: null }),
      jobs: { list: [], start: async () => true },
    });
  };

  test("is for staff only: it carries names and true coordinates", async () => {
    const app = await appWith(false, "unused");
    expect((await app.request("/exports")).status).toBe(403);
    expect((await app.request("/exports/occurrences.csv")).status).toBe(403);
  });

  test("says when nothing has been written yet, and serves the file once it has", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exports-"));
    const app = await appWith(true, dir);
    expect(await (await app.request("/exports")).text()).toContain("Not written yet");
    expect((await app.request("/exports/occurrences.csv")).status).toBe(404);

    await writeLegacyExport(conn, join(dir, "occurrences.csv"));
    const pageHtml = await (await app.request("/exports")).text();
    expect(pageHtml).toContain(`href="/exports/occurrences.csv"`);
    const res = await app.request("/exports/occurrences.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="occurrences_beeline_\d{4}-\d\d-\d\dT\d\d\.\d\d\.\d\d\.csv"$/);
    expect(Buffer.from(await res.arrayBuffer()).equals(await readFile(join(dir, "occurrences.csv")))).toBe(true);
  });
});

describe("writing the export", () => {
  beforeEach(freshStore);

  test("leaves the instance's thread count as it found it", async () => {
    // The CLI, which used to run on the machine's two and outgrew the budget (beeline-1w2d).
    await conn.run("SET threads = 2");
    await writeLegacyExport(conn, join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv"));
    const [[threads]] = (await (await conn.run(`SELECT current_setting('threads')`)).getRows()) as [[bigint]];
    expect(Number(threads)).toBe(2);
  });

  test("leaves no table behind for the rows it sorted", async () => {
    // The app's shared connection runs it, so a temporary table would outlive the job.
    await writeLegacyExport(conn, join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv"));
    const [[left]] = (await (
      await conn.run(`SELECT count(*) FROM duckdb_tables() WHERE table_name = 'legacy_export_rows'`)
    ).getRows()) as [[bigint]];
    expect(Number(left)).toBe(0);
  });
});

describe("the legacy-export job", () => {
  beforeEach(freshStore);

  test("writes the file on one thread and puts the instance's thread count back", async () => {
    const { buildJobs } = await import("../src/app/jobs/registry.js");
    const { runJob } = await import("../src/app/jobs/framework.js");
    const dir = await mkdtemp(join(tmpdir(), "exports-job-"));
    const job = buildJobs({
      syncProjects: [],
      sweepDays: 365,
      personChangesPath: "unused",
      sampleChangesPath: "unused",
      sampleStatePath: "unused",
      exportsDir: dir,
    }).find((j) => j.name === "legacy-export")!;
    await conn.run("SET threads = 3");
    const { instance } = await createMemoryDb();
    await runJob({ db: createKysely(instance), conn }, job);
    const [[threads]] = (await (await conn.run(`SELECT current_setting('threads')`)).getRows()) as [[bigint]];
    expect(Number(threads)).toBe(3);
    expect((await readFile(join(dir, "occurrences.csv"))).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});
