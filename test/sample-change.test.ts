import { beforeEach, describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDb, insertCleanSample, currentSeasonDate, rows } from "./helpers.js";
import { duckdbReader } from "../src/person-change.js";
import {
  foldSampleChanges,
  parseSampleChanges,
  readSampleChanges,
  readSnapshot,
  recordSampleChanges,
  sampleHistory,
  type SampleLogPaths,
} from "../src/sample-change.js";

let conn: DuckDBConnection;
let paths: SampleLogPaths;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
  const dir = await mkdtemp(join(tmpdir(), "sample-change-"));
  paths = { log: join(dir, "sample-change.csv"), state: join(dir, "sample-state.csv") };
});

const read = () => duckdbReader(conn);
const record = (opts: Parameters<typeof recordSampleChanges>[2] = { source: "reconcile" }) =>
  recordSampleChanges(read(), paths, opts);

describe("the baseline lives in the snapshot, not the log", () => {
  it("first pass writes the whole corpus as a snapshot and records nothing", async () => {
    await insertCleanSample(conn);
    const result = await record();
    expect(result).toMatchObject({ appended: 0, baselined: true });
    expect(await readSampleChanges(paths.log)).toEqual([]);
    const snapshot = await readSnapshot(paths.state);
    expect(snapshot?.size).toBe(1);
    const [state] = [...snapshot!.values()];
    expect(state).toMatchObject({
      collector: "name:Ada Collector",
      sample_number: "1",
      date_start: currentSeasonDate(7, 14),
    });
    expect(state!.fields.locality).toBe("Corvallis");
  });

  it("a second pass appends nothing — idempotence is what covers a forgetful writer", async () => {
    await insertCleanSample(conn);
    await record();
    const again = await record();
    expect(again).toMatchObject({ appended: 0, baselined: false, contested: 0 });
  });

  it("a rebuilt store that derives the same state records nothing against the old snapshot", async () => {
    // The reseed case: the control experiment for beeline-6e9 showed
    // derivation is deterministic, so the snapshot carries across a rebuild
    // and the pass after it is silent.
    const id = await insertCleanSample(conn);
    await record();
    // Simulate the rebuild by re-running against the same (identical) store.
    void id;
    expect((await record()).appended).toBe(0);
  });
});

describe("what a pass records", () => {
  it("a changed field is one entry, old and new, attributed to the pass", async () => {
    const id = await insertCleanSample(conn);
    await record();
    await conn.run(`UPDATE sample SET locality = 'Alsea' WHERE entity_id = ${id}`);
    const result = await record({ source: "observation_promotion", at: "2026-08-30T12:00:00Z" });
    expect(result.appended).toBe(1);
    const [entry] = await readSampleChanges(paths.log);
    expect(entry).toMatchObject({
      collector: "name:Ada Collector",
      sample_number: "1",
      date_start: currentSeasonDate(7, 14),
      field: "locality",
      old_value: "Corvallis",
      new_value: "Alsea",
      author: "",
      source: "observation_promotion",
    });
    // And the snapshot moved with it, so the next pass is silent.
    expect((await record()).appended).toBe(0);
  });

  it("a sample arriving after the baseline records its non-empty fields", async () => {
    await insertCleanSample(conn);
    await record();
    await insertCleanSample(conn, { sample_number: "'2'" }, null);
    const result = await record();
    const entries = await readSampleChanges(paths.log);
    // Every entry an arrival: nothing → value, under the new triple.
    expect(result.appended).toBe(entries.length);
    expect(entries.every((e) => e.old_value === "" && e.sample_number === "2")).toBe(true);
    expect(entries.map((e) => e.field)).toContain("locality");
    // Empty fields are not "set to nothing".
    expect(entries.map((e) => e.field)).not.toContain("observation");
  });

  it("a coordinate move is one location entry, not three", async () => {
    const id = await insertCleanSample(conn);
    await record();
    await conn.run(
      `UPDATE sample_location SET latitude = 44.9, longitude = -123.9, elevation_m = NULL,
              elevation_source_id = NULL, elevation_latitude = NULL, elevation_longitude = NULL
        WHERE sample_id = ${id}`,
    );
    await record();
    const entries = await readSampleChanges(paths.log);
    expect(entries.map((e) => e.field)).toEqual(["location"]);
    expect(entries[0]!.old_value).toBe("44.5646,-123.262 ±30 m");
    expect(entries[0]!.new_value).toBe("44.9,-123.9 ±30 m");
  });

  it("a sample whose collector no reference names is counted, not guessed at", async () => {
    // A namesake with no account makes Ada's name ambiguous and neither holds
    // an account, so their samples cannot be referenced.
    await insertCleanSample(conn);
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    const result = await record();
    expect(result).toMatchObject({ baselined: true, unreferenceable: 1 });
  });
});

