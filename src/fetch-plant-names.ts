import type { DuckDBConnection } from "@duckdb/node-api";
import { pathToFileURL } from "node:url";
import { openDuckDb } from "./db.js";
import { DEFAULT_DB } from "./person-change.js";
import { thenRefreshPlantCommonNames } from "./plant-common-names.js";

/**
 * Ask iNaturalist which taxon each name of the old plant list is
 * (schema/067, schema/111, beeline-rfkj.2). One request per normalised name
 * and expected rank, answered whatever the answer, so a name with no match is
 * asked about once and not every night.
 *
 * WHICH ENDPOINT. API v1 `/v1/taxa?q=<name>&taxon_id=47126&is_active=any`,
 * restricted to the ranks the name's shape allows. v1 and not v2, found by
 * calling both on 2026-11-14: v2 gives the same `matched_term` and
 * `current_synonymous_taxon_ids` with a small `fields=` list, but it refuses
 * `is_active=any` (422, only true or false), and without that it returns no
 * retired taxon, so a name iNaturalist has since renamed (Aster chilensis,
 * Mentha piperita) finds only its replacement under the wrong term or
 * nothing. v1 answers a few kilobytes for a name, which is small enough.
 * `matched_term` is what makes a retired name findable: it is the name the
 * search matched, which for a hit on an older name is that older name.
 *
 * WHAT IS KEPT. Every hit with a matched_term, as given (plant_name_lookup_hit),
 * and the replacements a retired hit carried. Which hits count is decided on
 * read (plant_name_hit_current): the name, or an older name of the taxon, at
 * an allowed rank. A page is 30 hits, and every page is read until the
 * results run out, because a second taxon of the name on a later page is what
 * makes it ambiguous (one name of the 1,404 had more than 30 on 2026-11-14,
 * Aster, with 48). `total_results` records how many there were, and
 * `read_in_full` whether the page cap stopped the reading first, in which
 * case the name is given no taxon. The search also asks for the
 * fallback ranks of a genus-shaped name (section, subgenus, supertribe; see
 * plant_expected_rank).
 *
 * WHEN A REQUEST FAILS. A 400, 414 or 422 is iNaturalist refusing this query
 * (measured 2026-11-14: 422 for a query of 3,000 characters, 414 for 9,000):
 * the lookup is recorded at once as one that could not be asked (answered =
 * false), which stops it failing the step, and the name is asked again after
 * 30 days. Every other failure is transient, including the other 4xx (a 401,
 * 403, 404 or 410 says something about the client or the endpoint, not about
 * the name, and would come back for every name alike): nothing is recorded,
 * the name keeps any answer it had, and it is asked again next run, the step
 * being marked failed. A 429 stops the run. The worklist is in name order and
 * three transient failures in a row stop the run, so names that fail at the
 * head of the alphabet hold back the rest until iNaturalist answers them;
 * none does today.
 *
 * PACE AND BUDGET. A request about every 1.1 seconds, no token, as
 * src/fetch-inat-taxa.ts does; measured on 2026-11-14, 1,404 names took 29
 * minutes (1.2 seconds each). The nightly gives it 300 names, about six
 * minutes, so the first fill takes five nights; staff can run it at once from
 * /jobs (the plant-names job), as many times as it takes. The ids it finds join the taxon cache's worklist
 * (inat_taxon_uncached) and are read with their ancestors by the next run of
 * src/fetch-inat-taxa.ts, which the same job runs once the names are done.
 */

export const TAXA_SEARCH_URL = "https://api.inaturalist.org/v1/taxa";
/** Plantae. */
const PLANTAE = 47126;
const HITS_PER_REQUEST = 30;
const FAILURES_IN_A_ROW = 3;

export interface FetchPlantNamesOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  requestDelayMs?: number;
  requestTimeoutMs?: number;
  /** Requests made in this run, a name's later pages included: the job's budget, not a correctness knob. */
  maxRequests?: number;
  signal?: AbortSignal;
  /** Told of every request error, so a job's log keeps the ones its one-line summary leaves out. */
  log?: (message: string) => void;
}

export interface FetchPlantNamesResult {
  /** Names on the worklist when the run began. */
  unlooked: number;
  /** Requests made: a name with more than 30 results takes one for each page. */
  requested: number;
  /** Lookups stored, answered with a hit or without. */
  stored: number;
  /** Names iNaturalist refused with a 4xx status other than 429, recorded as could not be asked (asked again after 30 days). */
  refused: number;
  errors: string[];
  /** True when the cap or a deadline left names unasked. */
  stoppedEarly: boolean;
  /** True when iNaturalist answered 429: the job then makes no further call to it, taxa included. */
  rateLimited: boolean;
}

