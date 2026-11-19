import { describe, expect, it, vi } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import { duckdbReader } from "../src/person-change.js";
import { readSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { readSampleOverlay } from "../src/sample-overlay.js";
import {
  adoptLocality,
  editSample,
  holdSample,
  releaseLabels,
  setCoordinates,
  setPlace,
  setSpecimenCount,
  setTrapCount,
  takeLocation,
  waiveFlag,
  type Actor,
  actorFor,
  type CorrectionDeps,
} from "../src/app/sample-corrections.js";
import { withPromotionLock } from "../src/app/promotion-lock.js";
import { onSample } from "../src/app/sample-queue.js";
import { prepareRun } from "../src/print-run.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths, SETTLED_SEASON } from "./helpers.js";

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
    expect(result).toEqual({ ok: true, outcome: "saved", reason: "because" });
    expect(await localityOf(s.conn, s.linked)).toBe("Finley NWR");
    expect(await logged(s)).toContainEqual(["locality", "Finley NWR", "alice"]);
    expect((await readSampleOverlay(s.paths.sampleOverlayPath)).map((r) => [r.field, r.value, r.author])).toEqual([["locality", "Finley NWR", "alice"]]);
  });

  it("does not replace a locality staff set while the collector's form was arriving", async () => {
    const s = await withSuggestions();
    // The form is read after the first check; staff save a locality in that gap.
    const result = await adoptLocality(s.deps, s.alice, s.linked, async () => {
      expect(await setPlace(s.deps, s.sam, s.linked, { locality: "Staff's name", reasonFor })).toEqual({ ok: true, outcome: "saved" });
      return { locality: "Finley NWR", reasonFor };
    });
    expect(result).toEqual({ ok: false, refusal: "set_by_other" });
    expect(await localityOf(s.conn, s.linked)).toBe("Staff's name");
  });

  it("writes a place the editor offers, logged under their login", async () => {
    const s = await withSuggestions();
    expect(await setPlace(s.deps, s.alice, s.other, { locality: "Finley NWR", reasonFor })).toEqual({ ok: true, outcome: "saved" });
    expect(await localityOf(s.conn, s.other)).toBe("Finley NWR");
    expect(await logged(s)).toContainEqual(["locality", "Finley NWR", "alice"]);
  });

  it("holds a sample and lifts the hold, logged under staff's login", async () => {
    const s = await withSuggestions();
    expect(await holdSample(s.deps, s.sam, s.linked, { lift: false, note: "date looks a year off" })).toEqual({ ok: true, outcome: "saved" });
    expect(await rows(s.conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${s.linked}`)).toEqual([]);
    expect(await logged(s)).toContainEqual(expect.arrayContaining(["samstaff"]));
    expect(await holdSample(s.deps, s.sam, s.linked, { lift: true, note: "" })).toEqual({ ok: true, outcome: "removed" });
    expect(await rows(s.conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${s.linked}`)).toHaveLength(1);
  });

  it("waives a blocking flag staff judged fine", async () => {
    const s = await setup();
    await s.conn.run(`UPDATE sample SET locality = 'Deschutes River SRA' WHERE entity_id = ${s.linked}`);
    expect(await rows(s.conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${s.linked}`)).toEqual([]);
    expect(await waiveFlag(s.deps, s.sam, s.linked, { rule: "locality_format", remove: false, note: "short enough" })).toEqual({ ok: true, outcome: "saved" });
    expect(await rows(s.conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${s.linked}`)).toHaveLength(1);
  });

  it("sets staff coordinates, logged under staff's login", async () => {
    const s = await withSuggestions();
    const result = await setCoordinates(s.deps, s.sam, s.linked, { ...coordinates, note: "from the field notebook" });
    expect(result).toMatchObject({ ok: true });
    expect(await rows(s.conn, `SELECT round(latitude, 1), source FROM sample_location WHERE sample_id = ${s.linked}`)).toEqual([[44.5, "staff_entry"]]);
    expect((await logged(s)).filter((c) => c[2] === "samstaff").length).toBeGreaterThan(0);
  });

  /**
   * One correction at a time for a sample (beeline-4ksk). Before, only the
   * collector's edit and the place editor took a turn of the sample's queue;
   * the rest could write between another correction's check and its write,
   * and be recorded in the history under each other's name.
   */
  describe("one at a time for a sample", () => {
    /** Hold the sample's queue, as a correction in progress does, until released. */
    const occupy = (sampleId: number) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      void onSample(sampleId, () => held);
      return release;
    };
    const overlayRows = async (s: Awaited<ReturnType<typeof withSuggestions>>) => (await readSampleOverlay(s.paths.sampleOverlayPath)).length;
    /**
     * Long enough that a correction which did not wait would have written:
     * each takes well under 100 ms here. A slower machine can only make the
     * wait too short to catch a correction that fails to queue; it cannot fail
     * a correction that queues.
     */
    const longEnoughToWrite = () => new Promise((resolve) => setTimeout(resolve, 400));
    /**
     * An input a page would pass: a function, called once the rules that do
     * not need the form have passed. `read` resolves at that moment, so a
     * test can change something then, before handing the form over with
     * `give`, and nothing depends on how long anything takes.
     */
    const form = <T,>(value: T) => {
      let called!: () => void;
      let give!: () => void;
      const read = new Promise<void>((resolve) => (called = resolve));
      const handed = new Promise<void>((resolve) => (give = resolve));
      return {
        read,
        give,
        input: async () => {
          called();
          await handed;
          return value;
        },
      };
    };

    it("every correction waits for the one in progress before it writes anything", async () => {
      const corrections: [string, (s: Awaited<ReturnType<typeof withSuggestions>>) => Promise<{ ok: boolean }>][] = [
        ["adoptLocality", (s) => adoptLocality(s.deps, s.alice, s.linked, { locality: "Finley NWR", reasonFor })],
        ["setPlace", (s) => setPlace(s.deps, s.alice, s.linked, { locality: "Finley NWR", reasonFor })],
        ["setCoordinates", (s) => setCoordinates(s.deps, s.sam, s.linked, { ...coordinates, note: "" })],
        ["holdSample", (s) => holdSample(s.deps, s.sam, s.linked, { lift: false, note: "wait" })],
        ["waiveFlag", (s) => waiveFlag(s.deps, s.sam, s.linked, { rule: "locality_format", remove: false, note: "fine" })],
      ];
      for (const [name, run] of corrections) {
        const s = await withSuggestions();
        // A waiver needs a flag to waive: a locality too long for a label.
        if (name === "waiveFlag") await s.conn.run(`UPDATE sample SET locality = 'Deschutes River SRA' WHERE entity_id = ${s.linked}`);
        const release = occupy(s.linked);
        try {
          let done = false;
          const pending = run(s).then((r) => ((done = true), r));
          await longEnoughToWrite();
          // Still waiting, and nothing of it is in the overlay or the history.
          expect(done, name).toBe(false);
          expect(await overlayRows(s), name).toBe(0);
          expect(await logged(s), name).toEqual([]);
          release();
          expect(await pending, name).toMatchObject({ ok: true });
          expect(await overlayRows(s), name).toBe(1);
        } finally {
          release();
        }
      }
    });

    it("applies corrections sent one after another, without waiting, in the order they were sent", async () => {
      // What a program does: the input is already in hand, so each takes its turn as it is called.
      for (let i = 0; i < 5; i++) {
        const s = await withSuggestions();
        const first = setPlace(s.deps, s.sam, s.linked, { locality: "First name", reasonFor });
        const second = setPlace(s.deps, s.sam, s.linked, { locality: "Second name", reasonFor });
        expect(await first).toEqual({ ok: true, outcome: "saved" });
        expect(await second).toEqual({ ok: true, outcome: "saved" });
        expect(await localityOf(s.conn, s.linked)).toBe("Second name");
      }
      // A hold and then its lifting leave the sample not held.
      const h = await withSuggestions();
      const held = holdSample(h.deps, h.sam, h.linked, { lift: false, note: "wait" });
      const lifted = holdSample(h.deps, h.sam, h.linked, { lift: true, note: "" });
      expect([await held, await lifted]).toEqual([{ ok: true, outcome: "saved" }, { ok: true, outcome: "removed" }]);
      expect(await rows(h.conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${h.linked}`)).toHaveLength(1);
      // Staff set a locality, then the collector tries to adopt one: staff's stands and the collector is refused.
      const t = await withSuggestions();
      const staff = setPlace(t.deps, t.sam, t.linked, { locality: "Staff's name", reasonFor });
      const collector = adoptLocality(t.deps, t.alice, t.linked, { locality: "Finley NWR", reasonFor });
      expect(await staff).toEqual({ ok: true, outcome: "saved" });
      expect(await collector).toEqual({ ok: false, refusal: "set_by_other" });
      expect(await localityOf(t.conn, t.linked)).toBe("Staff's name");
    });

    it("asks its rules again when its turn comes, of the sample as it then stands", async () => {
      const s = await withSuggestions();
      // A page's request: taking the observation's location passes "no sync
      // is running" before its form is read; the nightly starts while the
      // form is arriving.
      const taking = form({ note: "", defaultReason: "moved" });
      const pending = takeLocation(s.deps, s.sam, s.linked, taking.input);
      await taking.read;
      s.setRunning(true);
      taking.give();
      expect(await pending).toEqual({ ok: false, refusal: "busy" });
      s.setRunning(false);

      // A collector adopting a locality passes "nobody else set it" before
      // the form is read; staff set one while it is arriving.
      const adopting = form({ locality: "Finley NWR", reasonFor });
      const collector = adoptLocality(s.deps, s.alice, s.linked, adopting.input);
      await adopting.read;
      expect(await setPlace(s.deps, s.sam, s.linked, { locality: "Staff's name", reasonFor })).toEqual({ ok: true, outcome: "saved" });
      adopting.give();
      expect(await collector).toEqual({ ok: false, refusal: "set_by_other" });
      expect(await localityOf(s.conn, s.linked)).toBe("Staff's name");
    });

    it("credits a staff point to staff even when a check of iNaturalist ends while its elevation is being derived", async () => {
      const s = await withSuggestions();
      // "Check iNaturalist now" holds the promotion lock, which deriving the
      // moved point waits for, and ends with a pass over every sample's
      // history under no author.
      let endCheck!: () => void;
      const checking = new Promise<void>((resolve) => (endCheck = resolve));
      const check = withPromotionLock(async () => {
        await checking;
        await recordSampleChanges(duckdbReader(s.conn), s.deps.samplePaths, { source: "observation_promotion" });
      });
      const moved = setCoordinates(s.deps, s.sam, s.linked, { ...coordinates, note: "from the field notebook" });
      try {
        // The point is written and entered in the history, and the correction is
        // waiting on the lock to derive from it; then the check finishes. (Waiting
        // for the entry, not just the point: a check that ended in the instant
        // between the two could still take the point for its own, as any writer
        // that records state after the fact can.)
        await vi.waitFor(async () =>
          expect(
            (await readSampleChanges(s.paths.sampleChangesPath)).some((c) => c.author === "samstaff" && c.field.startsWith("location")),
          ).toBe(true),
        );
      } finally {
        // Whatever happened above, let go of the lock and the sample's turn, or every later test waits on them.
        endCheck();
        await check;
      }
      expect(await moved).toMatchObject({ ok: true });
      const changes = (await readSampleChanges(s.paths.sampleChangesPath)).filter((c) => c.field.startsWith("location"));
      expect(changes.length).toBeGreaterThan(0);
      // Every entry about the point is staff's; none fell to the unauthored pass.
      expect(changes.map((c) => [c.source, c.author])).toEqual(changes.map(() => ["app", "samstaff"]));
    });

    it("records two corrections made at the same moment each under its own author", async () => {
      const s = await withSuggestions();
      // A collector adopts a locality while staff hold the sample: two
      // corrections that do not touch each other's fields. (Staff moving the
      // point at the same moment would rightly withdraw the suggestion.)
      const [adopted, held] = await Promise.all([
        adoptLocality(s.deps, s.alice, s.linked, { locality: "Finley NWR", reasonFor }),
        holdSample(s.deps, s.sam, s.linked, { lift: false, note: "date looks a year off" }),
      ]);
      expect(adopted).toMatchObject({ ok: true });
      expect(held).toMatchObject({ ok: true });
      const entries = await logged(s);
      // The locality is the collector's and nobody else's; everything else is staff's and nobody else's.
      expect(entries.filter((c) => c[0] === "locality").map((c) => c[2])).toEqual(["alice"]);
      const rest = entries.filter((c) => c[0] !== "locality");
      expect(rest.length).toBeGreaterThan(0);
      expect(new Set(rest.map((c) => c[2]))).toEqual(new Set(["samstaff"]));
    });

    it("refuses a suggestion that was withdrawn while the form was arriving", async () => {
      const s = await withSuggestions();
      const withdraw = async () => {
        await s.conn.run(`DELETE FROM sample_locality_candidate WHERE sample_id = ${s.linked}`);
        return { locality: "Finley NWR", reasonFor };
      };
      expect(await adoptLocality(s.deps, s.alice, s.linked, withdraw)).toEqual({ ok: false, refusal: "changed" });
      // The place editor too: a collector may write only a name that is offered now.
      const t = await withSuggestions();
      const withdrawT = async () => {
        await t.conn.run(`DELETE FROM sample_locality_candidate WHERE sample_id = ${t.linked}`);
        return { locality: "Finley NWR", reasonFor };
      };
      expect(await setPlace(t.deps, t.alice, t.linked, withdrawT)).toEqual({ ok: false, refusal: "only_offered" });
      expect(await localityOf(t.conn, t.linked)).not.toBe("Finley NWR");
    });
  });
});

describe("setTrapCount", () => {
  const problemFor = (p: string) => `problem: ${p}`;
  const trapSample = async (s: Awaited<ReturnType<typeof setup>>, extra: Record<string, string> = {}) =>
    insertCleanSample(s.conn, {
      collector_id: "(SELECT min(entity_id) FROM person)",
      sample_number: "'T-1'",
      kind: "'trap'",
      protocol: "'vane trap'",
      sampling_effort: "'6 vane traps'",
      ...extra,
    });
  const effortOf = async (s: Awaited<ReturnType<typeof setup>>, id: number) =>
    ((await rows(s.conn, `SELECT sampling_effort FROM sample WHERE entity_id = ${id}`)) as (string | null)[][])[0]![0];

  it("sets the count with the sample's method, and records it under staff", async () => {
    const s = await setup();
    const id = await trapSample(s);
    await recordSampleChanges(duckdbReader(s.conn), s.deps.samplePaths, { source: "observation_promotion" });
    expect(await setTrapCount(s.deps, s.sam, id, { count: "1", note: "recount", problemFor })).toEqual({ ok: true, outcome: "saved", effort: "1 vane trap" });
    expect(await setTrapCount(s.deps, s.sam, id, { count: 8, note: "", problemFor })).toEqual({ ok: true, outcome: "saved", effort: "8 vane traps" });
    expect(await effortOf(s, id)).toBe("8 vane traps");
    const log = (await readSampleChanges(s.paths.sampleChangesPath)).filter((c) => c.field === "sampling_effort" && c.source !== "observation_promotion");
    expect(log.map((c) => [c.new_value, c.author, c.reason])).toEqual([
      ["1 vane trap", "samstaff", "recount"],
      ["8 vane traps", "samstaff", ""],
    ]);
  });

  it("answers unchanged for the count it already has, and clears on blank", async () => {
    const s = await setup();
    const id = await trapSample(s);
    expect(await setTrapCount(s.deps, s.sam, id, { count: "6", note: "", problemFor })).toMatchObject({ ok: true, outcome: "unchanged" });
    expect(await setTrapCount(s.deps, s.sam, id, { count: " ", note: "", problemFor })).toEqual({ ok: true, outcome: "removed", effort: null });
    expect(await effortOf(s, id)).toBeNull();
    expect(await setTrapCount(s.deps, s.sam, id, { count: "", note: "", problemFor })).toMatchObject({ outcome: "unchanged" });
  });

  it("is for staff only, never while impersonating, and not for a missing sample", async () => {
    const s = await setup();
    const id = await trapSample(s);
    expect(await setTrapCount(s.deps, s.alice, id, { count: "2", note: "", problemFor })).toEqual({ ok: false, refusal: "not_admin" });
    expect(await setTrapCount(s.deps, { ...s.sam, impersonating: true }, id, { count: "2", note: "", problemFor })).toEqual({ ok: false, refusal: "impersonating" });
    expect(await setTrapCount(s.deps, s.sam, 999999, { count: "2", note: "", problemFor })).toEqual({ ok: false, refusal: "not_found" });
    expect(await effortOf(s, id)).toBe("6 vane traps");
  });

  it("refuses a net sample, a sample with no method, and a count that is not a whole number", async () => {
    const s = await setup();
    const net = await insertCleanSample(s.conn, { sample_number: "'N-1'" });
    expect(await setTrapCount(s.deps, s.sam, net, { count: "3", note: "", problemFor })).toMatchObject({ ok: false, refusal: "invalid", problem: "problem: net" });
    const bare = await trapSample(s, { sample_number: "'T-2'", protocol: "NULL", sampling_effort: "NULL" });
    expect(await setTrapCount(s.deps, s.sam, bare, { count: "3", note: "", problemFor })).toMatchObject({ refusal: "invalid", problem: "problem: method" });
    const id = await trapSample(s, { sample_number: "'T-3'" });
    for (const bad of ["0", "-2", "2.5", "six", "1e3"]) {
      expect(await setTrapCount(s.deps, s.sam, id, { count: bad, note: "", problemFor })).toMatchObject({ refusal: "invalid" });
    }
    expect(await effortOf(s, id)).toBe("6 vane traps");
    // A blank count on a sample with nothing to clear is no change, not a refusal.
    expect(await setTrapCount(s.deps, s.sam, bare, { count: "", note: "", problemFor })).toMatchObject({ ok: true, outcome: "unchanged" });
  });

  it("takes the method's plural as written", async () => {
    const s = await setup();
    const id = await trapSample(s, { sample_number: "'T-4'", protocol: "'pan traps'", sampling_effort: "NULL" });
    expect(await setTrapCount(s.deps, s.sam, id, { count: "1", note: "", problemFor })).toMatchObject({ effort: "1 pan traps" });
  });
});

describe("setSpecimenCount", () => {
  const problemFor = (p: string, n?: number) => (n === undefined ? `problem: ${p}` : `problem: ${p} ${n}`);
  const trapSample = async (s: Awaited<ReturnType<typeof setup>>, extra: Record<string, string> = {}) =>
    insertCleanSample(s.conn, {
      collector_id: "(SELECT min(entity_id) FROM person)",
      sample_number: "'T-1'",
      kind: "'trap'",
      protocol: "'vane trap'",
      specimen_count: "3",
      ...extra,
    });
  const countOf = async (s: Awaited<ReturnType<typeof setup>>, id: number) =>
    ((await rows(s.conn, `SELECT specimen_count FROM sample WHERE entity_id = ${id}`)) as number[][])[0]![0];
  const set = (s: Awaited<ReturnType<typeof setup>>, id: number, count: string | number, note = "") =>
    setSpecimenCount(s.deps, s.sam, id, { count, note, problemFor });

  it("raises and lowers the count, and records each change under staff with the note", async () => {
    const s = await setup();
    const id = await trapSample(s);
    await recordSampleChanges(duckdbReader(s.conn), s.deps.samplePaths, { source: "observation_promotion" });
    expect(await set(s, id, "5", "found two more")).toMatchObject({ ok: true, outcome: "saved", specimen_count: 5 });
    expect(await set(s, id, 2)).toMatchObject({ ok: true, outcome: "saved", specimen_count: 2 });
    expect(await set(s, id, " 0 ")).toMatchObject({ ok: true, outcome: "saved", specimen_count: 0 });
    expect(await countOf(s, id)).toBe(0);
    const log = (await readSampleChanges(s.paths.sampleChangesPath)).filter((c) => c.field === "specimen_count" && c.source !== "observation_promotion");
    expect(log.map((c) => [c.new_value, c.author, c.reason])).toEqual([
      ["5", "samstaff", "found two more"],
      ["2", "samstaff", ""],
      ["0", "samstaff", ""],
    ]);
  });

  it("answers unchanged for the count it already has, and records nothing", async () => {
    const s = await setup();
    const id = await trapSample(s);
    await recordSampleChanges(duckdbReader(s.conn), s.deps.samplePaths, { source: "observation_promotion" });
    const before = (await readSampleChanges(s.paths.sampleChangesPath)).length;
    expect(await set(s, id, "3")).toMatchObject({ ok: true, outcome: "unchanged", specimen_count: 3 });
    expect((await readSampleChanges(s.paths.sampleChangesPath)).length).toBe(before);
  });

  it("is for staff only, never while impersonating, and not for a missing sample", async () => {
    const s = await setup();
    const id = await trapSample(s);
    const input = { count: "4", note: "", problemFor };
    expect(await setSpecimenCount(s.deps, s.alice, id, input)).toEqual({ ok: false, refusal: "not_admin" });
    expect(await setSpecimenCount(s.deps, { ...s.sam, impersonating: true }, id, input)).toEqual({ ok: false, refusal: "impersonating" });
    expect(await setSpecimenCount(s.deps, s.sam, 999999, input)).toEqual({ ok: false, refusal: "not_found" });
    expect(await countOf(s, id)).toBe(3);
  });

  it("refuses a count that is not a whole number of at most six digits", async () => {
    const s = await setup();
    const id = await trapSample(s);
    for (const bad of ["", "-1", "2.5", "six", "1e3", "1234567", "007"]) {
      expect(await set(s, id, bad)).toEqual({ ok: false, refusal: "invalid", problem: "problem: count" });
    }
    expect(await set(s, id, "999999")).toMatchObject({ ok: true, specimen_count: 999999 });
  });

  it("refuses a net sample", async () => {
    const s = await setup();
    const net = await insertCleanSample(s.conn, { sample_number: "'N-1'" });
    expect(await set(s, net, "4")).toEqual({ ok: false, refusal: "invalid", problem: "problem: net" });
    expect(await countOf(s, net)).toBe(3);
  });

  it("refuses a count below the highest numbered specimen, and allows exactly that number", async () => {
    const s = await setup();
    const id = await trapSample(s, { specimen_count: "8" });
    // A specimen row with no label is an imported one, which holds its place.
    await s.conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${id}, 1), (${id}, 5)`);
    expect(await set(s, id, "4")).toEqual({ ok: false, refusal: "invalid", problem: "problem: numbered 5" });
    expect(await countOf(s, id)).toBe(8);
    expect(await set(s, id, "5")).toMatchObject({ ok: true, outcome: "saved", specimen_count: 5, pending: 3 });
    expect(await countOf(s, id)).toBe(5);
  });

  it("reports the labels the next run would print, a settled season's included once the count is set", async () => {
    const s = await setup();
    const current = await trapSample(s);
    expect(await set(s, current, "6")).toMatchObject({ ok: true, specimen_count: 6, pending: 6 });
    const settled = await trapSample(s, { sample_number: "'T-2'", ...settledDates });
    // Setting the count is what releases a settled season's sample, so the bees print.
    expect(await set(s, settled, "6")).toMatchObject({ ok: true, specimen_count: 6, pending: 6 });
  });

  const settledDates = {
    date_start: `DATE '${SETTLED_SEASON}-07-14'`,
    date_end: `DATE '${SETTLED_SEASON}-07-14'`,
  };
  const releases = async (s: Awaited<ReturnType<typeof setup>>) =>
    rows(s.conn, `SELECT sample_id, released_by, reason FROM sample_print_release ORDER BY sample_id`);

  it("writes the release with the count, whatever the season, and credits the person who set it", async () => {
    const s = await setup();
    const settled = await trapSample(s, { sample_number: "'T-2'", ...settledDates });
    const current = await trapSample(s);
    expect(await rows(s.conn, `SELECT count(*) FROM pending_print_sample WHERE sample_id = ${settled}`)).toEqual([[0n]]);
    expect(await set(s, settled, "5", "bottle opened")).toMatchObject({ outcome: "saved", pending: 5 });
    expect(await set(s, current, "5")).toMatchObject({ outcome: "saved", pending: 5 });
    const [[sam]] = (await rows(s.conn, `SELECT person_id FROM inat_account WHERE login = 'samstaff'`)) as [[number]];
    expect(await releases(s)).toEqual([
      [settled, sam, "bottle opened"],
      [current, sam, null],
    ]);
  });

  it("releases a settled sample when staff confirm the count it already has, and says unchanged", async () => {
    const s = await setup();
    const settled = await trapSample(s, { sample_number: "'T-2'", ...settledDates });
    expect(await set(s, settled, "3")).toMatchObject({ ok: true, outcome: "unchanged", specimen_count: 3, pending: 3 });
    expect(await releases(s)).toHaveLength(1);
    // A second confirmation finds the release standing and writes no second one.
    expect(await set(s, settled, "3")).toMatchObject({ outcome: "unchanged" });
    expect(await releases(s)).toHaveLength(1);
  });

  it("writes no release for a count it refuses", async () => {
    const s = await setup();
    const settled = await trapSample(s, { sample_number: "'T-2'", ...settledDates, specimen_count: "8" });
    await s.conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${settled}, 5)`);
    expect(await set(s, settled, "4")).toMatchObject({ refusal: "invalid" });
    expect(await releases(s)).toEqual([]);
  });

  it("refuses a count that still follows its observation, and allows it once the sample is printed", async () => {
    const s = await setup();
    await s.conn.run(
      `INSERT INTO observation_field (inat_id, observed_on, user_id, user_login, sample_number_raw, specimen_count_raw)
       VALUES (445566, DATE '${SETTLED_SEASON}-07-14', 1, 'alice', 'T-9', '3')`,
    );
    const id = await trapSample(s, { sample_number: "'T-9'", inat_observation_id: "445566" });
    expect(await set(s, id, "4")).toEqual({ ok: false, refusal: "invalid", problem: "problem: follows" });
    expect(await countOf(s, id)).toBe(3);
    await s.conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${id}, 1)`);
    expect(await set(s, id, "4")).toMatchObject({ ok: true, outcome: "saved", specimen_count: 4 });
    expect(await countOf(s, id)).toBe(4);
  });

  it("refuses it too when the observation's count is not one promotion follows today", async () => {
    const s = await setup();
    // Not a candidate now, but it will be once the volunteer writes a number, and the count would follow again.
    await s.conn.run(
      `INSERT INTO observation_field (inat_id, observed_on, user_id, user_login, sample_number_raw, specimen_count_raw)
       VALUES (445567, DATE '${SETTLED_SEASON}-07-14', 1, 'alice', 'T-10', 'three')`,
    );
    const id = await trapSample(s, { sample_number: "'T-10'", inat_observation_id: "445567" });
    expect(await set(s, id, "3")).toEqual({ ok: false, refusal: "invalid", problem: "problem: follows" });
  });
});

