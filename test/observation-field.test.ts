import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { canonicalJson, syncINat } from "../src/sync-inat.js";
import { refreshObservationFields } from "../src/refresh-observation-fields.js";
import { promoteObservations } from "../src/promote-observations.js";
import { schemaDrift } from "../src/migrate.js";

/**
 * The stored observation projection (beeline-2c3.36).
 *
 * `observation_field` is the one place in this schema where a view's output
 * is kept, so the whole of its correctness is that a refresh ran. These
 * tests are about that and nothing else: that every path which can put loads
 * into a store also shreds them, that the alarm for the case where one does
 * not actually fires, and that the rules reading the table say what they
 * said when they read the view.
 */

let conn: DuckDBConnection;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  // insertCleanSample hangs its collector on the first person in the store.
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
});

/** An observation shaped like the ones sync stores, with the fields the rules read. */
function obs(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    observed_on: "2026-07-14",
    geojson: { coordinates: [-123.262, 44.5646], type: "Point" },
    positional_accuracy: 30,
    geoprivacy: null,
    taxon_geoprivacy: null,
    user: { id: 100, login: "adacollects" },
    // ancestor_ids is self-inclusive; 211194 = Tracheophyta.
    taxon: { id: 51048, name: "Salvia officinalis", ancestor_ids: [211194, 51048] },
    ofvs: [
      { name: "sampleId", value: "1" },
      { name: "numberOfSpecimens", value: "3" },
    ],
    ...extra,
  };
}

/** Stage a load the way sync would, but without the refresh sync does. */
async function stageLoad(o: Record<string, unknown>, hash = `hash-${o.id}`): Promise<void> {
  await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
  await conn.run(
    `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
     VALUES ($1, (SELECT max(entity_id) FROM sync_run), $2, $3)`,
    [Number(o.id), canonicalJson(o), hash] as never,
  );
}

const count = async (sql: string) => Number(((await rows(conn, sql))[0] ?? [0])[0]);

describe("the stored projection", () => {
  test("says exactly what shredding the loads says", async () => {
    await stageLoad(obs(7));
    await refreshObservationFields(conn);
    // Not a spot-check of a column or two: the whole relation, both ways,
    // which is the only claim worth making about a materialisation.
    expect(await count("SELECT count(*) FROM observation_field_stale")).toBe(0);
    expect(await rows(conn, "SELECT inat_id, host_is_tracheophyte, specimen_count_raw FROM observation_field")).toEqual([
      [7n, true, "3"],
    ]);
  });

  test("a sync refreshes it in its own transaction, so loads and shred never disagree", async () => {
    const api = (async () =>
      new Response(JSON.stringify({ results: [obs(11)] }), { status: 200 })) as typeof fetch;
    await syncINat(conn, { projectId: 99706, perPage: 2, pageDelayMs: 0, token: "test-jwt", fetchImpl: api });
    expect(await count("SELECT count(*) FROM observation_field")).toBe(1);
    expect(await count("SELECT count(*) FROM observation_field_stale")).toBe(0);
  });

  test("promotion refreshes before it reads, which is what a reseeded store relies on", async () => {
    // db:reseed carries observation_load across into a fresh schema and tells
    // you to promote; nothing has shredded anything yet. Reading an empty
    // table here would link no samples and report that as a number.
    const sampleId = await insertCleanSample(conn, { inat_observation_id: "21", sample_number: "'1'" });
    await stageLoad(obs(21));
    expect(await count("SELECT count(*) FROM observation_field")).toBe(0);

    const counts = await promoteObservations(conn);
    expect(counts.linkedSamples).toBe(1);
    expect(await count("SELECT count(*) FROM observation_field")).toBe(1);
    expect(await count(`SELECT count(*) FROM sample_location WHERE sample_id = ${sampleId}`)).toBe(1);
  });

  test("the alarm fires when loads move and nothing shreds them", async () => {
    await stageLoad(obs(7));
    await refreshObservationFields(conn);
    // A newer load for the same observation: the current-load view moves, the
    // table does not. This is the failure the view exists to name — a writer
    // that forgot, which is a state every new write path can create.
    await stageLoad(obs(7, { ofvs: [{ name: "numberOfSpecimens", value: "99" }] }), "hash-7b");
    expect(await rows(conn, "SELECT inat_id FROM observation_field_stale")).toEqual([[7n]]);
    await refreshObservationFields(conn);
    expect(await count("SELECT count(*) FROM observation_field_stale")).toBe(0);
  });

  test("an observation that goes away leaves no row behind", async () => {
    await stageLoad(obs(7));
    await stageLoad(obs(8));
    await refreshObservationFields(conn);
    expect(await count("SELECT count(*) FROM observation_field")).toBe(2);
    // Whole-table, not incremental: rows disappear as well as change.
    await conn.run("DELETE FROM observation_load WHERE inat_id = 8");
    await refreshObservationFields(conn);
    expect(await rows(conn, "SELECT inat_id FROM observation_field")).toEqual([[7n]]);
    expect(await count("SELECT count(*) FROM observation_field_stale")).toBe(0);
  });
});

