import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createMemoryDb } from "../src/build-db.js";
import { loadSpatial, openDuckDb } from "../src/db.js";
import type { PromotionInputs } from "../src/promote-legacy.js";

export { createMemoryDb };

/**
 * The same schema, in a FILE rather than in memory — the shape production
 * actually runs, and a fixture rather than an ad-hoc instance because using it
 * is a deliberate choice a reader should be able to recognise.
 *
 * Reach for it only where being file-backed is the thing under test.
 * createMemoryDb is the default everywhere else and is faster; the one
 * property this buys is that the default catalog is named after the file
 * instead of `memory`, which is where beeline-d34 lived — the private-store
 * patch switched catalog to apply DDL and switched back to a hardcoded
 * `USE memory`, and every test in the suite paired a file-backed PRIVATE
 * store with an in-memory main one, which is the single combination in which
 * that cannot fail.
 *
 * Returns the catalog name so a test can assert against it without hardcoding
 * how it was derived.
 */
export async function createFileDb(): Promise<{
  instance: DuckDBInstance;
  catalog: string;
  privatePath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "beeline-filedb-"));
  const instance = await DuckDBInstance.create(join(dir, "beeline.duckdb"));
  const conn = await instance.connect();
  try {
    await applySchema(conn);
  } finally {
    conn.closeSync();
  }
  return { instance, catalog: "beeline", privatePath: join(dir, "private.duckdb") };
}

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;

/**
 * What promotion reads in a test. Every path here is either a fixture or a
 * file checked into git; NONE of them is one of the gitignored, machine-local
 * paths in LIVE_INPUTS, which is the whole point (beeline-cqk). A test that
 * read `data/corrections.csv` or `data/legacy/usernames.csv` would be reading
 * whatever the developer happened to fetch that morning, and would pass or
 * fail for reasons nothing in the repository records.
 *
 * The two curated overlays are fixtures rather than the real
 * `ingest/person-overlay.csv`: that file names 398 real people, none of whom
 * appear in any fixture, so every row of it would report unresolved — true,
 * and no test's business.
 *
 * Spread it and override the one input under test:
 *   promoteLegacy(conn, { ...FIXTURE_INPUTS, legacyCorrections: CORRECTIONS })
 */
export const FIXTURE_INPUTS: PromotionInputs = {
  taxonomyCsv: fixture("taxonomy.csv"),
  determinerAliases: "ingest/determiner-aliases.csv",
  determinerRegister: "ingest/determiner-register.csv",
  legacyCorrections: "ingest/legacy-corrections.csv",
  appCorrections: fixture("empty-corrections.csv"),
  curatedOverlay: fixture("person-overlay.csv"),
  appOverlay: fixture("empty-person-overlay.csv"),
  collectorAliases: fixture("no-collector-aliases.csv"),
  taxonAliases: fixture("no-taxon-aliases.csv"),
  taxonCuration: fixture("no-taxon-curation.csv"),
  usernameRegister: fixture("no-usernames.csv"),
};

/**
 * Today in Oregon as `YYYY-MM-DD`, where the store reads it (`season`,
 * schema/102) — not in UTC, whose new year comes eight hours early.
 */
const todayInOregon = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

/**
 * The current season: this calendar year, in Oregon. A fixture that should be
 * asked about or printed is dated in it, never in a year written into the
 * test, because a written year becomes a past season on the next 1 January
 * and settles on the 1 March after, and every test that expected it to be
 * active then fails (beeline-a0lj). A test in qc.test.ts holds this to the
 * store's own answer.
 */
export const CURRENT_SEASON = Number(todayInOregon.slice(0, 4));

/**
 * The newest settled season: last season from 1 March, and the one before it
 * in January and February, while last season is still active. A fixture that
 * should have stopped asking is dated in it, not in `CURRENT_SEASON - 1`,
 * which is active for two months of the year.
 */
export const SETTLED_SEASON = CURRENT_SEASON - (Number(todayInOregon.slice(5, 7)) < 3 ? 2 : 1);

/**
 * A day in the current season as `YYYY-MM-DD`, from its month and day. The
 * fixtures use summer days, the middle of a collecting season. Such a day may
 * still lie ahead of today; no rule asks whether a sample was collected in the
 * future, so nothing minds.
 */
