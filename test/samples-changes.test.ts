import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Kysely } from "kysely";
import { describe as describeInOrder, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { Database } from "../src/model.js";
import { en } from "../src/app/messages/en.js";
import { APPLY_ORDER } from "../src/app/samples-upload-change.js";
import { applyPending, applyWaiting, clearStopped, describeApply, settleUndone } from "../src/app/samples-upload-apply.js";
import { SAMPLES_UNITS } from "../src/app/samples-upload-plan.js";
import { parseSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { duckdbReader } from "../src/person-change.js";
import { CURRENT_SEASON, buildTestGazetteer, insertCleanSample, rows } from "./helpers.js";
import { UPLOAD_TODAY, edited, everyProgramConfirmed, matrixOf, uploadFixture, type UploadFixture } from "./upload-fixture.js";
import type { TestCell } from "./workbook.js";

/**
 * Applying a changed row of the samples file to its existing sample (beeline-kgyd.4.11): each kind of change goes
 * through the correction the pages and the API use, is refused where it refuses, and is recorded for each kind in the
 * outcome table. Every test has a store of its own, copied from one made once.
 */
const describe = describeInOrder.concurrent;

const ORIGIN = "http://localhost:3054";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const day = (n: number, month = "07") => `${CURRENT_SEASON}-${month}-${String(n).padStart(2, "0")}`;
const esc = (text: string) => text.replaceAll("'", "&#39;");
const c = en.uploads.changes;
const in1 = en.uploads.page.split(1, 0, 0);
const n = en.uploads.notes;

const download = async (f: UploadFixture) => new Uint8Array(await (await f.app.request("/samples.xlsx?scope=all")).arrayBuffer());
const upload = async (f: UploadFixture, file: Uint8Array) => {
  const body = new FormData();
  body.set("file", new File([file as BlobPart], "samples.xlsx", { type: XLSX }));
  const res = await f.app.request("/uploads", { method: "POST", headers: { origin: ORIGIN }, body });
  expect(res.status).toBe(303);
  return res.headers.get("location")!;
};
const digestIn = (html: string) => /name="digest" value="([0-9a-f]+)"/.exec(html)?.[1];
const apply = async (f: UploadFixture, location: string, fields: { digest?: string; kinds?: readonly string[]; anyway?: readonly number[]; obas?: boolean; confirmElsewhere?: boolean }) => {
  const body = new FormData();
  // The fixture's staff member leads no program, so applying asks once (beeline-kgyd.13); most tests are not about it, so it is ticked unless a test says not.
  if (fields.confirmElsewhere !== false) body.set("confirm_elsewhere", await everyProgramConfirmed(f));
  if (fields.digest !== undefined) body.set("digest", fields.digest);
  if (fields.obas !== false) body.set("obas", "1");
  for (const r of fields.anyway ?? []) body.append("anyway", String(r));
  if (fields.kinds !== undefined) {
    body.set("kinds_shown", "1");
    for (const k of fields.kinds) body.append("kind", k);
  }
  return f.app.request(`${location}/apply-samples`, { method: "POST", headers: { origin: ORIGIN }, body });
};
/** A samples file with the given cells of existing samples changed (and rows added), uploaded and its page read. */
const offered = async (f: UploadFixture, edits: Array<{ id: number; set: Record<string, TestCell> }>, addRows: Array<Record<string, TestCell>> = []) => {
  const location = await upload(f, edited(await download(f), edits, { idColumn: "sampleId", addRows }));
  const html = await (await f.app.request(location)).text();
  return { location, html, digest: digestIn(html) };
};
const deps = (f: UploadFixture, over = {}) => ({
  db: f.db,
  conn: f.conn,
  printWriter: f.conn,
  samplePaths: { log: f.paths.sampleChangesPath, state: f.paths.sampleStatePath },
  correctionsPath: f.paths.correctionsPath,
  sampleOverlayPath: f.paths.sampleOverlayPath,
  today: () => UPLOAD_TODAY,
  ...over,
});
/** The store as production's was, built and then changed, so that its change log follows a sample whose fields move (src/sample-change.ts). */
const baseline = async (f: UploadFixture) => {
  await f.conn.run("INSERT INTO schema_migration (name) VALUES ('0001-a-store-that-was-built.sql')");
  return recordSampleChanges(duckdbReader(f.conn), { log: f.paths.sampleChangesPath, state: f.paths.sampleStatePath }, { source: "reconcile" });
};
const uploadId = async (f: UploadFixture) => Number((await rows(f.conn, `SELECT max(entity_id) FROM upload`))[0]![0]);

/** What each change of an upload came to: unit, outcome and sentence, in the order they are applied. */
const outcomesOf = async (f: UploadFixture, row?: number) => {
  const found = (await rows(f.conn, `SELECT row_number, unit, outcome, detail FROM upload_sample_outcome ${row === undefined ? "" : `WHERE row_number = ${row}`}`)) as Array<[number, string, string, string | null]>;
  const rank = (unit: string) => (unit === "row" ? -1 : (APPLY_ORDER as readonly string[]).indexOf(unit));
  return found.sort((a, b) => a[0] - b[0] || rank(a[1]) - rank(b[1])).map(([r, unit, outcome, detail]) => ({ row: r, unit, outcome, detail }));
};
const byUnit = (list: Awaited<ReturnType<typeof outcomesOf>>) => Object.fromEntries(list.map((o) => [o.unit, [o.outcome, o.detail]]));

/** The row of the first new row of a file, which is the last row. */
const rowOfNew = async (f: UploadFixture, location: string) => {
  const html = await (await f.app.request(location)).text();
  return Number(/name="anyway" value="(\d+)"/.exec(html)![1]);
};

/** The row of a sample in the file, the header being row 1. */
const rowOf = async (f: UploadFixture, sampleId: number) => {
  const m = matrixOf(await download(f));
  return m.findIndex((r) => r[m[0]!.indexOf("sampleId")] === String(sampleId)) + 1;
};
/** The note the file with notes gives a sample's row. */
const noteOf = async (f: UploadFixture, location: string, sampleId: number) => {
  const notes = matrixOf(new Uint8Array(await (await f.app.request(`${location}/notes`)).arrayBuffer()));
  const head = notes[0]!;
  return notes.find((r) => r[head.indexOf("sampleId")] === String(sampleId))![head.length - 1]!;
};

/** A trap sample entered in Beeline, collected 1 to 8 July: the kind a registry file is mostly made of. */
async function trapSample(f: UploadFixture, over: Record<string, string> = {}, entered = true): Promise<number> {
  const id = await insertCleanSample(f.conn, {
    kind: "'trap'",
    sample_number: "'T-1'",
    date_start: `DATE '${day(1)}'`,
    date_end: `DATE '${day(8)}'`,
    protocol: "'vane trap'",
    sampling_effort: "'6 vane traps'",
    specimen_count: "2",
    collector_id: String(f.volunteer),
    ...over,
  });
  if (entered) await f.conn.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES (${id}, ${f.staffer})`);
  return id;
}

/** The tables legacy promotion leaves in a store, empty. */
async function legacyTables(f: UploadFixture) {
  await f.conn.run(`CREATE TABLE IF NOT EXISTS legacy_specimen_number (_id VARCHAR, sample_id INTEGER)`);
  await f.conn.run(
    `CREATE TABLE IF NOT EXISTS legacy_occurrence (_id VARCHAR, "samplingProtocol" VARCHAR, day VARCHAR, month VARCHAR, year VARCHAR, day2 VARCHAR, month2 VARCHAR, year2 VARCHAR, "recordedBy" VARCHAR, locality VARCHAR, country VARCHAR, "stateProvince" VARCHAR, county VARCHAR)`,
  );
}

/** Old records for a sample, as promotion leaves them: enough for the method's correction to name. */
async function oldRecords(f: UploadFixture, sampleId: number, record: string, protocol: string) {
  await legacyTables(f);
  await f.conn.run(`INSERT INTO legacy_specimen_number VALUES ('${record}', ${sampleId})`);
  await f.conn.run(`INSERT INTO legacy_occurrence VALUES ('${record}', '${protocol}', '1', '7', '${CURRENT_SEASON}', '8', '7', '${CURRENT_SEASON}', 'Vera Volunteer', 'Corvallis', 'USA', 'OR', 'BentonCo')`);
}

/** A Kysely whose first update loses a write conflict, as a store write racing another does. */
function losingOnce(db: Kysely<Database>, what: "updateTable" | "transaction" = "updateTable", table?: string, skip = 0): Kysely<Database> {
  let fired = false;
  let seen = 0;
  const losing = <T extends object>(builder: T): T =>
    new Proxy(builder, {
      get(target, prop) {
        if (prop === "execute") return async () => Promise.reject(new Error("TransactionContext Error: Conflict on update!"));
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const next = (value as (...a: unknown[]) => unknown).apply(target, args);
          return next !== null && typeof next === "object" ? losing(next) : next;
        };
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === what && !fired) {
        // The transaction `skip` others have begun first is the one that loses.
        if (what === "transaction") {
          if (seen++ < skip) return (target.transaction as () => unknown).bind(target);
          return () => ((fired = true), { execute: async () => Promise.reject(new Error("TransactionContext Error: Conflict on update!")) });
        }
        return (...args: unknown[]) => {
          const built = (target.updateTable as (...a: unknown[]) => object)(...args);
          if (table !== undefined && args[0] !== table) return built;
          fired = true;
          return losing(built);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Kysely<Database>;
}

describe("a changed existing row", () => {
  it("is applied one kind of change at a time through the corrections, credited to the uploader with a reason naming the upload", async () => {
    const f = await uploadFixture();
    await f.conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${f.staffer}, 1, 'sam_s')`);
    const t = await trapSample(f);
    await baseline(f);
    const { location, html, digest } = await offered(f, [
      {
        id: t,
        set: { eventDate: `${day(2)}/${day(9)}`, samplingProtocol: "pan trap", trapCount: "8", specimenCount: "4", recordedBy: "Vera Volunteer | Sam Staff", locality: "Albany" },
      },
    ]);
    expect(html).toContain(esc(en.uploads.page.changesLine(1, in1)));
    expect((await apply(f, location, { digest })).status).toBe(303);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, applied: 5 });
    const row = await rowOf(f, t);
    expect((await outcomesOf(f, row)).map((o) => [o.unit, o.outcome])).toEqual([
      ["method_dates", "applied"],
      ["trap_count", "applied"],
      ["specimen_count", "applied"],
      ["collectors", "applied"],
      ["place", "applied"],
    ]);
    expect(await rows(f.conn, `SELECT protocol, CAST(date_start AS VARCHAR), CAST(date_end AS VARCHAR), sampling_effort, specimen_count, locality, kind FROM sample WHERE entity_id = ${t}`)).toEqual([
      ["pan trap", day(2), day(9), "8 pan traps", 4, "Albany", "trap"],
    ]);
    expect(await rows(f.conn, `SELECT person_id, position FROM sample_collector WHERE sample_id = ${t} ORDER BY position`)).toEqual([[f.volunteer, 1], [f.staffer, 2]]);
    // The history credits the uploader and names the upload, for every kind of change.
    const id = await uploadId(f);
    const log = parseSampleChanges(await readFile(f.paths.sampleChangesPath, "utf8")).changes.filter((x) => x.sample_number === "T-1" && x.source === "upload");
    expect(new Set(log.map((x) => x.field)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(log.map((x) => x.author))).toEqual(new Set(["sam_s"]));
    expect(new Set(log.map((x) => x.reason))).toEqual(new Set([`From upload ${id}`]));
    // The page and the notes say what was done.
    const after = await (await f.app.request(location)).text();
    expect(after).toContain(esc(en.uploads.page.samplesChangedCount(1, 5, in1)));
    const note = await noteOf(f, location, t);
    expect(note).toContain(n.unitApplied(`${n.appliedCell("trapCount", '"6"', '"8"')}`));
    expect(note).toContain(n.appliedCell("locality", '"Corvallis"', '"Albany"'));
  });

  it("applies the kinds that were ticked, leaves the others as differences, and says nothing was ticked when none were", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { trapCount: "8", locality: "Albany" } }]);
    const none = await apply(f, location, { digest, kinds: [] });
    expect(none.status).toBe(409);
    expect(await none.text()).toContain(esc(en.uploads.page.samplesNothingTicked));
    expect(await rows(f.conn, `SELECT count(*) FROM upload_applied`)).toEqual([[0n]]);
    expect((await apply(f, location, { digest, kinds: ["place"] })).status).toBe(303);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, applied: 1 });
    expect(byUnit(await outcomesOf(f))).toEqual({ trap_count: ["skipped", c.notChosen], place: ["applied", null] });
    expect(await rows(f.conn, `SELECT sampling_effort, locality FROM sample WHERE entity_id = ${t}`)).toEqual([["6 vane traps", "Albany"]]);
    const after = await (await f.app.request(location)).text();
    expect(after).toContain(esc(en.uploads.page.changesNotChosen(1, in1)));
    expect(await noteOf(f, location, t)).toContain(n.unitNotApplied("trap count", c.notChosen));
  });

  it("does not tick coordinates at first, says how far each point moves, and records an unticked kind as not chosen", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    // 0.0288 degrees of latitude is 3.2 km.
    const { location, html, digest } = await offered(f, [{ id: t, set: { decimalLatitude: "44.5934", locality: "Albany" } }]);
    expect(html).toContain(esc(en.uploads.page.pointsLine(1, 1, "3.2 km", in1, in1)));
    expect(html).toMatch(/name="kind" value="coordinates"\/>/);
    expect(html).toMatch(/name="kind" value="place" checked=""\/>/);
    expect(html).toContain(esc(en.uploads.page.changeCoordinatesNote));
    // Before applying, the notes say how far it moves.
    expect(await noteOf(f, location, t)).toContain(n.moves("3.2 km"));
    expect((await apply(f, location, { digest })).status).toBe(303);
    await applyPending(deps(f));
    expect(byUnit(await outcomesOf(f))).toMatchObject({ coordinates: ["skipped", c.notChosen], place: ["applied", null] });
    expect(await rows(f.conn, `SELECT latitude FROM sample_location WHERE sample_id = ${t}`)).toEqual([[44.5646]]);
    expect(await noteOf(f, location, t)).toContain(n.unitNotApplied("coordinates", c.notChosen));
  });

  it("applies a ticked point, and then leaves the country, state and county to follow it, saying how the county compares with the file's", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { decimalLatitude: "44.5934", county: "Linn" } }]);
    expect((await apply(f, location, { digest, kinds: ["coordinates", "area"] })).status).toBe(303);
    // The areas are derived from a gazetteer, which this point is in the county of (Benton, spelled as the gazetteer does).
    const gazetteerPath = join(dirname(f.paths.uploadsDir), "gazetteer.duckdb");
    await buildTestGazetteer(gazetteerPath, "build-1");
    expect(await applyPending(deps(f, { derivePaths: { gazetteerPath } }))).toEqual({ created: 0, refused: 0, skipped: 1, stopped: 0, applied: 1 });
    const [now] = (await rows(f.conn, `SELECT county FROM sample WHERE entity_id = ${t}`)) as [[string]];
    expect(byUnit(await outcomesOf(f))).toEqual({
      coordinates: ["applied", null],
      area: ["skipped", c.areaFollowsPoint(`USA, OR, ${now[0]}`, "USA, OR, Linn")],
    });
    expect(await rows(f.conn, `SELECT latitude FROM sample_location WHERE sample_id = ${t}`)).toEqual([[44.5934]]);
    // The gazetteer's county stands, not the file's.
    expect(await rows(f.conn, `SELECT county FROM sample WHERE entity_id = ${t}`)).toEqual([["Benton"]]);
  });

  it("applies the country, state and county when the point does not change, through the correction", async () => {
    const f = await uploadFixture();
    await baseline(f);
    // A settled net sample with no observation: its place does not follow its point.
    const { location, digest } = await offered(f, [{ id: f.ids.sampleB, set: { county: "Linn" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, applied: 1 });
    expect(byUnit(await outcomesOf(f))).toEqual({ area: ["applied", null] });
    expect(await rows(f.conn, `SELECT county FROM sample WHERE entity_id = ${f.ids.sampleB}`)).toEqual([["Linn"]]);
    const log = parseSampleChanges(await readFile(f.paths.sampleChangesPath, "utf8")).changes.filter((x) => x.source === "upload");
    expect(log.map((x) => x.field)).toContain("county");
  });

  it("writes the trap count again after a method change on an old sample, so its effort names the new method", async () => {
    const f = await uploadFixture();
    const o = await trapSample(f, { sample_number: "'O-1'", protocol: "'pan trap'", sampling_effort: "'6 pan traps'" }, false);
    await oldRecords(f, o, "rec-1", "pan trap");
    const { location, digest } = await offered(f, [{ id: o, set: { samplingProtocol: "vane trap" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, applied: 1 });
    expect(await rows(f.conn, `SELECT protocol, sampling_effort FROM sample WHERE entity_id = ${o}`)).toEqual([["vane trap", "6 vane traps"]]);
    // The change is kept against the old record too.
    expect(await readFile(f.paths.correctionsPath, "utf8")).toContain("vane trap");
  });

  it("sends a single day on an old trap sample as start and end both, so it stays a trap sample", async () => {
    const f = await uploadFixture();
    const o = await trapSample(f, { sample_number: "'O-2'", date_start: `DATE '${day(3)}'`, date_end: `DATE '${day(3)}'` }, false);
    await oldRecords(f, o, "rec-2", "vane trap");
    const { location, digest } = await offered(f, [{ id: o, set: { eventDate: day(4) } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await applyPending(deps(f));
    expect(await rows(f.conn, `SELECT kind, CAST(date_start AS VARCHAR), CAST(date_end AS VARCHAR) FROM sample WHERE entity_id = ${o}`)).toEqual([["trap", day(4), day(4)]]);
  });
});

describe("a change a correction would refuse", () => {
  it("is shown in the preview as one that may not be applied, is queued all the same, and is recorded as refused with the correction's own sentence", async () => {
    const f = await uploadFixture();
    // A net sample: it has no trap count and no specimen count to correct.
    const { location, html, digest } = await offered(f, [{ id: f.ids.sampleA, set: { trapCount: "5", specimenCount: "9" } }], [
      { fieldNumber: "OBAS-00011", recordedBy: "Vera Volunteer", eventDate: day(10), samplingProtocol: "vane trap", trapCount: "6", specimenCount: "2", decimalLatitude: "44.9", decimalLongitude: "-123.2", coordinateUncertaintyInMeters: "50", countryCode: "US", stateProvince: "OR", county: "Benton", locality: "Fir Butte" },
    ]);
    expect(html).toContain(esc(en.uploads.page.mayNotLine(2, en.uploads.page.split(2, 0, 0))));
    expect(await noteOf(f, location, f.ids.sampleA)).toContain(n.mayNot("trap count", en.record.sample.trapCount.problems.net));
    expect((await apply(f, location, { digest })).status).toBe(303);
    // Queued: a prediction is shown and not enforced, so the correction decides.
    const row = await rowOf(f, f.ids.sampleA);
    expect(byUnit(await outcomesOf(f, row))).toEqual({ trap_count: ["pending", null], specimen_count: ["pending", null] });
    expect(await applyPending(deps(f))).toEqual({ created: 1, refused: 0, skipped: 0, stopped: 0, notApplied: 2 });
    expect(byUnit(await outcomesOf(f, row))).toEqual({
      trap_count: ["refused", en.record.sample.trapCount.problems.net],
      specimen_count: ["refused", en.record.sample.specimenCount.problems.net],
    });
    expect(await rows(f.conn, `SELECT specimen_count FROM sample WHERE entity_id = ${f.ids.sampleA}`)).toEqual([[3]]);
  });

  it("predicts only over the kinds that are ticked", async () => {
    const f = await uploadFixture();
    // Coordinates on a sample nothing can keep a point against would be refused, but they are not ticked.
    const { html } = await offered(f, [{ id: f.ids.sampleA, set: { decimalLatitude: "44.6", locality: "Albany" } }]);
    expect(html).not.toContain(esc(en.uploads.page.mayNotLine(1, in1)));
  });

  it("is predicted for a start date on a sample with an observation, a method on a sample nothing backs, a print run and a number taken", async () => {
    const f = await uploadFixture("staffer", { unprinted: true });
    // An old sample with an observation: iNaturalist holds its start.
    const withObservation = await trapSample(f, { sample_number: "'X-1'", date_start: `DATE '${day(20)}'`, date_end: `DATE '${day(20)}'`, inat_observation_id: "12345" }, false);
    await oldRecords(f, withObservation, "rec-x", "vane trap");
    // An old net sample whose collector has a sample with the same number on the day the file moves it to.
    const net = await insertCleanSample(f.conn, { sample_number: "'2'", date_start: `DATE '${day(22)}'`, date_end: `DATE '${day(22)}'`, collector_id: String(f.volunteer) });
    await oldRecords(f, net, "rec-n", "aerial net");
    await trapSample(f, { sample_number: "'2'", date_start: `DATE '${day(23)}'`, date_end: `DATE '${day(23)}'` });
    // A trap sample whose labels are in a print run that has not printed.
    await f.conn.run(`UPDATE sample SET kind = 'trap', date_end = date_end + 3, protocol = 'vane trap' WHERE entity_id = ${f.ids.sampleC}`);
    await f.conn.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES (${f.ids.sampleC}, ${f.staffer})`);
    const { location } = await offered(f, [
      { id: withObservation, set: { eventDate: day(21) } },
      { id: net, set: { eventDate: day(23) } },
      { id: f.ids.sampleC!, set: { samplingProtocol: "pan trap" } },
      { id: f.ids.sampleB, set: { samplingProtocol: "pan trap" } },
    ]);
    expect(await noteOf(f, location, withObservation)).toContain(n.mayNot("method and dates", en.record.sample.methodEdit.problems.start_observation));
    expect(await noteOf(f, location, net)).toContain(n.mayNot("method and dates", en.record.sample.methodEdit.numberTaken("2")));
    expect(await noteOf(f, location, f.ids.sampleC!)).toContain(n.mayNot("method and dates", en.record.sample.methodEdit.inPrintRun));
    expect(await noteOf(f, location, f.ids.sampleB)).toContain(n.mayNot("method and dates", en.record.sample.methodEdit.noOldRecords));
  });

  it("does not predict a refusal for a start date on a printed sample with an observation, and applies it", async () => {
    const f = await uploadFixture("staffer", { unprinted: true });
    const printed = await trapSample(f, { sample_number: "'X-2'", date_start: `DATE '${day(20)}'`, date_end: `DATE '${day(20)}'`, inat_observation_id: "12346" }, false);
    await oldRecords(f, printed, "rec-p", "vane trap");
    // A specimen no run minted is on paper.
    await f.conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${printed}, 1)`);
    const { location, digest } = await offered(f, [{ id: printed, set: { eventDate: day(21) } }]);
    expect(await noteOf(f, location, printed)).not.toContain(en.record.sample.methodEdit.problems.start_observation);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await applyPending(deps(f));
    expect(await rows(f.conn, `SELECT CAST(date_start AS VARCHAR) FROM sample WHERE entity_id = ${printed}`)).toEqual([[day(21)]]);
  });

  it("makes a method-only change on an unprinted range with an observation and no old records eligible, and keeps a one-day one ineligible", async () => {
    const f = await uploadFixture("staffer", { unprinted: true });
    const range = await trapSample(f, { sample_number: "'X-3'", date_start: `DATE '${day(20)}'`, date_end: `DATE '${day(22)}'`, inat_observation_id: "12347" }, false);
    const oneDay = await trapSample(f, { sample_number: "'X-4'", date_start: `DATE '${day(20)}'`, date_end: `DATE '${day(20)}'`, inat_observation_id: "12348" }, false);
    const { location } = await offered(f, [
      { id: range, set: { samplingProtocol: "pan trap" } },
      { id: oneDay, set: { samplingProtocol: "pan trap" } },
    ]);
    expect(await noteOf(f, location, range)).not.toContain(n.mayNot("method and dates", en.record.sample.methodEdit.noOldRecords));
    expect(await noteOf(f, location, oneDay)).toContain(n.mayNot("method and dates", en.record.sample.methodEdit.noOldRecords));
  });

  it("is predicted for a specimen count below the highest specimen number already given", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f, { specimen_count: "3" });
    for (const k of [1, 2, 3]) await f.conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${t}, ${k}, NULL)`);
    const { location, digest } = await offered(f, [{ id: t, set: { specimenCount: "1", trapCount: "8" } }]);
    expect(await noteOf(f, location, t)).toContain(n.mayNot("specimen count", en.record.sample.specimenCount.problems.numbered(3)));
    expect((await apply(f, location, { digest })).status).toBe(303);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, notApplied: 1, applied: 1 });
    expect(byUnit(await outcomesOf(f))).toMatchObject({ specimen_count: ["refused", en.record.sample.specimenCount.problems.numbered(3)], trap_count: ["applied", null] });
  });

  it("is recorded with the correction's own sentence when the job meets it: a locality on a sample with no record to keep it against", async () => {
    const f = await uploadFixture();
    await legacyTables(f);
    const { location, digest } = await offered(f, [{ id: f.ids.sampleB, set: { locality: "Albany" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, notApplied: 1 });
    const [placed] = await outcomesOf(f);
    expect(placed).toMatchObject({ unit: "place", outcome: "refused" });
    expect(placed!.detail).toContain("No old Beeline record backs this sample");
    expect(await noteOf(f, location, f.ids.sampleB)).toContain(n.unitNotApplied("locality", placed!.detail!));
  });
});

describe("a change a correction refuses only when the job meets it", () => {
  it("refuses a sample moved to a day its collector took the number on after the page", async () => {
    const f = await uploadFixture();
    const net = await insertCleanSample(f.conn, { sample_number: "'3'", date_start: `DATE '${day(22)}'`, date_end: `DATE '${day(22)}'`, collector_id: String(f.volunteer) });
    await oldRecords(f, net, "rec-n3", "aerial net");
    const { location, digest } = await offered(f, [{ id: net, set: { eventDate: day(23) } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await trapSample(f, { sample_number: "'3'", date_start: `DATE '${day(23)}'`, date_end: `DATE '${day(23)}'` });
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, notApplied: 1 });
    expect(byUnit(await outcomesOf(f))).toEqual({ method_dates: ["refused", en.record.sample.methodEdit.numberTaken("3")] });
    expect(await rows(f.conn, `SELECT CAST(date_start AS VARCHAR) FROM sample WHERE entity_id = ${net}`)).toEqual([[day(22)]]);
  });

  it("refuses a method change when a print run that has not printed took the sample after the page", async () => {
    const f = await uploadFixture("staffer", { unprinted: true });
    const c1 = f.ids.c1!;
    await f.conn.run(`UPDATE sample SET kind = 'trap', date_end = date_end + 3, protocol = 'vane trap' WHERE entity_id = ${f.ids.sampleC}`);
    await f.conn.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES (${f.ids.sampleC}, ${f.staffer})`);
    // The run's label is taken away while the page is made, and put back before the job runs.
    const label = (await rows(f.conn, `SELECT print_run_id, sheet, cell, location_text, coordinates_text, date_text, collector_text, method_text, number_text, latitude, longitude, CAST(date_start AS VARCHAR), CAST(date_end AS VARCHAR) FROM printed_label WHERE specimen_id = ${c1}`))[0]!;
    await f.conn.run(`DELETE FROM printed_label WHERE specimen_id = ${c1}`);
    const { location, digest } = await offered(f, [{ id: f.ids.sampleC!, set: { samplingProtocol: "pan trap" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await f.conn.run(
      `INSERT INTO printed_label (print_run_id, specimen_id, sheet, cell, location_text, coordinates_text, date_text, collector_text, method_text, number_text, latitude, longitude, date_start, date_end)
       VALUES (${label[0]}, ${c1}, ${label[1]}, ${label[2]}, '${label[3]}', '${label[4]}', '${label[5]}', '${label[6]}', '${label[7]}', '${label[8]}', ${label[9]}, ${label[10]}, DATE '${label[11]}', DATE '${label[12]}')`,
    );
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, notApplied: 1 });
    expect(byUnit(await outcomesOf(f))).toEqual({ method_dates: ["refused", en.record.sample.methodEdit.inPrintRun] });
    expect(await rows(f.conn, `SELECT protocol FROM sample WHERE entity_id = ${f.ids.sampleC}`)).toEqual([["vane trap"]]);
  });
});

describe("what Beeline holds right before a change", () => {
  it("is compared with what the file was downloaded against: a cell changed since refuses that change and not the row", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { trapCount: "8", locality: "Albany" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    // Somebody corrects the locality between the button and the job.
    await f.conn.run(`UPDATE sample SET locality = 'Elsewhere' WHERE entity_id = ${t}`);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, notApplied: 1, applied: 1 });
    expect(byUnit(await outcomesOf(f))).toEqual({ trap_count: ["applied", null], place: ["refused", c.changedSince("locality", "Elsewhere")] });
    expect(await rows(f.conn, `SELECT sampling_effort, locality FROM sample WHERE entity_id = ${t}`)).toEqual([["8 vane traps", "Elsewhere"]]);
  });

  it("does not refuse a later change of the row for the row's own earlier writes", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    // The method rewrites the effort text of an entered sample, which the trap count's cell then reads.
    const { location, digest } = await offered(f, [{ id: t, set: { samplingProtocol: "pan trap", trapCount: "8", specimenCount: "4" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, applied: 3 });
    expect(await rows(f.conn, `SELECT sampling_effort, specimen_count FROM sample WHERE entity_id = ${t}`)).toEqual([["8 pan traps", 4]]);
  });

  it("refuses the apply, writing nothing, when a sample changed between the page and the button", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { locality: "Albany" } }]);
    await f.conn.run(`UPDATE sample SET specimen_count = 5 WHERE entity_id = ${t}`);
    const stale = await apply(f, location, { digest });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain(esc(en.uploads.page.samplesChangedSince));
    expect(await rows(f.conn, `SELECT count(*) FROM upload_applied`)).toEqual([[0n]]);
  });
});

