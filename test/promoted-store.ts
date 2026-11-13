import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryDb } from "../src/build-db.js";
import { ensureCorrectionsFile } from "../src/corrections.js";
import { openMemoryDuckDb } from "../src/db.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy, type PromotionInputs } from "../src/promote-legacy.js";
import { FIXTURE_INPUTS } from "./helpers.js";

/**
 * A store promoted from a legacy fixture, for the tests that only need one to
 * stand on (beeline-vwn4). Production no longer promotes (ADR 0006), but many
 * tests want a store shaped like the one promotion left, and promoting takes
 * about 5 s on Hostess and twice that on CI however small the fixture: the
 * cost is in creating 84 tables, 124 views and 19 macros, not in the six
 * records. Paid by every test of a 45-test file, it made the whole run as long
 * as that one file.
 *
 * So each kind of promoted store is built once per run and written to a file
 * in the run's own folder (test/global-setup.ts), and every test gets its own
 * in-memory copy of it, which takes about 0.2 s. A copy is complete: the
 * promotion SQL reads every input file into a table rather than into a view
 * that would read the file again later, and sets no session state, so the
 * file holds everything a test can see. `test/promoted-store.test.ts` holds
 * the copy to the store it was made from.
 *
 * Tests that are about promotion itself, or that need staging or inputs other
 * than these, still promote for themselves.
 */
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;

export const PROMOTED_STORES = {
  /** test/fixtures/legacy-occurrences.jsonl, through FIXTURE_INPUTS. */
  occurrences: { staging: fixture("legacy-occurrences.jsonl"), inputs: FIXTURE_INPUTS },
  /** The same records, with the git-side corrections in test/fixtures/legacy-corrections.csv. */
  corrected: {
    staging: fixture("legacy-occurrences.jsonl"),
    inputs: { ...FIXTURE_INPUTS, legacyCorrections: fixture("legacy-corrections.csv") },
  },
  /** test/fixtures/legacy-skipped.jsonl: the records promotion holds back. */
  skipped: { staging: fixture("legacy-skipped.jsonl"), inputs: FIXTURE_INPUTS },
} satisfies Record<string, { staging: string; inputs: PromotionInputs }>;

export type PromotedStore = keyof typeof PROMOTED_STORES;

/**
 * A fresh in-memory store, as `kind` stood straight after promotion: the same
 * as createMemoryDb, loadLegacyStaging and promoteLegacy with those inputs,
 * without paying for the promotion.
 *
 * Pass `appCorrections` where the test promoted with its own corrections file
 * and reads that file afterwards: promotion created it with its header, and
 * this does the same. That file must hold no corrections yet, since the store
 * was promoted without any; one that holds some needs a real promotion.
 */
export async function promotedStore(
  kind: PromotedStore,
  { appCorrections }: { appCorrections?: string } = {},
): Promise<{ instance: DuckDBInstance; conn: DuckDBConnection }> {
  if (appCorrections !== undefined) {
    await ensureCorrectionsFile(appCorrections);
    const lines = (await readFile(appCorrections, "utf8")).split("\n").filter((l) => l !== "");
    if (lines.length > 1) {
      throw new Error(`${appCorrections} already holds corrections; promote with it rather than copying a store promoted without`);
    }
  }
  return openCopy(await templateFile(kind));
}

/** Write the store `conn` has open to a new file at `path`. */
export async function writeCopy(conn: DuckDBConnection, path: string): Promise<void> {
  await conn.run(`ATTACH '${path.replaceAll("'", "''")}' AS copy_target`);
  try {
    await copyDatabase(conn, "memory", "copy_target");
  } finally {
    await conn.run("DETACH copy_target");
  }
}

/** A fresh in-memory store holding everything in the file at `path`. */
export async function openCopy(path: string): Promise<{ instance: DuckDBInstance; conn: DuckDBConnection }> {
  const instance = await openMemoryDuckDb();
  const conn = await instance.connect();
  await conn.run(`ATTACH '${path.replaceAll("'", "''")}' AS copy_source (READ_ONLY)`);
  await copyDatabase(conn, "copy_source", "memory");
  await conn.run("DETACH copy_source");
  return { instance, conn };
}

