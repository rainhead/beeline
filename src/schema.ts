import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The schema, as a thing you can apply. `schema/*.sql` in filename order is
 * the whole definition (ADR 0001); this module is the only place that knows
 * how to run it, so builds, tests, and the migration tool's drift check all
 * mean the same thing by "the schema".
 */

export const SCHEMA_DIR = fileURLToPath(new URL("../schema/", import.meta.url));

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
