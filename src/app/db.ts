import { DuckDBInstance } from "@duckdb/node-api";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { createKysely } from "../db.js";
import type { Database } from "../model.js";
import type { AppConfig } from "./config.js";

const PRIVATE_SCHEMA_DIR = new URL("../../schema/private/", import.meta.url).pathname;

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * Attach the private store (ADR 0003) and create its tables if missing —
 * the app owns the store's lifecycle (blow-away era; no migrations).
 * Encryption requires a key; config enforces one outside development.
 */
export async function attachPrivateStore(
  instance: DuckDBInstance,
  opts: { path: string; key: string | null },
): Promise<void> {
  const conn = await instance.connect();
  try {
    const options = opts.key === null ? "" : ` (ENCRYPTION_KEY ${quote(opts.key)})`;
    await conn.run(`ATTACH IF NOT EXISTS ${quote(opts.path)} AS private${options}`);
    const existing = await conn.run(
      `SELECT count(*) FROM information_schema.tables WHERE table_catalog = 'private' AND table_name = 'session'`,
    );
    const [[count]] = (await existing.getRows()) as [[bigint]];
    if (count === 0n) {
      await conn.run(`USE private`);
      const files = (await readdir(PRIVATE_SCHEMA_DIR)).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        await conn.run(await readFile(join(PRIVATE_SCHEMA_DIR, file), "utf8"));
      }
    }
  } finally {
    conn.closeSync();
  }
}

export interface AppDb {
  instance: DuckDBInstance;
  db: Kysely<Database>;
  close(): Promise<void>;
}

/**
 * Open the database the app owns (ADR 0005: exactly one process, this one)
 * with the private store attached. Without a key the store is unencrypted —
 * config only permits that in development.
 */
export async function openAppDb(config: Pick<AppConfig, "dbPath" | "privateDbPath" | "privateDbKey">): Promise<AppDb> {
  const instance = await DuckDBInstance.create(config.dbPath);
  await attachPrivateStore(instance, { path: config.privateDbPath, key: config.privateDbKey });
  const db = createKysely(instance);
  return {
    instance,
    db,
    async close() {
      await db.destroy();
      instance.closeSync();
    },
  };
}
