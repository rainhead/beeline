import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { readSampleOverlay } from "../src/sample-overlay.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths } from "./helpers.js";

/**
 * Changing a sample's locality from its Place cell on /samples
 * (beeline-7ywr, Peter 2026-11-04): a pencil that opens a choice of
 * iNaturalist's locality and the names suggested from the coordinates, and
 * for staff a box to write one in, making the sample page's own writes with
 * its permissions.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

async function person(conn: DuckDBConnection, name: string, login: string, userId: number): Promise<number> {
  const [[id]] = (await (
    await conn.run(`INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)
  ).getRows()) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${userId}, '${login}')`);
  return Number(id);
}

type Who = "alice" | "bob" | "sam";
const LOGINS: Record<Who, string> = { alice: "alice", bob: "bob", sam: "samstaff" };
const t = en.listings.samples.placeEdit;

/**
 * Alice's iNat-linked sample, its locality a street address too long for a
 * label, with two names offered for its point; and a printed one of hers.
 */
async function setup() {
  const { instance, conn } = await createMemoryDb();
  const ids = {
    alice: await person(conn, "Alice Adams", "alice", 1),
    bob: await person(conn, "Bob Barnes", "bob", 2),
    sam: await person(conn, "Sam Staff", "samstaff", 3),
  };
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${ids.sam})`);
  const open = await insertCleanSample(conn, {
    collector_id: String(ids.alice),
    sample_number: "'A-1'",
    inat_observation_id: "901",
    locality: "'26208 Finley Refuge Rd'",
  });
  const printed = await insertCleanSample(conn, {
    collector_id: String(ids.alice),
    sample_number: "'A-2'",
    inat_observation_id: "902",
    locality: "'26208 Finley Refuge Rd'",
  });
  await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${printed}, 1)`);
  for (const id of [open, printed]) {
    await conn.run(
      `INSERT INTO sample_locality_candidate (sample_id, rank, locality, basis, latitude, longitude, gazetteer_build, rule_version, derived_at)
       SELECT sample_id, r, name, basis, latitude, longitude, 'test', 1, current_timestamp
       FROM sample_location, (VALUES (1, 'Finley NWR', 'refuge'), (2, 'Muddy Creek CG', 'campground')) v(r, name, basis)
       WHERE sample_id = ${id}`,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "beeline-place-edit-"));
  const paths = {
    sampleOverlayPath: join(dir, "sample-overlay.csv"),
    correctionsPath: join(dir, "corrections.csv"),
    sampleChangesPath: join(dir, "sample-change.csv"),
    sampleStatePath: join(dir, "sample-state.csv"),
  };
  const base = await scratchPaths();
  const appFor = (who: Who) =>
    createApp({
      ...base,
      db: createKysely(instance),
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId: ids[who], login: LOGINS[who], iconUrl: null }),
      conn,
      ...paths,
    });
  return { appFor, conn, open, printed, ...paths };
}

type App = ReturnType<Awaited<ReturnType<typeof setup>>["appFor"]>;
const place = (app: App, id: number, body: Record<string, string>) =>
  app.request(`/samples/${id}/place`, { method: "POST", body: new URLSearchParams({ back: "/samples?scope=all&qc=locality", ...body }) });
const localityOf = async (conn: DuckDBConnection, id: number) =>
  ((await rows(conn, `SELECT locality FROM sample WHERE entity_id = ${id}`)) as (string | null)[][])[0]![0];
const pencil = (id: number) => `action="/samples/${id}/place"`;

