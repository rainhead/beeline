import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { afterEach, describe, expect, it } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { createKysely } from "../src/db.js";
import { sha256 } from "../src/label-pdf.js";
import { runPdf } from "../src/app/print-runs.js";
import { withPrintRunLock } from "../src/print-run.js";
import { createMemoryDb, insertCleanSample, CURRENT_SEASON, rows, scratchPaths } from "./helpers.js";

/**
 * The print-run screens end to end (beeline-1kb.2, beeline-1kb.4): prepare
 * from the form, proof the run page, download the sheets, walk the states,
 * and see the result on a volunteer's sample and specimen pages.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const ORIGIN = "http://localhost:3054";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function printApp(signedInAs: "ash" | "staffer" = "staffer") {
  const { instance, conn } = await createMemoryDb();
  const person = async (name: string) => {
    const [given, family] = name.split(" ");
    const [[id]] = (await rows(
      conn,
      `INSERT INTO person (display_name, given_name, family_name) VALUES ('${name}', '${given}', '${family}') RETURNING entity_id`,
    )) as [[number]];
    return id;
  };
  const ash = await person("Ada Ash");
  const birch = await person("Bo Birch");
  const staffer = await person("Sam Staff");
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staffer})`);
  // The fixture's default county is the literal 'BentonCo'; a real one is bare.
  const ashSample = await insertCleanSample(conn, {
    collector_id: String(ash),
    specimen_count: "3",
    county: "'Benton'",
    atlas_id: `(SELECT entity_id FROM atlas WHERE code = 'OBA')`,
  });
  const birchSample = await insertCleanSample(conn, {
    collector_id: String(birch),
    specimen_count: "1",
    sample_number: "'2'",
    county: "NULL",
  });
  const dir = await mkdtemp(join(tmpdir(), "beeline-print-runs-"));
  dirs.push(dir);
  const people = { ash, staffer };
  const db = createKysely(instance);
  const paths = await scratchPaths();
  /** The same store, seen by somebody else. */
  const appFor = (who: "ash" | "staffer") =>
    createApp({
      ...paths,
      db,
      config: { environment: "sandbox" as const, origin: ORIGIN },
      inat: unusedInat,
      resolveSession: async () => ({ personId: people[who], login: who, iconUrl: null }),
      printConn: conn,
      printRunsDir: dir,
    });
  const app = appFor(signedInAs);
  const post = (path: string, body: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { origin: ORIGIN }, body: new URLSearchParams(body) });
  return { app, appFor, conn, db, post, dir, ash, birch, ashSample, birchSample };
}

/**
 * The first number the store's first run minted, which must be the floor of
 * the year that run was prepared in. The app numbers by its own clock, so that
 * is 26000001 in 2026 and 27000001 in 2027; the year is read off the run's
 * prepared_at, in Pacific time as nextFieldNumber reads it, rather than off
 * the test's clock, which could cross New Year between the two.
 */
async function firstFieldNumber(conn: DuckDBConnection): Promise<string> {
  const [[first, preparedAt]] = (await rows(
    conn,
    `SELECT (SELECT min(field_number) FROM minted_field_number), (SELECT min(prepared_at) FROM print_run)`,
  )) as [[string, { micros: bigint }]];
  const year = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "2-digit" }).format(
    new Date(Number(preparedAt.micros / 1000n)),
  );
  expect(first).toBe(`${year}000001`);
  return first;
}

