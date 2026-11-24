import { readFile } from "node:fs/promises";
import { describe as describeInOrder, expect, it } from "vitest";
import { en } from "../src/app/messages/en.js";
import { APPLY_JOB, APPLY_ROW_LIMIT, APPLY_TIME_LIMIT_MS, applyPending, applyWaiting, clearStopped } from "../src/app/samples-upload-apply.js";
import { buildJobs } from "../src/app/jobs/registry.js";
import { startScheduler, runJob, type Job } from "../src/app/jobs/framework.js";
import { onSample } from "../src/app/sample-queue.js";
import { planSamples } from "../src/app/samples-upload-plan.js";
import { SAMPLES_LAYOUT, parseUpload } from "../src/app/upload-plan.js";
import { checkTrapSample, findLookalikes, createTrapSample, deleteTrapSample, mayEditTrapSample, seriesNumberProblem, DELETED_WITH_SAMPLE, NEVER_DELETED, deletable, highestSeriesNumber, seriesNumberHolder } from "../src/trap-sample.js";
import { parseSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { duckdbReader } from "../src/person-change.js";
import { CURRENT_SEASON, SETTLED_SEASON, insertCleanSample, rows } from "./helpers.js";
import { UPLOAD_TODAY, edited, everyProgramConfirmed, matrixOf, uploadFixture, type UploadFixture } from "./upload-fixture.js";
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
// Each is a kilometre from the last, so that rows of one file are not held as look-alikes of one another.
const newRow = (n: number, over: Record<string, TestCell> = {}) => ({ ...ready, fieldNumber: `OBAS-${String(10 + n).padStart(5, "0")}`, decimalLatitude: String(44.5 + n * 0.01), ...over });

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
const apply = async (f: UploadFixture, location: string, fields: { digest?: string; anyway?: number[]; obas?: boolean; confirmElsewhere?: boolean }, app = f.app) => {
  const body = new FormData();
  // The fixture's staff member leads no program, so every record is another program's and applying asks once (beeline-kgyd.13); most tests are not about it, so it is ticked unless a test says not.
  if (fields.confirmElsewhere !== false) body.set("confirm_elsewhere", await everyProgramConfirmed(f));
  if (fields.digest !== undefined) body.set("digest", fields.digest);
  // The series' numbers wait for the one box; most tests are not about it, so it is ticked unless a test says not.
  if (fields.obas !== false) body.set("obas", "1");
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

  it("is not offered for a file that says what Beeline has, and is offered, with the kinds of change to tick, for a changed existing sample", async () => {
    const f = await uploadFixture();
    const same = await upload(f, await download(f));
    expect(await pageAt(f, same)).not.toContain("apply-samples");
    const location = await upload(f, edited(await download(f), [{ id: f.ids.sampleA, set: { locality: "Albany" } }], { idColumn: "sampleId" }));
    const html = await pageAt(f, location);
    expect(html).toContain("apply-samples");
    expect(html).toContain(esc(en.uploads.page.samplesNothingChanged));
    expect(html).toContain(esc(en.uploads.page.changeKind(en.uploads.page.changeKinds.place!, 1, en.uploads.page.split(1, 0, 0))));
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

  it("is accepted while the nightly runs: the job waits for it, and checks each row when its turn comes", async () => {
    const f = await uploadFixture("staffer", { jobs: { list: [], start: async () => false, running: () => "nightly-pipeline" } });
    const { location, digest } = await offered(f, [newRow(1)]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    expect(await rows(f.conn, `SELECT count(*) FROM upload_applied`)).toEqual([[1n]]);
    expect(await applyWaiting(f.db)).toBe(true);
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
    expect(result).toEqual({ created: 2, refused: 0, skipped: 0, stopped: 0 });
    const made = await rows(f.conn, `SELECT o.row_number, o.outcome, o.sample_number, s.sample_number, s.kind, e.entered_by
      FROM upload_sample_outcome o JOIN sample s ON s.entity_id = o.sample_id JOIN sample_entry e ON e.sample_id = s.entity_id ORDER BY 1`);
    expect(made.map((r) => r.slice(1))).toEqual([
      ["created", "OBAS-00011", "OBAS-00011", "trap", f.staffer],
      ["created", "OBAS-00012", "OBAS-00012", "trap", f.staffer],
    ]);
    expect(await rows(f.conn, `SELECT p.person_id, p.position FROM sample_collector p JOIN sample s ON s.entity_id = p.sample_id WHERE s.sample_number = 'OBAS-00012' ORDER BY 2`)).toEqual([[f.volunteer, 1], [f.staffer, 2]]);
    // The method as the trap form writes it, with the count the file gave beside it (beeline-ni5m.15).
    expect(await rows(f.conn, `SELECT s.sample_number, s.protocol, s.sampling_effort, m.method_code, m.trap_count FROM sample s JOIN sample_method m ON m.sample_id = s.entity_id WHERE s.sample_number LIKE 'OBAS-%' ORDER BY 1`)).toEqual([
      ["OBAS-00011", "vane trap", "6 vane traps", "vane trap", 6],
      ["OBAS-00012", "vane trap", "6 vane traps", "vane trap", 6],
    ]);
    expect(await rows(f.conn, `SELECT count(*) FROM sample_method_out_of_step`)).toEqual([[0n]]);
    const log = parseSampleChanges(await readFile(f.paths.sampleChangesPath, "utf8")).changes.filter((c) => c.sample_number.startsWith("OBAS-"));
    expect(log.length).toBeGreaterThan(0);
    expect(new Set(log.map((c) => c.source))).toEqual(new Set(["upload"]));
    expect(new Set(log.map((c) => c.reason))).toEqual(new Set([`From upload ${(await rows(f.conn, `SELECT entity_id FROM upload`))[0]![0]}`]));
    expect(new Set(log.map((c) => c.author))).toEqual(new Set(["sam_s"]));
    // The page says what was done, and the file with notes names each sample.
    const html = await pageAt(f, location);
    expect(html).toContain(esc(en.uploads.page.samplesCreated(2, 0)));
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
    expect(await applyPending(deps(f))).toEqual({ created: 2, refused: 0, skipped: 0, stopped: 0 });
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
    expect(await applyPending(deps(f))).toEqual({ created: 1, refused: 1, skipped: 0, stopped: 0 });
    expect(await outcomes(f)).toEqual([
      [expect.any(Number), "refused", "OBAS-00011", "Trap sample OBAS-00011 is already in Beeline."],
      [expect.any(Number), "created", "OBAS-00012", null],
    ]);
    const html = await pageAt(f, location);
    expect(html).toContain(esc(en.uploads.page.samplesNotCreated(1)));
  });

  it("runs as a job: the scheduler starts it when a row is waiting, and not before", async () => {
    const f = await uploadFixture();
    const jobs = buildJobs({ syncProjects: [], sweepDays: 1, personChangesPath: "unused", sampleChangesPath: f.paths.sampleChangesPath, sampleStatePath: f.paths.sampleStatePath, correctionsPath: f.paths.correctionsPath, sampleOverlayPath: f.paths.sampleOverlayPath }, { printConn: f.conn });
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
    expect(html).toContain(esc(en.uploads.page.samplesHeld(2, " (2 in the active seasons)")));
    expect(html).toContain(`name="anyway" value="${await heldRow(f)}"`);
    await apply(f, location, { digest });
    expect(await applyPending(deps(f))).toEqual({ created: 1, refused: 0, skipped: 0, stopped: 0 });
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
    expect(await applyPending(deps(f))).toEqual({ created: 1, refused: 0, skipped: 0, stopped: 0 });
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
    await f.conn.run(`INSERT INTO sample_location (sample_id, latitude, longitude, source) VALUES (${id}, 44.51, -123.2, 'staff_entry')`);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 1, stopped: 0 });
  });
});

/** The row of the one held row in the file the fixture's last upload was: row 2 of new rows, after the fixture's own two. */
async function heldRow(f: UploadFixture): Promise<number> {
  const [[n]] = (await rows(f.conn, `SELECT count(*) FROM sample WHERE kind = 'net' OR kind = 'trap'`)) as [[bigint]];
  return Number(n) + 2;
}

describe("the series' numbers", () => {
  it("must be OBAS- and five digits, and nothing else is judged", () => {
    expect(seriesNumberProblem("OBAS-00060")).toBeNull();
    expect(seriesNumberProblem("OBAS-99999")).toBeNull();
    expect(seriesNumberProblem("OBAS-123")).toContain("five digits");
    expect(seriesNumberProblem("OBAS-000123")).toContain("five digits");
    expect(seriesNumberProblem("OBAS-1234x")).toContain("five digits");
    expect(seriesNumberProblem("UP-99999")).toBeNull();
    expect(seriesNumberProblem("7")).toBeNull();
  });

  it("wait for the one box: unticked they are skipped with a note, ticked they are made; a number outside the series is not held", async () => {
    const f = await uploadFixture();
    const { location, html, digest } = await offered(f, [newRow(1), newRow(2, { fieldNumber: "YPT3" })]);
    expect(html).toContain(esc(en.uploads.page.obasLine(1, "OBAS-00011", "OBAS-00011", 0, null, null)));
    expect(html).toContain(`name="obas"`);
    expect(html).toContain(esc(en.uploads.page.obasBox));
    await apply(f, location, { digest, obas: false });
    expect(await applyPending(deps(f))).toEqual({ created: 1, refused: 0, skipped: 0, stopped: 0 });
    expect((await outcomes(f)).map((r) => [r[1], r[2]])).toEqual([["skipped", "OBAS-00011"], ["created", "YPT3"]]);
    expect(String((await outcomes(f))[0]![3])).toContain("I've checked these OBAS numbers");
    // Only held rows, nothing ticked: its own sentence.
    const g = await uploadFixture();
    const only = await offered(g, [newRow(1)]);
    const none = await apply(g, only.location, { digest: only.digest, obas: false });
    expect(none.status).toBe(409);
    expect(await none.text()).toContain(esc(en.uploads.page.samplesNothingTicked));
  });

  it("gives a row with no number the next in the series, under the lock, so consecutive rows get consecutive numbers", async () => {
    const f = await uploadFixture();
    await f.conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end, country, state_province, protocol)
      VALUES ('trap', 'OBAS-00040', DATE '${day(1)}', DATE '${day(2)}', 'USA', 'OR', 'vane trap')`);
    const { location, html, digest } = await offered(f, [newRow(1, { fieldNumber: "", decimalLatitude: "44.1" }), newRow(2, { fieldNumber: "", decimalLatitude: "44.2" })]);
    expect(html).toContain(esc(en.uploads.page.obasLine(2, null, null, 2, "OBAS-00041", "OBAS-00042")));
    await apply(f, location, { digest });
    expect(await applyPending(deps(f))).toEqual({ created: 2, refused: 0, skipped: 0, stopped: 0 });
    expect((await outcomes(f)).map((r) => r[2])).toEqual(["OBAS-00041", "OBAS-00042"]);
    expect(await rows(f.conn, `SELECT sample_number FROM sample WHERE sample_number IN ('OBAS-00041', 'OBAS-00042') ORDER BY 1`)).toEqual([["OBAS-00041"], ["OBAS-00042"]]);
    const notes = matrixOf(new Uint8Array(await (await f.app.request(`${location}/notes`)).arrayBuffer()));
    expect(notes.at(-1)!.at(-1)).toBe(en.uploads.notes.created("OBAS-00042"));
  });

  it("cannot be used when any other sample, of any kind, has the number, and the note names that sample", async () => {
    const f = await uploadFixture();
    // The old Beeline holds some trap bottles as net samples.
    const held = await insertCleanSample(f.conn, { kind: "'net'", sample_number: "'OBAS-00033'", collector_id: String(f.staffer) });
    const { html } = await offered(f, [newRow(1, { fieldNumber: "OBAS-00033" })]);
    expect(html).toContain(esc(en.uploads.page.samplesCantUse(1, en.uploads.page.split(1, 0, 0))));
    const notes = matrixOf(new Uint8Array(await (await f.app.request(`${(await upload(f, edited(await download(f), [], { idColumn: "sampleId", addRows: [newRow(1, { fieldNumber: "OBAS-00033" })] })))}/notes`)).arrayBuffer()));
    expect(notes.at(-1)!.at(-1)).toContain(`sampleId ${held}`);
    // And the job asks again under the lock.
    const g = await uploadFixture();
    const queued = await offered(g, [newRow(1, { fieldNumber: "OBAS-00034" })]);
    await apply(g, queued.location, { digest: queued.digest });
    const other = await insertCleanSample(g.conn, { kind: "'net'", sample_number: "'OBAS-00034'", collector_id: String(g.staffer) });
    expect(await applyPending(deps(g))).toEqual({ created: 0, refused: 1, skipped: 0, stopped: 0 });
    expect(String((await outcomes(g))[0]![3])).toContain(`sampleId ${other}`);
  });

  it("warns, before applying, how many samples to be made are in an active season with specimens", async () => {
    const f = await uploadFixture();
    const { html } = await offered(f, [newRow(1, { specimenCount: "3" }), newRow(2, { specimenCount: "0", decimalLatitude: "44.3" }), newRow(3, { specimenCount: "", decimalLatitude: "44.4" })]);
    expect(html).toContain(esc(en.uploads.page.labelsReady(1)));
    const g = await uploadFixture();
    expect((await offered(g, [newRow(1, { specimenCount: "0" })])).html).not.toContain("ready to print");
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
    // In an unprinted run (the fixture's UP-3 is a net sample not entered here, so make it an entered trap sample).
    const sampleC = f.ids.sampleC!;
    await f.conn.run(`UPDATE sample SET kind = 'trap' WHERE entity_id = ${sampleC}`);
    await f.conn.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES (${sampleC}, ${f.staffer})`);
    expect(await refused(sampleC)).toContain(esc(en.trapSample.delete.refused.in_print_run!));
    // A net sample is never deleted here, whatever marks it carries.
    const net = await entered("OBAS-00034");
    await f.conn.run(`UPDATE sample SET kind = 'net' WHERE entity_id = ${net}`);
    expect(await refused(net)).toContain(esc(en.trapSample.delete.refused.not_entered!));
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE entity_id IN (${bare}, ${withSpecimen}, ${printed}, ${sampleC}, ${net})`)).toEqual([[5n]]);
  });

  it("finds its satellite tables in the store, so one added later is deleted too", async () => {
    const f = await uploadFixture();
    const { id } = await made(f);
    expect(await deleteTrapSample(f.conn, id, f.staffer)).toEqual({ deleted: "OBAS-00011" });
    expect(await deleteTrapSample(f.conn, id, f.staffer)).toEqual({ refused: "not_found" });
  });
});

describe("a run that is cut short", () => {
  /** A connection that fails the first statement it is asked to read matching `when`, as a query interrupted at shutdown does, or with a fault nobody foresaw. */
  const failingAt = (f: UploadFixture, when: number | RegExp, error: () => Error, before?: () => void) => {
    let reads = 0;
    let done = false;
    return new Proxy(f.conn, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (key !== "runAndReadAll" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
        return async (...args: unknown[]) => {
          if (!done && (typeof when === "number" ? ++reads === when : when.test(String(args[0])))) {
            done = true;
            before?.();
            throw error();
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  };
  /** A shutdown: the signal is set, and the query is interrupted. */
  const interruptedAt = (f: UploadFixture, when: number | RegExp) => {
    const stop = new AbortController();
    return { stop, conn: failingAt(f, when, () => new Error("INTERRUPT Error: Interrupted!"), () => stop.abort()) };
  };

  it("leaves the row it was working on pending and unmarked, and the next run makes it", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1), newRow(2)]);
    await apply(f, location, { digest });
    // The first read of the row (the trap form's check) is interrupted, and then a later one.
    const first = interruptedAt(f, 1);
    await expect(applyPending(deps(f, { conn: first.conn, signal: first.stop.signal }))).rejects.toThrow(/Interrupted/);
    const second = interruptedAt(f, /FROM sample_collector c\s+JOIN sample s/);
    // The look-alike is read under the print runs' lock, on the print connection.
    await expect(applyPending(deps(f, { printWriter: second.conn, signal: second.stop.signal }))).rejects.toThrow(/Interrupted/);
    expect((await outcomes(f)).map((r) => r[1])).toEqual(["pending", "pending"]);
    expect(await rows(f.conn, `SELECT stopped_at, stopped_row FROM upload_applied`)).toEqual([[null, null]]);
    expect(await applyPending(deps(f))).toEqual({ created: 2, refused: 0, skipped: 0, stopped: 0 });
  });

  it("is not a shutdown just because an error says interrupt: the upload is stopped", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1), newRow(2)]);
    await apply(f, location, { digest });
    // No signal is set, so this is a fault.
    await expect(applyPending(deps(f, { conn: failingAt(f, 1, () => new Error("INTERRUPT Error: not a shutdown")) }))).rejects.toThrow("not a shutdown");
    expect((await rows(f.conn, `SELECT stopped_row FROM upload_applied`))[0]![0]).toBe(4);
  });

  it("refuses a payload that is not what the job writes from, and a number the guard recognises, and goes on", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1), newRow(2)]);
    await apply(f, location, { digest });
    await f.conn.run(`UPDATE upload_sample_outcome SET payload = '{"form": 5}' WHERE sample_number = 'OBAS-00011'`);
    expect(await applyPending(deps(f))).toEqual({ created: 1, refused: 1, skipped: 0, stopped: 0 });
    expect(String((await outcomes(f))[0]![3])).toContain("cannot be read (no form)");
    await f.conn.run(`UPDATE upload_sample_outcome SET outcome = 'pending', payload = 'not json' WHERE sample_number = 'OBAS-00011'`);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 1, skipped: 0, stopped: 0 });
    expect(String((await outcomes(f))[0]![3])).toContain("not JSON");
    const g = await uploadFixture();
    const queued = await offered(g, [newRow(1)]);
    await apply(g, queued.location, { digest: queued.digest });
    await g.conn.run(`UPDATE upload_sample_outcome SET payload = replace(payload, 'OBAS-00011', 'OBAS-123')`);
    expect(await applyPending(deps(g))).toEqual({ created: 0, refused: 1, skipped: 0, stopped: 0 });
    expect(String((await outcomes(g))[0]![3])).toContain("five digits");
  });

  it("stops on an unexpected error: the row stays pending, the upload is marked and left alone, other uploads go on, and the run fails; Try again resumes it", async () => {
    const started: string[] = [];
    const f = await uploadFixture("staffer", { jobs: { list: [], start: async (name) => (started.push(name), true) } });
    const one = await offered(f, [newRow(1), newRow(2)]);
    await apply(f, one.location, { digest: one.digest });
    const two = await offered(f, [newRow(3, { decimalLatitude: "44.9" })]);
    await apply(f, two.location, { digest: two.digest });
    // A write conflict, say, on the first row of the first upload.
    await expect(applyPending(deps(f, { conn: failingAt(f, 1, () => new Error("Conflict on tuple with 'secret value'")) }))).rejects.toThrow("secret value");
    // The first upload stopped at its row 2 (nothing is stepped over); the second upload's row was made.
    expect(await rows(f.conn, `SELECT outcome, sample_number FROM upload_sample_outcome ORDER BY upload_id, row_number`)).toEqual([["pending", "OBAS-00011"], ["pending", "OBAS-00012"], ["created", "OBAS-00013"]]);
    const marks = (await rows(f.conn, `SELECT stopped_row, stopped_at IS NOT NULL FROM upload_applied ORDER BY upload_id`)) as Array<[number | null, boolean]>;
    expect(marks[0]).toEqual([marks[0]![0], true]);
    expect(marks[1]).toEqual([null, false]);
    // No error text is kept anywhere a person reads.
    expect(JSON.stringify(await rows(f.conn, `SELECT * FROM upload_sample_outcome`), (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain("secret");
    // The scheduler does not restart a stopped upload, and the page says so, with a button for staff.
    expect(await applyWaiting(f.db)).toBe(false);
    const html = await pageAt(f, one.location);
    expect(html).toContain(esc(en.uploads.page.samplesStopped(marks[0]![0]!)));
    expect(html).toContain(`${one.location}/apply-samples/retry`);
    // Try again clears the mark and starts the job, which carries on.
    started.length = 0;
    const retry = await f.app.request(`${one.location}/apply-samples/retry`, { method: "POST", headers: { origin: ORIGIN }, body: new FormData() });
    expect(retry.status).toBe(303);
    expect(await applyWaiting(f.db)).toBe(true);
    expect(started).toEqual([APPLY_JOB]);
    expect(await applyPending(deps(f))).toEqual({ created: 2, refused: 0, skipped: 0, stopped: 0 });
    // Not for a volunteer.
    expect((await f.appAs("volunteer").request(`${one.location}/apply-samples/retry`, { method: "POST", headers: { origin: ORIGIN }, body: new FormData() })).status).toBe(404);
  });

  it("starts no creation once the signal is set", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1)]);
    await apply(f, location, { digest });
    const stopped = new AbortController();
    stopped.abort();
    await expect(applyPending(deps(f, { signal: stopped.signal }))).rejects.toThrow(/interrupted by shutdown/);
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE sample_number = 'OBAS-00011'`)).toEqual([[0n]]);
    expect(await rows(f.conn, `SELECT outcome FROM upload_sample_outcome`)).toEqual([["pending"]]);
    expect(await rows(f.conn, `SELECT stopped_row FROM upload_applied`)).toEqual([[null]]);
  });

  it("does not report a run that was stopped to Sentry's observer, and a run left by a shutdown is started at the next tick", async () => {
    const f = await uploadFixture();
    const heard: unknown[] = [];
    const stopper = new AbortController();
    const job: Job = {
      name: "x",
      schedule: { kind: "onDemand" },
      window: "interactive",
      async run(ctx) {
        await ctx.step("a", async () => undefined);
        stopper.abort();
        await ctx.step("b", async () => undefined);
      },
    };
    await runJob({ db: f.db, conn: f.conn, observe: () => (_o, err) => void heard.push(err) }, job, stopper.signal);
    expect(heard).toEqual([undefined]);
    await f.conn.run(`INSERT INTO job_run (job_name, started_at, completed_at, outcome, detail) VALUES ('resumed', now(), now(), 'failed', 'interrupted by shutdown before step a')`);
    let resumed = 0;
    const second: Job = { name: "resumed", schedule: { kind: "onDemand" }, window: "interactive", waiting: async () => resumed === 0, async run() { resumed++; } };
    const again = startScheduler({ db: f.db, conn: f.conn, jobs: [second], tickMs: 20 });
    for (let i = 0; i < 50 && resumed === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await again.stop({ graceMs: 1000 });
    expect(resumed).toBe(1);
  });
});