describe("the Place cell's editor", () => {
  it("is offered to staff on a sample that has not printed: one combobox of every name, free to write one in", async () => {
    const { appFor, open, printed } = await setup();
    const page = await (await appFor("sam").request("/samples?scope=all")).text();
    expect(page).toContain(pencil(open));
    expect(page).not.toContain(pencil(printed));
    expect(page).toContain(`aria-label="${t.open("A-1")}"`);
    expect(page).toContain(`<beeline-combobox free="">`);
    expect(page).toContain(`id="place-${open}" name="locality" type="text" value="26208 Finley Refuge Rd" list="place-${open}-choices"`);
    expect(page).toContain(`<option value="Finley NWR" label="${t.noteSuggested}">`);
    expect(page).toContain(`<option value="Muddy Creek CG" label="${t.noteAlternative}">`);
    expect(page).toContain(`<option value="26208 Finley Refuge Rd" label="${t.noteCurrent}">`);
    expect(page).toContain(t.hintStaff);
  });

  it("is offered to the collector on their own sample, choices only, and to nobody else", async () => {
    const { appFor, open } = await setup();
    const own = await (await appFor("alice").request("/samples?scope=mine")).text();
    expect(own).toContain(pencil(open));
    expect(own).toContain("<beeline-combobox>");
    expect(own).not.toContain(t.hintStaff);
    const other = await (await appFor("bob").request("/samples?scope=all")).text();
    expect(other).not.toContain(pencil(open));
  });

  it("adopts a name offered for the point, credited to whoever chose it, and goes back to the listing", async () => {
    const { appFor, conn, open, sampleOverlayPath } = await setup();
    const res = await place(appFor("sam"), open, { locality: "Muddy Creek CG" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/samples?scope=all&qc=locality");
    expect(await localityOf(conn, open)).toBe("Muddy Creek CG");
    const [row] = await readSampleOverlay(sampleOverlayPath);
    expect(row).toMatchObject({ sample_ref: "inat:901", value: "Muddy Creek CG", author: "samstaff" });
    expect(row!.reason).toBe(en.suggestedLocality.reason(en.suggestedLocality.basis.campground));
  });

  it("writes in any other name for staff, and refuses one from a collector", async () => {
    const { appFor, conn, open } = await setup();
    const refused = await place(appFor("alice"), open, { locality: "Muddy Creek" });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe(t.onlyOffered);
    expect(await localityOf(conn, open)).toBe("26208 Finley Refuge Rd");
    await place(appFor("sam"), open, { locality: "  Muddy Creek " });
    expect(await localityOf(conn, open)).toBe("Muddy Creek");
  });

  it("keeps the sample's own locality as it is", async () => {
    const { appFor, open, sampleOverlayPath } = await setup();
    const res = await place(appFor("sam"), open, { locality: "26208 Finley Refuge Rd" });
    expect(res.status).toBe(302);
    expect(await readSampleOverlay(sampleOverlayPath)).toEqual([]);
  });

  it("lets a collector adopt a suggestion and empty the box to follow iNaturalist again, but not over staff's locality", async () => {
    const { appFor, conn, open, sampleOverlayPath } = await setup();
    const alice = appFor("alice");
    await place(alice, open, { locality: "Finley NWR" });
    expect(await localityOf(conn, open)).toBe("Finley NWR");
    // Her row is emptied, which is how the overlay says nobody's locality stands.
    await place(alice, open, { locality: "" });
    expect((await readSampleOverlay(sampleOverlayPath)).map((r) => [r.author, r.value])).toEqual([["alice", ""]]);
    await place(appFor("sam"), open, { locality: "Muddy Creek CG" });
    expect((await place(alice, open, { locality: "" })).status).toBe(403);
    expect((await place(alice, open, { locality: "Finley NWR" })).status).toBe(403);
    expect(await localityOf(conn, open)).toBe("Muddy Creek CG");
    // And the pencil is gone from her listing while staff's locality stands.
    expect(await (await alice.request("/samples?scope=mine")).text()).not.toContain(pencil(open));
  });

  it("refuses a printed sample, and sends a back link elsewhere to the listing", async () => {
    const { appFor, open, printed } = await setup();
    const sam = appFor("sam");
    expect((await place(sam, printed, { locality: "Finley NWR" })).status).toBe(409);
    const res = await sam.request(`/samples/${open}/place`, {
      method: "POST",
      body: new URLSearchParams({ back: "https://example.com/samples", locality: "Finley NWR" }),
    });
    expect(res.headers.get("location")).toBe("/samples");
  });

  it("finds the samples whose locality is missing or will not fit a label", async () => {
    const { appFor, open } = await setup();
    const page = await (await appFor("sam").request("/samples?scope=all&qc=locality")).text();
    expect(page).toContain(`/samples/${open}"`);
    const clean = await (await appFor("sam").request("/samples?scope=all&qc=clean")).text();
    expect(clean).not.toContain(`/samples/${open}"`);
  });
});
