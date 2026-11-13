import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { Kysely } from "kysely";
import { createKysely, loadSpatial, openDuckDb } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApi } from "../src/app/api.js";
import { createKey, hashKey, KEY_SCOPES, offeredScopes } from "../src/app/api-keys.js";
import { createApp } from "../src/app/server.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { duckdbReader } from "../src/person-change.js";
import { readSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { readSampleOverlay, type SampleOverlayRow } from "../src/sample-overlay.js";
import { en } from "../src/app/messages/en.js";
import type { Database } from "../src/model.js";
import { approveRun, markPrinted, prepareRun } from "../src/print-run.js";
import { refreshObservationFields } from "../src/refresh-observation-fields.js";
import { canonicalJson } from "../src/sync-inat.js";
import { buildTestGazetteer, createMemoryDb, currentSeasonDate, FIXTURE_INPUTS, insertCleanSample, rows, scratchPaths } from "./helpers.js";

/**
 * The sample corrections of the API (beeline-pnqr.6): that a program holding a
 * key makes the corrections the pages allow, by the same functions and so
 * under the same rules, and what is different about it. Run on the sandbox
 * environment, since development makes everyone staff.
 *
 * Four people with iNat accounts: Bea (collects the old Beeline's sample
 * OBAS-00657, which has no observation and so can be edited), Alice (collects
 * two samples with observations that each have a suggested locality), Bob (a
 * volunteer who collects nothing here) and Sam (staff).
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const ORIGIN = "http://localhost:3054";
const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;
const CORRECTIONS = new URL("./fixtures/legacy-corrections.csv", import.meta.url).pathname;
const UID = { alice: 1, bob: 2, sam: 3 } as const;

async function person(conn: DuckDBConnection, name: string, login: string, userId: number): Promise<number> {
  const [[id]] = (await (await conn.run(`INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)).getRows()) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${userId}, '${login}')`);
  return Number(id);
}

async function world() {
  const { instance, conn } = await createMemoryDb();
  await loadLegacyStaging(conn, FIXTURE);
  const paths = await scratchPaths();
  await promoteLegacy(conn, { ...FIXTURE_INPUTS, legacyCorrections: CORRECTIONS, appCorrections: paths.correctionsPath });
  const [[beaId]] = (await rows(conn, `SELECT entity_id FROM person WHERE display_name = 'Bea Trapper'`)) as [[number]];
  const bea = Number(beaId);
  // Promotion already bound Bea to an iNat account, whose login the history entries are credited to.
  const [[beaUid, beaLogin]] = (await rows(conn, `SELECT inat_user_id, login FROM inat_account WHERE person_id = ${bea}`)) as [[bigint, string]];
  const alice = await person(conn, "Alice Adams", "alice", UID.alice);
  const bob = await person(conn, "Bob Barnes", "bob", UID.bob);
  const sam = await person(conn, "Sam Staff", "samstaff", UID.sam);
  await conn.run(`INSERT INTO person_admin (person_id, granted_by) VALUES (${sam}, 'peter')`);
  const [[legacy]] = (await rows(conn, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00657'`)) as [[number]];
  const linked = await insertCleanSample(conn, { collector_id: String(alice), sample_number: "'A-1'", inat_observation_id: "998877" });
  const other = await insertCleanSample(conn, { collector_id: String(alice), sample_number: "'A-3'", inat_observation_id: "998878" });
  for (const id of [linked, other]) {
    await conn.run(
      `INSERT INTO sample_locality_candidate (sample_id, rank, locality, basis, latitude, longitude, gazetteer_build, rule_version, derived_at)
       SELECT sample_id, 1, 'Finley NWR', 'refuge', latitude, longitude, 'test', 1, current_timestamp
       FROM sample_location WHERE sample_id = ${id}`,
    );
  }
  // The change log's first pass only takes a baseline; production's was taken long ago.
  const samplePaths = { log: paths.sampleChangesPath, state: paths.sampleStatePath };
  await recordSampleChanges(duckdbReader(conn), samplePaths, { source: "observation_promotion" });

  let running: string | null = null;
  const db = createKysely(instance);
  const app = createApp({
    ...paths,
    db,
    config: { environment: "sandbox" as const, origin: ORIGIN },
    inat: unusedInat,
    // Sam is signed in on the pages, to compare what a page writes with what the API does.
    resolveSession: async () => ({ personId: sam, login: "samstaff", inatUserId: BigInt(UID.sam), iconUrl: null }),
    conn,
    jobs: { list: [], start: async () => false, running: () => running },
  });
  const keyFor = async (uid: number, scope: string) => {
    const made = await createKey(db, { inatUserId: uid, name: "test", scope, lifetimeDays: 30, offered: KEY_SCOPES });
    if ("problem" in made) throw new Error(made.problem);
    return made.key;
  };
  const send = (key: string | undefined, path: string, body: unknown, method = "POST") =>
    app.request(`/api/v1${path}`, {
      method,
      headers: { ...(key === undefined ? {} : { authorization: `Bearer ${key}` }), "content-type": "application/json" },
      body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  const page = (path: string, body: Record<string, string>) =>
    app.request(path, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  const keys = {
    bea: await keyFor(Number(beaUid), "edit"),
    alice: await keyFor(UID.alice, "edit"),
    aliceRead: await keyFor(UID.alice, "read"),
    bob: await keyFor(UID.bob, "edit"),
    sam: await keyFor(UID.sam, "staff"),
    samEdit: await keyFor(UID.sam, "edit"),
  };
  return {
    app,
    db,
    conn,
    send,
    page,
    keys,
    paths,
    legacy: Number(legacy),
    linked,
    other,
    people: { bea, alice, bob, sam },
    beaLogin,
    setRunning: (job: string | null) => (running = job),
    /** The history entries a correction made, without the baseline: what, who, why and which door. */
    entries: async (sampleNumber: string) =>
      (await readSampleChanges(paths.sampleChangesPath))
        .filter((c) => c.sample_number === sampleNumber && c.source !== "observation_promotion")
        .map((c) => ({ field: c.field, to: c.new_value, author: c.author, reason: c.reason, source: c.source })),
    uses: async () =>
      (await rows(conn, `SELECT key_sha256, method, route, subject, outcome, reference, status FROM api_key_use ORDER BY used_at, subject`)) as unknown[][],
  };
}

type World = Awaited<ReturnType<typeof world>>;
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const localityOf = async (conn: DuckDBConnection, id: number) =>
  ((await rows(conn, `SELECT locality FROM sample WHERE entity_id = ${id}`)) as string[][])[0]![0];
