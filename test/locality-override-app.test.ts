import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { parseCsv } from "../src/corrections.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { readSampleOverlay } from "../src/sample-overlay.js";
import { createMemoryDb, FIXTURE_INPUTS, insertCleanSample, rows } from "./helpers.js";

/**
 * The staff locality form on /samples/:id (beeline-649): the one write a
 * volunteer cannot make on an iNat-linked sample. Reach is the record
 * page's; the write is admin-gated; the file is what survives.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;

async function person(conn: DuckDBConnection, name: string, login: string, userId: number): Promise<number> {
  const [[id]] = (await (
    await conn.run(`INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)
  ).getRows()) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${userId}, '${login}')`);
  return Number(id);
}

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "beeline-locality-"));
  return {
    sampleOverlayPath: join(dir, "sample-overlay.csv"),
    correctionsPath: join(dir, "corrections.csv"),
    sampleChangesPath: join(dir, "sample-change.csv"),
    sampleStatePath: join(dir, "sample-state.csv"),
  };
}

/** Alice's iNat-linked sample, and Sam who is staff; signed in as one of them. */
async function inatApp(signedInAs: "alice" | "sam") {
  const { instance, conn } = await createMemoryDb();
  const alice = await person(conn, "Alice Adams", "alice", 1);
  const sam = await person(conn, "Sam Staff", "samstaff", 2);
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${sam})`);
  const sampleId = await insertCleanSample(conn, {
    collector_id: String(alice),
    sample_number: "'A-1'",
    inat_observation_id: "998877",
    locality: "'Corvallis'",
  });
  const paths = await scratch();
  const db = createKysely(instance);
  const people = { alice, sam };
  const app = createApp({
    db,
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({
      personId: people[signedInAs],
      login: signedInAs === "sam" ? "samstaff" : "alice",
      iconUrl: null,
    }),
    conn,
    ...paths,
  });
  return { app, conn, sampleId, ...paths };
}

const post = (app: { request: (p: string, init?: RequestInit) => Promise<Response> | Response }, path: string, body: Record<string, string>) =>
  app.request(path, { method: "POST", body: new URLSearchParams(body) });

const one = async (conn: DuckDBConnection, sql: string) => (await rows(conn, sql))[0];

describe("the staff locality form", () => {
  it("is on the sample page for staff and not for the collector", async () => {
    const staff = await inatApp("sam");
    const page = await (await staff.app.request(`/samples/${staff.sampleId}`)).text();
    expect(page).toContain("Set the locality");
    expect(page).toContain(`/samples/${staff.sampleId}/locality`);

    const collector = await inatApp("alice");
    const own = await (await collector.app.request(`/samples/${collector.sampleId}`)).text();
    expect(own).not.toContain("Set the locality");
  });

  it("sets the locality, writes the file, credits the staffer, and shows the provenance", async () => {
    const { app, conn, sampleId, sampleOverlayPath, sampleChangesPath } = await inatApp("sam");
    const res = await post(app, `/samples/${sampleId}/locality`, {
      locality: "Bald Hill",
      note: "the trailhead, not the town",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/samples/${sampleId}`);

    expect(await one(conn, `SELECT locality FROM sample WHERE entity_id = ${sampleId}`)).toEqual(["Bald Hill"]);
    const file = await readSampleOverlay(sampleOverlayPath);
    expect(file).toEqual([
      {
        sample_ref: "inat:998877",
        field: "locality",
        base_value: "",
        value: "Bald Hill",
        author: "samstaff",
        reason: "the trailhead, not the town",
      },
    ]);

    const page = await (await app.request(`/samples/${sampleId}`)).text();
    expect(page).toContain("Locality set here by Sam Staff.");
    expect(page).toContain("Reason: the trailhead, not the town");
    expect(page).toContain("Remove, and follow iNaturalist again");

    // The history credits whoever typed it (ADR 0007). A first pass over a
    // store with no snapshot baselines rather than records, so the edit
    // lands in the log only from the second write on: make one and check.
    await post(app, `/samples/${sampleId}/locality`, { locality: "Fitton Green", note: "" });
    const log = parseCsv(await readFile(sampleChangesPath, "utf8"));
    const entry = log.find((r) => r.includes("locality") && r.includes("Fitton Green"));
    expect(entry, log.map((r) => r.join(",")).join("\n")).toBeDefined();
    expect(entry).toContain("samstaff");
  });

  it("removes the override on request", async () => {
    const { app, conn, sampleId, sampleOverlayPath } = await inatApp("sam");
    await post(app, `/samples/${sampleId}/locality`, { locality: "Bald Hill", note: "" });
    const res = await post(app, `/samples/${sampleId}/locality`, { remove: "1" });
    expect(res.status).toBe(302);
    expect(await one(conn, `SELECT count(*) FROM sample_locality_override`)).toEqual([0n]);
    // No observation is staged here, so there is nothing to follow back to
    // and the sample keeps its last value — as under the follow rule, whose
    // inner join on observation_field is what an absent observation means;
    // the first version nulled it. The file records the removal.
    expect(await one(conn, `SELECT locality FROM sample WHERE entity_id = ${sampleId}`)).toEqual(["Bald Hill"]);
    expect((await readSampleOverlay(sampleOverlayPath))[0]).toMatchObject({ value: "" });
    const page = await (await app.request(`/samples/${sampleId}`)).text();
    expect(page).not.toContain("Locality set here");
  });

  it("refuses to write a decision two samples would claim", async () => {
    const { app, conn, sampleId, sampleOverlayPath } = await inatApp("sam");
    await insertCleanSample(conn, { sample_number: "'A-2'", inat_observation_id: "998877" });
    const res = await post(app, `/samples/${sampleId}/locality`, { locality: "Bald Hill" });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe("2 samples carry observation 998877");
    // Nothing durable: a row here would be refused by every pass and
    // reported by every nightly.
    expect(await readSampleOverlay(sampleOverlayPath)).toEqual([]);
    expect(await one(conn, `SELECT locality FROM sample WHERE entity_id = ${sampleId}`)).toEqual(["Corvallis"]);
  });

  it("refuses a blank locality, and refuses the collector", async () => {
    const staff = await inatApp("sam");
    expect((await post(staff.app, `/samples/${staff.sampleId}/locality`, { locality: "   " })).status).toBe(400);
    expect(await one(staff.conn, `SELECT locality FROM sample WHERE entity_id = ${staff.sampleId}`)).toEqual([
      "Corvallis",
    ]);

    const collector = await inatApp("alice");
    const res = await post(collector.app, `/samples/${collector.sampleId}/locality`, { locality: "Bald Hill" });
    expect(res.status).toBe(403);
    expect(await one(collector.conn, `SELECT locality FROM sample WHERE entity_id = ${collector.sampleId}`)).toEqual([
      "Corvallis",
    ]);
  });

  it("goes through the corrections overlay for a sample with no observation", async () => {
    const { instance, conn } = await createMemoryDb();
    await loadLegacyStaging(conn, FIXTURE);
    const paths = await scratch();
    await promoteLegacy(conn, { ...FIXTURE_INPUTS, appCorrections: paths.correctionsPath });
    const sam = await person(conn, "Sam Staff", "samstaff", 2);
    await conn.run(`INSERT INTO person_admin (person_id) VALUES (${sam})`);
    const [[sampleId]] = (await rows(conn, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00657'`)) as [
      [number],
    ];
    const app = createApp({
      db: createKysely(instance),
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId: sam, login: "samstaff", iconUrl: null }),
      conn,
      ...paths,
    });
    const page = await (await app.request(`/samples/${sampleId}`)).text();
    expect(page).toContain("This sample has no observation, so the locality is kept as a correction");

    const res = await post(app, `/samples/${sampleId}/locality`, { locality: "Marys Peak", note: "staff fix" });
    expect(res.status).toBe(302);
    expect(await one(conn, `SELECT locality FROM sample WHERE entity_id = ${Number(sampleId)}`)).toEqual(["Marys Peak"]);
    const corrections = parseCsv(await readFile(paths.correctionsPath, "utf8")).slice(1);
    expect(corrections.length).toBeGreaterThan(0);
    for (const row of corrections) expect(row.slice(1)).toMatchObject(["locality", expect.any(String), "Marys Peak", "samstaff", "staff fix"]);
    // Nothing in the sample overlay: it can only name a sample by observation.
    expect(await readSampleOverlay(paths.sampleOverlayPath)).toEqual([]);
  });
});

