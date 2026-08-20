import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb } from "../src/build-db.js";

export { createMemoryDb };

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
    collector_id: "1",
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
    `INSERT INTO sample (${keys.join(", ")}) VALUES (${keys.map((k) => cols[k]).join(", ")}) RETURNING id`,
  );
  const [[id]] = (await result.getRows()) as [[number]];

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
         VALUES ('test DEM', 'N44_W124_1arc_v3.tif', 'deadbeef') RETURNING id`,
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
