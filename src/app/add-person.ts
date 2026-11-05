import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";

/**
 * Adding a person by their iNaturalist account (beeline-2c3.33). Promotion
 * makes people from records, and /unclaimed admits somebody whose records are
 * waiting, so somebody who collects nothing — staff, an intern, a coordinator
 * — had no way in but a row in ingest/person-overlay.csv, a deploy and
 * `pnpm person:apply` with the app stopped. On the first two days after
 * cutover that left a staff member turned away at sign-in until a pull
 * request was merged. This is the form for it, on /people/new, writing the
 * same overlay rows through the same path as every other person decision.
 */

/** An iNaturalist account, as its public profile describes it. */
export interface InatProfile {
  id: number;
  login: string;
  /** The profile's name, where it has one. */
  name: string | null;
  iconUrl: string | null;
  observations: number;
  joined: Date | null;
}

/** Looks an account up on iNaturalist: by login or by numeric id. Null when there is no such account. */
export type InatProfiles = (loginOrId: string) => Promise<InatProfile | null>;

/**
 * The account a staff member typed, in whichever form they had to hand: a
 * login, `@login`, or a profile link (`/people/<login or id>`, `/users/<id>`).
 * Null for anything else. A login is letters, digits, `_` and `-`, beginning
 * with a letter (src/app/roster.ts, parsePersonHandle); an id is digits.
 */
export function parseInatAccount(raw: string): string | null {
  let s = raw.trim();
  if (s === "") return null;
  const link = /^(?:https?:\/\/)?(?:www\.)?inaturalist\.org\/(?:people|users)\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(s);
  if (link) {
    // A link with broken percent-encoding names no account; decodeURIComponent would throw on it.
    try {
      s = decodeURIComponent(link[1]!);
    } catch {
      return null;
    }
  }
  if (s.startsWith("@")) s = s.slice(1);
  if (/^\d{1,12}$/.test(s)) return s;
  if (/^[a-z][a-z0-9_-]{0,39}$/i.test(s)) return s.toLowerCase();
  return null;
}

/** The public profile, read from iNaturalist's API; a short timeout, since somebody is waiting on the form. */
export function inatProfiles(fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): InatProfiles {
  return async (loginOrId) => {
    const response = await fetchImpl(`https://api.inaturalist.org/v1/users/${encodeURIComponent(loginOrId)}`, {
      headers: { accept: "application/json", "user-agent": "Beeline (melittologist.org)" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`iNaturalist profile lookup failed: ${response.status}`);
    const body = (await response.json()) as {
      results?: Array<{
        id: number;
        login: string;
        name?: string | null;
        icon_url?: string | null;
        observations_count?: number;
        created_at?: string | null;
      }>;
    };
    const u = body.results?.[0];
    if (u === undefined) return null;
    return {
      id: u.id,
      login: u.login,
      name: u.name?.trim() ? u.name.trim() : null,
      iconUrl: u.icon_url ?? null,
      observations: u.observations_count ?? 0,
      joined: u.created_at ? new Date(u.created_at) : null,
    };
  };
}

/** Somebody who signed in with iNaturalist and was turned away, because no person holds their account. */
export interface TurnedAway {
  inat_user_id: number;
  login: string;
  first_tried: Date;
  last_tried: Date;
}

/**
 * Everybody turned away at sign-in, most recent first. Sign-in records each
 * account before it asks whether anyone holds it (src/app/auth.tsx), so this
 * is that record less the accounts somebody now holds.
 */
export async function turnedAway(db: Kysely<Database>): Promise<TurnedAway[]> {
  const found = await sql<{ inat_user_id: number | bigint; login: string; created_at: Date; last_login_at: Date }>`
    SELECT s.inat_user_id, s.login, s.created_at, s.last_login_at
    FROM inat_sign_in s
    WHERE NOT EXISTS (SELECT 1 FROM inat_account a WHERE a.inat_user_id = s.inat_user_id)
    ORDER BY s.last_login_at DESC`.execute(db);
  return found.rows.map((r) => ({
    inat_user_id: Number(r.inat_user_id),
    login: r.login,
    first_tried: r.created_at,
    last_tried: r.last_login_at,
  }));
}

/** What Beeline already knows about an account, which decides what the form can offer. */
export type AccountStanding =
  | { kind: "held"; personId: number; name: string; handle: string }
  | { kind: "waiting"; records: number }
  | { kind: "free"; triedToSignIn: Date | null };

/**
 * Whether somebody already holds the account, or it has collection records
 * waiting on /unclaimed — in which case adding them there is the right path,
 * since it also makes those records into samples at once — or neither.
 */
export async function accountStanding(db: Kysely<Database>, uid: number): Promise<AccountStanding> {
  const held = await db
    .selectFrom("inat_account")
    .innerJoin("person", "person.entity_id", "inat_account.person_id")
    .select(["person.entity_id", "person.display_name", "inat_account.login"])
    .where("inat_account.inat_user_id", "=", BigInt(uid))
    .executeTakeFirst();
  if (held !== undefined) {
    return { kind: "held", personId: held.entity_id, name: held.display_name, handle: held.login ?? String(held.entity_id) };
  }
  const waiting = await sql<{ n: number | bigint }>`
    SELECT count(*) AS n FROM unclaimed_record WHERE user_id = ${uid}`.execute(db);
  const records = Number(waiting.rows[0]?.n ?? 0);
  if (records > 0) return { kind: "waiting", records };
  const tried =
    (
      await sql<{ last_login_at: Date }>`
        SELECT last_login_at FROM inat_sign_in WHERE inat_user_id = ${uid}`.execute(db)
    ).rows[0]?.last_login_at ?? null;
  return { kind: "free", triedToSignIn: tried };
}
