import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { LEGACY_EXPORT_COLUMNS, writeLegacyExport } from "../src/legacy-export.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { createMemoryDb, FIXTURE_INPUTS, insertCleanSample, rows } from "./helpers.js";
import { createKysely } from "../src/db.js";
import { createApp } from "../src/app/server.js";

const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;

let conn: DuckDBConnection;
let path: string;
let bytes: Buffer;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await loadLegacyStaging(conn, FIXTURE);
  await promoteLegacy(conn, FIXTURE_INPUTS);
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
  test("opens with a byte order mark and the legacy header, in order", () => {
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const header = bytes.subarray(3).toString("utf8").split("\n")[0];
    expect(header).toBe(LEGACY_EXPORT_COLUMNS.join(","));
    expect(LEGACY_EXPORT_COLUMNS).toHaveLength(63);
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
      relationshipOfResource: "",
      specimenId: "1",
    });
    // A blank plant in the legacy record stays blank, though the sample now names a host.
    expect(byNumber.get("25000003")).toMatchObject({ speciesPlant: "", genusPlant: "" });
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
      `INSERT INTO specimen (sample_id, specimen_number, field_number, occurrence_id)
       VALUES (${sampleId}, 1, '26090001', '0192f2a0-0000-7000-8000-000000000001')`,
    );
    const out = join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv");
    const { staged } = await writeLegacyExport(fresh, out);
    expect(staged).toBe(false);
    const [row] = (
      await fresh.runAndReadAll(`SELECT * FROM read_csv('${out}', header = true, all_varchar = true)`)
    ).getRowObjectsJson() as Record<string, string | null>[];
    expect(row).toMatchObject({
      fieldNumber: "26090001",
      occurrenceID: "0192f2a0-0000-7000-8000-000000000001",
      resourceID: "0192f2a0-0000-7000-8000-000000000001",
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

describe("the Exports page", () => {
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
      db: createKysely(instance),
      config: { environment: "sandbox", origin: "https://beeline.example", exportsDir },
      inat,
      resolveSession: async () => ({ personId: 1, login: "someone", iconUrl: null }),
      jobs: { list: [], runNow: async () => true },
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
  test("leaves the instance's thread count as it found it", async () => {
    // The CLI, which used to run on the machine's two and outgrew the budget (beeline-1w2d).
    await conn.run("SET threads = 2");
    await writeLegacyExport(conn, join(await mkdtemp(join(tmpdir(), "legacy-export-")), "occurrences.csv"));
    const [[threads]] = (await (await conn.run(`SELECT current_setting('threads')`)).getRows()) as [[bigint]];
    expect(Number(threads)).toBe(2);
  });
});

describe("the legacy-export job", () => {
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
