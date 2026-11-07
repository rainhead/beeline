import { DuckDBInstance } from "@duckdb/node-api";
import type { Kysely } from "kysely";
import { createKysely, openDuckDb } from "../db.js";
import type { Database } from "../model.js";
import type { AppConfig } from "./config.js";

export interface AppDb {
  instance: DuckDBInstance;
  db: Kysely<Database>;
  close(): Promise<void>;
}

/** Open the database the app owns (ADR 0005: exactly one process, this one). */
export async function openAppDb(config: Pick<AppConfig, "dbPath">): Promise<AppDb> {
  const instance = await openDuckDb(config.dbPath);
  const db = createKysely(instance);
  return {
    instance,
    db,
    async close() {
      // Checkpoint the store explicitly before closing, and say so if it
      // fails. Closing the instance checkpoints too, but that path is the
      // last thing to run before exit and its failure is silent. DuckDB
      // <= 1.5.5 could fail to replay an uncheckpointed WAL and leave the
      // file unopenable; 2.0 replays it (verified 2026-11-07, beeline-c1b),
      // but a store closed with nothing in its WAL is still one file a backup
      // or a copy can take on its own. A failure here does not stop the
      // close — a checkpoint the close manages is still a checkpoint.
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
