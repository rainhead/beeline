import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { deriveElevations, tileKeyFor } from "../src/derive-elevation.js";
import { glo30Url } from "../src/fetch-dem.js";

/** Minimal single-strip little-endian TIFF — geotiff's own writer mangles
 * anything wider than 8 bits, so we emit the ~200 bytes by hand. SRTM tiles
 * are signed 16-bit integers; GLO-30's are 32-bit floats. */
function tinyTiff(data: Int16Array | Float32Array, width: number, height: number): Buffer {
  const float = data instanceof Float32Array;
  const bytesPerSample = float ? 4 : 2;
  const tags: Array<[number, number, number]> = [
    [256, 3, width], // ImageWidth
    [257, 3, height], // ImageLength
    [258, 3, bytesPerSample * 8], // BitsPerSample
    [259, 3, 1], // Compression: none
    [262, 3, 1], // PhotometricInterpretation
    [273, 4, 0], // StripOffsets (patched below)
    [277, 3, 1], // SamplesPerPixel
    [278, 3, height], // RowsPerStrip
    [279, 4, data.length * bytesPerSample], // StripByteCounts
    [339, 3, float ? 3 : 2], // SampleFormat: IEEE float / signed integer
  ];
  const ifdStart = 8;
  const pixelStart = ifdStart + 2 + tags.length * 12 + 4;
  tags[5]![2] = pixelStart;
  const buf = Buffer.alloc(pixelStart + data.length * bytesPerSample);
  buf.write("II", 0, "ascii");
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifdStart, 4);
  buf.writeUInt16LE(tags.length, ifdStart);
  tags.forEach(([id, type, value], i) => {
    const at = ifdStart + 2 + i * 12;
    buf.writeUInt16LE(id, at);
    buf.writeUInt16LE(type, at + 2);
    buf.writeUInt32LE(1, at + 4);
    buf.writeUInt32LE(value, at + 8);
  });
  data.forEach((v, i) => {
    const at = pixelStart + i * bytesPerSample;
    if (float) buf.writeFloatLE(v, at);
    else buf.writeInt16LE(v, at);
  });
  return buf;
}

let conn: DuckDBConnection;
let demDir: string;
let sampleNumber = 0;

/** Each sample needs its own number; location values are SQL literals. */
const gapAt = (latitude: string, longitude: string) =>
  insertCleanSample(
    conn,
    { sample_number: `'${String(++sampleNumber)}'` },
    { latitude, longitude, elevation_m: "NULL" },
  );

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
  demDir = await mkdtemp(join(tmpdir(), "beeline-dem-"));

  // n44_w124, SRTM only: 10×10, cell value = row*100 + column, except one
  // void cell at (row 8, col 9) — value -32767.
  const srtm = new Int16Array(100);
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) srtm[c + 10 * r] = r * 100 + c;
  srtm[9 + 10 * 8] = -32767;
  await writeFile(join(demDir, "n44_w124_1arc_v3.tif"), tinyTiff(srtm, 10, 10));

  // n45_w124 in both datasets, with values that tell them apart.
  await writeFile(join(demDir, "n45_w124_1arc_v3.tif"), tinyTiff(new Int16Array(4).fill(111), 2, 2));
  await writeFile(join(demDir, "n45_w124_glo30.tif"), tinyTiff(new Float32Array(4).fill(222), 2, 2));

  // n60_w136, GLO-30 only. Deliberately not square: north of 50°N GLO-30
  // thins its longitude sampling, so the lookup must use the tile's own
  // dimensions rather than assume a square grid.
  const glo = new Float32Array(72);
  for (let r = 0; r < 12; r++) for (let c = 0; c < 6; c++) glo[c + 6 * r] = r * 100 + c + 0.6;
  glo[5 + 6 * 2] = NaN; // a float no-data cell no comparison would catch
  await writeFile(join(demDir, "n60_w136_glo30.tif"), tinyTiff(glo, 6, 12));
});

