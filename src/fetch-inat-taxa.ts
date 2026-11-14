import { DuckDBConnection } from "@duckdb/node-api";
import { pathToFileURL } from "node:url";
import { openDuckDb } from "./db.js";
import { DEFAULT_DB } from "./person-change.js";

/**
 * Fill and refresh the iNaturalist taxon cache (schema/066, beeline-rfkj.1):
 * every taxon a sample or an observation names as its floral host, the
 * ancestors of each, and whatever replaced the ones iNaturalist has retired.
 *
 * WHICH ENDPOINT. API v2 `/taxa/{ids}` with an explicit `fields=` list. It
 * returns retired taxa (is_active false, with current_synonymous_taxon_ids),
 * each taxon's ancestors with name, rank, rank_level, parent and common name
 * in the same response, and the English name preferred for Oregon when asked
 * with preferred_place_id=10 and locale=en. A response for 30 taxa is a few
 * tens of kilobytes, where v1 sent 512 KB for 10 (it returns whole records).
 * Two things the response does not do, found by calling it: `ancestor_ids`
 * leaves the taxon itself out (so the self row is added here), and the
 * `ancestors` array leaves out the root, Life (48460), though `ancestor_ids`
 * names it; Life is therefore fetched by id like any other missing taxon.
 *
 * Unauthenticated, as src/fetch-places.ts is: taxa are public reference data.
 *
 * THE WORKLIST is `inat_taxon_uncached` (schema/112), and it is recursive:
 * fetching a taxon adds its ancestors and replacements to it. So the loop
 * reads the view again after every batch until it is empty or the request cap
 * is reached. A run interrupted anywhere has stored what it fetched, and the
 * next run reads the rest from the same view.
 *
 * Ancestors in a child's response are stored as taxa too, so a lineage costs
 * no requests of its own, but only active ones that are not stored yet: an
 * ancestor response carries no replacement ids, so an inactive ancestor goes
 * through the worklist and is fetched itself.
 *
 * REFRESH. Taxa change upstream (renames, retirements, a new common name).
 * After the worklist, each run reads again the replacements of retired taxa
 * (inat_taxon_recheck, so a chain is followed the night after it forms) and
 * the stalest thirtieth of what is stored (inat_taxon_stalest), leaving out
 * what was read within 12 hours (a cold fill does not read everything twice).
 * Both rules are views in schema/112. The refresh runs even when the
 * worklist could not be finished.
 *
 * AN ABSENT VERDICT lasts 30 days, and any response that shows the taxon to
 * exist (as a result or as an ancestor) clears it at once.
 *
 * A BATCH THE API REFUSES is asked again in halves, down to single ids; an id
 * that fails alone is reported in `failed` and the rest carry on. Three
 * single ids in a row failing means the API is down, and the phase stops.
 *
 * Each fetch of a taxon deletes and re-inserts its ancestor and replacement
 * rows, so a reinstated or re-split taxon leaves nothing stale.
 */

const IDS_PER_REQUEST = 30;
/** Oregon, for the preferred common name (Peter, 2026-11-13). */
export const PREFERRED_PLACE_ID = 10;
const ANCESTOR_FIELDS = "id,name,rank,rank_level,parent_id,is_active,preferred_common_name";
export const TAXON_FIELDS =
  "id,name,rank,rank_level,parent_id,is_active,preferred_common_name,ancestor_ids,current_synonymous_taxon_ids," +
  ANCESTOR_FIELDS.split(",")
    .map((f) => `ancestors.${f}`)
    .join(",");

export interface FetchInatTaxaOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  /** The public API asks for about one request a second; stay under. */
  requestDelayMs?: number;
  requestTimeoutMs?: number;
  /** Cap the work in one run — the nightly job's SLA, not a correctness knob. */
  maxRequests?: number;
  /** Checked before every request and passed to it, so a shutdown or a deadline stops the run; the batches already stored stay. */
  signal?: AbortSignal;
  /** Skip the rolling refresh (the worklist is still worked). */
  skipRefresh?: boolean;
}

export interface FetchInatTaxaResult {
  /** Ids on the worklist when the run began. */
  missing: number;
  requested: number;
  /** Taxa read and stored from a request's results (not ancestors stored alongside them). */
  cached: number;
  /** Of `cached`, how many were read again rather than fetched for the first time. */
  refreshed: number;
  /** Ancestors stored from a child's response without a request of their own. */
  ancestorsStored: number;
  /** Ids asked for on THIS run that iNaturalist did not return. */
  unresolved: number[];
  /** Ids whose request failed even asked alone; not recorded absent, so a later run asks again. */
  failed: number[];
  /** What went wrong with the requests, one line each; empty on a clean run. */
  errors: string[];
  /** True when the cap stopped the run with work left on the worklist. */
  capped: boolean;
}