describe("the scheduler stopping", () => {
  it("starts nothing when a stop began while it asked whether work was waiting, and waits for that tick", async () => {
    const f = await uploadFixture();
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    let answer!: (v: boolean) => void;
    let ran = 0;
    const job: Job = {
      name: "late",
      schedule: { kind: "onDemand" },
      window: "interactive",
      waiting: () => {
        asked();
        return new Promise<boolean>((r) => (answer = r));
      },
      async run() {
        ran++;
      },
    };
    const scheduler = startScheduler({ db: f.db, conn: f.conn, jobs: [job], tickMs: 10 });
    await askedP;
    let stopped = false;
    const stopping = scheduler.stop({ graceMs: 1000 }).then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 50));
    // The tick is still waiting for its answer, so the store may not be closed yet.
    expect(stopped).toBe(false);
    answer(true);
    await stopping;
    expect(ran).toBe(0);
    expect(await rows(f.conn, `SELECT count(*) FROM job_run WHERE job_name = 'late'`)).toEqual([[0n]]);
  });
});

describe("an interrupted delete and its record", () => {
  it("is finished by deleting again, and the record stays after the sample is gone", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1)]);
    await apply(f, location, { digest });
    await applyPending(deps(f));
    const [[id]] = (await rows(f.conn, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00011'`)) as [[number]];
    // The process dies after the satellites are gone and before the sample is.
    const dying = new Proxy(f.conn, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (key !== "run" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
        return async (sql: string, ...rest: unknown[]) => {
          if (/^DELETE FROM sample WHERE/.test(sql)) throw new Error("killed");
          return (value as (...a: unknown[]) => unknown).apply(target, [sql, ...rest]);
        };
      },
    });
    await expect(deleteTrapSample(dying, id, f.staffer)).rejects.toThrow("killed");
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE entity_id = ${id}`)).toEqual([[1n]]);
    expect(await rows(f.conn, `SELECT count(*) FROM sample_entry WHERE sample_id = ${id}`)).toEqual([[0n]]);
    expect(await rows(f.conn, `SELECT sample_number, deleted_by FROM sample_deletion WHERE sample_id = ${id}`)).toEqual([["OBAS-00011", f.staffer]]);
    // The page offers to finish it, and finishing it works.
    expect(await (await f.app.request(`/samples/${id}/delete`)).text()).toContain(esc(en.trapSample.delete.explain));
    expect((await f.app.request(`/samples/${id}/delete`, { method: "POST", headers: { origin: ORIGIN }, body: new FormData() })).status).toBe(302);
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE entity_id = ${id}`)).toEqual([[0n]]);
    expect(await rows(f.conn, `SELECT count(*) FROM sample_deletion WHERE sample_id = ${id}`)).toEqual([[1n]]);
    // An id drawn again: an old record for it, then a new sample with that id deleted, writes a record of its own.
    const g = await uploadFixture();
    const queued = await offered(g, [newRow(1)]);
    await apply(g, queued.location, { digest: queued.digest });
    await applyPending(deps(g));
    const [[reused]] = (await rows(g.conn, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00011'`)) as [[number]];
    await g.conn.run(`INSERT INTO sample_deletion (sample_id, sample_number, deleted_by, deleted_at) VALUES (${reused}, 'OLD-1', ${g.staffer}, now() - INTERVAL 1 DAY)`);
    expect(await deleteTrapSample(g.conn, reused, g.staffer)).toEqual({ deleted: "OBAS-00011" });
    expect(await rows(g.conn, `SELECT sample_number FROM sample_deletion WHERE sample_id = ${reused} ORDER BY entity_id`)).toEqual([["OLD-1"], ["OBAS-00011"]]);
    // A sample with an old deletion row that is not cut short (it is not an entered one) is not deletable.
    await f.conn.run(`INSERT INTO sample_deletion (sample_id, sample_number, deleted_by, deleted_at) VALUES (${f.ids.sampleA}, 'x', ${f.staffer}, now())`);
    expect(await deleteTrapSample(f.conn, f.ids.sampleA, f.staffer)).toEqual({ refused: "not_entered" });
  });
});