describe("a corrected reference moves, and the history follows", () => {
  it("a renumbered linked sample is recognised by its observation and not restarted", async () => {
    const id = await insertCleanSample(conn, { inat_observation_id: "77" });
    await record();
    await conn.run(`UPDATE sample SET locality = 'Alsea' WHERE entity_id = ${id}`);
    await conn.run(`UPDATE sample SET sample_number = '9' WHERE entity_id = ${id}`);
    const result = await record({ source: "reconcile", at: "2026-08-30T12:00:00Z" });
    expect(result).toMatchObject({ appended: 2, contested: 0 });

    const entries = await readSampleChanges(paths.log);
    // The mover is filed under the OLD triple; everything before it too.
    expect(entries.map((e) => [e.field, e.sample_number])).toEqual([
      ["locality", "1"],
      ["sample_number", "1"],
    ]);
    // The page asks with the sample's CURRENT reference and gets the whole story.
    const history = sampleHistory(entries, {
      collector: "name:Ada Collector",
      sample_number: "9",
      date_start: currentSeasonDate(7, 14),
    });
    expect(history.map((e) => e.field)).toEqual(["locality", "sample_number"]);
    // Nothing answers to the old triple any more.
    expect(
      sampleHistory(entries, { collector: "name:Ada Collector", sample_number: "1", date_start: currentSeasonDate(7, 14) }),
    ).toEqual([]);
  });

  it("two movers in one pass chain: each is filed under the triple as moved so far", async () => {
    const id = await insertCleanSample(conn, { inat_observation_id: "77" });
    await record();
    await conn.run(`UPDATE sample SET sample_number = '9', date_start = DATE '${currentSeasonDate(7, 20)}',
                           date_end = DATE '${currentSeasonDate(7, 20)}' WHERE entity_id = ${id}`);
    await record();
    const entries = await readSampleChanges(paths.log);
    const bySample = Object.fromEntries(entries.map((e) => [e.field, [e.sample_number, e.date_start]]));
    // sample_number filed under the pre-pass triple; date_start under the
    // triple sample_number has already moved it to.
    expect(bySample.sample_number).toEqual(["1", currentSeasonDate(7, 14)]);
    expect(bySample.date_start).toEqual(["9", currentSeasonDate(7, 14)]);
    const history = sampleHistory(entries, {
      collector: "name:Ada Collector",
      sample_number: "9",
      date_start: currentSeasonDate(7, 20),
    });
    expect(history.map((e) => e.field).sort()).toEqual(["date_end", "date_start", "sample_number"]);
  });

  it("a renumbered UNLINKED sample restarts: the evidence to follow it is not there", async () => {
    const id = await insertCleanSample(conn, {}, null);
    await record();
    await conn.run(`UPDATE sample SET sample_number = '9' WHERE entity_id = ${id}`);
    const result = await record();
    // Recorded as an arrival under the new triple; the old history stops.
    expect(result.contested).toBe(0);
    const entries = await readSampleChanges(paths.log);
    expect(entries.every((e) => e.old_value === "" && e.sample_number === "9")).toBe(true);
  });

  it("two samples colliding on one reference are recorded as nothing, and counted", async () => {
    // A is renumbered onto the triple B already holds — a live
    // duplicate_sample_number. One reference now names two samples, and
    // recording either under it would hand one the other's history.
    const a = await insertCleanSample(conn, { inat_observation_id: "77" });
    await insertCleanSample(conn, { sample_number: "'2'", inat_observation_id: "88" }, null);
    await record();
    await conn.run(`UPDATE sample SET sample_number = '2' WHERE entity_id = ${a}`);
    const result = await record();
    expect(result).toMatchObject({ appended: 0, colliding: 2 });
    expect(await readSampleChanges(paths.log)).toEqual([]);
  });

  it("a resolved collision reconnects to its history instead of arriving again", async () => {
    // The snapshot carries the rows of samples a pass cannot speak for
    // (CodeRabbit on PR #32): without that, resolving the duplicate would
    // record every field of both samples as a spurious arrival, permanently.
    const a = await insertCleanSample(conn, { inat_observation_id: "77" });
    await insertCleanSample(conn, { sample_number: "'2'", inat_observation_id: "88" }, null);
    await record();
    await conn.run(`UPDATE sample SET sample_number = '2' WHERE entity_id = ${a}`);
    await record(); // collision: nothing recorded, rows carried
    await conn.run(`UPDATE sample SET sample_number = '1' WHERE entity_id = ${a}`);
    const resolved = await record();
    // A is back on its own triple, B never left hers: the pass has nothing
    // to say, because nothing (net of the collision) changed.
    expect(resolved).toMatchObject({ appended: 0, colliding: 0, contested: 0 });
    // And a REAL change after the resolution records as exactly one entry.
    await conn.run(`UPDATE sample SET locality = 'Alsea' WHERE entity_id = ${a}`);
    expect((await record()).appended).toBe(1);
  });

  it("concurrent passes over one snapshot are serialized, not interleaved", async () => {
    const id = await insertCleanSample(conn);
    await record();
    await conn.run(`UPDATE sample SET locality = 'Alsea' WHERE entity_id = ${id}`);
    // Fired together: without the queue, both read the pre-change snapshot
    // and both append the same difference to an append-only file.
    const [first, second] = await Promise.all([record(), record()]);
    expect(first.appended + second.appended).toBe(1);
    expect(await readSampleChanges(paths.log)).toHaveLength(1);
  });

  it("the fold never moves a history onto a triple it already knows a sample by", () => {
    // Synthetic on purpose: a recording pass refuses to create this shape
    // (the collision test above), so the guard is exercised directly — it
    // protects the reader against a log written by anything else.
    const entry = (sample_number: string, field: string, old_value: string, new_value: string) => ({
      at: "2026-08-30T12:00:00Z",
      collector: "name:Ada Collector",
      sample_number,
      date_start: currentSeasonDate(7, 14),
      field,
      old_value,
      new_value,
      author: "",
      source: "reconcile",
      reason: "",
    });
    const entries = [
      entry("1", "locality", "", "Corvallis"),
      entry("2", "locality", "", "Adair"),
      // A hand-written move of sample 1 onto sample 2's triple.
      entry("1", "sample_number", "1", "2"),
    ] as never[];
    const folded = foldSampleChanges(entries);
    // Sample 2's history is untouched, and sample 1's stays under its own key.
    const sizes = [...folded.values()].map((v) => (v as unknown[]).length).sort();
    expect(folded.size).toBe(2);
    expect(sizes).toEqual([1, 2]);
  });

  it("two claimants on one history record nothing, and are counted — every pass, not once", async () => {
    // The snapshot row is reachable directly by one sample and via its
    // observation by another: iteration order must not pick the heir.
    const a = await insertCleanSample(conn, { inat_observation_id: "77" });
    await record();
    // A loses its link; a new sample takes the observation over.
    await conn.run(`UPDATE sample SET inat_observation_id = NULL WHERE entity_id = ${a}`);
    await insertCleanSample(conn, { sample_number: "'5'", inat_observation_id: "77" }, null);
    const result = await record();
    expect(result.contested).toBe(2);
    expect(result.appended).toBe(0);
    // The restatement must not write the claimants' current state into the
    // snapshot: that buries the contest — the next pass direct-matches the
    // fresh rows, counts nothing, and the transition is never recorded by
    // any pass (adversarial review of PR #32). The contest stands until a
    // human resolves it, like the person log's.
    const again = await record();
    expect(again.contested).toBe(2);
    expect(again.appended).toBe(0);
  });

  // The sandbox's shape since 2026-10-04: two observations numbered 1 were one
  // sample until promotion split them, and the volunteer had renumbered one to
  // 2. Sample 2 holds the observation the log recorded; sample 1 holds the
  // other. Both claimed the log's row, so the pair was contested on every pass
  // and neither was recorded again. The store lists them in no stated order,
  // and the newcomer filed ahead of the move would be carried into the
  // renumbered sample's history, so both orders are run.
  it.each([
    ["the store's order", false],
    ["the reverse", true],
  ])("a renumbered sample and a newcomer on its old number are told apart by the link (%s)", async (_, reverse) => {
    const a = await insertCleanSample(conn, { inat_observation_id: "77" });
    await record();
    await conn.run(`UPDATE sample SET sample_number = '2' WHERE entity_id = ${a}`);
    await insertCleanSample(conn, { inat_observation_id: "88", locality: "'Alsea'" }, null);
    const reader = read();
    const ordered: typeof reader = async (sql) => {
      const rows = await reader(sql);
      return reverse ? rows.reverse() : rows;
    };
    const result = await recordSampleChanges(ordered, paths, { source: "reconcile" });
    expect(result.contested).toBe(0);

    const entries = await readSampleChanges(paths.log);
    const at = (sample_number: string) =>
      sampleHistory(entries, { collector: "name:Ada Collector", sample_number, date_start: currentSeasonDate(7, 14) });
    // Sample 2 is the sample the log knew, renumbered; nothing else happened to it.
    expect(at("2").map((e) => [e.field, e.old_value, e.new_value])).toEqual([["sample_number", "1", "2"]]);
    // Sample 1 is a newcomer, and only the newcomer.
    const newcomer = at("1");
    expect(newcomer.find((e) => e.field === "observation")?.new_value).toBe("88");
    expect(newcomer.find((e) => e.field === "locality")?.new_value).toBe("Alsea");
    expect(newcomer.every((e) => e.old_value === "")).toBe(true);

    expect(await record()).toMatchObject({ appended: 0, contested: 0 });
  });

  it("a narrowed pass on the newcomer defers rather than overwrite the renumbered sample's row", async () => {
    const a = await insertCleanSample(conn, { inat_observation_id: "77" });
    await record();
    await conn.run(`UPDATE sample SET sample_number = '2' WHERE entity_id = ${a}`);
    const b = await insertCleanSample(conn, { inat_observation_id: "88" }, null);
    // One sample in view, so it cannot see that another holds observation 77.
    const narrowed = await record({ source: "app", author: "ada", where: `s.entity_id = ${b}` });
    expect(narrowed.appended).toBe(0);
    expect([...(await readSnapshot(paths.state))!.values()].map((s) => s.fields.observation)).toEqual(["77"]);
    // The full pass then tells them apart.
    const full = await record();
    expect(full.contested).toBe(0);
    const entries = await readSampleChanges(paths.log);
    expect(
      sampleHistory(entries, { collector: "name:Ada Collector", sample_number: "2", date_start: currentSeasonDate(7, 14) }).map(
        (e) => e.field,
      ),
    ).toEqual(["sample_number"]);
  });

  it("a narrowed pass records nothing for a sample renumbered onto a triple another sample holds", async () => {
    // Ada's samples 1 and 2 on one day. Staff renumber 2 to 1, which the
    // store allows and flags as a duplicate. The edit screen's one-sample
    // pass cannot see sample 1 beside it, so it matched the edited sample
    // directly to sample 1's row and recorded the edit as changes to sample
    // 1's history — then restated that row with the other sample's state,
    // so the pass after the duplicate is resolved reports sample 1 changing
    // back to what it always was. A duplicate is recorded as nothing.
    const one = await insertCleanSample(conn, { locality: "'Corvallis'" });
    const two = await insertCleanSample(conn, { sample_number: "'2'", locality: "'Alsea'" }, null);
    await record();
    await conn.run(`UPDATE sample SET sample_number = '1' WHERE entity_id = ${two}`);
    const narrowed = await record({ source: "app", author: "ada", where: `s.entity_id = ${two}` });
    expect(narrowed.appended).toBe(0);
    expect(narrowed.colliding).toBeGreaterThan(0);
    const row = (await readSnapshot(paths.state))!.get(
      `name:Ada Collector\u001f1\u001f${currentSeasonDate(7, 14)}`,
    );
    expect(row?.fields.locality).toBe("Corvallis");
    // Resolving the duplicate leaves sample 1's history as it was.
    await conn.run(`UPDATE sample SET sample_number = '2' WHERE entity_id = ${two}`);
    expect(await record()).toMatchObject({ appended: 0, colliding: 0 });
    void one;
  });

  const inOrder = (reverse: boolean) => {
    const reader = read();
    return (async (sql: string) => {
      const rows = await reader(sql);
      return reverse ? rows.reverse() : rows;
    }) as typeof reader;
  };
  const historyOf = async (sample_number: string) =>
    sampleHistory(await readSampleChanges(paths.log), {
      collector: "name:Ada Collector",
      sample_number,
      date_start: currentSeasonDate(7, 14),
    });

  it.each([
    ["the store's order", false],
    ["the reverse", true],
  ])("a chain of renumbers keeps each history its own (%s)", async (_, reverse) => {
    // 1 becomes 2 while 2 becomes 3. Recorded 1→2 first, the fold would carry
    // sample 1's history onto 2 and then on to 3 with sample 2's (CodeRabbit).
    const a = await insertCleanSample(conn, { inat_observation_id: "77", locality: "'Alsea'" });
    const b = await insertCleanSample(conn, { sample_number: "'2'", inat_observation_id: "88" }, null);
    await record();
    await conn.run(`UPDATE sample SET sample_number = '3' WHERE entity_id = ${b}`);
    await conn.run(`UPDATE sample SET sample_number = '2' WHERE entity_id = ${a}`);
    const result = await recordSampleChanges(inOrder(reverse), paths, { source: "reconcile" });
    expect(result).toMatchObject({ appended: 2, contested: 0 });
    expect((await historyOf("2")).map((e) => [e.old_value, e.new_value])).toEqual([["1", "2"]]);
    expect((await historyOf("3")).map((e) => [e.old_value, e.new_value])).toEqual([["2", "3"]]);
  });

  it.each([
    ["the store's order", false],
    ["the reverse", true],
  ])("two linked samples that swap numbers fall back to their triples rather than merge (%s)", async (_, reverse) => {
    // The log cannot record a swap: whichever move is written first lands on
    // the triple the other still holds. So the pass does what it did before
    // the link outranked the triple, and reads each triple as relinked.
    const a = await insertCleanSample(conn, { inat_observation_id: "77" }, null);
    const b = await insertCleanSample(conn, { sample_number: "'2'", inat_observation_id: "88" }, null);
    await record();
    await conn.run(`UPDATE sample SET sample_number = '0' WHERE entity_id = ${a}`);
    await conn.run(`UPDATE sample SET sample_number = '1' WHERE entity_id = ${b}`);
    await conn.run(`UPDATE sample SET sample_number = '2' WHERE entity_id = ${a}`);
    const result = await recordSampleChanges(inOrder(reverse), paths, { source: "reconcile" });
    expect(result.contested).toBe(0);
    expect((await historyOf("1")).map((e) => [e.field, e.old_value, e.new_value])).toEqual([["observation", "77", "88"]]);
    expect((await historyOf("2")).map((e) => [e.field, e.old_value, e.new_value])).toEqual([["observation", "88", "77"]]);
  });

  it("a displacement whose heir took another row falls back to the triple", async () => {
    // Sample 2, unlinked, takes observation 77 and keeps its own row; sample 1
    // takes another observation. Nobody inherits sample 1's row through the
    // link, so the triple keeps it rather than a newcomer starting on top of
    // a history that is then left to nobody.
    const a = await insertCleanSample(conn, { inat_observation_id: "77" }, null);
    const b = await insertCleanSample(conn, { sample_number: "'2'" }, null);
    await record();
    await conn.run(`UPDATE sample SET inat_observation_id = 88 WHERE entity_id = ${a}`);
    await conn.run(`UPDATE sample SET inat_observation_id = 77 WHERE entity_id = ${b}`);
    expect(await record()).toMatchObject({ appended: 2, contested: 0 });
    expect((await historyOf("1")).map((e) => [e.field, e.old_value, e.new_value])).toEqual([["observation", "77", "88"]]);
    expect((await historyOf("2")).map((e) => [e.field, e.old_value, e.new_value])).toEqual([["observation", "", "77"]]);
  });

  it("a newcomer is held, not handed the row, while the renumbered sample sits on a shared number", async () => {
    // Found by Fable's review of PR #157. The renumbered sample lands on a
    // number its collector already used that day, so the pass cannot speak
    // for it; its observation still says the newcomer is not the row's sample.
    const s2 = await insertCleanSample(conn, { inat_observation_id: "77", locality: "'Old history'" }, null);
    const s3 = await insertCleanSample(conn, { sample_number: "'2'", inat_observation_id: "99" }, null);
    await record();
    await conn.run(`UPDATE sample SET sample_number = '2' WHERE entity_id = ${s2}`);
    await insertCleanSample(conn, { inat_observation_id: "88", locality: "'Alsea'" }, null);
    const held = await record();
    expect(held).toMatchObject({ appended: 0, colliding: 2, contested: 1 });
    expect([...(await readSnapshot(paths.state))!.values()].map((s) => s.fields.observation).sort()).toEqual(["77", "99"]);

    // The duplicate is resolved, and each sample is recognised.
    await conn.run(`UPDATE sample SET sample_number = '3' WHERE entity_id = ${s3}`);
    expect(await record()).toMatchObject({ colliding: 0, contested: 0 });
    expect((await historyOf("2")).map((e) => [e.field, e.old_value, e.new_value])).toEqual([["sample_number", "1", "2"]]);
    expect((await historyOf("3")).map((e) => [e.field, e.old_value, e.new_value])).toEqual([["sample_number", "2", "3"]]);
    const newcomer = await historyOf("1");
    expect(newcomer.find((e) => e.field === "observation")?.new_value).toBe("88");
    expect(newcomer.every((e) => e.old_value === "")).toBe(true);
  });

  it("a newcomer is held, not handed the row, while the renumbered sample's own claim is contested", async () => {
    // Also from Fable's review: the renumbered sample is contested on its new
    // number, so it may yet be the row's sample, and the newcomer must not
    // take the row in the meantime.
    const s2 = await insertCleanSample(conn, { inat_observation_id: "77", locality: "'Old history'" }, null);
    const c = await insertCleanSample(conn, { sample_number: "'2'", inat_observation_id: "99" }, null);
    await record();
    await conn.run(`UPDATE sample SET sample_number = '3' WHERE entity_id = ${c}`);
    await insertCleanSample(conn, { sample_number: "'4'", inat_observation_id: "99" }, null);
    await conn.run(`UPDATE sample SET sample_number = '2' WHERE entity_id = ${s2}`);
    await insertCleanSample(conn, { inat_observation_id: "88", locality: "'Alsea'" }, null);
    await record();
    expect(await historyOf("1")).toEqual([]);
    expect([...(await readSnapshot(paths.state))!.values()].some((s) => s.fields.observation === "77")).toBe(true);
  });

  it("a snapshot whose header this code did not write re-baselines instead of appending a million arrivals", async () => {
    await insertCleanSample(conn);
    await record();
    // A future field addition changes STATE_COLUMNS; simulate by rewriting
    // the header. Every row is then the wrong width, and an
    // empty-but-non-null read would record the whole corpus as arrivals in
    // an append-only file.
    const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
    const text = await rf(paths.state, "utf8");
    await wf(paths.state, text.replace(/^[^\n]+/, "a,b,c"));
    const result = await record();
    expect(result).toMatchObject({ appended: 0, baselined: true });
    expect(await readSampleChanges(paths.log)).toEqual([]);
  });

  it("a steady pass leaves the snapshot file untouched", async () => {
    await insertCleanSample(conn);
    await record();
    const { stat } = await import("node:fs/promises");
    const before = await stat(paths.state);
    await new Promise((r) => setTimeout(r, 10));
    await record();
    const after = await stat(paths.state);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe("the authored, narrowed pass", () => {
  it("matches on the reference alone: a moved triple defers to the next full pass", async () => {
    // The weak tiers' guards are built from the whole store; a one-sample
    // pass has an empty holder index and can never see a second claimant, so
    // granting them here could file this sample's entries under a live
    // sibling's history and delete its snapshot row (adversarial review of
    // PR #32).
    const id = await insertCleanSample(conn, { inat_observation_id: "77" });
    await record();
    await conn.run(`UPDATE sample SET sample_number = '9', locality = 'Alsea' WHERE entity_id = ${id}`);
    const narrowed = await record({ source: "app", author: "ada", where: `s.entity_id = ${id}` });
    // Direct miss (the triple moved): nothing recorded, nothing deleted.
    expect(narrowed.appended).toBe(0);
    expect((await readSnapshot(paths.state))?.size).toBe(1);
    // The full pass follows the observation link and records both changes.
    const full = await record();
    expect(full.appended).toBe(2);
    const history = sampleHistory(await readSampleChanges(paths.log), {
      collector: "name:Ada Collector",
      sample_number: "9",
      date_start: currentSeasonDate(7, 14),
    });
    expect(history.map((e) => e.field).sort()).toEqual(["locality", "sample_number"]);
  });


  it("credits the author with their edit and nothing else", async () => {
    const edited = await insertCleanSample(conn);
    const other = await insertCleanSample(conn, { sample_number: "'2'" }, null);
    await record();
    // Both samples change; only the edit is the author's.
    await conn.run(`UPDATE sample SET locality = 'Alsea' WHERE entity_id = ${edited}`);
    await conn.run(`UPDATE sample SET locality = 'Adair' WHERE entity_id = ${other}`);
    await record({ source: "app", author: "ada", reason: "typo", where: `s.entity_id = ${edited}` });

    let entries = await readSampleChanges(paths.log);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ field: "locality", new_value: "Alsea", author: "ada", reason: "typo" });

    // The other sample's change is still owed — the snapshot was patched, not
    // restated — and the next full pass records it, attributed to itself.
    const swept = await record({ source: "reconcile" });
    expect(swept.appended).toBe(1);
    entries = await readSampleChanges(paths.log);
    expect(entries[1]).toMatchObject({ field: "locality", new_value: "Adair", author: "" });
  });
});

/**
 * The snapshot carries each sample's id, and a pass over the store that
 * wrote it finds a sample's row by that id (beeline-7r0g, ADR 0007's
 * addendum of 2026-11-13). Every test above runs on a store with no
 * identity, where ids are never believed, so they pin the pass as it was
 * before ids. These give the store one.
 */
describe("a snapshot that carries ids, read by the store that wrote it", () => {
  const ada = "name:Ada Collector";
  const day = currentSeasonDate(7, 14);
  const unlinked = (number: string, more: Record<string, string> = {}) =>
    insertCleanSample(conn, { sample_number: `'${number}'`, ...more }, null);
  const numbers = async () => [...(await readSnapshot(paths.state))!.values()].map((s) => s.sample_number).sort();
  const historyOf = async (number: string, date = day) =>
    sampleHistory(await readSampleChanges(paths.log), { collector: ada, sample_number: number, date_start: date }).map(
      (e) => [e.field, e.old_value, e.new_value, e.author],
    );
  const renumber = (id: number, to: string) => conn.run(`UPDATE sample SET sample_number = '${to}' WHERE entity_id = ${id}`);
  const narrowed = (id: number, more: Partial<Parameters<typeof recordSampleChanges>[2]> = {}) =>
    record({ source: "app", author: "ada", where: `s.entity_id = ${id}`, ...more });

  beforeEach(async () => {
    // What `pnpm db:build` does to a store it makes: the instant recorded
    // here is the store's identity (STORE_ORIGIN_SQL).
    await conn.run("INSERT INTO schema_migration (name) VALUES ('0001-a-store-that-was-built.sql')");
  });

  it("a renumbered sample with no observation keeps its history, in a full pass", async () => {
    const id = await unlinked("1");
    await record();
    await conn.run(`UPDATE sample SET locality = 'Alsea' WHERE entity_id = ${id}`);
    await record();
    await renumber(id, "9");
    expect((await record()).appended).toBe(1);
    // Newest first: the renumbering, then what was recorded under the old number.
    expect(await historyOf("9")).toEqual([
      ["sample_number", "1", "9", ""],
      ["locality", "Corvallis", "Alsea", ""],
    ]);
    expect(await numbers()).toEqual(["9"]);
    expect((await record()).appended).toBe(0);
  });

  it("and in a one-sample pass, where the renumbering is its author's", async () => {
    const id = await unlinked("1");
    await record();
    await conn.run(`UPDATE sample SET sample_number = '9', sampling_effort = '8 vane traps' WHERE entity_id = ${id}`);
    expect((await narrowed(id)).appended).toBe(2);
    expect(await historyOf("9")).toEqual([
      ["sampling_effort", "", "8 vane traps", "ada"],
      ["sample_number", "1", "9", "ada"],
    ]);
    expect(await numbers()).toEqual(["9"]);
    expect((await record()).appended).toBe(0);
  });

  it("a new start date and a new number in one save are filed as a full pass files them", async () => {
    const id = await unlinked("1");
    await record();
    const moved = currentSeasonDate(7, 10);
    await conn.run(`UPDATE sample SET sample_number = '9', date_start = DATE '${moved}' WHERE entity_id = ${id}`);
    await narrowed(id);
    const entries = await readSampleChanges(paths.log);
    expect(entries.map((e) => [e.sample_number, e.date_start, e.field, e.new_value])).toEqual([
      ["1", day, "sample_number", "9"],
      ["9", day, "date_start", moved],
    ]);
    expect((await record()).appended).toBe(0);
  });

  it("a sample the caller just made arrives under its author; without the caller's word it waits", async () => {
    await unlinked("1");
    await record();
    const id = await unlinked("2");
    expect((await narrowed(id)).appended).toBe(0);
    const made = await narrowed(id, { created: true });
    expect(made.appended).toBeGreaterThan(0);
    const entries = await readSampleChanges(paths.log);
    expect(entries.every((e) => e.author === "ada" && e.old_value === "" && e.sample_number === "2")).toBe(true);
    expect(await numbers()).toEqual(["1", "2"]);
    expect((await record()).appended).toBe(0);
  });

  it("a sample a full pass entered before its maker's pass ran keeps the file's ids", async () => {
    // The nightly was waiting its turn, read the store after the sample was
    // written, and entered it under nobody's name. The maker's pass then
    // finds a row with the new sample's id under its own reference, which is
    // no sign of another store.
    const other = await unlinked("1");
    await record();
    const made = await unlinked("2");
    expect((await record()).appended).toBeGreaterThan(0);
    expect((await narrowed(made, { created: true })).appended).toBe(0);
    const ids = [...(await readSnapshot(paths.state))!.values()].map((r) => r.id).sort();
    expect(ids).toEqual([String(other), String(made)].sort());
    // So a renumbering after it is still followed.
    await renumber(other, "9");
    expect((await narrowed(other)).appended).toBe(1);
  });

  it("a snapshot from before ids gains them on the next pass, with nothing lost and nothing invented", async () => {
    const id = await unlinked("1");
    await unlinked("2");
    await record();
    // The file as the release before this one wrote it: no first line, no id column.
    const withoutIds = (await readFile(paths.state, "utf8"))
      .split("\n")
      .slice(1)
      .map((line) => line.slice(line.indexOf(",") + 1))
      .join("\n");
    await writeFile(paths.state, withoutIds);
    await conn.run(`UPDATE sample SET locality = 'Alsea' WHERE entity_id = ${id}`);
    const first = await record();
    expect(first).toMatchObject({ appended: 1, baselined: false });
    const rows = [...(await readSnapshot(paths.state))!.values()];
    expect(rows.map((r) => r.id).sort()).toEqual([String(id), String(id + 1)].sort());
    // So the renumbering after it is followed.
    await renumber(id, "9");
    expect((await narrowed(id)).appended).toBe(1);
    expect((await historyOf("9")).map((e) => e[0])).toEqual(["sample_number", "locality"]);
  });

  it("gains them on a pass with nothing to record, too", async () => {
    // The pass after the deploy is usually a quiet one, and a quiet pass
    // leaves the file alone. Left without ids, the first trap sample
    // renumbered afterwards would be entered as a second sample arriving.
    const id = await unlinked("1");
    await record();
    const withoutIds = (await readFile(paths.state, "utf8"))
      .split("\n")
      .slice(1)
      .map((line) => line.slice(line.indexOf(",") + 1))
      .join("\n");
    await writeFile(paths.state, withoutIds);
    expect((await record()).appended).toBe(0);
    expect([...(await readSnapshot(paths.state))!.values()].map((r) => r.id)).toEqual([String(id)]);
  });

  describe("when the snapshot is out of step with the store", () => {
    // The three sequences CodeRabbit found in the first attempt at this,
    // which told the pass the reference a sample used to have. Each begins
    // with a move that was made and never recorded.

    it("a move onto a number another sample has left, unrecorded: nothing until the full pass, then both in order", async () => {
      const a = await unlinked("1", { locality: "'Alsea'" });
      const b = await unlinked("2", { locality: "'Adair'" });
      await record();
      await renumber(b, "3");
      await renumber(a, "2");
      expect((await narrowed(a)).appended).toBe(0);
      expect(await numbers()).toEqual(["1", "2"]);
      // B's move first, so the reader can move A's history onto 2 after it.
      expect((await record()).appended).toBe(2);
      expect(await historyOf("3")).toEqual([["sample_number", "2", "3", ""]]);
      expect(await historyOf("2")).toEqual([["sample_number", "1", "2", ""]]);
      expect(await numbers()).toEqual(["2", "3"]);
    });

    it("a sample entered on such a number is not compared with the row still there", async () => {
      const b = await unlinked("1");
      await record();
      await renumber(b, "3");
      const made = await unlinked("1", { locality: "'Alsea'" });
      expect((await narrowed(made, { created: true })).appended).toBe(0);
      expect(await numbers()).toEqual(["1"]);
      await record();
      expect(await historyOf("3")).toEqual([["sample_number", "1", "3", ""]]);
      // The newcomer arrives; nothing says its locality changed from B's.
      expect((await historyOf("1")).every((e) => e[1] === "")).toBe(true);
    });

    it("a second move after one that waited takes the sample's own row, not the one it stood on", async () => {
      const a = await unlinked("1", { locality: "'Alsea'" });
      const b = await unlinked("2", { locality: "'Adair'" });
      await record();
      await renumber(b, "3");
      await renumber(a, "2");
      expect((await narrowed(a)).appended).toBe(0);
      await renumber(a, "4");
      expect((await narrowed(a)).appended).toBe(1);
      expect(await historyOf("4")).toEqual([["sample_number", "1", "4", "ada"]]);
      // B's row is still B's, for the full pass to move.
      expect(await numbers()).toEqual(["2", "4"]);
      expect((await record()).appended).toBe(1);
      expect(await historyOf("3")).toEqual([["sample_number", "2", "3", ""]]);
    });
  });

  it("two samples that swap numbers are compared by reference, since the log cannot say a swap", async () => {
    const a = await unlinked("1", { locality: "'Alsea'" });
    const b = await unlinked("2", { locality: "'Adair'" });
    await record();
    await renumber(a, "x");
    await renumber(b, "1");
    await renumber(a, "2");
    await record();
    const entries = await readSampleChanges(paths.log);
    expect(entries.map((e) => [e.sample_number, e.field, e.old_value, e.new_value]).sort()).toEqual([
      ["1", "locality", "Alsea", "Adair"],
      ["2", "locality", "Adair", "Alsea"],
    ]);
    // Each row now carries the id of the sample on its number.
    const rows = [...(await readSnapshot(paths.state))!.values()];
    expect(rows.map((r) => [r.sample_number, r.id]).sort()).toEqual([
      ["1", String(b)],
      ["2", String(a)],
    ]);
    expect((await record()).appended).toBe(0);
  });

  it("a sample standing on the number of a row that stays is held until the row moves", async () => {
    // T1's row is under 5 and T1 itself has gone to 6, which T2 holds, so
    // the pass can record neither and both rows stay. T3, entered on 5, must
    // not be entered in the log there: the log still reads 5 as T1, and
    // would carry T3's arrival off with T1 when T1's move is recorded.
    const t1 = await unlinked("5");
    const t2 = await unlinked("6");
    await record();
    await renumber(t1, "6");
    const t3 = await unlinked("5", { locality: "'Alsea'" });
    expect((await narrowed(t3, { created: true })).appended).toBe(0);
    const held = await record();
    expect(held).toMatchObject({ appended: 0, contested: 1 });
    expect(await numbers()).toEqual(["5", "6"]);
    // The duplicate is resolved: every move is recorded, and then T3 arrives.
    await renumber(t2, "7");
    await record();
    expect(await historyOf("7")).toEqual([["sample_number", "6", "7", ""]]);
    expect(await historyOf("6")).toEqual([["sample_number", "5", "6", ""]]);
    const arrived = await historyOf("5");
    expect(arrived.length).toBeGreaterThan(0);
    expect(arrived.every((e) => e[1] === "")).toBe(true);
    expect(await numbers()).toEqual(["5", "6", "7"]);
    expect((await record()).appended).toBe(0);
  });

  describe("a number and a start date corrected in one save", () => {
    // Recorded as two moves, and the reference between them is one the
    // sample never had. Net sample numbers restart every day, so "really
    // sample 1 of the next day" passes through sample 1 of this one.
    const next = currentSeasonDate(7, 15);
    const setUp = async () => {
      const one = await unlinked("1", { locality: "'Alsea'" });
      const four = await unlinked("4", { locality: "'Adair'" });
      await record();
      await conn.run(`UPDATE sample SET locality = 'Philomath' WHERE entity_id = ${one}`);
      await conn.run(`UPDATE sample SET locality = 'Monroe' WHERE entity_id = ${four}`);
      await record();
      return { one, four };
    };
    const correct = (id: number) =>
      conn.run(`UPDATE sample SET sample_number = '1', date_start = DATE '${next}', date_end = DATE '${next}' WHERE entity_id = ${id}`);

    for (const pass of ["full", "one-sample"] as const) {
      it(`is filed date first where the number first would pass through another sample (${pass} pass)`, async () => {
        const { four } = await setUp();
        await correct(four);
        if (pass === "full") await record();
        else await narrowed(four);
        // The other sample keeps its history, and the corrected one its own.
        expect(await historyOf("1")).toEqual([["locality", "Alsea", "Philomath", ""]]);
        expect((await historyOf("1", next)).map((e) => [e[0], e[2]]).sort()).toEqual([
          ["date_end", next],
          ["date_start", next],
          ["locality", "Monroe"],
          ["sample_number", "1"],
        ]);
        // The date first, under the old number; then the number, under the new date.
        const moves = (await readSampleChanges(paths.log)).filter((e) => e.field === "date_start" || e.field === "sample_number");
        expect(moves.map((e) => [e.sample_number, e.date_start, e.field])).toEqual([
          ["4", day, "date_start"],
          ["4", next, "sample_number"],
        ]);
        expect((await record()).appended).toBe(0);
      });
    }

    it("is held where either order passes through another sample", async () => {
      const { four } = await setUp();
      await unlinked("4", { date_start: `DATE '${next}'`, date_end: `DATE '${next}'` });
      await record();
      const before = (await readSampleChanges(paths.log)).length;
      await correct(four);
      expect((await narrowed(four)).appended).toBe(0);
      expect(await record()).toMatchObject({ appended: 0, contested: 1 });
      expect((await readSampleChanges(paths.log)).length).toBe(before);
    });
  });

  it("a swap between a sample followed by its id and one followed by its observation is compared by reference too", async () => {
    const a = await unlinked("1", { locality: "'Alsea'" });
    const b = await unlinked("2", { locality: "'Adair'", inat_observation_id: "77" });
    await record();
    // B's row as a pass leaves it when it could not record B: without an id.
    const text = await readFile(paths.state, "utf8");
    expect(text).toContain(`\n${b},`);
    await writeFile(paths.state, text.replace(`\n${b},`, "\n,"));
    await renumber(a, "x");
    await renumber(b, "1");
    await renumber(a, "2");
    await record();
    const entries = await readSampleChanges(paths.log);
    expect(entries.map((e) => e.field)).not.toContain("sample_number");
    expect(entries.filter((e) => e.field === "locality").map((e) => [e.sample_number, e.old_value, e.new_value]).sort()).toEqual([
      ["1", "Alsea", "Adair"],
      ["2", "Adair", "Alsea"],
    ]);
    expect((await record()).appended).toBe(0);
  });

  it("a renamed collector's samples are followed by id, in a one-sample pass and in the full pass after it", async () => {
    const edited = await unlinked("1");
    await unlinked("2");
    await record();
    await conn.run("UPDATE person SET display_name = 'Ada Lovelace' WHERE display_name = 'Ada Collector'");
    await conn.run(`UPDATE sample SET locality = 'Alsea' WHERE entity_id = ${edited}`);
    // Whoever edits one of her samples before the nightly is entered as the
    // author of its collector change as well (ADR 0007's addendum).
    expect((await narrowed(edited)).appended).toBe(2);
    expect((await record()).appended).toBe(1);
    const entries = await readSampleChanges(paths.log);
    expect(entries.map((e) => [e.sample_number, e.field, e.new_value, e.author])).toEqual([
      ["1", "locality", "Alsea", "ada"],
      ["1", "collector", "name:Ada Lovelace", "ada"],
      ["2", "collector", "name:Ada Lovelace", ""],
    ]);
    const history = sampleHistory(entries, { collector: "name:Ada Lovelace", sample_number: "1", date_start: day });
    expect(history.map((e) => e.field)).toEqual(["locality", "collector"]);
    expect((await record()).appended).toBe(0);
  });

  describe("ids that are not this store's are not believed", () => {
    it("a sample just made whose id the snapshot gives to another is entered as arriving, not as that one renumbered", async () => {
      // A store put back to an earlier copy whose ids have caught up with
      // the snapshot's, where the pass the app makes as it starts failed.
      const gone = await unlinked("7");
      await record();
      const made = await unlinked("50");
      const text = await readFile(paths.state, "utf8");
      await writeFile(paths.state, text.replace(`\n${gone},`, `\n${made},`));
      expect((await narrowed(made, { created: true })).appended).toBeGreaterThan(0);
      const entries = await readSampleChanges(paths.log);
      expect(entries.every((e) => e.old_value === "" && e.sample_number === "50" && e.author === "ada")).toBe(true);
    });

    it("a one-sample pass adds no ids of its own, and the full pass after it writes this store's", async () => {
      const id = await unlinked("1");
      await record();
      const first = (await readFile(paths.state, "utf8")).split("\n")[0];
      await conn.run("UPDATE schema_migration SET applied_at = applied_at + INTERVAL 1 DAY");
      await conn.run(`UPDATE sample SET locality = 'Alsea' WHERE entity_id = ${id}`);
      expect((await narrowed(id)).appended).toBe(1);
      // The first line still names the store that wrote the file, and no row has an id.
      expect((await readFile(paths.state, "utf8")).split("\n")[0]).toBe(first);
      expect([...(await readSnapshot(paths.state))!.values()].map((r) => r.id)).toEqual([""]);
      expect((await record()).appended).toBe(0);
      expect((await readFile(paths.state, "utf8")).split("\n")[0]).not.toBe(first);
      expect([...(await readSnapshot(paths.state))!.values()].map((r) => r.id)).toEqual([String(id)]);
    });

    // Two samples that stay put beside the one that moves: a snapshot that
    // mostly names samples the store does not hold is refused whole, and a
    // refused pass would leave these tests nothing to look at.
    const sampleAmongOthers = async () => {
      const id = await unlinked("1");
      await unlinked("2");
      await unlinked("3");
      return id;
    };
    const restarts = async (id: number) => {
      await renumber(id, "9");
      expect((await record()).refused).toBeNull();
      // As before ids: an arrival under the new number, the old history stopped.
      const history = await historyOf("9");
      expect(history.length).toBeGreaterThan(0);
      expect(history.every((e) => e[1] === "")).toBe(true);
    };

    it("a store built at another time, whose ids may be the same numbers", async () => {
      const id = await sampleAmongOthers();
      await record();
      await conn.run("UPDATE schema_migration SET applied_at = applied_at + INTERVAL 1 DAY");
      await restarts(id);
    });

    it("a store put back to an earlier copy, which will draw the snapshot's later ids again", async () => {
      const id = await sampleAmongOthers();
      await record();
      // The snapshot was written when the store held a sample with a higher id.
      const text = await readFile(paths.state, "utf8");
      const [origin, ...rest] = text.split("\n");
      const [mark, identity] = origin!.split(",");
      await writeFile(paths.state, [`${mark},${identity},${id + 1000}`, ...rest].join("\n"));
      await restarts(id);
      // That pass wrote the file as this store's, so the next move is followed.
      expect((await readFile(paths.state, "utf8")).split("\n")[0]).toBe(`${mark},${identity},${id + 2}`);
      await renumber(id, "10");
      expect((await record()).appended).toBe(1);
      expect((await historyOf("10"))[0]).toEqual(["sample_number", "9", "10", ""]);
    });

    it("a store with no identity at all", async () => {
      await conn.run("DELETE FROM schema_migration");
      const id = await sampleAmongOthers();
      await record();
      await restarts(id);
    });
  });
});

describe("the file", () => {
  it("is read leniently: a malformed row costs itself, not the page", async () => {
    const text = [
      "at,collector,sample_number,date_start,field,old_value,new_value,author,source,reason",
      "2026-08-30T12:00:00Z,name:Ada Collector,1,2026-07-14,locality,,Corvallis,,reconcile,",
      "not,enough,cells",
      "2026-08-30T12:00:00Z,name:Ada Collector,1,2026-07-14,not_a_field,,x,,reconcile,",
    ].join("\n");
    const { changes, malformed } = parseSampleChanges(text);
    expect(changes).toHaveLength(1);
    expect(malformed).toBe(2);
  });

  it("reads, through its cache, exactly what a fresh parse of the file says, whoever appended", async () => {
    const fresh = async () => parseSampleChanges(await readFile(paths.log, "utf8")).changes;
    const id = await insertCleanSample(conn);
    await record();
    await conn.run(`UPDATE sample SET locality = 'Adair' WHERE entity_id = ${id}`);
    await record();
    await readSampleChanges(paths.log); // the cache now holds the file

    // This process's own append extends the cache.
    await conn.run(`UPDATE sample SET locality = 'Alsea' WHERE entity_id = ${id}`);
    await record();
    expect(await readSampleChanges(paths.log)).toEqual(await fresh());
    expect((await readSampleChanges(paths.log)).map((c) => c.new_value)).toEqual(["Adair", "Alsea"]);

    // Somebody else's append, and an unterminated last line, are read from the file.
    await appendFile(paths.log, "2026-08-30T12:00:00Z,name:Ada Collector,1,2026-07-14,locality,Alsea,Blodgett,,reconcile,");
    expect(await readSampleChanges(paths.log)).toEqual(await fresh());
    await conn.run(`UPDATE sample SET locality = 'Burnt Woods' WHERE entity_id = ${id}`);
    await record();
    expect(await readSampleChanges(paths.log)).toEqual(await fresh());
    expect((await readSampleChanges(paths.log)).map((c) => c.new_value)).toEqual(["Adair", "Alsea", "Blodgett", "Burnt Woods"]);

    // A write cut off inside a quoted value: the next append continues that
    // value as far as a full parse is concerned, so the cache must say so too.
    await appendFile(paths.log, '\n2026-08-30T12:00:00Z,name:Ada Collector,1,2026-07-14,locality,Burnt Woods,Alsea,,reconcile,"cut off');
    await readSampleChanges(paths.log);
    await conn.run(`UPDATE sample SET locality = 'Blodgett' WHERE entity_id = ${id}`);
    await record();
    expect(await readSampleChanges(paths.log)).toEqual(await fresh());
  });

  it("drops its cache rather than extend a record cut off after a line break inside a quoted value", async () => {
    const id = await insertCleanSample(conn);
    await record();
    await conn.run(`UPDATE sample SET locality = 'Adair' WHERE entity_id = ${id}`);
    await record();
    await appendFile(paths.log, '2026-08-30T12:00:00Z,name:Ada Collector,1,2026-07-14,locality,Adair,Alsea,,reconcile,"first line\n');
    await readSampleChanges(paths.log);
    await conn.run(`UPDATE sample SET locality = 'Blodgett' WHERE entity_id = ${id}`);
    await record();
    expect(await readSampleChanges(paths.log)).toEqual(parseSampleChanges(await readFile(paths.log, "utf8")).changes);
  });

  it("round-trips values that carry commas and quotes", async () => {
    const id = await insertCleanSample(conn);
    await record();
    await conn.run(`UPDATE sample SET locality = 'Alsea, "the bend"' WHERE entity_id = ${id}`);
    await record();
    const entries = await readSampleChanges(paths.log);
    expect(entries[0]!.new_value).toBe('Alsea, "the bend"');
    // And the snapshot, which restates rather than appends.
    const snapshot = await readSnapshot(paths.state);
    expect([...snapshot!.values()][0]!.fields.locality).toBe('Alsea, "the bend"');
  });

  it("the log carries coordinates and their source the way the page reads them", async () => {
    await insertCleanSample(conn);
    await record();
    const raw = await readFile(paths.state, "utf8");
    // The first line says which store wrote the file; the header follows it.
    expect(raw.split("\n")[1]).toContain("sample_id,collector,sample_number,date_start");
    expect(raw).toContain("±30 m");
  });
});

describe("a number-and-date coincidence is not an identity", () => {
  it("a live collector's row cannot be claimed by somebody else's matching pair", async () => {
    // Ada's unlinked sample and Bo's unlinked sample; Ada renumbers hers so
    // her old row sits unclaimed, and Bo renumbers HIS onto that exact
    // (number, date) pair in the same pass. The pair is unique in the
    // snapshot — but Ada still collects here, so her row is not Bo's to
    // inherit (the person log's liveness gate, ported; CodeRabbit on PR #33).
    await conn.run("INSERT INTO person (display_name) VALUES ('Bo Collector')");
    const bo = "(SELECT entity_id FROM person WHERE display_name = 'Bo Collector')";
    const ada = await insertCleanSample(conn, { sample_number: "'7'" }, null);
    const his = await insertCleanSample(conn, { sample_number: "'8'", collector_id: bo }, null);
    await record();
    await conn.run(`UPDATE sample SET sample_number = '9' WHERE entity_id = ${ada}`);
    await conn.run(`UPDATE sample SET sample_number = '7' WHERE entity_id = ${his}`);
    await record();
    const entries = await readSampleChanges(paths.log);
    // Nothing of Ada's history was handed to Bo: every entry under her
    // collector ref stays hers, and Bo's renumber is recognised (or arrives)
    // under his own.
    expect(entries.some((e) => e.collector === "name:Ada Collector" && e.author === "" &&
                               e.field === "sample_number" && e.new_value === "7")).toBe(false);
  });

  it("a row whose link a colliding sample still holds cannot be claimed by a matching pair either", async () => {
    // Ada's sample 3 is linked to observation 77. Bo has two samples both
    // numbered 3 on the same day, a live duplicate the pass records as
    // nothing. One of Bo's is corrected to Ada, so it now collides with
    // hers instead and the other stands alone on Bo's number. That one
    // reaches Ada's row by number and date. Ada is still here and still
    // holds 77 — but on a shared triple, so the pass could not list her
    // among the live collectors or the observation holders, and handed her
    // row to Bo's sample: "unlinked from 77, collector Ada -> Bo", about a
    // sample that never carried 77.
    await conn.run("INSERT INTO person (display_name) VALUES ('Bo Collector')");
    const bo = "(SELECT entity_id FROM person WHERE display_name = 'Bo Collector')";
    const ada = "(SELECT entity_id FROM person WHERE display_name = 'Ada Collector')";
    await insertCleanSample(conn, { sample_number: "'3'", inat_observation_id: "77" }, null);
    const moved = await insertCleanSample(conn, { sample_number: "'3'", collector_id: bo }, null);
    await insertCleanSample(conn, { sample_number: "'3'", collector_id: bo }, null);
    expect(await record()).toMatchObject({ baselined: true, colliding: 2 });

    await conn.run(`UPDATE sample_collector SET person_id = ${ada} WHERE sample_id = ${moved}`);
    const pass = await record();
    expect(pass.colliding).toBe(2);

    const entries = await readSampleChanges(paths.log);
    expect(entries.filter((e) => e.collector === "name:Ada Collector")).toEqual([]);
    expect(entries.filter((e) => e.field === "observation" && e.old_value === "77")).toEqual([]);
    expect((await record()).appended).toBe(0);
  });
});

describe("what the pass deliberately does not say", () => {
  it("a vanished sample records nothing — its history simply stops", async () => {
    const id = await insertCleanSample(conn);
    await insertCleanSample(conn, { sample_number: "'2'" }, null);
    await record();
    await conn.run(`DELETE FROM sample_collector WHERE sample_id = ${id}`);
    await conn.run(`DELETE FROM sample_location WHERE sample_id = ${id}`);
    await conn.run(`DELETE FROM sample WHERE entity_id = ${id}`);
    const result = await record();
    expect(result.appended).toBe(0);
    // And the snapshot dropped the row, so a lookalike arriving later is an
    // arrival, not a resurrection.
    const snapshot = await readSnapshot(paths.state);
    expect(snapshot?.size).toBe(1);
    void rows;
  });
});

describe("a snapshot another store wrote", () => {
  const replaceCorpus = async (numbers: string[]) => {
    for (const t of ["sample_atlas", "sample_location", "sample_collector", "sample"]) await conn.run(`DELETE FROM ${t}`);
    for (const n of numbers) await insertCleanSample(conn, { sample_number: `'${n}'` });
  };

  it("is refused whole when it mostly names samples this store does not hold: nothing appended, nothing restated", async () => {
    // beeline-hrw: the screenshot fixture — a scratch store with thirty
    // samples — booted against the shared data/ paths and restated the
    // snapshot with its own samples. The real store's next pass then found
    // a row for nothing it held, and the vanishing rule plus the arrival
    // rule made that 1,085,665 entries in a file that cannot be un-appended.
    await replaceCorpus(["1", "2", "3"]);
    await record();
    const { readFile: rf, unlink } = await import("node:fs/promises");
    const before = await rf(paths.state, "utf8");
    await replaceCorpus(["9"]);
    const result = await record({ source: "observation_promotion" });
    expect(result).toMatchObject({ appended: 0, baselined: false });
    expect(result.refused).toMatch(/3 of its 3 rows/);
    expect(await rf(paths.state, "utf8")).toBe(before);
    expect(await readSampleChanges(paths.log)).toEqual([]);
    // The way back is the one the message names: delete the snapshot, and
    // the next pass is the baseline — after which recording resumes.
    await unlink(paths.state);
    expect(await record()).toMatchObject({ appended: 0, baselined: true, refused: null });
    await conn.run("UPDATE sample SET locality = 'Albany'");
    expect(await record()).toMatchObject({ appended: 1, refused: null });
  });

  it("in the other direction too: the scratch store's own pass leaves the real snapshot standing", async () => {
    // Refusing rather than re-baselining is what makes the mistake free:
    // had the fixture's boot been allowed to restate, the real snapshot
    // would already be gone by the time the real pass could notice.
    await replaceCorpus(["1", "2", "3", "4", "5"]);
    await record();
    const { readFile: rf } = await import("node:fs/promises");
    const real = await rf(paths.state, "utf8");
    await replaceCorpus(["8"]);
    const result = await record();
    expect(result.refused).toMatch(/5 of its 5 rows/);
    expect(await rf(paths.state, "utf8")).toBe(real);
    // The real store returns and finds its own snapshot: a steady pass.
    await replaceCorpus(["1", "2", "3", "4", "5"]);
    expect(await record()).toMatchObject({ appended: 0, refused: null });
  });

  it("a snapshot with no rows is no snapshot: the corpus arriving is the baseline, not a million events", async () => {
    // The app booted on a freshly built store before anything was promoted.
    expect(await record()).toMatchObject({ appended: 0, baselined: true });
    await insertCleanSample(conn);
    expect(await record()).toMatchObject({ appended: 0, baselined: true, refused: null });
    expect((await readSnapshot(paths.state))?.size).toBe(1);
  });
});