describe("elevation derivation", () => {
  test("tile keys floor toward the covering tile, boundary and hemispheres included", () => {
    expect(tileKeyFor(44.5646, -123.262)).toBe("n44_w124");
    expect(tileKeyFor(44.0, -124.0)).toBe("n44_w124");
    expect(tileKeyFor(48.14, -118.99)).toBe("n48_w119");
    expect(tileKeyFor(-38.65, 176.08)).toBe("s39_e176");
    // Both archives zero-pad; an unpadded n5 is simply not a tile they have.
    expect(tileKeyFor(5.2, 36.4)).toBe("n05_e036");
    expect(tileKeyFor(-0.5, -0.5)).toBe("s01_w001");
  });

  test("GLO-30 object names key off the same corner the tile key does", () => {
    expect(glo30Url("n60_w136")).toContain("Copernicus_DSM_COG_10_N60_00_W136_00_DEM.tif");
    expect(glo30Url("s39_e176")).toContain("Copernicus_DSM_COG_10_S39_00_E176_00_DEM.tif");
  });

  test("fills gaps by nearest pixel, skips voids, reports missing tiles, reuses one source", async () => {
    // lat .55 → row 4; lon frac .15 → col 1 → value 401.
    const filled = await gapAt("44.55", "-123.85");
    // void cell: lat .19 → row 8; lon frac .95 → col 9.
    const voided = await gapAt("44.19", "-123.05");
    // no dataset has n29_w096.
    const missing = await gapAt("29.5", "-95.5");

    const result = await deriveElevations(conn, demDir);
    expect(result).toEqual({ gaps: 3, filled: 1, voids: 1, missingTiles: ["n29_w096"] });

    const state = await rows(
      conn,
      `SELECT loc.sample_id, loc.elevation_m, src.file_name
       FROM sample_location loc
       LEFT JOIN elevation_source src ON src.entity_id = loc.elevation_source_id
       WHERE loc.sample_id IN (${filled}, ${voided}, ${missing})
       ORDER BY loc.sample_id`,
    );
    expect(state).toEqual([
      [filled, 401, "n44_w124_1arc_v3.tif"],
      [voided, null, null],
      [missing, null, null],
    ]);

    // Idempotent: the remaining gaps are the void and the missing-tile row;
    // nothing fills twice and the tile's source row is not duplicated.
    const again = await deriveElevations(conn, demDir);
    expect(again).toMatchObject({ gaps: 2, filled: 0 });
    const [[sources]] = (await rows(
      conn,
      "SELECT count(*) FROM elevation_source WHERE file_name = 'n44_w124_1arc_v3.tif'",
    )) as [[unknown]];
    expect(sources).toBe(1n);
  });

  test("falls back to GLO-30 where SRTM has no tile, and records it as its own source", async () => {
    // lat .5 → row 12 - 6 - 1 = 5; lon frac .5 → col 3 → 503.6, rounded.
    const yukon = await gapAt("60.5", "-135.5");
    await deriveElevations(conn, demDir);

    expect(
      await rows(
        conn,
        `SELECT loc.elevation_m, src.file_name, src.description
         FROM sample_location loc JOIN elevation_source src ON src.entity_id = loc.elevation_source_id
         WHERE loc.sample_id = ${yukon}`,
      ),
    ).toEqual([[504, "n60_w136_glo30.tif", "Copernicus DEM GLO-30, nearest pixel"]]);
  });

  test("a NaN sample is a void, not an elevation", async () => {
    // Settle everything fillable first, so the counts below are this row's
    // doing rather than a void an earlier test left lying around.
    const before = await deriveElevations(conn, demDir);
    // The NaN cell: lat .8 → row 2; lon frac .9 → col 5.
    const nan = await gapAt("60.8", "-135.1");
    const after = await deriveElevations(conn, demDir);
    expect(after).toMatchObject({ voids: before.voids + 1, filled: 0 });
    expect(
      await rows(conn, `SELECT elevation_m FROM sample_location WHERE sample_id = ${nan}`),
    ).toEqual([[null]]);
  });

  test("a moved coordinate re-derives without anyone clearing the elevation", async () => {
    // The bug this guards: elevation_m is a statement about a point, and for
    // one release the only thing keeping it true was that each coordinate
    // writer remembered to null it (beeline-x5c). Here nothing does.
    const moved = await gapAt("44.55", "-123.85");
    await deriveElevations(conn, demDir);
    expect(
      await rows(conn, `SELECT elevation_m FROM sample_location WHERE sample_id = ${moved}`),
    ).toEqual([[401]]);

    // Shove it four rows south, leaving the elevation exactly where it was.
    await conn.run(`UPDATE sample_location SET latitude = 44.95 WHERE sample_id = ${moved}`);
    expect(
      await rows(conn, `SELECT sample_id FROM sample_elevation_stale WHERE sample_id = ${moved}`),
    ).toEqual([[moved]]);

    // lat .95 → row 0; lon frac .15 → col 1 → 1.
    await deriveElevations(conn, demDir);
    expect(
      await rows(
        conn,
        `SELECT elevation_m, elevation_latitude FROM sample_location WHERE sample_id = ${moved}`,
      ),
    ).toEqual([[1, 44.95]]);
    expect(await rows(conn, "SELECT sample_id FROM sample_elevation_stale")).toEqual([]);
  });

  test("a coordinate that only rounds differently is not stale", async () => {
    const nudged = await gapAt("44.55", "-123.85");
    await deriveElevations(conn, demDir);
    // Under the 5e-5 tolerance: the same DEM pixel, so re-reading it would
    // change nothing and 383k legacy rows should not re-derive on a reload.
    await conn.run(`UPDATE sample_location SET latitude = 44.550_02 WHERE sample_id = ${nudged}`);
    expect(
      await rows(conn, `SELECT sample_id FROM sample_elevation_stale WHERE sample_id = ${nudged}`),
    ).toEqual([]);
    expect(await deriveElevations(conn, demDir)).toMatchObject({ filled: 0 });
  });

  test("an elevation with no point behind it is pending on a store that has no CHECK", async () => {
    // Migration 0012 adds elevation_latitude/longitude and cannot add the
    // CHECK pairing them with elevation_m, because DuckDB has no ALTER TABLE
    // ADD CONSTRAINT (ADR 0006) — so it nominates these views as what keeps a
    // deployed store honest instead. They only do that if a row with an
    // elevation and no point is visible to them: `abs(NULL - latitude) >
    // 5e-5` is NULL, which is neither stale nor pending, and the hole would
    // be exactly on the stores that lack the CHECK.
    //
    // So the views are exercised here against the real schema/170 text on a
    // table built without the constraints, which is the shape a migrated
    // store actually has and the shape a fresh build cannot reproduce.
    const bare = await (await DuckDBInstance.create(":memory:")).connect();
    await bare.run(`CREATE TABLE sample_location (
      sample_id INTEGER PRIMARY KEY, latitude DOUBLE, longitude DOUBLE,
      elevation_m INTEGER, elevation_source_id INTEGER,
      elevation_latitude DOUBLE, elevation_longitude DOUBLE)`);
    await bare.run(await readFile("schema/170_views_elevation.sql", "utf8"));
    await bare.run(`INSERT INTO sample_location VALUES
      (1, 44.5, -123.2,   72, 1, NULL, NULL),   -- elevation, no point
      (2, 44.9, -123.2,   72, 1, 44.5, -123.2), -- point it moved away from
      (3, 44.5, -123.2,   72, 1, 44.5, -123.2), -- settled
      (4, 44.5, -123.2, NULL, NULL, NULL, NULL)`); // never derived

    expect(await rows(bare, "SELECT sample_id FROM sample_elevation_stale ORDER BY 1")).toEqual([[1], [2]]);
    expect(await rows(bare, "SELECT sample_id FROM sample_elevation_pending ORDER BY 1")).toEqual([
      [1], [2], [4],
    ]);
  });

  test("SRTM wins where both datasets have the tile", async () => {
    const both = await gapAt("45.5", "-123.5");
    await deriveElevations(conn, demDir);
    expect(
      await rows(
        conn,
        `SELECT loc.elevation_m, src.file_name FROM sample_location loc
         JOIN elevation_source src ON src.entity_id = loc.elevation_source_id
         WHERE loc.sample_id = ${both}`,
      ),
    ).toEqual([[111, "n45_w124_1arc_v3.tif"]]);
  });
});