describe("history written as each sample is made", () => {
  it("is entered before the next row, so an edit made after the row is recorded after it", async () => {
    const f = await uploadFixture();
    await baseline(f);
    const { location, digest } = await offered(f, [newRow(1)]);
    await apply(f, location, { digest });
    let edit: Promise<string> | undefined;
    let seenInLog = "";
    await applyPending(
      deps(f, {
        afterRow: async () => {
          const [[id]] = (await rows(f.conn, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00011'`)) as [[number]];
          edit = onSample(id, async () => {
            seenInLog = await readFile(f.paths.sampleChangesPath, "utf8");
            return "edited";
          });
        },
      }),
    );
    expect(await edit).toBe("edited");
    // When the edit's turn came, the upload's entry was already in the log.
    expect(seenInLog).toContain(",upload,");
    expect(seenInLog).toContain("From upload");
  });
});

describe("what staff are told, and who sees what", () => {
  const looks = (over: Record<string, TestCell> = {}) => newRow(1, { eventDate: day(14), decimalLatitude: "44.5650", decimalLongitude: "-123.2620", ...over });

  it("says nothing of ticking once the file is applied, and says so when nothing was ticked", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [looks()]);
    const none = await apply(f, location, { digest });
    expect(none.status).toBe(409);
    expect(await none.text()).toContain(esc(en.uploads.page.samplesNothingTicked));
    const g = await uploadFixture();
    const queued = await offered(g, [looks(), newRow(2)]);
    await apply(g, queued.location, { digest: queued.digest });
    const [[detail]] = (await rows(g.conn, `SELECT detail FROM upload_sample_outcome WHERE outcome = 'skipped'`)) as [[string]];
    expect(detail).toContain("tick create anyway");
    await applyPending(deps(g));
    const [[later]] = (await rows(g.conn, `SELECT detail FROM upload_sample_outcome WHERE outcome = 'skipped'`)) as [[string]];
    expect(later).toBe(detail);
  });

  it("counts a tick only for a row that looks like something", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1)]);
    const first = Number((await rows(f.conn, `SELECT count(*) FROM sample`))[0]![0]) + 2;
    await apply(f, location, { digest, anyway: [first] });
    const [[payload]] = (await rows(f.conn, `SELECT payload FROM upload_sample_outcome`)) as [[string]];
    expect(JSON.parse(payload).anyway).toBe(false);
  });

  it("holds a row for a reader who may not see the sample it looks like, without naming it", async () => {
    const f = await uploadFixture();
    const bytes = edited(await download(f), [], { idColumn: "sampleId", addRows: [looks()] });
    const p = await parseUpload(bytes, { inThread: true }, SAMPLES_LAYOUT);
    if (!p.ok) throw new Error("x");
    const plan = await planSamples(f.db, f.conn, p.upload, { today: `${CURRENT_SEASON}-12-31`, reader: { staff: false, personIds: [f.volunteer] } });
    expect(plan.rows.at(-1)!.create!.lookalike).toEqual({ sampleId: 0, sampleNumber: "" });
    expect(plan.counts.newHeld.active).toBe(1);
  });
});

