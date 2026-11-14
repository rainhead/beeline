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
 * (inat_taxon_recheck, so a chain is followed the night it forms) and the
 * stalest thirtieth of what is stored, by fetched_at, leaving out what was
 * read within the day (a cold fill does not read everything twice).
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
  /** Checked before every request, so a shutdown stops at a batch boundary. */
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
    capped: false,
  };
  // Every id asked for in this run. A taxon the API returns is stored, and one
  // it does not return is recorded absent, so the worklist shrinks either way;
  // this guards the loop against ever asking for the same id twice should a
  // response surprise us.
  const asked = new Set<number>();

  async function request(batch: number[], refresh: boolean): Promise<void> {
    if (result.requested > 0 && delay > 0) await new Promise((r) => setTimeout(r, delay));
    // After the delay, not before it: a shutdown during the pause must not
    // start one more request.
    opts.signal?.throwIfAborted();
    const url =
      `${apiBase}/taxa/${batch.join(",")}?preferred_place_id=${PREFERRED_PLACE_ID}&locale=en` +
      `&per_page=${IDS_PER_REQUEST}&fields=${TAXON_FIELDS}`;
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 30_000),
    });
    result.requested += 1;
    for (const id of batch) asked.add(id);
    if (!response.ok) {
      throw new Error(`iNat API ${response.status} on /taxa for ${batch.length} ids starting ${batch[0]}`);
    }
    const body = (await response.json()) as { results?: unknown };
    if (!Array.isArray(body.results)) {
      // A malformed page is a failure, never "zero taxa": recording the whole
      // batch absent would hide real taxa until somebody deleted the verdicts.
      throw new Error(`iNat API returned no results array on /taxa starting ${batch[0]}`);
    }
    await store(conn, body.results as InatTaxonJson[], batch, refresh, result);
  }

  // 1. The worklist, until it is empty.
  let first = true;
  for (;;) {
    const todo = (await ids(conn, "SELECT inat_taxon_id FROM inat_taxon_uncached ORDER BY inat_taxon_id")).filter(
      (id) => !asked.has(id),
    );
    if (first) result.missing = todo.length;
    first = false;
    if (todo.length === 0) break;
    if (result.requested >= cap) {
      result.capped = true;
      return result;
    }
    await request(todo.slice(0, IDS_PER_REQUEST), false);
  }

  // 2. The refresh: replacements of retired taxa, then the stalest thirtieth.
  if (!opts.skipRefresh) {
    const stored = Number(
      ((await (await conn.run("SELECT count(*) FROM inat_taxon")).getRows()) as Array<[bigint]>)[0]![0],
    );
    const stalest = await ids(
      conn,
      `SELECT inat_taxon_id FROM inat_taxon
       WHERE inat_taxon_id NOT IN (SELECT inat_taxon_id FROM inat_taxon_absent)
         AND fetched_at < now() - INTERVAL '1 day'
       ORDER BY fetched_at, inat_taxon_id LIMIT ${Math.ceil(stored / 30)}`,
    );
    const recheck = await ids(conn, "SELECT inat_taxon_id FROM inat_taxon_recheck ORDER BY inat_taxon_id");
    const refresh = [...new Set([...recheck, ...stalest])].filter((id) => !asked.has(id));
    for (let i = 0; i < refresh.length; i += IDS_PER_REQUEST) {
      if (result.requested >= cap) {
        result.capped = true;
        return result;
      }
      await request(refresh.slice(i, i + IDS_PER_REQUEST), true);
    }
    // What a refresh turned up (a newly retired taxon's replacements, a new
    // ancestor) is on the worklist now; one more pass of it, within the cap.
    for (;;) {
      const todo = (await ids(conn, "SELECT inat_taxon_id FROM inat_taxon_uncached ORDER BY inat_taxon_id")).filter(
        (id) => !asked.has(id),
      );
      if (todo.length === 0) break;
      if (result.requested >= cap) {
        result.capped = true;
        return result;
      }
      await request(todo.slice(0, IDS_PER_REQUEST), false);
    }
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
  // unless already stored, retired, or fetched in their own right here.
  const candidates = new Map<number, { row: TaxonRow; above: number[] }>();
  for (const t of taxa) {
    const lineage = lineageOf.get(t.id);
    if (lineage === undefined) continue;
    for (const a of t.ancestors ?? []) {
      if (
        typeof a.id !== "number" || typeof a.name !== "string" || typeof a.rank !== "string" ||
        typeof a.rank_level !== "number" || a.is_active === false || fetched.has(a.id) || candidates.has(a.id)
      ) {
        continue;
      }
      // The ancestor's own lineage is the part of the child's above it.
      candidates.set(a.id, {
        row: [a.id, a.name, a.rank, a.rank_level, a.parent_id ?? null, true, a.preferred_common_name ?? null],
        above: lineage.slice(0, Math.max(lineage.indexOf(a.id), 0)),
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
      await conn.run(`DELETE FROM inat_taxon_absent WHERE inat_taxon_id IN (${touched.join(", ")})`);
    }
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
    const gone = batch.filter((id) => !returned.has(id));
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
  if (result.unresolved.length > 0) {
    console.warn(
      `${result.unresolved.length} taxon ids iNaturalist did not return, recorded in inat_taxon_absent: ` +
        result.unresolved.slice(0, 20).join(", ") +
        (result.unresolved.length > 20 ? ", …" : ""),
    );
  }
}
