import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb } from "../src/build-db.js";
import type { PromotionInputs } from "../src/promote-legacy.js";

export { createMemoryDb };

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
  const cols: Record<string, string> = {
    kind: "'net'",
    collector_id: "(SELECT min(entity_id) FROM person)",
    sample_number: "'1'",
    date_start: "DATE '2026-07-14'",
    date_end: "DATE '2026-07-14'",
    specimen_count: "3",
    country: "'USA'",
    state_province: "'OR'",
    county: "'BentonCo'",
    locality: "'Corvallis'",
    protocol: "'net'",
    ...overrides,
  };
  const keys = Object.keys(cols);
  const result = await conn.run(
    `INSERT INTO sample (${keys.join(", ")}) VALUES (${keys.map((k) => cols[k]).join(", ")}) RETURNING entity_id`,
  );
  const [[id]] = (await result.getRows()) as [[number]];
  // Position 1 is the sample's own collector — the invariant every "my
  // samples" query reads (beeline-77j).
  await conn.run(
    `INSERT INTO sample_collector (sample_id, person_id, position)
     SELECT ${id}, collector_id, 1 FROM sample WHERE entity_id = ${id}`,
  );

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
    const locKeys = Object.keys(loc);
    await conn.run(
      `INSERT INTO sample_location (${locKeys.join(", ")}) VALUES (${locKeys.map((k) => loc[k]).join(", ")})`,
    );
  }
  return id;
}