describe("a look-alike that appears after Apply", () => {
  it("is caught in the creating transaction, under the print runs' lock, which is rolled back, and the row is left alone", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1)]);
    expect((await apply(f, location, { digest })).status).toBe(303);
    // Between Apply and the job reaching the row, somebody saves a sample of Vera's at the same place on the same days.
    const [[id]] = (await rows(f.conn, `INSERT INTO sample (kind, sample_number, date_start, date_end, country, state_province, protocol)
      VALUES ('trap', 'OBAS-00099', DATE '${day(9)}', DATE '${day(11)}', 'USA', 'OR', 'vane trap') RETURNING entity_id`)) as [[number]];
    await f.conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${id}, ${f.volunteer}, 1)`);
    await f.conn.run(`INSERT INTO sample_location (sample_id, latitude, longitude, source) VALUES (${id}, 44.51, -123.2, 'staff_entry')`);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 1, stopped: 0 });
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE sample_number = 'OBAS-00011'`)).toEqual([[0n]]);
    expect(String((await outcomes(f))[0]![3])).toContain("OBAS-00099");
  });
});

describe("spellings of the program's series", () => {
  it("cannot be used unless written exactly, and a sample that has one holds the number in every spelling", async () => {
    const f = await uploadFixture();
    for (const spelling of ["obas-00700", "OBAS 00700", "OBAS00700", "Obas_00700"]) {
      expect(seriesNumberProblem(spelling), spelling).toContain("written exactly OBAS- and five digits");
    }
    expect(seriesNumberProblem("OBAS-00700")).toBeNull();
    const { html } = await offered(f, [newRow(1, { fieldNumber: "obas-00700" }), newRow(2, { fieldNumber: "OBAS 00701" }), newRow(3, { fieldNumber: "OBAS00702" })]);
    expect(html).toContain(esc(en.uploads.page.samplesCantUse(3, en.uploads.page.split(3, 0, 0))));
    // Two spellings of one number in one file are one number.
    const g = await uploadFixture();
    const twice = await offered(g, [newRow(1, { fieldNumber: "OBAS-00700" }), newRow(2, { fieldNumber: "OBAS-00700" })]);
    expect(twice.html).toContain(esc(en.uploads.page.samplesCantUse(2, en.uploads.page.split(2, 0, 0))));
    // A sample written another way holds the number.
    const h = await uploadFixture();
    const holder = await insertCleanSample(h.conn, { kind: "'net'", sample_number: "'OBAS 00033'", collector_id: String(h.staffer) });
    const held = await offered(h, [newRow(1, { fieldNumber: "OBAS-00033" })]);
    expect(held.html).toContain(esc(en.uploads.page.samplesCantUse(1, en.uploads.page.split(1, 0, 0))));
    expect(holder).toBeGreaterThan(0);
  });
});

