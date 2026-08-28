import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";

/**
 * Who is signed in. Minted at OAuth sign-in for people with an inat_account
 * row (the approval gate); resolved per request from the session cookie.
 */
export interface Session {
  personId: number;
  /** iNat login: the account join is now inner, so there is always one. */
  login: string;
  /** iNat profile picture, cached at sign-in; null until they sign in again. */
  iconUrl: string | null;
  /**
   * True when this session came from BEELINE_DEV_LOGIN rather than from a
   * cookie: the resolver ignores cookies wholesale, so there is nothing for
   * signing out to end. The chrome says so instead of offering a button that
   * cannot work (Peter hit exactly that, 2026-08-23).
   */
  stub?: boolean;
}

/** Resolves a request to a session, or null for anonymous. */
export type SessionResolver = (c: Context) => Promise<Session | null>;

/** The Hono environment every app route shares. */
export type AppEnv = {
  Variables: {
    session: Session;
    /** Resolved once per request at the gate, from person_admin. */
    admin: boolean;
    /**
     * Whose records `mine` means, and whether that is somebody else
     * (beeline-oyl). Resolved at the gate, re-checked against
     * person_delegate every request.
     */
    acting: import("./acting.js").Acting;
    m: import("./messages/index.js").Messages;
  };
};

export const noSession: SessionResolver = async () => null;

export const SESSION_COOKIE = "beeline_session";
/** Sliding expiry: a session dies 30 days after its last request. */
const idleCutoff = sql<Date>`current_timestamp - INTERVAL 30 DAY`;

/**
 * Keyed on the iNat user, not the person: `entity_id` is a per-store sequence
 * draw that a rebuild or a `db:reseed` redraws, so a session holding one
 * resolved to whoever inherited the number (beeline-ten). The person is
 * looked up through `inat_account` per request instead.
 */
export async function createSession(db: Kysely<Database>, inatUserId: number): Promise<string> {
  const id = randomBytes(32).toString("hex");
  await db.insertInto("private.session").values({ id, inat_user_id: inatUserId }).execute();
  return id;
}

export async function deleteSession(db: Kysely<Database>, id: string): Promise<void> {
  await db.deleteFrom("private.session").where("id", "=", id).execute();
}

/**
 * The real resolver: session cookie → private.session row → iNat account →
 * person. The account join is the binding, so unbinding an account ends its
 * sessions and rebinding moves them — both of which are what staff mean by
 * those words (/people).
 */
export function cookieSessionResolver(db: Kysely<Database>): SessionResolver {
  return async (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (!id) return null;
    const row = await db
      .selectFrom("private.session")
      .innerJoin("inat_account", "inat_account.inat_user_id", "private.session.inat_user_id")
      .innerJoin("person", "person.entity_id", "inat_account.person_id")
      .leftJoin("private.inat_oauth_token as token", "token.inat_user_id", "private.session.inat_user_id")
      .where("private.session.id", "=", id)
      .where("last_seen_at", ">", idleCutoff)
      .select(["inat_account.person_id", "person.display_name", "inat_account.login", "token.icon_url"])
      .executeTakeFirst();
    if (row === undefined) return null;
    await db
      .updateTable("private.session")
      .set({ last_seen_at: sql`current_timestamp` })
      .where("id", "=", id)
      .execute();
    return { personId: row.person_id, login: row.login, iconUrl: row.icon_url };
  };
}

/**
 * End every session for an iNat account, because the account no longer means
 * what it meant when they were issued.
 *
 * Resolution failing is not revocation. An unbound session's `last_seen_at`
 * stops sliding, so the row never ages out — and binding that iNat user to a
 * different person revives every cookie ever issued for it, as that person,
 * with whatever rights they hold. Unbind-then-rebind is exactly what /people
 * is for, so this is the realistic path, not a contrived one.
 */
export async function endSessionsFor(db: Kysely<Database>, inatUserId: number | bigint): Promise<void> {
  await db.deleteFrom("private.session").where("inat_user_id", "=", BigInt(inatUserId)).execute();
}

/**
 * Expired sessions linger until this runs (a scheduled job, beeline-2c3.4) —
 * and so do sessions whose account has since been unbound, which resolution
 * refuses but nothing was deleting: their `last_seen_at` stops moving the
 * moment they stop resolving, so the idle cutoff never reaches them.
 */
export async function purgeIdleSessions(db: Kysely<Database>): Promise<void> {
  await db
    .deleteFrom("private.session")
    .where("last_seen_at", "<=", idleCutoff)
    .execute();
  await db
    .deleteFrom("private.session")
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("inat_account")
            .select("inat_account.person_id")
            .whereRef("inat_account.inat_user_id", "=", "private.session.inat_user_id"),
        ),
      ),
    )
    .execute();
}