interface HitJson {
  id?: number;
  name?: string;
  rank?: string;
  is_active?: boolean;
  matched_term?: string | null;
  current_synonymous_taxon_ids?: number[] | null;
}

interface PageJson {
  total_results?: number;
  results?: HitJson[];
}

/** Pages read for one name at most: 300 results, far more than any name in the list has had. */
const MAX_PAGES = 10;

/** The statuses that are iNaturalist refusing this one query, not trouble with the run (see the header). */
const REFUSAL_STATUSES = new Set([400, 414, 422]);

export async function fetchPlantNames(
  conn: DuckDBConnection,
  opts: FetchPlantNamesOptions = {},
): Promise<FetchPlantNamesResult> {
  // The lookups decide which taxon each list entry is, and so what a host is called (schema/115).
  return thenRefreshPlantCommonNames(conn, () => fetchPlantNamesUnrefreshed(conn, opts));
}

async function fetchPlantNamesUnrefreshed(
  conn: DuckDBConnection,
  opts: FetchPlantNamesOptions,
): Promise<FetchPlantNamesResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? TAXA_SEARCH_URL;
  const delay = opts.requestDelayMs ?? 1_100;
  const cap = opts.maxRequests ?? Infinity;

  const todo = (
    (await (
      await conn.run("SELECT name_key, expected_rank FROM plant_name_unlooked ORDER BY name_key, expected_rank")
    ).getRows()) as Array<[string, string]>
  ).map(([nameKey, expectedRank]) => ({ nameKey, expectedRank }));
  const ranksOf = new Map<string, string[]>();
  for (const [expected, inat] of (await (
    await conn.run("SELECT expected_rank, inat_rank FROM plant_expected_rank")
  ).getRows()) as Array<[string, string]>) {
    ranksOf.set(expected, [...(ranksOf.get(expected) ?? []), inat]);
  }

  const result: FetchPlantNamesResult = { unlooked: todo.length, requested: 0, stored: 0, refused: 0, errors: [], stoppedEarly: false, rateLimited: false };
  const fail = (message: string) => {
    result.errors.push(message);
    opts.log?.(message);
  };
  let failuresInARow = 0;
  names: for (const { nameKey, expectedRank } of todo) {
    // Every page is read before anything is written, and the name's hits and lookup row are then replaced
    // in one transaction. So a name asked again (its taxon retired, or its refusal 30 days old) keeps its
    // old answer through a failed request, a 429, the cap or a shutdown, and a name whose later page fails
    // is not recorded as answered.
    let total = 0;
    let seen = 0;
    let readInFull = false;
    let failure: string | null = null;
    let refusedWith: number | null = null;
    const hits: HitJson[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (result.requested >= cap) {
        result.stoppedEarly = true;
        break names;
      }
      if (result.requested > 0 && delay > 0) await new Promise((r) => setTimeout(r, delay));
      // After the pause, so a shutdown or a deadline during it starts no request.
      if (opts.signal?.aborted) {
        result.stoppedEarly = true;
        break names;
      }
      const url =
        `${apiBase}?q=${encodeURIComponent(nameKey)}&taxon_id=${PLANTAE}&is_active=any` +
        `&rank=${encodeURIComponent((ranksOf.get(expectedRank) ?? [expectedRank]).join(","))}` +
        `&per_page=${HITS_PER_REQUEST}&page=${page}&locale=en`;
      result.requested += 1;
      let body = null as PageJson | null;
      try {
        const timeout = AbortSignal.timeout(opts.requestTimeoutMs ?? 30_000);
        const response = await fetchImpl(url, {
          headers: { Accept: "application/json" },
          signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
        });
        body = (await response.json().catch(() => null)) as PageJson | null;
        if (!response.ok || !Array.isArray(body?.results)) {
          failure = `${response.status}`;
          // The API is asking us to stop: this run does, and the job makes no more calls to iNaturalist.
          if (response.status === 429) {
            fail(`iNat API 429 on /taxa for "${nameKey}"`);
            result.stoppedEarly = true;
            result.rateLimited = true;
            break names;
          }
          // A refusal of this query, not a fault of the run (see the header); any other status is transient.
          if (REFUSAL_STATUSES.has(response.status)) refusedWith = response.status;
        }
      } catch (err) {
        if (opts.signal?.aborted) {
          result.stoppedEarly = true;
          break names;
        }
        failure = (err as Error).message;
      }
      if (failure !== null) break;
      const results = body!.results!;
      total = body!.total_results ?? results.length;
      seen += results.length;
      hits.push(...results);
      // Every page, to the end: a second taxon of the name on a later page is what makes it ambiguous,
      // and the views judge only the hits stored. Few names have a second page (Aster, on 2026-11-14).
      if (results.length < HITS_PER_REQUEST || seen >= total) {
        readInFull = true;
        break;
      }
    }
    if (refusedWith !== null) {
      // A refusal (400, 414 or 422) is iNaturalist's answer about the name: recorded at once as one that
      // could not be asked, so it stops failing the step, and asked again after 30 days (plant_name_unlooked).
      // A name that was refused before and is refused again gets a new looked_up_at, so it waits another 30 days.
      opts.log?.(`iNat API ${refusedWith} on /taxa for "${nameKey}": recorded as could not be asked`);
      await recordAnswer(conn, nameKey, expectedRank, [], 0, false, false);
      result.refused += 1;
      failuresInARow = 0;
      continue;
    }
    if (failure !== null) {
      // A 5xx, a network error or a timeout is transient: nothing is recorded, so the name keeps any previous
      // answer and is asked again next run. A name that was already waiting on a re-ask (its old lookup is
      // more than 30 days old, or its taxon was found retired) is therefore asked once each run, one request,
      // and fails the step each night until iNaturalist answers; it is never retried within a run.
      fail(`iNat API ${failure} on /taxa for "${nameKey}"`);
      failuresInARow += 1;
      if (failuresInARow >= FAILURES_IN_A_ROW) {
        result.stoppedEarly = true;
        break;
      }
      continue;
    }
    failuresInARow = 0;
    // Recorded as answered either way, so the name is not asked again every night; a lookup the page cap
    // cut short reads as 'too many results' and gives the name no taxon (plant_name_resolution).
    await recordAnswer(conn, nameKey, expectedRank, hits, total, readInFull, true);
    result.stored += 1;
  }
  return result;
}