describe("rows with no number", () => {
  it("are given exactly the numbers the page shows: the next after the highest, leaving out the file's own and any taken", async () => {
    const f = await uploadFixture();
    await f.conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end, country, state_province, protocol)
      VALUES ('trap', 'OBAS-00040', DATE '${day(1)}', DATE '${day(2)}', 'USA', 'OR', 'vane trap')`);
    const { location, html, digest } = await offered(f, [
      newRow(1, { fieldNumber: "", decimalLatitude: "44.1" }),
      newRow(2, { fieldNumber: "OBAS-00042", decimalLatitude: "44.2" }),
      newRow(3, { fieldNumber: "", decimalLatitude: "44.3" }),
    ]);
    // 00041 and then 00043: the file has 00042 itself.
    expect(html).toContain(esc(en.uploads.page.obasLine(3, "OBAS-00042", "OBAS-00042", 2, "OBAS-00041", "OBAS-00043")));
    await apply(f, location, { digest });
    expect((await rows(f.conn, `SELECT row_number, sample_number FROM upload_sample_outcome ORDER BY 1`)).map((r) => r[1])).toEqual(["OBAS-00041", "OBAS-00042", "OBAS-00043"]);
    // Taken meanwhile: the row is refused, not renumbered, and the others are made.
    await f.conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end, country, state_province, protocol)
      VALUES ('net', 'OBAS-00041', DATE '${day(1)}', DATE '${day(2)}', 'USA', 'OR', 'net')`);
    expect(await applyPending(deps(f))).toEqual({ created: 2, refused: 1, skipped: 0, stopped: 0 });
    expect((await outcomes(f)).map((r) => [r[1], r[2]])).toEqual([["refused", "OBAS-00041"], ["created", "OBAS-00042"], ["created", "OBAS-00043"]]);
  });

  it("are part of the digest, so a number that changed between the preview and Apply refuses", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1, { fieldNumber: "" })]);
    await f.conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end, country, state_province, protocol)
      VALUES ('trap', 'OBAS-00011', DATE '${day(1)}', DATE '${day(2)}', 'USA', 'OR', 'vane trap')`);
    expect((await apply(f, location, { digest })).status).toBe(409);
  });

  it("cannot be used past OBAS-99999", async () => {
    const f = await uploadFixture();
    await f.conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end, country, state_province, protocol)
      VALUES ('trap', 'OBAS-99999', DATE '${day(1)}', DATE '${day(2)}', 'USA', 'OR', 'vane trap')`);
    const { html } = await offered(f, [newRow(1, { fieldNumber: "" })]);
    expect(html).toContain(esc(en.uploads.page.samplesCantUse(1, en.uploads.page.split(1, 0, 0))));
  });
});

describe("the page of an upload that was applied", () => {
  it("is read from the outcome rows, and does not refresh once the upload is stopped", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1), newRow(2)]);
    await apply(f, location, { digest });
    const waiting = await f.app.request(location);
    expect(waiting.headers.get("refresh")).toBe("5");
    await expect(applyPending(deps(f, { conn: new Proxy(f.conn, { get: (t, k) => (k === "runAndReadAll" ? async () => { throw new Error("boom"); } : (typeof Reflect.get(t, k) === "function" ? (Reflect.get(t, k) as (...a: unknown[]) => unknown).bind(t) : Reflect.get(t, k))) }) }))).rejects.toThrow("boom");
    const stopped = await f.app.request(location);
    expect(stopped.headers.get("refresh")).toBeNull();
    expect(await stopped.text()).toContain(esc(en.uploads.page.samplesApplying(0, 2)));
  });
});

