import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { bookkeeping } from "./session.js";

/**
 * Personal API keys (beeline-pnqr.1).
 *
 * A key is a credential a person makes for a program of their own (a script,
 * an AI assistant) to use in place of signing in. It is shown once, when it
 * is made, and the store keeps only its SHA-256 (schema/012, `api_key`), for
 * the reason a session is kept that way: a copy of the table lets nobody in.
 *
 * A key is accepted in one place, the bearer header of a request under
 * /api/v1/ (src/app/api.ts). No page reads one, and the API reads no cookie,
 * so neither credential can be used where the other belongs.
 */

/**
 * What a key may do at most. `read` sees what its person sees; `edit` may
 * also correct its person's own samples; `staff` may do what its person may
 * do as staff, for as long as they are staff.
 */
export const KEY_SCOPES = ["read", "edit", "staff"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/**
 * How long a key may last, in days. The longest is a session's own limit
 * (src/app/session.ts), so a key that leaks stops working as soon as a stolen
 * cookie would.
 */
export const KEY_LIFETIMES_DAYS = [7, 30, 90] as const;
export const KEY_NAME_MAX = 80;

/**
 * Every key starts with this, so that a key pasted somewhere it should not be
 * can be recognised for what it is, by a person or by a scanner for leaked
 * secrets.
 */
export const KEY_PREFIX = "beeline_";

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/**
 * A short name for a key that is safe to show and to record: the first 12 hex
 * digits of its SHA-256, as `sessionRef` is for a session. It finds the row
 * and grants nothing.
 */
export const keyRef = (key: string) => hashKey(key).slice(0, 12);

export interface KeyListing {
  ref: string;
  name: string;
  scope: KeyScope;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export type CreateKeyProblem = "name" | "scope" | "lifetime";

/**
 * Make a key. Returns the key itself, which is never readable again, or what
 * was wrong with the request.
 */
export async function createKey(
  db: Kysely<Database>,
  input: { inatUserId: number | bigint; name: string; scope: string; lifetimeDays: number },
): Promise<{ key: string; ref: string } | { problem: CreateKeyProblem }> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > KEY_NAME_MAX) return { problem: "name" };
  if (!(KEY_SCOPES as readonly string[]).includes(input.scope)) return { problem: "scope" };
  if (!(KEY_LIFETIMES_DAYS as readonly number[]).includes(input.lifetimeDays)) return { problem: "lifetime" };
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  await db
    .insertInto("api_key")
    .values({
      key_sha256: hashKey(key),
      inat_user_id: BigInt(input.inatUserId),
      name,
      scope: input.scope as KeyScope,
      // The lifetime is one of three whole numbers checked above, so it is
      // safe to write into the interval.
      expires_at: sql<Date>`current_timestamp + ${sql.raw(`INTERVAL ${input.lifetimeDays} DAY`)}`,
    })
    .execute();
  return { key, ref: keyRef(key) };
}

/** A person's keys, newest first, including the ones that no longer work. */
export async function listKeys(db: Kysely<Database>, inatUserId: number | bigint): Promise<KeyListing[]> {
  const rows = await db
    .selectFrom("api_key")
    .select(["key_sha256", "name", "scope", "created_at", "expires_at", "last_used_at", "revoked_at"])
    .where("inat_user_id", "=", BigInt(inatUserId))
    .orderBy("created_at", "desc")
    .orderBy("key_sha256")
    .execute();
  return rows.map((r) => ({
    ref: r.key_sha256.slice(0, 12),
    name: r.name,
    scope: r.scope,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }));
}

/**
 * Revoke one of a person's own keys, named by its reference. The owner is
 * part of the match, so a reference from somebody else's list revokes
 * nothing. Returns whether a working key was revoked.
 */
