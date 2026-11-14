import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database, RevokedReason } from "../model.js";
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
 * The scopes a person may give a key they make. Decided here and used for
 * both the form's choices and the check on what the form posts, so the page
 * cannot offer less than the server accepts. Anyone signed in may make a
 * `read` key, which sees only what its person sees and changes nothing. The
 * `edit` and `staff` keys are for someone who is staff now (the owner's
 * decision, 2026-11-13): a key that corrects samples is not offered to
 * collectors, and a staff key must not be makeable by a volunteer who is later
 * given staff rights.
 */
export const offeredScopes = (staff: boolean): KeyScope[] => (staff ? ["read", "edit", "staff"] : ["read"]);

/**
 * How long a key may last, in days. The longest is the most a session can
 * last however often it is used (src/app/session.ts), so a key that leaks
 * does not work forever. A key has no idle limit and no signing out, which a
 * session has; revoking it is the way to end it early.
 */
export const KEY_LIFETIMES_DAYS = [7, 30, 90] as const;
export const KEY_NAME_MAX = 80;
/**
 * The most working keys one person may have. The limit on requests is counted
 * per key, so without this a person could multiply it by making more keys.
 */
export const KEY_LIMIT = 10;

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
  /** Login of whoever revoked it; null for a key the nightly job revoked and for keys revoked before this was kept. */
  revokedBy: string | null;
  revokedReason: RevokedReason | null;
  /** When the account it was made under was unlinked or moved to someone else; null while it stays with its person. */
  accountChangedAt: Date | null;
}

/**
 * Why a key was revoked (`api_key.revoked_reason`): its person did (`owner`),
 * a staff member did on the person's page (`staff`), staff changed the iNat
 * account it was made under (`account_changed`), or the nightly job found
 * that account linked to nobody (`account_gone`).
 */
export type { RevokedReason };

export type CreateKeyProblem = "name" | "scope" | "lifetime" | "tooMany";

/**
 * Make a key. Returns the key itself, which is never readable again, or what
 * was wrong with the request.
 */
export async function createKey(
  db: Kysely<Database>,
  input: {
    inatUserId: number | bigint;
    name: string;
    scope: string;
    lifetimeDays: number;
    /** The scopes this person may give a key ({@link offeredScopes}). */
    offered: readonly KeyScope[];
  },
): Promise<{ key: string; ref: string } | { problem: CreateKeyProblem }> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > KEY_NAME_MAX) return { problem: "name" };
  if (!(input.offered as readonly string[]).includes(input.scope)) return { problem: "scope" };
  if (!(KEY_LIFETIMES_DAYS as readonly number[]).includes(input.lifetimeDays)) return { problem: "lifetime" };
  const working = await db
    .selectFrom("api_key")
    .select(({ fn }) => fn.countAll<number>().as("n"))
    .where("inat_user_id", "=", BigInt(input.inatUserId))
    .where("revoked_at", "is", null)
    .where("expires_at", ">", sql<Date>`current_timestamp`)
    .executeTakeFirstOrThrow();
  if (Number(working.n) >= KEY_LIMIT) return { problem: "tooMany" };
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

/**
 * The keys made under an iNat account, newest first, including the ones that
 * no longer work. `current` is the keys of the account as its person holds it
 * now, which is all the person themselves may see; `all` adds the keys made
 * before the account was unlinked or moved to someone else, which belong to
 * whoever held it then (`account_changed_at`), and is for staff.
 */
export async function listKeys(
  db: Kysely<Database>,
  inatUserId: number | bigint,
  which: "current" | "all" = "current",
): Promise<KeyListing[]> {
  let query = db
    .selectFrom("api_key")
    .select([
      "key_sha256",
      "name",
      "scope",
      "created_at",
      "expires_at",
      "last_used_at",
      "revoked_at",
      "revoked_by",
      "revoked_reason",
      "account_changed_at",
    ])
    .where("inat_user_id", "=", BigInt(inatUserId));
  if (which === "current") query = query.where("account_changed_at", "is", null);
  const rows = await query.orderBy("created_at", "desc").orderBy("key_sha256").execute();
  return rows.map((r) => ({
    ref: r.key_sha256.slice(0, 12),
    name: r.name,
    scope: r.scope,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by,
    revokedReason: r.revoked_reason,
    accountChangedAt: r.account_changed_at,
  }));
}