describe("rows of one file against each other", () => {
  const same = (n: number, over: Record<string, TestCell> = {}) => newRow(n, { fieldNumber: `YPT${n}`, decimalLatitude: "44.1", decimalLongitude: "-123.3", ...over });

  it("holds a row that looks like an earlier row, naming that row, unless it is ticked", async () => {
    const f = await uploadFixture();
    const { location, html, digest } = await offered(f, [same(1), same(2)]);
    expect(html).toContain(esc(en.uploads.page.samplesHeld(1, en.uploads.page.split(1, 0, 0))));
    const first = Number((await rows(f.conn, `SELECT count(*) FROM sample`))[0]![0]) + 2;
    expect(html).toContain(esc(en.uploads.page.heldRowOfFile(first, "YPT1")));
    const notes = matrixOf(new Uint8Array(await (await f.app.request(`${location}/notes`)).arrayBuffer()));
    expect(notes.at(-1)!.at(-1)).toContain(`row ${first} (YPT1) of this file`);
    // Ticked, both are made.
    await apply(f, location, { digest, anyway: [first + 1] });
    expect(await applyPending(deps(f))).toEqual({ created: 2, refused: 0, skipped: 0, stopped: 0 });
  });

  it("does not hold rows with another collector, other days or another place", async () => {
    const f = await uploadFixture();
    const { html } = await offered(f, [same(1), same(2, { recordedBy: "Sam Staff" }), same(3, { eventDate: day(20) }), same(4, { decimalLatitude: "44.2" })]);
    expect(html).not.toContain("for a tick below");
  });
});

describe("undoing and trying again", () => {
  it("settles an upload's waiting rows as left alone, so nothing more is made; Try again needs a stopped upload", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1), newRow(2)]);
    await apply(f, location, { digest });
    await applyPending(deps(f, { afterRow: undefined }));
    // A third row still waiting, with the upload stopped.
    await f.conn.run(`UPDATE upload_sample_outcome SET outcome = 'pending', sample_id = NULL WHERE sample_number = 'OBAS-00012'`);
    await f.conn.run(`UPDATE upload_applied SET stopped_at = now(), stopped_row = 5`);
    const done = await f.app.request(`${location}/delete-samples`, { method: "POST", headers: { origin: ORIGIN }, body: new FormData() });
    expect(done.status).toBe(200);
    expect((await outcomes(f)).map((r) => r[1])).toEqual(["created", "skipped"]);
    expect(String((await outcomes(f))[1]![3])).toContain("upload was undone");
    expect(await applyWaiting(f.db)).toBe(false);
    // Not stopped: Try again does nothing.
    await f.conn.run(`UPDATE upload_applied SET stopped_at = NULL, stopped_row = NULL`);
    const started: string[] = [];
    const g = await uploadFixture("staffer", { jobs: { list: [], start: async (n) => (started.push(n), true) } });
    const queued = await offered(g, [newRow(1)]);
    await apply(g, queued.location, { digest: queued.digest });
    started.length = 0;
    await g.app.request(`${queued.location}/apply-samples/retry`, { method: "POST", headers: { origin: ORIGIN }, body: new FormData() });
    expect(started).toEqual([]);
  });
});

describe("deleting from an explicit list", () => {
  it("covers every table that names a sample, or says in NEVER_DELETED that it refuses", async () => {
    const f = await uploadFixture();
    const found = (await rows(f.conn, `SELECT table_name, constraint_column_names FROM duckdb_constraints() WHERE constraint_type = 'FOREIGN KEY' AND referenced_table = 'sample'`)) as Array<[string, unknown]>;
    const known = new Set<string>([...DELETED_WITH_SAMPLE, ...NEVER_DELETED]);
    const unknown = found.map(([t]) => t).filter((t) => !known.has(t));
    // A new table that names a sample must be decided: deleted with it, or never deleted (and the delete refuses).
    expect(unknown).toEqual([]);
    for (const [, columns] of found) expect(JSON.stringify(columns)).toContain("sample_id");
    for (const t of known) expect(found.map(([n]) => n), t).toContain(t);
  });

  it("refuses a sample that a table outside the list records, with a sentence", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1)]);
    await apply(f, location, { digest });
    await applyPending(deps(f));
    const [[id]] = (await rows(f.conn, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00011'`)) as [[number]];
    await f.conn.run(`INSERT INTO sample_legacy_observation (sample_id, inat_observation_id) VALUES (${id}, 1)`);
    expect(await deleteTrapSample(f.conn, id, f.staffer)).toEqual({ refused: "has_other_records" });
    expect(en.trapSample.delete.refused.has_other_records).toBeTruthy();
  });

  it("deletes a released sample's release events and place stamp with it, through the delete and through the undo", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1), newRow(2, { decimalLatitude: "44.2" })]);
    await apply(f, location, { digest });
    await applyPending(deps(f));
    const ids = ((await rows(f.conn, `SELECT entity_id FROM sample WHERE sample_number IN ('OBAS-00011', 'OBAS-00012') ORDER BY sample_number`)) as Array<[number]>).map((r) => r[0]);
    for (const id of ids) {
      await f.conn.run(`INSERT INTO sample_print_release_event (sample_id, action, person_id) VALUES (${id}, 'release', ${f.staffer})`);
      await f.conn.run(`INSERT INTO sample_print_release_event (sample_id, action, person_id) VALUES (${id}, 'withdraw', ${f.staffer})`);
      await f.conn.run(`INSERT INTO sample_print_release_event (sample_id, action, person_id) VALUES (${id}, 'release', ${f.staffer})`);
      await f.conn.run(`INSERT INTO sample_place_stamped (sample_id, latitude, longitude) VALUES (${id}, 44.5, -123.2)`);
    }
    const left = (id: number) =>
      rows(f.conn, `SELECT (SELECT count(*) FROM sample_print_release_event WHERE sample_id = ${id}), (SELECT count(*) FROM sample_place_stamped WHERE sample_id = ${id}), (SELECT count(*) FROM sample WHERE entity_id = ${id})`);
    expect(await left(ids[0]!)).toEqual([[3n, 1n, 1n]]);
    // The single delete.
    expect(await deleteTrapSample(f.conn, ids[0]!, f.staffer)).toEqual({ deleted: "OBAS-00011" });
    expect(await left(ids[0]!)).toEqual([[0n, 0n, 0n]]);
    // The undo of the upload, which deletes what is left.
    const done = await f.app.request(`${location}/delete-samples`, { method: "POST", headers: { origin: ORIGIN }, body: new FormData() });
    expect(done.status).toBe(200);
    expect(await left(ids[1]!)).toEqual([[0n, 0n, 0n]]);
  });

  it("writes no release for a settled-season sample an upload by staff made: staff release it from its page", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1, { eventDate: `${SETTLED_SEASON}-07-10` })]);
    await apply(f, location, { digest });
    expect(await applyPending(deps(f))).toMatchObject({ created: 1 });
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE sample_number = 'OBAS-00011' AND date_start < (SELECT active_since FROM season)`)).toEqual([[1n]]);
    expect(await rows(f.conn, `SELECT count(*) FROM sample_print_release_event`)).toEqual([[0n]]);
  });

  it("offers the Delete button for a deletion cut short, which has no entry mark", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1)]);
    await apply(f, location, { digest });
    await applyPending(deps(f));
    const [[id]] = (await rows(f.conn, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00011'`)) as [[number]];
    await f.conn.run(`INSERT INTO sample_deletion (sample_id, sample_number, deleted_by, deleted_at) VALUES (${id}, 'OBAS-00011', ${f.staffer}, now())`);
    for (const t of DELETED_WITH_SAMPLE) await f.conn.run(`DELETE FROM ${t} WHERE sample_id = ${id}`);
    expect(await (await f.app.request(`/samples/${id}`)).text()).toContain(`href="/samples/${id}/delete"`);
  });
});

