import { describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { canonicalJson } from "../src/sync-inat.js";
import { promoteObservations } from "../src/promote-observations.js";
import { isWriteConflict, retryOnWriteConflict } from "../src/write-conflict.js";

/**
 * Retrying a transaction that lost a write race (beeline-lpx).
 *
 * The conflicts here are real ones, from two connections on one DuckDB
 * instance, rather than errors written to look like them: the claim under
 * test is that the pattern matches what the engine actually says.
 */

async function conflictError(): Promise<unknown> {
  const { instance, conn } = await createMemoryDb();
  const other = await instance.connect();
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
  const id = await insertCleanSample(conn);
  await other.run("BEGIN TRANSACTION");
  await other.run(`UPDATE sample SET locality = 'first' WHERE entity_id = ${id}`);
  try {
    await conn.run(`UPDATE sample SET locality = 'second' WHERE entity_id = ${id}`);
  } catch (err) {
    return err;
  } finally {
    await other.run("ROLLBACK");
  }
  throw new Error("expected a write conflict");
}

describe("isWriteConflict", () => {
  test("recognises DuckDB's own conflict error", async () => {
    expect(isWriteConflict(await conflictError())).toBe(true);
  });

  test("does not take a constraint violation for a race", async () => {
    const { conn } = await createMemoryDb();
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada')");
    const [[id]] = (await rows(conn, "SELECT min(entity_id) FROM person")) as [[number]];
    const err = await conn.run(`INSERT INTO person (entity_id, display_name) VALUES (${id}, 'Ada')`).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isWriteConflict(err)).toBe(false);
  });
});

describe("retryOnWriteConflict", () => {
  const noWait = async () => {};

  test("runs again after a conflict and reports how many retries it took", async () => {
    const conflict = await conflictError();
    let calls = 0;
    const result = await retryOnWriteConflict(
      async () => {
        if (++calls < 3) throw conflict;
        return "done";
      },
      { sleep: noWait },
    );
    expect(result).toEqual({ value: "done", retries: 2 });
  });

  test("gives up after its last delay and throws the conflict", async () => {
    const conflict = await conflictError();
    let calls = 0;
    await expect(
      retryOnWriteConflict(
        async () => {
          calls++;
          throw conflict;
        },
        { delaysMs: [0, 0], sleep: noWait },
      ),
    ).rejects.toBe(conflict);
    expect(calls).toBe(3);
  });

  test("never retries any other error, nor once aborted", async () => {
    let calls = 0;
    await expect(
      retryOnWriteConflict(async () => {
        calls++;
        throw new Error("Constraint Error: duplicate key");
      }, { sleep: noWait }),
    ).rejects.toThrow("duplicate key");
    expect(calls).toBe(1);

    const conflict = await conflictError();
    const aborted = AbortSignal.abort();
    calls = 0;
    await expect(
      retryOnWriteConflict(async () => {
        calls++;
        throw conflict;
      }, { sleep: noWait, signal: aborted }),
    ).rejects.toBe(conflict);
    expect(calls).toBe(1);
  });
});

describe("promotion against a concurrent writer", () => {
  test("loses to a writer holding a row it rewrites, and succeeds once that writer commits", async () => {
    // bench/contention.ts's '+ overlap' phase, made deterministic: another
    // connection holds an uncommitted write to the locality the unprinted-
    // locality follow rule is about to rewrite, and commits during the wait.
    const { instance, conn } = await createMemoryDb();
    const other = await instance.connect();
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    for (const [id, name, level] of [[1, "United States", 0], [10, "Oregon", 10], [484, "Benton", 20]] as const) {
      await conn.run(`INSERT INTO inat_place (inat_place_id, name, admin_level) VALUES (${id}, '${name}', ${level})`);
    }
    const sampleId = await insertCleanSample(conn, {
      inat_observation_id: "7", sample_number: "'7'", locality: "'Bald Hill'",
    });
    await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
    await stageObservation(conn, 7);

    await other.run("BEGIN TRANSACTION");
    await other.run(`UPDATE sample SET locality = 'Typed meanwhile' WHERE entity_id = ${sampleId}`);
    const waits: number[] = [];
    const counts = await promoteObservations(conn, {
      retry: {
        delaysMs: [10, 20],
        sleep: async (ms) => {
          waits.push(ms);
          await other.run("COMMIT");
        },
      },
    });
    expect(waits).toEqual([10]);
    expect(counts.retries).toBe(1);
    // The retry ran the whole promotion again, so the follow rule applied
    // over what the writer committed.
    expect((await rows(conn, `SELECT locality FROM sample WHERE entity_id = ${sampleId}`))[0]).toEqual(["Corvallis"]);
  });
});

async function stageObservation(conn: DuckDBConnection, id: number): Promise<void> {
  const o = {
    id,
    uuid: `uuid-${id}`,
    observed_on: "2026-07-14",
    geojson: { coordinates: [-123.262, 44.5646], type: "Point" },
    positional_accuracy: 30,
    public_positional_accuracy: 30,
    geoprivacy: null,
    taxon_geoprivacy: null,
    place_ids: [1, 10, 484],
    place_guess: "Corvallis, OR, US",
    user: { id: 100, login: "adacollects", name: "Ada Collector" },
    taxon: { id: 47604, name: "Rubus", ancestor_ids: [48460, 47126, 211194, 47604] },
    ofvs: [
      { name: "sampleId", value: "7" },
      { name: "numberOfSpecimens", value: "3" },
    ],
  };
  await conn.run(
    `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
     VALUES ($1, (SELECT max(entity_id) FROM sync_run), $2, $3)`,
    [id, canonicalJson(o), `hash-${id}`] as never,
  );
}
