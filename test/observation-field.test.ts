import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { canonicalJson, syncINat } from "../src/sync-inat.js";
import { refreshObservationFields } from "../src/refresh-observation-fields.js";
import { promoteObservations } from "../src/promote-observations.js";
import { baseline, MIGRATIONS_DIR, schemaDrift } from "../src/migrate.js";

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
  test("brings a store built from the previous schema up to this one, filled", async () => {
    // The sandbox cannot be rebuilt (ADR 0006), so the delta has to stand on
    // its own: apply it to a store that predates the table and there must be
    // no drift left, and no empty window where the rules read nothing.
    // The pre-state is a store that predates the change: no table, no alarm
    // view, and the eight views still written against observation_current_
    // fields. DuckDB resolves a view's body lazily, so dropping the table out
    // from under them leaves exactly the catalog a pre-migration store has —
    // and leaves the migration's own DROPs something to drop.
    const { conn: old } = await createMemoryDb();
    await old.run("DROP VIEW observation_field_stale");
    await old.run("DROP TABLE observation_field");
    await baseline(old);
    expect(await schemaDrift(old)).toEqual(["missing: observation_field", "missing: observation_field_stale"]);

    await old.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('t', true, now())");
    await old.run(
      `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
       VALUES (7, (SELECT max(entity_id) FROM sync_run), $1, 'h7')`,
      [canonicalJson(obs(7))] as never,
    );

    const sql = await readFile(join(MIGRATIONS_DIR, "0017-store-the-observation-projection.sql"), "utf8");
    await old.run(sql);

    expect(await schemaDrift(old)).toEqual([]);
    // Filled by the migration itself: an empty table would have left the
    // three rules silently reporting nothing until the next promotion.
    const filled = await (await old.run("SELECT inat_id, specimen_count_raw FROM observation_field")).getRows();
    expect(filled).toEqual([[7n, "3"]]);
    const stale = await (await old.run("SELECT count(*) FROM observation_field_stale")).getRows();
    expect(Number(stale[0]![0])).toBe(0);
  });
});
