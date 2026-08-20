import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SCHEMA_DIR = new URL("../schema/", import.meta.url).pathname;

/** Apply every schema/*.sql, in filename order, to an open connection. */
export async function applySchema(conn: DuckDBConnection): Promise<void> {
  const files = (await readdir(SCHEMA_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(join(SCHEMA_DIR, file), "utf8");
    try {
      await conn.run(sql);
    } catch (err) {
      throw new Error(`applying schema/${file}: ${(err as Error).message}`, { cause: err });
    }
  }
}

/** Fresh in-memory database with the schema applied (tests, scratch work). */
export async function createMemoryDb(): Promise<{ instance: DuckDBInstance; conn: DuckDBConnection }> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await applySchema(conn);
  return { instance, conn };
}

// CLI: pnpm db:build [target.duckdb] — blows away and rebuilds (pre-cutover stance).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const target = process.argv[2] ?? "beeline.duckdb";
  await rm(target, { force: true });
  const instance = await DuckDBInstance.create(target);
  const conn = await instance.connect();
  await applySchema(conn);
  conn.closeSync();
  console.log(`built ${target}`);
}
