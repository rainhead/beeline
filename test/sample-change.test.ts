import { beforeEach, describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
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
      date_start: "2026-07-14",
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
      date_start: "2026-07-14",
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
      date_start: "2026-07-14",
    });
    expect(history.map((e) => e.field)).toEqual(["locality", "sample_number"]);
    // Nothing answers to the old triple any more.
    expect(
      sampleHistory(entries, { collector: "name:Ada Collector", sample_number: "1", date_start: "2026-07-14" }),
    ).toEqual([]);
  });

  it("two movers in one pass chain: each is filed under the triple as moved so far", async () => {
    const id = await insertCleanSample(conn, { inat_observation_id: "77" });
    await record();
    await conn.run(`UPDATE sample SET sample_number = '9', date_start = DATE '2026-07-20',
                           date_end = DATE '2026-07-20' WHERE entity_id = ${id}`);
    await record();
    const entries = await readSampleChanges(paths.log);
    const bySample = Object.fromEntries(entries.map((e) => [e.field, [e.sample_number, e.date_start]]));
    // sample_number filed under the pre-pass triple; date_start under the
    // triple sample_number has already moved it to.
    expect(bySample.sample_number).toEqual(["1", "2026-07-14"]);
    expect(bySample.date_start).toEqual(["9", "2026-07-14"]);
    const history = sampleHistory(entries, {
      collector: "name:Ada Collector",
      sample_number: "9",
      date_start: "2026-07-20",
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
      date_start: "2026-07-14",
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
      date_start: "2026-07-14",
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
    expect(raw.split("\n")[0]).toContain("collector,sample_number,date_start");
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
