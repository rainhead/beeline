import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { createMemoryDb as buildSchema } from "../src/schema.js";
import { openMemoryDuckDb } from "../src/db.js";

/**
 * Stores made once per run and copied for each test (beeline-tl4q). Building
 * the schema takes about 0.4 s and copying a finished store about 0.1 s, and a
 * test that wants a store of its own pays that for every test, which across
 * the suite was a third of its time. The files live in the run's folder
 * (test/global-setup.ts), which removes them when the run ends.
 */

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
 * time. A table with no rows is skipped.
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
    await conn.runAndReadAll(`SELECT table_name FROM duckdb_tables() WHERE database_name = '${from}' ORDER BY table_oid ASC`)
  ).getRows() as [string][];
  // Most tables of a store a test starts from are empty, and an INSERT of no
  // rows still costs most of a millisecond: counting them all in one query
  // and copying only those with rows halves the time a copy of the schema
  // takes (beeline-tl4q).
  const filled = new Set(
    tables.length === 0
      ? []
      : (
          (
            await conn.runAndReadAll(
              tables.map(([t]) => `SELECT '${t.replaceAll("'", "''")}' AS t FROM ${from}.main."${t}" HAVING count(*) > 0`).join(" UNION ALL "),
            )
          ).getRows() as [string][]
        ).map(([t]) => t),
  );
  for (const [table] of tables) {
    if (!filled.has(table)) continue;
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
 * The run's file named `name`, built by whichever test asks first, in the run's
 * folder from test/global-setup.ts, which removes it when the run ends. Test
 * files run in several workers at once, so the first to ask takes a lock file,
 * writes its process id in it and builds, and the rest wait for the finished
 * file, which appears whole because it is renamed into place. A build that
 * fails removes the lock, and the next test to ask tries again.
 *
 * A worker that crashes while building leaves the lock behind. A waiter that
 * finds the lock's process gone says so at once rather than waiting out its
 * test's timeout, which is shorter than any wait here. It does not take the
 * lock over: two waiters could both find it stale, and the second would remove
 * the lock the first had just taken.
 *
 * The wait sleeps with node:timers/promises and counts its polls instead of
 * reading a clock, because vi.useFakeTimers() freezes Date, performance and
 * process.hrtime and replaces the global setTimeout, and a wait on any of those
 * would never end in a test that fakes timers.
 */
export async function templateFile(name: string, build: (path: string) => Promise<void>): Promise<string> {
  const runDir = process.env.BEELINE_TEST_RUN_DIR;
  if (runDir === undefined) {
    throw new Error("BEELINE_TEST_RUN_DIR is unset: a store template needs test/global-setup.ts (vite.config.ts) to have run");
  }
  const dir = join(runDir, "store-templates");
  await mkdir(dir, { recursive: true });
  const done = join(dir, `${name}.duckdb`);
  const lock = join(dir, `${name}.lock`);
  // Two minutes of polls 0.1 s apart, for a promotion on a busy machine.
  for (let polls = 0; !existsSync(done); polls++) {
    let held;
    try {
      held = await open(lock, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = await lockOwner(lock);
      if (owner !== undefined && !isRunning(owner)) {
        throw new Error(`${lock} was left by process ${owner}, which is no longer running: did it crash while building ${done}?`);
      }
      if (polls >= 1200) throw new Error(`waited two minutes for ${done} while process ${owner ?? "unknown"} held ${lock}`);
      await sleep(100);
      continue;
    }
    try {
      await held.writeFile(String(process.pid));
      if (!existsSync(done)) await build(done);
    } finally {
      await held.close();
      await rm(lock, { force: true });
    }
  }
  return done;
}

/** The process id written in a lock file, or undefined before it is written or once the lock is gone. */
async function lockOwner(lock: string): Promise<number | undefined> {
  try {
    const pid = Number.parseInt(await readFile(lock, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: running, as another user.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The schema alone, as createMemoryDb in src/schema.ts makes it, in the run's file. */
export function schemaTemplate(): Promise<string> {
  return templateFile("schema", async (path) => {
    const { instance, conn } = await buildSchema();
    const partial = `${path}.${process.pid}.partial`;
    try {
      await writeCopy(conn, partial);
      await rename(partial, path);
    } finally {
      conn.closeSync();
      instance.closeSync();
      await rm(partial, { force: true });
      await rm(`${partial}.wal`, { force: true });
    }
  });
}

/**
 * A new in-memory store holding the schema and nothing else, a copy of
 * `schemaTemplate()`, of the caller's own.
 */
export async function schemaCopy(): Promise<{ instance: DuckDBInstance; conn: DuckDBConnection }> {
  return openCopy(await schemaTemplate());
}

/**
 * Everything a test can see in a store, as plain values: the catalog's own
 * description of every table, column, view, macro, index, constraint,
 * sequence, type and schema, with their comments, and the rows of every table
 * and view. Two stores that give the same answer here look the same to any
 * query a test can write. Left out are the numbers DuckDB hands out to catalog
 * entries as it makes them (the oids), and a table's estimated size.
 *
 * Also left out is a sequence's start_value. COPY FROM DATABASE remakes a
 * sequence starting where the original had got to, so a copy of a store whose
 * `entity_id_seq` has handed out 8 says it started at 9. Its last_value and the
 * next id it hands out are the same, and those are compared; nothing in src
 * reads start_value.
 *
 * `viewText` compares each view's SQL as DuckDB prints it. Leave it on for the
 * schema; a promoted store's views include some DuckDB prints with the names
 * in an EXCLUDE or REPLACE list in no fixed order, so those are compared by
 * what they return.
 */
export async function storeContents(conn: DuckDBConnection, { viewText = true } = {}) {
  const read = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJson();
  const here = "WHERE database_name = current_database()";
  const relations = (
    await conn.runAndReadAll(
      `SELECT table_name FROM duckdb_tables() ${here}
       UNION ALL SELECT view_name FROM duckdb_views() ${here} AND NOT internal ORDER BY 1`,
    )
  ).getRows() as [string][];
  const rows: Record<string, string> = {};
  for (const [relation] of relations) {
    rows[relation] = JSON.stringify((await conn.runAndReadAll(`SELECT * FROM "${relation}" ORDER BY ALL`)).getRowsJson());
  }
  return {
    catalog: {
      database: await read(`SELECT current_database() AS name, current_schema() AS schema`),
      databases: await read(`SELECT * EXCLUDE (database_oid) FROM duckdb_databases() WHERE NOT internal ORDER BY ALL`),
      schemas: await read(`SELECT * EXCLUDE (oid, database_oid, parent_schema_oid) FROM duckdb_schemas() ${here} ORDER BY ALL`),
      tables: await read(
        `SELECT * EXCLUDE (database_oid, schema_oid, table_oid, estimated_size) FROM duckdb_tables() ${here} ORDER BY table_name`,
      ),
      columns: await read(
        `SELECT * EXCLUDE (database_oid, schema_oid, table_oid) FROM duckdb_columns() ${here} ORDER BY table_name, column_index`,
      ),
      views: await read(
        `SELECT * EXCLUDE (database_oid, schema_oid, view_oid${viewText ? "" : ", sql"}) FROM duckdb_views()
         ${here} AND NOT internal ORDER BY view_name`,
      ),
      macros: await read(
        `SELECT * EXCLUDE (database_oid, function_oid) FROM duckdb_functions()
         ${here} AND NOT internal ORDER BY function_name, parameters`,
      ),
      indexes: await read(`SELECT * EXCLUDE (database_oid, schema_oid, index_oid, table_oid) FROM duckdb_indexes() ${here} ORDER BY index_name`),
      constraints: await read(
        `SELECT * EXCLUDE (database_oid, schema_oid, table_oid) FROM duckdb_constraints() ${here} ORDER BY table_name, constraint_index`,
      ),
      sequences: await read(
        `SELECT * EXCLUDE (database_oid, schema_oid, sequence_oid, start_value) FROM duckdb_sequences() ${here} ORDER BY sequence_name`,
      ),
      types: await read(`SELECT * EXCLUDE (database_oid, schema_oid, type_oid) FROM duckdb_types() ${here} AND NOT internal ORDER BY type_name`),
    },
    rows,
    nextEntityId: (await conn.runAndReadAll(`SELECT nextval('entity_id_seq')`)).getRowsJson(),
  };
}

/**
 * What a connection carries besides the catalog: every setting, the loaded
 * extensions, and the temporary tables and views. A schema file that ran SET,
 * PRAGMA, LOAD or CREATE TEMP would leave its mark here on the connection that
 * built the schema and not on a copy, and every test on the copy would run
 * differently from one on a fresh build without saying so.
 */
export async function sessionState(conn: DuckDBConnection) {
  const read = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJson();
  return {
    settings: await read(`SELECT name, value, scope FROM duckdb_settings() ORDER BY name`),
    extensions: await read(`SELECT extension_name FROM duckdb_extensions() WHERE loaded ORDER BY 1`),
    temporary: await read(
      `SELECT database_name, schema_name, table_name AS name, 'table' AS kind FROM duckdb_tables() WHERE temporary
       UNION ALL SELECT database_name, schema_name, view_name, 'view' FROM duckdb_views() WHERE temporary AND NOT internal
       ORDER BY ALL`,
    ),
  };
}
