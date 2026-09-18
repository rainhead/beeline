import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { createKysely } from "../src/db.js";
import { sha256 } from "../src/label-pdf.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

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
  const app = createApp({
    db: createKysely(instance),
    config: { environment: "sandbox" as const, origin: ORIGIN },
    inat: unusedInat,
    resolveSession: async () => ({ personId: people[signedInAs], login: signedInAs, iconUrl: null }),
    printConn: conn,
    printRunsDir: dir,
  });
  const post = (path: string, body: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { origin: ORIGIN }, body: new URLSearchParams(body) });
  return { app, conn, post, dir, ash, birch, ashSample, birchSample };
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
    expect(body).toContain("Oregon Bee Atlas — 3 labels for 1 sample waiting");
    expect(body).toContain("Washington Bee Atlas — nothing waiting");
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
    expect(page).toContain("14.VII2026-1.1");
    const table = page.slice(page.indexOf("Labels</h2>"));
    expect(table).toContain("A. Ash");
    expect(table).toContain("B. Birch");
    expect(table.indexOf("A. Ash")).toBeLessThan(table.indexOf("B. Birch"));
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
    expect(sample).toContain("26000001");
    const [[specimenId]] = (await rows(conn, `SELECT entity_id FROM specimen WHERE field_number = '26000001'`)) as [
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
    expect(page).toContain("26000001");
    expect(page).not.toContain("labels.pdf");
    const sheets = await app.request(`${runPath}/labels.pdf`);
    expect(sheets.status).toBe(409);
    expect(await sheets.text()).toContain("canceled");
    // The volunteer's specimen rows say what happened rather than going blank.
    const sample = await (await app.request(`/samples/${ashSample}`)).text();
    expect(sample).toContain("run canceled; it will be numbered again in the next run");
    expect(sample).toContain("not numbered");
    expect(sample).not.toMatch(/<td><\/td>/);
    expect(await rows(conn, `SELECT count(*) FROM pending_print_sample`)).toEqual([[2n]]);
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
    expect(await missing.text()).toBe("No such print run.");

    // And a pending sample that is not fit to freeze stops Prepare, by name.
    const broken = await printApp();
    await broken.conn.run(`UPDATE sample_collector SET position = 2 WHERE sample_id = ${broken.ashSample}`);
    const stopped = await broken.post("/print-runs", { atlas_id: "" });
    expect(stopped.status).toBe(409);
    expect(await stopped.text()).toContain(`sample ${broken.ashSample} is waiting to print`);
    expect(await rows(broken.conn, `SELECT count(*) FROM print_run`)).toEqual([[0n]]);
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
