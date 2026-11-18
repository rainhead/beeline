import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import { compareLegacyExport, DEFAULT_RULINGS, writeDifferences } from "../src/compare-legacy-export.js";
import { readRulings } from "../src/legacy-export-rulings.js";
import { writeLegacyExport } from "../src/legacy-export.js";
import { applySampleOverlay } from "../src/apply-sample-overlay.js";
import { legacyRecordRef, parseSampleOverlay, parseSampleRef, readSampleOverlay, upsertSampleOverlay } from "../src/sample-overlay.js";
import { setCoordinates, type Actor, type CorrectionDeps } from "../src/app/sample-corrections.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths } from "./helpers.js";
import { promotedStore } from "./promoted-store.js";

/**
 * Staff set the point of a sample that has no iNaturalist observation
 * (beeline-kgyd.4.2), against the real old-record fixture: samples 11 and 12
 * (OBAS-00658 and OBAS-00657) came from old Beeline's records eeee5555 and
 * bbbb2222, at 46.0646 -118.343 in Walla Walla County, Washington, 120 m up.
 */

async function setup({ separatePrintWriter = false } = {}) {
  const { instance, conn } = await promotedStore("occurrences");
  await conn.run(`INSERT INTO person (display_name) VALUES ('Sam Staff'), ('Alice Adams')`);
  await conn.run(
    `INSERT INTO inat_account (person_id, inat_user_id, login)
     SELECT entity_id, CASE display_name WHEN 'Sam Staff' THEN 3 ELSE 1 END, CASE display_name WHEN 'Sam Staff' THEN 'samstaff' ELSE 'alice' END
     FROM person WHERE display_name IN ('Sam Staff', 'Alice Adams')`,
  );
  const ids = (await rows(conn, `SELECT entity_id, display_name FROM person WHERE display_name IN ('Sam Staff', 'Alice Adams')`)) as [number, string][];
  const idOf = (name: string) => Number(ids.find(([, n]) => n === name)![0]);
  const paths = await scratchPaths();
  let running = false;
  const deps: CorrectionDeps = {
    db: createKysely(instance),
    conn,
    printWriter: separatePrintWriter ? await instance.connect() : undefined,
    correctionsPath: paths.correctionsPath,
    sampleOverlayPath: paths.sampleOverlayPath,
    samplePaths: { log: paths.sampleChangesPath, state: paths.sampleStatePath },
    syncJobRunning: () => running,
  };
  const actor = (personId: number, login: string, extra: Partial<Actor> = {}): Actor => ({
    personId,
    signedInPersonId: personId,
    login,
    staff: false,
    impersonating: false,
    ...extra,
  });
  const sampleOf = async (sampleNumber: string) =>
    Number(((await rows(conn, `SELECT entity_id FROM sample WHERE sample_number = '${sampleNumber}'`)) as [number][])[0]![0]);
  return {
    conn,
    paths,
    deps,
    sam: actor(idOf("Sam Staff"), "samstaff", { staff: true }),
    alice: actor(idOf("Alice Adams"), "alice"),
    old: await sampleOf("OBAS-00657"),
    other: await sampleOf("OBAS-00658"),
    setRunning: (v: boolean) => (running = v),
  };
}

const newPoint = { latitude: "44.5", longitude: "-123.2", uncertainty: "25", remove: false, note: "from the field notebook" };
const removal = { latitude: "", longitude: "", uncertainty: "", remove: true, note: "" };

const location = async (conn: DuckDBConnection, id: number) =>
  (await rows(conn, `SELECT latitude, longitude, coordinate_uncertainty_m, source, elevation_m FROM sample_location WHERE sample_id = ${id}`))[0];
const place = async (conn: DuckDBConnection, id: number) =>
  (await rows(
    conn,
    `SELECT s.country, s.state_province, s.county, (SELECT atlas_id FROM sample_atlas a WHERE a.sample_id = s.entity_id)
     FROM sample s WHERE s.entity_id = ${id}`,
  ))[0];