export async function revokeKey(db: Kysely<Database>, inatUserId: number | bigint, ref: string): Promise<boolean> {
  if (!/^[0-9a-f]{12}$/.test(ref)) return false;
  const result = await db
    .updateTable("api_key")
    .set({ revoked_at: sql`current_timestamp` })
    .where("inat_user_id", "=", BigInt(inatUserId))
    .where(sql<boolean>`starts_with(key_sha256, ${ref})`)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/**
 * Revoke every key of an iNat account, because the account no longer means
 * what it meant when they were made. The same reason, at the same moment, as
 * `endSessionsFor`: a key of an unlinked account resolves to nobody, but
 * linking that account to a different person would otherwise bring the key
 * back to life as that person.
 */
export async function revokeKeysFor(db: Kysely<Database>, inatUserId: number | bigint): Promise<void> {
  await db
    .updateTable("api_key")
    .set({ revoked_at: sql`current_timestamp` })
    .where("inat_user_id", "=", BigInt(inatUserId))
    .where("revoked_at", "is", null)
    .execute();
}

/**
 * Revoke the keys of accounts that are no longer linked to anyone. Unlinking
 * through /people revokes them at once; this is for an account that went
 * another way, as when promotion rebuilds `inat_account` without it. Run
 * nightly beside the session purge.
 */
export async function revokeOrphanedKeys(db: Kysely<Database>): Promise<void> {
  await db
    .updateTable("api_key")
    .set({ revoked_at: sql`current_timestamp` })
    .where("revoked_at", "is", null)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("inat_account")
            .select("inat_account.person_id")
            .whereRef("inat_account.inat_user_id", "=", "api_key.inat_user_id"),
        ),
      ),
    )
    .execute();
}

/** Who a key belongs to, as a request under /api/v1/ sees them. */
export interface KeyHolder {
  personId: number;
  inatUserId: bigint;
  login: string;
  displayName: string;
  scope: KeyScope;
  /** The key's reference (see {@link keyRef}). */
  ref: string;
  expiresAt: Date;
}

/** The last-used time is written at most this often, as a session's slide is. */
const lastUsedDue = sql<Date>`current_timestamp - INTERVAL 5 MINUTE`;

/**
 * Resolve a key to its person, or null if it does not work: unknown, revoked,
 * expired, or its iNat account no longer linked to anyone. The account join
 * is the binding, as it is for a session.
 */
export async function resolveKey(db: Kysely<Database>, key: string): Promise<KeyHolder | null> {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const hash = hashKey(key);
  const row = await db
    .selectFrom("api_key")
    .innerJoin("inat_account", "inat_account.inat_user_id", "api_key.inat_user_id")
    .innerJoin("person", "person.entity_id", "inat_account.person_id")
    .where("api_key.key_sha256", "=", hash)
    .where("api_key.revoked_at", "is", null)
    .where("api_key.expires_at", ">", sql<Date>`current_timestamp`)
    .select([
      "inat_account.person_id",
      "inat_account.inat_user_id",
      "inat_account.login",
      "person.display_name",
      "api_key.scope",
      "api_key.expires_at",
    ])
    .executeTakeFirst();
  if (row === undefined) return null;
  // Throttled, and allowed to lose: two requests carrying one key would
  // otherwise update one row at once, which DuckDB fails and does not queue
  // (see `bookkeeping`).
  await bookkeeping(() =>
    db
      .updateTable("api_key")
      .set({ last_used_at: sql`current_timestamp` })
      .where("key_sha256", "=", hash)
      .where((eb) => eb.or([eb("last_used_at", "is", null), eb("last_used_at", "<", lastUsedDue)]))
      .execute(),
  );
  return {
    personId: Number(row.person_id),
    inatUserId: BigInt(row.inat_user_id),
    login: row.login,
    displayName: row.display_name,
    scope: row.scope,
    ref: hash.slice(0, 12),
    expiresAt: row.expires_at,
  };
}

/**
 * A limit on how often one key may ask, kept in memory: the machine's CPU
 * allowance is small, and a script in a loop should be slowed before the
 * pages are. A fixed window per key, forgotten on restart, which is precise
 * enough for a limit whose only job is to stop a runaway.
 */
export function keyRateLimiter({ limit = 120, windowMs = 60_000 }: { limit?: number; windowMs?: number } = {}) {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    /** Counts one request. Returns 0 if it may go ahead, or the seconds to wait. */
    take(ref: string, now = Date.now()): number {
      // Forget windows that have ended, so the map holds only keys in use.
      if (windows.size > 1000) {
        for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
      }
      const w = windows.get(ref);
      if (w === undefined || now - w.start >= windowMs) {
        windows.set(ref, { start: now, count: 1 });
        return 0;
      }
      w.count += 1;
      return w.count <= limit ? 0 : Math.max(1, Math.ceil((w.start + windowMs - now) / 1000));
    },
  };
}
