import { createWriteStream } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import { openDuckDb } from "./db.js";
import { mkdir, rm, rename } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import type { DemDataset } from "./derive-elevation.js";
import { GLO30, SRTM, locateTile, tileFileName, tileKeyFor } from "./derive-elevation.js";

/**
 * Fetch the DEM tiles that elevation derivation needs into data/dem/. The
 * nightly does this itself before deriving, a limited number at a time
 * (refreshTiles in src/app/jobs/registry.ts, beeline-z08); the CLI fetches
 * every one at once. Self-scoping: the tile set is computed from the
 * database's current elevation gaps, so a fresh dev environment fetches only what its data
 * needs, and a later run picks up tiles for newly cleared elevations. Tiles
 * already present are skipped.
 *
 * Two sources over plain HTTPS, in the order derivation prefers them: SRTM
 * 1-arc-second, then Copernicus GLO-30 for whatever SRTM does not reach
 * (beeline-zjd) — anything north of 60°N or south of 56°S, where the shuttle
 * simply did not fly. Tiles neither source has are printed; those elevations
 * stay NULL, which is fine — elevation is never a QC finding and never blocks
 * printing.
 *
 * Neither source wants a credential, and that is the point (beeline-oxi). The
 * SRTM tiles used to be rsynced from the legacy server's own archive, so any
 * host that fetched one needed an ssh key or an agent forwarded to it — which
 * the nightly pipeline, running unattended, has no way to hold. Worse, an
 * unreachable archive failed the whole run rather than falling through to
 * GLO-30, so a host without that key could not fetch even the tiles SRTM has
 * never held. The archive was a mirror of a public dataset; this reads the
 * public dataset.
 */

/**
 * Public, no-auth mirror of SRTM 1 Arc-Second Global v3, one GeoTIFF per
 * 1°×1° tile. The authoritative distribution is NASA's LP DAAC, which is
 * behind an Earthdata Login: a credential is the thing this is here to avoid,
 * and the data is identical public-domain SRTM either way.
 *
 * Not byte-identical to the legacy archive's rendition of the same tiles,
 * which is a property of SRTM and not of this mirror: renditions differ in
 * how they fill the voids the radar left in steep terrain. Measured on
 * n44_w123 — same 3601x3601 grid, same bounding box, 53,306 of 12,967,201
 * pixels differing (0.4%), all of them in the rugged eastern third and none
 * on the valley floor, and NOT a shift (the four one-pixel offsets are two
 * orders of magnitude worse). At the 1,416 sample coordinates the store
 * actually holds in that tile, the two agree exactly on 1,414 and by 10 m or
 * better on the rest: samples sit in valleys and along roads, where there
 * were no voids to disagree about. Tiles land under the archive's own file
 * name, so a cache filled either way still resolves, and the differing
 * rendition is visible where it belongs — elevation_source keys on the file
 * hash, so a re-fetched tile is a new source row rather than a silent
 * substitution.
 */
const SRTM_BUCKET = "https://opentopography.s3.sdsc.edu/raster/SRTM_GL1/SRTM_GL1_srtm";

/** SRTM's object name for a tile key: the same southwest corner, capitalised
 * and without the separator, so n44_w123 is N44W123. */
export function srtmUrl(key: string): string {
  return `${SRTM_BUCKET}/${key.toUpperCase().replace("_", "")}.tif`;
}

/** Public, no-auth, requester-pays-free mirror of Copernicus DEM GLO-30. */
const GLO30_BUCKET = "https://copernicus-dem-30m.s3.amazonaws.com";

/** GLO-30's object name for a tile key. Its tiles are keyed by the same
 * southwest corner the SRTM name is — verified against tile bounding boxes,
 * southern hemisphere included — so n60_w136 is N60_00_W136_00. */
export function glo30Url(key: string): string {
  const id = `Copernicus_DSM_COG_10_${key.toUpperCase().replace("_", "_00_")}_00_DEM`;
  return `${GLO30_BUCKET}/${id}/${id}.tif`;
}

/**
 * The tiles derivation will actually read: exactly the coordinates of
 * sample_elevation_pending (schema/170), which is what deriveElevations
 * selects. Not "every row with no elevation" — the pending view drops a
 * coordinate too vague to place (the 100 m elevation_derivation_limit,
 * beeline-6vc), and the two had drifted (beeline-67x): the fetch downloaded
 * tiles for rows nothing would ever derive. Caught on the dev store, where
 * the one tile of eleven that neither SRTM nor GLO-30 could supply was
 * s08_w122, open Pacific 2,000 km west of Peru, wanted by a single sample
 * whose obscured coordinate carries 1,196 km of uncertainty. That matters
 * beyond the wasted request: the unavailable list is how someone judges
 * whether a fetch went well, and that tile was the one entry on it that was
 * not a real gap.
 */
export async function neededTileKeys(conn: DuckDBConnection): Promise<string[]> {
  const rows = (await (
    await conn.run(`SELECT DISTINCT latitude, longitude FROM sample_elevation_pending`)
  ).getRows()) as Array<[number, number]>;
  return [...new Set(rows.map(([lat, lon]) => tileKeyFor(lat, lon)))].sort();
}

