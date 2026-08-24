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
  /** iNat login (or display name for the rare accountless person). */
  login: string;
  /** iNat profile picture, cached at sign-in; null for accountless people. */
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
export type AppEnv = { Variables: { session: Session; m: import("./messages/index.js").Messages } };

export const noSession: SessionResolver = async () => null;

export const SESSION_COOKIE = "beeline_session";
/** Sliding expiry: a session dies 30 days after its last request. */
const idleCutoff = sql<Date>`current_timestamp - INTERVAL 30 DAY`;

export async function createSession(db: Kysely<Database>, personId: number): Promise<string> {
  const id = randomBytes(32).toString("hex");
  await db.insertInto("private.session").values({ id, person_id: personId }).execute();
  return id;
}

export async function deleteSession(db: Kysely<Database>, id: string): Promise<void> {
  await db.deleteFrom("private.session").where("id", "=", id).execute();
}

/** The real resolver: session cookie → private.session row → person. */
export function cookieSessionResolver(db: Kysely<Database>): SessionResolver {
  return async (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (!id) return null;
    const row = await db
      .selectFrom("private.session")
      .innerJoin("person", "person.entity_id", "private.session.person_id")
      .leftJoin("inat_account", "inat_account.person_id", "person.entity_id")
      .leftJoin("private.inat_oauth_token as token", "token.inat_user_id", "inat_account.inat_user_id")
      .where("private.session.id", "=", id)
      .where("last_seen_at", ">", idleCutoff)
      .select(["private.session.person_id", "person.display_name", "inat_account.login", "token.icon_url"])
      .executeTakeFirst();
    if (row === undefined) return null;
    await db
      .updateTable("private.session")
      .set({ last_seen_at: sql`current_timestamp` })
      .where("id", "=", id)
      .execute();
    return { personId: row.person_id, login: row.login ?? row.display_name, iconUrl: row.icon_url };
  };
}

/** Expired sessions linger until this runs (a scheduled job, beeline-2c3.4). */
export async function purgeIdleSessions(db: Kysely<Database>): Promise<void> {
  await db
    .deleteFrom("private.session")
    .where("last_seen_at", "<=", idleCutoff)
    .execute();
}
