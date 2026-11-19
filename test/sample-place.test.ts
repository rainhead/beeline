import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { Kysely } from "kysely";
import { createKysely } from "../src/db.js";
import { compareLegacyExport, writeDifferences } from "../src/compare-legacy-export.js";
import { AREA_RULE_VERSION } from "../src/derive-area.js";
import { parseCsv } from "../src/corrections.js";
import { writeLegacyExport } from "../src/legacy-export.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import type { Database } from "../src/model.js";
import { duckdbReader } from "../src/person-change.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { readSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { setSamplePlace, type Actor, type CorrectionDeps } from "../src/app/sample-corrections.js";
import { createMemoryDb, FIXTURE_INPUTS, insertCleanSample, rows, scratchPaths, SETTLED_SEASON } from "./helpers.js";
import { promotedStore } from "./promoted-store.js";

/**
 * Staff correct the country, state and county of a sample (beeline-kgyd.4.3),
 * against the old-record fixture: sample 1 (records aaaa1111, dddd4444 and
 * ffff6666, Benton County, Oregon, observation 250000001) and the trap sample
 * OBAS-00657 (record bbbb2222, Washington, no county, no observation). Both
 * are printed, being the old Beeline's, and settled.
 */

const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;

async function setup() {
  const paths = await scratchPaths();
  const { instance, conn } = await promotedStore("occurrences", { appCorrections: paths.correctionsPath });
  const [[sam]] = (await rows(conn, `INSERT INTO person (display_name) VALUES ('Sam Staff') RETURNING entity_id`)) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${sam}, 3, 'samstaff')`);
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${sam})`);
  // The store as it stood, so a correction is recorded as a change rather than taken for the first snapshot.
  await recordSampleChanges(duckdbReader(conn), { log: paths.sampleChangesPath, state: paths.sampleStatePath }, { source: "observation_promotion" });
  const deps: CorrectionDeps = {
    db: createKysely(instance),
    conn,
    correctionsPath: paths.correctionsPath,
    sampleOverlayPath: paths.sampleOverlayPath,
    samplePaths: { log: paths.sampleChangesPath, state: paths.sampleStatePath },
    syncJobRunning: () => false,
  };
  const staff: Actor = { personId: Number(sam), signedInPersonId: Number(sam), login: "samstaff", staff: true, impersonating: false, via: "api" };
  const sampleOf = async (n: string) => Number(((await rows(conn, `SELECT entity_id FROM sample WHERE sample_number = '${n}'`)) as [number][])[0]![0]);
  return { conn, deps, paths, staff, net: await sampleOf("1"), trap: await sampleOf("OBAS-00657") };
}

const placeOf = async (conn: DuckDBConnection, id: number) =>
  (await rows(
    conn,
    `SELECT s.country, s.state_province, s.county, p.code FROM sample s
     LEFT JOIN sample_atlas sa ON sa.sample_id = s.entity_id LEFT JOIN program p ON p.entity_id = sa.atlas_id
     WHERE s.entity_id = ${id}`,
  ))[0];

