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
      (await rows(conn, `SELECT key_sha256, method, route, subject, status FROM api_key_use ORDER BY used_at, subject`)) as unknown[][],
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
  it("offers edit to everyone, and staff only to someone who is staff", () => {
    expect(offeredScopes(false)).toEqual(["read", "edit"]);
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

  it("says unchanged when the edit changes nothing, using the bases the caller last saw", async () => {
    const w = await world();
    const now = (await localityOf(w.conn, w.legacy))!;
    const same = await w.send(w.keys.bea, `/samples/${w.legacy}/edit`, { values: { locality: now } });
    expect(await json(same)).toMatchObject({ outcome: "unchanged", changes: [] });
    // A stale program sends the value it first read as the base, so a newer save is not undone.
    await w.send(w.keys.bea, `/samples/${w.legacy}/edit`, { values: { locality: "Newer" } });
    const stale = await w.send(w.keys.bea, `/samples/${w.legacy}/edit`, { values: { locality: now }, bases: { locality: now } });
    expect(await json(stale)).toMatchObject({ outcome: "unchanged" });
    expect(await localityOf(w.conn, w.legacy)).toBe("Newer");
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
    for (const body of [{ values: { locality: 5 } }, { values: { colour: "red" } }, { values: { locality: "X" }, bases: { height: "1" } }, { note: "x" }, { values: [] }]) {
      expect([JSON.stringify(body), (await w.send(w.keys.bea, edit, body)).status]).toEqual([JSON.stringify(body), 400]);
    }
    expect(await localityOf(w.conn, w.linked)).toBe("Corvallis");
    expect(await overlay(w)).toEqual([]);
    expect(await correctionsFile(w)).not.toContain("x");
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

  it("answers a write conflict with 409 and does not retry", async () => {
    const w = await world();
    let attempts = 0;
    const conflicting = new Proxy(w.db, {
      get(target, prop) {
        if (prop === "transaction") {
          return () => ({
            execute: async () => {
              attempts += 1;
              throw new Error("TransactionContext Error: Conflict on update!");
            },
          });
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Kysely<Database>;
    const api = createApi({
      db: w.db,
      isStaff: async () => false,
      corrections: {
        deps: {
          db: conflicting,
          conn: w.conn,
          correctionsPath: w.paths.correctionsPath,
          sampleOverlayPath: w.paths.sampleOverlayPath,
          samplePaths: { log: w.paths.sampleChangesPath, state: w.paths.sampleStatePath },
          syncJobRunning: () => false,
        },
        messages: en,
      },
    });
    const res = await api.request(`/samples/${w.legacy}/edit`, {
      method: "POST",
      headers: { authorization: `Bearer ${w.keys.bea}` },
      body: JSON.stringify({ values: { locality: "Walla Walla" } }),
    });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: "conflict" });
    expect(attempts).toBe(1);
  });
});

describe("one correction at a time for a sample", () => {
  it("applies corrections sent without waiting in the order they were sent", async () => {
    const w = await world();
    const path = `/samples/${w.linked}/hold`;
    for (let round = 0; round < 8; round++) {
      // A hold, then lifting it, sent together: the order decides whether each does anything.
      const [first, second] = await Promise.all([w.send(w.keys.sam, path, { note: "x" }), w.send(w.keys.sam, path, { lift: true })]);
      expect([round, await json(first), await json(second)]).toEqual([
        round,
        { sample_id: w.linked, outcome: "saved" },
        { sample_id: w.linked, outcome: "removed" },
      ]);
      expect(await printable(w, w.linked)).toBe(true);
    }
  });
});

describe("which key made each change", () => {
  it("records one row for each request that is not a read, with the key, the route, the subject and the status", async () => {
    const w = await world();
    await w.send(w.keys.sam, `/samples/${w.linked}/hold`, { note: "x" });
    await w.send(w.keys.alice, `/samples/${w.other}/locality`, { locality: "Nowhere" });
    await w.send(w.keys.sam, "/samples/999999/hold", { note: "x" });
    await w.send(w.keys.sam, "/samples/abc/hold", { note: "x" });
    // Reads leave nothing, and neither does a request with no working key.
    await w.send(w.keys.sam, "/me", "", "GET");
    await w.send("beeline_nonsense", `/samples/${w.linked}/hold`, { note: "x" });
    await w.send(undefined, `/samples/${w.linked}/hold`, { note: "x" });

    const uses = await w.uses();
    expect(uses.map(([key, method, route, subject, status]) => [key, method, route, subject, status])).toEqual([
      [hashKey(w.keys.sam), "POST", "/api/v1/samples/:id/hold", String(w.linked), 200],
      [hashKey(w.keys.alice), "POST", "/api/v1/samples/:id/locality", String(w.other), 409],
      [hashKey(w.keys.sam), "POST", "/api/v1/samples/:id/hold", "999999", 404],
      [hashKey(w.keys.sam), "POST", "/api/v1/samples/:id/hold", "abc", 404],
    ]);
  });

  it("records a refused key's scope check too, and an unknown path", async () => {
    const w = await world();
    await w.send(w.keys.aliceRead, `/samples/${w.linked}/hold`, { note: "x" });
    await w.send(w.keys.sam, "/nowhere", {});
    expect((await w.uses()).map((u) => [u[2], u[4]])).toEqual([
      ["/api/v1/samples/*", 403],
      ["/api/v1/*", 404],
    ]);
  });

  it("never fails a request because the row could not be written", async () => {
    const w = await world();
    await w.conn.run("DROP TABLE api_key_use");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await w.send(w.keys.sam, `/samples/${w.linked}/hold`, { note: "x" });
      expect(res.status).toBe(200);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not record the use of key"));
    } finally {
      warn.mockRestore();
    }
    expect(await printable(w, w.linked)).toBe(false);
  });

  it("records starting a job with the job's name as its subject", async () => {
    const w = await world();
    await w.send(w.keys.sam, "/jobs/nonesuch", "", "POST");
    expect((await w.uses()).map((u) => [u[2], u[3], u[4]])).toEqual([["/api/v1/jobs/:name", "nonesuch", 404]]);
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
    const app = createApp({
      ...paths,
      db,
      config: { environment: "sandbox" as const, origin: ORIGIN },
      inat: unusedInat,
      resolveSession: async () => ({ personId: sam, login: "samstaff", inatUserId: BigInt(2), iconUrl: null }),
      conn,
      mintConn: await instance.connect(),
      derivePaths: { gazetteerPath },
      jobs: { list: [], start: async () => false, running: () => null },
    });
    await recordSampleChanges(duckdbReader(conn), { log: paths.sampleChangesPath, state: paths.sampleStatePath }, { source: "observation_promotion" });
    const made = await createKey(db, { inatUserId: 2, name: "test", scope: "staff", lifetimeDays: 30, offered: KEY_SCOPES });
    if ("problem" in made) throw new Error(made.problem);
    return { app, conn, sampleId, paths, key: made.key };
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
});