describe("a change that is neither made nor refused", () => {
  it("is left pending while the nightly runs, and the upload stops there until Try again finishes it", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { recordedBy: "Vera Volunteer | Sam Staff", locality: "Albany" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await expect(applyPending(deps(f, { syncJobRunning: () => true }))).rejects.toThrow(/was not done: busy/);
    // The collectors come before the locality: the first is left pending and the row's later change waits behind it.
    expect(byUnit(await outcomesOf(f))).toEqual({ collectors: ["pending", null], place: ["pending", null] });
    const stopped = await rows(f.conn, `SELECT stopped_row FROM upload_applied`);
    expect(stopped[0]![0]).toBe(await rowOf(f, t));
    expect(await applyWaiting(f.db)).toBe(false);
    expect(await (await f.app.request(location)).text()).toContain(esc(en.uploads.page.samplesStopped(await rowOf(f, t))));
    expect(await clearStopped(f.db, await uploadId(f))).toBe(true);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, applied: 2 });
    // The collectors' own warnings are kept with the change that made them.
    expect(byUnit(await outcomesOf(f))).toEqual({ collectors: ["applied", expect.stringContaining("now has what its collectors have")], place: ["applied", null] });
  });

  it("is left pending when the store write loses a conflict, and sending it again applies it", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { samplingProtocol: "pan trap" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await expect(applyPending(deps(f, { db: losingOnce(createKysely(f.instance), "transaction") }))).rejects.toThrow(/was not done: not_applied/);
    // Nothing was kept elsewhere for a sample entered in Beeline, and the note says so.
    expect(byUnit(await outcomesOf(f))).toEqual({ method_dates: ["pending", c.notAppliedNothingKept] });
    expect(await rows(f.conn, `SELECT protocol FROM sample WHERE entity_id = ${t}`)).toEqual([["vane trap"]]);
    expect(await clearStopped(f.db, await uploadId(f))).toBe(true);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, applied: 1 });
    expect(await rows(f.conn, `SELECT protocol FROM sample WHERE entity_id = ${t}`)).toEqual([["pan trap"]]);
  });

  it("is not made for somebody who has stopped being staff", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { locality: "Albany" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await f.conn.run(`DELETE FROM person_admin WHERE person_id = ${f.staffer}`);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, notApplied: 1 });
    expect(byUnit(await outcomesOf(f))).toEqual({ place: ["refused", c.noLongerStaff] });
  });
});

