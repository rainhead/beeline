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