describe("releaseLabels", () => {
  const settledDates = {
    date_start: `DATE '${SETTLED_SEASON}-07-14'`,
    date_end: `DATE '${SETTLED_SEASON}-07-14'`,
  };
  const settledSample = (s: Awaited<ReturnType<typeof setup>>, extra: Record<string, string> = {}) =>
    insertCleanSample(s.conn, { sample_number: "'S-1'", kind: "'trap'", protocol: "'vane trap'", ...settledDates, ...extra });
  const releases = async (s: Awaited<ReturnType<typeof setup>>) =>
    rows(s.conn, `SELECT sample_id, reason FROM sample_print_release ORDER BY sample_id`);
  const pending = async (s: Awaited<ReturnType<typeof setup>>, id: number) =>
    rows(s.conn, `SELECT pending_count FROM pending_print_sample WHERE sample_id = ${id}`);
  const release = (s: Awaited<ReturnType<typeof setup>>, id: number, note = "", withdraw = false) =>
    releaseLabels(s.deps, s.sam, id, { note, withdraw });

  it("is for staff only, never while impersonating, and not for a missing sample", async () => {
    const s = await setup();
    const id = await settledSample(s);
    expect(await releaseLabels(s.deps, s.alice, id, { note: "" })).toEqual({ ok: false, refusal: "not_admin" });
    expect(await releaseLabels(s.deps, { ...s.sam, impersonating: true }, id, { note: "" })).toEqual({ ok: false, refusal: "impersonating" });
    expect(await release(s, 999999)).toEqual({ ok: false, refusal: "not_found" });
    expect(await releases(s)).toEqual([]);
  });

  it("refuses a sample from an active season, which prints without one", async () => {
    const s = await setup();
    expect(await release(s, s.unlinked)).toEqual({ ok: false, refusal: "not_settled" });
    expect(await releases(s)).toEqual([]);
  });

  it("refuses to release a sample whose count still follows its observation, until a label is on paper", async () => {
    const s = await setup();
    const id = await settledSample(s, { sample_number: "'S-9'", inat_observation_id: "556677" });
    expect(await release(s, id)).toEqual({ ok: false, refusal: "count_follows_observation" });
    expect(await releases(s)).toEqual([]);
    // Withdrawing is never refused for this reason.
    expect(await release(s, id, "", true)).toMatchObject({ outcome: "unchanged" });
    // Once a label is on paper the count no longer follows, and the release is allowed.
    await s.conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${id}, 1)`);
    expect(await release(s, id)).toMatchObject({ ok: true, outcome: "saved" });
  });

  it("releases a settled sample, and answers unchanged the second time", async () => {
    const s = await setup();
    const id = await settledSample(s);
    expect(await pending(s, id)).toEqual([]);
    expect(await release(s, id, "bottle is unlabelled")).toEqual({ ok: true, outcome: "saved", pending: 3, labels_in_run: 0 });
    expect(await releases(s)).toEqual([[id, "bottle is unlabelled"]]);
    expect(await pending(s, id)).toEqual([[3]]);
    expect(await release(s, id, "again")).toMatchObject({ ok: true, outcome: "unchanged", pending: 3 });
    expect(await releases(s)).toEqual([[id, "bottle is unlabelled"]]);
  });

  it("withdraws a release, answers unchanged when there is none, and allows it for an active season", async () => {
    const s = await setup();
    const id = await settledSample(s);
    expect(await release(s, id, "", true)).toMatchObject({ ok: true, outcome: "unchanged", pending: 0 });
    await release(s, id);
    expect(await release(s, id, "", true)).toEqual({ ok: true, outcome: "removed", pending: 0, labels_in_run: 0 });
    expect(await releases(s)).toEqual([]);
    expect(await pending(s, id)).toEqual([]);
    // Withdrawing is allowed whatever the season: it only changes what is pending.
    await s.conn.run(`INSERT INTO sample_print_release (sample_id) VALUES (${s.unlinked})`);
    expect(await release(s, s.unlinked, "", true)).toMatchObject({ outcome: "removed" });
  });

  it("says how many labels a withdrawn release leaves in a run that has not printed, and leaves them there", async () => {
    const s = await setup();
    const id = await settledSample(s);
    await release(s, id);
    await prepareRun(s.conn, { atlasId: null, personId: s.sam.personId, now: new Date("2026-09-21T16:00:00Z") });
    const held = () =>
      rows(s.conn, `SELECT count(*) FROM printed_label pl JOIN specimen sp ON sp.entity_id = pl.specimen_id WHERE sp.sample_id = ${id}`);
    expect(await held()).toEqual([[3n]]);
    expect(await release(s, id, "", true)).toMatchObject({ ok: true, outcome: "removed", pending: 0, labels_in_run: 3 });
    // The run still holds them: a withdrawal changes what is pending, not what was frozen.
    expect(await held()).toEqual([[3n]]);
  });
});
