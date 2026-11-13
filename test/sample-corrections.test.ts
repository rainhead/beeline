import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import { duckdbReader } from "../src/person-change.js";
import { readSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { readSampleOverlay } from "../src/sample-overlay.js";
import {
  adoptLocality,
  editSample,
  holdSample,
  setCoordinates,
  setPlace,
  takeLocation,
  waiveFlag,
  type Actor,
  actorFor,
  type CorrectionDeps,
} from "../src/app/sample-corrections.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths } from "./helpers.js";

/**
 * The refusals each sample correction makes by itself, without a page
 * (beeline-pnqr.8). The route tests in this folder pin what the pages answer;
 * these pin the functions an API will call, in the order the rules are checked.
 */

async function person(conn: DuckDBConnection, name: string, login: string, userId: number): Promise<number> {
  const [[id]] = (await (await conn.run(`INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)).getRows()) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${userId}, '${login}')`);
  return Number(id);
}

async function setup() {
  const { instance, conn } = await createMemoryDb();
  const alice = await person(conn, "Alice Adams", "alice", 1);
  const bob = await person(conn, "Bob Barnes", "bob", 2);
  const sam = await person(conn, "Sam Staff", "samstaff", 3);
  const linked = await insertCleanSample(conn, { collector_id: String(alice), sample_number: "'A-1'", inat_observation_id: "998877" });
  const unlinked = await insertCleanSample(conn, { collector_id: String(alice), sample_number: "'A-2'" });
  const paths = await scratchPaths();
  let running = false;
  const deps: CorrectionDeps = {
    db: createKysely(instance),
    conn,
    correctionsPath: paths.correctionsPath,
    sampleOverlayPath: paths.sampleOverlayPath,
    samplePaths: { log: paths.sampleChangesPath, state: paths.sampleStatePath },
    syncJobRunning: () => running,
  };
  const actor = (personId: number, login: string, extra: Partial<Actor> = {}): Actor => ({
    personId,
    signedInPersonId: personId,
    login,
    staff: false,
    impersonating: false,
    ...extra,
  });
  return {
    conn,
    paths,
    instance,
    deps,
    linked,
    unlinked,
    alice: actor(alice, "alice"),
    bob: actor(bob, "bob"),
    sam: actor(sam, "samstaff", { staff: true }),
    setRunning: (v: boolean) => (running = v),
  };
}

const coordinates = { latitude: "44.5", longitude: "-123.2", uncertainty: "", remove: false, note: "" };
const reasonFor = () => "because";

describe("sample corrections: refusals", () => {
  it("refuses every correction while impersonating, before anything else", async () => {
    const s = await setup();
    const alice = { ...s.alice, impersonating: true };
    const sam = { ...s.sam, impersonating: true };
    const gone = { ok: false, refusal: "impersonating" };
    expect(await editSample(s.deps, alice, s.unlinked, { values: { locality: "X" }, bases: {}, note: undefined })).toEqual(gone);
    expect(await adoptLocality(s.deps, alice, s.linked, { locality: "X", reasonFor })).toEqual(gone);
    expect(await setPlace(s.deps, alice, s.linked, { locality: "X", reasonFor })).toEqual(gone);
    expect(await setCoordinates(s.deps, sam, s.linked, coordinates)).toEqual(gone);
    expect(await takeLocation(s.deps, sam, s.linked, { note: "", defaultReason: "r" })).toEqual(gone);
    expect(await holdSample(s.deps, sam, s.linked, { lift: false, note: "n" })).toEqual(gone);
    expect(await waiveFlag(s.deps, sam, s.linked, { rule: "r", remove: false, note: "n" })).toEqual(gone);
  });

  it("refuses the staff corrections to anyone who is not staff", async () => {
    const s = await setup();
    const gone = { ok: false, refusal: "not_admin" };
    expect(await setCoordinates(s.deps, s.alice, s.linked, coordinates)).toEqual(gone);
    expect(await takeLocation(s.deps, s.alice, s.linked, { note: "", defaultReason: "r" })).toEqual(gone);
    expect(await holdSample(s.deps, s.alice, s.linked, { lift: false, note: "n" })).toEqual(gone);
    expect(await waiveFlag(s.deps, s.alice, s.linked, { rule: "r", remove: false, note: "n" })).toEqual(gone);
  });

  it("says a sample is not found when it is not the collector's, or does not exist", async () => {
    const s = await setup();
    expect(await editSample(s.deps, s.bob, s.unlinked, { values: { locality: "X" }, bases: {}, note: undefined })).toEqual({
      ok: false,
      refusal: "not_editable",
    });
    expect(await adoptLocality(s.deps, s.bob, s.linked, { locality: "X", reasonFor })).toEqual({ ok: false, refusal: "not_found" });
    expect(await setPlace(s.deps, s.bob, s.linked, { locality: "X", reasonFor })).toEqual({ ok: false, refusal: "not_found" });
    expect(await setCoordinates(s.deps, s.sam, 999999, coordinates)).toEqual({ ok: false, refusal: "not_found" });
    expect(await holdSample(s.deps, s.sam, 999999, { lift: false, note: "n" })).toEqual({ ok: false, refusal: "not_found" });
  });

  it("refuses a locality that is no longer offered, and a collector's own name for a place", async () => {
    const s = await setup();
    expect(await adoptLocality(s.deps, s.alice, s.linked, { locality: "Nowhere", reasonFor })).toEqual({ ok: false, refusal: "changed" });
    expect(await setPlace(s.deps, s.alice, s.linked, { locality: "Nowhere", reasonFor })).toEqual({ ok: false, refusal: "only_offered" });
  });

  it("refuses a point on a sample with no observation, and while a sync job runs", async () => {
    const s = await setup();
    expect(await setCoordinates(s.deps, s.sam, s.unlinked, coordinates)).toEqual({ ok: false, refusal: "no_observation" });
    s.setRunning(true);
    expect(await setCoordinates(s.deps, s.sam, s.linked, coordinates)).toEqual({ ok: false, refusal: "busy" });
    expect(await takeLocation(s.deps, s.sam, s.linked, { note: "", defaultReason: "r" })).toEqual({ ok: false, refusal: "busy" });
    expect(await rows(s.conn, "SELECT 1 FROM sample_location_override")).toEqual([]);
  });

  it("refuses staff decisions on an instance with no overlay connection", async () => {
    const s = await setup();
    const deps = { ...s.deps, conn: undefined };
    expect(await holdSample(deps, s.sam, s.linked, { lift: false, note: "n" })).toEqual({ ok: false, refusal: "unavailable" });
    expect(await takeLocation(deps, s.sam, s.linked, { note: "", defaultReason: "r" })).toEqual({ ok: false, refusal: "unavailable" });
  });

  it("refuses a hold with no reason as invalid, naming the problem", async () => {
    const s = await setup();
    const result = await holdSample(s.deps, s.sam, s.linked, { lift: false, note: "" });
    expect(result).toMatchObject({ ok: false, refusal: "invalid" });
  });
});

describe("sample corrections: the order of refusals", () => {
  it("cannot make an actor who is both staff and impersonating, so impersonation is refused first", async () => {
    const s = await setup();
    const both = actorFor({ ...s.sam, impersonating: true, staff: true });
    expect(both.staff).toBe(false);
    expect(await holdSample(s.deps, both, s.linked, { lift: false, note: "n" })).toEqual({ ok: false, refusal: "impersonating" });
    expect(await setCoordinates(s.deps, both, s.linked, coordinates)).toEqual({ ok: false, refusal: "impersonating" });
  });

  it("does not read the input of a refused correction", async () => {
    const s = await setup();
    const unread = async () => {
      throw new Error("the form was read");
    };
    expect(await setCoordinates(s.deps, s.alice, s.linked, unread)).toEqual({ ok: false, refusal: "not_admin" });
    expect(await holdSample(s.deps, s.sam, 999999, unread)).toEqual({ ok: false, refusal: "not_found" });
    s.setRunning(true);
    expect(await setCoordinates(s.deps, s.sam, s.linked, unread)).toEqual({ ok: false, refusal: "busy" });
  });
});

describe("sample corrections: a correction that saves", () => {
  async function withSuggestions() {
    const s = await setup();
    const other = await insertCleanSample(s.conn, { collector_id: String(s.alice.personId), sample_number: "'A-3'", inat_observation_id: "998878" });
    for (const id of [s.linked, other]) {
      await s.conn.run(
        `INSERT INTO sample_locality_candidate (sample_id, rank, locality, basis, latitude, longitude, gazetteer_build, rule_version, derived_at)
         SELECT sample_id, 1, 'Finley NWR', 'refuge', latitude, longitude, 'test', 1, current_timestamp
         FROM sample_location WHERE sample_id = ${id}`,
      );
    }
    // The change log's first pass only takes a baseline; production's was taken long ago.
    await recordSampleChanges(duckdbReader(s.conn), s.deps.samplePaths, { source: "observation_promotion" });
    return { ...s, other };
  }
  const logged = async (s: Awaited<ReturnType<typeof withSuggestions>>) =>
    (await readSampleChanges(s.paths.sampleChangesPath)).filter((c) => c.source === "app").map((c) => [c.field, c.new_value, c.author]);
  const localityOf = async (conn: DuckDBConnection, id: number) =>
    ((await rows(conn, `SELECT locality FROM sample WHERE entity_id = ${id}`)) as string[][])[0]![0];

  it("adopts a suggested locality for the collector, logged under their login", async () => {
    const s = await withSuggestions();
    const result = await adoptLocality(s.deps, s.alice, s.linked, { locality: "Finley NWR", reasonFor });
    expect(result).toEqual({ ok: true, reason: "because" });
    expect(await localityOf(s.conn, s.linked)).toBe("Finley NWR");
    expect(await logged(s)).toContainEqual(["locality", "Finley NWR", "alice"]);
    expect((await readSampleOverlay(s.paths.sampleOverlayPath)).map((r) => [r.field, r.value, r.author])).toEqual([["locality", "Finley NWR", "alice"]]);
  });

  it("writes a place the editor offers, logged under their login", async () => {
    const s = await withSuggestions();
    expect(await setPlace(s.deps, s.alice, s.other, { locality: "Finley NWR", reasonFor })).toEqual({ ok: true });
    expect(await localityOf(s.conn, s.other)).toBe("Finley NWR");
    expect(await logged(s)).toContainEqual(["locality", "Finley NWR", "alice"]);
  });

  it("holds a sample and lifts the hold, logged under staff's login", async () => {
    const s = await withSuggestions();
    expect(await holdSample(s.deps, s.sam, s.linked, { lift: false, note: "date looks a year off" })).toEqual({ ok: true });
    expect(await rows(s.conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${s.linked}`)).toEqual([]);
    expect(await logged(s)).toContainEqual(expect.arrayContaining(["samstaff"]));
    expect(await holdSample(s.deps, s.sam, s.linked, { lift: true, note: "" })).toEqual({ ok: true });
    expect(await rows(s.conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${s.linked}`)).toHaveLength(1);
  });

  it("waives a blocking flag staff judged fine", async () => {
    const s = await setup();
    await s.conn.run(`UPDATE sample SET locality = 'Deschutes River SRA' WHERE entity_id = ${s.linked}`);
    expect(await rows(s.conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${s.linked}`)).toEqual([]);
    expect(await waiveFlag(s.deps, s.sam, s.linked, { rule: "locality_format", remove: false, note: "short enough" })).toEqual({ ok: true });
    expect(await rows(s.conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${s.linked}`)).toHaveLength(1);
  });

  it("sets staff coordinates, logged under staff's login", async () => {
    const s = await withSuggestions();
    const result = await setCoordinates(s.deps, s.sam, s.linked, { ...coordinates, note: "from the field notebook" });
    expect(result).toMatchObject({ ok: true });
    expect(await rows(s.conn, `SELECT round(latitude, 1), source FROM sample_location WHERE sample_id = ${s.linked}`)).toEqual([[44.5, "staff_entry"]]);
    expect((await logged(s)).filter((c) => c[2] === "samstaff").length).toBeGreaterThan(0);
  });
});