interface InatTaxonJson {
  id: number;
  name?: string;
  rank?: string;
  rank_level?: number;
  parent_id?: number | null;
  is_active?: boolean;
  preferred_common_name?: string | null;
  ancestor_ids?: number[] | null;
  current_synonymous_taxon_ids?: number[] | null;
  ancestors?: Array<{
    id: number;
    name?: string;
    rank?: string;
    rank_level?: number;
    parent_id?: number | null;
    is_active?: boolean;
    preferred_common_name?: string | null;
  }> | null;
}

const num = (rows: unknown): number[] => (rows as Array<[bigint | number]>).map(([id]) => Number(id));

async function ids(conn: DuckDBConnection, sql: string): Promise<number[]> {
  return num(await (await conn.run(sql)).getRows());
}

/** The cap on requests was reached: the work left waits for the next run. */
class CapReached extends Error {}
/** The API is failing in a way splitting the batch did not get round. Reported, not thrown past the run. */
class RequestFailure extends Error {}

/** Single ids in a row that may fail, each asked alone, before the API is judged down and the phase gives up. */
const FAILURES_IN_A_ROW = 3;

export async function fetchInatTaxa(
  conn: DuckDBConnection,
  opts: FetchInatTaxaOptions = {},
): Promise<FetchInatTaxaResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? "https://api.inaturalist.org/v2";
  const delay = opts.requestDelayMs ?? 1_100;
  const cap = opts.maxRequests ?? Infinity;

  const result: FetchInatTaxaResult = {
    missing: 0,
    requested: 0,
    cached: 0,
    refreshed: 0,
    ancestorsStored: 0,
    unresolved: [],
    failed: [],
    errors: [],
    capped: false,
  };
  // Every id asked for in this run. A taxon the API returns is stored, and one
  // it does not return is recorded absent, so the worklist shrinks either way;
  // this keeps the loop from asking for the same id twice, which would
  // otherwise happen for an id whose request failed.
  const asked = new Set<number>();
  let failuresInARow = 0;

  /**
   * One request for `batch`, and what follows from its answer. A batch the API
   * refuses is asked again in halves, down to single ids, so that one id it
   * cannot answer for costs only itself (found by calling it: a single unknown
   * id answers 404 with an empty list, several answer 200 with the ones it
   * knows, so this is cover for a failure not yet seen). A single id that
   * still fails is recorded in `failed`, not as absent, and the rest go on.
   */
  async function post(batch: number[], refresh: boolean): Promise<void> {
    if (result.requested >= cap) throw new CapReached();
    if (result.requested > 0 && delay > 0) await new Promise((r) => setTimeout(r, delay));
    // After the delay, not before it: a shutdown or the step's deadline during
    // the pause must not start one more request.
    opts.signal?.throwIfAborted();
    const url =
      `${apiBase}/taxa/${batch.join(",")}?preferred_place_id=${PREFERRED_PLACE_ID}&locale=en` +
      `&per_page=${IDS_PER_REQUEST}&fields=${TAXON_FIELDS}`;
    result.requested += 1;
    for (const id of batch) asked.add(id);
    let status = 0;
    let results: unknown;
    let failure: string | null = null;
    try {
      const timeout = AbortSignal.timeout(opts.requestTimeoutMs ?? 30_000);
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
      });
      status = response.status;
      const body = (await response.json().catch(() => null)) as { results?: unknown } | null;
      results = body?.results;
      if (!Array.isArray(results)) {
        // A malformed page is a failure, never "zero taxa": recording the whole
        // batch absent would hide real taxa for a month.
        failure = response.ok ? "no results array" : `${status}`;
      } else if (!response.ok && !(status === 404 && results.length === 0)) {
        failure = `${status}`;
      }
    } catch (err) {
      opts.signal?.throwIfAborted();
      failure = (err as Error).message;
    }
    if (failure === null) {
      failuresInARow = 0;
      // A 404 with an empty list is the answer for a single id iNaturalist does not have.
      await store(conn, results as InatTaxonJson[], batch, refresh, result);
      return;
    }
    const what = `iNat API ${failure} on /taxa for ${batch.length} id(s) starting ${batch[0]}`;
    if (status === 429) throw new RequestFailure(what);
    if (batch.length > 1) {
      const half = Math.ceil(batch.length / 2);
      await post(batch.slice(0, half), refresh);
      await post(batch.slice(half), refresh);
    } else {
      // Only a single id failing counts towards "the API is down": while a
      // batch is being narrowed down to the id that spoils it, every request
      // on the way fails, and that says nothing about the API.
      failuresInARow += 1;
      if (failuresInARow >= FAILURES_IN_A_ROW) throw new RequestFailure(what);
      result.failed.push(batch[0]!);
      result.errors.push(what);
    }
  }

  const worklist = () =>
    ids(conn, "SELECT inat_taxon_id FROM inat_taxon_uncached ORDER BY inat_taxon_id").then((all) =>
      all.filter((id) => !asked.has(id)),
    );

  /** The worklist, until it is empty. It is recursive: fetching adds ancestors and replacements. */
  async function drain(count: boolean): Promise<void> {
    for (;;) {
      const todo = await worklist();
      if (count) result.missing = todo.length;
      count = false;
      if (todo.length === 0) return;
      await post(todo.slice(0, IDS_PER_REQUEST), false);
    }
  }

  /** The replacements of retired taxa, then the stalest thirtieth (schema/112). */
  async function refreshPhase(): Promise<void> {
    const recheck = await ids(conn, "SELECT inat_taxon_id FROM inat_taxon_recheck ORDER BY inat_taxon_id");
    const stalest = await ids(conn, "SELECT inat_taxon_id FROM inat_taxon_stalest ORDER BY inat_taxon_id");
    const refresh = [...new Set([...recheck, ...stalest])].filter((id) => !asked.has(id));
    for (let i = 0; i < refresh.length; i += IDS_PER_REQUEST) {
      await post(refresh.slice(i, i + IDS_PER_REQUEST), true);
    }
  }

  /**
   * A failure of the API ends the phase it happened in and is reported, and
   * the next phase still runs: a worklist that cannot be finished is no reason
   * to let the stored taxa go stale. Anything else, the cap, a shutdown or a
   * database error, ends the run.
   */
  async function phase(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      if (!(err instanceof RequestFailure)) throw err;
      result.errors.push(err.message);
      failuresInARow = 0;
    }
  }

  try {
    await phase(() => drain(true));
    if (!opts.skipRefresh) {
      await phase(refreshPhase);
      // What a refresh turned up (a newly retired taxon's replacements, a new
      // ancestor) is on the worklist now; one more pass of it, within the cap.
      await phase(() => drain(false));
    }
  } catch (err) {
    if (!(err instanceof CapReached)) throw err;
    result.capped = true;
  }
  return result;
}