/** Tile keys no dataset in demDir covers yet. */
async function absentTiles(demDir: string, keys: string[]): Promise<string[]> {
  const absent: string[] = [];
  for (const key of keys) if ((await locateTile(demDir, key)) === null) absent.push(key);
  return absent;
}

/**
 * Stream one tile in, returning false for the 404 that means this dataset
 * does not have it: all ocean, or — for SRTM — outside the 60°N–56°S band the
 * shuttle flew. Downloads to a temp name and renames, so an interrupted
 * transfer never leaves a truncated tile behind for derivation to hash and
 * trust.
 */
async function fetchTile(
  demDir: string,
  key: string,
  dataset: DemDataset,
  url: string,
  opts: Pick<FetchTilesOptions, "signal" | "fetchImpl">,
): Promise<boolean> {
  const target = `${demDir}/${tileFileName(key, dataset)}`;
  const partial = `${target}.partial`;
  const timeout = AbortSignal.timeout(10 * 60_000);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const res = await (opts.fetchImpl ?? fetch)(url, { signal });
  if (res.status === 404) {
    // Node's fetch holds the pooled connection until the body is read or
    // cancelled, and unlike a browser's it will not collect it promptly on its
    // own. A 404 is the ordinary case here, not the exceptional one — every
    // tile above 60°N takes one before falling through to GLO-30 — so leaving
    // them unread would have each miss slow the tiles behind it.
    await res.body?.cancel();
    return false;
  }
  if (!res.ok || res.body === null) throw new Error(`${key} from ${url}: HTTP ${res.status}`);
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(partial));
    await rename(partial, target);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  return true;
}

export interface FetchTilesOptions {
  /** At most this many tiles downloaded in one call; the rest wait for the
   * next. A tile neither source has costs two empty answers and counts for
   * nothing, so it can never use up the allowance. */
  limit?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Told each key as it starts and each source that failed, for the CLI. */
  log?: (line: string) => void;
}

export interface FetchTilesResult {
  /** Tiles the pending elevations fall on, whether on disk or not. */
  needed: number;
  fromSrtm: string[];
  fromGlo30: string[];
  /** Neither source has them: open ocean, mostly. Asked again next time. */
  unavailable: string[];
  /** Absent and not yet asked for, because the limit was reached. */
  deferred: number;
}

/**
 * Fetch the tiles the pending elevations need and the disk lacks, SRTM first
 * and GLO-30 for whatever SRTM does not have. The CLI calls it with no limit;
 * the nightly calls it before deriving (beeline-z08), with one.
 */
export async function fetchMissingTiles(
  conn: DuckDBConnection,
  demDir: string,
  opts: FetchTilesOptions = {},
): Promise<FetchTilesResult> {
  await mkdir(demDir, { recursive: true });
  const needed = await neededTileKeys(conn);
  const absent = await absentTiles(demDir, needed);
  opts.log?.(`${needed.length} tiles needed, ${absent.length} to fetch`);

  // Per tile rather than per dataset: SRTM's absence at one key says nothing
  // about the next.
  const result: FetchTilesResult = { needed: needed.length, fromSrtm: [], fromGlo30: [], unavailable: [], deferred: 0 };
  for (const [i, key] of absent.entries()) {
    if (opts.limit !== undefined && result.fromSrtm.length + result.fromGlo30.length >= opts.limit) {
      result.deferred = absent.length - i;
      break;
    }
    opts.signal?.throwIfAborted();
    opts.log?.(`  ${key}`);
    // A transport failure on the first source is reported and then treated as
    // "this dataset does not have it", because an unreachable source failing
    // the whole run is precisely what left a host unable to fetch even the
    // tiles the other source holds (beeline-oxi). Both sources failing still
    // throws: that is an outage, not a gap.
    let srtm = false;
    try {
      srtm = await fetchTile(demDir, key, SRTM, srtmUrl(key), opts);
    } catch (err) {
      opts.signal?.throwIfAborted();
      opts.log?.(`    SRTM unavailable: ${(err as Error).message}`);
    }
    if (srtm) result.fromSrtm.push(key);
    else if (await fetchTile(demDir, key, GLO30, glo30Url(key), opts)) result.fromGlo30.push(key);
    else result.unavailable.push(key);
  }
  return result;
}

// CLI: pnpm elevation:fetch [db] [demDir]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // BEELINE_DB before the bare default (see db:migrate): with the store on a
  // mounted volume, a bare run would otherwise open an empty one beside the app.
  const dbPath = process.argv[2] ?? process.env.BEELINE_DB ?? "beeline.duckdb";
  const demDir = process.argv[3] ?? "data/dem";
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  try {
    const { needed, fromSrtm, fromGlo30, unavailable } = await fetchMissingTiles(conn, demDir, {
      log: (line) => console.error(line),
    });
    console.log(JSON.stringify({ needed, fromSrtm, fromGlo30, unavailable }, null, 2));
  } finally {
    conn.closeSync();
  }
}
