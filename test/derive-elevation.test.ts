import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { deriveElevations, tileNameFor } from "../src/derive-elevation.js";

/** Minimal single-strip little-endian TIFF with signed 16-bit samples —
 * geotiff's own writer mangles anything wider than 8 bits, so we emit the
 * ~200 bytes by hand. */
function tinyTiff(data: Int16Array, width: number, height: number): Buffer {
  const tags: Array<[number, number, number]> = [
    [256, 3, width], // ImageWidth
    [257, 3, height], // ImageLength
    [258, 3, 16], // BitsPerSample
    [259, 3, 1], // Compression: none
    [262, 3, 1], // PhotometricInterpretation
    [273, 4, 0], // StripOffsets (patched below)
    [277, 3, 1], // SamplesPerPixel
    [278, 3, height], // RowsPerStrip
    [279, 4, data.length * 2], // StripByteCounts
    [339, 3, 2], // SampleFormat: signed integer
  ];
  const ifdStart = 8;
  const pixelStart = ifdStart + 2 + tags.length * 12 + 4;
  tags[5]![2] = pixelStart;
  const buf = Buffer.alloc(pixelStart + data.length * 2);
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
  data.forEach((v, i) => buf.writeInt16LE(v, pixelStart + i * 2));
  return buf;
}

let conn: DuckDBConnection;
let demDir: string;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");

  // A 10×10 fake SRTM tile for n44_w124: cell value = row*100 + column,
  // except one void cell at (row 8, col 9) — value -32767.
  const width = 10, height = 10;
  const data = new Int16Array(width * height);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) data[c + width * r] = r * 100 + c;
  data[9 + width * 8] = -32767;
  demDir = await mkdtemp(join(tmpdir(), "beeline-dem-"));
  await writeFile(join(demDir, "n44_w124_1arc_v3.tif"), tinyTiff(data, width, height));
});

describe("elevation derivation", () => {
  test("tile naming floors toward the covering tile, boundary included", () => {
    expect(tileNameFor(44.5646, -123.262)).toBe("n44_w124_1arc_v3.tif");
    expect(tileNameFor(44.0, -124.0)).toBe("n44_w124_1arc_v3.tif");
    expect(tileNameFor(48.14, -118.99)).toBe("n48_w119_1arc_v3.tif");
  });

  test("fills gaps by nearest pixel, skips voids, reports missing tiles, reuses one source", async () => {
    // lat .55 → row 4; lon frac .15 → col 1 → value 401.
    const filled = await insertCleanSample(conn, {}, {
      latitude: "44.55", longitude: "-123.85", elevation_m: "NULL",
    });
    // void cell: lat .19 → row 8; lon frac .95 → col 9.
    const voided = await insertCleanSample(conn, { sample_number: "'2'" }, {
      latitude: "44.19", longitude: "-123.05", elevation_m: "NULL",
    });
    // no tile for n45.
    const missing = await insertCleanSample(conn, { sample_number: "'3'" }, {
      latitude: "45.5", longitude: "-123.5", elevation_m: "NULL",
    });

    const result = await deriveElevations(conn, demDir);
    expect(result).toEqual({
      gaps: 3,
      filled: 1,
      voids: 1,
      missingTiles: ["n45_w124_1arc_v3.tif"],
    });

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
});
