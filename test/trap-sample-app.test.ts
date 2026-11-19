import { describe, expect, it } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { createKysely } from "../src/db.js";
import { duckdbReader } from "../src/person-change.js";
import { readSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestGazetteer, createMemoryDb, CURRENT_SEASON, insertCleanSample, rows, scratchPaths, SETTLED_SEASON } from "./helpers.js";

/**
 * Entering and editing a trap sample through the app (beeline-3vs.2): who
 * reaches the form, a refused save keeping what was typed, and the sample
 * page offering the edit.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};
const ORIGIN = "http://localhost:3054";

async function trapApp(opts: { gazetteer?: boolean } = {}) {
  const { instance, conn } = await createMemoryDb();
  const person = async (name: string) =>
    ((await rows(conn, `INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`))[0]![0] as number);
  const people = {
    trapper: await person("Tess Trapper"),
    otherTrapper: await person("Otto Other"),
    netter: await person("Ned Netter"),
    staffer: await person("Sam Staff"),
  };
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${people.staffer})`);
  await insertCleanSample(conn, { kind: "'trap'", sample_number: "'OBAS-00657'", collector_id: String(people.trapper) });
  await insertCleanSample(conn, { kind: "'net'", collector_id: String(people.netter) });
  await insertCleanSample(conn, { kind: "'trap'", sample_number: "'OBAS-00600'", collector_id: String(people.otherTrapper) });
  const db = createKysely(instance);
  const paths = await scratchPaths();
  const gazetteerPath = join(await mkdtemp(join(tmpdir(), "trap-sample-gazetteer-")), "gazetteer.duckdb");
  if (opts.gazetteer === true) await buildTestGazetteer(gazetteerPath, "build-trap");
  const as = (who: keyof typeof people) => {
    const app = createApp({
      ...paths,
      db,
      config: { environment: "sandbox" as const, origin: ORIGIN },
      inat: unusedInat,
      resolveSession: async () => ({ personId: people[who], login: who, iconUrl: null }),
      conn,
      printConn: conn,
      derivePaths: opts.gazetteer === true ? { gazetteerPath } : undefined,
    });
    const post = (path: string, body: URLSearchParams) => app.request(path, { method: "POST", headers: { origin: ORIGIN }, body });
    return { app, post };
  };
  return { conn, as, paths };
}

const entry = (over: Record<string, string> = {}) => {
  const body = new URLSearchParams({
    sample_number: "OBAS-00658",
    date_start: `${CURRENT_SEASON}-06-16`,
    date_end: `${CURRENT_SEASON}-07-12`,
    method: "vane trap",
    trap_count: "6",
    specimen_count: "0",
    latitude: "42.005",
    longitude: "-118.592",
    uncertainty: "5",
    country: "USA",
    state_province: "OR",
    county: "Malheur",
    locality: "Fields-Denio N",
    ...over,
  });
  body.append("collector", "Tess Trapper");
  body.append("collector", "");
  body.append("collector", "");
  return body;
};

describe("entering a trap sample", () => {
  it("is offered to staff and to people who have collected trap samples, and nobody else", async () => {
    const { as } = await trapApp();
    for (const who of ["staffer", "trapper"] as const) {
      const listing = await (await as(who).app.request("/samples")).text();
      expect(listing, who).toContain(`href="/trap-samples/new"`);
      const form = await as(who).app.request("/trap-samples/new");
      expect(form.status, who).toBe(200);
      // The next number in Oregon's series is filled in.
      expect(await form.text(), who).toContain(`value="OBAS-00658"`);
    }
    const netter = as("netter");
    expect(await (await netter.app.request("/samples")).text()).not.toContain(`href="/trap-samples/new"`);
    expect((await netter.app.request("/trap-samples/new")).status).toBe(404);
    expect((await netter.post("/trap-samples/new", entry())).status).toBe(404);
  });

  it("writes the sample and goes to its page, which offers the edit", async () => {
    const { as, conn } = await trapApp();
    const trapper = as("trapper");
    const res = await trapper.post("/trap-samples/new", entry());
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/^\/samples\/\d+$/);
    const id = Number(location.split("/")[2]);
    expect(await rows(conn, `SELECT sample_number, kind, sampling_effort FROM sample WHERE entity_id = ${id}`)).toEqual([
      ["OBAS-00658", "trap", "6 vane traps"],
    ]);
    const page = await (await trapper.app.request(location)).text();
    expect(page).toContain(`href="/samples/${id}/trap"`);
    // Staff edit its locality on that form, not the correction form for old Beeline records.
    expect(await (await as("staffer").app.request(location)).text()).not.toContain(`action="/samples/${id}/locality"`);
    // Somebody who may not enter trap samples is not offered the edit.
    expect(await (await as("netter").app.request(location)).text()).not.toContain(`/samples/${id}/trap`);
  });

  const old = { date_start: `${SETTLED_SEASON}-06-16`, date_end: `${SETTLED_SEASON}-07-12`, specimen_count: "4", latitude: "44.50", longitude: "-123.60" };
  const idOf = (res: Response) => Number(res.headers.get("location")!.split("/")[2]);

  it("releases a settled season's sample when staff enter it, stamping its place from the point, and not when a trapper does", async () => {
    const { as, conn } = await trapApp({ gazetteer: true });
    const byStaff = idOf(await as("staffer").post("/trap-samples/new", entry({ ...old })));
    const byTrapper = idOf(await as("trapper").post("/trap-samples/new", entry({ ...old, sample_number: "OBAS-00659" })));
    expect(await rows(conn, `SELECT sample_id FROM sample_print_release`)).toEqual([[byStaff]]);
    expect(await rows(conn, `SELECT sample_id, pending_count FROM pending_print_sample WHERE sample_id IN (${byStaff}, ${byTrapper})`)).toEqual([[byStaff, 4]]);
    // The typed county was Malheur; the point is in Benton County.
    expect(await rows(conn, `SELECT county FROM sample WHERE entity_id IN (${byStaff}, ${byTrapper}) ORDER BY entity_id`)).toEqual([["Benton"], ["Malheur"]]);
  });

  it("leaves a settled sample staff entered held back, not released, while its place cannot be worked out", async () => {
    const { as, conn } = await trapApp();
    const id = idOf(await as("staffer").post("/trap-samples/new", entry({ ...old })));
    expect(await rows(conn, `SELECT count(*) FROM sample_print_release`)).toEqual([[0n]]);
    expect(await rows(conn, `SELECT county FROM sample WHERE entity_id = ${id}`)).toEqual([["Malheur"]]);
    // The sample page offers the release once the place can be worked out.
    expect(await (await as("staffer").app.request(`/samples/${id}`)).text()).toContain("Release labels for printing");
  });

  it("shows staff a note on the form that saving a settled season's sample releases its labels, and shows it to nobody else", async () => {
    const { as } = await trapApp();
    // A save with no latitude comes back to the form, with the note where it applies.
    const posted = async (who: "staffer" | "trapper", over: Record<string, string>) =>
      (await as(who).post("/trap-samples/new", entry({ ...over, latitude: "" }))).text();
    const note = "Saving this sample lets the next print run label its bees that have no label yet.";
    expect(await posted("staffer", old)).toContain(note);
    expect(await posted("staffer", { date_start: `${CURRENT_SEASON}-06-16` })).not.toContain(note);
    expect(await posted("trapper", old)).not.toContain(note);
  });

  it("releases a settled season's sample when staff change its count on the form, and not when they leave it", async () => {
    const { as, conn } = await trapApp({ gazetteer: true });
    const staff = as("staffer");
    // Entered by a trapper: held back until staff say otherwise.
    const id = idOf(await as("trapper").post("/trap-samples/new", entry({ ...old })));
    expect(await rows(conn, `SELECT count(*) FROM sample_print_release`)).toEqual([[0n]]);
    expect((await staff.post(`/samples/${id}/trap`, entry({ ...old }))).status).toBe(302);
    expect(await rows(conn, `SELECT count(*) FROM sample_print_release`)).toEqual([[0n]]);
    expect((await staff.post(`/samples/${id}/trap`, entry({ ...old, specimen_count: "9" }))).status).toBe(302);
    expect(await rows(conn, `SELECT sample_id FROM sample_print_release`)).toEqual([[id]]);
    expect(await rows(conn, `SELECT pending_count FROM pending_print_sample WHERE sample_id = ${id}`)).toEqual([[9]]);
    // A trapper editing their own sample's count releases nothing.
    const other = idOf(await as("trapper").post("/trap-samples/new", entry({ ...old, sample_number: "OBAS-00660" })));
    expect((await as("trapper").post(`/samples/${other}/trap`, entry({ ...old, sample_number: "OBAS-00660", specimen_count: "9" }))).status).toBe(302);
    expect(await rows(conn, `SELECT count(*) FROM sample_print_release WHERE sample_id = ${other}`)).toEqual([[0n]]);
  });

  it("refuses a save with what was wrong, keeping what was typed", async () => {
    const { as, conn } = await trapApp();
    const res = await as("staffer").post("/trap-samples/new", entry({ sample_number: "OBAS-00657", latitude: "" }));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Trap sample OBAS-00657 is already in Beeline.");
    expect(body).toContain("A latitude in decimal degrees is needed.");
    expect(body).toContain(`value="Fields-Denio N"`);
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM sample_entry`)).toEqual([[0]]);
  });

  it("edits an entered sample from the same form", async () => {
    const { as, conn } = await trapApp();
    const staff = as("staffer");
    const id = Number((await staff.post("/trap-samples/new", entry())).headers.get("location")!.split("/")[2]);
    const form = await (await staff.app.request(`/samples/${id}/trap`)).text();
    expect(form).toContain(`value="Tess Trapper"`);
    const saved = await staff.post(`/samples/${id}/trap`, entry({ specimen_count: "42" }));
    expect(saved.status).toBe(302);
    expect(await rows(conn, `SELECT specimen_count FROM sample WHERE entity_id = ${id}`)).toEqual([[42]]);
  });

  it("lets another trapper enter samples but not edit this one", async () => {
    const { as } = await trapApp();
    const id = Number((await as("trapper").post("/trap-samples/new", entry())).headers.get("location")!.split("/")[2]);
    const other = as("otherTrapper");
    expect((await other.app.request("/trap-samples/new")).status).toBe(200);
    expect(await (await other.app.request(`/samples/${id}`)).text()).not.toContain(`/samples/${id}/trap`);
    expect((await other.app.request(`/samples/${id}/trap`)).status).toBe(404);
    expect((await other.post(`/samples/${id}/trap`, entry({ specimen_count: "9" }))).status).toBe(404);
  });

  it("does not open an imported sample in the trap form", async () => {
    const { as, conn } = await trapApp();
    const [[imported]] = (await rows(conn, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00657'`)) as [[number]];
    expect((await as("staffer").app.request(`/samples/${imported}/trap`)).status).toBe(404);
  });

  // beeline-3vs.5: the listing's Edit link and Place pencil used to go to the
  // correction form for old Beeline records, which an entered sample cannot use.
  it("lets whoever entered a sample edit it, even once they no longer qualify to enter new ones", async () => {
    const { as, conn } = await trapApp();
    const id = Number((await as("trapper").post("/trap-samples/new", entry())).headers.get("location")!.split("/")[2]);
    // Tess is no longer on any trap sample, this one included; she entered it.
    await conn.run(`DELETE FROM sample_collector WHERE person_id = (SELECT entity_id FROM person WHERE display_name = 'Tess Trapper') AND sample_id <> ${id}`);
    const otto = new URLSearchParams(entry());
    otto.delete("collector");
    otto.append("collector", "Otto Other");
    expect((await as("staffer").post(`/samples/${id}/trap`, otto)).status).toBe(302);
    const tess = as("trapper");
    expect((await tess.app.request("/trap-samples/new")).status).toBe(404);
    expect((await tess.app.request(`/samples/${id}/trap`)).status).toBe(200);
  });

  it("keeps the form's link on an entered sample an observation was later linked to", async () => {
    const { as, conn } = await trapApp();
    const staff = as("staffer");
    const id = Number((await staff.post("/trap-samples/new", entry())).headers.get("location")!.split("/")[2]);
    await conn.run(`UPDATE sample SET inat_observation_id = 4242 WHERE entity_id = ${id}`);
    const listing = await (await staff.app.request("/samples?scope=all")).text();
    expect(listing).toContain("inaturalist.org/observations/4242");
    expect(listing).toContain(`href="/samples/${id}/trap"`);
  });

  it("enters the sample in its history under whoever entered it, and a renumbering under whoever renumbered it", async () => {
    // Until beeline-7r0g neither was recorded: the next nightly entered the
    // new sample under nobody's name, and a renumbered one as a second
    // sample arriving, cut off from what was recorded under its old number.
    const { as, conn, paths } = await trapApp();
    const trapper = as("trapper");
    // A store that was built, as production's was, so the history believes
    // the ids it keeps (the store's identity is its first migration's instant).
    await conn.run("INSERT INTO schema_migration (name) VALUES ('0001-a-store-that-was-built.sql')");
    // The pass the app makes when it starts, which a test's app does not.
    await recordSampleChanges(duckdbReader(conn), { log: paths.sampleChangesPath, state: paths.sampleStatePath }, { source: "reconcile" });
    const id = Number((await trapper.post("/trap-samples/new", entry())).headers.get("location")!.split("/")[2]);
    const made = await readSampleChanges(paths.sampleChangesPath);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((e) => e.author === "trapper" && e.old_value === "" && e.sample_number === "OBAS-00658")).toBe(true);

    const saved = await as("staffer").post(`/samples/${id}/trap`, entry({ sample_number: "OBAS-00659", trap_count: "8" }));
    expect(saved.status).toBe(302);
    const after = (await readSampleChanges(paths.sampleChangesPath)).slice(made.length);
    expect(after.map((e) => [e.sample_number, e.field, e.old_value, e.new_value, e.author])).toEqual([
      ["OBAS-00658", "sampling_effort", "6 vane traps", "8 vane traps", "staffer"],
      ["OBAS-00658", "sample_number", "OBAS-00658", "OBAS-00659", "staffer"],
    ]);
  });

  it("links an entered sample's row to its own form, and changes its place directly", async () => {
    const { as, conn } = await trapApp();
    const staff = as("staffer");
    const id = Number((await staff.post("/trap-samples/new", entry())).headers.get("location")!.split("/")[2]);
    const listing = await (await staff.app.request("/samples?scope=all")).text();
    expect(listing).toContain(`href="/samples/${id}/trap"`);
    expect(listing).not.toContain(`href="/samples/${id}/edit"`);
    expect(listing).toContain(`action="/samples/${id}/place"`);
    // A collector writes any name, as on the form.
    const moved = await as("trapper").post(`/samples/${id}/place`, new URLSearchParams({ locality: "Denio Junction", back: "/samples" }));
    expect(moved.status).toBe(302);
    expect(await rows(conn, `SELECT locality FROM sample WHERE entity_id = ${id}`)).toEqual([["Denio Junction"]]);
    // Blank clears it.
    await as("trapper").post(`/samples/${id}/place`, new URLSearchParams({ locality: "", back: "/samples" }));
    expect(await rows(conn, `SELECT locality FROM sample WHERE entity_id = ${id}`)).toEqual([[null]]);
    await as("trapper").post(`/samples/${id}/place`, new URLSearchParams({ locality: "Denio Junction", back: "/samples" }));
    // Somebody who is neither staff, its collector nor its enterer cannot.
    const refused = await as("otherTrapper").post(`/samples/${id}/place`, new URLSearchParams({ locality: "Elsewhere", back: "/samples" }));
    expect(refused.status).toBe(404);
    expect(await rows(conn, `SELECT locality FROM sample WHERE entity_id = ${id}`)).toEqual([["Denio Junction"]]);
  });
});