describe("guards on the marks", () => {
  it("clearStopped says whether it changed a row", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1)]);
    await apply(f, location, { digest });
    const [[uploadId]] = (await rows(f.conn, `SELECT upload_id FROM upload_applied`)) as [[number]];
    expect(await clearStopped(f.db, uploadId)).toBe(false);
    await f.conn.run(`UPDATE upload_applied SET stopped_at = now(), stopped_row = 4`);
    expect(await clearStopped(f.db, uploadId)).toBe(true);
    expect(await clearStopped(f.db, uploadId)).toBe(false);
  });

  it("reports to the observer any error that is not the run's own interruption, even with the signal set", async () => {
    const f = await uploadFixture();
    const heard: unknown[] = [];
    const stop = new AbortController();
    stop.abort();
    const job: Job = { name: "x", schedule: { kind: "onDemand" }, window: "interactive", async run() { throw new Error("a real fault"); } };
    await runJob({ db: f.db, conn: f.conn, observe: () => (_o, err) => void heard.push(err) }, job, stop.signal);
    expect(heard.map((e) => (e as Error).message)).toEqual(["a real fault"]);
  });
});

describe("undoing an upload", () => {
  it("deletes every sample the upload made that can be deleted, lists the rest with why, and says so in the page and the notes", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1), newRow(2, { decimalLatitude: "44.2" }), newRow(3, { decimalLatitude: "44.3" })]);
    await apply(f, location, { digest });
    // Not while the job is still working on it.
    expect(await (await f.app.request(`${location}/delete-samples`)).text()).toContain(esc(en.uploads.page.undo.working));
    expect((await f.app.request(`${location}/delete-samples`, { method: "POST", headers: { origin: ORIGIN }, body: new FormData() })).status).toBe(409);
    await applyPending(deps(f));
    expect(await (await f.app.request(location)).text()).toContain(`${location}/delete-samples`);
    // One of the three gets a specimen on a printed label.
    const [[printed]] = (await rows(f.conn, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00012'`)) as [[number]];
    const [[sp]] = (await rows(f.conn, `INSERT INTO specimen (sample_id, specimen_number) VALUES (${printed}, 1) RETURNING entity_id`)) as [[number]];
    expect(sp).toBeGreaterThan(0);
    const confirm = await (await f.app.request(`${location}/delete-samples`)).text();
    expect(confirm).toContain(esc(en.uploads.page.undo.explain));
    const done = await f.app.request(`${location}/delete-samples`, { method: "POST", headers: { origin: ORIGIN }, body: new FormData() });
    expect(done.status).toBe(200);
    const text = await done.text();
    expect(text).toContain(esc(en.uploads.page.undo.done(2, 1)));
    expect(text).toContain(esc(en.uploads.page.undo.row("OBAS-00012", en.trapSample.delete.refused.printed!)));
    expect(await rows(f.conn, `SELECT sample_number FROM sample WHERE sample_number LIKE 'OBAS-%' ORDER BY 1`)).toEqual([["OBAS-00012"]]);
    expect(await rows(f.conn, `SELECT sample_number FROM sample_deletion ORDER BY 1`)).toEqual([["OBAS-00011"], ["OBAS-00013"]]);
    // The upload's own record stands, and the page and the notes say what became of them.
    expect(await rows(f.conn, `SELECT count(*) FROM upload_sample_outcome WHERE outcome = 'created'`)).toEqual([[3n]]);
    const page = await (await f.app.request(location)).text();
    expect(page).toContain(esc(en.uploads.page.samplesCreated(3, 2)));
    const notes = matrixOf(new Uint8Array(await (await f.app.request(`${location}/notes`)).arrayBuffer()));
    const head = notes[0]!;
    const note = (number: string) => notes.find((r) => r[head.indexOf("fieldNumber")] === number)![head.length - 1];
    expect(note("OBAS-00011")).toBe(en.uploads.notes.createdDeleted("OBAS-00011"));
    expect(note("OBAS-00012")).toBe(en.uploads.notes.created("OBAS-00012"));
    // Staff only.
    const volunteer = f.appAs("volunteer");
    expect((await volunteer.request(`${location}/delete-samples`)).status).toBe(404);
  });
});


