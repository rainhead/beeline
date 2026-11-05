import { describe, expect, it } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { createKysely } from "../src/db.js";
import { createMemoryDb, CURRENT_SEASON, insertCleanSample, rows, scratchPaths } from "./helpers.js";

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

async function trapApp() {
  const { instance, conn } = await createMemoryDb();
  const person = async (name: string) =>
    ((await rows(conn, `INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`))[0]![0] as number);
  const people = {
    trapper: await person("Tess Trapper"),
    netter: await person("Ned Netter"),
    staffer: await person("Sam Staff"),
  };
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${people.staffer})`);
  await insertCleanSample(conn, { kind: "'trap'", sample_number: "'OBAS-00657'", collector_id: String(people.trapper) });
  await insertCleanSample(conn, { kind: "'net'", collector_id: String(people.netter) });
  const db = createKysely(instance);
  const paths = await scratchPaths();
  const as = (who: keyof typeof people) => {
    const app = createApp({
      ...paths,
      db,
      config: { environment: "sandbox" as const, origin: ORIGIN },
      inat: unusedInat,
      resolveSession: async () => ({ personId: people[who], login: who, iconUrl: null }),
      conn,
      printConn: conn,
    });
    const post = (path: string, body: URLSearchParams) => app.request(path, { method: "POST", headers: { origin: ORIGIN }, body });
    return { app, post };
  };
  return { conn, as };
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

  it("refuses a save with what was wrong, keeping what was typed", async () => {
    const { as, conn } = await trapApp();
    const res = await as("staffer").post("/trap-samples/new", entry({ sample_number: "OBAS-00657", latitude: "" }));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Sample OBAS-00657 is already in Beeline.");
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

  it("does not open an imported sample in the trap form", async () => {
    const { as, conn } = await trapApp();
    const [[imported]] = (await rows(conn, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00657'`)) as [[number]];
    expect((await as("staffer").app.request(`/samples/${imported}/trap`)).status).toBe(404);
  });
});