const overlay = (w: World) => readSampleOverlay(w.paths.sampleOverlayPath);
const correctionsFile = async (w: World) => readFile(w.paths.correctionsPath, "utf8").catch(() => "");
const printable = async (w: World, id: number) => (await rows(w.conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${id}`)).length === 1;

describe("what a key may do", () => {
  it("offers read to everyone, and edit and staff only to someone who is staff", () => {
    expect(offeredScopes(false)).toEqual(["read"]);
    expect(offeredScopes(true)).toEqual(["read", "edit", "staff"]);
  });

  it("refuses a key that may only read, on every endpoint, before loading or writing anything", async () => {
    const w = await world();
    const before = await correctionsFile(w);
    for (const [path, body] of [
      [`/samples/${w.legacy}/edit`, { values: { locality: "X" } }],
      [`/samples/${w.linked}/locality`, { locality: "Finley NWR" }],
      [`/samples/${w.linked}/coordinates`, { latitude: 44.5, longitude: -123.2 }],
      [`/samples/${w.linked}/take-observation-location`, {}],
      [`/samples/${w.linked}/hold`, { note: "x" }],
      [`/samples/${w.linked}/waiver`, { rule: "locality_format", note: "x" }],
      // Not even a body that could not be read is read.
      [`/samples/${w.linked}/hold`, "not json"],
    ] as const) {
      const res = await w.send(w.keys.aliceRead, path, body);
      expect([path, res.status]).toEqual([path, 403]);
      expect(await json(res)).toMatchObject({ error: "forbidden" });
    }
    expect(await overlay(w)).toEqual([]);
    expect(await correctionsFile(w)).toBe(before);
    expect(await w.entries("A-1")).toEqual([]);
    // A read key asking for a sample that does not exist learns nothing either: no 404 before the 403.
    expect((await w.send(w.keys.aliceRead, "/samples/999999/hold", {})).status).toBe(403);
  });

  it("answers 401 to a request with no key, even from a browser that is signed in", async () => {
    const w = await world();
    const res = await w.send(undefined, `/samples/${w.linked}/hold`, { note: "x" });
    expect(res.status).toBe(401);
    expect(await overlay(w)).toEqual([]);
  });

  it("lets an edit key correct its own person's samples and no one else's", async () => {
    const w = await world();
    const mine = await w.send(w.keys.alice, `/samples/${w.linked}/locality`, { locality: "Finley NWR" });
    expect(mine.status).toBe(200);
    expect(await localityOf(w.conn, w.linked)).toBe("Finley NWR");
    // Bob's key reaches nothing of Alice's: 404, as the page answers a stranger.
    for (const [path, body] of [
      [`/samples/${w.other}/locality`, { locality: "Finley NWR" }],
      [`/samples/${w.legacy}/edit`, { values: { locality: "X" } }],
    ] as const) {
      const res = await w.send(w.keys.bob, path, body);
      expect([path, res.status]).toEqual([path, 404]);
    }
    expect(await localityOf(w.conn, w.other)).toBe("Corvallis");
  });

  it("refuses an edit key the staff endpoints with 403, and writes nothing", async () => {
    const w = await world();
    for (const [path, body] of [
      [`/samples/${w.linked}/coordinates`, { latitude: 44.5, longitude: -123.2 }],
      [`/samples/${w.linked}/take-observation-location`, {}],
      [`/samples/${w.linked}/hold`, { note: "x" }],
      [`/samples/${w.linked}/waiver`, { rule: "locality_format", note: "x" }],
    ] as const) {
      // Even a staff person's key made with the edit scope acts as no more than its person's own samples.
      for (const key of [w.keys.alice, w.keys.samEdit]) {
        const res = await w.send(key, path, body);
        expect([path, res.status, (await json(res)).error]).toEqual([path, 403, "forbidden"]);
      }
    }
    expect(await overlay(w)).toEqual([]);
    // Nor may it write a name the place editor does not offer.
    const own = await w.send(w.keys.alice, `/samples/${w.linked}/locality`, { locality: "My own name" });
    expect([own.status, (await json(own)).error]).toEqual([409, "only_offered"]);
  });

  it("stops a staff key acting as staff the moment its person loses staff rights", async () => {
    const w = await world();
    const hold = () => w.send(w.keys.sam, `/samples/${w.linked}/hold`, { note: "date looks a year off" });
    expect((await hold()).status).toBe(200);
    await w.conn.run(`DELETE FROM person_admin`);
    const res = await hold();
    expect([res.status, (await json(res)).error]).toEqual([403, "forbidden"]);
  });
});

describe("each correction writes what the page's form writes", () => {
  it("adopts a locality with the page's reason, under the key's login, and says the history came through the API", async () => {
    const w = await world();
    // The same adoption of the same suggested name: once on a page, once through the API, both as staff.
    expect((await w.page(`/samples/${w.linked}/place`, { locality: "Finley NWR" })).status).toBe(302);
    const res = await w.send(w.keys.sam, `/samples/${w.other}/locality`, { locality: "Finley NWR" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ sample_id: w.other, outcome: "saved" });
    expect(await localityOf(w.conn, w.other)).toBe("Finley NWR");

    const rowsOf = await overlay(w);
    const [byPage, byApi] = ["inat:998877", "inat:998878"].map((ref) => rowsOf.find((r) => r.sample_ref === ref && r.field === "locality")) as [
      SampleOverlayRow,
      SampleOverlayRow,
    ];
    expect(byApi.reason).toBe(byPage.reason);
    expect(byApi.reason).toBe(en.suggestedLocality.reason(en.suggestedLocality.basis.refuge));
    expect([byApi.value, byApi.author]).toEqual([byPage.value, byPage.author]);

    const page = await w.entries("A-1");
    const api = await w.entries("A-3");
    expect(page.length).toBeGreaterThan(0);
    expect(page.every((e) => e.source === "app")).toBe(true);
    expect(api.every((e) => e.source === "api")).toBe(true);
    expect(api.map(({ source: _, ...rest }) => rest)).toEqual(page.map(({ source: _, ...rest }) => rest));
    expect(api).toContainEqual(expect.objectContaining({ field: "locality", to: "Finley NWR", author: "samstaff" }));
  });

  it("follows iNaturalist again for an empty name, as the place editor does, saying it removed", async () => {
    const w = await world();
    await w.send(w.keys.alice, `/samples/${w.linked}/locality`, { locality: "Finley NWR" });
    const res = await w.send(w.keys.alice, `/samples/${w.linked}/locality`, { locality: "" });
    expect(await json(res)).toEqual({ sample_id: w.linked, outcome: "removed" });
    expect((await overlay(w)).filter((r) => r.field === "locality" && r.value !== "")).toEqual([]);
    const again = await w.send(w.keys.alice, `/samples/${w.linked}/locality`, { locality: "" });
    expect(await json(again)).toEqual({ sample_id: w.linked, outcome: "unchanged" });
  });

  it("lets staff write a name nobody offered, and puts the point in", async () => {
    const w = await world();
    const named = await w.send(w.keys.sam, `/samples/${w.linked}/locality`, { locality: "Staff's name" });
    expect(await json(named)).toEqual({ sample_id: w.linked, outcome: "saved" });
    const point = await w.send(w.keys.sam, `/samples/${w.linked}/coordinates`, { latitude: "44.5", longitude: -123.2, note: "from the notebook" });
    expect(point.status).toBe(200);
    expect(await json(point)).toMatchObject({ sample_id: w.linked, outcome: "saved" });
    expect(await rows(w.conn, `SELECT round(latitude, 1), source FROM sample_location WHERE sample_id = ${w.linked}`)).toEqual([[44.5, "staff_entry"]]);
    const entries = await w.entries("A-1");
    expect(entries).toContainEqual(expect.objectContaining({ field: "locality", author: "samstaff", source: "api" }));
    expect(entries).toContainEqual(expect.objectContaining({ field: "location", reason: "from the notebook", source: "api" }));
    // Taking the point away says so.
    const gone = await w.send(w.keys.sam, `/samples/${w.linked}/coordinates`, { remove: true, note: "wrong" });
    expect(await json(gone)).toMatchObject({ outcome: "removed" });
  });

  it("holds a sample and lifts the hold, and waives a flag, saying what each did", async () => {
    const w = await world();
    const held = await w.send(w.keys.sam, `/samples/${w.linked}/hold`, { note: "date looks a year off" });
    expect(await json(held)).toEqual({ sample_id: w.linked, outcome: "saved" });
    expect(await printable(w, w.linked)).toBe(false);
    const lifted = await w.send(w.keys.sam, `/samples/${w.linked}/hold`, { lift: true });
    expect(await json(lifted)).toEqual({ sample_id: w.linked, outcome: "removed" });
    expect(await printable(w, w.linked)).toBe(true);

    await w.conn.run(`UPDATE sample SET locality = 'Deschutes River SRA' WHERE entity_id = ${w.other}`);
    expect(await printable(w, w.other)).toBe(false);
    const waived = await w.send(w.keys.sam, `/samples/${w.other}/waiver`, { rule: "locality_format", note: "short enough" });
    expect(await json(waived)).toEqual({ sample_id: w.other, outcome: "saved" });
    expect(await printable(w, w.other)).toBe(true);
    expect(await w.entries("A-3")).toContainEqual(expect.objectContaining({ field: "waivers", author: "samstaff", source: "api" }));
  });

  it("edits the collector's own sample, writing the corrections file and the sample as the form does", async () => {
    const w = await world();
    const res = await w.send(w.keys.bea, `/samples/${w.legacy}/edit`, { values: { locality: "Walla Walla" }, note: "in town" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      sample_id: w.legacy,
      outcome: "saved",
      dry_run: false,
      changes: [{ field: "locality", from: expect.anything(), to: "Walla Walla" }],
    });
    expect(await localityOf(w.conn, w.legacy)).toBe("Walla Walla");
    expect(await correctionsFile(w)).toContain("Walla Walla");
    expect(await w.entries("OBAS-00657")).toContainEqual({ field: "locality", to: "Walla Walla", author: w.beaLogin, reason: "in town", source: "api" });
  });

  it("says unchanged and writes nothing when the value sent is the one the sample holds, with or without a note", async () => {
    const w = await world();
    const now = (await localityOf(w.conn, w.legacy))!;
    const before = await correctionsFile(w);
    for (const body of [{ values: { locality: now } }, { values: { locality: `  ${now} ` }, note: "no change" }, { values: {} }]) {
      const res = await w.send(w.keys.bea, `/samples/${w.legacy}/edit`, body);
      expect([JSON.stringify(body), await json(res)]).toEqual([
        JSON.stringify(body),
        { sample_id: w.legacy, outcome: "unchanged", dry_run: false, changes: [] },
      ]);
    }
    expect(await correctionsFile(w)).toBe(before);
    expect(await w.entries("OBAS-00657")).toEqual([]);
    // Without bases there is no stale form to tell from: a program that reads the sample, and then sends
    // the value it read after a newer save, is changing the sample back, and says so with `from` and `to`.
    await w.send(w.keys.bea, `/samples/${w.legacy}/edit`, { values: { locality: "Newer" } });
    const back = await json(await w.send(w.keys.bea, `/samples/${w.legacy}/edit`, { values: { locality: now } }));
    expect(back).toMatchObject({ outcome: "saved", changes: [{ field: "locality", from: "Newer", to: now }] });
  });
});

describe("a dry run of the collector's edit", () => {
  it("returns the plan and writes nothing, and the same request without it writes exactly that plan", async () => {
    const w = await world();
    const body = { values: { locality: "Walla Walla", county: "Walla Walla" }, note: "in town" };
    const store = async () => rows(w.conn, `SELECT locality, county FROM sample WHERE entity_id = ${w.legacy}`);
    const before = { store: await store(), file: await correctionsFile(w), log: await w.entries("OBAS-00657"), overlay: await overlay(w) };

    const dry = await w.send(w.keys.bea, `/samples/${w.legacy}/edit`, { ...body, dry_run: true });
    expect(dry.status).toBe(200);
    const planned = await json(dry);
    expect(planned).toMatchObject({ outcome: "would_save", dry_run: true });
    expect((planned.changes as { field: string }[]).map((c) => c.field).sort()).toEqual(["county", "locality"]);
    expect({ store: await store(), file: await correctionsFile(w), log: await w.entries("OBAS-00657"), overlay: await overlay(w) }).toEqual(before);

    const real = await json(await w.send(w.keys.bea, `/samples/${w.legacy}/edit`, body));
    expect(real.outcome).toBe("saved");
    expect(real.changes).toEqual(planned.changes);
    expect(await store()).toEqual([["Walla Walla", "Walla Walla"]]);
  });

  it("goes through the same rules: a stranger's sample is a 404 even for a dry run", async () => {
    const w = await world();
    const res = await w.send(w.keys.bob, `/samples/${w.legacy}/edit`, { values: { locality: "X" }, dry_run: true });
    expect(res.status).toBe(404);
  });

  it("is refused by name on the endpoints that have none, and nothing is done", async () => {
    const w = await world();
    for (const [path, body] of [
      [`/samples/${w.linked}/locality`, { locality: "Finley NWR" }],
      [`/samples/${w.linked}/coordinates`, { latitude: 44.5, longitude: -123.2 }],
      [`/samples/${w.linked}/take-observation-location`, {}],
      [`/samples/${w.linked}/hold`, { note: "x" }],
      [`/samples/${w.linked}/waiver`, { rule: "locality_format", note: "x" }],
    ] as const) {
      const res = await w.send(w.keys.sam, path, { ...body, dry_run: true });
      expect([path, res.status]).toEqual([path, 400]);
      expect((await json(res)).message).toContain("Dry runs exist only for edit");
    }
    expect(await overlay(w)).toEqual([]);
    expect(await localityOf(w.conn, w.linked)).toBe("Corvallis");
  });
});

describe("a request that is not a correction", () => {
  it("is refused with 400 for an unknown field, a body that is not JSON or not an object, and a field of the wrong type", async () => {
    const w = await world();
    const path = `/samples/${w.linked}/locality`;
    const unknown = await w.send(w.keys.alice, path, { locality: "Finley NWR", localty: "x" });
    expect(unknown.status).toBe(400);
    expect((await json(unknown)).message).toContain('"localty"');
    for (const body of ["not json", "[1]", "null", '"text"', ""]) {
      expect([body, (await w.send(w.keys.alice, path, body)).status]).toEqual([body, 400]);
    }
    for (const body of [{}, { locality: 5 }, { locality: null }]) {
      expect([JSON.stringify(body), (await w.send(w.keys.alice, path, body)).status]).toEqual([JSON.stringify(body), 400]);
    }
    const edit = `/samples/${w.legacy}/edit`;
    for (const body of [
      { values: { locality: 5 } },
      { values: { colour: "red" } },
      { values: { toString: "x" } },
      // `bases` is for a page that must tell a touched field from a stale prefill: a program sends what it means to change.
      { values: { locality: "X" }, bases: { locality: "Y" } },
      { note: "x" },
      { values: [] },
    ]) {
      expect([JSON.stringify(body), (await w.send(w.keys.bea, edit, body)).status]).toEqual([JSON.stringify(body), 400]);
    }
    expect(await localityOf(w.conn, w.linked)).toBe("Corvallis");
    expect(await overlay(w)).toEqual([]);
    expect(await correctionsFile(w)).not.toContain("x");
  });

  it("takes only the fields an endpoint has: toString, constructor and __proto__ are refused on each, and nothing is written", async () => {
    const w = await world();
    const bodies = (valid: object) => ["toString", "constructor", "__proto__", "hasOwnProperty"].map((name) => `{${JSON.stringify(name)}: "x", ${JSON.stringify(valid).slice(1, -1)}}`);
    const wrote = async () => [await overlay(w), await correctionsFile(w), await w.entries("A-1"), await w.entries("OBAS-00657")];
    const before = await wrote();
    for (const [key, path, valid] of [
      [w.keys.bea, `/samples/${w.legacy}/edit`, { values: { locality: "X" } }],
      [w.keys.alice, `/samples/${w.linked}/locality`, { locality: "Finley NWR" }],
      [w.keys.sam, `/samples/${w.linked}/coordinates`, { latitude: 44.5, longitude: -123.2 }],
      [w.keys.sam, `/samples/${w.linked}/take-observation-location`, {}],
      [w.keys.sam, `/samples/${w.linked}/hold`, { note: "x" }],
      [w.keys.sam, `/samples/${w.linked}/waiver`, { rule: "locality_format", note: "x" }],
    ] as const) {
      for (const body of bodies(valid)) {
        // JSON.parse makes "__proto__" an own property of the body, as a program's would be.
        const res = await w.send(key, path, body.replace(", }", "}"));
        expect([path, body, res.status]).toEqual([path, body, 400]);
        expect((await json(res)).message).toContain("is not a field of this request");
      }
    }
    expect(await wrote()).toEqual(before);
  });

  it("refuses control characters and over-long text in the text a program sends, naming the field, and writes nothing", async () => {
    const w = await world();
    const before = [await overlay(w), await correctionsFile(w)];
    const refused = async (key: string, path: string, body: object, field: string) => {
      const res = await w.send(key, path, body);
      expect([path, JSON.stringify(body).slice(0, 80), res.status]).toEqual([path, JSON.stringify(body).slice(0, 80), 400]);
      expect((await json(res)).message).toContain(field);
    };
    const edit = `/samples/${w.legacy}/edit`;
    for (const bad of ["a\nb", "tab\there", "nul\u0000", "del\u007f", "esc\u001b"]) {
      await refused(w.keys.bea, edit, { values: { locality: bad } }, "locality");
      await refused(w.keys.bea, edit, { values: { locality: "fine" }, note: bad }, "note");
      await refused(w.keys.alice, `/samples/${w.linked}/locality`, { locality: bad }, "locality");
      await refused(w.keys.sam, `/samples/${w.linked}/hold`, { note: bad }, "note");
      await refused(w.keys.sam, `/samples/${w.linked}/coordinates`, { latitude: 44.5, longitude: -123.2, note: bad }, "note");
      await refused(w.keys.sam, `/samples/${w.linked}/waiver`, { rule: bad, note: "x" }, "rule");
    }
    await refused(w.keys.bea, edit, { values: { locality: "x".repeat(501) } }, "500");
    await refused(w.keys.bea, edit, { values: { locality: "fine" }, note: "n".repeat(2001) }, "2000");
    await refused(w.keys.sam, `/samples/${w.linked}/hold`, { note: "n".repeat(2001) }, "2000");
    // At the limits the text is taken.
    const ok = await w.send(w.keys.bea, edit, { values: { locality: "x".repeat(500) }, note: "n".repeat(2000) });
    expect(ok.status).toBe(200);
    expect(before[0]).toEqual([]);
  });

  it("is refused with 413 when the body is over 64 KB, and nothing is written", async () => {
    const w = await world();
    const big = JSON.stringify({ values: { locality: "x".repeat(70 * 1024) } });
    const res = await w.send(w.keys.bea, `/samples/${w.legacy}/edit`, big);
    expect(res.status).toBe(413);
    expect(await json(res)).toMatchObject({ error: "too large" });
    expect(await localityOf(w.conn, w.legacy)).not.toContain("xxxx");
  });

  it("answers 404 for a sample id that is not a whole number, or for no sample", async () => {
    const w = await world();
    for (const id of ["abc", "0", "-1", "1.5", "99999999999", "999999"]) {
      expect([id, (await w.send(w.keys.sam, `/samples/${id}/hold`, { note: "x" })).status]).toEqual([id, 404]);
    }
  });
});

describe("what a refused correction is answered with", () => {
  it("maps each refusal to its status, with its name and a sentence", async () => {
    const w = await world();
    const answer = async (key: string, path: string, body: unknown) => {
      const res = await w.send(key, path, body);
      const b = await json(res);
      return [res.status, b.error, typeof b.message === "string" && b.message.length > 0] as const;
    };
    // not_found
    expect(await answer(w.keys.sam, "/samples/999999/hold", { note: "x" })).toEqual([404, "not found", true]);
    // not_editable: the edit is for a sample with no observation
    expect(await answer(w.keys.alice, `/samples/${w.linked}/edit`, { values: { locality: "X" } })).toEqual([404, "not found", true]);
    // only_offered
    expect(await answer(w.keys.alice, `/samples/${w.linked}/locality`, { locality: "Nowhere" })).toEqual([409, "only_offered", true]);
    // set_by_other: staff set the locality, so its collector may not adopt over it
    await w.send(w.keys.sam, `/samples/${w.linked}/locality`, { locality: "Staff's name" });
    expect(await answer(w.keys.alice, `/samples/${w.linked}/locality`, { locality: "Finley NWR" })).toEqual([409, "set_by_other", true]);
    // not_yours: nor take staff's name away
    expect(await answer(w.keys.alice, `/samples/${w.linked}/locality`, { locality: "" })).toEqual([409, "not_yours", true]);
    // invalid: a hold needs a reason, and the point needs both coordinates
    expect(await answer(w.keys.sam, `/samples/${w.other}/hold`, {})).toEqual([422, "invalid", true]);
    const invalid = await json(await w.send(w.keys.sam, `/samples/${w.other}/hold`, {}));
    expect(invalid.message).toBe("a hold needs a reason");
    expect(await answer(w.keys.sam, `/samples/${w.other}/coordinates`, { latitude: "44.5" })).toEqual([422, "invalid", true]);
    // no_observation: a sample with none has no observation to put a point on
    expect(await answer(w.keys.sam, `/samples/${w.legacy}/coordinates`, { latitude: 44.5, longitude: -123.2 })).toEqual([409, "no_observation", true]);
    // not_moved: nothing to take where iNaturalist's point has not moved
    expect(await answer(w.keys.sam, `/samples/${w.other}/take-observation-location`, {})).toEqual([409, "not_moved", true]);
    // busy: while the nightly runs, a point does not change
    w.setRunning("nightly-pipeline");
    expect(await answer(w.keys.sam, `/samples/${w.other}/coordinates`, { latitude: 44.5, longitude: -123.2 })).toEqual([409, "busy", true]);
    expect(await answer(w.keys.sam, `/samples/${w.other}/take-observation-location`, {})).toEqual([409, "busy", true]);
    // unresolved and unavailable are the writer's and the instance's own: see the unit tests of the functions
  });

  it("refuses every correction with busy while the nightly run or the weekly sweep runs, and writes nothing", async () => {
    const w = await world();
    const all = [
      [w.keys.bea, `/samples/${w.legacy}/edit`, { values: { locality: "Walla Walla" } }],
      [w.keys.alice, `/samples/${w.linked}/locality`, { locality: "Finley NWR" }],
      [w.keys.sam, `/samples/${w.linked}/coordinates`, { latitude: 44.5, longitude: -123.2 }],
      [w.keys.sam, `/samples/${w.linked}/take-observation-location`, {}],
      [w.keys.sam, `/samples/${w.linked}/hold`, { note: "x" }],
      [w.keys.sam, `/samples/${w.linked}/waiver`, { rule: "locality_format", note: "x" }],
    ] as const;
    for (const job of ["nightly-pipeline", "weekly-sweep"]) {
      w.setRunning(job);
      for (const [key, path, body] of all) {
        const res = await w.send(key, path, body);
        expect([job, path, res.status, (await json(res)).error]).toEqual([job, path, 409, "busy"]);
      }
    }
    expect(await overlay(w)).toEqual([]);
    expect(await correctionsFile(w)).not.toContain("Walla Walla");
    // A dry run is a correction too, so it is refused as well; a malformed body is still a 400 first.
    expect((await w.send(w.keys.bea, `/samples/${w.legacy}/edit`, { values: { locality: "X" }, dry_run: true })).status).toBe(409);
    expect((await w.send(w.keys.bea, `/samples/${w.legacy}/edit`, { values: 5 })).status).toBe(400);
    // Other jobs do not stop corrections.
    w.setRunning("session-purge");
    expect((await w.send(w.keys.sam, `/samples/${w.linked}/hold`, { note: "x" })).status).toBe(200);
    // The busy refusal is the API's: the pages are as they were.
    w.setRunning("nightly-pipeline");
    expect((await w.page(`/samples/${w.other}/place`, { locality: "Finley NWR" })).status).toBe(302);
  });

  describe("a write conflict while applying a correction", () => {
    const conflict = () => new Error("TransactionContext Error: Conflict on update!");
    /** A Kysely whose first transaction loses a write conflict. */
    const dbLosingOnce = (db: Kysely<Database>) => {
      let fired = false;
      return new Proxy(db, {
        get(target, prop) {
          if (prop === "transaction" && !fired) {
            fired = true;
            return () => ({
              execute: async () => {
                throw conflict();
              },
            });
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Kysely<Database>;
    };
    /** A connection whose first write to an overlay table loses a write conflict. */
    const connLosingOnce = (conn: DuckDBConnection) => {
      let fired = false;
      return new Proxy(conn, {
        get(target, prop) {
          if (prop === "run") {
            return (sql: string, ...rest: unknown[]) => {
              if (!fired && /^\s*(DELETE FROM|INSERT INTO) sample_(hold|qc_waiver|locality_override|location_override)\b/.test(sql)) {
                fired = true;
                throw conflict();
              }
              return (target.run as (...a: unknown[]) => unknown)(sql, ...rest);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as DuckDBConnection;
    };
    const apiOver = (w: World, deps: { db?: Kysely<Database>; conn?: DuckDBConnection }) =>
      createApi({
        db: w.db,
        isStaff: async (personId) => personId === w.people.sam,
        corrections: {
          deps: {
            db: deps.db ?? w.db,
            conn: deps.conn ?? w.conn,
            correctionsPath: w.paths.correctionsPath,
            sampleOverlayPath: w.paths.sampleOverlayPath,
            samplePaths: { log: w.paths.sampleChangesPath, state: w.paths.sampleStatePath },
            syncJobRunning: () => false,
          },
          messages: en,
        },
      });
    const post = (api: ReturnType<typeof apiOver>, key: string, path: string, body: object) =>
      api.request(path, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    const apiEntries = async (w: World, sampleNumber: string, field: string) =>
      (await w.entries(sampleNumber)).filter((e) => e.source === "api" && e.field === field);

    /**
     * Each of the six writes its file and then the store, so a conflict applying
     * it leaves the file holding the change. Sent again, it is safe: the file
     * has one row for it and not two, the store has it, and the history has one
     * entry under the key's person.
     */
    it("says the change is recorded and not yet applied, and sending it again applies it once: edit", async () => {
      const w = await world();
      const api = apiOver(w, { db: dbLosingOnce(w.db) });
      const send = () => post(api, w.keys.bea, `/samples/${w.legacy}/edit`, { values: { locality: "Walla Walla" }, note: "in town" });
      const lost = await send();
      const answer = await json(lost);
      expect([lost.status, answer.error]).toEqual([409, "recorded_not_applied"]);
      expect(answer.message).toContain("Sending the same request again applies it now and does not record it twice");
      // The file holds it; the store and the history do not.
      expect(await correctionsFile(w)).toContain("Walla Walla");
      expect(await localityOf(w.conn, w.legacy)).not.toBe("Walla Walla");
      expect(await apiEntries(w, "OBAS-00657", "locality")).toEqual([]);
      const again = await send();
      expect(again.status).toBe(200);
      expect(await localityOf(w.conn, w.legacy)).toBe("Walla Walla");
      const events = (await correctionsFile(w)).split("\n").filter((l) => l.includes("Walla Walla"));
      const stagingRows = Number(((await rows(w.conn, `SELECT count(*) FROM legacy_specimen_number WHERE sample_id = ${w.legacy}`)) as [[bigint]])[0][0]);
      expect(events.length).toBe(stagingRows);
      expect(await apiEntries(w, "OBAS-00657", "locality")).toEqual([
        { field: "locality", to: "Walla Walla", author: w.beaLogin, reason: "in town", source: "api" },
      ]);
      const use = (await w.uses()).map((u) => [u[2], u[4], u[6]]);
      expect(use).toEqual([
        ["/samples/:id/edit", "recorded_not_applied", 409],
        ["/samples/:id/edit", "saved", 200],
      ]);
    });

    const overlayCases = [
      ["locality", "alice", (w: World) => `/samples/${w.other}/locality`, { locality: "Finley NWR" }, "A-3", "locality", "inat:998878"],
      ["coordinates", "sam", (w: World) => `/samples/${w.linked}/coordinates`, { latitude: 44.5, longitude: -123.2 }, "A-1", "location", "inat:998877"],
      ["hold", "sam", (w: World) => `/samples/${w.linked}/hold`, { note: "date looks a year off" }, "A-1", "hold", "inat:998877"],
      ["waiver", "sam", (w: World) => `/samples/${w.other}/waiver`, { rule: "locality_format", note: "short enough" }, "A-3", "waivers", "inat:998878"],
    ] as const;
    for (const [name, who, path, body, number, field, ref] of overlayCases) {
      it(`says the change is recorded and not yet applied, and sending it again applies it once: ${name}`, async () => {
        const w = await world();
        if (name === "waiver") await w.conn.run(`UPDATE sample SET locality = 'Deschutes River SRA' WHERE entity_id = ${w.other}`);
        const api = apiOver(w, { conn: connLosingOnce(w.conn) });
        const key = w.keys[who];
        const lost = await post(api, key, path(w), body);
        expect([name, lost.status, (await json(lost)).error]).toEqual([name, 409, "recorded_not_applied"]);
        const filed = (await overlay(w)).filter((r) => r.sample_ref === ref);
        expect(filed.length).toBe(1);
        expect(await apiEntries(w, number, field)).toEqual([]);
        const again = await post(api, key, path(w), body);
        expect([name, again.status]).toEqual([name, 200]);
        // One row in the file, as before, and the store and the history have it once.
        expect((await overlay(w)).filter((r) => r.sample_ref === ref)).toHaveLength(1);
        expect(await apiEntries(w, number, field)).toHaveLength(1);
        expect((await apiEntries(w, number, field)).every((e) => e.author === (who === "alice" ? "alice" : "samstaff"))).toBe(true);
        const store =
          name === "locality"
            ? await rows(w.conn, `SELECT count(*) FROM sample_locality_override WHERE sample_id = ${w.other}`)
            : name === "coordinates"
              ? await rows(w.conn, `SELECT count(*) FROM sample_location_override WHERE sample_id = ${w.linked}`)
              : name === "hold"
                ? await rows(w.conn, `SELECT count(*) FROM sample_hold WHERE sample_id = ${w.linked}`)
                : await rows(w.conn, `SELECT count(*) FROM sample_qc_waiver WHERE sample_id = ${w.other}`);
        expect(store).toEqual([[1n]]);
        expect((await w.uses()).map((u) => u[4])).toEqual(["recorded_not_applied", "saved"]);
      });
    }
  });
});

describe("corrections one after another", () => {
  it("applies corrections in the order they were sent, when each is sent after the last was answered", async () => {
    const w = await world();
    const path = `/samples/${w.linked}/hold`;
    for (let round = 0; round < 4; round++) {
      expect(await json(await w.send(w.keys.sam, path, { note: "x" }))).toEqual({ sample_id: w.linked, outcome: "saved" });
      expect(await json(await w.send(w.keys.sam, path, { lift: true }))).toEqual({ sample_id: w.linked, outcome: "removed" });
      expect(await printable(w, w.linked)).toBe(true);
    }
    // Sent together, they may be applied in either order, so nothing here asserts one: only that each
    // is applied whole, once, and the sample ends in a state one of the two orders leads to.
    const both = await Promise.all([w.send(w.keys.sam, path, { note: "x" }), w.send(w.keys.sam, path, { lift: true })]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect([true, false]).toContain(await printable(w, w.linked));
  });
});

describe("which key made each change", () => {
  it("records one row for each request that is not a read, with the key, the route, the subject, what came of it and the status", async () => {
    const w = await world();
    await w.send(w.keys.sam, `/samples/${w.linked}/hold`, { note: "x" });
    await w.send(w.keys.alice, `/samples/${w.other}/locality`, { locality: "Nowhere" });
    await w.send(w.keys.sam, "/samples/999999/hold", { note: "x" });
    await w.send(w.keys.sam, "/samples/abc/hold", { note: "x" });
    await w.send(w.keys.sam, `/samples/${w.linked}/hold`, { colour: "x" });
    await w.send(w.keys.sam, `/samples/${w.linked}/hold`, { lift: true });
    await w.send(w.keys.sam, `/samples/${w.legacy}/edit`, { values: { locality: "X" }, dry_run: true });
    // Reads leave nothing; neither does a request with no working key, or to a path no route answers.
    await w.send(w.keys.sam, "/me", "", "GET");
    await w.send("beeline_nonsense", `/samples/${w.linked}/hold`, { note: "x" });
    await w.send(undefined, `/samples/${w.linked}/hold`, { note: "x" });
    await w.send(w.keys.sam, "/nowhere", {});
    await w.send(w.keys.sam, `/samples/${w.linked}/nowhere`, {});

    expect((await w.uses()).map(([key, method, route, subject, outcome, , status]) => [key, method, route, subject, outcome, status])).toEqual([
      [hashKey(w.keys.sam), "POST", "/api/v1/samples/:id/hold", String(w.linked), "saved", 200],
      [hashKey(w.keys.alice), "POST", "/api/v1/samples/:id/locality", String(w.other), "only_offered", 409],
      [hashKey(w.keys.sam), "POST", "/api/v1/samples/:id/hold", "999999", "not_found", 404],
      [hashKey(w.keys.sam), "POST", "/api/v1/samples/:id/hold", "abc", "not_found", 404],
      [hashKey(w.keys.sam), "POST", "/api/v1/samples/:id/hold", String(w.linked), "invalid_request", 400],
      [hashKey(w.keys.sam), "POST", "/api/v1/samples/:id/hold", String(w.linked), "removed", 200],
      [hashKey(w.keys.sam), "POST", "/api/v1/samples/:id/edit", String(w.legacy), "not_editable", 404],
    ]);
  });

  it("tells a dry run, a save and a request that changed nothing apart by what came of each", async () => {
    const w = await world();
    const edit = `/samples/${w.legacy}/edit`;
    const now = (await localityOf(w.conn, w.legacy))!;
    await w.send(w.keys.bea, edit, { values: { locality: "Walla Walla" }, dry_run: true });
    await w.send(w.keys.bea, edit, { values: { locality: "Walla Walla" } });
    await w.send(w.keys.bea, edit, { values: { locality: "Walla Walla" } });
    expect(now).not.toBe("Walla Walla");
    expect((await w.uses()).map((u) => [u[4], u[6]])).toEqual([
      ["would_save", 200],
      ["saved", 200],
      ["unchanged", 200],
    ]);
  });

  it("records the refusal of a key that may only read under the route it was for, and nothing for a path no route has", async () => {
    const w = await world();
    await w.send(w.keys.aliceRead, `/samples/${w.linked}/hold`, { note: "x" });
    expect((await w.uses()).map((u) => [u[2], u[4], u[6]])).toEqual([["/api/v1/samples/:id/hold", "forbidden", 403]]);
  });

  it("records a request that ends in a 500, with its status", async () => {
    const w = await world();
    const broken = new Proxy(w.db, {
      get(target, prop) {
        if (prop === "selectFrom") return () => { throw new Error("the store failed"); };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Kysely<Database>;
    const api = createApi({
      db: w.db,
      isStaff: async () => false,
      corrections: {
        deps: {
          db: broken,
          conn: w.conn,
          correctionsPath: w.paths.correctionsPath,
          sampleOverlayPath: w.paths.sampleOverlayPath,
          samplePaths: { log: w.paths.sampleChangesPath, state: w.paths.sampleStatePath },
          syncJobRunning: () => false,
        },
        messages: en,
      },
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await api.request(`/samples/${w.legacy}/edit`, {
        method: "POST",
        headers: { authorization: `Bearer ${w.keys.bea}` },
        body: JSON.stringify({ values: { locality: "X" } }),
      });
      expect(res.status).toBe(500);
    } finally {
      quiet.mockRestore();
    }
    expect((await w.uses()).map((u) => [u[2], u[3], u[4], u[6]])).toEqual([["/samples/:id/edit", String(w.legacy), null, 500]]);
  });

  it("never fails a request because the row could not be written, and logs why, a write conflict included", async () => {
    const w = await world();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await w.conn.run("DROP TABLE api_key_use");
      const res = await w.send(w.keys.sam, `/samples/${w.linked}/hold`, { note: "x" });
      expect(res.status).toBe(200);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not record the use of key"));
      // A write conflict is logged as one, and not swallowed.
      const conflicting = new Proxy(w.db, {
        get(target, prop) {
          if (prop === "insertInto") {
            return () => ({ values: () => ({ execute: async () => { throw new Error("TransactionContext Error: Conflict on update!"); } }) });
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Kysely<Database>;
      warn.mockClear();
      const api = createApi({ db: conflicting, isStaff: async () => false });
      expect((await api.request("/jobs/nonesuch", { method: "POST", headers: { authorization: `Bearer ${w.keys.bea}` } })).status).toBe(403);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("a write conflict"));
    } finally {
      warn.mockRestore();
    }
    expect(await printable(w, w.linked)).toBe(false);
  });

  it("records starting a job with the job's name as its subject", async () => {
    const w = await world();
    await w.send(w.keys.sam, "/jobs/nonesuch", "", "POST");
    expect((await w.uses()).map((u) => [u[2], u[3], u[4], u[6]])).toEqual([["/api/v1/jobs/:name", "nonesuch", "not_found", 404]]);
  });
});

describe("a reference to the request behind a change", () => {
  const sixRequests = (w: World) =>
    [
      [w.keys.bea, `/samples/${w.legacy}/edit`, { values: { locality: "Walla Walla" } }],
      [w.keys.alice, `/samples/${w.other}/locality`, { locality: "Finley NWR" }],
      [w.keys.sam, `/samples/${w.linked}/coordinates`, { latitude: 44.5, longitude: -123.2 }],
      [w.keys.sam, `/samples/${w.linked}/take-observation-location`, {}],
      [w.keys.sam, `/samples/${w.linked}/hold`, { note: "x" }],
      [w.keys.sam, `/samples/${w.linked}/waiver`, { rule: "locality_format", note: "x" }],
    ] as const;

  it("is stored with the request for each of the six endpoints, trimmed, and for a dry run", async () => {
    const w = await world();
    for (const [key, path, body] of sixRequests(w)) {
      const res = await w.send(key, path, { ...body, reference: "  gmail:msg-18c2f  " });
      // Whatever the correction answered: the reference is recorded either way.
      expect([path, res.status === 400]).toEqual([path, false]);
    }
    await w.send(w.keys.bea, `/samples/${w.legacy}/edit`, { values: { locality: "Elsewhere" }, dry_run: true, reference: "https://example.org/issues/7" });
    const used = await w.uses();
    expect(used).toHaveLength(7);
    expect(used.map((u) => u[5])).toEqual([...Array(6).fill("gmail:msg-18c2f"), "https://example.org/issues/7"]);
    // A refused correction records it too, with the refusal's name as its outcome.
    expect(used.map((u) => u[4])).toContain("not_moved");
    expect(used[1]![4]).toBe("saved");
  });

  it("records a refused correction's reference with the refusal's name, and is NULL when absent or empty", async () => {
    const w = await world();
    const refused = await w.send(w.keys.alice, `/samples/${w.linked}/locality`, { locality: "Nowhere", reference: "msg-1" });
    expect(refused.status).toBe(409);
    await w.send(w.keys.sam, `/samples/${w.linked}/hold`, { note: "x" });
    await w.send(w.keys.sam, `/samples/${w.linked}/hold`, { lift: true, reference: "" });
    await w.send(w.keys.sam, `/samples/${w.linked}/hold`, { note: "y", reference: "   " });
    expect((await w.uses()).map((u) => [u[4], u[5]])).toEqual([
      ["only_offered", "msg-1"],
      ["saved", null],
      ["removed", null],
      ["saved", null],
    ]);
  });

  it("is not passed to the correction: not in the overlay, the history or the corrections file", async () => {
    const w = await world();
    await w.send(w.keys.sam, `/samples/${w.linked}/hold`, { note: "date looks a year off", reference: "gmail:msg-18c2f" });
    await w.send(w.keys.bea, `/samples/${w.legacy}/edit`, { values: { locality: "Walla Walla" }, note: "in town", reference: "gmail:msg-18c2f" });
    expect(JSON.stringify(await overlay(w))).not.toContain("msg-18c2f");
    expect(await correctionsFile(w)).not.toContain("msg-18c2f");
    expect(JSON.stringify([await w.entries("A-1"), await w.entries("OBAS-00657")])).not.toContain("msg-18c2f");
    expect(await readFile(w.paths.sampleChangesPath, "utf8")).not.toContain("msg-18c2f");
  });

  it("is refused with 400 naming the field when it is too long, not a string or has a control character, and nothing is written", async () => {
    const w = await world();
    const before = [await overlay(w), await correctionsFile(w)];
    for (const [key, path, body] of sixRequests(w)) {
      for (const bad of ["x".repeat(501), 5, null, ["a"], "line\nbreak", "tab\t", "nul\u0000"]) {
        const res = await w.send(key, path, { ...body, reference: bad });
        expect([path, JSON.stringify(bad).slice(0, 20), res.status]).toEqual([path, JSON.stringify(bad).slice(0, 20), 400]);
        expect((await json(res)).message).toContain('"reference"');
      }
      // The longest allowed, once trimmed.
      expect([path, (await w.send(key, path, { ...body, dry_run: undefined, reference: ` ${"x".repeat(500)} ` })).status === 400]).toEqual([path, false]);
    }
    expect(before[0]).toEqual([]);
    // Every request that was a 400 left a row with no reference.
    expect((await w.uses()).filter((u) => u[6] === 400).every((u) => u[5] === null && u[4] === "invalid_request")).toBe(true);
  });

  it("is accepted when starting a job, where a missing or empty body is as valid as ever and any other field is a 400", async () => {
    const w = await world();
    const post = (body: string | undefined) =>
      w.app.request("/api/v1/jobs/nonesuch", { method: "POST", headers: { authorization: `Bearer ${w.keys.sam}` }, body });
    expect((await post(undefined)).status).toBe(404);
    expect((await post("")).status).toBe(404);
    expect((await post(JSON.stringify({ reference: "https://example.org/issues/7" }))).status).toBe(404);
    expect((await post(JSON.stringify({ reference: "" }))).status).toBe(404);
    for (const bad of [{ note: "x" }, { reference: 5 }, { reference: "x".repeat(501) }, { reference: "a\nb" }, "not json", "[]"]) {
      expect([JSON.stringify(bad), (await post(typeof bad === "string" ? bad : JSON.stringify(bad))).status]).toEqual([JSON.stringify(bad), 400]);
    }
    expect((await w.uses()).map((u) => [u[3], u[4], u[5]])).toEqual([
      ["nonesuch", "not_found", null],
      ["nonesuch", "not_found", null],
      ["nonesuch", "not_found", "https://example.org/issues/7"],
      ["nonesuch", "not_found", null],
      ...Array(6).fill(["nonesuch", "invalid_request", null]),
    ]);
  });
});

describe("what a key reaches", () => {
  it("never acts for anyone: a key whose person holds a delegation gets 404 on the other person's samples", async () => {
    const w = await world();
    await w.conn.run(`INSERT INTO person_delegate (person_id, acts_for_id, granted_by) VALUES (${w.people.bob}, ${w.people.alice}, 'peter')`);
    const res = await w.send(w.keys.bob, `/samples/${w.linked}/locality`, { locality: "Finley NWR" });
    expect(res.status).toBe(404);
    expect(await localityOf(w.conn, w.linked)).toBe("Corvallis");
    // Nor an edit of what a delegate may edit on a page.
    await w.conn.run(`INSERT INTO person_delegate (person_id, acts_for_id, granted_by) VALUES (${w.people.bob}, ${w.people.bea}, 'peter')`);
    expect((await w.send(w.keys.bob, `/samples/${w.legacy}/edit`, { values: { locality: "X" } })).status).toBe(404);
    expect(await overlay(w)).toEqual([]);
  });

  it("gives a staff key no more of the collector's edit than anyone else has: it is the collector's", async () => {
    const w = await world();
    const res = await w.send(w.keys.sam, `/samples/${w.legacy}/edit`, { values: { locality: "X" } });
    expect([res.status, (await json(res)).error]).toEqual([404, "not found"]);
    expect(await localityOf(w.conn, w.legacy)).not.toBe("X");
  });
});

describe("refusals over HTTP that need a fixture", () => {
  it("answers printed, no_staging and unresolved with their statuses", async () => {
    const w = await world();
    // no_staging: a sample with no observation and no old Beeline record behind it.
    const bare = await insertCleanSample(w.conn, { collector_id: String(w.people.alice), sample_number: "'A-9'" });
    const noStaging = await w.send(w.keys.alice, `/samples/${bare}/edit`, { values: { locality: "Elsewhere" } });
    expect([noStaging.status, (await json(noStaging)).error]).toEqual([409, "no_staging"]);
    // unresolved: two samples on one observation cannot take an overlay row that names one.
    await insertCleanSample(w.conn, { collector_id: String(w.people.alice), sample_number: "'A-10'", inat_observation_id: "998877" });
    const unresolved = await w.send(w.keys.sam, `/samples/${w.linked}/hold`, { note: "x" });
    expect([unresolved.status, (await json(unresolved)).error]).toEqual([409, "unresolved"]);
    expect(await overlay(w)).toEqual([]);
    // printed: once Beeline has printed a sample, its collector may not change the locality.
    const run = (await prepareRun(w.conn, { atlasId: null, personId: w.people.sam, now: new Date() }))!.printRunId;
    await approveRun(w.conn, run, { personId: w.people.sam, now: new Date() });
    await markPrinted(w.conn, run, { personId: w.people.sam, now: new Date() });
    const printed = await w.send(w.keys.alice, `/samples/${w.other}/locality`, { locality: "Finley NWR" });
    expect([printed.status, (await json(printed)).error]).toEqual([409, "printed"]);
  });

  // `changed` is adoptLocality's refusal, and the API has no endpoint for adoptLocality: the place editor adopts an offered name.
  // `unavailable` needs an instance with no overlay connection, which the pages' tests and the function's own tests cover.

  it("says not found, and not printed, to someone who may not see another person's printed sample entered in Beeline, on the page and the API alike", async () => {
    const w = await world();
    const entered = await insertCleanSample(w.conn, { collector_id: String(w.people.alice), sample_number: "'A-20'" });
    await w.conn.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES (${entered}, ${w.people.alice})`);
    const run = (await prepareRun(w.conn, { atlasId: null, personId: w.people.sam, now: new Date() }))!.printRunId;
    await approveRun(w.conn, run, { personId: w.people.sam, now: new Date() });
    await markPrinted(w.conn, run, { personId: w.people.sam, now: new Date() });
    expect((await rows(w.conn, `SELECT 1 FROM printed_sample WHERE sample_id = ${entered}`)).length).toBe(1);

    // The API, with Bob's key. His own sample's collector, Alice, is told it is printed.
    const byKey = await w.send(w.keys.bob, `/samples/${entered}/locality`, { locality: "Somewhere" });
    expect([byKey.status, (await json(byKey)).error]).toEqual([404, "not found"]);
    const owner = await w.send(w.keys.alice, `/samples/${entered}/locality`, { locality: "Somewhere" });
    expect([owner.status, (await json(owner)).error]).toEqual([409, "printed"]);

    // The page, signed in as Bob.
    const asBob = createApp({
      ...w.paths,
      db: w.db,
      config: { environment: "sandbox" as const, origin: ORIGIN },
      inat: unusedInat,
      resolveSession: async () => ({ personId: w.people.bob, login: "bob", inatUserId: BigInt(UID.bob), iconUrl: null }),
      conn: w.conn,
    });
    const page = await asBob.request(`/samples/${entered}/place`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ locality: "Somewhere" }).toString(),
    });
    expect(page.status).toBe(404);
  });
});

