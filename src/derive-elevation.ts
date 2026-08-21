import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { fromArrayBuffer } from "geotiff";

/**
 * Derive missing elevations for believed-true coordinates (beeline-bqz).
 * Fills sample_location rows where elevation_m IS NULL from SRTM
 * 1-arc-second GeoTIFF tiles in data/dem/ — the same dataset and nearest-
 * pixel semantics as the reference ElevationService, so re-derived values
 * are comparable with legacy ones. Each tile used gets one elevation_source
 * row (file name + sha256), reused across runs; the CHECK on
 * sample_location guarantees no elevation lands without it. Idempotent:
 * only NULL rows are touched, so promotion clearing a moved coordinate's
 * elevation is exactly what schedules its re-derivation. Values < -10 are
 * SRTM voids (reference rule) and stay NULL.
 */

export interface ElevationResult {
  gaps: number;
  filled: number;
  voids: number;
  missingTiles: string[];
}

/** SRTM tile file for a coordinate: n{floor(lat)}_w{-floor(lon)}_1arc_v3.tif.
 * Floor (not truncation) so an exact boundary like -124.0 maps to the tile
 * whose pixel grid the lookup math actually indexes into. */
export function tileNameFor(latitude: number, longitude: number): string {
  const lat = Math.floor(latitude);
  const lon = Math.floor(longitude);
  const ns = lat < 0 ? `s${String(-lat)}` : `n${String(lat)}`;
  const ew = lon < 0 ? `w${String(-lon).padStart(3, "0")}` : `e${String(lon).padStart(3, "0")}`;
  return `${ns}_${ew}_1arc_v3.tif`;
}

export async function deriveElevations(
  conn: DuckDBConnection,
  demDir = "data/dem",
): Promise<ElevationResult> {
  const gaps = (await (
    await conn.run(
      `SELECT sample_id, latitude, longitude FROM sample_location WHERE elevation_m IS NULL`,
    )
  ).getRows()) as Array<[number, number, number]>;

  const byTile = new Map<string, Array<[number, number, number]>>();
  for (const row of gaps) {
    const tile = tileNameFor(row[1], row[2]);
    if (!byTile.has(tile)) byTile.set(tile, []);
    byTile.get(tile)!.push(row);
  }

  const result: ElevationResult = { gaps: gaps.length, filled: 0, voids: 0, missingTiles: [] };
  await conn.run("BEGIN TRANSACTION");
  try {
    for (const [tile, rows] of byTile) {
      let bytes: Buffer;
      try {
        bytes = await readFile(`${demDir}/${tile}`);
      } catch {
        result.missingTiles.push(tile);
        continue;
      }
      const hash = createHash("sha256").update(bytes).digest("hex");
      const arrayBuffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(arrayBuffer).set(bytes);
      const tiff = await fromArrayBuffer(arrayBuffer);
      const image = await tiff.getImage();
      const rasters = await image.readRasters();
      const data = rasters[0] as ArrayLike<number>;
      const { width, height } = rasters;

      const sourceId = await findOrCreateSource(conn, tile, hash);
      for (const [sampleId, latitude, longitude] of rows) {
        // Reference semantics: nearest pixel by floor, rows from the bottom.
        const row = height - Math.floor((latitude - Math.floor(latitude)) * height) - 1;
        const column = Math.floor((longitude - Math.floor(longitude)) * width);
        const elevation = data[column + width * row];
        if (elevation === undefined || elevation < -10) {
          result.voids += 1;
          continue;
        }
        await conn.run(
          `UPDATE sample_location SET elevation_m = $1, elevation_source_id = $2 WHERE sample_id = $3`,
          [Math.round(elevation), sourceId, sampleId],
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
       VALUES ('SRTM 1 Arc-Second Global v3, nearest pixel', $1, $2) RETURNING entity_id`,
      [fileName, fileHash],
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