describe("a file with new rows and changes", () => {
  it("applies both, and the page and the notes say what became of each", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { locality: "Albany" } }], [
      { fieldNumber: "OBAS-00011", recordedBy: "Vera Volunteer", eventDate: day(10), samplingProtocol: "vane trap", trapCount: "6", specimenCount: "2", decimalLatitude: "44.9", decimalLongitude: "-123.2", coordinateUncertaintyInMeters: "50", countryCode: "US", stateProvince: "OR", county: "Benton", locality: "Fir Butte" },
    ]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    expect(await applyPending(deps(f))).toEqual({ created: 1, refused: 0, skipped: 0, stopped: 0, applied: 1 });
    const html = await (await f.app.request(location)).text();
    expect(html).toContain(esc(en.uploads.page.samplesCreated(1, 0)));
    expect(html).toContain(esc(en.uploads.page.samplesChangedCount(1, 1, in1)));
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE sample_number = 'OBAS-00011'`)).toEqual([[1n]]);
    expect(await rows(f.conn, `SELECT locality FROM sample WHERE entity_id = ${t}`)).toEqual([["Albany"]]);
    expect(await noteOf(f, location, t)).toContain(n.unitApplied(n.appliedCell("locality", '"Corvallis"', '"Albany"')));
    expect(SAMPLES_UNITS.length).toBe(7);
  });
});

describe("the trap count after a method change on an old sample (beeline-ni5m.15)", () => {
  const oldTrap = async (f: UploadFixture, effort: string) => {
    const o = await trapSample(f, { sample_number: "'O-5'", protocol: "'pan trap'", sampling_effort: `'${effort}'` }, false);
    await oldRecords(f, o, "rec-5", "pan trap");
    return o;
  };
  const held = (f: UploadFixture, id: number) => rows(f.conn, `SELECT s.protocol, m.method_code, m.trap_count, s.sampling_effort FROM sample s JOIN sample_method m ON m.sample_id = s.entity_id WHERE s.entity_id = ${id}`);

  it("stays with the sample when the new method is a trap, with the old effort column written from it", async () => {
    const f = await uploadFixture();
    const o = await oldTrap(f, "6 pan traps");
    const { location, digest } = await offered(f, [{ id: o, set: { samplingProtocol: "vane trap" } }]);
    expect((await apply(f, location, { digest, kinds: ["method_dates"] })).status).toBe(303);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, applied: 1 });
    expect(await held(f, o)).toEqual([["vane trap", "vane trap", 6, "6 vane traps"]]);
    expect(await rows(f.conn, `SELECT count(*) FROM sample_method_out_of_step`)).toEqual([[0n]]);
  });

  it("goes when the new method is not a trap", async () => {
    const f = await uploadFixture();
    const o = await oldTrap(f, "6 pan traps");
    const { location, digest } = await offered(f, [{ id: o, set: { samplingProtocol: "aerial net" } }]);
    expect((await apply(f, location, { digest, kinds: ["method_dates"] })).status).toBe(303);
    await applyPending(deps(f));
    expect(await held(f, o)).toEqual([["aerial net", "aerial net", null, null]]);
    expect(await rows(f.conn, `SELECT count(*) FROM sample_method_out_of_step`)).toEqual([[0n]]);
  });
});

describe("a stop on a method and dates change, whose file rows are put back", () => {
  it("says nothing was kept on the change and the page, and a retry that finds the sample changed is refused plainly", async () => {
    const f = await uploadFixture();
    const o = await trapSample(f, { sample_number: "'O-6'" }, false);
    await oldRecords(f, o, "rec-6", "vane trap");
    const { location, digest } = await offered(f, [{ id: o, set: { samplingProtocol: "pan trap" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await expect(applyPending(deps(f, { db: losingOnce(createKysely(f.instance), "transaction") }))).rejects.toThrow(/not_applied/);
    expect(byUnit(await outcomesOf(f))).toEqual({ method_dates: ["pending", c.notAppliedNothingKept] });
    expect(await (await f.app.request(location)).text()).toContain(esc(c.notAppliedNothingKept));
    // The sample changed meanwhile, so the retry is refused; nothing is left over in the file.
    await f.conn.run(`UPDATE sample SET protocol = 'malaise trap' WHERE entity_id = ${o}`);
    expect(await clearStopped(f.db, await uploadId(f))).toBe(true);
    await applyPending(deps(f));
    expect(byUnit(await outcomesOf(f))).toEqual({ method_dates: ["refused", c.changedSince("samplingProtocol", "malaise trap")] });
  });
});

describe("collectors", () => {
  it("warn in the preview when the first collector changes, and the applied change records the real call's warnings", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, html, digest } = await offered(f, [{ id: t, set: { recordedBy: "Sam Staff | Vera Volunteer" } }]);
    expect(html).toContain(esc(en.uploads.page.firstCollectorLine(1, in1, 0)));
    const note = await noteOf(f, location, t);
    expect(note).toContain("Sam Staff is now the first collector, in place of Vera Volunteer");
    expect((await apply(f, location, { digest })).status).toBe(303);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, applied: 1 });
    const [detail] = (await outcomesOf(f)).map((o) => o.detail);
    expect(String(detail)).toContain("Sam Staff is now the first collector");
    expect(await noteOf(f, location, t)).toContain("Sam Staff is now the first collector");
  });
});

describe("the counts on the page", () => {
  it("are split by season, as every other count is", async () => {
    const f = await uploadFixture();
    const { html } = await offered(f, [
      { id: f.ids.sampleA, set: { county: "Linn" } },
      { id: f.ids.sampleB, set: { county: "Linn" } },
    ]);
    expect(html).toContain(esc(en.uploads.page.changesLine(2, en.uploads.page.split(1, 1, 0))));
  });
});

describe("words and notes", () => {
  it("say an undone upload's change was not made, not that it was not created", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { locality: "Albany" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await settleUndone(f.db, await uploadId(f));
    expect(byUnit(await outcomesOf(f))).toEqual({ place: ["skipped", "The upload was undone, so this change was not made."] });
  });

  it("do not break the download of the notes when a stored payload cannot be read: the change's label stands in", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { locality: "Albany" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await applyPending(deps(f));
    await f.conn.run(`UPDATE upload_sample_outcome SET payload = 'not json' WHERE unit = 'place'`);
    expect(await noteOf(f, location, t)).toContain(n.unitApplied("locality"));
  });

  it("give a printed entered sample's locality a sentence that does not send staff elsewhere", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    await f.conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${t}, 1, 'OBA20001')`);
    const { location } = await offered(f, [{ id: t, set: { locality: "Albany" } }]);
    const note = await noteOf(f, location, t);
    expect(note).toContain(n.mayNot("locality", c.localityPrinted));
    expect(c.localityPrinted).not.toContain("Staff correct it");
  });
});

