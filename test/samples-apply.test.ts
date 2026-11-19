import { readFile } from "node:fs/promises";
import { describe as describeInOrder, expect, it } from "vitest";
import { en } from "../src/app/messages/en.js";
import { APPLY_JOB, applyPending, applyWaiting } from "../src/app/samples-upload-apply.js";
import { buildJobs } from "../src/app/jobs/registry.js";
import { startScheduler, runJob } from "../src/app/jobs/framework.js";
import { checkTrapSample, findLookalikes, createTrapSample, deleteTrapSample, seriesNumberProblem, seriesReach, SERIES_MARGIN } from "../src/trap-sample.js";
import { parseSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { duckdbReader } from "../src/person-change.js";
import { CURRENT_SEASON, rows } from "./helpers.js";
import { edited, matrixOf, uploadFixture, type UploadFixture } from "./upload-fixture.js";
import type { TestCell } from "./workbook.js";

/** The tests run at the same time: each has a store of its own, copied from one made once. */
const describe = describeInOrder.concurrent;

const ORIGIN = "http://localhost:3054";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const day = (n: number, month = "07") => `${CURRENT_SEASON}-${month}-${String(n).padStart(2, "0")}`;
const esc = (text: string) => text.replaceAll("'", "&#39;");

/** A new row with nothing wrong, 8 km from the fixture's samples. */
const ready = {
  fieldNumber: "OBAS-00011",
  recordedBy: "Vera Volunteer",
  eventDate: day(10),
  samplingProtocol: "vane trap",
  trapCount: "6",
  specimenCount: "2",
  decimalLatitude: "44.5",
  decimalLongitude: "-123.2",
  coordinateUncertaintyInMeters: "50",
  countryCode: "US",
  stateProvince: "OR",
  county: "Benton",
  locality: "Fir Butte",
};
const newRow = (n: number, over: Record<string, TestCell> = {}) => ({ ...ready, fieldNumber: `OBAS-${String(10 + n).padStart(5, "0")}`, ...over });

const download = async (f: UploadFixture) => new Uint8Array(await (await f.app.request("/samples.xlsx?scope=all")).arrayBuffer());
const upload = async (f: UploadFixture, file: Uint8Array, app = f.app) => {
  const body = new FormData();
  body.set("file", new File([file as BlobPart], "samples.xlsx", { type: XLSX }));
  const res = await app.request("/uploads", { method: "POST", headers: { origin: ORIGIN }, body });
  expect(res.status).toBe(303);
  return res.headers.get("location")!;
};
const pageAt = async (f: UploadFixture, location: string, app = f.app) => (await app.request(location)).text();
const digestIn = (html: string) => /name="digest" value="([0-9a-f]+)"/.exec(html)?.[1];
const apply = (f: UploadFixture, location: string, fields: { digest?: string; anyway?: number[] }, app = f.app) => {
  const body = new FormData();
  if (fields.digest !== undefined) body.set("digest", fields.digest);
  for (const r of fields.anyway ?? []) body.append("anyway", String(r));
  return app.request(`${location}/apply-samples`, { method: "POST", headers: { origin: ORIGIN }, body });
};
/** A file of new rows uploaded and its page read: the location, the digest, the page. */
const offered = async (f: UploadFixture, added: Array<Record<string, TestCell>>) => {
  const location = await upload(f, edited(await download(f), [], { idColumn: "sampleId", addRows: added }));
  const html = await pageAt(f, location);
  return { location, html, digest: digestIn(html) };
};
const outcomes = (f: UploadFixture) => rows(f.conn, `SELECT row_number, outcome, sample_number, detail FROM upload_sample_outcome ORDER BY row_number`);
const deps = (f: UploadFixture, over = {}) => ({ db: f.db, conn: f.conn, printWriter: f.conn, samplePaths: { log: f.paths.sampleChangesPath, state: f.paths.sampleStatePath }, ...over });
const baseline = (f: UploadFixture) => recordSampleChanges(duckdbReader(f.conn), { log: f.paths.sampleChangesPath, state: f.paths.sampleStatePath }, { source: "reconcile" });

describe("the Apply button", () => {
  it("is offered to the staff member who uploaded the file, with a digest, and to nobody else", async () => {
    const f = await uploadFixture();
    const { location, html, digest } = await offered(f, [newRow(1)]);
    expect(html).toContain(`action="${location}/apply-samples"`);
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
    expect(html).toContain(esc(en.uploads.page.samplesNothingChanged));
    expect(html).toContain(en.uploads.page.samplesApply);
    // Another staff member sees the page and cannot apply it; a volunteer cannot see it.
    const other = f.appAs("volunteer");
    expect((await other.request(location)).status).toBe(404);
    expect((await apply(f, location, { digest }, other)).status).toBe(404);
    // Nothing queued by any of that.
    expect(await outcomes(f)).toEqual([]);
  });

  it("is not offered for a file with no new row ready, and the page says existing samples are not applied", async () => {
    const f = await uploadFixture();
    const location = await upload(f, edited(await download(f), [{ id: f.ids.sampleA, set: { locality: "Albany" } }], { idColumn: "sampleId" }));
    const html = await pageAt(f, location);
    expect(html).not.toContain("apply-samples");
    expect(html).toContain(esc(en.uploads.page.samplesNothingChanged));
    expect(en.uploads.page.samplesNothingChanged).toContain("Changes to existing samples aren't applied yet");
  });
});

describe("applying", () => {
  it("queues the rows in one claim, starts the job, and writes no sample by itself", async () => {
    const started: string[] = [];
    const f = await uploadFixture("staffer", { jobs: { list: [], start: async (name) => (started.push(name), true) } });
    const { location, digest } = await offered(f, [newRow(1), newRow(2)]);
    const res = await apply(f, location, { digest });
    expect(res.status).toBe(303);
    expect(started).toEqual([APPLY_JOB]);
    expect(await outcomes(f)).toEqual([
      [expect.any(Number), "pending", "OBAS-00011", null],
      [expect.any(Number), "pending", "OBAS-00012", null],
    ]);
    expect(await rows(f.conn, `SELECT applied_by, draft_count FROM upload_applied`)).toEqual([[f.staffer, 2]]);
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE sample_number LIKE 'OBAS-%'`)).toEqual([[0n]]);
    // The page says so while they wait, and asks again by itself.
    const page = await f.app.request(location);
    expect(page.headers.get("refresh")).toBe("5");
    const html = await page.text();
    expect(html).toContain(esc(en.uploads.page.samplesApplying(0, 2)));
    expect(await applyWaiting(f.db)).toBe(true);
  });

  it("is refused with a changed page when the digest is not the plan's, and writes nothing", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1)]);
    // Somebody takes the number between the page and the button.
    await f.conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end, country, state_province, protocol)
      VALUES ('trap', 'OBAS-00011', DATE '${day(1)}', DATE '${day(2)}', 'USA', 'OR', 'vane trap')`);
    const stale = await apply(f, location, { digest });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain(esc(en.uploads.page.samplesChangedSince));
    const wrong = await apply(f, location, { digest: "0".repeat(32) });
    expect(wrong.status).toBe(409);
    expect(await rows(f.conn, `SELECT count(*) FROM upload_applied`)).toEqual([[0n]]);
    expect(await rows(f.conn, `SELECT count(*) FROM upload_sample_outcome`)).toEqual([[0n]]);
  });

  it("queues the rows once when the button is pressed twice", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1), newRow(2)]);
    const [a, b] = await Promise.all([apply(f, location, { digest }), apply(f, location, { digest })]);
    expect([a.status, b.status]).toEqual([303, 303]);
    expect(await rows(f.conn, `SELECT count(*) FROM upload_applied`)).toEqual([[1n]]);
    expect(await rows(f.conn, `SELECT count(*) FROM upload_sample_outcome`)).toEqual([[2n]]);
    // And after the first, a later submission is told what was done.
    expect((await apply(f, location, { digest })).status).toBe(303);
    expect(await rows(f.conn, `SELECT count(*) FROM upload_sample_outcome`)).toEqual([[2n]]);
  });

  it("is refused while the nightly runs, and while viewing as somebody else", async () => {
    const f = await uploadFixture("staffer", { jobs: { list: [], start: async () => true, running: () => "nightly-pipeline" } });
    const { location, digest } = await offered(f, [newRow(1)]);
    const busy = await apply(f, location, { digest });
    expect(busy.status).toBe(409);
    expect(await busy.text()).toContain(esc(en.uploads.page.samplesBusy));
    expect(await rows(f.conn, `SELECT count(*) FROM upload_applied`)).toEqual([[0n]]);
    // Not the apply-uploads job itself: it is not a sweep.
    const own = await uploadFixture("staffer", { jobs: { list: [], start: async () => true, running: () => APPLY_JOB } });
    const second = await offered(own, [newRow(1)]);
    expect((await apply(own, second.location, { digest: second.digest })).status).toBe(303);
  });
});