describe("a staff point on a sample with no observation", () => {
  it("is saved under the sample's first old record, and the sample takes it as staff_entry", async () => {
    const s = await setup();
    expect(await location(s.conn, s.old)).toEqual([46.0646, -118.343, 300, "legacy_import", 120]);
    const result = await setCoordinates(s.deps, s.sam, s.old, newPoint);
    expect(result).toMatchObject({ ok: true, outcome: "saved" });
    expect(await location(s.conn, s.old)).toEqual([44.5, -123.2, 25, "staff_entry", 120]);
    // The overlay file holds it by the old record, so a nightly replays it.
    expect((await readSampleOverlay(s.paths.sampleOverlayPath)).map((r) => [r.sample_ref, r.field, r.value, r.base_value, r.author])).toEqual([
      [legacyRecordRef("bbbb2222"), "coordinates", "44.5 -123.2 25", "46.0646 -118.343 300 legacy_import", "samstaff"],
    ]);
    expect(await rows(s.conn, `SELECT observed_latitude, observed_source, set_by IS NOT NULL FROM sample_location_override`)).toEqual([[46.0646, "legacy_import", true]]);
    // The other sample from old records is untouched.
    expect(await location(s.conn, s.other)).toEqual([46.0646, -118.343, 300, "legacy_import", 120]);
  });

  it("a correction is the right point set over the wrong one, under the key already standing in the file", async () => {
    const s = await setup();
    await setCoordinates(s.deps, s.sam, s.old, newPoint);
    // The row stands under an old record that is not the sample's lowest: a later save keeps that key.
    await s.conn.run(`INSERT INTO legacy_specimen_number (_id, sample_id, specimen_number) VALUES ('aaaa0000', ${s.old}, 9)`);
    const [row] = await readSampleOverlay(s.paths.sampleOverlayPath);
    expect(row!.sample_ref).toBe("legacy:bbbb2222");
    await setCoordinates(s.deps, s.sam, s.old, { ...newPoint, latitude: "44.6" });
    const file = await readSampleOverlay(s.paths.sampleOverlayPath);
    expect(file.map((r) => [r.sample_ref, r.value])).toEqual([["legacy:bbbb2222", "44.6 -123.2 25"]]);
    expect((await location(s.conn, s.old))!.slice(0, 4)).toEqual([44.6, -123.2, 25, "staff_entry"]);
    // What the point replaced is still the old record's, not the first staff point.
    expect(await rows(s.conn, `SELECT observed_latitude, observed_source FROM sample_location_override`)).toEqual([[46.0646, "legacy_import"]]);
  });

  it("has no removal: the function refuses it with its reason, and a removal row in the overlay is reported, not applied, and not thrown", async () => {
    const s = await setup();
    await setCoordinates(s.deps, s.sam, s.old, newPoint);
    const refused = await setCoordinates(s.deps, s.sam, s.old, removal);
    expect(refused).toMatchObject({ ok: false, refusal: "invalid" });
    expect((refused as { problem: string }).problem).toMatch(/set the right one/);
    expect((await location(s.conn, s.old))!.slice(0, 4)).toEqual([44.5, -123.2, 25, "staff_entry"]);
    // A removal row, as a hand-edited or older file might hold: readable, and the nightly goes on.
    const header = "sample_ref,field,base_value,value,author,reason\n";
    expect(parseSampleOverlay(`${header}legacy:bbbb2222,coordinates,46.0646 -118.343 300 legacy_import,,samstaff,\n`, "x")).toHaveLength(1);
    const result = await applySampleOverlay(s.conn, [
      { sample_ref: "legacy:bbbb2222", field: "coordinates", base_value: "", value: "", author: "samstaff", reason: "" },
    ]);
    expect(result.applied).toBe(0);
    expect(result.unresolved[0]!.reason).toMatch(/no removal/);
    expect((await location(s.conn, s.old))!.slice(0, 4)).toEqual([44.5, -123.2, 25, "staff_entry"]);
  });

  describe("while a print run holds the sample", () => {
    /** A run with a label for each specimen of the sample, in the given state. */
    async function holdInRun(conn: DuckDBConnection, sampleId: number, state: "prepared" | "printed" | "canceled") {
      await conn.run(`INSERT INTO print_run (prepared_by) SELECT min(entity_id) FROM person`);
      const run = `(SELECT max(entity_id) FROM print_run)`;
      if (state === "printed") await conn.run(`UPDATE print_run SET approved_by = prepared_by, approved_at = now(), printed_by = prepared_by, printed_at = now() WHERE entity_id = ${run}`);
      if (state === "canceled") await conn.run(`UPDATE print_run SET canceled_by = prepared_by, canceled_at = now() WHERE entity_id = ${run}`);
      await conn.run(
        `INSERT INTO printed_label (print_run_id, specimen_id, sheet, cell, location_text, coordinates_text, date_text,
                                    collector_text, method_text, number_text, latitude, longitude, date_start, date_end)
         SELECT ${run}, sp.entity_id, 1, 0, 'l', 'c', 'd', 'c', 'm', 'n', 46.0646, -118.343, s.date_start, s.date_end
         FROM specimen sp JOIN sample s ON s.entity_id = sp.sample_id WHERE sp.sample_id = ${sampleId}`,
      );
    }

    it("a point change is refused while the run has not printed, and nothing is written", async () => {
      const s = await setup();
      await holdInRun(s.conn, s.old, "prepared");
      expect(await setCoordinates(s.deps, s.sam, s.old, newPoint)).toEqual({ ok: false, refusal: "in_print_run" });
      expect(await rows(s.conn, `SELECT count(*) FROM sample_location_override`)).toEqual([[0n]]);
      expect(await readSampleOverlay(s.paths.sampleOverlayPath)).toEqual([]);
    });

    it("is allowed once the run is canceled, or has printed", async () => {
      const s = await setup();
      await holdInRun(s.conn, s.old, "canceled");
      expect(await setCoordinates(s.deps, s.sam, s.old, newPoint)).toMatchObject({ ok: true, outcome: "saved" });
      await holdInRun(s.conn, s.other, "printed");
      expect(await setCoordinates(s.deps, s.sam, s.other, newPoint)).toMatchObject({ ok: true, outcome: "saved" });
    });

    it("a removal on an observation sample is refused too, and the point stands", async () => {
      const s = await setup();
      const sample = await insertCleanSample(s.conn, { sample_number: "'OBS-2'", inat_observation_id: "424243" });
      await setCoordinates(s.deps, s.sam, sample, newPoint);
      await s.conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${sample}, 1)`);
      await holdInRun(s.conn, sample, "prepared");
      expect(await setCoordinates(s.deps, s.sam, sample, removal)).toEqual({ ok: false, refusal: "in_print_run" });
      expect((await location(s.conn, sample))!.slice(0, 4)).toEqual([44.5, -123.2, 25, "staff_entry"]);
    });
  });

  it("keeps its key when an observation is linked to the sample later: one row, and a removal replaces it", async () => {
    const s = await setup();
    await setCoordinates(s.deps, s.sam, s.old, newPoint);
    await s.conn.run(`UPDATE sample SET inat_observation_id = 777001 WHERE entity_id = ${s.old}`);
    await setCoordinates(s.deps, s.sam, s.old, { ...newPoint, latitude: "44.6" });
    expect((await readSampleOverlay(s.paths.sampleOverlayPath)).map((r) => [r.sample_ref, r.value])).toEqual([["legacy:bbbb2222", "44.6 -123.2 25"]]);
    // The sample has an observation now, so it has a removal, applied as for any observation sample.
    expect(await setCoordinates(s.deps, s.sam, s.old, removal)).toMatchObject({ ok: true, outcome: "removed" });
    expect((await readSampleOverlay(s.paths.sampleOverlayPath)).map((r) => [r.sample_ref, r.value])).toEqual([["legacy:bbbb2222", ""]]);
    expect(await rows(s.conn, `SELECT count(*) FROM sample_location_override`)).toEqual([[0n]]);
    // The nightly's replay applies it cleanly and puts nothing back.
    const replay = await applySampleOverlay(s.conn, await readSampleOverlay(s.paths.sampleOverlayPath));
    expect(replay).toEqual({ applied: 1, unresolved: [] });
    expect(await rows(s.conn, `SELECT count(*) FROM sample_location_override`)).toEqual([[0n]]);
  });

  it("an entered sample's write that loses a write conflict says nothing was done, not that it was recorded", async () => {
    const s = await setup({ separatePrintWriter: true });
    const entered = await insertCleanSample(s.conn, { sample_number: "'OBAS-8'", kind: "'trap'" }, { source: "'staff_entry'" });
    await s.conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${entered})`);
    const writer = s.deps.printWriter as unknown as { run: (sql: string, ...rest: unknown[]) => Promise<unknown> };
    const run = writer.run.bind(writer);
    writer.run = async (sql: string, ...rest: unknown[]) => {
      if (/^\s*INSERT INTO sample_location_override/.test(sql)) throw new Error("TransactionContext Error: Catalog write-write conflict on update");
      return run(sql, ...rest);
    };
    expect(await setCoordinates(s.deps, s.sam, entered, newPoint)).toEqual({ ok: false, refusal: "busy" });
    writer.run = run;
    expect(await rows(s.conn, `SELECT count(*) FROM sample_location_override`)).toEqual([[0n]]);
    expect(await readSampleOverlay(s.paths.sampleOverlayPath)).toEqual([]);
    // Sent again, it applies.
    expect(await setCoordinates(s.deps, s.sam, entered, newPoint)).toMatchObject({ ok: true, outcome: "saved" });
  });

  it("answers the old records' disagreement about where the sample was", async () => {
    const s = await setup();
    await s.conn.run(
      `INSERT INTO sample_promotion_finding (sample_id, rule_name, details) VALUES
         (${s.old}, 'within_sample_disagreement', 'coordinates: 46.0646 -118.343 | 46.1 -118.3'),
         (${s.old}, 'within_sample_disagreement', 'county: A | B')`,
    );
    await setCoordinates(s.deps, s.sam, s.old, newPoint);
    expect(await rows(s.conn, `SELECT details FROM sample_promotion_finding WHERE sample_id = ${s.old}`)).toEqual([["county: A | B"]]);
  });

  it("a replay of the overlay does not delete the finding again: only the save settles it", async () => {
    const s = await setup();
    await setCoordinates(s.deps, s.sam, s.old, newPoint);
    await s.conn.run(`INSERT INTO sample_promotion_finding (sample_id, rule_name, details) VALUES (${s.old}, 'within_sample_disagreement', 'coordinates: a | b')`);
    await applySampleOverlay(s.conn, await readSampleOverlay(s.paths.sampleOverlayPath));
    expect(await rows(s.conn, `SELECT count(*) FROM sample_promotion_finding WHERE sample_id = ${s.old}`)).toEqual([[1n]]);
  });

  it("is refused to anyone but staff, while impersonating, and while a job runs", async () => {
    const s = await setup();
    expect(await setCoordinates(s.deps, s.alice, s.old, newPoint)).toEqual({ ok: false, refusal: "not_admin" });
    expect(await setCoordinates(s.deps, { ...s.sam, impersonating: true }, s.old, newPoint)).toEqual({ ok: false, refusal: "impersonating" });
    s.setRunning(true);
    expect(await setCoordinates(s.deps, s.sam, s.old, newPoint)).toEqual({ ok: false, refusal: "busy" });
    expect(await rows(s.conn, `SELECT count(*) FROM sample_location_override`)).toEqual([[0n]]);
  });

  it("is refused for a sample with no observation, no old record and no entry, which nothing could keep it against", async () => {
    const s = await setup();
    const bare = await insertCleanSample(s.conn, { sample_number: "'BARE-1'" });
    expect(await setCoordinates(s.deps, s.sam, bare, newPoint)).toEqual({ ok: false, refusal: "no_observation" });
  });

  it("is applied to a sample entered in Beeline at once, with no file row, and has no removal either", async () => {
    const s = await setup();
    const entered = await insertCleanSample(s.conn, { sample_number: "'OBAS-9'", kind: "'trap'" }, { source: "'staff_entry'" });
    await s.conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${entered})`);
    const saved = await setCoordinates(s.deps, s.sam, entered, newPoint);
    expect(saved).toMatchObject({ ok: true, outcome: "saved" });
    expect((await location(s.conn, entered))!.slice(0, 4)).toEqual([44.5, -123.2, 25, "staff_entry"]);
    expect(await rows(s.conn, `SELECT count(*) FROM sample_location_override WHERE sample_id = ${entered}`)).toEqual([[1n]]);
    expect(await readSampleOverlay(s.paths.sampleOverlayPath)).toEqual([]);
    expect(await rows(s.conn, `SELECT count(*) FROM sample_location_override_stale`)).toEqual([[0n]]);
    expect(await setCoordinates(s.deps, s.sam, entered, removal)).toMatchObject({ ok: false, refusal: "invalid" });
  });

  it("on an observation sample, removal is as it was: it hands back the held point", async () => {
    const s = await setup();
    // Not printed, so removal hands the held point back (a printed sample keeps the point on its labels).
    const sample = await insertCleanSample(s.conn, { sample_number: "'OBS-1'", inat_observation_id: "424242" });
    const before = await location(s.conn, sample);
    await setCoordinates(s.deps, s.sam, sample, newPoint);
    expect(await setCoordinates(s.deps, s.sam, sample, removal)).toMatchObject({ ok: true, outcome: "removed" });
    expect((await location(s.conn, sample))!.slice(0, 4)).toEqual(before!.slice(0, 4));
  });

  it("keeps a replay of the overlay in step: the nightly applies the same point, and a store with no old records reports it", async () => {
    const s = await setup();
    await setCoordinates(s.deps, s.sam, s.old, newPoint);
    const replay = await applySampleOverlay(s.conn, await readSampleOverlay(s.paths.sampleOverlayPath));
    expect(replay).toEqual({ applied: 1, unresolved: [] });
    expect((await location(s.conn, s.old))!.slice(0, 4)).toEqual([44.5, -123.2, 25, "staff_entry"]);
  });
});

describe("an overlay row naming an old record", () => {
  it("is read back from the file, and says what it names", async () => {
    expect(parseSampleRef(legacyRecordRef("bbbb2222"))).toEqual({ legacy_id: "bbbb2222" });
    expect(parseSampleRef("inat:7")).toEqual({ inat_observation_id: "7" });
    expect(parseSampleRef("legacy:")).toBeNull();
  });

  it("carries only a point that is set: any other field is reported, not thrown", async () => {
    const s = await setup();
    const result = await applySampleOverlay(s.conn, [{ sample_ref: "legacy:bbbb2222", field: "locality", base_value: "", value: "Somewhere", author: "samstaff", reason: "" }]);
    expect(result.applied).toBe(0);
    expect(result.unresolved[0]!.reason).toMatch(/only a point/);
  });

  describe("on a store with no old records", () => {
    let conn: DuckDBConnection;
    beforeEach(async () => {
      ({ conn } = await createMemoryDb());
      await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector')`);
    });

    it("is reported unresolved, and nothing fails or changes", async () => {
      const id = await insertCleanSample(conn);
      const row = { sample_ref: "legacy:bbbb2222", field: "coordinates" as const, base_value: "", value: "44.5 -123.2 25", author: "nobody", reason: "" };
      const result = await applySampleOverlay(conn, [row]);
      expect(result.applied).toBe(0);
      expect(result.unresolved).toHaveLength(1);
      expect(result.unresolved[0]!.reason).toMatch(/no old Beeline records/);
      expect(await rows(conn, `SELECT count(*) FROM sample_location_override WHERE sample_id = ${id}`)).toEqual([[0n]]);
    });

    it("is reported unresolved on a store with old records when none holds that id", async () => {
      const s = await setup();
      const path = s.paths.sampleOverlayPath;
      await upsertSampleOverlay(path, [
        { sample_ref: "legacy:nosuchrecord", field: "coordinates", base_value: "", value: "44.5 -123.2", author: "samstaff", reason: "" },
      ]);
      const result = await applySampleOverlay(s.conn, await readSampleOverlay(path));
      expect(result).toEqual({
        applied: 0,
        unresolved: [{ sample_ref: "legacy:nosuchrecord", field: "coordinates", reason: "no sample holds old record nosuchrecord" }],
      });
    });
  });
});

