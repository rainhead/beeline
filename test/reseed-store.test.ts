import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../src/schema.js";
import { CARRIED_TABLES, carryStaging, reseedStore, type ReseedCounts } from "../src/reseed-store.js";
import { PrintedStoreRefused } from "../src/registry-guard.js";
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
let instance: DuckDBInstance;

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
  // And the verdicts on ids iNat does not have (beeline-0oj): same argument,
  // and the same instant, for the same reason.
  await seed.run(
    `INSERT INTO inat_place_absent (inat_place_id, asked_at)
     VALUES (117476, TIMESTAMPTZ '2026-08-01 12:00:00+00')`,
  );
  // And the same verdict on an observation a sample cites (beeline-wcc6).
  await seed.run(
    `INSERT INTO observation_absent (inat_id, absent_since, asked_at)
     VALUES (370191199, TIMESTAMPTZ '2026-08-01 12:00:00+00', TIMESTAMPTZ '2026-08-02 12:00:00+00')`,
  );
  // An account's ORCID iD (beeline-yaaj): keyed by the iNat user id and
  // fetched from iNaturalist, so it comes across as the place cache does.
  await seed.run(
    `INSERT INTO inat_user_orcid (inat_user_id, orcid, fetched_at)
     VALUES (429964, '0000-0002-1825-0097', TIMESTAMPTZ '2026-08-01 12:00:00+00')`,
  );
  // Ecdysis's thesaurus, on inat_place's terms: filled from outside the
  // store, keyed by Ecdysis's own id, and not something promotion can
  // recompute (beeline-7gob). Real rows of the fetch of 2026-10-24.
  await seed.run(
    `INSERT INTO ecdysis_taxon (tid, rank, name, author, status, accepted_tid, parent_tid, admitted_parent_tid, fetched_on) VALUES
       (265407, 'species', 'Brachymelecta californica', '(Cresson, 1878)', 'accepted', 265407, 173747, 173747, DATE '2026-10-24'),
       (1645055, 'species', 'Xeromelecta californica', '(Cresson, 1879)', 'synonym', 265407, 204170, NULL, DATE '2026-10-24')`,
  );
  // Who has signed in and been here (schema/012): synthetic, keyed by iNat
  // user id and by name, so they come across as they are (beeline-4tdh).
  await seed.run(`INSERT INTO inat_sign_in (inat_user_id, login) VALUES (501, 'memberbee')`);
  await seed.run(`INSERT INTO session (id_sha256, inat_user_id) VALUES (repeat('b', 64), 501)`);
  // A store from before who revoked a key, and whose account it was made
  // under, was kept (migration 0087): its table has none of those columns,
  // and a reseed must carry its rows with them empty.
  await seed.run(`DROP TABLE api_key`);
  await seed.run(
    `CREATE TABLE api_key (key_sha256 TEXT PRIMARY KEY, inat_user_id BIGINT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL,
       created_at TIMESTAMP NOT NULL DEFAULT current_timestamp, expires_at TIMESTAMP NOT NULL, last_used_at TIMESTAMP, revoked_at TIMESTAMP)`,
  );
  await seed.run(
    `INSERT INTO api_key (key_sha256, inat_user_id, name, scope, expires_at) VALUES (repeat('c', 64), 501, 'script', 'read', current_timestamp + INTERVAL 30 DAY)`,
  );
  await seed.run(`INSERT INTO person_activity (inat_user_id) VALUES (501)`);
  await seed.run(`INSERT INTO impersonation (admin_login, person_name) VALUES ('staffer', 'Member Bee')`);
  // Model rows, of the kind promotion derives and this tool must not carry.
  await seed.run(`INSERT INTO person (entity_id, display_name) VALUES (nextval('entity_id_seq'), 'Stale Person')`);
  // And a sequence left where a promoted store leaves it: far ahead. Both
  // catalogs are attached during the carry and both have a sequence by this
  // name, so reading the wrong one reports the source's floor as the target's.
  await seed.run(`SELECT max(nextval('entity_id_seq')) FROM range(5000)`);
  seed.closeSync();

  counts = await reseedStore(source, target);
  instance = await DuckDBInstance.create(target);
  conn = await instance.connect();
});