/** Replace the name's hits and its lookup row with the answer (or, where answered is false, the refusal), in one transaction. */
async function recordAnswer(
  conn: DuckDBConnection,
  nameKey: string,
  expectedRank: string,
  hits: HitJson[],
  total: number,
  readInFull: boolean,
  answered: boolean,
): Promise<void> {
  await conn.run("BEGIN TRANSACTION");
  try {
    await clear(conn, nameKey, expectedRank);
    await storeHits(conn, nameKey, expectedRank, hits);
    await conn.run(
      "INSERT INTO plant_name_lookup (name_key, expected_rank, total_results, read_in_full, answered) VALUES ($1, $2, $3, $4, $5)",
      [nameKey, expectedRank, total, readInFull, answered],
    );
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}

/** Take out whatever an earlier or half-finished lookup of the name left, so it is asked from nothing. */
async function clear(conn: DuckDBConnection, nameKey: string, expectedRank: string): Promise<void> {
  for (const t of ["plant_name_lookup_hit_replacement", "plant_name_lookup_hit", "plant_name_lookup"]) {
    await conn.run(`DELETE FROM ${t} WHERE name_key = $1 AND expected_rank = $2`, [nameKey, expectedRank]);
  }
}

async function storeHits(conn: DuckDBConnection, nameKey: string, expectedRank: string, hits: HitJson[]): Promise<void> {
  const kept = hits.filter(
    (h) =>
      typeof h.id === "number" && typeof h.name === "string" && typeof h.rank === "string" &&
      typeof h.matched_term === "string" && h.matched_term !== "",
  );
  for (const h of kept) {
    await conn.run(
      `INSERT INTO plant_name_lookup_hit (name_key, expected_rank, inat_taxon_id, name, rank, is_active, matched_term)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [nameKey, expectedRank, h.id!, h.name!, h.rank!, h.is_active !== false, h.matched_term!],
    );
    for (const r of new Set((h.current_synonymous_taxon_ids ?? []).map(Number))) {
      await conn.run(
        `INSERT INTO plant_name_lookup_hit_replacement (name_key, expected_rank, inat_taxon_id, replacement_taxon_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [nameKey, expectedRank, h.id!, r],
      );
    }
  }
}

/** Names asked about in one night: about six minutes at the pace kept. */
export const NIGHTLY_PLANT_NAME_REQUESTS = 300;

// CLI: pnpm inat:fetch-plant-names [db] — all of the worklist, about 29 minutes cold.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const instance = await openDuckDb(process.argv[2] ?? DEFAULT_DB);
  const conn = await instance.connect();
  const started = Date.now();
  const result = await fetchPlantNames(conn);
  conn.closeSync();
  console.log(JSON.stringify({ ...result, seconds: Math.round((Date.now() - started) / 1000) }, null, 2));
  if (result.errors.length > 0) {
    console.error(result.errors.join("\n"));
    process.exitCode = 1;
  }
}
