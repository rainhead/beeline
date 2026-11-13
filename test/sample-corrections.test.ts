import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import {
  adoptLocality,
  editSample,
  holdSample,
  setCoordinates,
  setPlace,
  takeLocation,
  waiveFlag,
  type Actor,
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
