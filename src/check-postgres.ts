/**
 * `pnpm db:check-postgres [connection-url]` — does the schema still port?
 *
 * Applies schema/*.sql, rewritten by src/postgres-port.ts, to a throwaway
 * database on a real Postgres, and then schema/private/*.sql into a schema
 * named `private`, which is what ADR 0003's attached store would become.
 * Fails on the first statement Postgres refuses (beeline-l6w). No data is
 * involved: the claim ADR 0001 makes is that the DDL applies and every view
 * binds, and Postgres binds a view when it is created.
 *
 * The connection URL (or the PG* environment variables `pg` reads) names a
 * server to create the database on, never a database to apply to: the check
 * creates `beeline_check_<random>` and drops it afterwards.
 */
import pg from "pg";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SCHEMA_DIR } from "./schema.js";
import { readPrelude, toPostgres } from "./postgres-port.js";

export interface PortFailure {
  file: string;
  message: string;
  /** The rewritten SQL around the position Postgres named, when it named one. */
  context?: string;
}

async function sqlFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
}

function around(sql: string, position: number | undefined): string | undefined {
  if (!position) return undefined;
  const lines = sql.slice(0, position).split("\n");
  const at = lines.length - 1;
  const all = sql.split("\n");
  return all
    .slice(Math.max(0, at - 2), at + 3)
    .map((l, k) => `${Math.max(0, at - 2) + k === at ? ">" : " "} ${l}`)
    .join("\n");
}

/**
 * Apply the whole schema to `client`'s database, stopping at the first failure.
 * `adjust` sees each file's rewritten SQL before it is applied: an experiment
 * (bench/postgres) can change one view without forking the schema.
 */
export async function applyPortedSchema(
  client: pg.Client,
  adjust: (file: string, sql: string) => string = (_file, sql) => sql,
): Promise<PortFailure | null> {
  const steps: { file: string; sql: string; searchPath: string }[] = [
    { file: "schema/postgres/prelude.sql", sql: await readPrelude(), searchPath: "public" },
  ];
  for (const f of await sqlFiles(SCHEMA_DIR)) {
    steps.push({ file: `schema/${f}`, sql: await readFile(join(SCHEMA_DIR, f), "utf8"), searchPath: "public" });
  }
  const privateDir = join(SCHEMA_DIR, "private");
  for (const f of await sqlFiles(privateDir)) {
    steps.push({ file: `schema/private/${f}`, sql: await readFile(join(privateDir, f), "utf8"), searchPath: "private, public" });
  }
  await client.query("CREATE SCHEMA private");

  for (const step of steps) {
    let sql: string;
    try {
      sql = adjust(step.file, step.file.includes("/postgres/") ? step.sql : toPostgres(step.sql));
    } catch (err) {
      return { file: step.file, message: `no port rule: ${(err as Error).message}` };
    }
    try {
      await client.query(`SET search_path = ${step.searchPath}`);
      await client.query(sql);
    } catch (err) {
      const e = err as pg.DatabaseError;
      return { file: step.file, message: e.message, context: around(sql, e.position ? Number(e.position) : undefined) };
    }
  }
  return null;
}

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Create a throwaway database on the server `config` reaches, hand it to `fn`, drop it. */
export async function withScratchDatabase<T>(
  config: pg.ClientConfig,
  fn: (client: pg.Client, database: string) => Promise<T>,
): Promise<T> {
  const database = `beeline_check_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client(config);
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  try {
    // A connection string wins over `database`, so the name goes into it.
    const scratch: pg.ClientConfig = config.connectionString
      ? { ...config, connectionString: withDatabase(config.connectionString, database) }
      : { ...config, database };
    const client = new pg.Client(scratch);
    await client.connect();
    try {
      return await fn(client, database);
    } finally {
      await client.end();
    }
  } finally {
    await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.argv[2] ?? process.env.DATABASE_URL;
  const config: pg.ClientConfig = url ? { connectionString: url } : {};
  const failure = await withScratchDatabase(config, (client) => applyPortedSchema(client));
  if (failure) {
    console.error(`${failure.file}: ${failure.message}`);
    if (failure.context) console.error(failure.context);
    process.exit(1);
  }
  console.log("schema/*.sql and schema/private/*.sql apply on Postgres through src/postgres-port.ts");
}