describe("an entered sample whose season has settled", () => {
  it("stays with whoever entered it and with staff, and its other collectors lose the form", async () => {
    const f = await uploadFixture();
    const entered = async (season: number, number: string, by: number) => {
      const id = await insertCleanSample(f.conn, { kind: "'trap'", sample_number: `'${number}'`, collector_id: String(f.volunteer), date_start: `DATE '${season}-06-02'`, date_end: `DATE '${season}-06-02'` });
      await f.conn.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES (${id}, ${by})`);
      return id;
    };
    // The volunteer is a collector of all three; staff entered two of them, the volunteer one.
    const current = await entered(CURRENT_SEASON, "OBAS-00051", f.staffer);
    const settled = await entered(SETTLED_SEASON, "OBAS-00052", f.staffer);
    const settledOwn = await entered(SETTLED_SEASON, "OBAS-00053", f.volunteer);
    expect(await mayEditTrapSample(f.conn, current, f.volunteer, false)).toBe(true);
    expect(await mayEditTrapSample(f.conn, settled, f.volunteer, false)).toBe(false);
    expect(await mayEditTrapSample(f.conn, settledOwn, f.volunteer, false)).toBe(true);
    expect(await mayEditTrapSample(f.conn, settled, f.staffer, true)).toBe(true);
    const volunteer = f.appAs("volunteer");
    expect((await volunteer.request(`/samples/${current}/trap`)).status).toBe(200);
    expect((await volunteer.request(`/samples/${settled}/trap`)).status).toBe(404);
    expect((await volunteer.request(`/samples/${settledOwn}/trap`)).status).toBe(200);
    expect((await f.app.request(`/samples/${settled}/trap`)).status).toBe(200);
  });
});

describe("the listing's Place pencil for an entered sample", () => {
  it("follows the same rule: the enterer and staff once settled, any collector before", async () => {
    const { placeEditable } = await import("../src/app/views/listings.js");
    const row = (over: Record<string, unknown>) => ({ location_withheld: false, entered: true, printed: false, mine: false, entered_by_me: false, entered_settled: false, ...over }) as never;
    expect(placeEditable(row({ mine: true }), false)).toBe(true);
    expect(placeEditable(row({ mine: true, entered_settled: true }), false)).toBe(false);
    expect(placeEditable(row({ mine: true, entered_by_me: true, entered_settled: true }), false)).toBe(true);
    expect(placeEditable(row({ entered_settled: true }), true)).toBe(true);
  });
});

describe("a bounded run", () => {
  it("ends after its row limit with the rest pending, and the next run goes on; its time limit ends it too", async () => {
    expect(APPLY_ROW_LIMIT).toBe(200);
    expect(APPLY_TIME_LIMIT_MS).toBe(5 * 60_000);
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1), newRow(2), newRow(3), newRow(4), newRow(5)]);
    await apply(f, location, { digest });
    expect(await applyPending(deps(f, { limits: { rows: 2 } }))).toEqual({ created: 2, refused: 0, skipped: 0, stopped: 0 });
    expect((await outcomes(f)).map((r) => r[1])).toEqual(["created", "created", "pending", "pending", "pending"]);
    expect(await applyWaiting(f.db)).toBe(true);
    // The clock: a run that has used its time makes no row.
    let at = 0;
    const clock = () => (at += 100);
    expect(await applyPending(deps(f, { limits: { ms: 250, now: clock } }))).toEqual({ created: 2, refused: 0, skipped: 0, stopped: 0 });
    expect(await applyPending(deps(f))).toEqual({ created: 1, refused: 0, skipped: 0, stopped: 0 });
    expect(await applyWaiting(f.db)).toBe(false);
  });

  it("lets a due clock job run before the rest: the scheduler resumes the upload after it", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1), newRow(2), newRow(3)]);
    await apply(f, location, { digest });
    const order: string[] = [];
    const apply1: Job = {
      name: "apply",
      schedule: { kind: "onDemand" },
      window: "interactive",
      waiting: () => applyWaiting(f.db),
      async run() {
        order.push("apply");
        await applyPending(deps(f, { limits: { rows: 1 } }));
      },
    };
    const clockJob: Job = { name: "clock", schedule: { kind: "everyMinutes", minutes: 0.0001 }, window: "interactive", async run() { order.push("clock"); } };
    const scheduler = startScheduler({ db: f.db, conn: f.conn, jobs: [clockJob, apply1], tickMs: 20 });
    for (let i = 0; i < 200 && (await applyWaiting(f.db)); i++) await new Promise((r) => setTimeout(r, 25));
    await scheduler.stop({ graceMs: 2000 });
    expect(order.filter((x) => x === "apply")).toHaveLength(3);
    expect(order).toContain("clock");
    // The clock job ran between two runs of the upload, not after all of them.
    expect(order.indexOf("clock")).toBeLessThan(order.lastIndexOf("apply"));
  });
});

describe("the next number and the holder check", () => {
  it("counts the highest among valid series numbers only, folded, and finds a holder in any spelling", async () => {
    const f = await uploadFixture();
    const sample = (n: string) =>
      f.conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end, country, state_province, protocol)
        VALUES ('net', '${n}', DATE '${day(1)}', DATE '${day(2)}', 'USA', 'OR', 'net')`);
    await sample("OBAS-00030");
    // Not valid series numbers: too long, too short.
    await sample("OBAS-100000");
    await sample("OBAS-1204");
    expect(await highestSeriesNumber(f.conn)).toBe(30);
    // Another spelling counts, folded.
    await sample("OBAS 00040");
    expect(await highestSeriesNumber(f.conn)).toBe(40);
    // A holder in a spelling with separators among the letters.
    await sample("O.BAS-00033");
    expect(await seriesNumberHolder(f.conn, "OBAS-00033")).toMatchObject({ kind: "net" });
    expect(await seriesNumberHolder(f.conn, "OBAS-00034")).toBeNull();
    // And a blank row is numbered from the valid highest.
    const { html } = await offered(f, [newRow(1, { fieldNumber: "" })]);
    expect(html).toContain(esc(en.uploads.page.obasLine(1, null, null, 1, "OBAS-00041", "OBAS-00041")));
  });
});

describe("the page of a file that is queued", () => {
  it("says it is queued while rows wait, then the stop alone if stopped, and applied only when nothing waits", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1)]);
    await apply(f, location, { digest });
    const queued = await (await f.app.request(location)).text();
    expect(queued).toContain("Queued on");
    expect(queued).not.toContain("Applied on");
    await f.conn.run(`UPDATE upload_applied SET stopped_at = now(), stopped_row = 4`);
    const stopped = await (await f.app.request(location)).text();
    expect(stopped).toContain(esc(en.uploads.page.samplesStopped(4)));
    expect(stopped).not.toContain("Queued on");
    expect(stopped).not.toContain("Applied on");
    await f.conn.run(`UPDATE upload_applied SET stopped_at = NULL, stopped_row = NULL`);
    await applyPending(deps(f));
    expect(await (await f.app.request(location)).text()).toContain("Applied on");
  });
});

describe("smaller guards of the apply", () => {
  it("refuses a queued change whose payload cannot be read, and changes nothing", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1)]);
    await apply(f, location, { digest });
    // A queued new row made into a change of an existing sample whose payload is not what the job writes from.
    await f.conn.run(`UPDATE upload_sample_outcome SET unit = 'collectors', sample_id = ${f.ids.sampleA}, payload = 'not json'`);
    expect(await applyPending(deps(f))).toEqual({ created: 0, refused: 0, skipped: 0, stopped: 0, notApplied: 1 });
    expect(String((await outcomes(f))[0]![3])).toContain("cannot be read");
    expect(await rows(f.conn, `SELECT count(*) FROM sample WHERE sample_number = 'OBAS-00011'`)).toEqual([[0n]]);
  });

  it("counts a stored sample's first collector only when it has exactly one at position 1", async () => {
    const f = await uploadFixture();
    const base = { firstCollectorId: f.volunteer, dateStart: day(14), dateEnd: day(14), latitude: 44.5646, longitude: -123.262 };
    expect((await findLookalikes(f.conn, base)).map((l) => l.sampleNumber)).toEqual(["UP-1"]);
    // A second collector at position 1 makes the sample's first collector undefined.
    await f.conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${f.ids.sampleA}, ${f.staffer}, 1)`);
    expect(await findLookalikes(f.conn, base)).toEqual([]);
  });

  it("compares the file's rows against each other only among those that will be made", async () => {
    const f = await uploadFixture();
    const same = (n: number, over: Record<string, TestCell> = {}) => newRow(n, { fieldNumber: `YPT${n}`, decimalLatitude: "44.1", decimalLongitude: "-123.3", ...over });
    // Row 1 cannot be used (a bad date), so row 2 is not held for looking like it; row 4 repeats row 3's number, so row 5 is not held against it.
    const { html } = await offered(f, [same(1, { eventDate: "nope" }), same(2), same(3, { fieldNumber: "YPTX", decimalLatitude: "44.2" }), same(4, { fieldNumber: "YPTX", decimalLatitude: "44.2" }), same(5, { decimalLatitude: "44.2" })]);
    expect(html).not.toContain("for a tick below");
  });

  it("explains a refusal for other records before the button, and under the lock", async () => {
    const f = await uploadFixture();
    const { location, digest } = await offered(f, [newRow(1)]);
    await apply(f, location, { digest });
    await applyPending(deps(f));
    const [[id]] = (await rows(f.conn, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00011'`)) as [[number]];
    await f.conn.run(`INSERT INTO sample_legacy_observation (sample_id, inat_observation_id) VALUES (${id}, 1)`);
    expect(await deletable(f.conn, id)).toEqual({ refused: "has_other_records" });
    expect(await (await f.app.request(`/samples/${id}/delete`)).text()).toContain(esc(en.trapSample.delete.refused.has_other_records!));
    expect(await (await f.app.request(`/samples/${id}`)).text()).not.toContain(`href="/samples/${id}/delete"`);
  });
});