describe("the print-run screens", () => {
  it("are staff tools: gated, and in the menu only for an admin", async () => {
    const volunteer = await printApp("ash");
    expect((await volunteer.app.request("/print-runs")).status).toBe(403);
    expect((await volunteer.post("/print-runs")).status).toBe(403);
    const staff = await printApp();
    const body = await (await staff.app.request("/print-runs")).text();
    expect(body).toContain(`href="/print-runs"`);
    expect(body).toContain("No print runs yet.");
    // The Prepare form says what it will take before anyone presses it.
    expect(body).toContain("Everyone Oregon prints for — 4 labels for 2 samples waiting");
    // No atlas prints its own labels, so no atlas is a scope of its own.
    expect(body).not.toContain("Oregon Bee Atlas —");
    expect(body).not.toContain("Washington Bee Atlas —");
    await staff.conn.run(`INSERT INTO atlas_printing SELECT entity_id FROM atlas WHERE code = 'WaBA'`);
    const flagged = await (await staff.app.request("/print-runs")).text();
    expect(flagged).toContain("Washington Bee Atlas — nothing waiting");
    expect(flagged).not.toContain("Oregon Bee Atlas —");
  });

  it("refuses a run scoped to an atlas that does not print its own labels, in words", async () => {
    const { conn, post } = await printApp();
    const [[oba]] = (await rows(conn, `SELECT entity_id FROM atlas WHERE code = 'OBA'`)) as [[number]];
    const refused = await post("/print-runs", { atlas_id: String(oba) });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("that atlas does not print its own labels");
    expect(Number(((await rows(conn, "SELECT count(*) FROM print_run")) as [[bigint]])[0][0])).toBe(0);
  });

  it("prepares, proofs, downloads, and walks prepared → approved → printed → mailed", async () => {
    const { app, conn, post, dir, ashSample, birchSample } = await printApp();

    const prepared = await post("/print-runs", { atlas_id: "" });
    expect(prepared.status).toBe(302);
    const runPath = prepared.headers.get("location")!;
    expect(runPath).toMatch(/^\/print-runs\/\d+$/);

    let page = await (await app.request(runPath)).text();
    expect(page).toContain("4 labels for 2 samples from 2 collectors, on 1 sheet.");
    expect(page).toContain("Prepared</span>");
    // The proofing table: the six strings, in sheet order, with the blank
    // cell between collectors visible as cell 4 following cell 2.
    expect(page).toContain("USA:OR:BentonCo Corvallis");
    expect(page).toContain(`14.VII${CURRENT_SEASON}-1.1`);
    const table = page.slice(page.indexOf("Labels</h2>"));
    expect(table).toContain("A.Ash");
    expect(table).toContain("B.Birch");
    expect(table.indexOf("A.Ash")).toBeLessThan(table.indexOf("B.Birch"));
    // Bo's sample has no county: one label to look at, said at the top.
    expect(page).toContain("1 label to look at");
    expect(page).toContain("county missing");
    expect(page).not.toMatch(/<td><\/td>/);
    expect(page).toContain("Approve</button>");
    expect(page).toContain("Cancel run</button>");
    // One form, two destinations: the note typed goes with whichever button
    // is pressed, so Cancel is not an empty form of its own.
    expect(page).toContain(`formaction="${runPath}/cancel"`);
    expect(page).not.toContain("cancel-form");

    // A file already sitting where the cache goes is not this run's until the
    // run vouches for it: a reseed restarts ids while the directory survives.
    await writeFile(join(dir, `run-${runPath.split("/").pop()}.pdf`), "somebody else's labels");

    // The sheets: rendered once, kept, and hashed on the run.
    const pdf = await app.request(`${runPath}/labels.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const [[recorded]] = (await rows(conn, `SELECT pdf_sha256 FROM print_run`)) as [[string]];
    expect(recorded).toBe(sha256(bytes));
    const cached = await readFile(join(dir, `run-${runPath.split("/").pop()}.pdf`));
    expect(sha256(cached)).toBe(recorded);
    const again = new Uint8Array(await (await app.request(`${runPath}/labels.pdf`)).arrayBuffer());
    expect(sha256(again)).toBe(recorded);
    // And a cached file that stops matching the recorded hash is re-rendered,
    // not served.
    await writeFile(join(dir, `run-${runPath.split("/").pop()}.pdf`), "tampered");
    const repaired = new Uint8Array(await (await app.request(`${runPath}/labels.pdf`)).arrayBuffer());
    expect(sha256(repaired)).toBe(recorded);

    // Out of order is refused with the state it is in.
    const early = await post(`${runPath}/printed`);
    expect(early.status).toBe(409);
    expect(await early.text()).toContain("prepared");

    expect((await post(`${runPath}/approve`, { note: "proofed two labels" })).status).toBe(302);
    page = await (await app.request(runPath)).text();
    expect(page).toContain("Approved</span>");
    expect(page).toContain("Mark printed</button>");
    expect(page).toContain(`value="proofed two labels"`);

    // Not printed yet: nothing is locked.
    expect(await rows(conn, `SELECT sample_id FROM printed_sample`)).toEqual([]);
    expect((await post(`${runPath}/printed`)).status).toBe(302);
    expect(await rows(conn, `SELECT count(*) FROM printed_sample`)).toEqual([[2n]]);
    page = await (await app.request(runPath)).text();
    expect(page).toContain("Mark mailed</button>");
    expect(page).not.toContain("Cancel run</button>");
    expect((await post(`${runPath}/cancel`)).status).toBe(409);

    expect((await post(`${runPath}/mailed`)).status).toBe(302);
    page = await (await app.request(runPath)).text();
    expect(page).toContain("Mailed</span>");
    expect(page).toContain("This run is finished.");

    // The list shows it, with every date that has arrived and none blank.
    const list = await (await app.request("/print-runs")).text();
    expect(list).toContain("Sam Staff");
    expect(list).not.toMatch(/<td><\/td>/);
    expect(list).toContain("Everyone Oregon prints for — nothing waiting");

    // And the records say where the labels are, in a volunteer's words.
    const sample = await (await app.request(`/samples/${ashSample}`)).text();
    expect(sample).toContain("Mailed ");
    const first = await firstFieldNumber(conn);
    expect(sample).toContain(first);
    const [[specimenId]] = (await rows(conn, `SELECT entity_id FROM specimen WHERE field_number = '${first}'`)) as [
      [number],
    ];
    const specimen = await (await app.request(`/specimens/${specimenId}`)).text();
    expect(specimen).toContain("Labels</h2>");
    expect(specimen).toContain(`href="${runPath}"`);
    expect(specimen).toContain("Mailed");
    expect(specimen).not.toMatch(/<td><\/td>/);
    void birchSample;
  });

  it("says when nothing was waiting, and shows a canceled run's leftovers honestly", async () => {
    const { app, conn, post, ashSample } = await printApp();
    const first = await post("/print-runs", { atlas_id: "" });
    const runPath = first.headers.get("location")!;
    const empty = await post("/print-runs", { atlas_id: "" });
    expect(empty.headers.get("location")).toBe("/print-runs?prepared=nothing");
    const list = await (await app.request("/print-runs?prepared=nothing")).text();
    expect(list).toContain("Nothing was waiting to print in that scope, so no run was prepared.");

    expect((await post(`${runPath}/cancel`, { note: "wrong week" })).status).toBe(302);
    const page = await (await app.request(runPath)).text();
    expect(page).toContain("Canceled</span>");
    expect(page).toContain("wrong week");
    // The labels stay on the page as the record of what was prepared — but
    // there are no sheets to print: the numbers are burned.
    const burned = await firstFieldNumber(conn);
    expect(page).toContain(burned);
    expect(page).not.toContain("labels.pdf");
    const sheets = await app.request(`${runPath}/labels.pdf`);
    expect(sheets.status).toBe(409);
    expect(await sheets.text()).toContain("canceled");
    // The volunteer's specimen rows say what happened rather than going blank
    // — and say it as a number taken back, not as a label from before
    // numbering, which is what "not numbered" means elsewhere (beeline-1kb.21).
    const sample = await (await app.request(`/samples/${ashSample}`)).text();
    expect(sample).toContain("run canceled; it will be numbered again in the next run");
    expect(sample).toContain("awaiting a number");
    expect(sample).not.toContain("not numbered");
    expect(sample).not.toMatch(/<td><\/td>/);
    // The specimen page tells the same story, names the burned number, and
    // keeps it in the Labels table, where a proof sheet from the canceled
    // run can still be matched to its specimen.
    const [[specimenId]] = (await rows(conn, `SELECT entity_id FROM specimen WHERE sample_id = ${ashSample} ORDER BY specimen_number LIMIT 1`)) as [[number]];
    const specimen = await (await app.request(`/specimens/${specimenId}`)).text();
    expect(specimen).toContain(`${burned} was taken back when`);
    expect(specimen).toContain("was canceled; the next run will number this specimen again.");
    expect(specimen).not.toContain("predates field numbering");
    expect(specimen).toContain(`<span class="mono">${burned}</span>`);
    // And the listing, which cannot see the Label column, says the same.
    const listing = await (await app.request("/specimens?scope=all")).text();
    expect(listing).toContain("awaiting a number");
    expect(await rows(conn, `SELECT count(*) FROM pending_print_sample`)).toEqual([[2n]]);
  });

  it("keeps a sample on its collector's front page until the labels are mailed", async () => {
    // The freeze takes a sample out of pending at once, and the front page
    // listed only what was pending — so a sample vanished from it when its run
    // was prepared, days before an envelope went anywhere (seen in the first
    // demonstration, 2026-09-18).
    const { appFor, post } = await printApp();
    const home = async () => (await appFor("ash").request("/")).text();
    expect(await home()).toContain("3 labels to print");

    const runPath = (await post("/print-runs", { atlas_id: "" })).headers.get("location")!;
    let page = await home();
    expect(page).toContain("3 labels are being printed");
    expect(page).not.toContain("labels to print");
    expect(page).toContain("1 sample is waiting on labels");

    await post(`${runPath}/approve`);
    expect(await home()).toContain("3 labels are being printed");

    await post(`${runPath}/printed`);
    page = await home();
    expect(page).toMatch(/3 labels printed [A-Z][a-z]{2} \d{1,2}, \d{4}, not mailed yet/);
    expect(page).toContain("1 sample is waiting on labels");

    await post(`${runPath}/mailed`);
    page = await home();
    expect(page).not.toContain("labels printed");
    // The lede and the all-clear both say the words; the summary must not.
    expect(page).not.toContain("sample is waiting on labels");
    expect(page).toContain("none are waiting on labels");
  });

  it("answers a refusal with its reason, not a bare failure", async () => {
    const { app, conn, post } = await printApp();
    const runPath = (await post("/print-runs", { atlas_id: "" })).headers.get("location")!;
    // Somebody identifies a specimen before the run prints: cancel is refused.
    await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('genus', 'Bombus')`);
    await conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, verbatim_identification)
       SELECT min(sp.entity_id), (SELECT min(entity_id) FROM animal), false, 'in_app', 'Bombus' FROM specimen sp`,
    );
    const refused = await post(`${runPath}/cancel`, { note: "wrong week" });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("1 of its specimens has already been identified");
    expect(await (await app.request(runPath)).text()).toContain("Prepared</span>");

    // A run that is not there is a 404 in words, not "the run is null".
    const missing = await post("/print-runs/999999/approve");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("<p>No such print run.</p>");

    // And a pending sample that is not fit to freeze stops Prepare, by name.
    const broken = await printApp();
    await broken.conn.run(`UPDATE sample_collector SET position = 2 WHERE sample_id = ${broken.ashSample}`);
    const stopped = await broken.post("/print-runs", { atlas_id: "" });
    expect(stopped.status).toBe(409);
    expect(await stopped.text()).toContain(`sample ${broken.ashSample} is waiting to print`);
    expect(await rows(broken.conn, `SELECT count(*) FROM print_run`)).toEqual([[0n]]);
  });

  it("never serves a canceled run's sheets when the cancel reached the lock first", async () => {
    const { app, post } = await printApp();
    const runPath = (await post("/print-runs", { atlas_id: "" })).headers.get("location")!;
    // Hold the print-run lock, queue the cancel behind it, then the download
    // behind that. The download reads the run's state inside the lock, so it
    // sees the cancel that went first — before the lock covered the read, it
    // checked the state early and served the burned numbers anyway.
    let release!: () => void;
    const held = withPrintRunLock(() => new Promise<void>((resolve) => (release = resolve)));
    const canceling = post(`${runPath}/cancel`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const downloading = app.request(`${runPath}/labels.pdf`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await held;
    expect((await canceling).status).toBe(302);
    expect((await downloading).status).toBe(409);
  });

  /**
   * The render moved to a worker thread (beeline-1kb.19), which makes two
   * people opening the same unrendered run at once a real possibility rather
   * than a theoretical one: in process the second request queued behind the
   * first on the one thread, and now it would start a second worker on
   * identical input and write the file twice.
   */
  it("renders a run's sheets once when two people ask at the same time", async () => {
    const { conn, db, dir, post } = await printApp();
    expect((await post("/print-runs", { scope: "" })).status).toBe(302);
    // Through epoch_ms because the raw driver hands back its own timestamp
    // value, and pdf-lib stamps the document with a real Date.
    const [[runId, ms]] = (await rows(conn, `SELECT entity_id, epoch_ms(prepared_at) FROM print_run`)) as [
      [number, bigint],
    ];
    const preparedAt = new Date(Number(ms));

    const first = runPdf(db, runId, preparedAt, null, dir);
    const second = runPdf(db, runId, preparedAt, null, dir);
    // The same promise, which is the whole of the claim: one render, not two.
    expect(second).toBe(first);
    const [a, b] = await Promise.all([first, second]);
    expect(a.sha256).toBe(b.sha256);
    expect(a.cached).toBe(false);

    // And the coalescing is only for the render in flight: once it settles
    // the entry goes, so the next request is a fresh call that finds the file.
    const later = runPdf(db, runId, preparedAt, a.sha256, dir);
    expect(later).not.toBe(first);
    expect((await later).cached).toBe(true);
  });

  it("shows an imported specimen's label as printed before Beeline, never blank", async () => {
    const { app, conn, ashSample } = await printApp("ash");
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${ashSample}, 1, '25000001')`);
    const sample = await (await app.request(`/samples/${ashSample}`)).text();
    expect(sample).toContain("printed before Beeline");
    const [[specimenId]] = (await rows(conn, `SELECT entity_id FROM specimen WHERE field_number = '25000001'`)) as [
      [number],
    ];
    const specimen = await (await app.request(`/specimens/${specimenId}`)).text();
    expect(specimen).toContain("Printed before Beeline");
    // A volunteer sees the labels block without a link into the staff tool.
    expect(specimen).not.toContain(`href="/print-runs`);
  });

});

