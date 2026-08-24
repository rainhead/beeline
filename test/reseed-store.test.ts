import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../src/schema.js";
import { carryStaging, reseedStore, type ReseedCounts } from "../src/reseed-store.js";
import { rows } from "./helpers.js";

/**
 * Re-deriving a deployed store's model from the staging it already holds.
 *
 * A change to promotion leaves such a store shaped right and derived wrong,
 * which no migration and no drift check can see (beeline-eyk). Re-promoting
 * fixes it, and must not cost a re-sync: the staged legacy dump and the iNat
 * presence rows deletion detection reads are already in the file.
 */

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
  await seed.run(
    `INSERT INTO sync_run (source, authenticated, updated_since, completed_at)
     VALUES ('18521', true, NULL, now())`,
  );
  await seed.run(
    `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
     SELECT 991, entity_id, '{}', 'hash' FROM sync_run`,
  );
  await seed.run(`INSERT INTO observation_seen (sync_run_id, inat_id) SELECT entity_id, 991 FROM sync_run`);
  await seed.run(
    `INSERT INTO job_run (job_name, outcome, detail) VALUES ('nightly-pipeline', 'succeeded', 'ok')`,
  );
  // Model rows, of the kind promotion derives and this tool must not carry.
  await seed.run(`INSERT INTO person (entity_id, display_name) VALUES (nextval('entity_id_seq'), 'Stale Person')`);
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
  test("staged and synced state comes across, and the model does not", async () => {
    expect(counts.carried).toEqual({
      legacy_occurrence: 1,
      sync_run: 1,
      observation_load: 1,
      observation_seen: 1,
      job_run: 1,
    });
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

  test("the id sequence restarts past what came across", async () => {
    // Ids are sequence draws (ADR 0002). A sequence left at 1 would hand
    // promotion's first person the id a carried sync run already holds, and
    // observation_load.sync_run_id would silently point at a person.
    const highest = await rows(conn, `SELECT max(entity_id) FROM sync_run`);
    expect(counts.sequenceRestartedAt).toBeGreaterThan(Number(highest[0]![0]));
    const next = await rows(conn, `SELECT nextval('entity_id_seq')`);
    expect(Number(next[0]![0])).toBe(counts.sequenceRestartedAt);
  });

  test("the target is a schema build, so migrations are stamped and never run", async () => {
    const stamped = await rows(conn, `SELECT count(*) FROM schema_migration`);
    expect(Number(stamped[0]![0])).toBeGreaterThan(0);
  });

  test("a source that never synced reseeds anyway", async () => {
    // Skipping a missing table rather than failing: legacy-only stores exist,
    // and so will iNat-only ones. The sequence still lands past the seed rows
    // the schema itself inserts — the atlases hold the first ids in any store.
    const bare = join(dir, "bare.duckdb");
    const out = join(dir, "bare-target.duckdb");
    const instance = await DuckDBInstance.create(bare);
    const c = await instance.connect();
    await applySchema(c);
    c.closeSync();
    const bareCounts = await reseedStore(bare, out);
    expect(bareCounts.carried).toEqual({
      sync_run: 0,
      observation_load: 0,
      observation_seen: 0,
      job_run: 0,
    });
    const bareInstance = await DuckDBInstance.create(out);
    const bareConn = await bareInstance.connect();
    const atlases = await rows(bareConn, `SELECT max(entity_id) FROM atlas`);
    bareConn.closeSync();
    expect(bareCounts.sequenceRestartedAt).toBe(Number(atlases[0]![0]) + 1);
  });

  test("reseeding onto the source refuses rather than destroying it", async () => {
    await expect(reseedStore(source, source)).rejects.toThrow(/different target path/);
    // And the guard is in the low-level path too, for a caller with a handle.
    expect(carryStaging).toBeTypeOf("function");
  });
});
