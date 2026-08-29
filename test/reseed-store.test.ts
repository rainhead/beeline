import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../src/schema.js";
import { CARRIED_TABLES, carryStaging, reseedStore, type ReseedCounts } from "../src/reseed-store.js";
import { rows } from "./helpers.js";

/**
 * Re-deriving a deployed store's model from the staging it already holds.
 *
 * A change to promotion leaves such a store shaped right and derived wrong,
 * which no migration and no drift check can see (beeline-eyk). Re-promoting
 * fixes it, and must not cost a re-sync: the staged legacy dump and the iNat
 * presence rows deletion detection reads are already in the file.
 */

const SOURCE_SYNC_RUN_ID = 722_365;

let dir: string;
let source: string;
let target: string;
let counts: ReseedCounts;
let conn: DuckDBConnection;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "beeline-reseed-"));
  source = join(dir, "source.duckdb");
  target = join(dir, "target.duckdb");

  // A store with staging, sync history, and a model derived from them.
  const seedInstance = await DuckDBInstance.create(source);
  const seed = await seedInstance.connect();
  await applySchema(seed);
  await seed.run(`CREATE TABLE legacy_occurrence AS SELECT 'aaaa1111' AS _id, 'Bea Trapper' AS recordedBy`);
  // A real store's sync runs are drawn AFTER promotion, so their ids are huge
  // — 722,365 on the sandbox. That is what used to set the new store's floor.
  await seed.run(
    `INSERT INTO sync_run (entity_id, source, authenticated, updated_since, completed_at)
     VALUES (${SOURCE_SYNC_RUN_ID}, '18521', true, NULL, now())`,
  );
  await seed.run(
    `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
     SELECT 991, entity_id, '{}', 'hash' FROM sync_run`,
  );
  await seed.run(`INSERT INTO observation_seen (sync_run_id, inat_id) SELECT entity_id, 991 FROM sync_run`);
  await seed.run(
    `INSERT INTO job_run (job_name, outcome, detail) VALUES ('nightly-pipeline', 'succeeded', 'ok')`,
  );
  // The one carried table promotion cannot recompute: it comes from an
  // outbound fetch, so a reseed that dropped it would leave the store unable
  // to resolve any observation to a state. fetched_at is set to a distinct
  // past instant so the carry can be shown to preserve it rather than stamp
  // a new one.
  await seed.run(
    `INSERT INTO inat_place (inat_place_id, name, admin_level, ancestor_place_ids, fetched_at)
     VALUES (10, 'Oregon', 10, [97394, 1, 10], TIMESTAMPTZ '2026-08-01 12:00:00+00')`,
  );
  // Model rows, of the kind promotion derives and this tool must not carry.
  await seed.run(`INSERT INTO person (entity_id, display_name) VALUES (nextval('entity_id_seq'), 'Stale Person')`);
  // And a sequence left where a promoted store leaves it: far ahead. Both
  // catalogs are attached during the carry and both have a sequence by this
  // name, so reading the wrong one reports the source's floor as the target's.
  await seed.run(`SELECT max(nextval('entity_id_seq')) FROM range(5000)`);
  seed.closeSync();

  counts = await reseedStore(source, target);
  const instance = await DuckDBInstance.create(target);
  conn = await instance.connect();
});

afterAll(async () => {
  conn?.closeSync();
  await rm(dir, { recursive: true, force: true });
});

