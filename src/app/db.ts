import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { Kysely } from "kysely";
import { createKysely } from "../db.js";
import type { Database } from "../model.js";
import type { AppConfig } from "./config.js";

export interface AppDb {
  instance: DuckDBInstance;
  db: Kysely<Database>;
  close(): Promise<void>;
}

/**
 * Open the database the app owns (ADR 0005: exactly one process, this one)
 * and attach the encrypted private store when a key is configured (ADR 0003).
 * Without a key the app still runs — every private-store read path must
 * already cope with the tables being absent.
 */
export async function openAppDb(config: Pick<AppConfig, "dbPath" | "privateDbPath" | "privateDbKey">): Promise<AppDb> {
  const instance = await DuckDBInstance.create(config.dbPath);
  if (config.privateDbKey !== null) {
    const conn: DuckDBConnection = await instance.connect();
    try {
      await conn.run(`ATTACH IF NOT EXISTS $path AS private (ENCRYPTION_KEY $key)`, {
        path: config.privateDbPath,
        key: config.privateDbKey,
      });
    } finally {
      conn.closeSync();
    }
  }
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
