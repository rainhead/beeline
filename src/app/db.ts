import { DuckDBInstance } from "@duckdb/node-api";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { createKysely } from "../db.js";
import type { Database } from "../model.js";
import type { AppConfig } from "./config.js";

const PRIVATE_SCHEMA_DIR = fileURLToPath(new URL("../../schema/private/", import.meta.url));

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
    } else {
      // The private store outlives the blow-away era (it holds live sessions
      // and tokens), so columns added to its schema are patched in here rather
      // than by rebuild. CHECKPOINT per docs/runbooks: DuckDB < 1.6 can fail
      // WAL replay after DDL (beeline-vyi).
      const hasIconUrl = await conn.run(
        `SELECT count(*) FROM information_schema.columns
         WHERE table_catalog = 'private' AND table_name = 'inat_oauth_token' AND column_name = 'icon_url'`,
      );
      const [[iconUrlCount]] = (await hasIconUrl.getRows()) as [[bigint]];
      if (iconUrlCount === 0n) {
        await conn.run(`ALTER TABLE private.inat_oauth_token ADD COLUMN icon_url TEXT`);
        await conn.run(`CHECKPOINT private`);
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

/**
 * Bootstrap the admin roster. The store is the authority (schema/010
 * person_admin) so grants and revocations made in the app stick; the
 * checked-in ADMIN_LOGINS is the seed that keeps a store nobody has granted
 * anything from locking its keepers out.
 *
 * Seeds only when the table is EMPTY. Topping it up on every boot would
 * resurrect a deliberate revocation at the next restart, which is the one
 * thing a roster screen must not do.
 */
export async function seedAdmins(db: Kysely<Database>, logins: readonly string[]): Promise<number> {
  if (logins.length === 0) return 0;
  const existing = await db.selectFrom("person_admin").select("person_id").executeTakeFirst();
  if (existing !== undefined) return 0;
  const people = await db
    .selectFrom("inat_account")
    .where("login", "in", [...logins])
    .select(["person_id", "login"])
    .execute();
  if (people.length === 0) return 0;
  await db
    .insertInto("person_admin")
    .values(people.map((p) => ({ person_id: p.person_id, granted_by: "seed" })))
    .execute();
  const missing = logins.filter((l) => !people.some((p) => p.login === l));
  if (missing.length > 0) {
    console.warn(`admin seed: no inat_account for ${missing.join(", ")} — they cannot sign in yet`);
  }
  return people.length;
}