export const currentSeasonDate = (month: number, day: number): string =>
  `${CURRENT_SEASON}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/**
 * Every file the app writes, in a directory of its own. Spread it into
 * createApp, then name any path the test reads back:
 *   createApp({ db, config, ...(await scratchPaths()), correctionsPath })
 *
 * The defaults are the developer's own files under `data/`, and a test that
 * fell back to one wrote fake history into them (beeline-yq65); createApp now
 * refuses to fall back under Vitest (src/deployment-path.ts).
 */
export async function scratchPaths() {
  const dir = await mkdtemp(join(tmpdir(), "beeline-app-"));
  return {
    correctionsPath: join(dir, "corrections.csv"),
    personOverlayPath: join(dir, "person-overlay.csv"),
    sampleOverlayPath: join(dir, "sample-overlay.csv"),
    personChangesPath: join(dir, "person-change.csv"),
    sampleChangesPath: join(dir, "sample-change.csv"),
    sampleStatePath: join(dir, "sample-state.csv"),
    programContactsPath: join(dir, "program-contacts.csv"),
    printRunsDir: join(dir, "print-runs"),
  };
}

export async function rows(conn: DuckDBConnection, sql: string): Promise<unknown[][]> {
  const result = await conn.run(sql);
  return result.getRows();
}

/**
 * A sample with every label-required field present and a positive count,
 * including a believed-true location row, collected on 14 July of the open
 * season (CURRENT_SEASON). Pass location: null to omit the
 * location row; pass column overrides as SQL literals.
 */
export async function insertCleanSample(
  conn: DuckDBConnection,
  overrides: Record<string, string> = {},
  location: Record<string, string> | null = {},
): Promise<number> {
  // collector_id and atlas_id stay override KEYS for the fixture's callers,
  // but land in sample_collector and sample_atlas — the columns left sample
  // with beeline-6e9.
  const {
    collector_id = "(SELECT min(entity_id) FROM person)",
    atlas_id = "NULL",
    ...sampleOverrides
  } = overrides;
  const cols: Record<string, string> = {
    kind: "'net'",
    sample_number: "'1'",
    date_start: `DATE '${currentSeasonDate(7, 14)}'`,
    date_end: `DATE '${currentSeasonDate(7, 14)}'`,
    specimen_count: "3",
    country: "'USA'",
    state_province: "'OR'",
    county: "'BentonCo'",
    locality: "'Corvallis'",
    protocol: "'net'",
    ...sampleOverrides,
  };
  const keys = Object.keys(cols);
  const result = await conn.run(
    `INSERT INTO sample (${keys.join(", ")}) VALUES (${keys.map((k) => cols[k]).join(", ")}) RETURNING entity_id`,
  );
  const [[id]] = (await result.getRows()) as [[number]];
  // Position 1 is the primary collector — the head every "my samples" query
  // and attribution read (beeline-77j, beeline-6e9).
  await conn.run(
    `INSERT INTO sample_collector (sample_id, person_id, position)
     VALUES (${id}, ${collector_id}, 1)`,
  );
  if (atlas_id !== "NULL") {
    await conn.run(`INSERT INTO sample_atlas (sample_id, atlas_id) VALUES (${id}, ${atlas_id})`);
  }

  if (location !== null) {
    const loc: Record<string, string> = {
      sample_id: String(id),
      latitude: "44.5646",
      longitude: "-123.2620",
      coordinate_uncertainty_m: "30",
      elevation_m: "72",
      source: "'inat_public'",
      ...location,
    };
    if (loc.elevation_m !== "NULL" && loc.elevation_source_id === undefined) {
      const src = await conn.run(
        `INSERT INTO elevation_source (description, file_name, file_hash)
         VALUES ('test DEM', 'N44_W124_1arc_v3.tif', 'deadbeef') RETURNING entity_id`,
      );
      const [[srcId]] = (await src.getRows()) as [[number]];
      loc.elevation_source_id = String(srcId);
    }
    // An elevation is derived from a point, and the schema will not accept one
    // without it (beeline-x5c). Default to the row's own coordinates: a fixture
    // that wants a stale elevation says so by overriding these.
    if (loc.elevation_m !== "NULL") {
      loc.elevation_latitude ??= loc.latitude!;
      loc.elevation_longitude ??= loc.longitude!;
    }
    const locKeys = Object.keys(loc);
    await conn.run(
      `INSERT INTO sample_location (${locKeys.join(", ")}) VALUES (${locKeys.map((k) => loc[k]).join(", ")})`,
    );
  }
  return id;
}

/**
 * A gazetteer of a few hand-drawn shapes, with the tables and columns
 * ingest/gazetteer.sql builds: synthetic, since the real one is built from
 * downloads no test should make. One refuge square west of Corvallis, a
 * county (Benton, by its Census GEOID) around everything, two towns, a lake
 * volunteers have named, and two made-up wildernesses that both OpenStreetMap
 * and Wilderness.net outline.
 * Shared by the derive steps' tests and the iNaturalist check's (beeline-7i6,
 * beeline-9jd4).
 */
export async function buildTestGazetteer(path: string, buildId: string): Promise<void> {
  await rm(path, { force: true });
  const instance = await openDuckDb(path);
  const conn = await instance.connect();
  await loadSpatial(conn);
  const box = (w: number, s: number, e: number, n: number) => `ST_MakeEnvelope(${w}, ${s}, ${e}, ${n})`;
  await conn.run(`
    CREATE TABLE gazetteer_build AS SELECT '${buildId}' AS build_id, current_timestamp AS built_at;
    CREATE TABLE region AS SELECT 'US-OR-41003' AS region_id, 'USA' AS country, 'OR' AS state, 'Benton' AS county,
      'census' AS source, '41003' AS source_id, 'Benton County' AS name, ${box(-124, 44, -122, 45)} AS geom;
    CREATE TABLE refuge AS SELECT 'WILLIAM L. FINLEY NATIONAL WILDLIFE REFUGE' AS name, ${box(-123.35, 44.38, -123.25, 44.45)} AS geom;
    CREATE TABLE wildlife_area_unit (unit TEXT, area TEXT, geom GEOMETRY);
    CREATE TABLE nps_unit (unit TEXT, geom GEOMETRY);
    CREATE TABLE state_park (park TEXT, suffix TEXT, geom GEOMETRY);
    CREATE TABLE town_limits (name TEXT, kind TEXT, geom GEOMETRY);
    CREATE TABLE osm_area (osm_id TEXT, name TEXT, area_ha DOUBLE, is_island BOOLEAN, geom GEOMETRY);
    -- A made-up federal wilderness, which is never a locality.
    INSERT INTO osm_area VALUES ('way/1', 'Alsea Wilderness', 4000, false, ${box(-123.65, 44.48, -123.55, 44.53)}),
      ('way/2', 'Ox Wilderness Area', 3000, false, ${box(-123.80, 44.48, -123.70, 44.53)});
    CREATE TABLE wilderness AS SELECT * FROM (VALUES
      ('9001', 'Alsea Wilderness', 'FS', ${box(-123.65, 44.48, -123.55, 44.53)}),
      ('9002', 'Ox Wilderness', 'BLM', ${box(-123.80, 44.48, -123.70, 44.53)}))
      t(wid, name, agency, geom);
    CREATE TABLE place AS SELECT * FROM (VALUES
      (1, 'Philomath', 44.54, -123.37, 'town', 'PPL', 5000, 'US-OR-41003', NULL),
      (2, 'Alsea', 44.38, -123.60, 'town', 'PPL', 164, 'US-OR-41003', NULL))
      t(id, name, lat, lon, kind, fcode, pop, region_id, island_id);
    CREATE TABLE feature AS SELECT 10 AS id, 'Marys Peak Lake' AS name, 44.70 AS lat, -123.60 AS lon,
      'H.LK' AS code, 'OR' AS state, NULL::TEXT AS island_id, 'maryspeaklake' AS fold;
    -- A campground, out of the way of every other place here (beeline-4hxe).
    CREATE TABLE campground AS SELECT 'node/20' AS osm_id, 'Alsea Falls Campground' AS name, 44.33 AS lat, -123.49 AS lon;
  `);
  conn.closeSync();
  instance.closeSync();
}