describe("reprints (gh-218)", () => {
  /** A staffer's app over a store whose first run has printed. */
  async function printed() {
    const env = await printApp();
    const prepared = await env.post("/print-runs");
    const runPath = prepared.headers.get("location")!;
    expect((await env.post(`${runPath}/approve`)).status).toBe(302);
    expect((await env.post(`${runPath}/printed`)).status).toBe(302);
    const [[specimenId]] = (await rows(
      env.conn,
      `SELECT entity_id FROM specimen WHERE sample_id = ${env.ashSample} AND specimen_number = 2`,
    )) as [[number]];
    return { ...env, specimenId };
  }

  it("asks for one label from the specimen page, which says so to staff and collector alike", async () => {
    const { app, appFor, post, specimenId } = await printed();
    const before = await (await app.request(`/specimens/${specimenId}`)).text();
    expect(before).toContain("Reprint this label");
    const asked = await post(`/specimens/${specimenId}/reprint`, { reason: "damaged", note: "pin bent" });
    expect(asked.status).toBe(302);
    expect(asked.headers.get("location")).toBe(`/specimens/${specimenId}`);

    const staffPage = await (await app.request(`/specimens/${specimenId}`)).text();
    expect(staffPage).toContain("Sam Staff asked on");
    expect(staffPage).toContain("Reason: Damaged or lost.");
    expect(staffPage).toContain("Note: pin bent");
    expect(staffPage).toContain("Take back the reprint");
    expect(staffPage).not.toContain("Reprint this label");
    // Asking twice is refused in words, not a fault.
    const twice = await post(`/specimens/${specimenId}/reprint`, {});
    expect(twice.status).toBe(409);
    expect(await twice.text()).toContain("already been asked for");

    // The collector sees the label coming, and has no form and no write.
    const volunteer = appFor("ash");
    const theirs = await (await volunteer.request(`/specimens/${specimenId}`)).text();
    expect(theirs).toContain("Sam Staff asked on");
    expect(theirs).not.toContain("Take back the reprint");
    const refused = await volunteer.request(`/specimens/${specimenId}/reprint`, {
      method: "POST",
      headers: { origin: ORIGIN },
      body: new URLSearchParams({ withdraw: "1" }),
    });
    expect(refused.status).toBe(403);
  });

  it("asks for a whole sample, and the next run prints the reprints after the new labels", async () => {
    const { app, conn, post, ashSample, specimenId } = await printed();
    const samplePage = await (await app.request(`/samples/${ashSample}`)).text();
    expect(samplePage).toContain("Reprint every label in this sample");
    expect(samplePage).toContain("That is 3 specimens now.");
    expect((await post(`/samples/${ashSample}/reprint`, { reason: "never_received" })).status).toBe(302);
    const after = await (await app.request(`/samples/${ashSample}`)).text();
    expect(after).toContain("3 labels are waiting to be reprinted in the next print run.");
    expect(after).toContain("reprint requested");

    // A new sample, so the run holds both series.
    await insertCleanSample(conn, {
      collector_id: "(SELECT min(entity_id) FROM person)",
      specimen_count: "1",
      sample_number: "'8'",
      county: "'Benton'",
    });
    const list = await (await app.request("/print-runs")).text();
    expect(list).toContain("1 label for 1 sample and 3 reprints waiting");
    const prepared = await post("/print-runs");
    const run = await (await app.request(prepared.headers.get("location")!)).text();
    expect(run).toContain("3 of the labels are reprints, after the new ones.");
    // A reprint goes out in its own envelope; it does not split its sample's first mailing.
    expect(run).not.toContain("will arrive in two envelopes");
    expect(
      await rows(
        conn,
        `SELECT pl.cell, rp.specimen_id IS NOT NULL FROM printed_label pl
         LEFT JOIN printed_label_reprint rp USING (print_run_id, specimen_id)
         WHERE pl.print_run_id = (SELECT max(entity_id) FROM print_run) ORDER BY pl.cell`,
      ),
    ).toEqual([
      [0, false],
      // Cell 1 is the blank between the new labels and the reprints.
      [2, true],
      [3, true],
      [4, true],
    ]);

    const specimenPage = await (await app.request(`/specimens/${specimenId}`)).text();
    expect(specimenPage).toContain("Asked for by Sam Staff: never received.");
    // Taken by the run: nothing is waiting, and while the run is unprinted there is no form either.
    expect(specimenPage).not.toContain("Take back the reprint");
    expect(specimenPage).toContain("To change that label, cancel the run.");
  });

  it("marks the specimens ticked on the listing, and returns to the same listing (beeline-1kb.23)", async () => {
    const { app, appFor, conn, post, ashSample } = await printed();
    const listing = await (await app.request("/specimens?scope=all")).text();
    expect(listing).toContain(`form="reprint-bulk"`);
    expect(listing).toContain("Mark for reprint");
    // The island keys its stored ticks by who is signed in.
    expect(listing).toContain(`data-bulk-owner="staffer"`);
    const ids = ((await rows(conn, `SELECT entity_id FROM specimen WHERE sample_id = ${ashSample} ORDER BY specimen_number`)) as [
      number,
    ][]).map(([id]) => id);

    // Two ticked, one of them twice: once on this page, once carried from another.
    const body = new URLSearchParams({ back: "/specimens?scope=all", reason: "never_received" });
    body.append("specimen", String(ids[0]));
    body.append("specimen", String(ids[1]));
    body.append("specimen", String(ids[1]));
    const marked = await app.request("/specimens/reprint", { method: "POST", headers: { origin: ORIGIN }, body });
    expect(marked.status).toBe(302);
    expect(marked.headers.get("location")).toBe("/specimens?scope=all&reprinted=2&of=2");
    const after = await (await app.request(marked.headers.get("location")!)).text();
    expect(after).toContain("Marked 2 labels for reprint.");
    expect(after.match(/reprint requested/g)?.length).toBe(2);
    expect(await rows(conn, `SELECT reason FROM pending_reprint ORDER BY specimen_id`)).toEqual([
      ["never_received"],
      ["never_received"],
    ]);

    // Partly marked: one already waiting.
    const again = await post("/specimens/reprint", { specimen: String(ids[1]), back: "https://elsewhere.example/" });
    expect(again.status).toBe(409);
    const some = new URLSearchParams({ back: "https://elsewhere.example/" });
    some.append("specimen", String(ids[1]));
    some.append("specimen", String(ids[2]));
    const partly = await app.request("/specimens/reprint", { method: "POST", headers: { origin: ORIGIN }, body: some });
    // Somewhere else is not a listing, so it lands on the listing itself.
    expect(partly.headers.get("location")).toBe("/specimens?reprinted=1&of=2");
    expect(await (await app.request(partly.headers.get("location")!)).text()).toContain(
      "Marked 1 of 2 labels for reprint.",
    );
    // A listing that already says what an earlier marking did says what this one did instead.
    await post(`/specimens/${ids[2]}/reprint`, { withdraw: "1" });
    const repeat = new URLSearchParams({ back: "/specimens?scope=all&reprinted=9&of=9", specimen: String(ids[2]) });
    const replaced = await app.request("/specimens/reprint", { method: "POST", headers: { origin: ORIGIN }, body: repeat });
    expect(replaced.headers.get("location")).toBe("/specimens?scope=all&reprinted=1&of=1");

    // A volunteer sees the state and no tick boxes, and cannot post.
    const volunteer = appFor("ash");
    const theirs = await (await volunteer.request("/specimens")).text();
    expect(theirs).toContain("reprint requested");
    expect(theirs).not.toContain(`form="reprint-bulk"`);
    const refused = await volunteer.request("/specimens/reprint", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: new URLSearchParams({ specimen: String(ids[0]) }),
    });
    expect(refused.status).toBe(403);
  });

  it("takes back what no run has taken yet", async () => {
    const { app, post, ashSample } = await printed();
    await post(`/samples/${ashSample}/reprint`, {});
    expect((await post(`/samples/${ashSample}/reprint`, { withdraw: "1" })).status).toBe(302);
    const page = await (await app.request(`/samples/${ashSample}`)).text();
    expect(page).not.toContain("waiting to be reprinted");
    expect(page).toContain("That is 3 specimens now.");
  });
});