describe("the staff coordinates form", () => {
  it("is offered to staff on a sample with an observation, sets, shows provenance, and removes", async () => {
    const { app, conn, sampleId, sampleOverlayPath } = await inatApp("sam");
    const page = await (await app.request(`/samples/${sampleId}`)).text();
    expect(page).toContain("Set the coordinates");

    const res = await post(app, `/samples/${sampleId}/coordinates`, {
      latitude: "44.6",
      longitude: "-123.3",
      uncertainty: "15",
      note: "GPS from the field notebook",
    });
    expect(res.status).toBe(302);
    expect(await one(conn, `SELECT latitude, longitude, coordinate_uncertainty_m, source FROM sample_location WHERE sample_id = ${sampleId}`))
      .toEqual([44.6, -123.3, 15, "staff_entry"]);
    const file = await readSampleOverlay(sampleOverlayPath);
    expect(file[0]).toMatchObject({ field: "coordinates", value: "44.6 -123.3 15", author: "samstaff" });
    // The fixture's clean sample has a location row, so the base names it.
    expect(file[0]!.base_value).toMatch(/^[-\d.]+ [-\d.]+ (\d+|-) inat_public$/);

    const after = await (await app.request(`/samples/${sampleId}`)).text();
    expect(after).toContain("Coordinates set here by Sam Staff.");
    expect(after).toContain("Reason: GPS from the field notebook");
    expect(after).toContain("Entered by staff.");

    expect((await post(app, `/samples/${sampleId}/coordinates`, { remove: "1" })).status).toBe(302);
    expect(await one(conn, `SELECT count(*) FROM sample_location_override`)).toEqual([0n]);
    expect(await one(conn, `SELECT source FROM sample_location WHERE sample_id = ${sampleId}`)).toEqual(["inat_public"]);
  });

  it("refuses a bad point, the collector, and a sample with no observation", async () => {
    const staff = await inatApp("sam");
    const bad = await post(staff.app, `/samples/${staff.sampleId}/coordinates`, { latitude: "95", longitude: "-123.3" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("not a latitude");
    const half = await post(staff.app, `/samples/${staff.sampleId}/coordinates`, { latitude: "44.6", longitude: "" });
    expect(half.status).toBe(400);

    const collector = await inatApp("alice");
    expect((await post(collector.app, `/samples/${collector.sampleId}/coordinates`, { latitude: "44.6", longitude: "-123.3" })).status).toBe(403);

    // No observation: not offered, and refused with the reason.
    await staff.conn.run(`UPDATE sample SET inat_observation_id = NULL WHERE entity_id = ${staff.sampleId}`);
    const page = await (await staff.app.request(`/samples/${staff.sampleId}`)).text();
    expect(page).not.toContain("Set the coordinates");
    const res = await post(staff.app, `/samples/${staff.sampleId}/coordinates`, { latitude: "44.6", longitude: "-123.3" });
    expect(res.status).toBe(409);
  });
});