describe("the rules that read it", () => {
  test("still find the host and count problems they found through the view", async () => {
    // A moss, not a vascular plant — ancestor_ids without 211194.
    const mossy = await insertCleanSample(conn, { inat_observation_id: "31", sample_number: "'1'", specimen_count: "3" });
    await stageLoad(
      obs(31, { taxon: { id: 55555, name: "Hypnum", ancestor_ids: [311249, 55555] }, ofvs: [{ name: "numberOfSpecimens", value: "3" }] }),
    );
    // A count the observation disagrees with.
    const miscounted = await insertCleanSample(conn, {
      inat_observation_id: "32",
      sample_number: "'2'",
      specimen_count: "3",
    });
    await stageLoad(obs(32, { ofvs: [{ name: "numberOfSpecimens", value: "9" }] }));
    await refreshObservationFields(conn);

    const findings = await rows(conn, `SELECT sample_id, rule_name FROM qc_finding ORDER BY sample_id, rule_name`);
    expect(findings).toContainEqual([mossy, "non_tracheophyte_host"]);
    expect(findings).toContainEqual([miscounted, "count_mismatch"]);
  });

  test("go quiet when the projection is empty, which is why nothing reads it unrefreshed", async () => {
    // Stated as a test rather than left implied: an unrefreshed table is not
    // a visibly broken one — the rules simply report nothing and printability
    // calls the sample clean. That is the whole reason for the alarm above
    // and for promotion refreshing at its head.
    await insertCleanSample(conn, { inat_observation_id: "41", sample_number: "'1'", specimen_count: "3" });
    await stageLoad(obs(41, { taxon: { id: 55555, name: "Hypnum", ancestor_ids: [311249, 55555] } }));
    expect(await count("SELECT count(*) FROM qc_rule_non_tracheophyte_host")).toBe(0);
    expect(await count("SELECT count(*) FROM observation_field_stale")).toBe(1);
  });
});

describe("the migration for deployed stores", () => {
  /**
   * This block used to walk the head of the migration chain: unwind a
   * current store to before the newest migration, apply it, and expect no
   * drift — "the newest delta has to stand on its own" (its comment, from
   * 0017 through 0022, is in git history).
   *
   * beeline-6e9 ended the walk's premise. Rebuilding `sample` — collector_id
   * and atlas_id off the table, sample_atlas and sample_primary_collector in
   * — is ADR 0006's "not migratable at all" case: DuckDB cannot drop a
   * column on a table five others reference, so there is no 0024 to walk,
   * and the deployed store catches up by `pnpm db:reseed` instead.
   * Migrations 0001–0023 remain correct for the epoch they served and are
   * now unwalkable from this schema: 0021 recreates views that read
   * sample.collector_id, which a store built from schema/*.sql no longer
   * has. No store will walk them again — a fresh build stamps them, a
   * reseeded store is built from the schema and stamps them too.
   *
   * What is left to pin is the half the operator relies on: a store shaped
   * before the reseed epoch must be REPORTED as drifted, because
   * `db:migrate --check` saying "a migration or a reseed may be needed" is
   * the only thing standing between the sandbox and running new code on an
   * old shape.
   */
  test("a pre-reseed store is reported as drifted, naming the sample rework", async () => {
    const { conn: old } = await createMemoryDb();
    // The pre-6e9 shape, in miniature: the satellite and the head view are
    // missing, and sample carries the dropped columns. ADD COLUMN suffices
    // to simulate — the drift check compares shapes, not data.
    await old.run("DROP VIEW sample_primary_collector_invalid");
    await old.run("DROP VIEW sample_primary_collector");
    await old.run("ALTER TABLE sample ADD COLUMN collector_id INTEGER");
    const drift = await schemaDrift(old);
    expect(drift).toContain("missing: sample_primary_collector");
    expect(drift).toContain("missing: sample_primary_collector_invalid");
    expect(drift).toContain("not in the schema: sample.collector_id");
  });
});