describe("the method page", () => {
  it("refuses a method change while a print run that has not printed holds the sample, as the upload does", async () => {
    const f = await uploadFixture("staffer", { unprinted: true });
    await f.conn.run(`UPDATE sample SET kind = 'trap', date_end = date_end + 3, protocol = 'vane trap' WHERE entity_id = ${f.ids.sampleC}`);
    await f.conn.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES (${f.ids.sampleC}, ${f.staffer})`);
    const body = new FormData();
    body.set("protocol", "pan trap");
    body.set("date_end", day(17));
    const res = await f.app.request(`/samples/${f.ids.sampleC}/method`, { method: "POST", headers: { origin: ORIGIN }, body });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(en.record.sample.methodEdit.inPrintRun);
  });
});

describe("the page shown after a refused Apply", () => {
  it("keeps the ticks that were posted: kinds, create anyway and the OBAS box", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const looksLike = { fieldNumber: "OBAS-00011", recordedBy: "Vera Volunteer", eventDate: day(14), samplingProtocol: "vane trap", trapCount: "6", specimenCount: "2", decimalLatitude: "44.5650", decimalLongitude: "-123.2620", coordinateUncertaintyInMeters: "50", countryCode: "US", stateProvince: "OR", county: "Benton", locality: "Fir Butte" };
    const { location } = await offered(f, [{ id: t, set: { trapCount: "8", locality: "Albany", decimalLatitude: "44.5934" } }], [looksLike]);
    const refused = await apply(f, location, { digest: "0".repeat(32), kinds: ["coordinates"], anyway: [await rowOfNew(f, location)], obas: true });
    expect(refused.status).toBe(409);
    const html = await refused.text();
    // What was ticked is ticked again, and what was not is not: the defaults do not come back.
    expect(html).toMatch(/name="kind" value="coordinates" checked=""\/>/);
    expect(html).toMatch(/name="kind" value="place"\/>/);
    expect(html).toMatch(/name="kind" value="trap_count"\/>/);
    expect(html).toMatch(/name="anyway" value="\d+" checked=""/);
    expect(html).toMatch(/name="obas" value="1" checked=""\/>/);
    expect(await rows(f.conn, `SELECT count(*) FROM upload_applied`)).toEqual([[0n]]);
  });
});

describe("the method's number check", () => {
  const post = (f: UploadFixture, id: number, fields: Record<string, string>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    return f.app.request(`/samples/${id}/method`, { method: "POST", headers: { origin: ORIGIN }, body });
  };
  const netSample = async (f: UploadFixture, number: string, record: string) => {
    const id = await insertCleanSample(f.conn, { sample_number: `'${number}'`, date_start: `DATE '${day(22)}'`, date_end: `DATE '${day(22)}'`, collector_id: String(f.volunteer) });
    await oldRecords(f, id, record, "aerial net");
    return id;
  };

  it("lets a net sample become a trap sample whatever other samples have its number: the method decides nothing", async () => {
    const f = await uploadFixture();
    await trapSample(f, { sample_number: "'7'", date_start: `DATE '${day(22)}'`, date_end: `DATE '${day(22)}'` });
    const net = await netSample(f, "7", "rec-b");
    const res = await post(f, net, { protocol: "pan trap", date_end: day(25) });
    expect(res.status).toBeLessThan(400);
    expect(await rows(f.conn, `SELECT kind FROM sample WHERE entity_id = ${net}`)).toEqual([["trap"]]);
  });

  it("refuses a start day that gives the sample's number to a day its collector already has it on", async () => {
    const f = await uploadFixture();
    await trapSample(f, { sample_number: "'7'", date_start: `DATE '${day(23)}'`, date_end: `DATE '${day(23)}'` });
    const net = await netSample(f, "7", "rec-s");
    const res = await post(f, net, { protocol: "aerial net", date_start: day(23), date_end: day(23) });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(en.record.sample.methodEdit.numberTaken("7"));
    expect(await rows(f.conn, `SELECT CAST(date_start AS VARCHAR) FROM sample WHERE entity_id = ${net}`)).toEqual([[day(22)]]);
    // A form left open while another edit moved the sample still submits the old day as its base: untouched, so no check.
    await trapSample(f, { sample_number: "'8'", date_start: `DATE '${day(22)}'`, date_end: `DATE '${day(22)}'` });
    const moved = await netSample(f, "8", "rec-m");
    await f.conn.run(`UPDATE sample SET date_start = DATE '${day(24)}', date_end = DATE '${day(24)}' WHERE entity_id = ${moved}`);
    const stale = await post(f, moved, { protocol: "aerial net", date_start: day(22), date_end: day(22), "base:date_start": day(22), "base:date_end": day(22) });
    expect(stale.status).not.toBe(409);
    // Another day is free.
    expect((await post(f, net, { protocol: "aerial net", date_start: day(24), date_end: day(24) })).status).toBeLessThan(400);
  });
});

describe("a change that is already in place", () => {
  it("is unchanged, not refused as changed since: the correction committed or staff did it by hand", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { locality: "Albany" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await f.conn.run(`UPDATE sample SET locality = 'Albany' WHERE entity_id = ${t}`);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, unchanged: 1 });
    expect(byUnit(await outcomesOf(f))).toEqual({ place: ["unchanged", null] });
  });
});

describe("the counts after applying", () => {
  it("are split by season", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [
      { id: t, set: { locality: "Albany" } },
      { id: f.ids.sampleB, set: { county: "Linn" } },
    ]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await applyPending(deps(f));
    const html = await (await f.app.request(location)).text();
    expect(html).toContain(esc(en.uploads.page.samplesChangedCount(2, 2, en.uploads.page.split(1, 1, 0))));
  });
});

describe("an undone upload", () => {
  it("settles a method and dates change that was not applied as not made, with the stop cleared", async () => {
    const f = await uploadFixture();
    const o = await trapSample(f, { sample_number: "'O-7'" }, false);
    await oldRecords(f, o, "rec-7", "vane trap");
    const { location, digest } = await offered(f, [{ id: o, set: { samplingProtocol: "pan trap" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await expect(applyPending(deps(f, { db: losingOnce(createKysely(f.instance), "transaction") }))).rejects.toThrow(/not_applied/);
    await settleUndone(f.db, await uploadId(f));
    expect(byUnit(await outcomesOf(f))).toEqual({ method_dates: ["skipped", "The upload was undone, so this change was not made."] });
    expect(await rows(f.conn, `SELECT stopped_at FROM upload_applied`)).toEqual([[null]]);
  });
});

describe("what the job does not trust", () => {
  it("compares a cell the file does not carry: an uncertainty changed since the download is not written back", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const location = await upload(f, edited(await download(f), [{ id: t, set: { decimalLatitude: "44.5934" } }], { idColumn: "sampleId", dropColumns: ["coordinateUncertaintyInMeters"] }));
    const digest = digestIn(await (await f.app.request(location)).text());
    expect((await apply(f, location, { digest, kinds: ["coordinates"] })).status).toBe(303);
    await f.conn.run(`UPDATE sample_location SET coordinate_uncertainty_m = 99 WHERE sample_id = ${t}`);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, notApplied: 1 });
    expect(byUnit(await outcomesOf(f))).toEqual({ coordinates: ["refused", c.changedSince("coordinateUncertaintyInMeters", "99")] });
    expect(await rows(f.conn, `SELECT latitude, coordinate_uncertainty_m FROM sample_location WHERE sample_id = ${t}`)).toEqual([[44.5646, 99]]);
  });

  it("applies a method-only change on an old sample linked to an observation, since its start date is unchanged", async () => {
    const f = await uploadFixture();
    const o = await trapSample(f, { sample_number: "'O-8'", inat_observation_id: "4455" }, false);
    await oldRecords(f, o, "rec-8", "vane trap");
    const { location, digest } = await offered(f, [{ id: o, set: { samplingProtocol: "pan trap" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, applied: 1 });
    expect(await rows(f.conn, `SELECT protocol FROM sample WHERE entity_id = ${o}`)).toEqual([["pan trap"]]);
  });

  it("refuses a stored change missing what it is written from, and goes on with the rest of the row", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { recordedBy: "Vera Volunteer | Sam Staff", locality: "Albany" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await f.conn.run(`UPDATE upload_sample_outcome SET payload = '{"change":{"unit":"collectors"},"cells":[]}' WHERE unit = 'collectors'`);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, applied: 1, notApplied: 1 });
    expect(byUnit(await outcomesOf(f))).toEqual({ collectors: ["refused", expect.stringContaining("cannot be read")], place: ["applied", null] });
  });
});

describe("what a run says of itself", () => {
  it("counts refused rows and changes not applied apart", () => {
    expect(describeApply({ created: 1, refused: 2, skipped: 0, stopped: 0, applied: 3, unchanged: 1, notApplied: 4 })).toBe(
      "1 trap sample(s) created, 3 change(s) applied, 1 already as the file says, 4 change(s) not applied, 2 row(s) refused, 0 left alone",
    );
  });
});

describe("notes for somebody who is no longer staff", () => {
  it("say a change was refused because the sample changed, without what Beeline holds now", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { locality: "Albany" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await f.conn.run(`UPDATE sample SET locality = 'Secret place' WHERE entity_id = ${t}`);
    await applyPending(deps(f));
    expect(await noteOf(f, location, t)).toContain("Secret place");
    await f.conn.run(`DELETE FROM person_admin WHERE person_id = ${f.staffer}`);
    const notes = matrixOf(new Uint8Array(await (await f.app.request(`${location}/notes`)).arrayBuffer()));
    const text = notes.flat().join(" ");
    expect(text).toContain(c.changedSinceBare);
    expect(text).not.toContain("Secret place");
  });
});

describe("an area after a point whose derivation was deferred", () => {
  it("is not compared with the old county: the note says the place will follow the point when it is worked out", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { decimalLatitude: "44.5934", county: "Linn" } }]);
    expect((await apply(f, location, { digest, kinds: ["coordinates", "area"] })).status).toBe(303);
    // No gazetteer here, so the county, state and country are not worked out.
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 1, stopped: 0, applied: 1 });
    expect(byUnit(await outcomesOf(f))).toEqual({ coordinates: ["applied", c.pointDeferred], area: ["skipped", c.areaFollowsDeferred] });
  });
});
