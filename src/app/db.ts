import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import type { Kysely } from "kysely";
import { createKysely, openDuckDb } from "../db.js";
import type { Database } from "../model.js";
import type { AppConfig } from "./config.js";

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * The retired private store's tables that are carried. Not its sessions: a
 * browser holds its session under the cookie name from before the __Host-
 * prefix (beeline-73c9), which is no longer read, so no carried session could
 * be used by its own browser. It could still be used by anyone holding the
 * old id in the clear, from an older backup or the retired file, so carrying
 * one would only keep it alive. Everyone signs in once more instead.
 */
const RETIRED_TABLES = ["inat_sign_in", "person_activity", "impersonation"] as const;

/** What absorbing a retired private store carried, table by table; null when there was none. */
export type Absorbed = Record<(typeof RETIRED_TABLES)[number], number> | null;

/**
 * Carry a retired private store's rows into the main store, once (beeline-4tdh).
 *
 * Until 2026-11-05 sessions, sign-in records, last visits and the
 * impersonation log lived in a second, encrypted file (ADR 0003). The tables
 * now live in the main store (schema/012), and a deployed store gets them
 * empty from migration 0076; this fills all but the sessions (see
 * RETIRED_TABLES). It is the app's job rather than the migration's because
 * only the app holds the old store's key.
 *
 * Every insert skips a row already there and the whole copy is one
 * transaction, so a crash before the file is renamed repeats the copy on the
 * next boot without duplicating anything — the impersonation log, which has
 * no key, by matching every column. Then the file is renamed to
 * `<path>.retired` rather than deleted: it is the only copy of the rows as
 * they stood, and its key still opens it. A second store carried later (one
 * restored from an older backup) gets a name of its own rather than
 * replacing the first.
 *
 * A file that will not open — encrypted and no key given, or the wrong key —
 * throws, and the app does not start. Starting without the rows would sign
 * everyone out and lose who has been here, quietly.
 */
export async function absorbPrivateStore(
  instance: DuckDBInstance,
  opts: { path: string; key: string | null },
): Promise<Absorbed> {
  if (!existsSync(opts.path)) return null;
  const conn = await instance.connect();
  try {
    const options = ["READ_ONLY", ...(opts.key === null ? [] : [`ENCRYPTION_KEY ${quote(opts.key)}`])].join(", ");
    await conn.run(`ATTACH ${quote(opts.path)} AS retired_private (${options})`);
    const columnsOf = async (table: string): Promise<Set<string>> => {
      const found = await conn.run(
        `SELECT column_name FROM information_schema.columns
          WHERE table_catalog = 'retired_private' AND table_name = $1`,
        [table] as never,
      );
      return new Set(((await found.getRows()) as [string][]).map(([c]) => c));
    };
    const count = async (statement: string): Promise<number> => {
      const found = await conn.run(statement);
      return Number(found.rowsChanged);
    };

    const carried = { inat_sign_in: 0, person_activity: 0, impersonation: 0 };
    await conn.run("BEGIN TRANSACTION");
    try {
      // A store from before 2026-08-28 named the sign-in table for the token
      // it then held; one that never had icon_url gives none.
      let signIn = await columnsOf("inat_sign_in");
      let signInTable = "inat_sign_in";
      if (signIn.size === 0) {
        signIn = await columnsOf("inat_oauth_token");
        signInTable = "inat_oauth_token";
      }
      if (signIn.size > 0) {
        carried.inat_sign_in = await count(
          `INSERT INTO inat_sign_in (inat_user_id, login, icon_url, created_at, last_login_at)
           SELECT inat_user_id, login, ${signIn.has("icon_url") ? "icon_url" : "NULL"}, created_at, last_login_at
           FROM retired_private.${signInTable}
           ON CONFLICT DO NOTHING`,
        );
      }
      if ((await columnsOf("person_activity")).size > 0) {
        carried.person_activity = await count(
          `INSERT INTO person_activity (inat_user_id, last_seen_at)
           SELECT inat_user_id, last_seen_at FROM retired_private.person_activity
           ON CONFLICT DO NOTHING`,
        );
      }
      if ((await columnsOf("impersonation")).size > 0) {
        carried.impersonation = await count(
          `INSERT INTO impersonation (admin_login, person_name, started_at)
           SELECT r.admin_login, r.person_name, r.started_at FROM retired_private.impersonation r
           WHERE NOT EXISTS (
             SELECT 1 FROM impersonation i
              WHERE i.admin_login = r.admin_login AND i.person_name = r.person_name AND i.started_at = r.started_at)`,
        );
      }
      await conn.run("COMMIT");
    } catch (err) {
      // Neither clean-up step may hide why the copy failed.
      await conn.run("ROLLBACK").catch((e: Error) => console.error(`rollback failed: ${e.message}`));
      await conn.run("DETACH retired_private").catch((e: Error) => console.error(`detach failed: ${e.message}`));
      throw err;
    }
    await conn.run("DETACH retired_private");
    // CHECKPOINT per docs/runbooks: DuckDB < 1.6 can fail WAL replay and
    // leave the file unopenable (beeline-vyi). Before the rename, so the rows
    // are in the main file before the old one stops being found.
    await conn.run("CHECKPOINT");
    let retired = `${opts.path}.retired`;
    for (let n = 2; existsSync(retired) || existsSync(`${retired}.wal`); n++) retired = `${opts.path}.retired-${n}`;
    await rename(opts.path, retired);
    if (existsSync(`${opts.path}.wal`)) await rename(`${opts.path}.wal`, `${retired}.wal`);
    console.log(
      `absorbed the private store into the main store and renamed it ${retired}: ` +
        RETIRED_TABLES.map((t) => `${carried[t]} ${t}`).join(", "),
    );
    return carried;
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
 * Open the database the app owns (ADR 0005: exactly one process, this one).
 * Carrying a retired private store across is the caller's next step, after
 * the registry guard (src/app/main.ts).
 */
export async function openAppDb(config: Pick<AppConfig, "dbPath">): Promise<AppDb> {
  const instance = await openDuckDb(config.dbPath);
  const db = createKysely(instance);
  return {
    instance,
    db,
    async close() {
      // Checkpoint the store explicitly before closing, and say so if it
      // fails. Closing the instance checkpoints too, but that path is the
      // last thing to run before exit and its failure is silent; DuckDB
      // <= 1.5.5 can fail to replay an uncheckpointed WAL and leave the file
      // unopenable (beeline-c1b), which is the one outcome a shutdown exists
      // to avoid. A failure here does not stop the close — a checkpoint the
      // close manages is still a checkpoint.
      //
      // Every step runs whatever the one before it did: the instance close is
      // the last chance at a checkpoint, and a connection that could not be
      // opened, or a Kysely pool that would not drain, must not stand between
      // the process and it.
      try {
        const conn = await instance.connect();
        try {
          try {
            await conn.run("CHECKPOINT");
          } catch (err) {
            console.error(`checkpoint failed: ${(err as Error).message}`);
          }
        } finally {
          conn.closeSync();
        }
      } catch (err) {
        console.error(`could not open a connection to checkpoint: ${(err as Error).message}`);
      }
      try {
        await db.destroy();
      } finally {
        instance.closeSync();
      }
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
    console.warn(`admin seed: no inat_account for ${missing.map((l) => `'${l}'`).join(", ")} — they cannot sign in yet`);
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
