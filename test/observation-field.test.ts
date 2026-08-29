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
  /**
   * The sandbox cannot be rebuilt (ADR 0006), so the newest delta has to stand
   * on its own: apply it to a store built from the schema *without* that
   * change and there must be no drift left, and no empty window where the
   * rules read nothing.
   *
   * This used to pin 0017, the migration that created observation_field, and
   * it simulated the pre-state by dropping the table and its alarm view out
   * from under a current store. That stopped being an accurate simulation the
   * moment beeline-2yt gave observation_current_fields a twenty-first column:
   * a real pre-0017 store carries the pre-0017 *view* as well, and no amount
   * of dropping tables from a current one reproduces that. Rather than
   * maintain a fiction, the test follows the head of the chain — which is
   * where the risk actually is, since that is the migration nothing has run
   * yet.
   *
   * So it moves. It pinned 0020; the head is now 0021 (beeline-oyq), and the
   * unwind below is correspondingly longer because that migration adds a
   * twenty-second column, a file's worth of views, and a rewrite of
   * qc_rule_locality_format. Whoever adds 0022 moves it again — which is the
   * cost of the doctrine and cheaper than the fiction it replaced.
   */
  test("brings a store built from the previous schema up to this one, filled", async () => {
    const { conn: old } = await createMemoryDb();

    // Unwind beeline-oyq: the whole of schema/108, the projection's
    // twenty-second column in both the table and the view, and
    // qc_rule_locality_format's inline copy of the street-suffix list.
    // Dependents first — sample_mint_free_link and sample_mint_pending read
    // sample_mint_match, which reads sample_mint_group.
    for (const view of [
      "observation_locality", "sample_mint_free_link", "sample_mint_pending",
      "sample_mint_ambiguous", "sample_mint_match", "sample_mint_group",
      "observation_sample_unresolved", "observation_sample_unusable",
      "observation_sample_candidate", "sample_atlas_unfilled",
      "sample_multi_observation", "sample_observation_number_mismatch",
      "observation_field_stale",
    ]) {
      await old.run(`DROP VIEW ${view}`);
    }
    // Back to the inline word list, so that dropping the shared one is
    // possible at all — a pre-0021 store has no such view to read.
    await old.run(`CREATE OR REPLACE VIEW qc_rule_locality_format AS
      SELECT sample_id, CAST(NULL AS INTEGER) AS specimen_id,
             'locality_format' AS rule_name,
             concat_ws('; ',
               CASE WHEN len > 18 THEN concat('longer than 18 chars (', len, ')') END,
               CASE WHEN has_comma THEN 'contains comma' END,
               CASE WHEN has_quote THEN 'contains double quote' END,
               CASE WHEN is_street THEN 'looks like a street address' END) AS details
      FROM (
        SELECT norm.sample_id, length(norm.locality) AS len,
               position(',' IN norm.locality) > 0 AS has_comma,
               position('"' IN norm.locality) > 0 AS has_quote,
               regexp_matches(norm.norm,
                 ' (road|rd|street|str|st|avenue|ave|av|drive|dr|boulevard|blvd|court|ct|lane|ln|county) '
               ) AS is_street
        FROM (
          SELECT s.entity_id AS sample_id, s.locality,
                 concat(' ', replace(replace(lower(s.locality), ',', ' '), '.', ' '), ' ') AS norm
          FROM sample s WHERE s.locality IS NOT NULL
        ) norm
      ) flags
      WHERE len > 18 OR has_comma OR has_quote OR is_street`);
    await old.run("DROP VIEW locality_street_suffix_pattern");
    await old.run("ALTER TABLE observation_field DROP COLUMN private_place_guess");
    await old.run("DROP VIEW observation_current_fields");
    await old.run(`CREATE VIEW observation_current_fields AS
      SELECT inat_id, observed_on, latitude, longitude, private_latitude, private_longitude,
             positional_accuracy, public_positional_accuracy, geoprivacy, taxon_geoprivacy,
             viewer_trusted, user_id, user_login, place_guess, host_taxon_id, host_taxon_name,
             host_is_tracheophyte, quality_grade, sample_number_raw, specimen_count_raw,
             collection_method_raw
      FROM observation_field`);
    // The stale view has to come back too — 0021 does not create it, and a
    // real pre-0021 store has it. Pointed at the same 21 columns.
    await old.run(`CREATE VIEW observation_field_stale AS
      SELECT inat_id FROM (
        SELECT * FROM observation_current_fields EXCEPT SELECT * FROM observation_field
      ) missing
      UNION
      SELECT inat_id FROM (
        SELECT * FROM observation_field EXCEPT SELECT * FROM observation_current_fields
      ) extra`);
    await baseline(old);

    await old.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('t', true, now())");
    await old.run(
      `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
       VALUES (7, (SELECT max(entity_id) FROM sync_run), $1, 'h7')`,
      [canonicalJson(obs(7, { ofvs: [
        { name: "sampleId", value: "1" },
        { name: "numberOfSpecimens", value: "3" },
        { name: "OBA Collection Method", value: "net" },
      ] }))] as never,
    );

    const sql = await readFile(join(MIGRATIONS_DIR, "0021-observations-become-samples.sql"), "utf8");
    await old.run(sql);

    expect(await schemaDrift(old)).toEqual([]);
    // Refilled by the migration itself, and reading the new field: an
    // unrefreshed table would have left the rules quietly reporting an older
    // answer, with observation_field_stale the only thing that knew.
    const filled = await (
      await old.run("SELECT inat_id, specimen_count_raw, collection_method_raw FROM observation_field")
    ).getRows();
    expect(filled).toEqual([[7n, "3", "net"]]);
    const stale = await (await old.run("SELECT count(*) FROM observation_field_stale")).getRows();
    expect(Number(stale[0]![0])).toBe(0);
    // And every region got its place id, which is what the whole places half
    // of the migration exists to make possible.
    const regions = await (
      await old.run("SELECT count(*), count(inat_place_id) FROM atlas_region")
    ).getRows();
    expect(regions).toEqual([[64n, 64n]]);
    // And the reconcile the migration exists to make possible can be asked
    // its question on a store that has never rebuilt.
    const candidates = await (await old.run("SELECT count(*) FROM observation_sample_candidate")).getRows();
    expect(Number(candidates[0]![0])).toBe(1);
  });
});
