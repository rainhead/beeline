import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createMemoryDb } from "../src/build-db.js";
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
  usernameRegister: fixture("no-usernames.csv"),
};

export async function rows(conn: DuckDBConnection, sql: string): Promise<unknown[][]> {
  const result = await conn.run(sql);
  return result.getRows();
}

/**
 * A sample with every label-required field present and a positive count,
 * including a believed-true location row. Pass location: null to omit the
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
    date_start: "DATE '2026-07-14'",
    date_end: "DATE '2026-07-14'",
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