/**
 * Every schema object and row of database `from` into database `to`, which
 * must be empty. DuckDB's own COPY FROM DATABASE copies the schema (tables,
 * views, macros, indexes, and the sequence at its current value) but not the
 * rows of this store: it fills each table in one statement, DuckDB checks a
 * foreign key against the rows that were there before the statement, and
 * `animal` refers to itself through `parent_id`. So the rows go table by table
 * in the order the tables were made, which is an order in which every table a
 * foreign key names comes first, and `animal` goes one level of the tree at a
 * time.
 */
export async function copyDatabase(conn: DuckDBConnection, from: string, to: string): Promise<void> {
  await conn.run(`COPY FROM DATABASE ${from} TO ${to} (SCHEMA)`);
  const selfReferencing = (
    await conn.runAndReadAll(
      `SELECT table_name FROM duckdb_constraints()
       WHERE database_name = '${from}' AND constraint_type = 'FOREIGN KEY'
         AND referenced_table = table_name`,
    )
  ).getRows() as [string][];
  const unhandled = selfReferencing.filter(([t]) => t !== "animal");
  if (unhandled.length > 0) {
    throw new Error(`copyDatabase cannot yet copy a table that refers to itself: ${unhandled.join(", ")}`);
  }
  const tables = (
    await conn.runAndReadAll(`SELECT table_name FROM duckdb_tables() WHERE database_name = '${from}' ORDER BY table_oid`)
  ).getRows() as [string][];
  for (const [table] of tables) {
    if (table === "animal") {
      for (;;) {
        const step = await conn.run(
          `INSERT INTO ${to}.main.animal SELECT a.* FROM ${from}.main.animal a
           WHERE a.entity_id NOT IN (SELECT entity_id FROM ${to}.main.animal)
             AND (a.parent_id IS NULL OR a.parent_id IN (SELECT entity_id FROM ${to}.main.animal))`,
        );
        if (step.rowsChanged === 0) break;
      }
      const [[left]] = (
        await conn.runAndReadAll(
          `SELECT count(*) FROM ${from}.main.animal WHERE entity_id NOT IN (SELECT entity_id FROM ${to}.main.animal)`,
        )
      ).getRows() as [[bigint]];
      if (left !== 0n) throw new Error(`copyDatabase: ${left} animal rows hang from no copied parent`);
    } else {
      await conn.run(`INSERT INTO ${to}.main."${table}" SELECT * FROM ${from}.main."${table}"`);
    }
  }
}

/**
 * The run's file for `kind`, built by whichever test asks first, in the run's
 * folder from test/global-setup.ts, which removes it when the run ends. Test
 * files run in several workers at once, so the first to ask takes a lock file
 * and builds, and the rest wait for the finished file, which appears whole
 * because it is renamed into place. A build that fails removes the lock, and
 * the next test to ask tries again.
 */
async function templateFile(kind: PromotedStore): Promise<string> {
  const runDir = process.env.BEELINE_TEST_RUN_DIR;
  if (runDir === undefined) {
    throw new Error("BEELINE_TEST_RUN_DIR is unset: promotedStore needs test/global-setup.ts (vite.config.ts) to have run");
  }
  const dir = join(runDir, "promoted-stores");
  await mkdir(dir, { recursive: true });
  const done = join(dir, `${kind}.duckdb`);
  const lock = join(dir, `${kind}.lock`);
  const deadline = Date.now() + 120_000;
  while (!existsSync(done)) {
    let held;
    try {
      held = await open(lock, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) throw new Error(`waited two minutes for ${done}; is ${lock} left over from a crash?`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    try {
      if (!existsSync(done)) await buildTemplate(kind, done);
    } finally {
      await held.close();
      await rm(lock, { force: true });
    }
  }
  return done;
}

async function buildTemplate(kind: PromotedStore, path: string): Promise<void> {
  const { staging, inputs } = PROMOTED_STORES[kind];
  const { instance, conn } = await createMemoryDb();
  const partial = `${path}.${process.pid}.partial`;
  try {
    await loadLegacyStaging(conn, staging);
    await promoteLegacy(conn, inputs);
    await writeCopy(conn, partial);
    await rename(partial, path);
  } finally {
    conn.closeSync();
    instance.closeSync();
    await rm(partial, { force: true });
    await rm(`${partial}.wal`, { force: true });
  }
}
