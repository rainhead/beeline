import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { fromArrayBuffer } from "geotiff";

/**
 * Derive missing elevations for believed-true coordinates (beeline-bqz).
 * Fills the sample_location rows sample_elevation_pending names — never
 * derived, or derived from a point the coordinates have since moved away
 * from (schema/170, beeline-x5c) — from DEM GeoTIFF
 * tiles in data/dem/ — SRTM 1-arc-second first, so re-derived values stay
 * comparable with the legacy ones, falling back to Copernicus GLO-30 where
 * the SRTM archive has no tile (beeline-zjd). Each tile used gets one
 * elevation_source row (file name + sha256 + which dataset it is), reused
 * across runs; the CHECK on sample_location guarantees no elevation lands
 * without it, and a second CHECK guarantees it never lands without the
 * coordinates it was read at. Idempotent: a settled row is not pending, so a
 * re-run is a no-op — and a coordinate that moved schedules its own
 * re-derivation without any writer having to remember to clear anything.
 * Values < -10 are DEM voids (reference rule) and stay NULL.
 *
 * A coordinate too vague to deserve an elevation is never a gap at all: the
 * pending view drops it, so it cannot sit in the backlog forever being
 * re-attempted. Those are counted separately and reported (beeline-6vc).
 */

export interface ElevationResult {
  gaps: number;
  filled: number;
  voids: number;
  /** Coordinates too vague to deserve an elevation (schema/170). Reported so
   * a shrinking gap count is not read as work quietly going undone. */
  refused: number;
  /** Tile keys (n44_w124) no dataset in data/dem covers — those gaps stay NULL. */
  missingTiles: string[];
}

/** A DEM we read tiles from: how its files are named, and how an
 * elevation_source row describes them. Both datasets are 1°×1° tiles on the
 * same key, so a tile key resolves in either. */
export interface DemDataset {
  suffix: string;
  description: string;
}

export const SRTM: DemDataset = {
  suffix: "_1arc_v3.tif",
  description: "SRTM 1 Arc-Second Global v3, nearest pixel",
};

/** Fallback for tiles outside the legacy archive, including north of 60°N
 * where SRTM simply stops. GLO-30 thins its longitude sampling toward the
 * poles (3600 px wide below 50°, then 2400, then 1800), which the lookup
 * below already accommodates by reading each tile's own raster dimensions. */
export const GLO30: DemDataset = {
  suffix: "_glo30.tif",
  description: "Copernicus DEM GLO-30, nearest pixel",
};

/** Preference order: SRTM is what the existing rows were derived from. */
export const DEM_DATASETS: DemDataset[] = [SRTM, GLO30];

/** DEM tile key for a coordinate: n{floor(lat)}_w{-floor(lon)}, the
 * southwest corner both datasets name their tiles by. Floor (not truncation)
 * so an exact boundary like -124.0 maps to the tile whose pixel grid the
 * lookup math actually indexes into. Degrees are zero-padded to the width
 * each archive uses — 2 for latitude, 3 for longitude — so a coordinate
 * within 10° of the equator asks for n05, not the n5 that simply 404s. */
export function tileKeyFor(latitude: number, longitude: number): string {
  const lat = Math.floor(latitude);
  const lon = Math.floor(longitude);
  const ns = `${lat < 0 ? "s" : "n"}${String(Math.abs(lat)).padStart(2, "0")}`;
  const ew = `${lon < 0 ? "w" : "e"}${String(Math.abs(lon)).padStart(3, "0")}`;
  return `${ns}_${ew}`;
}

/** A dataset's file name for a tile key — the same name the legacy archive
 * uses and the name it lands under in demDir. */
export function tileFileName(key: string, dataset: DemDataset): string {
  return `${key}${dataset.suffix}`;
}

/** The tile on disk for this key — which dataset holds it and under what
 * file name — or null if no dataset does. */
export async function locateTile(
  demDir: string,
  key: string,
): Promise<{ dataset: DemDataset; fileName: string } | null> {
  for (const dataset of DEM_DATASETS) {
    const fileName = tileFileName(key, dataset);
    try {
      await access(`${demDir}/${fileName}`);
      return { dataset, fileName };
    } catch {
      // next dataset
    }
  }
  return null;
}