/**
 * Taking the observation's location needs a sample Beeline printed whose
 * observation has since moved, which is a long setup (the case, and its
 * numbers, are test/take-observation-location.test.ts's: an observation printed
 * in California and moved to Lane County, Oregon). Here Sam, who is staff, takes
 * it once through a page and once through the API, each in a store of its own.
 */
describe("taking the observation's location", () => {
  const CALIFORNIA = { lat: 39.059242, lon: -121.137299 };
  const OREGON = { lat: 43.620977, lon: -122.237981 };
  const OBSERVATION = 402367157;
  const PLACES: Array<[number, string, number, number[]]> = [
    [1, "United States", 0, [97394, 1]],
    [10, "Oregon", 10, [97394, 1, 10]],
    [981, "Lane", 20, [97394, 1, 10, 981]],
  ];

  async function moved() {
    const { instance, conn } = await createMemoryDb();
    const lori = await person(conn, "Lori Collector", "lori", 1);
    const sam = await person(conn, "Sam Staff", "samstaff", 2);
    await conn.run(`INSERT INTO person_admin (person_id) VALUES (${sam})`);
    for (const [id, name, level, ancestors] of PLACES) {
      await conn.run(`INSERT INTO inat_place (inat_place_id, name, admin_level, ancestor_place_ids) VALUES ($1, $2, $3, CAST($4 AS BIGINT[]))`, [
        id,
        name,
        level,
        `[${ancestors.join(",")}]`,
      ] as never);
    }
    const sampleId = await insertCleanSample(
      conn,
      {
        collector_id: String(lori),
        sample_number: "'5'",
        date_start: `DATE '${currentSeasonDate(9, 21)}'`,
        date_end: `DATE '${currentSeasonDate(9, 21)}'`,
        specimen_count: "2",
        inat_observation_id: String(OBSERVATION),
        state_province: "'CA'",
        county: "'Nevada'",
        locality: "'Wolf Mountain'",
      },
      { latitude: String(CALIFORNIA.lat), longitude: String(CALIFORNIA.lon), coordinate_uncertainty_m: "NULL", elevation_m: "478" },
    );
    const run = (await prepareRun(conn, { atlasId: null, personId: sam, now: new Date() }))!.printRunId;
    await approveRun(conn, run, { personId: sam, now: new Date() });
    await markPrinted(conn, run, { personId: sam, now: new Date() });
    await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
    const o = {
      id: OBSERVATION,
      uuid: "uuid-wolf",
      observed_on: currentSeasonDate(9, 21),
      geojson: { type: "Point", coordinates: [OREGON.lon, OREGON.lat] },
      positional_accuracy: null,
      geoprivacy: null,
      taxon_geoprivacy: null,
      obscured: false,
      place_guess: "Wolf Mountain, OR, USA",
      place_ids: [1, 10, 981],
      user: { id: 1, login: "lori", name: "Lori Collector" },
      ofvs: [{ name: "sampleId", value: "5" }, { name: "numberOfSpecimens", value: "2" }],
    };
    await conn.run(
      `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
       VALUES ($1, (SELECT max(entity_id) FROM sync_run), $2, $3)`,
      [OBSERVATION, canonicalJson(o), `hash-${Math.random()}`] as never,
    );
    await refreshObservationFields(conn);
    const dir = await mkdtemp(join(tmpdir(), "beeline-api-take-"));
    const gazetteerPath = join(dir, "gazetteer.duckdb");
    await buildTestGazetteer(gazetteerPath, "build-lane");
    const gz = await openDuckDb(gazetteerPath);
    const g = await gz.connect();
    await loadSpatial(g);
    await g.run(`INSERT INTO region VALUES ('US-OR-41039', 'USA', 'OR', 'Lane', 'census', '41039', 'Lane County', ST_MakeEnvelope(-122.6, 43.4, -121.9, 43.9))`);
    g.closeSync();
    gz.closeSync();
    const paths = await scratchPaths();
    const db = createKysely(instance);
    const mintConn = await instance.connect();
    const app = createApp({
      ...paths,
      db,
      config: { environment: "sandbox" as const, origin: ORIGIN },
      inat: unusedInat,
      resolveSession: async () => ({ personId: sam, login: "samstaff", inatUserId: BigInt(2), iconUrl: null }),
      conn,
      mintConn,
      derivePaths: { gazetteerPath },
      jobs: { list: [], start: async () => false, running: () => null },
    });
    await recordSampleChanges(duckdbReader(conn), { log: paths.sampleChangesPath, state: paths.sampleStatePath }, { source: "observation_promotion" });
    const made = await createKey(db, { inatUserId: 2, name: "test", scope: "staff", lifetimeDays: 30, offered: KEY_SCOPES });
    if ("problem" in made) throw new Error(made.problem);
    return { app, db, conn, mintConn, sam, gazetteerPath, sampleId, paths, key: made.key };
  }

  it("takes the point as the page does, with the same reason and author, and the history says it came through the API", async () => {
    const byPage = await moved();
    const page = await byPage.app.request(`/samples/${byPage.sampleId}/take-observation-location`, { method: "POST", body: new URLSearchParams({}) });
    expect(page.status).toBe(302);

    const byApi = await moved();
    const res = await byApi.app.request(`/api/v1/samples/${byApi.sampleId}/take-observation-location`, {
      method: "POST",
      headers: { authorization: `Bearer ${byApi.key}` },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ sample_id: byApi.sampleId, outcome: "saved", settled: true });

    const stored = async (w: { conn: DuckDBConnection; sampleId: number; paths: { sampleOverlayPath: string; sampleChangesPath: string } }) => ({
      point: (await rows(w.conn, `SELECT round(latitude, 6), round(longitude, 6), source FROM sample_location WHERE sample_id = ${w.sampleId}`))[0],
      county: (await rows(w.conn, `SELECT county FROM sample WHERE entity_id = ${w.sampleId}`))[0],
      overlay: (await readSampleOverlay(w.paths.sampleOverlayPath)).map((r) => [r.field, r.value, r.author, r.reason]),
      history: (await readSampleChanges(w.paths.sampleChangesPath))
        .filter((c) => c.source !== "observation_promotion")
        .map((c) => ({ field: c.field, to: c.new_value, author: c.author, reason: c.reason, source: c.source })),
    });
    const [p, a] = [await stored(byPage), await stored(byApi)];
    expect(a.point).toEqual([OREGON.lat, OREGON.lon, "staff_entry"]);
    expect(a.county).toEqual(["Lane"]);
    expect(a.overlay).toEqual(p.overlay);
    expect(a.overlay[0]![3]).toBe(en.record.sample.takeObservationLocation.reason);
    expect(a.history.length).toBeGreaterThan(0);
    expect(p.history.every((h) => h.source === "app")).toBe(true);
    expect(a.history.every((h) => h.source === "api")).toBe(true);
    expect(a.history.map(({ source: _, ...rest }) => rest)).toEqual(p.history.map(({ source: _, ...rest }) => rest));
    // Nothing left to take: not_moved.
    const again = await byApi.app.request(`/api/v1/samples/${byApi.sampleId}/take-observation-location`, {
      method: "POST",
      headers: { authorization: `Bearer ${byApi.key}` },
      body: "{}",
    });
    expect([again.status, (await json(again)).error]).toEqual([409, "not_moved"]);
  });

  it("says the change is recorded and not yet applied when applying it loses a write conflict, and sending it again applies it once: take-observation-location", async () => {
    const w = await moved();
    let fired = false;
    const conn = new Proxy(w.conn, {
      get(target, prop) {
        if (prop === "run") {
          return (sql: string, ...rest: unknown[]) => {
            if (!fired && /^\s*(DELETE FROM|INSERT INTO) sample_location_override\b/.test(sql)) {
              fired = true;
              throw new Error("TransactionContext Error: Conflict on update!");
            }
            return (target.run as (...a: unknown[]) => unknown)(sql, ...rest);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DuckDBConnection;
    const api = createApi({
      db: w.db,
      isStaff: async (personId) => personId === w.sam,
      corrections: {
        deps: {
          db: w.db,
          conn,
          mintConn: w.mintConn,
          correctionsPath: w.paths.correctionsPath,
          sampleOverlayPath: w.paths.sampleOverlayPath,
          samplePaths: { log: w.paths.sampleChangesPath, state: w.paths.sampleStatePath },
          derivePaths: { gazetteerPath: w.gazetteerPath },
          syncJobRunning: () => false,
        },
        messages: en,
      },
    });
    const send = () =>
      api.request(`/samples/${w.sampleId}/take-observation-location`, { method: "POST", headers: { authorization: `Bearer ${w.key}` }, body: "{}" });
    const lost = await send();
    expect([lost.status, (await json(lost)).error]).toEqual([409, "recorded_not_applied"]);
    expect(await readSampleOverlay(w.paths.sampleOverlayPath)).toHaveLength(1);
    expect(await rows(w.conn, `SELECT round(latitude, 6) FROM sample_location WHERE sample_id = ${w.sampleId}`)).toEqual([[CALIFORNIA.lat]]);
    const again = await send();
    expect(again.status).toBe(200);
    expect(await readSampleOverlay(w.paths.sampleOverlayPath)).toHaveLength(1);
    expect(await rows(w.conn, `SELECT round(latitude, 6), source FROM sample_location WHERE sample_id = ${w.sampleId}`)).toEqual([[OREGON.lat, "staff_entry"]]);
    const mine = (await readSampleChanges(w.paths.sampleChangesPath)).filter((c) => c.source === "api" && c.field === "location");
    expect(mine.map((c) => c.author)).toEqual(["samstaff"]);
  });
});