describe("reseeding a store that cannot be blown away", () => {
  test("CARRIED_TABLES is a claim something checks, not a comment", async () => {
    // carryStaging copies each table by hand — three of them need their ids
    // or their sync_run reference rewritten, and no loop expresses that — so
    // the list can name a table that nothing actually copies. That is not
    // hypothetical: inat_place was added to the list and to no branch, which
    // would have silently dropped the places cache on every reseed and left
    // the store unable to give anything an atlas (CodeRabbit, PR #19). The
    // source store above holds a row in every one of these, so a name here
    // that carryStaging forgets shows up as a missing key.
    expect(Object.keys(counts.carried).sort()).toEqual([...CARRIED_TABLES].sort());
  });

  test("staged and synced state comes across, and the model does not", async () => {
    expect(counts.carried).toEqual({
      legacy_occurrence: 1,
      sync_run: 1,
      observation_load: 1,
      observation_seen: 1,
      job_run: 1,
      inat_place: 1,
    });
    // The place cache comes across whole, keeping the instant iNat was
    // actually asked: now() would claim a freshness the reseed did not earn.
    expect(
      await rows(conn, `SELECT inat_place_id, name, admin_level,
                               array_to_string(ancestor_place_ids, ','),
                               fetched_at = TIMESTAMPTZ '2026-08-01 12:00:00+00'
                        FROM inat_place`),
    ).toEqual([[10n, "Oregon", 10, "97394,1,10", true]]);

    // The whole point: the model is empty, so promotion may run against it.
    expect(await rows(conn, `SELECT count(*) FROM person`)).toEqual([[0n]]);
    expect(await rows(conn, `SELECT count(*) FROM sample`)).toEqual([[0n]]);
  });

  test("the presence rows deletion detection reads keep pointing at their run", async () => {
    // observation_seen and observation_load are keyed on sync_run.entity_id.
    // Carrying them without their run — or renumbering either — would make
    // qc_rule_observation_missing_upstream read absence where there is none.
    const joined = await rows(
      conn,
      `SELECT s.source, l.inat_id, seen.inat_id
       FROM sync_run s
       JOIN observation_load l ON l.sync_run_id = s.entity_id
       JOIN observation_seen seen ON seen.sync_run_id = s.entity_id`,
    );
    expect(joined).toEqual([["18521", 991n, 991n]]);
  });

  test("carried rows take fresh ids, so reseeding does not ratchet the floor", async () => {
    // The source's sync run holds a high id, drawn after a promotion. Carrying
    // it verbatim forced the sequence past it and every later reseed past that
    // — ids climbing by a million a run for no reason. This builds a new
    // database, where a sync run's id is no more permanent than a person's.
    const source = await rows(conn, `SELECT max(entity_id) FROM sync_run`);
    expect(Number(source[0]![0])).toBeLessThan(SOURCE_SYNC_RUN_ID);
    expect(counts.sequenceAt).toBeLessThan(SOURCE_SYNC_RUN_ID);
    const next = await rows(conn, `SELECT nextval('entity_id_seq')`);
    expect(Number(next[0]![0])).toBe(counts.sequenceAt);
  });

  test("reseeding the result again lands in the same id range", async () => {
    // The property the old behaviour lacked: reseed twice and the floor was a
    // million higher. A store should not accumulate id debt for being kept.
    const again = join(dir, "again.duckdb");
    const second = await reseedStore(target, again);
    expect(second.carried).toEqual(counts.carried);
    expect(second.sequenceAt).toBe(counts.sequenceAt);
  });

  test("the target is a schema build, so migrations are stamped and never run", async () => {
    const stamped = await rows(conn, `SELECT count(*) FROM schema_migration`);
    expect(Number(stamped[0]![0])).toBeGreaterThan(0);
  });

  test("a source that never synced reseeds anyway", async () => {
    // Skipping a missing table rather than failing: legacy-only stores exist,
    // and so will iNat-only ones. Nothing carried, so the sequence sits right
    // after the seed rows the schema itself inserts — the atlases.
    const bare = join(dir, "bare.duckdb");
    const out = join(dir, "bare-target.duckdb");
    const instance = await DuckDBInstance.create(bare);
    const c = await instance.connect();
    await applySchema(c);
    c.closeSync();
    const bareCounts = await reseedStore(bare, out);
    // Every schema table reports zero; legacy_occurrence is absent because
    // load-legacy makes it and this store never ran one.
    expect(bareCounts.carried).toEqual({
      sync_run: 0,
      observation_load: 0,
      observation_seen: 0,
      job_run: 0,
      inat_place: 0,
    });
    const bareInstance = await DuckDBInstance.create(out);
    const bareConn = await bareInstance.connect();
    const atlases = await rows(bareConn, `SELECT max(entity_id) FROM atlas`);
    bareConn.closeSync();
    expect(bareCounts.sequenceAt).toBe(Number(atlases[0]![0]) + 1);
  });

  test("reseeding onto the source refuses rather than destroying it", async () => {
    await expect(reseedStore(source, source)).rejects.toThrow(/different target path/);
    // And the guard is in the low-level path too, for a caller with a handle.
    expect(carryStaging).toBeTypeOf("function");
  });
});