export async function deriveElevations(
  conn: DuckDBConnection,
  demDir = "data/dem",
): Promise<ElevationResult> {
  const gaps = (await (
    await conn.run(`SELECT sample_id, latitude, longitude FROM sample_elevation_pending`)
  ).getRows()) as Array<[number, number, number]>;

  const byTile = new Map<string, Array<[number, number, number]>>();
  for (const row of gaps) {
    const key = tileKeyFor(row[1], row[2]);
    if (!byTile.has(key)) byTile.set(key, []);
    byTile.get(key)!.push(row);
  }

  const [[refused]] = (await (
    await conn.run(
      `SELECT count(*) FROM sample_location
        WHERE elevation_m IS NULL
          AND coordinate_uncertainty_m >
              (SELECT coordinate_uncertainty_m FROM elevation_derivation_limit)`,
    )
  ).getRows()) as [[bigint]];
  const result: ElevationResult = {
    gaps: gaps.length,
    filled: 0,
    voids: 0,
    refused: Number(refused),
    missingTiles: [],
  };
  await conn.run("BEGIN TRANSACTION");
  try {
    for (const [key, rows] of byTile) {
      const found = await locateTile(demDir, key);
      if (found === null) {
        result.missingTiles.push(key);
        continue;
      }
      const { dataset, fileName } = found;
      const bytes = await readFile(`${demDir}/${fileName}`);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const arrayBuffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(arrayBuffer).set(bytes);
      const tiff = await fromArrayBuffer(arrayBuffer);
      const image = await tiff.getImage();
      const rasters = await image.readRasters();
      const data = rasters[0] as ArrayLike<number>;
      const { width, height } = rasters;

      const sourceId = await findOrCreateSource(conn, fileName, hash, dataset.description);
      for (const [sampleId, latitude, longitude] of rows) {
        // Reference semantics: nearest pixel by floor, rows from the bottom.
        // Deliberately the legacy ElevationService's arithmetic, so re-derived
        // SRTM values stay comparable with the ones it produced. Both datasets
        // are point-registered, but GLO-30 spans the degree in 3600 rows where
        // SRTM uses 3601, so on a GLO-30 tile this lands one row (~30 m) north
        // of centre — immaterial for an elevation, and not worth two dialects
        // of the same lookup.
        const row = height - Math.floor((latitude - Math.floor(latitude)) * height) - 1;
        const column = Math.floor((longitude - Math.floor(longitude)) * width);
        const elevation = data[column + width * row];
        // GLO-30 samples are floats, so a no-data cell can also arrive as NaN,
        // which no comparison would catch.
        if (elevation === undefined || !Number.isFinite(elevation) || elevation < -10) {
          result.voids += 1;
          continue;
        }
        // The coordinates go down with the elevation, not the ones the row
        // happens to hold when someone next reads it: those are the same
        // today and the whole point of the column tomorrow.
        await conn.run(
          `UPDATE sample_location
              SET elevation_m = $1, elevation_source_id = $2,
                  elevation_latitude = $3, elevation_longitude = $4
            WHERE sample_id = $5`,
          [Math.round(elevation), sourceId, latitude, longitude, sampleId],
        );
        result.filled += 1;
      }
    }
    await conn.run("COMMIT");
    result.missingTiles.sort();
    return result;
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}

async function findOrCreateSource(
  conn: DuckDBConnection,
  fileName: string,
  fileHash: string,
  description: string,
): Promise<number> {
  const existing = (await (
    await conn.run(
      `SELECT entity_id FROM elevation_source WHERE file_name = $1 AND file_hash = $2`,
      [fileName, fileHash],
    )
  ).getRows()) as Array<[number]>;
  if (existing[0]) return Number(existing[0][0]);
  const [[id]] = (await (
    await conn.run(
      `INSERT INTO elevation_source (description, file_name, file_hash)
       VALUES ($1, $2, $3) RETURNING entity_id`,
      [description, fileName, fileHash],
    )
  ).getRows()) as [[number]];
  return Number(id);
}

// CLI: pnpm elevation:derive [db] [demDir]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? "beeline.duckdb";
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const result = await deriveElevations(conn, process.argv[3] ?? "data/dem");
  conn.closeSync();
  console.log(JSON.stringify(result, null, 2));
}
