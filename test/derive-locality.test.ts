import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpatial, openDuckDb } from "../src/db.js";
import { deriveLocalities } from "../src/derive-locality.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

// A gazetteer of a few hand-drawn shapes, with the tables and columns
// ingest/gazetteer.sql builds: synthetic, since the real one is built from
// downloads no test should make. One refuge square west of Corvallis, a
// county around everything, two towns, and a lake volunteers have named.

let dir: string;

async function buildGazetteer(path: string, buildId: string): Promise<void> {
  await rm(path, { force: true });
  const instance = await openDuckDb(path);
  const conn = await instance.connect();
  await loadSpatial(conn);
  const box = (w: number, s: number, e: number, n: number) => `ST_MakeEnvelope(${w}, ${s}, ${e}, ${n})`;
  await conn.run(`
    CREATE TABLE gazetteer_build AS SELECT '${buildId}' AS build_id, current_timestamp AS built_at;
    CREATE TABLE region AS SELECT 'US-OR-Benton' AS region_id, 'USA' AS country, 'OR' AS state, 'Benton' AS county,
      ${box(-124, 44, -122, 45)} AS geom;
    CREATE TABLE refuge AS SELECT 'WILLIAM L. FINLEY NATIONAL WILDLIFE REFUGE' AS name, ${box(-123.35, 44.38, -123.25, 44.45)} AS geom;
    CREATE TABLE wildlife_area_unit (unit TEXT, area TEXT, geom GEOMETRY);
    CREATE TABLE nps_unit (unit TEXT, geom GEOMETRY);
    CREATE TABLE state_park (park TEXT, suffix TEXT, geom GEOMETRY);
    CREATE TABLE town_limits (name TEXT, kind TEXT, geom GEOMETRY);
    CREATE TABLE osm_area (osm_id TEXT, name TEXT, area_ha DOUBLE, is_island BOOLEAN, geom GEOMETRY);
    CREATE TABLE place AS SELECT * FROM (VALUES
      (1, 'Philomath', 44.54, -123.37, 'town', 'PPL', 5000, 'US-OR-Benton', NULL),
      (2, 'Alsea', 44.38, -123.60, 'town', 'PPL', 164, 'US-OR-Benton', NULL))
      t(id, name, lat, lon, kind, fcode, pop, region_id, island_id);
    CREATE TABLE feature AS SELECT 10 AS id, 'Marys Peak Lake' AS name, 44.70 AS lat, -123.60 AS lon,
      'H.LK' AS code, 'OR' AS state, NULL::TEXT AS island_id, 'maryspeaklake' AS fold;
  `);
  conn.closeSync();
  instance.closeSync();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "beeline-gazetteer-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function storeWithPerson(): Promise<DuckDBConnection> {
  const { conn } = await createMemoryDb();
  await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Adams'), ('Bo Brown')`);
  return conn;
}

const suggestions = (conn: DuckDBConnection) =>
  rows(conn, `SELECT sample_id, locality, basis FROM sample_locality_suggestion_current ORDER BY sample_id`);

describe("deriveLocalities", () => {
  test("without a gazetteer there is nothing to do, and it says so", async () => {
    const conn = await storeWithPerson();
    await insertCleanSample(conn);
    const r = await deriveLocalities(conn, join(dir, "absent.duckdb"));
    expect(r).toMatchObject({ gazetteerBuild: null, pending: 0, named: 0 });
    expect(await suggestions(conn)).toEqual([]);
  });

  test("names each sample from its point, and records the point and the build", async () => {
    const path = join(dir, "a.duckdb");
    await buildGazetteer(path, "build-a");
    const conn = await storeWithPerson();
    const inRefuge = await insertCleanSample(conn, {}, { latitude: "44.41", longitude: "-123.30" });
    const nearTown = await insertCleanSample(conn, { sample_number: "'2'" }, { latitude: "44.55", longitude: "-123.38" });
    const r = await deriveLocalities(conn, path);
    expect(r).toMatchObject({ gazetteerBuild: "build-a", pending: 2, named: 2, unnamed: 0 });
    expect(await suggestions(conn)).toEqual([
      [inRefuge, "Finley NWR", "refuge"],
      [nearTown, "Philomath", "town"],
    ]);
    const [[lat, lon, build]] = (await rows(
      conn,
      `SELECT latitude, longitude, gazetteer_build FROM sample_locality_suggestion WHERE sample_id = ${inRefuge}`,
    )) as [[number, number, string]];
    expect([lat, lon, build]).toEqual([44.41, -123.3, "build-a"]);
    // The sample's own locality is never touched: this is only a suggestion.
    expect(await rows(conn, `SELECT DISTINCT locality FROM sample`)).toEqual([["Corvallis"]]);
    // A second run has nothing left to name.
    expect((await deriveLocalities(conn, path)).pending).toBe(0);
  });

  test("a moved point is not shown, and is named again; so is every sample after a new build", async () => {
    const path = join(dir, "b.duckdb");
    await buildGazetteer(path, "build-b1");
    const conn = await storeWithPerson();
    const id = await insertCleanSample(conn, {}, { latitude: "44.41", longitude: "-123.30" });
    await deriveLocalities(conn, path);
    await conn.run(`UPDATE sample_location SET latitude = 44.55, longitude = -123.38 WHERE sample_id = ${id}`);
    expect(await suggestions(conn)).toEqual([]);
    expect(await deriveLocalities(conn, path)).toMatchObject({ pending: 1, named: 1 });
    expect(await suggestions(conn)).toEqual([[id, "Philomath", "town"]]);
    await buildGazetteer(path, "build-b2");
    expect(await deriveLocalities(conn, path)).toMatchObject({ gazetteerBuild: "build-b2", pending: 1, named: 1 });
  });

  test("a feature whose name volunteers wrote nearby names the samples near it", async () => {
    const path = join(dir, "c.duckdb");
    await buildGazetteer(path, "build-c");
    const conn = await storeWithPerson();
    // Two collectors have written the lake's name for samples beside it.
    await insertCleanSample(conn, { locality: "'Marys Peak Lake'" }, { latitude: "44.701", longitude: "-123.601" });
    await insertCleanSample(
      conn,
      { locality: "'Marys Peak Lake'", sample_number: "'2'", collector_id: "(SELECT max(entity_id) FROM person)" },
      { latitude: "44.699", longitude: "-123.599" },
    );
    // A third sample 3 km away, whose collector wrote a town.
    const away = await insertCleanSample(conn, { sample_number: "'3'" }, { latitude: "44.727", longitude: "-123.600" });
    await deriveLocalities(conn, path);
    expect((await suggestions(conn)).find(([sampleId]) => sampleId === away)).toEqual([away, "Marys Peak Lake", "feature"]);
  });
});