async function correctionsIn(path: string): Promise<Record<string, string>[]> {
  const [head = [], ...body] = parseCsv(await readFile(path, "utf8"));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

describe("staff correcting a sample's country, state and county", { timeout: 120_000 }, () => {
  it("corrects every old record of an old sample, and the sample, and moves the atlas geography gave it", async () => {
    const s = await setup();
    const result = await setSamplePlace(s.deps, s.staff, s.net, { values: { state_province: "wa", county: "Walla Walla" }, note: "the vials say Walla Walla" });
    expect(result).toEqual({
      ok: true,
      outcome: "saved",
      changes: [
        { field: "state_province", from: "OR", to: "WA" },
        { field: "county", from: "BentonCo", to: "Walla Walla" },
        { field: "atlas", from: "OBA", to: "WaBA" },
      ],
    });
    expect(await placeOf(s.conn, s.net)).toEqual(["USA", "WA", "Walla Walla", "WaBA"]);
    // One event per old record and field, in the corrections file and in the store's own tables.
    const events = (await correctionsIn(s.paths.correctionsPath)).map((e) => [e._id, e.field, e.new_value, e.author, e.reason]).sort();
    expect(events).toEqual(
      ["aaaa1111", "dddd4444", "ffff6666"]
        .flatMap((id) => [
          [id, "county", "Walla Walla", "samstaff", "the vials say Walla Walla"],
          [id, "stateProvince", "WA", "samstaff", "the vials say Walla Walla"],
        ])
        .sort(),
    );
    expect(await rows(s.conn, `SELECT count(*) FROM legacy_app_correction WHERE field IN ('county', 'stateProvince')`)).toEqual([[6n]]);
    // The history says who, why, and that it came through the API, the atlas included.
    const history = (await readSampleChanges(s.paths.sampleChangesPath)).filter((c) => c.sample_number === "1" && c.source === "api");
    expect(history.map((c) => [c.field, c.new_value, c.author, c.reason]).sort()).toEqual([
      ["atlas", "WaBA", "samstaff", "the vials say Walla Walla"],
      ["county", "Walla Walla", "samstaff", "the vials say Walla Walla"],
      ["state_province", "WA", "samstaff", "the vials say Walla Walla"],
    ]);
  });

  it("keeps an atlas a person assigned when the state changes", async () => {
    const s = await setup();
    await s.conn.run(`UPDATE sample_atlas SET assigned_by = (SELECT min(entity_id) FROM person) WHERE sample_id = ${s.net}`);
    const result = await setSamplePlace(s.deps, s.staff, s.net, { values: { state_province: "WA" }, note: "" });
    expect(result).toMatchObject({ ok: true, changes: [{ field: "state_province", from: "OR", to: "WA" }] });
    expect((await placeOf(s.conn, s.net))?.[3]).toBe("OBA");
  });

  it("writes a Canadian sample's country into the old records as the old Beeline wrote it", async () => {
    const s = await setup();
    const result = await setSamplePlace(s.deps, s.staff, s.trap, { values: { country: "can", state_province: "BC", county: "Capital" }, note: "" });
    expect(result).toMatchObject({ ok: true, outcome: "saved" });
    expect(await placeOf(s.conn, s.trap)).toEqual(["CAN", "BC", "Capital", "BC"]);
    const events = await correctionsIn(s.paths.correctionsPath);
    expect(events.filter((e) => e.field === "country").map((e) => [e._id, e.base_value, e.new_value])).toEqual([["bbbb2222", "USA", "CA"]]);
  });

  it("is what a rebuild from the corrections file makes of the sample", async () => {
    const s = await setup();
    await setSamplePlace(s.deps, s.staff, s.trap, { values: { county: "Walla Walla" }, note: "" });
    await setSamplePlace(s.deps, s.staff, s.net, { values: { county: "Linn" }, note: "" });
    const rebuilt = await createMemoryDb();
    await loadLegacyStaging(rebuilt.conn, FIXTURE);
    await promoteLegacy(rebuilt.conn, { ...FIXTURE_INPUTS, appCorrections: s.paths.correctionsPath });
    for (const record of ["bbbb2222", "aaaa1111"]) {
      const [[mine]] = (await rows(s.conn, `SELECT sample_id FROM legacy_specimen_number WHERE _id = '${record}'`)) as [[number]];
      const [[again]] = (await rows(rebuilt.conn, `SELECT sample_id FROM legacy_specimen_number WHERE _id = '${record}'`)) as [[number]];
      expect(await placeOf(rebuilt.conn, Number(again))).toEqual(await placeOf(s.conn, Number(mine)));
    }
  });

  it("reaches the export of a sample whose old records disagreed, settles the disagreement, and the comparison calls it a staff correction", async () => {
    const s = await setup();
    // One record of sample 1 names another county; the export writes each record's own while they disagree.
    await s.conn.run(`UPDATE legacy_occurrence SET county = 'LinnCo' WHERE _id = 'ffff6666'`);
    await s.conn.run(`INSERT INTO sample_promotion_finding (sample_id, rule_name, details) VALUES (${s.net}, 'within_sample_disagreement', 'county: BentonCo | LinnCo')`);
    await setSamplePlace(s.deps, s.staff, s.net, { values: { county: "Benton" }, note: "" });

    const dir = await mkdtemp(join(tmpdir(), "sample-place-"));
    const exportPath = join(dir, "occurrences.csv");
    await writeLegacyExport(s.conn, exportPath);
    const counties = await rows(
      s.conn,
      `SELECT DISTINCT county FROM read_csv('${exportPath}', header = true, all_varchar = true)
       WHERE "fieldNumber" IN (SELECT "fieldNumber" FROM legacy_occurrence WHERE "sampleId" = '1')`,
    );
    expect(counties).toEqual([["Benton"]]);
    expect(await rows(s.conn, `SELECT details FROM sample_promotion_finding WHERE sample_id = ${s.net} ORDER BY 1`)).toEqual([
      ["locality: Corvallis | Philomath"],
    ]);
    // Against the old Beeline's own file (the staged records as they were), the difference is explained.
    await compareLegacyExport(s.conn, exportPath, []);
    const differences = join(dir, "differences.csv");
    await writeDifferences(s.conn, [], differences);
    expect(
      await rows(s.conn, `SELECT DISTINCT kind FROM read_csv('${differences}', header = true, all_varchar = true) WHERE "column" = 'county'`),
    ).toEqual([["staff_correction"]]);
  });

  it("writes a sample entered in Beeline directly, printed or not, with nothing in the corrections file", async () => {
    const s = await setup();
    const entered = await insertCleanSample(s.conn, {
      kind: "'trap'",
      sample_number: "'OBAS-09999'",
      date_start: `DATE '${SETTLED_SEASON}-06-01'`,
      date_end: `DATE '${SETTLED_SEASON}-06-08'`,
    });
    await s.conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${entered})`);
    await s.conn.run(`INSERT INTO sample_atlas (sample_id, atlas_id) SELECT ${entered}, atlas_id FROM atlas_region WHERE state_province = 'OR'`);
    const result = await setSamplePlace(s.deps, s.staff, entered, { values: { state_province: "ID", county: "Owyhee" }, note: "" });
    expect(result).toMatchObject({ ok: true, outcome: "saved" });
    expect(await placeOf(s.conn, entered)).toEqual(["USA", "ID", "Owyhee", "ID"]);
    expect(await correctionsIn(s.paths.correctionsPath)).toEqual([]);
    // Labels on paper do not stop it: the record is corrected before a reprint.
    await s.conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${entered}, 1, 'TEST0001')`);
    expect(await setSamplePlace(s.deps, s.staff, entered, { values: { county: "" }, note: "" })).toMatchObject({ ok: true, outcome: "saved" });
    expect((await placeOf(s.conn, entered))?.[2]).toBeNull();
  });

  it("writes a sample minted from an observation directly once it no longer follows its point", async () => {
    const s = await setup();
    const minted = await insertCleanSample(s.conn, {
      sample_number: "'M-1'",
      inat_observation_id: "424242",
      date_start: `DATE '${SETTLED_SEASON}-07-14'`,
      date_end: `DATE '${SETTLED_SEASON}-07-14'`,
    });
    expect(await setSamplePlace(s.deps, s.staff, minted, { values: { county: "Linn" }, note: "" })).toMatchObject({ ok: true, outcome: "saved" });
    expect((await placeOf(s.conn, minted))?.[2]).toBe("Linn");
    expect(await correctionsIn(s.paths.correctionsPath)).toEqual([]);
  });

  it("says unchanged and writes nothing when the values are the sample's own", async () => {
    const s = await setup();
    expect(await setSamplePlace(s.deps, s.staff, s.net, { values: { country: "usa", state_province: "OR", county: "BentonCo" }, note: "" })).toEqual({
      ok: true,
      outcome: "unchanged",
      changes: [],
    });
    expect(await setSamplePlace(s.deps, s.staff, s.net, { values: {}, note: "" })).toMatchObject({ outcome: "unchanged" });
    expect(await correctionsIn(s.paths.correctionsPath)).toEqual([]);
  });

  describe("refusals", () => {
    const invalid = async (s: Awaited<ReturnType<typeof setup>>, id: number, values: Record<string, string>) => {
      const result = await setSamplePlace(s.deps, s.staff, id, { values, note: "" });
      return result.ok ? "saved" : result.refusal === "invalid" ? result.problem : result.refusal;
    };

    it("refuses a value that would print wrong, and writes nothing", async () => {
      const s = await setup();
      expect(await invalid(s, s.trap, { country: "US" })).toMatch(/three-letter code/);
      expect(await invalid(s, s.trap, { state_province: "Washington" })).toMatch(/two-letter code/);
      expect(await invalid(s, s.trap, { state_province: "XX" })).toBe("XX is not a state or province of USA.");
      expect(await invalid(s, s.trap, { state_province: "BC" })).toBe("BC is in CAN, not USA.");
      expect(await invalid(s, s.trap, { county: "Walla Walla County" })).toMatch(/as Walla Walla: the label adds "Co"/);
      expect(await invalid(s, s.trap, { county: "Walla Walla, WA, US" })).toMatch(/name alone/);
      // Sample 1 has an observation, which would fill a blank county again tonight.
      expect(await invalid(s, s.net, { county: "" })).toMatch(/filled again tonight/);
      expect(await invalid(s, s.trap, { country: "" })).toMatch(/three-letter code/);
      expect(await correctionsIn(s.paths.correctionsPath)).toEqual([]);
      // A country no list covers takes whatever state it is given.
      expect(await invalid(s, s.trap, { country: "NZL", state_province: "CAN" })).toBe("saved");
    });

    it("refuses a sample whose place the nightly writes from its point, and not one whose point is in no county", async () => {
      const s = await setup();
      // Still to print, with an observation: it follows its point.
      const following = await insertCleanSample(s.conn, { sample_number: "'F-1'", inat_observation_id: "515151" });
      expect(await invalid(s, following, { county: "Linn" })).toBe("follows_point");
      // Tested, and in no county: the nightly writes nothing, so staff may.
      await s.conn.run(
        `INSERT INTO sample_area_derivation (sample_id, latitude, longitude, gazetteer_build, rule_version, country, state_province, derived_at)
         SELECT sample_id, latitude, longitude, 'test', ${AREA_RULE_VERSION}, NULL, NULL, now() FROM sample_location WHERE sample_id = ${following}`,
      );
      expect(await invalid(s, following, { county: "Linn" })).toBe("saved");
      // A newer gazetteer is in use elsewhere, so the next nightly tests this point again and may find a county.
      await insertCleanSample(s.conn, { sample_number: "'F-2'", inat_observation_id: "515152" });
      await s.conn.run(
        `INSERT INTO sample_area_derivation (sample_id, latitude, longitude, gazetteer_build, rule_version, country, state_province, derived_at)
         SELECT sample_id, latitude, longitude, 'newer', ${AREA_RULE_VERSION}, 'USA', 'OR', now() + INTERVAL 1 DAY FROM sample_location
         WHERE sample_id = (SELECT entity_id FROM sample WHERE sample_number = 'F-2')`,
      );
      expect(await invalid(s, following, { county: "Benton" })).toBe("follows_point");
      await s.conn.run(`DELETE FROM sample_area_derivation WHERE gazetteer_build = 'newer'`);
      // So may one tested under an older rule.
      await s.conn.run(`UPDATE sample_area_derivation SET rule_version = ${AREA_RULE_VERSION - 1} WHERE sample_id = ${following}`);
      expect(await invalid(s, following, { county: "Benton" })).toBe("follows_point");
      await s.conn.run(`UPDATE sample_area_derivation SET rule_version = ${AREA_RULE_VERSION} WHERE sample_id = ${following}`);
      // Tested at a point it has since left: it may be in a county now.
      await s.conn.run(`UPDATE sample_location SET latitude = latitude + 0.1 WHERE sample_id = ${following}`);
      expect(await invalid(s, following, { county: "Benton" })).toBe("follows_point");
      // A staff point makes any sample follow it, printed and settled ones included.
      await s.conn.run(
        `INSERT INTO sample_location_override (sample_id, latitude, longitude, reason)
         SELECT ${s.trap}, latitude, longitude, '' FROM sample_location WHERE sample_id = ${s.trap}`,
      );
      expect(await invalid(s, s.trap, { county: "Walla Walla" })).toBe("follows_point");
    });

    it("refuses a sample whose labels a print run that has not printed holds", async () => {
      const s = await setup();
      await s.conn.run(`INSERT INTO print_run (prepared_by) SELECT min(entity_id) FROM person`);
      await s.conn.run(
        `INSERT INTO printed_label (print_run_id, specimen_id, sheet, cell, location_text, coordinates_text, date_text,
                                    collector_text, method_text, number_text, latitude, longitude, date_start, date_end)
         SELECT (SELECT max(entity_id) FROM print_run), sp.entity_id, 1, 0, 'l', 'c', 'd', 'c', 'm', 'n', 46.0646, -118.343, s.date_start, s.date_end
         FROM specimen sp JOIN sample s ON s.entity_id = sp.sample_id WHERE sp.sample_id = ${s.trap}`,
      );
      expect(await invalid(s, s.trap, { county: "Walla Walla" })).toBe("in_print_run");
      expect(await correctionsIn(s.paths.correctionsPath)).toEqual([]);
    });

    it("is staff's alone, refused while impersonating, and says not found for no sample", async () => {
      const s = await setup();
      const values = { values: { county: "Walla Walla" }, note: "" };
      expect(await setSamplePlace(s.deps, { ...s.staff, staff: false }, s.trap, values)).toEqual({ ok: false, refusal: "not_admin" });
      expect(await setSamplePlace(s.deps, { ...s.staff, staff: false, impersonating: true }, s.trap, values)).toEqual({ ok: false, refusal: "impersonating" });
      expect(await setSamplePlace(s.deps, s.staff, 999_999, values)).toEqual({ ok: false, refusal: "not_found" });
      // While the nightly or the weekly sweep runs, which rewrite samples wholesale.
      expect(await setSamplePlace({ ...s.deps, syncJobRunning: () => true }, s.staff, s.trap, values)).toEqual({ ok: false, refusal: "busy" });
      expect(await correctionsIn(s.paths.correctionsPath)).toEqual([]);
    });
  });

  describe("a write conflict", () => {
    /** A Kysely whose first transaction loses a write conflict. */
    const losingOnce = (db: Kysely<Database>) => {
      let fired = false;
      return new Proxy(db, {
        get(target, prop) {
          if (prop === "transaction" && !fired) {
            fired = true;
            return () => ({
              execute: async () => {
                throw new Error("TransactionContext Error: Conflict on update!");
              },
            });
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Kysely<Database>;
    };

    it("on an old sample says the change is recorded and not applied, and a repeat applies it once", async () => {
      const s = await setup();
      const deps = { ...s.deps, db: losingOnce(s.deps.db) };
      const send = () => setSamplePlace(deps, s.staff, s.trap, { values: { county: "Walla Walla" }, note: "" });
      expect(await send()).toEqual({ ok: false, refusal: "not_applied" });
      expect((await placeOf(s.conn, s.trap))?.[2]).toBeNull();
      expect(await send()).toMatchObject({ ok: true, outcome: "saved" });
      expect((await placeOf(s.conn, s.trap))?.[2]).toBe("Walla Walla");
      expect((await correctionsIn(s.paths.correctionsPath)).filter((e) => e.field === "county")).toHaveLength(1);
    });

    it("on a sample with no old records says nothing was done", async () => {
      const s = await setup();
      const minted = await insertCleanSample(s.conn, { sample_number: "'M-2'", date_start: `DATE '${SETTLED_SEASON}-07-14'`, date_end: `DATE '${SETTLED_SEASON}-07-14'` });
      const deps = { ...s.deps, db: losingOnce(s.deps.db) };
      expect(await setSamplePlace(deps, s.staff, minted, { values: { county: "Linn" }, note: "" })).toEqual({ ok: false, refusal: "busy" });
      expect((await placeOf(s.conn, minted))?.[2]).toBe("BentonCo");
    });
  });
});