type TaxonRow = [number, string, string, number, number | null, boolean, string | null];

/** Run one multi-row INSERT of `rows`, each a list of bound values. One statement per batch, not per row: a cold fill is tens of thousands of rows. */
async function insertRows(
  conn: DuckDBConnection,
  head: string,
  tail: string,
  rows: unknown[][],
  chunk = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const width = part[0]!.length;
    const values = part.map((_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(", ")})`);
    await conn.run(`${head} VALUES ${values.join(", ")} ${tail}`, part.flat() as never[]);
  }
}

const UPSERT_HEAD = "INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, parent_id, is_active, preferred_common_name)";
const UPSERT_TAIL = `ON CONFLICT (inat_taxon_id) DO UPDATE SET
  name = excluded.name, rank = excluded.rank, rank_level = excluded.rank_level,
  parent_id = excluded.parent_id, is_active = excluded.is_active,
  preferred_common_name = excluded.preferred_common_name, fetched_at = now()`;

/** Store one response, in a transaction of its own: an interrupted run keeps the batches it finished. */
async function store(
  conn: DuckDBConnection,
  taxa: InatTaxonJson[],
  batch: number[],
  refresh: boolean,
  result: FetchInatTaxaResult,
): Promise<void> {
  const returned = new Set<number>();
  const fetched = new Map<number, TaxonRow>();
  const lineageOf = new Map<number, number[]>();
  const replacements: number[][] = [];
  for (const t of taxa) {
    // A result with no usable name or rank is skipped but still counts as
    // returned: it is answered, not absent, and recording it gone would hide
    // it from the worklist.
    if (typeof t.id !== "number") continue;
    returned.add(t.id);
    if (typeof t.name !== "string" || typeof t.rank !== "string" || typeof t.rank_level !== "number") continue;
    fetched.set(t.id, [t.id, t.name, t.rank, t.rank_level, t.parent_id ?? null, t.is_active !== false, t.preferred_common_name ?? null]);
    // ancestor_ids runs from the root down to the parent and omits the taxon.
    lineageOf.set(t.id, (t.ancestor_ids ?? []).map(Number).filter((a) => a !== t.id));
    for (const r of new Set((t.current_synonymous_taxon_ids ?? []).map(Number))) replacements.push([t.id, r]);
  }

  // Ancestors that arrived inside a child's response, to be stored as taxa
  // unless already stored, retired, or fetched in their own right here. A
  // retired child's lineage is stale (it names the old parent), so nothing is
  // taken from it; neither is an ancestor the child's ancestor_ids does not
  // list, since without its place in the lineage it would be stored with only
  // its own row, which then reads as a complete lineage.
  const candidates = new Map<number, { row: TaxonRow; above: number[] }>();
  // Every id a response shows to exist, whether asked for or listed as an
  // ancestor, so a verdict that it was absent can be cleared.
  const seen = new Set<number>(returned);
  for (const t of taxa) {
    for (const a of t.ancestors ?? []) if (typeof a?.id === "number") seen.add(a.id);
    const lineage = lineageOf.get(t.id);
    if (lineage === undefined || t.is_active === false) continue;
    for (const a of t.ancestors ?? []) {
      if (
        typeof a.id !== "number" || typeof a.name !== "string" || typeof a.rank !== "string" ||
        typeof a.rank_level !== "number" || a.is_active === false || fetched.has(a.id) || candidates.has(a.id)
      ) {
        continue;
      }
      const at = lineage.indexOf(a.id);
      if (at < 0) continue;
      // The ancestor's own lineage is the part of the child's above it.
      candidates.set(a.id, {
        row: [a.id, a.name, a.rank, a.rank_level, a.parent_id ?? null, true, a.preferred_common_name ?? null],
        above: lineage.slice(0, at),
      });
    }
  }

  await conn.run("BEGIN TRANSACTION");
  try {
    const have = new Set<number>();
    if (candidates.size > 0) {
      const rows = (await (
        await conn.run(`SELECT inat_taxon_id FROM inat_taxon WHERE inat_taxon_id IN (${[...candidates.keys()].join(", ")})`)
      ).getRows()) as Array<[bigint | number]>;
      for (const [id] of rows) have.add(Number(id));
    }
    const fresh = [...candidates.entries()].filter(([id]) => !have.has(id));

    const touched = [...fetched.keys(), ...fresh.map(([id]) => id)];
    if (touched.length > 0) {
      // Lineage and replacements are rewritten whole, so nothing stale stays.
      await conn.run(`DELETE FROM inat_taxon_ancestor WHERE inat_taxon_id IN (${touched.join(", ")})`);
      await conn.run(`DELETE FROM inat_taxon_replacement WHERE retired_taxon_id IN (${[...fetched.keys(), 0].join(", ")})`);
    }
    // A taxon any response shows to exist is not absent, including ancestors
    // that were already stored and so are not touched above.
    if (seen.size > 0) await conn.run(`DELETE FROM inat_taxon_absent WHERE inat_taxon_id IN (${[...seen].join(", ")})`);
    await insertRows(conn, UPSERT_HEAD, UPSERT_TAIL, [...fetched.values(), ...fresh.map(([, c]) => c.row)]);
    // Depth counts up from the taxon, and the taxon's own row is depth 0.
    const lineageRows: number[][] = [];
    for (const [id, above] of [
      ...[...lineageOf.entries()],
      ...fresh.map(([id, c]) => [id, c.above] as [number, number[]]),
    ]) {
      lineageRows.push([id, id, 0]);
      for (const [i, a] of above.entries()) lineageRows.push([id, a, above.length - i]);
    }
    await insertRows(conn, "INSERT INTO inat_taxon_ancestor", "ON CONFLICT DO NOTHING", lineageRows);
    await insertRows(conn, "INSERT INTO inat_taxon_replacement", "ON CONFLICT DO NOTHING", replacements);

    result.cached += fetched.size;
    if (refresh) result.refreshed += fetched.size;
    result.ancestorsStored += fresh.length;

    // An id iNat will not return is recorded rather than asked for every
    // night, in the same transaction as the batch. For a refresh the stored
    // row stays: a stale answer beats none, and the verdict keeps the refresh
    // from picking it again every night.
    const gone = batch.filter((id) => !seen.has(id));
    await insertRows(conn, "INSERT INTO inat_taxon_absent (inat_taxon_id)", "ON CONFLICT (inat_taxon_id) DO UPDATE SET asked_at = now()", gone.map((id) => [id]));
    result.unresolved.push(...gone);
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}

// CLI: pnpm inat:fetch-taxa [db]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? DEFAULT_DB;
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  const started = Date.now();
  const result = await fetchInatTaxa(conn);
  conn.closeSync();
  console.log(JSON.stringify({ ...result, seconds: Math.round((Date.now() - started) / 1000) }, null, 2));
  if (result.errors.length > 0) {
    console.error(result.errors.join("\n"));
    process.exitCode = 1;
  }
  if (result.unresolved.length > 0) {
    console.warn(
      `${result.unresolved.length} taxon ids iNaturalist did not return, recorded in inat_taxon_absent: ` +
        result.unresolved.slice(0, 20).join(", ") +
        (result.unresolved.length > 20 ? ", …" : ""),
    );
  }
}