afterAll(async () => {
  conn?.closeSync();
  instance?.closeSync();
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
      inat_place_absent: 1,
      observation_absent: 1,
      inat_user_orcid: 1,
      ecdysis_taxon: 2,
      inat_sign_in: 1,
      session: 1,
      api_key: 1,
      person_activity: 1,
      impersonation: 1,
    });
    expect(await rows(conn, `SELECT inat_user_id, name, revoked_by, revoked_reason, account_changed_at FROM api_key`)).toEqual([
      [501n, "script", null, null, null],
    ]);
    // The place cache comes across whole, keeping the instant iNat was
    // actually asked: now() would claim a freshness the reseed did not earn.
    expect(
      await rows(conn, `SELECT inat_place_id, name, admin_level,
                               array_to_string(ancestor_place_ids, ','),
                               fetched_at = TIMESTAMPTZ '2026-08-01 12:00:00+00'
                        FROM inat_place`),
    ).toEqual([[10n, "Oregon", 10, "97394,1,10", true]]);
    expect(
      await rows(conn, `SELECT inat_place_id, asked_at = TIMESTAMPTZ '2026-08-01 12:00:00+00' FROM inat_place_absent`),
    ).toEqual([[117476n, true]]);
    expect(
      await rows(conn, `SELECT inat_id, absent_since = TIMESTAMPTZ '2026-08-01 12:00:00+00',
                               asked_at = TIMESTAMPTZ '2026-08-02 12:00:00+00' FROM observation_absent`),
    ).toEqual([[370191199n, true, true]]);

    // The whole point: the model is empty, so promotion may run against it.
    expect(await rows(conn, `SELECT count(*) FROM person`)).toEqual([[0n]]);
    expect(await rows(conn, `SELECT count(*) FROM sample`)).toEqual([[0n]]);
  });

  test("a source that has printed is refused, and no target is built", async () => {
    // A reseed carries no print run and no minted number (schema/035): every
    // such row hangs off an entity_id it redraws. Until production's first run
    // it counted them as left behind and built anyway, and the new store then
    // minted again from the imported ceiling, issuing numbers already on pins
    // (beeline-83b8.13). One minted number is enough to refuse.
    const printed = join(dir, "printed.duckdb");
    const out = join(dir, "printed-target.duckdb");
    const instance = await DuckDBInstance.create(printed);
    const c = await instance.connect();
    await applySchema(c);
    await c.run(`INSERT INTO person (display_name) VALUES ('Ada Ash')`);
    await c.run(
      `INSERT INTO print_run (prepared_by) SELECT min(entity_id) FROM person;
       INSERT INTO minted_field_number (field_number, print_run_id)
         SELECT '26072092', min(entity_id) FROM print_run`,
    );
    c.closeSync();
    instance.closeSync();

    const refusal = reseedStore(printed, out);
    await expect(refusal).rejects.toThrow(PrintedStoreRefused);
    await expect(refusal).rejects.toThrow(/1 print run\(s\) and 1 minted field number\(s\).*Nothing was built/);
    expect(existsSync(out)).toBe(false);

    // The low-level path refuses too, for a caller with its own connection.
    const handle = await DuckDBInstance.create(":memory:");
    const hc = await handle.connect();
    // Its caller has built the target already, so it says only that nothing came across.
    await expect(carryStaging(hc, printed)).rejects.toThrow(/Nothing was carried from it/);
    hc.closeSync();
  });

  test("a source with a print run and no minted number is refused too", async () => {
    // Each table is counted on its own. The schema allows a run with no
    // minted number, so a guard reading only one table must fail here.
    const runOnly = join(dir, "run-only.duckdb");
    const instance = await DuckDBInstance.create(runOnly);
    const c = await instance.connect();
    await applySchema(c);
    await c.run(`INSERT INTO person (display_name) VALUES ('Ada Ash')`);
    await c.run(`INSERT INTO print_run (prepared_by) SELECT min(entity_id) FROM person`);
    c.closeSync();
    instance.closeSync();
    await expect(reseedStore(runOnly, join(dir, "run-only-target.duckdb"))).rejects.toThrow(
      /1 print run\(s\) and 0 minted field number\(s\)/,
    );
  });

  test("a target that has printed is refused, and not deleted, though the source has not", async () => {
    // The reseed deletes whatever is at its target. Swapped arguments, or a
    // rebuild from a copy taken before the first run, would pass the source's
    // check and then delete the live store with its registry.
    const live = join(dir, "live.duckdb");
    const instance = await DuckDBInstance.create(live);
    const c = await instance.connect();
    await applySchema(c);
    await c.run(`INSERT INTO person (display_name) VALUES ('Ada Ash')`);
    await c.run(
      `INSERT INTO print_run (prepared_by) SELECT min(entity_id) FROM person;
       INSERT INTO minted_field_number (field_number, print_run_id)
         SELECT '26072092', min(entity_id) FROM print_run`,
    );
    c.closeSync();
    instance.closeSync();

    await expect(reseedStore(source, live)).rejects.toThrow(/Refusing to replace .*Nothing was deleted/);
    const after = await DuckDBInstance.create(live);
    const ac = await after.connect();
    expect(await rows(ac, `SELECT field_number FROM minted_field_number`)).toEqual([["26072092"]]);
    ac.closeSync();
    after.closeSync();
  });

  test("the source above has printed nothing, so the reseed built it", async () => {
    // The ordinary case keeps working: an empty registry is not a refusal.
    expect(await rows(conn, `SELECT count(*) FROM print_run`)).toEqual([[0n]]);
    expect(await rows(conn, `SELECT count(*) FROM minted_field_number`)).toEqual([[0n]]);
    expect(counts.leftBehind).not.toHaveProperty("print_run");
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
    // One process owns a store (ADR 0005), so the copy this suite reads is
    // closed before the reseed opens it as a source, and reopened after.
    // DuckDB 1.5 let a second instance in the same process read the file
    // anyway; 2.0 finds its write-ahead log out of step and refuses.
    conn.closeSync();
    instance.closeSync();
    const again = join(dir, "again.duckdb");
    const second = await reseedStore(target, again);
    instance = await DuckDBInstance.create(target);
    conn = await instance.connect();
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
    // after the seed rows the schema itself inserts — the atlases, then the
    // programs.
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
      inat_place_absent: 0,
      observation_absent: 0,
      inat_user_orcid: 0,
      ecdysis_taxon: 0,
      inat_sign_in: 0,
      session: 0,
      api_key: 0,
      person_activity: 0,
      impersonation: 0,
    });
    const bareInstance = await DuckDBInstance.create(out);
    const bareConn = await bareInstance.connect();
    const seeded = await rows(
      bareConn,
      `SELECT max(entity_id) FROM program`,
    );
    bareConn.closeSync();
    expect(bareCounts.sequenceAt).toBe(Number(seeded[0]![0]) + 1);
  });

  test("reseeding onto the source refuses rather than destroying it", async () => {
    await expect(reseedStore(source, source)).rejects.toThrow(/different target path/);
    // And the guard is in the low-level path too, for a caller with a handle.
    expect(carryStaging).toBeTypeOf("function");
  });
});
