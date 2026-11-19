import { readFile } from "node:fs/promises";
import type { Kysely } from "kysely";
import { describe as describeInOrder, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { Database } from "../src/model.js";
import { en } from "../src/app/messages/en.js";
import { APPLY_ORDER } from "../src/app/samples-upload-change.js";
import { applyPending, applyWaiting, clearStopped } from "../src/app/samples-upload-apply.js";
import { SAMPLES_UNITS } from "../src/app/samples-upload-plan.js";
import { parseSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { duckdbReader } from "../src/person-change.js";
import { CURRENT_SEASON, insertCleanSample, rows } from "./helpers.js";
import { UPLOAD_TODAY, edited, matrixOf, uploadFixture, type UploadFixture } from "./upload-fixture.js";
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
const apply = (f: UploadFixture, location: string, fields: { digest?: string; kinds?: readonly string[] }) => {
  const body = new FormData();
  if (fields.digest !== undefined) body.set("digest", fields.digest);
  body.set("obas", "1");
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
function losingOnce(db: Kysely<Database>): Kysely<Database> {
  let fired = false;
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
      if (prop === "updateTable" && !fired) {
        fired = true;
        return (...args: unknown[]) => losing((target.updateTable as (...a: unknown[]) => object)(...args));
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
    expect(html).toContain(esc(en.uploads.page.changesLine(1)));
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
    expect(after).toContain(esc(en.uploads.page.samplesChangedCount(1, 5)));
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
    expect(after).toContain(esc(en.uploads.page.changesNotChosen(1)));
    expect(await noteOf(f, location, t)).toContain(n.unitNotApplied("trap count", c.notChosen));
  });

  it("does not tick coordinates at first, says how far each point moves, and records an unticked kind as not chosen", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    // 0.0288 degrees of latitude is 3.2 km.
    const { location, html, digest } = await offered(f, [{ id: t, set: { decimalLatitude: "44.5934", locality: "Albany" } }]);
    expect(html).toContain(esc(en.uploads.page.pointsLine(1, 1, "3.2 km")));
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
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 1, stopped: 0, applied: 1 });
    expect(byUnit(await outcomesOf(f))).toEqual({
      coordinates: ["applied", null],
      area: ["skipped", c.areaFollowsPoint("USA, OR, BentonCo", "USA, OR, Linn")],
    });
    expect(await rows(f.conn, `SELECT latitude FROM sample_location WHERE sample_id = ${t}`)).toEqual([[44.5934]]);
    expect(await rows(f.conn, `SELECT county FROM sample WHERE entity_id = ${t}`)).toEqual([["BentonCo"]]);
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
  it("is shown in the preview with the correction's sentence, is not queued, and is recorded as refused", async () => {
    const f = await uploadFixture();
    // A net sample: it has no trap count and no specimen count to correct.
    const { location, html, digest } = await offered(f, [{ id: f.ids.sampleA, set: { trapCount: "5", specimenCount: "9" } }], [
      { fieldNumber: "OBAS-00011", recordedBy: "Vera Volunteer", eventDate: day(10), samplingProtocol: "vane trap", trapCount: "6", specimenCount: "2", decimalLatitude: "44.9", decimalLongitude: "-123.2", coordinateUncertaintyInMeters: "50", countryCode: "US", stateProvince: "OR", county: "Benton", locality: "Fir Butte" },
    ]);
    expect(html).toContain(esc(en.uploads.page.cantApplyLine(2)));
    expect(await noteOf(f, location, f.ids.sampleA)).toContain(n.cantApply("trap count", en.record.sample.trapCount.problems.net));
    expect((await apply(f, location, { digest })).status).toBe(303);
    // Settled when the file was applied: nothing for the job to do for them.
    const row = await rowOf(f, f.ids.sampleA);
    expect(byUnit(await outcomesOf(f, row))).toEqual({
      trap_count: ["refused", en.record.sample.trapCount.problems.net],
      specimen_count: ["refused", en.record.sample.specimenCount.problems.net],
    });
    expect(await applyPending(deps(f))).toEqual({ created: 1, refused: 0, skipped: 0, stopped: 0 });
    expect(await rows(f.conn, `SELECT specimen_count FROM sample WHERE entity_id = ${f.ids.sampleA}`)).toEqual([[3]]);
  });

  it("is predicted for a start date on a sample with an observation, a method on a sample nothing backs, a print run and a number taken", async () => {
    const f = await uploadFixture("staffer", { unprinted: true });
    // An old sample with an observation: iNaturalist holds its start.
    const withObservation = await trapSample(f, { sample_number: "'X-1'", date_start: `DATE '${day(20)}'`, date_end: `DATE '${day(20)}'`, inat_observation_id: "12345" }, false);
    await oldRecords(f, withObservation, "rec-x", "vane trap");
    // An old net sample whose number a trap sample has, which a range of days would make a trap sample.
    const net = await insertCleanSample(f.conn, { sample_number: "'N-2'", date_start: `DATE '${day(22)}'`, date_end: `DATE '${day(22)}'`, collector_id: String(f.volunteer) });
    await oldRecords(f, net, "rec-n", "aerial net");
    await trapSample(f, { sample_number: "'N-2'" });
    // A trap sample whose labels are in a print run that has not printed.
    await f.conn.run(`UPDATE sample SET kind = 'trap', date_end = date_end + 3, protocol = 'vane trap' WHERE entity_id = ${f.ids.sampleC}`);
    await f.conn.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES (${f.ids.sampleC}, ${f.staffer})`);
    const { location } = await offered(f, [
      { id: withObservation, set: { eventDate: day(21) } },
      { id: net, set: { eventDate: `${day(22)}/${day(25)}` } },
      { id: f.ids.sampleC!, set: { samplingProtocol: "pan trap" } },
      { id: f.ids.sampleB, set: { samplingProtocol: "pan trap" } },
    ]);
    expect(await noteOf(f, location, withObservation)).toContain(n.cantApply("method and dates", en.record.sample.methodEdit.problems.start_observation));
    expect(await noteOf(f, location, net)).toContain(n.cantApply("method and dates", c.becomesTrapNumberTaken("N-2")));
    expect(await noteOf(f, location, f.ids.sampleC!)).toContain(n.cantApply("method and dates", c.methodInPrintRun));
    expect(await noteOf(f, location, f.ids.sampleB)).toContain(n.cantApply("method and dates", en.record.sample.methodEdit.noOldRecords));
  });

  it("is predicted for a specimen count below the highest specimen number already given", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f, { specimen_count: "3" });
    for (const k of [1, 2, 3]) await f.conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${t}, ${k}, NULL)`);
    const { location, digest } = await offered(f, [{ id: t, set: { specimenCount: "1", trapCount: "8" } }]);
    expect(await noteOf(f, location, t)).toContain(n.cantApply("specimen count", en.record.sample.specimenCount.problems.numbered(3)));
    expect((await apply(f, location, { digest })).status).toBe(303);
    expect(byUnit(await outcomesOf(f))).toMatchObject({ specimen_count: ["refused", en.record.sample.specimenCount.problems.numbered(3)] });
  });

  it("is recorded with the correction's own sentence when the job meets it: a locality on a sample with no record to keep it against", async () => {
    const f = await uploadFixture();
    await legacyTables(f);
    const { location, digest } = await offered(f, [{ id: f.ids.sampleB, set: { locality: "Albany" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 1, skipped: 0, stopped: 0 });
    const [placed] = await outcomesOf(f);
    expect(placed).toMatchObject({ unit: "place", outcome: "refused" });
    expect(placed!.detail).toContain("No old Beeline record backs this sample");
    expect(await noteOf(f, location, f.ids.sampleB)).toContain(n.unitNotApplied("locality", placed!.detail!));
  });
});

describe("the row's version", () => {
  it("is checked once, before the row's first change: a sample changed in Beeline since the download has every change refused", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { trapCount: "8", locality: "Albany" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    // Somebody corrects the sample between the button and the job.
    await f.conn.run(`UPDATE sample SET specimen_count = 5 WHERE entity_id = ${t}`);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 2, skipped: 0, stopped: 0 });
    expect(byUnit(await outcomesOf(f))).toEqual({ trap_count: ["refused", c.versionChanged], place: ["refused", c.versionChanged] });
    expect(await rows(f.conn, `SELECT sampling_effort, locality FROM sample WHERE entity_id = ${t}`)).toEqual([["6 vane traps", "Corvallis"]]);
  });

  it("is not checked again for a row resumed after a stop, whose own earlier writes changed it", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { trapCount: "8", specimenCount: "4" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    // The first change was made before the run stopped.
    await f.conn.run(`UPDATE sample SET sampling_effort = '8 vane traps' WHERE entity_id = ${t}`);
    await f.conn.run(`UPDATE upload_sample_outcome SET outcome = 'applied' WHERE unit = 'trap_count'`);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, applied: 1 });
    expect(byUnit(await outcomesOf(f))).toEqual({ trap_count: ["applied", null], specimen_count: ["applied", null] });
    expect(await rows(f.conn, `SELECT specimen_count FROM sample WHERE entity_id = ${t}`)).toEqual([[4]]);
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
    expect(byUnit(await outcomesOf(f))).toEqual({ collectors: ["applied", null], place: ["applied", null] });
  });

  it("is left pending when the store write loses a conflict, and sending it again applies it", async () => {
    const f = await uploadFixture();
    const t = await trapSample(f);
    const { location, digest } = await offered(f, [{ id: t, set: { samplingProtocol: "pan trap" } }]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    await expect(applyPending(deps(f, { db: losingOnce(createKysely(f.instance)) }))).rejects.toThrow(/was not done: not_applied/);
    expect(byUnit(await outcomesOf(f))).toEqual({ method_dates: ["pending", null] });
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
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 1, skipped: 0, stopped: 0 });
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
    expect(html).toContain(esc(en.uploads.page.samplesChangedCount(1, 1)));
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE sample_number = 'OBAS-00011'`)).toEqual([[1n]]);
    expect(await rows(f.conn, `SELECT locality FROM sample WHERE entity_id = ${t}`)).toEqual([["Albany"]]);
    expect(await noteOf(f, location, t)).toContain(n.unitApplied(n.appliedCell("locality", '"Corvallis"', '"Albany"')));
    expect(SAMPLES_UNITS.length).toBe(7);
  });
});
