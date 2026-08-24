import { DuckDBInstance } from "@duckdb/node-api";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rm, rename, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { GLO30, SRTM, locateTile, tileFileName, tileKeyFor } from "./derive-elevation.js";

/**
 * Fetch the DEM tiles that elevation derivation needs into data/dem/.
 * Self-scoping: the tile set is computed from the database's current
 * elevation gaps, so a fresh dev environment fetches only what its data
 * needs, and a later run picks up tiles for newly cleared elevations. Tiles
 * already present are skipped.
 *
 * Two sources, in the order derivation prefers them: SRTM 1-arc-second
 * rsynced from the legacy server's archive (requires `beeline` in
 * ~/.ssh/config, like scripts/fetch-legacy.sh), then Copernicus GLO-30 for
 * whatever that archive lacks (beeline-zjd) — out-of-atlas records, and
 * anything north of 60°N where SRTM has no coverage at all. Tiles neither
 * source has are printed; those elevations stay NULL, which is fine —
 * elevation is never a QC finding and never blocks printing.
 */

const REMOTE = "beeline:/root/app/OBP-Server/shared/data/elevation/";

/** Public, no-auth, requester-pays-free mirror of Copernicus DEM GLO-30. */
const GLO30_BUCKET = "https://copernicus-dem-30m.s3.amazonaws.com";

/** GLO-30's object name for a tile key. Its tiles are keyed by the same
 * southwest corner the SRTM name is — verified against tile bounding boxes,
 * southern hemisphere included — so n60_w136 is N60_00_W136_00. */
export function glo30Url(key: string): string {
  const id = `Copernicus_DSM_COG_10_${key.toUpperCase().replace("_", "_00_")}_00_DEM`;
  return `${GLO30_BUCKET}/${id}/${id}.tif`;
}

export async function neededTiles(dbPath: string): Promise<string[]> {
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const rows = (await (
    await conn.run(
      `SELECT DISTINCT latitude, longitude FROM sample_location WHERE elevation_m IS NULL`,
    )
  ).getRows()) as Array<[number, number]>;
  conn.closeSync();
  return [...new Set(rows.map(([lat, lon]) => tileKeyFor(lat, lon)))].sort();
}

/** Tile keys no dataset in demDir covers yet. */
async function absentTiles(demDir: string, keys: string[]): Promise<string[]> {
  const absent: string[] = [];
  for (const key of keys) if ((await locateTile(demDir, key)) === null) absent.push(key);
  return absent;
}

/** Pull SRTM tiles from the legacy archive. Tiles the server does not have
 * are simply not transferred; the caller re-checks what landed. */
async function rsyncFromLegacy(demDir: string, keys: string[]): Promise<void> {
  const listPath = `${demDir}/.fetch-list`;
  await writeFile(listPath, keys.map((key) => tileFileName(key, SRTM)).join("\n") + "\n");
  const rsync = spawn("rsync", ["-a", `--files-from=${listPath}`, REMOTE, demDir], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  // A null close code means rsync died on a signal — never success.
  const code = await new Promise<number>((resolve) => rsync.on("close", (c) => resolve(c ?? 1)));
  // 23/24: partial transfer — tiles the server lacks; the caller's re-check
  // reports exactly which. (macOS rsync predates --ignore-missing-args.)
  if (code !== 0 && code !== 23 && code !== 24) throw new Error(`rsync exited ${code}`);
}

/**
 * Stream one GLO-30 tile in, returning false for the 404 that means the tile
 * genuinely does not exist (all ocean). Downloads to a temp name and renames,
 * so an interrupted transfer never leaves a truncated tile behind for
 * derivation to hash and trust.
 */
async function fetchGlo30(demDir: string, key: string): Promise<boolean> {
  const target = `${demDir}/${tileFileName(key, GLO30)}`;
  const partial = `${target}.partial`;
  const res = await fetch(glo30Url(key), { signal: AbortSignal.timeout(10 * 60_000) });
  if (res.status === 404) return false;
  if (!res.ok || res.body === null) throw new Error(`GLO-30 ${key}: HTTP ${res.status}`);
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(partial));
    await rename(partial, target);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  return true;
}

// CLI: pnpm elevation:fetch [db] [demDir]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? "beeline.duckdb";
  const demDir = process.argv[3] ?? "data/dem";
  await mkdir(demDir, { recursive: true });
  const needed = await neededTiles(dbPath);
  const toFetch = await absentTiles(demDir, needed);
  console.error(`${needed.length} tiles needed, ${toFetch.length} to fetch`);

  if (toFetch.length > 0) await rsyncFromLegacy(demDir, toFetch);
  const beyondLegacy = await absentTiles(demDir, toFetch);
  if (beyondLegacy.length > 0) {
    console.error(`${beyondLegacy.length} not in the legacy archive — trying Copernicus GLO-30`);
  }

  const fromGlo30: string[] = [];
  const unavailable: string[] = [];
  for (const key of beyondLegacy) {
    console.error(`  ${key}`);
    if (await fetchGlo30(demDir, key)) fromGlo30.push(key);
    else unavailable.push(key);
  }

  console.log(
    JSON.stringify(
      {
        needed: needed.length,
        fromLegacy: toFetch.length - beyondLegacy.length,
        fromGlo30,
        unavailable,
      },
      null,
      2,
    ),
  );
}
