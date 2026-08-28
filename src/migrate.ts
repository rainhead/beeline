import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMemoryDb, SCHEMA_DIR } from "./schema.js";

/**
 * Migrations, for databases that outlive a rebuild.
 *
 * `schema/*.sql` remains the schema (ADR 0006): a database built by
 * `db:build` is current by construction, so building stamps every migration
 * as applied and none of them ever runs there. A migration exists for one
 * reason — a *deployed* store, which cannot be blown away, has to catch up.
 * Write the change into `schema/` first, then copy the delta into
 * `migrations/NNNN-slug.sql`.
 *
 * Each migration runs in its own transaction and the run ends with an
 * explicit CHECKPOINT: DuckDB ≤ 1.5.5 can fail WAL replay after DDL and
 * leave the file unopenable (beeline-vyi, beeline-c1b).
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** The ledger's own DDL — applied to stores that predate it. */
const LEDGER_SCHEMA_FILE = "000_schema_migration.sql";

export interface MigrateOptions {
  /** Directory of migration files; overridden by tests. */
  dir?: string;
  /** Record migrations as applied without running them (see baseline()). */
  baseline?: boolean;
}

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

async function scalar(conn: DuckDBConnection, sql: string): Promise<bigint> {
  const [[v]] = (await (await conn.run(sql)).getRows()) as [[bigint]];
  return v;
}

/** Every migration file, in apply order (filename order). */
export async function migrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
}

async function hasLedger(conn: DuckDBConnection): Promise<boolean> {
  const present = await scalar(
    conn,
    `SELECT count(*) FROM information_schema.tables
     WHERE table_schema = 'main' AND table_name = 'schema_migration'`,
  );
  return present > 0n;
}

/**
 * Create the ledger if this database predates it. Stores built from the
 * schema already have it; the sandbox, built before migrations existed,
 * does not. Only migrating creates it — asking about state never writes.
 */
async function ensureLedger(conn: DuckDBConnection): Promise<void> {
  if (!(await hasLedger(conn))) {
    await conn.run(await readFile(join(SCHEMA_DIR, LEDGER_SCHEMA_FILE), "utf8"));
  }
}

/** Names already recorded against this database; none if it has no ledger. */
export async function appliedMigrations(conn: DuckDBConnection): Promise<Set<string>> {
  if (!(await hasLedger(conn))) return new Set();
  const rows = await (await conn.run("SELECT name FROM schema_migration ORDER BY name")).getRows();
  return new Set(rows.map(([name]) => String(name)));
}

/** Files this database has not seen, in apply order. */
export async function pendingMigrations(conn: DuckDBConnection, dir = MIGRATIONS_DIR): Promise<string[]> {
  const applied = await appliedMigrations(conn);
  return (await migrationFiles(dir)).filter((f) => !applied.has(f));
}

/**
 * Bring a database forward. Returns the names applied (or stamped), in
 * order; an empty array means it was already current.
 *
 * A failing migration rolls back and is not recorded, so a fixed migration
 * re-runs cleanly. Later migrations do not run: the run stops at the failure.
 */
export async function migrate(conn: DuckDBConnection, opts: MigrateOptions = {}): Promise<string[]> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  await ensureLedger(conn);
  const pending = await pendingMigrations(conn, dir);
  for (const name of pending) {
    await conn.run("BEGIN TRANSACTION");
    try {
      if (opts.baseline !== true) await conn.run(await readFile(join(dir, name), "utf8"));
      await conn.run(`INSERT INTO schema_migration (name) VALUES (${quote(name)})`);
      await conn.run("COMMIT");
    } catch (err) {
      await conn.run("ROLLBACK");
      throw new Error(`migration ${name}: ${(err as Error).message}`, { cause: err });
    }
  }
  // Outside any transaction, and only when something changed: see the WAL
  // note above.
  if (pending.length > 0) await conn.run("CHECKPOINT");
  return pending;
}

/**
 * Record every pending migration as applied without running it — for a
 * database that already carries the changes: a fresh build from the schema,
 * or a store someone patched by hand.
 */
export async function baseline(conn: DuckDBConnection, dir = MIGRATIONS_DIR): Promise<string[]> {
  return migrate(conn, { dir, baseline: true });
}

/**
 * Where a database's shape differs from `schema/*.sql` — the answer to "did
 * I forget to write a migration?". Compares the tables and views the schema
 * declares, and their columns, against a database freshly built from it.
 *
 * Tables the schema does not declare are ignored on purpose: a real store
 * also holds the ingestion pipeline's staging tables (`ingest/*.sql`), which
 * are nobody's schema drift.
 */
export async function schemaDrift(conn: DuckDBConnection): Promise<string[]> {
  const shape = async (c: DuckDBConnection): Promise<Map<string, Set<string>>> => {
    const rows = await (
      await c.run(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'main' ORDER BY table_name, column_name`,
      )
    ).getRows();
    const byTable = new Map<string, Set<string>>();
    for (const [t, col] of rows) {
      const name = String(t);
      if (!byTable.has(name)) byTable.set(name, new Set());
      byTable.get(name)!.add(String(col));
    }
    return byTable;
  };

  const { instance, conn: fresh } = await createMemoryDb();
  try {
    const expected = await shape(fresh);
    const actual = await shape(conn);
    const drift: string[] = [];
    for (const [table, columns] of expected) {
      const here = actual.get(table);
      if (here === undefined) {
        drift.push(`missing: ${table}`);
        continue;
      }
      for (const col of columns) if (!here.has(col)) drift.push(`missing: ${table}.${col}`);
      for (const col of here) if (!columns.has(col)) drift.push(`not in the schema: ${table}.${col}`);
    }
    return drift.sort();
  } finally {
    fresh.closeSync();
    instance.closeSync();
  }
}

// CLI: pnpm db:migrate [--status|--baseline|--check] [target.duckdb]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const target = args.find((a) => !a.startsWith("--")) ?? "beeline.duckdb";
  const unknown = [...flags].filter((f) => !["--status", "--baseline", "--check"].includes(f));
  if (unknown.length > 0) {
    console.error(`unknown flag(s): ${unknown.join(", ")}`);
    process.exit(2);
  }

  // Nothing else may hold the database open (ADR 0005): stop the app first.
  const instance = await DuckDBInstance.create(target);
  const conn = await instance.connect();
  try {
    if (flags.has("--status")) {
      const applied = await appliedMigrations(conn);
      for (const name of await migrationFiles()) {
        console.log(`${applied.has(name) ? "applied" : "PENDING"}  ${name}`);
      }
    } else {
      const done = await migrate(conn, { baseline: flags.has("--baseline") });
      const verb = flags.has("--baseline") ? "stamped" : "applied";
      if (done.length === 0) console.log(`${target} is up to date`);
      for (const name of done) console.log(`${verb} ${name}`);
    }

    if (!flags.has("--status") || flags.has("--check")) {
      const drift = await schemaDrift(conn);
      if (drift.length > 0) {
        // Not always a missing migration: DuckDB cannot DROP COLUMN on a
        // table anything depends on (ADR 0001, "Evidence since"), so a column
        // the schema has dropped leaves a deployed store only at a reseed.
        console.warn(`\n${target} differs from schema/*.sql — a migration or a reseed may be needed:`);
        for (const line of drift) console.warn(`  ${line}`);
      } else if (flags.has("--check")) {
        console.log(`${target} matches schema/*.sql`);
      }
    }
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
