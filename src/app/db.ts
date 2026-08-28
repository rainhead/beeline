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
    // on the store holding everyone's live sessions.
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

    // And a column removed the same way. Every volunteer's non-expiring iNat
    // access token was stored here and never read back — the session cookie
    // authenticates a request, and sync authenticates as the pipeline rather
    // than as a volunteer (Peter, 2026-08-28). Dropping the column is what
    // actually deletes them from a store that has been collecting them since
    // the first sign-in, so it is a patch rather than a schema change alone.
    if (await columnExists("inat_oauth_token", "access_token")) {
      await conn.run(`ALTER TABLE private.inat_oauth_token DROP COLUMN access_token`);
      await conn.run(`CHECKPOINT private`);
      console.log("dropped stored iNaturalist access tokens: nothing read them");
    }

    // Sessions used to be keyed on person.entity_id, which a rebuild redraws —
    // so after a reseed each one resolved to whoever inherited its number
    // (beeline-ten). Rekeyed on the iNat user, which is stable. Dropped rather
    // than translated: rewriting the rows would mean trusting the very ids
    // that were the bug. Everyone signs in once more; last_seen_at goes with
    // the rows (beeline-dji).
    if (await columnExists("session", "person_id")) {
      // One transaction, so a crash cannot leave the store with sign-in rows
      // and no session table — and the loop above would repair it even if it
      // did.
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
 * app makes is recorded there before it reaches a row, so a decision in the
 * overlay is one a person made, whatever the table currently says.
 *
 * The question is asked **per person**, and that is the whole of this
 * function's design. It used to be asked of the store — seed nothing if the
 * table holds anyone, or if the overlay records any admin decision at all —
 * and both halves locked the sandbox out on 2026-08-28. `db:reseed` does not
 * carry person_admin (CARRIED_TABLES is staging; the comment there says the
 * rest is "a pure function of these, and promotion recomputes it", which is
 * true of everything except this), so a reseeded store rebuilds the roster
 * from the overlay alone. The only admin decision anyone had written was a
 * grant to one new staff member — so the table came back holding exactly her,
 * which satisfied *both* guards and permanently disabled the bootstrap for
 * the five people who had only ever been in it. Nobody was revoked; they were
 * simply never re-granted, and could not grant themselves because granting
 * requires being an admin.
 *
 * So: someone else's grant is none of this person's business, and only a
 * revocation of *this* person is. A `no` for them sticks across restarts,
 * which is the property the old shape was reaching for; anything else about
 * anyone else is ignored. Already holding a row is not a reason to skip the
 * rest of the list.
 *
 * Refs are matched the two ways the roster screen writes them (personRef:
 * `name:<display_name>` where the name is unique, `inat:<user_id>`
 * otherwise). A hand-curated `name:` row written against a display name that
 * promotion has since changed will not match — the rename case the applier's
 * own resolver handles — and errs toward re-granting rather than toward
 * locking someone out, which is the safe direction for a bootstrap.
 */
export async function seedAdmins(
  db: Kysely<Database>,
  logins: readonly string[],
  decisions: ReadonlyArray<{ person_ref: string; field: string; value: string }> = [],
): Promise<number> {
  if (logins.length === 0) return 0;
  // Only revocations matter. A grant in the overlay has already put the row
  // there (promotion applies it), so "already holds one" covers it without
  // this needing to know whose grant it was.
  const revoked = new Set(
    decisions.filter((d) => d.field === "admin" && d.value === "no").map((d) => d.person_ref),
  );
  const people = await db
    .selectFrom("inat_account as a")
    .innerJoin("person as p", "p.entity_id", "a.person_id")
    .leftJoin("person_admin as adm", "adm.person_id", "a.person_id")
    .where("a.login", "in", [...logins])
    .select(["a.person_id", "a.login", "a.inat_user_id", "p.display_name", "adm.person_id as holds"])
    .execute();
  const missing = logins.filter((l) => !people.some((p) => p.login === l));
  if (missing.length > 0) {
    console.warn(`admin seed: no inat_account for ${missing.join(", ")} — they cannot sign in yet`);
  }
  const grant = people.filter(
    (p) =>
      p.holds === null &&
      !revoked.has(`name:${p.display_name}`) &&
      !revoked.has(`inat:${p.inat_user_id}`),
  );
  if (grant.length === 0) return 0;
  await db
    .insertInto("person_admin")
    .values(grant.map((p) => ({ person_id: p.person_id, granted_by: "seed" })))
    .execute();
  return grant.length;
}
