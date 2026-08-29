import { DuckDBConnection, DuckDBInstance, listValue } from "@duckdb/node-api";
import { pathToFileURL } from "node:url";
import { DEFAULT_DB } from "./person-change.js";

/**
 * Fill the inat_place cache (schema/065) for every place an observation
 * names and the store has never been told about.
 *
 * An observation carries `place_ids` and nothing else usable: `place_guess`
 * is free text a phone wrote. So the only route from an observation to a
 * state — and therefore to an atlas, since atlas_region keys on the
 * two-letter code — runs through knowing what a place id means (beeline-2yt).
 *
 * Unauthenticated on purpose. Places are public reference data; there is no
 * private projection of a place, so a token would buy nothing and this is
 * the one fetch in the codebase that has no business holding one. (Contrast
 * src/sync-inat.ts, where anonymous is a silent-degradation hazard because it
 * withholds private coordinates.)
 *
 * Incremental by construction: `inat_place_uncached` (schema/107) is the
 * definition of what is missing, and it is a view so the fetcher and anything
 * asking "is the cache complete" read the same one. A cold corpus is ~2,556
 * ids, about 86 requests.
 */

/** iNat's own cap on a comma-separated id path is 30 (the API skill's note). */
const IDS_PER_REQUEST = 30;

export interface FetchPlacesOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  /** The public API allows 100 req/min; stay well under, as sync does. */
  requestDelayMs?: number;
  requestTimeoutMs?: number;
  /** Cap the work in one run — the nightly job's SLA, not a correctness knob. */
  maxRequests?: number;
}

export interface FetchPlacesResult {
  missing: number;
  requested: number;
  cached: number;
  /** Ids asked for that iNat did not return — merged or deleted upstream. */
  unresolved: number[];
}

interface InatPlace {
  id: number;
  name?: string;
  admin_level?: number | null;
  ancestor_place_ids?: number[] | null;
}

export async function fetchPlaces(
  conn: DuckDBConnection,
  opts: FetchPlacesOptions = {},
): Promise<FetchPlacesResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? "https://api.inaturalist.org/v1";
  const delay = opts.requestDelayMs ?? 1_100;

  const missingRows = (await (
    await conn.run("SELECT inat_place_id FROM inat_place_uncached ORDER BY inat_place_id")
  ).getRows()) as Array<[bigint | number]>;
  const missing = missingRows.map(([id]) => Number(id));

  const batches: number[][] = [];
  for (let i = 0; i < missing.length; i += IDS_PER_REQUEST) {
    batches.push(missing.slice(i, i + IDS_PER_REQUEST));
  }
  const planned = opts.maxRequests === undefined ? batches : batches.slice(0, opts.maxRequests);

  let cached = 0;
  const unresolved: number[] = [];
  for (const [n, batch] of planned.entries()) {
    if (n > 0 && delay > 0) await new Promise((r) => setTimeout(r, delay));
    const url = `${apiBase}/places/${batch.join(",")}`;
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 30_000),
    });
    if (!response.ok) {
      throw new Error(`iNat API ${response.status} on /places for ${batch.length} ids starting ${batch[0]}`);
    }
    const body = (await response.json()) as { results?: unknown };
    if (!Array.isArray(body.results)) {
      // The same stance sync takes: a malformed page is a failure, never
      // "zero places" — silently caching nothing would leave every sample
      // in the batch stateless with no error to explain it.
      throw new Error(`iNat API returned no results array on /places starting ${batch[0]}`);
    }
    const places = body.results as InatPlace[];
    const returned = new Set<number>();
    // One transaction per batch: a run interrupted halfway has cached what it
    // fetched, and the next run asks for the rest — the view is the ledger.
    await conn.run("BEGIN TRANSACTION");
    try {
      for (const place of places) {
        if (typeof place.id !== "number" || typeof place.name !== "string") continue;
        returned.add(place.id);
        await conn.run(
          `INSERT INTO inat_place (inat_place_id, name, admin_level, ancestor_place_ids)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (inat_place_id) DO UPDATE SET
             name = excluded.name,
             admin_level = excluded.admin_level,
             ancestor_place_ids = excluded.ancestor_place_ids,
             fetched_at = now()`,
          [
            place.id,
            place.name,
            place.admin_level ?? null,
            // DuckDB binds a LIST as a value, not a JS array.
            place.ancestor_place_ids ? listValue(place.ancestor_place_ids) : null,
          ],
        );
        cached += 1;
      }
      await conn.run("COMMIT");
    } catch (err) {
      await conn.run("ROLLBACK");
      throw err;
    }
    // An id iNat will not resolve is recorded rather than retried forever:
    // places get merged and deleted upstream, and an observation keeps naming
    // the old id. Reported, not cached — caching a placeholder would make
    // observation_place answer confidently about a place that is gone.
    for (const id of batch) if (!returned.has(id)) unresolved.push(id);
  }

  return { missing: missing.length, requested: planned.length, cached, unresolved };
}

// CLI: pnpm inat:fetch-places [db]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? DEFAULT_DB;
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const result = await fetchPlaces(conn);
  conn.closeSync();
  console.log(JSON.stringify(result, null, 2));
  if (result.unresolved.length > 0) {
    console.warn(
      `${result.unresolved.length} place ids iNaturalist did not return (merged or deleted upstream): ` +
        result.unresolved.slice(0, 20).join(", ") +
        (result.unresolved.length > 20 ? ", …" : ""),
    );
  }
}
