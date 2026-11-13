import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { ACTING_COOKIE, IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { en } from "../src/app/messages/en.js";
import { parseCsv } from "../src/corrections.js";
import { duckdbReader } from "../src/person-change.js";
import { readSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { readSampleOverlay, upsertSampleOverlay } from "../src/sample-overlay.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths } from "./helpers.js";
import { promotedStore } from "./promoted-store.js";

/**
 * What the pages do with the sample corrections' functions
 * (src/app/sample-corrections.ts, beeline-pnqr.8): who is recorded as the
 * author when somebody acts for somebody else, that impersonation refuses
 * before anything else, and that a refused request is answered without its
 * form being read.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const cookieFor = (name: string, cookie = ACTING_COOKIE) => `${cookie}=${encodeURIComponent(name)}`;

const form = (path: string, body: Record<string, string>, cookie?: string) => ({
  path,
  init: {
    method: "POST",
    headers: {
      origin: "http://localhost:3054",
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams(body).toString(),
  },
});

/** A body the form parser cannot read: multipart with no boundary. */
const truncated = (cookie?: string): RequestInit => ({
  method: "POST",
  headers: {
    origin: "http://localhost:3054",
    "content-type": "multipart/form-data",
    ...(cookie === undefined ? {} : { cookie }),
  },
  body: "not a multipart body",
});

async function person(conn: DuckDBConnection, name: string, login: string | null, userId: number): Promise<number> {
  const [[id]] = (await (await conn.run(`INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)).getRows()) as [[number]];
  if (login !== null) await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${userId}, '${login}')`);
  return Number(id);
}

/**
 * Gretchen is signed in, with login "pandg", and holds a grant to act for
 * Robert, who has no iNat login and owns the samples. `admin` makes Gretchen
 * staff too. Sandbox, since development makes everyone an admin.
 */
async function household({ admin = false }: { admin?: boolean } = {}) {
  const { instance, conn } = await createMemoryDb();
  const gretchen = await person(conn, "Gretchen Pederson", "pandg", 111);
  const robert = await person(conn, "Robert Pederson", null, 0);
  await conn.run(`INSERT INTO person_delegate (person_id, acts_for_id, granted_by) VALUES (${gretchen}, ${robert}, 'peter')`);
  if (admin) await conn.run(`INSERT INTO person_admin (person_id, granted_by) VALUES (${gretchen}, 'peter')`);
  const linked = await insertCleanSample(conn, { collector_id: String(robert), sample_number: "'R-1'", inat_observation_id: "998877" });
  await conn.run(
    `INSERT INTO sample_locality_candidate (sample_id, rank, locality, basis, latitude, longitude, gazetteer_build, rule_version, derived_at)
     SELECT sample_id, 1, 'Finley NWR', 'refuge', latitude, longitude, 'test', 1, current_timestamp
     FROM sample_location WHERE sample_id = ${linked}`,
  );
  const base = await scratchPaths();
  const app = createApp({
    ...base,
    db: createKysely(instance),
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: gretchen, login: "pandg", iconUrl: null }),
    conn,
  });
  // The change log's first pass only takes a baseline; production's was taken long ago.
  await recordSampleChanges(duckdbReader(conn), { log: base.sampleChangesPath, state: base.sampleStatePath }, { source: "observation_promotion" });
  const send = (path: string, init: RequestInit) => app.request(path, init);
  return { app, conn, send, linked, ...base };
}

describe("acting for somebody under a delegation", () => {
  it("records the signed-in person as the author of a place, on the acted-for person's sample", async () => {
    const h = await household();
    const { path, init } = form(`/samples/${h.linked}/place`, { locality: "Finley NWR" }, cookieFor("Robert Pederson"));
    expect((await h.send(path, init)).status).toBe(302);
    expect(await rows(h.conn, `SELECT locality FROM sample WHERE entity_id = ${h.linked}`)).toEqual([["Finley NWR"]]);
    expect((await readSampleOverlay(h.sampleOverlayPath)).map((r) => [r.field, r.value, r.author])).toEqual([["locality", "Finley NWR", "pandg"]]);
    const logged = (await readSampleChanges(h.sampleChangesPath)).filter((c) => c.source === "app");
    expect(logged.map((c) => [c.field, c.author])).toContainEqual(["locality", "pandg"]);
    // Without the switch Gretchen has no reach: the sample is not hers.
    const again = form(`/samples/${h.linked}/place`, { locality: "Somewhere" });
    expect((await h.send(again.path, again.init)).status).toBe(404);
  });

  it("records the signed-in person as the author of an edit, on the acted-for person's sample", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beeline-corrections-routes-"));
    const correctionsPath = join(dir, "corrections.csv");
    const { instance, conn } = await promotedStore("corrected", { appCorrections: correctionsPath });
    const [[bea]] = (await rows(conn, `SELECT entity_id FROM person WHERE display_name = 'Bea Trapper'`)) as [[number]];
    const [[sampleId]] = (await rows(conn, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00657'`)) as [[number]];
    const gretchen = await person(conn, "Gretchen Pederson", "pandg", 111);
    await conn.run(`INSERT INTO person_delegate (person_id, acts_for_id, granted_by) VALUES (${gretchen}, ${Number(bea)}, 'peter')`);
    const base = await scratchPaths();
    const app = createApp({
      ...base,
      db: createKysely(instance),
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId: gretchen, login: "pandg", iconUrl: null }),
      correctionsPath,
    });
    await recordSampleChanges(duckdbReader(conn), { log: base.sampleChangesPath, state: base.sampleStatePath }, { source: "observation_promotion" });

    const { path, init } = form(`/samples/${sampleId}/edit`, { locality: "Walla Walla", note: "in town" }, cookieFor("Bea Trapper"));
    expect((await app.request(path, init)).status).toBe(302);
    expect(await rows(conn, `SELECT locality FROM sample WHERE entity_id = ${sampleId}`)).toEqual([["Walla Walla"]]);
    const events = parseCsv(await readFile(correctionsPath, "utf8")).slice(1);
    expect(events.find((r) => r[0] === "bbbb2222" && r[1] === "locality")?.[4]).toBe("pandg");
    const logged = (await readSampleChanges(base.sampleChangesPath)).filter((c) => c.source === "app");
    expect(logged.map((c) => [c.field, c.author])).toContainEqual(["locality", "pandg"]);
  });
});

describe("impersonation through the pages", () => {
  const viewingAsRobert = cookieFor("Robert Pederson", IMPERSONATING_COOKIE);

  it("refuses a place, coordinates, a hold and a waiver with the impersonation message, first", async () => {
    const h = await household({ admin: true });
    const before = await rows(h.conn, `SELECT locality FROM sample WHERE entity_id = ${h.linked}`);
    for (const [route, body] of [
      ["place", { locality: "Finley NWR" }],
      ["suggested-locality", { locality: "Finley NWR" }],
      ["coordinates", { latitude: "44.5", longitude: "-123.2" }],
      ["take-observation-location", {}],
      ["hold", { note: "x" }],
      ["waiver", { rule: "locality_format", note: "x" }],
    ] as const) {
      const { path, init } = form(`/samples/${h.linked}/${route}`, body, viewingAsRobert);
      const res = await h.send(path, init);
      // Staff, yet "Admins only." is never the answer while impersonating.
      expect([route, res.status, await res.text()]).toEqual([route, 403, en.errors.readOnlyImpersonating]);
    }
    expect(await rows(h.conn, `SELECT locality FROM sample WHERE entity_id = ${h.linked}`)).toEqual(before);
    expect(await readSampleOverlay(h.sampleOverlayPath)).toEqual([]);
  });
});

describe("a refused request is answered without reading its form", () => {
  // The form is unreadable; the answer must be the refusal's own status, not a 500.
  it("answers the collector's edit, the place editor and the suggested locality", async () => {
    const h = await household();
    // A stranger's sample: not found.
    expect((await h.send(`/samples/${h.linked}/edit`, truncated())).status).toBe(404);
    expect((await h.send(`/samples/${h.linked}/place`, truncated())).status).toBe(404);
    expect((await h.send(`/samples/${h.linked}/suggested-locality`, truncated())).status).toBe(404);
    // No such sample.
    expect((await h.send(`/samples/999999/place`, truncated())).status).toBe(404);
  });

  it("answers the staff corrections", async () => {
    const h = await household();
    for (const route of ["coordinates", "take-observation-location", "hold", "waiver"]) {
      const res = await h.send(`/samples/${h.linked}/${route}`, truncated());
      expect([route, res.status]).toEqual([route, 403]);
    }
  });

  it("answers an impersonating staff member with the impersonation refusal", async () => {
    const h = await household({ admin: true });
    const viewing = cookieFor("Robert Pederson", IMPERSONATING_COOKIE);
    for (const route of ["edit", "place", "suggested-locality", "coordinates", "take-observation-location", "hold", "waiver"]) {
      const res = await h.send(`/samples/${h.linked}/${route}`, truncated(viewing));
      expect([route, res.status]).toEqual([route, 403]);
    }
  });

  it("answers a staff correction on a sample that does not exist", async () => {
    const h = await household({ admin: true });
    for (const route of ["coordinates", "hold", "waiver"]) {
      const res = await h.send(`/samples/999999/${route}`, truncated());
      expect([route, res.status]).toEqual([route, 404]);
    }
  });

  it("answers a locality somebody else set, and a trap sample the actor may not edit", async () => {
    const h = await household();
    await upsertSampleOverlay(h.sampleOverlayPath, [
      { sample_ref: "inat:998877", field: "locality", base_value: "", value: "Elsewhere", author: "lori", reason: "" },
    ]);
    const acting = cookieFor("Robert Pederson");
    expect((await h.send(`/samples/${h.linked}/suggested-locality`, truncated(acting))).status).toBe(403);
    // A sample entered in Beeline by somebody else is reachable by the place editor, but not editable.
    const [[robert]] = (await rows(h.conn, `SELECT entity_id FROM person WHERE display_name = 'Robert Pederson'`)) as [[number]];
    const entered = await insertCleanSample(h.conn, { collector_id: String(robert), sample_number: "'T-1'" });
    await h.conn.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES (${entered}, ${Number(robert)})`);
    expect((await h.send(`/samples/${entered}/place`, truncated())).status).toBe(404);
  });
});
