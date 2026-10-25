import type { DuckDBConnection } from "@duckdb/node-api";
import type { Kysely } from "kysely";
import type { Database } from "../model.js";
import { promoteObservations } from "../promote-observations.js";
import { syncINat } from "../sync-inat.js";
import { refreshPlaces } from "./jobs/registry.js";
import { withPromotionLock } from "./promotion-lock.js";

/**
 * "Check iNaturalist now" on the dashboard (beeline-yso): a volunteer who has
 * just fixed an observation on iNaturalist reads it back at once instead of at
 * 2am. Peter and Nora asked for it reviewing the dashboard on 2026-09-16.
 *
 * What it reads: every observation the person made in the active seasons
 * (this one, and last season until 1 March; schema/102), in each
 * synced project, whatever iNaturalist says changed — Peter does not trust
 * iNaturalist's updated_at to catch every edit (2026-10-16), so this is not
 * the nightly's "updated since" read narrowed to one person. A fix to a
 * settled season's observation still waits for the nightly. Each project is
 * read separately, as the nightly reads them, because trust is per project:
 * the true coordinates come back only when the query names exactly one.
 *
 * Then the nightly's own promotion, whole-store, on the app's promotion
 * connection behind the lock the unclaimed screen uses, so the two never
 * share a transaction. Skips the observation_field refresh, since each sync
 * refreshed it inside its own transaction.
 *
 * Each run records whose observations it read (sync_run.observer_user_id),
 * which is what keeps it from moving the nightly's watermark or proving
 * anybody else's observations gone (schema/120).
 */

/** How often one observer may be checked; a refusal says when they can check again. */
export const CHECK_INTERVAL_MS = 60_000;

// The last attempt per iNaturalist user, success or not, so a failing
// iNaturalist cannot be hammered either. In memory: a restart forgetting it
// costs one extra check, and when a person last checked is durable in
// sync_run. Keyed by the observer checked, so a delegate and the person they
// act for share one allowance.
const lastAttempt = new Map<string, number>();

/** When this observer may next be checked, or null if now. */
export function nextCheckAt(userId: number | bigint, now = Date.now()): Date | null {
  const at = lastAttempt.get(String(userId));
  if (at === undefined || now - at >= CHECK_INTERVAL_MS) return null;
  return new Date(at + CHECK_INTERVAL_MS);
}

/** Forget every attempt; for tests. */
export function resetCheckAttempts(): void {
  lastAttempt.clear();
}

export interface CheckOutcome {
  /** Observations read, across the projects. */
  fetched: number;
  /** Of those, how many differed from what Beeline held. */
  changed: number;
  /** Time spent reading from iNaturalist, and promoting; logged to size the interval. */
  fetchMs: number;
  promoteMs: number;
}

export interface CheckOptions {
  userId: number;
  projects: readonly number[];
  token: () => Promise<string>;
  sampleOverlayPath?: string;
  fetchImpl?: typeof fetch;
  /** Between pages of one project; the sync's own default otherwise. */
  pageDelayMs?: number;
  now?: () => number;
}

export async function checkObserver(conn: DuckDBConnection, opts: CheckOptions): Promise<CheckOutcome> {
  lastAttempt.set(String(opts.userId), (opts.now ?? Date.now)());
  return withPromotionLock(async () => {
    const started = Date.now();
    const [[seasonStart]] = (await (
      await conn.run("SELECT CAST(active_since AS VARCHAR) FROM season")
    ).getRows()) as [[string]];
    const token = await opts.token();
    const tokenMs = Date.now() - started;
    let fetched = 0;
    let changed = 0;
    let requestMs = 0;
    let refreshMs = 0;
    for (const projectId of opts.projects) {
      const r = await syncINat(conn, {
        projectId,
        userId: opts.userId,
        d1: seasonStart,
        token,
        fetchImpl: opts.fetchImpl,
        pageDelayMs: opts.pageDelayMs,
        // A click is waiting: fail in seconds, not the nightly's minute.
        requestTimeoutMs: 20_000,
      });
      fetched += r.fetched;
      changed += r.newLoads;
      requestMs += r.requestMs;
      refreshMs += r.refreshMs;
    }
    const placesStarted = Date.now();
    // A new observation can name a place the cache has never seen, and
    // minting it before the fetch would give it no state (registry.ts).
    await refreshPlaces(conn, { fetchImpl: opts.fetchImpl });
    const read = Date.now();
    const placesMs = read - placesStarted;
    // Short retries: someone is waiting, and the nightly's 1, 5 and 15 s
    // would hold the page for 21 s on a conflict with a sample edit.
    await promoteObservations(conn, {
      sampleOverlayPath: opts.sampleOverlayPath,
      refreshFields: false,
      retry: { delaysMs: [1_000, 3_000] },
    });
    const outcome = { fetched, changed, fetchMs: read - started, promoteMs: Date.now() - read };
    console.log(
      `[inat check] user ${opts.userId}: ${fetched} read, ${changed} changed; ` +
        `token ${tokenMs} ms, requests ${requestMs} ms, field refresh ${refreshMs} ms, places ${placesMs} ms, ` +
        `promotion ${outcome.promoteMs} ms`,
    );
    return outcome;
  });
}

/** When this observer was last checked from the dashboard, if ever. */
export async function lastChecked(db: Kysely<Database>, userId: number | bigint): Promise<Date | null> {
  const row = await db
    .selectFrom("sync_run")
    .select(({ fn }) => fn.max("completed_at").as("at"))
    .where("observer_user_id", "=", BigInt(userId))
    .executeTakeFirst();
  return row?.at ?? null;
}
