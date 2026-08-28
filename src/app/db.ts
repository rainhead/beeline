import { DuckDBInstance } from "@duckdb/node-api";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { createKysely } from "../db.js";
import type { Database } from "../model.js";
import type { AppConfig } from "./config.js";

const PRIVATE_SCHEMA_DIR = fileURLToPath(new URL("../../schema/private/", import.meta.url));
/** The one home of the session DDL, re-applied on its own by the patch below. */
const SESSION_SCHEMA = "020_session.sql";

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

    const count = async (sql: string, params: unknown[]) => {
      const found = await conn.run(sql, params as never);
      const [[n]] = (await found.getRows()) as [[bigint]];
      return n > 0n;
    };
    const tableExists = (table: string) =>
      count(
        `SELECT count(*) FROM information_schema.tables
          WHERE table_catalog = 'private' AND table_name = $1`,
        [table],
      );
    const columnExists = (table: string, column: string) =>
      count(
        `SELECT count(*) FROM information_schema.columns
          WHERE table_catalog = 'private' AND table_name = $1 AND column_name = $2`,
        [table, column],
      );
    const readDdl = (file: string) => readFile(join(PRIVATE_SCHEMA_DIR, file), "utf8");
    const apply = async (ddl: string) => {
      await conn.run(`USE private`);
      try {
        await conn.run(ddl);
      } finally {
        await conn.run(`USE memory`);
      }
    };

    // Per table, not all-or-nothing. This store outlives the blow-away era, so
    // it is met in more states than "fresh" and "current": the patch below
    // drops a table, and a crash in the wrong microsecond would leave the
    // store holding some of its tables and not others. Creating whatever is
    // missing repairs every one of those states — where a single "is it
    // fresh?" probe sent a half-patched store down the fresh path to re-run
    // DDL for a table that still existed, which is an unrecoverable boot crash
    // on the store holding the OAuth tokens.
    const files = (await readdir(PRIVATE_SCHEMA_DIR)).filter((f) => f.endsWith(".sql")).sort();
    let created = false;
    for (const file of files) {
      const ddl = await readDdl(file);
      const table = /CREATE TABLE (\w+)/.exec(ddl)?.[1];
      if (table === undefined || (await tableExists(table))) continue;
      await apply(ddl);
      created = true;
    }
    // CHECKPOINT per docs/runbooks: DuckDB < 1.6 can fail WAL replay after DDL
    // and leave the file unopenable (beeline-vyi).
    if (created) await conn.run(`CHECKPOINT private`);

    // Columns added to a table that already exists are patched in rather than
    // rebuilt, since the rows are live.
    if (!(await columnExists("inat_oauth_token", "icon_url"))) {
      await conn.run(`ALTER TABLE private.inat_oauth_token ADD COLUMN icon_url TEXT`);
      await conn.run(`CHECKPOINT private`);
    }

    // Sessions used to be keyed on person.entity_id, which a rebuild redraws —
    // so after a reseed each one resolved to whoever inherited its number
    // (beeline-ten). Rekeyed on the iNat user, which is stable. Dropped rather
    // than translated: rewriting the rows would mean trusting the very ids
    // that were the bug. Everyone signs in once more, their OAuth tokens
    // untouched; last_seen_at goes with the rows (beeline-dji).
    if (await columnExists("session", "person_id")) {
      // One transaction, so a crash cannot leave the store with tokens and no
      // session table — and the loop above would repair it even if it did.
      await conn.run(`BEGIN TRANSACTION`);
      try {
        await conn.run(`DROP TABLE private.session`);
        await apply(await readDdl(SESSION_SCHEMA));
        await conn.run(`COMMIT`);
      } catch (err) {
        await conn.run(`ROLLBACK`);
        throw err;
      }
      await conn.run(`CHECKPOINT private`);
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
 * "Nobody has granted anything" cannot be read off person_admin alone. An
 * empty table means either a store that has never been touched or one whose
 * last admin was deliberately revoked, and re-seeding the second case would
 * undo that decision at the next restart — the one thing a roster screen must
 * not do. The overlay is what tells them apart: every grant and revocation the
 * app makes is recorded there before it reaches a row, so an admin row in the
 * overlay means the question has been answered by a person, whatever the table
 * currently says.
 *
 * Seeding is therefore once per store, and the way back in after revoking
 * everyone is to remove the admin rows from the overlay (or set
 * BEELINE_ADMIN_LOGINS), not to restart and hope.
 */
export async function seedAdmins(
  db: Kysely<Database>,
  logins: readonly string[],
  decisions: ReadonlyArray<{ field: string }> = [],
): Promise<number> {
  if (logins.length === 0) return 0;
  if (decisions.some((d) => d.field === "admin")) return 0;
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