describe("the legacy-format export of a sample whose point staff set", () => {
  // The sample of old records aaaa1111, dddd4444 and ffff6666, whose records
  // disagree about the county ('BentonCo' on two, none on the third).
  it("writes the sample's point and place on every row, not each record's own, and the comparison explains the difference", async () => {
    const s = await setup();
    const sample = await (async () => Number(((await rows(s.conn, `SELECT entity_id FROM sample WHERE sample_number = '1'`)) as [number][])[0]![0]))();
    await s.conn.run(`UPDATE legacy_occurrence SET county = 'Elsewhere' WHERE _id = 'ffff6666'`);
    const result = await setCoordinates(s.deps, s.sam, sample, newPoint);
    expect(result).toMatchObject({ ok: true, outcome: "saved" });
    // What deriving the point's county does.
    await s.conn.run(`UPDATE sample SET county = 'LinnCo' WHERE entity_id = ${sample}`);

    const dir = await mkdtemp(join(tmpdir(), "staff-point-"));
    const exportPath = join(dir, "occurrences.csv");
    await writeLegacyExport(s.conn, exportPath);
    const exported = await rows(
      s.conn,
      `SELECT "fieldNumber", county, "decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters", "coordinateSource"
       FROM read_csv('${exportPath}', header = true, all_varchar = true) WHERE "fieldNumber" IN
         (SELECT "fieldNumber" FROM legacy_occurrence WHERE sampleId = '1') ORDER BY 1`,
    );
    expect(exported.length).toBeGreaterThanOrEqual(3);
    for (const row of exported) expect(row.slice(1)).toEqual(["LinnCo", "44.5000", "-123.2000", "25", null]);

    await compareLegacyExport(s.conn, exportPath, []);
    const differences = join(dir, "differences.csv");
    await writeDifferences(s.conn, [], differences);
    const kinds = await rows(
      s.conn,
      `SELECT "column", kind FROM read_csv('${differences}', header = true, all_varchar = true)
       WHERE "column" IN ('county', 'decimalLatitude', 'decimalLongitude', 'coordinateUncertaintyInMeters') GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    // And every one of them is ruled, so a staff point that production already holds is not unexplained.
    const rulings = await readRulings(DEFAULT_RULINGS);
    await compareLegacyExport(s.conn, exportPath, rulings);
    const ruled = join(dir, "ruled.csv");
    await writeDifferences(s.conn, rulings, ruled);
    expect(await rows(s.conn, `SELECT DISTINCT kind, outcome FROM read_csv('${ruled}', header = true, all_varchar = true) WHERE kind = 'staff_point'`)).toEqual([["staff_point", "expected"]]);
    expect(await rows(s.conn, `SELECT count(*) FROM read_csv('${ruled}', header = true, all_varchar = true) WHERE kind = 'staff_point' AND coalesce(outcome, '') = ''`)).toEqual([[0n]]);
    expect(kinds).toEqual([
      ["coordinateUncertaintyInMeters", "staff_point"],
      ["county", "staff_point"],
      ["decimalLatitude", "staff_point"],
      ["decimalLongitude", "staff_point"],
    ]);
  });
});

describe("a staff point's transaction is its own", () => {
  // The write is one transaction on the print connection behind the print
  // runs' lock, never on the app's shared connection, where another request's
  // statements would join it and a rollback would undo them (the 2am
  // promotion's lesson, src/app/main.ts). Here the writer is made to fail
  // after BEGIN, and another request's write lands while it is open.
  async function unrelatedWriteSurvivesAFailedSave(separatePrintWriter: boolean) {
    const s = await setup({ separatePrintWriter });
    const writer = (s.deps.printWriter ?? s.conn) as unknown as { run: (sql: string, ...rest: unknown[]) => Promise<unknown> };
    const run = writer.run.bind(writer);
    writer.run = async (sql: string, ...rest: unknown[]) => {
      if (/^\s*DELETE FROM sample_promotion_finding/.test(sql)) throw new Error("boom: the write fails after the transaction is open");
      const result = await run(sql, ...rest);
      // Another request's write, on the app's connection, while the transaction is open.
      if (/^BEGIN/.test(sql)) await s.conn.run(`UPDATE person SET display_name = 'Sam Staffer' WHERE display_name = 'Sam Staff'`);
      return result;
    };
    await expect(setCoordinates(s.deps, s.sam, s.old, newPoint)).rejects.toThrow(/boom/);
    writer.run = run;
    const survived = (await rows(s.conn, `SELECT count(*) FROM person WHERE display_name = 'Sam Staffer'`))[0]![0] === 1n;
    // The failed save itself is undone.
    expect(await rows(s.conn, `SELECT count(*) FROM sample_location_override`)).toEqual([[0n]]);
    expect((await location(s.conn, s.old))!.slice(0, 4)).toEqual([46.0646, -118.343, 300, "legacy_import"]);
    return survived;
  }

  it("a save that fails and rolls back does not undo another request's write made while it was open", async () => {
    expect(await unrelatedWriteSurvivesAFailedSave(true)).toBe(true);
  });

  it("would, on the app's shared connection: the same write is rolled back with it", async () => {
    // Why the print connection: this is the failure the test above rules out.
    expect(await unrelatedWriteSurvivesAFailedSave(false)).toBe(false);
  });
});