/**
 * Revoke one key of a person, named by its reference, and record who did it
 * and why: the person themselves (`owner`, on /keys) or a staff member on the
 * person's page (`staff`). `by` is the iNat login of whoever revoked it. The
 * owner is part of the match, so a reference from somebody else's list revokes
 * nothing, and only a working key is touched (not revoked, not expired), so a second
 * revoke leaves the first one's record as it was. Returns whether a working key was revoked.
 */
export async function revokeKey(
  db: Kysely<Database>,
  inatUserId: number | bigint,
  ref: string,
  by: { login: string; reason: "owner" | "staff" },
): Promise<boolean> {
  if (!/^[0-9a-f]{12}$/.test(ref)) return false;
  const result = await db
    .updateTable("api_key")
    .set({ revoked_at: sql`current_timestamp`, revoked_by: by.login, revoked_reason: by.reason })
    .where("inat_user_id", "=", BigInt(inatUserId))
    .where(sql<boolean>`starts_with(key_sha256, ${ref})`)
    .where("revoked_at", "is", null)
    // An expired key is already dead, and its row is left as it is.
    .where("expires_at", ">", sql<Date>`current_timestamp`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/**
 * An iNat account no longer means what it meant when its keys were made: end
 * the keys that work, and mark every key of the account as belonging to
 * whoever held it before. The same reason, at the same moment, as
 * `endSessionsFor`: a key of an unlinked account resolves to nobody, but
 * linking that account to a different person would otherwise bring the key
 * back to life as that person.
 *
 * Only a working key (not revoked, not expired) is revoked, with `by`, the
 * login of the staff member who changed the account; a key that had already
 * ended keeps its own story. Every key of the account not yet marked is
 * stamped `account_changed_at`, so the next holder sees none of them, and the
 * names and use of the last holder's keys stay out of the new holder's pages.
 * One statement, so that no key is revoked and left unstamped or the reverse.
 */
export async function revokeKeysFor(db: Kysely<Database>, inatUserId: number | bigint, by: string): Promise<void> {
  const working = sql<boolean>`revoked_at IS NULL AND expires_at > current_timestamp`;
  await db
    .updateTable("api_key")
    .set({
      revoked_at: sql`CASE WHEN ${working} THEN current_timestamp ELSE revoked_at END`,
      revoked_by: sql`CASE WHEN ${working} THEN ${by} ELSE revoked_by END`,
      revoked_reason: sql`CASE WHEN ${working} THEN 'account_changed' ELSE revoked_reason END`,
      account_changed_at: sql`current_timestamp`,
    })
    .where("inat_user_id", "=", BigInt(inatUserId))
    .where("account_changed_at", "is", null)
    .execute();
}

/**
 * End the keys of accounts that are no longer linked to anyone, and mark all
 * of those accounts' keys as belonging to whoever held the account before,
 * as `revokeKeysFor` does. Unlinking through /people does it at once; this is
 * for an account that went another way, as when promotion rebuilds
 * `inat_account` without it. Only working keys are revoked (with the reason
 * `account_gone` and nobody to name); keys already ended keep their own
 * story. Run nightly beside the session purge.
 */
export async function revokeOrphanedKeys(db: Kysely<Database>): Promise<void> {
  const working = sql<boolean>`revoked_at IS NULL AND expires_at > current_timestamp`;
  await db
    .updateTable("api_key")
    .set({
      revoked_at: sql`CASE WHEN ${working} THEN current_timestamp ELSE revoked_at END`,
      revoked_by: sql`CASE WHEN ${working} THEN NULL ELSE revoked_by END`,
      revoked_reason: sql`CASE WHEN ${working} THEN 'account_gone' ELSE revoked_reason END`,
      account_changed_at: sql`current_timestamp`,
    })
    .where("account_changed_at", "is", null)
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
    /**
     * Stop counting a reference that turned out to name no working key, so
     * the map holds only real keys and cannot be filled with guesses.
     */
    forget(ref: string): void {
      windows.delete(ref);
    },
  };
}