describe("the job", () => {
  it("creates each row in file order as a trap sample, with its outcome and a history entry that names the upload", async () => {
    const f = await uploadFixture();
    await f.conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${f.staffer}, 1, 'sam_s')`);
    await baseline(f);
    const { location, digest } = await offered(f, [newRow(1), newRow(2, { recordedBy: `${f.volunteer} | ${f.staffer}` })]);
    await apply(f, location, { digest });
    const result = await applyPending(deps(f));
    expect(result).toEqual({ created: 2, refused: 0, skipped: 0 });
    const made = await rows(f.conn, `SELECT o.row_number, o.outcome, o.sample_number, s.sample_number, s.kind, e.entered_by
      FROM upload_sample_outcome o JOIN sample s ON s.entity_id = o.sample_id JOIN sample_entry e ON e.sample_id = s.entity_id ORDER BY 1`);
    expect(made.map((r) => r.slice(1))).toEqual([
      ["created", "OBAS-00011", "OBAS-00011", "trap", f.staffer],
      ["created", "OBAS-00012", "OBAS-00012", "trap", f.staffer],
    ]);
    expect(await rows(f.conn, `SELECT p.person_id, p.position FROM sample_collector p JOIN sample s ON s.entity_id = p.sample_id WHERE s.sample_number = 'OBAS-00012' ORDER BY 2`)).toEqual([[f.volunteer, 1], [f.staffer, 2]]);
    const log = parseSampleChanges(await readFile(f.paths.sampleChangesPath, "utf8")).changes.filter((c) => c.sample_number.startsWith("OBAS-"));
    expect(log.length).toBeGreaterThan(0);
    expect(new Set(log.map((c) => c.source))).toEqual(new Set(["upload"]));
    expect(new Set(log.map((c) => c.reason))).toEqual(new Set([`From upload ${(await rows(f.conn, `SELECT entity_id FROM upload`))[0]![0]}`]));
    expect(new Set(log.map((c) => c.author))).toEqual(new Set(["sam_s"]));
    // The page says what was done, and the file with notes names each sample.
    const html = await pageAt(f, location);
    expect(html).toContain(esc(en.uploads.page.samplesCreated(2)));
    const notes = matrixOf(new Uint8Array(await (await f.app.request(`${location}/notes`)).arrayBuffer()));
    const head = notes[0]!;
    const note = (number: string) => notes.find((r) => r[head.indexOf("fieldNumber")] === number)![head.length - 1];
    expect(note("OBAS-00011")).toBe(en.uploads.notes.created("OBAS-00011"));
    expect(note("OBAS-00012")).toBe(en.uploads.notes.created("OBAS-00012"));
    // And a record page can name the source.
    expect(en.record.history.source.upload).toBeTruthy();
  });

  it("is stopped between rows and finishes the rest when it starts again", async () => {
    const f = await uploadFixture();
    await baseline(f);
    const history = async () => new Set(parseSampleChanges(await readFile(f.paths.sampleChangesPath, "utf8")).changes.filter((c) => c.source === "upload").map((c) => c.sample_number));
    const { location, digest } = await offered(f, [newRow(1), newRow(2), newRow(3), newRow(4)]);
    await apply(f, location, { digest });
    const stop = new AbortController();
    let done = 0;
    // The framework's own step, which refuses to begin once the signal says to stop.
    const stepOf = (signal: AbortSignal) => async <T,>(label: string, fn: () => Promise<T>) => {
      if (signal.aborted) throw new Error(`interrupted before ${label}`);
      return fn();
    };
    await expect(
      applyPending(deps(f, { step: stepOf(stop.signal), afterRow: () => { if (++done === 2) stop.abort(); } })),
    ).rejects.toThrow(/interrupted/);
    expect((await outcomes(f)).map((r) => r[1])).toEqual(["created", "created", "pending", "pending"]);
    // What was made before the stop is in the history already.
    expect(await history()).toEqual(new Set(["OBAS-00011", "OBAS-00012"]));
    expect(await applyWaiting(f.db)).toBe(true);
    // The next start picks up where it stopped, without making the first two again.
    expect(await applyPending(deps(f))).toEqual({ created: 2, refused: 0, skipped: 0 });
    expect((await outcomes(f)).map((r) => r[1])).toEqual(["created", "created", "created", "created"]);
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE sample_number LIKE 'OBAS-%'`)).toEqual([[4n]]);
    expect(await applyWaiting(f.db)).toBe(false);
    expect(await history()).toEqual(new Set(["OBAS-00011", "OBAS-00012", "OBAS-00013", "OBAS-00014"]));
  });

  it("cannot leave a sample no row names: the outcome is written in the sample's own transaction", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1)]);
    await apply(f, location, { digest });
    // A write that fails after the sample is made takes the sample with it.
    const queued = JSON.parse(String((await rows(f.conn, `SELECT payload FROM upload_sample_outcome`))[0]![0])) as { form: Parameters<typeof checkTrapSample>[1] };
    const checked = await checkTrapSample(f.conn, queued.form);
    if ("problems" in checked) throw new Error("not ready");
    await expect(
      createTrapSample(f.conn, checked.sample, f.staffer, async () => {
        throw new Error("crash");
      }),
    ).rejects.toThrow("crash");
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE sample_number = 'OBAS-00011'`)).toEqual([[0n]]);
    expect(await rows(f.conn, `SELECT count(*) FROM sample_entry WHERE entered_by = ${f.staffer}`)).toEqual([[0n]]);
    // So the row is still pending, and the job makes the sample once.
    expect((await outcomes(f)).map((r) => r[1])).toEqual(["pending"]);
    expect(await applyPending(deps(f))).toMatchObject({ created: 1 });
  });

  it("refuses a row whose number was taken after the page, with the trap form's sentence, and goes on", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1), newRow(2)]);
    await apply(f, location, { digest });
    await f.conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end, country, state_province, protocol)
      VALUES ('trap', 'OBAS-00011', DATE '${day(1)}', DATE '${day(2)}', 'USA', 'OR', 'vane trap')`);
    expect(await applyPending(deps(f))).toEqual({ created: 1, refused: 1, skipped: 0 });
    expect(await outcomes(f)).toEqual([
      [expect.any(Number), "refused", "OBAS-00011", "Trap sample OBAS-00011 is already in Beeline."],
      [expect.any(Number), "created", "OBAS-00012", null],
    ]);
    const html = await pageAt(f, location);
    expect(html).toContain(esc(en.uploads.page.samplesNotCreated(1)));
  });

  it("runs as a job: the scheduler starts it when a row is waiting, and not before", async () => {
    const f = await uploadFixture();
    const jobs = buildJobs({ syncProjects: [], sweepDays: 1, personChangesPath: "unused", sampleChangesPath: f.paths.sampleChangesPath, sampleStatePath: f.paths.sampleStatePath }, { printConn: f.conn });
    const job = jobs.find((j) => j.name === APPLY_JOB)!;
    expect(job.schedule).toEqual({ kind: "onDemand" });
    expect(await job.waiting!(f.db)).toBe(false);
    const { location, digest } = await offered(f, [newRow(1)]);
    await apply(f, location, { digest });
    expect(await job.waiting!(f.db)).toBe(true);
    await runJob({ db: f.db, conn: f.conn }, job);
    expect((await outcomes(f)).map((r) => r[1])).toEqual(["created"]);
    const run = await rows(f.conn, `SELECT outcome, detail FROM job_run WHERE job_name = '${APPLY_JOB}'`);
    expect(run).toEqual([["succeeded", "1 trap sample(s) created, 0 row(s) refused, 0 left alone"]]);
    expect(await job.waiting!(f.db)).toBe(false);
    // The scheduler ticks it too, and a shutdown waits for it: it is the job in hand.
    const { location: again, digest: d2 } = await offered(f, [newRow(5, { decimalLatitude: "44.4", decimalLongitude: "-123.1" })]);
    await apply(f, again, { digest: d2 });
    const scheduler = startScheduler({ db: f.db, conn: f.conn, jobs: [job], tickMs: 20 });
    for (let i = 0; i < 100 && (await applyWaiting(f.db)); i++) await new Promise((r) => setTimeout(r, 50));
    await scheduler.stop({ graceMs: 5000 });
    expect(await applyWaiting(f.db)).toBe(false);
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE sample_number = 'OBAS-00015'`)).toEqual([[1n]]);
  });
});

describe("a new row that looks like an existing sample", () => {
  // The fixture's UP-1 is Vera's, on 14 July at 44.5646, -123.262.
  const looks = (over: Record<string, TestCell> = {}) => newRow(1, { eventDate: day(14), decimalLatitude: "44.5650", decimalLongitude: "-123.2620", ...over });

  it("is held with its look-alike named and linked, and not created unless ticked", async () => {
    const f = await uploadFixture();
    const { location, html, digest } = await offered(f, [looks(), newRow(2)]);
    expect(html).toContain(`href="/samples/${f.ids.sampleA}"`);
    expect(html).toContain(esc(en.uploads.page.samplesHeld(1)));
    expect(html).toContain(`name="anyway" value="${await heldRow(f)}"`);
    await apply(f, location, { digest });
    expect(await applyPending(deps(f))).toEqual({ created: 1, refused: 0, skipped: 0 });
    const out = await outcomes(f);
    expect(out.map((r) => [r[1], r[2]])).toEqual([["skipped", "OBAS-00011"], ["created", "OBAS-00012"]]);
    expect(String(out[0]![3])).toContain("UP-1");
    expect(String(out[0]![3])).toContain("sampleId");
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE sample_number = 'OBAS-00011'`)).toEqual([[0n]]);
    const notes = matrixOf(new Uint8Array(await (await f.app.request(`${location}/notes`)).arrayBuffer()));
    const head = notes[0]!;
    expect(notes.find((r) => r[head.indexOf("fieldNumber")] === "OBAS-00011")![head.length - 1]).toContain("Not created: It looks like sample UP-1");
  });

  it("is created when ticked", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [looks()]);
    const row = await heldRow(f);
    // Only the held row: nothing to apply until it is ticked.
    expect((await apply(f, location, { digest })).status).toBe(409);
    expect((await apply(f, location, { digest, anyway: [row] })).status).toBe(303);
    expect(await applyPending(deps(f))).toEqual({ created: 1, refused: 0, skipped: 0 });
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE sample_number = 'OBAS-00011'`)).toEqual([[1n]]);
  });

  it("is judged by one rule: the same first collector, overlapping days, and a point within the distance", async () => {
    const f = await uploadFixture();
    const base = { firstCollectorId: f.volunteer, dateStart: day(14), dateEnd: day(14), latitude: 44.5646, longitude: -123.262 };
    const names = async (over: Partial<typeof base>) => (await findLookalikes(f.conn, { ...base, ...over })).map((l) => l.sampleNumber);
    expect(await names({})).toEqual(["UP-1"]);
    // 60 m north: still the same place. 300 m north: not.
    expect(await names({ latitude: 44.5646 + 60 / 111_000 })).toEqual(["UP-1"]);
    expect(await names({ latitude: 44.5646 + 300 / 111_000 })).toEqual([]);
    // Days that do not overlap, and another first collector, are not look-alikes.
    expect(await names({ dateStart: day(15), dateEnd: day(16) })).toEqual([]);
    expect(await names({ dateStart: day(10), dateEnd: day(14) })).toEqual(["UP-1"]);
    expect(await names({ firstCollectorId: f.staffer })).toEqual([]);
  });

  it("is looked for again when its turn comes, so a sample made since holds the row", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1)]);
    await apply(f, location, { digest });
    // Between the button and the job, a sample appears at the same place on the same days.
    await f.conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end, country, state_province, protocol)
      VALUES ('net', 'X-1', DATE '${day(9)}', DATE '${day(11)}', 'USA', 'OR', 'net')`);
    const [[id]] = (await rows(f.conn, `SELECT max(entity_id) FROM sample WHERE sample_number = 'X-1'`)) as [[number]];
    await f.conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${id}, ${f.volunteer}, 1)`);
    await f.conn.run(`INSERT INTO sample_location (sample_id, latitude, longitude, source) VALUES (${id}, 44.5, -123.2, 'staff_entry')`);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 1 });
  });
});

/** The row of the one held row in the file the fixture's last upload was: row 2 of new rows, after the fixture's own two. */
async function heldRow(f: UploadFixture): Promise<number> {
  const [[n]] = (await rows(f.conn, `SELECT count(*) FROM sample WHERE kind = 'net' OR kind = 'trap'`)) as [[bigint]];
  return Number(n) + 2;
}

describe("the guard on new numbers", () => {
  it("accepts the program's own series up to the margin above the highest, and says why it cannot use a number past it", async () => {
    expect(seriesNumberProblem("OBAS-00060", 10)).toBeNull();
    expect(seriesNumberProblem(`OBAS-${String(10 + SERIES_MARGIN).padStart(5, "0")}`, 10)).toBeNull();
    expect(seriesNumberProblem(`OBAS-${String(11 + SERIES_MARGIN).padStart(5, "0")}`, 10)).toContain("one mistyped number would move the next one offered for good");
    expect(seriesNumberProblem("OBAS-123", 10)).toContain("five digits");
    expect(seriesNumberProblem("OBAS-000123", 10)).toContain("five digits");
    // A run of consecutive numbers reaches as far as it goes; a number that jumps ahead of it does not.
    const run = Array.from({ length: 120 }, (_, i) => `OBAS-${String(11 + i).padStart(5, "0")}`);
    expect(seriesReach(10, run)).toBe(130);
    expect(seriesReach(10, [...run, "OBAS-12345"])).toBe(130);
    expect(seriesNumberProblem("OBAS-12345", seriesReach(10, [...run, "OBAS-12345"]))).toContain("one mistyped number");
    expect(seriesReach(10, ["OBAS-00100", "OBAS-00055"])).toBe(100);
    expect(seriesReach(10, ["OBAS-abc", "X-00011"])).toBe(10);
    expect(seriesNumberProblem("OBAS-1234x", 10)).toContain("five digits");
    // Another series is the collector's own.
    expect(seriesNumberProblem("UP-99999", 10)).toBeNull();
    expect(seriesNumberProblem("7", 10)).toBeNull();
  });

  it("holds a row past the margin out of the plan's ready rows, in the preview", async () => {
    const f = await uploadFixture();
    const { html, digest } = await offered(f, [newRow(1, { fieldNumber: "OBAS-90001" }), newRow(2, { fieldNumber: "OBAS-0001" }), newRow(3, { fieldNumber: "A-123" })]);
    // Only the number outside the program's series is ready.
    expect(digest).toBeDefined();
    expect(html).toContain(esc(en.uploads.page.samplesNew(1, en.uploads.page.split(1, 0, 0))));
    expect(html).toContain(esc(en.uploads.page.samplesCantUse(2, en.uploads.page.split(2, 0, 0))));
  });
});

describe("deleting a trap sample", () => {
  const made = async (f: UploadFixture) => {
    const { location, digest } = await offered(f, [newRow(1)]);
    await apply(f, location, { digest });
    await applyPending(deps(f));
    const [[id]] = (await rows(f.conn, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00011'`)) as [[number]];
    return { id, location };
  };
  const post = (f: UploadFixture, id: number, app = f.app) => app.request(`/samples/${id}/delete`, { method: "POST", headers: { origin: ORIGIN }, body: new FormData() });

  it("takes the sample and every row that names it, and leaves what the upload recorded", async () => {
    const f = await uploadFixture();
    const { id } = await made(f);
    // Give it more kinds of satellite than the form makes, so a table that is missed shows.
    await f.conn.run(`INSERT INTO sample_hold (sample_id, reason, held_by) VALUES (${id}, 'test', ${f.staffer})`);
    await f.conn.run(`INSERT INTO sample_location_override (sample_id, latitude, longitude, set_by) VALUES (${id}, 44.5, -123.2, ${f.staffer})`);
    await f.conn.run(`INSERT INTO sample_area (sample_id, area_source, area_source_id) VALUES (${id}, 'county', '41003')`);
    const page = await (await f.app.request(`/samples/${id}`)).text();
    expect(page).toContain(`href="/samples/${id}/delete"`);
    const confirm = await f.app.request(`/samples/${id}/delete`);
    expect(await confirm.text()).toContain(esc(en.trapSample.delete.explain));
    expect((await post(f, id)).status).toBe(302);
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE entity_id = ${id}`)).toEqual([[0n]]);
    // Every table that names a sample by a foreign key has nothing left for it.
    const tables = (await rows(f.conn, `SELECT table_name FROM duckdb_constraints() WHERE constraint_type = 'FOREIGN KEY' AND referenced_table = 'sample'`)) as string[][];
    for (const [t] of tables) expect(await rows(f.conn, `SELECT count(*) FROM ${t} WHERE sample_id = ${id}`), t).toEqual([[0n]]);
    // The record of what the upload did stands.
    expect(await rows(f.conn, `SELECT outcome, sample_id, sample_number FROM upload_sample_outcome`)).toEqual([["created", id, "OBAS-00011"]]);
  });

  it("is staff's alone, and not while viewing as somebody else", async () => {
    const f = await uploadFixture();
    const { id } = await made(f);
    const volunteer = f.appAs("volunteer");
    expect((await post(f, id, volunteer)).status).toBe(404);
    expect((await volunteer.request(`/samples/${id}/delete`)).status).toBe(404);
    expect(await (await volunteer.request(`/samples/${id}`)).text()).not.toContain("/delete");
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE entity_id = ${id}`)).toEqual([[1n]]);
  });

  it("refuses a sample from iNaturalist or the old Beeline, a printed one, one in a print run, and one with specimens, each with a sentence", async () => {
    const f = await uploadFixture("staffer", { unprinted: true });
    const refused = async (id: number) => {
      const res = await post(f, id);
      expect(res.status).toBe(409);
      return res.text();
    };
    // An imported sample: not entered in Beeline.
    expect(await refused(f.ids.sampleA)).toContain(esc(en.trapSample.delete.refused.not_entered!));
    const entered = async (number: string) => {
      const [[id]] = (await rows(f.conn, `INSERT INTO sample (kind, sample_number, date_start, date_end, country, state_province, protocol)
        VALUES ('trap', '${number}', DATE '${day(1)}', DATE '${day(2)}', 'USA', 'OR', 'vane trap') RETURNING entity_id`)) as [[number]];
      await f.conn.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES (${id}, ${f.staffer})`);
      return id;
    };
    // A specimen with no label at all counts as on paper, as every imported one does.
    const bare = await entered("OBAS-00031");
    await f.conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${bare}, 1)`);
    expect(await refused(bare)).toContain(esc(en.trapSample.delete.refused.printed!));
    // A specimen whose run was canceled is on no paper and in no run, but it is a specimen.
    const withSpecimen = await entered("OBAS-00033");
    const [[sp2]] = (await rows(f.conn, `INSERT INTO specimen (sample_id, specimen_number) VALUES (${withSpecimen}, 1) RETURNING entity_id`)) as [[number]];
    await f.conn.run(`INSERT INTO print_run (prepared_by, canceled_at, canceled_by) VALUES (${f.staffer}, now(), ${f.staffer})`);
    await f.conn.run(`INSERT INTO printed_label (print_run_id, specimen_id, sheet, cell, location_text, coordinates_text, date_text, collector_text, method_text, number_text, latitude, longitude, date_start, date_end)
      SELECT (SELECT max(entity_id) FROM print_run), ${sp2}, 1, 0, 'x', 'x', 'd', 'c', 'm', 'OBA20002', 44.5, -123.6, s.date_start, s.date_end FROM sample s WHERE s.entity_id = ${withSpecimen}`);
    await f.conn.run(`INSERT INTO minted_field_number (field_number, print_run_id, specimen_id) SELECT 'OBA20002', max(entity_id), ${sp2} FROM print_run`);
    expect(await refused(withSpecimen)).toContain(esc(en.trapSample.delete.refused.has_specimens!));
    // Printed: a specimen on paper (printed_sample).
    const printed = await entered("OBAS-00032");
    const [[sp]] = (await rows(f.conn, `INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${printed}, 1, 'OBA20001') RETURNING entity_id`)) as [[number]];
    await f.conn.run(`INSERT INTO print_run (prepared_by, prepared_at, approved_by, approved_at, printed_by, printed_at) VALUES (${f.staffer}, now() - INTERVAL 2 HOUR, ${f.staffer}, now() - INTERVAL 1 HOUR, ${f.staffer}, now())`);
    await f.conn.run(`INSERT INTO printed_label (print_run_id, specimen_id, sheet, cell, location_text, coordinates_text, date_text, collector_text, method_text, number_text, latitude, longitude, date_start, date_end)
      SELECT (SELECT max(entity_id) FROM print_run), ${sp}, 1, 0, 'x', 'x', 'd', 'c', 'm', 'OBA20001', 44.5, -123.6, s.date_start, s.date_end FROM sample s WHERE s.entity_id = ${printed}`);
    expect(await refused(printed)).toContain(esc(en.trapSample.delete.refused.printed!));
    // In an unprinted run (the fixture's UP-3 is not entered here, so enter it).
    const sampleC = f.ids.sampleC!;
    await f.conn.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES (${sampleC}, ${f.staffer})`);
    expect(await refused(sampleC)).toContain(esc(en.trapSample.delete.refused.in_print_run!));
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE entity_id IN (${bare}, ${withSpecimen}, ${printed}, ${sampleC})`)).toEqual([[4n]]);
  });

  it("finds its satellite tables in the store, so one added later is deleted too", async () => {
    const f = await uploadFixture();
    const { id } = await made(f);
    expect(await deleteTrapSample(f.conn, id)).toEqual({ deleted: "OBAS-00011" });
    expect(await deleteTrapSample(f.conn, id)).toEqual({ refused: "not_found" });
  });
});
