import type { DuckDBConnection } from "@duckdb/node-api";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadSpatial, openDuckDb } from "./db.js";
import { duckdbReader } from "./person-change.js";
import { recordSampleChanges, sampleLogFor } from "./sample-change.js";

/**
 * Work out which areas each sample's believed-true point lies inside
 * (beeline-9jd4), into sample_area (schema/038), copying each area a sample
 * lands in from the gazetteer into the store. The nightly runs it before
 * naming localities; "Check iNaturalist now" runs it for the checked
 * person's samples; `pnpm area:derive` runs it by hand. Two kinds so far:
 * the federal wilderness (beeline-zdfz), and the county or BC regional
 * district (beeline-313x), which is the one the point is in, or for a point
 * on the shore just outside every county, the nearest within 1 km.
 *
 * With `stampCounties`, it then writes the county of each sample still to
 * print from
 * that area: Beeline stamps the county itself, from the coordinates, rather
 * than taking iNaturalist's (Peter, 2026-10-27). See stampCounties below.
 *
 * As with localities (src/derive-locality.ts), a sample is tested when it
 * has not been yet, when its coordinates have moved from the point it was
 * tested at, or when it was tested against another gazetteer build, in
 * batches that are each their own transaction. Without a gazetteer there is
 * nothing to do, and the step says so rather than failing: an area is never
 * a QC finding and never blocks printing.
 */

// A name of its own for each attachment, for derive-locality.ts's reason:
// ATTACH and DETACH act on the whole instance, which the nightly and "Check
// iNaturalist now" share.
let attachments = 0;

/**
 * How far inside a wilderness's outline a point must be to count as inside
 * it: the program allows 100 m for GPS error (Peter, 2026-10-26). Measured to
 * the nearest edge, the edges of a cut-out road corridor included, so a
 * sample taken beside the Steens Mountain Loop Road is not inside the
 * wilderness the road runs through. The outline is itself simplified to
 * about 30 m (scripts/fetch-gazetteer.sh), well within this.
 */
export const WILDERNESS_EDGE_M = 100;

/**
 * How far outside every county a point may be and still take the nearest
 * one (Peter, 2026-10-27). The Census's cartographic boundaries stop at the
 * shoreline, so a sample taken on a beach falls just outside them: on the
 * sandbox store 134 of 136 such samples in Washington and Oregon were within
 * 1 km of a county, a median 13 m and 56 m out.
 */
export const COUNTY_SHORE_M = 1000;

export interface AreaResult {
  /** Null when there was no gazetteer to read. */
  gazetteerBuild: string | null;
  pending: number;
  /** Of the samples tested, how many lie inside a wilderness. */
  inWilderness: number;
  /** Of the samples tested, how many lie inside a county or regional district. */
  inCounty: number;
  /** The gazetteer was built before it held any areas: nothing was tested. */
  outdated: boolean;
  /** Samples whose county was written from their coordinates (stampCounties). */
  countiesStamped: number;
}

export interface DeriveAreaOptions {
  signal?: AbortSignal;
  batchSize?: number;
  /** Test only the samples this iNaturalist user collected, as deriveLocalities does. */
  observerUserId?: number;
  /**
   * Write the county of each sample still to print from its coordinates once the areas
   * are found. The nightly and the CLI do, and record what changed in the
   * sample log as coming from the coordinates; "Check iNaturalist now" does
   * not, since it records no sample changes and the next nightly would credit
   * its writes to an iNaturalist sync.
   */
  stampCounties?: boolean;
}

type Conn = DuckDBConnection;

async function rows<T>(conn: Conn, sql: string, params?: unknown[]): Promise<T[]> {
  const reader = await conn.runAndReadAll(sql, params as never);
  return reader.getRowObjectsJS() as T[];
}

export async function deriveAreas(conn: Conn, gazetteerPath: string, opts: DeriveAreaOptions = {}): Promise<AreaResult> {
  const result: AreaResult = {
    gazetteerBuild: null, pending: 0, inWilderness: 0, inCounty: 0, outdated: false, countiesStamped: 0,
  };
  try {
    await access(gazetteerPath);
  } catch {
    return result;
  }
  await loadSpatial(conn);
  const G = `gazetteer_area_${++attachments}`;
  await conn.run(`ATTACH '${gazetteerPath.replaceAll("'", "''")}' AS ${G} (READ_ONLY)`);
  try {
    const [build] = await rows<{ build_id: string }>(conn, `SELECT build_id FROM ${G}.gazetteer_build`);
    if (build === undefined) throw new Error(`${gazetteerPath} has no gazetteer_build row: rebuild it`);
    result.gazetteerBuild = build.build_id;
    // A gazetteer from before areas (beeline-9jd4), without the wildernesses
    // or without its regions' own ids, is still good for localities; it only
    // has no areas to test against.
    const [{ n: found } = { n: 0 }] = await rows<{ n: number }>(
      conn,
      `SELECT count(*)::INTEGER AS n FROM duckdb_columns() WHERE database_name = $1
         AND ((table_name = 'wilderness' AND column_name = 'wid')
              OR (table_name = 'region' AND column_name = 'source_id'))`,
      [G],
    );
    if (found < 2) {
      result.outdated = true;
      return result;
    }
    const pending = await rows<{ sample_id: number; lat: number; lon: number }>(
      conn,
      `SELECT l.sample_id, l.latitude AS lat, l.longitude AS lon
         FROM sample_location l
         LEFT JOIN sample_area_derivation d ON d.sample_id = l.sample_id
        WHERE (d.sample_id IS NULL OR d.gazetteer_build <> $1
               OR abs(d.latitude - l.latitude) > 5e-5 OR abs(d.longitude - l.longitude) > 5e-5)
          AND ($2::BIGINT IS NULL OR l.sample_id IN (
                SELECT sc.sample_id FROM sample_collector sc
                JOIN inat_account a ON a.person_id = sc.person_id
                WHERE a.inat_user_id = $2::BIGINT))
        ORDER BY l.sample_id`,
      [build.build_id, opts.observerUserId ?? null],
    );
    result.pending = pending.length;
    const size = opts.batchSize ?? 5000;
    for (let i = 0; i < pending.length; i += size) {
      opts.signal?.throwIfAborted();
      const found = await testBatch(conn, pending.slice(i, i + size), G, build.build_id);
      result.inWilderness += found.wilderness;
      result.inCounty += found.county;
    }
    // An area no sample lies inside any more goes: the store keeps only the
    // areas somebody collected in.
    await conn.run(`DELETE FROM area a WHERE NOT EXISTS (
      SELECT 1 FROM sample_area sa WHERE sa.area_source = a.source AND sa.area_source_id = a.source_id)`);
    if (opts.stampCounties) result.countiesStamped = await stampCounties(conn, G);
    return result;
  } finally {
    await conn.run(`DETACH ${G}`);
  }
}

/** Every area the gazetteer holds, in the store's terms. */
const gazetteerAreas = (G: string) => `
  SELECT 'wilderness.net' AS source, wid AS source_id, 'wilderness' AS kind, name, geom FROM ${G}.wilderness
  UNION ALL
  SELECT source, source_id, 'county' AS kind, name, geom FROM ${G}.region`;

/** Replace one batch's areas; returns how many of its samples lie inside an area of each kind. */
async function testBatch(
  conn: Conn,
  batch: Array<{ sample_id: number; lat: number; lon: number }>,
  G: string,
  buildId: string,
): Promise<{ wilderness: number; county: number }> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE area_batch (sample_id INTEGER, lat DOUBLE, lon DOUBLE)`);
  const appender = await conn.createAppender("area_batch", "main", "temp");
  for (const p of batch) {
    appender.appendInteger(p.sample_id);
    appender.appendDouble(p.lat);
    appender.appendDouble(p.lon);
    appender.endRow();
  }
  appender.closeSync();
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE area_batch_hit AS
    SELECT DISTINCT sample_id, 'wilderness.net' AS source, wid AS source_id, 'wilderness' AS kind
    FROM (SELECT b.sample_id, b.lat, b.lon, w.wid,
                 ST_ClosestPoint(ST_Boundary(w.geom), ST_Point(b.lon, b.lat)) AS edge
          FROM area_batch b JOIN ${G}.wilderness w ON ST_Contains(w.geom, ST_Point(b.lon, b.lat)))
    -- Metres to the nearest edge, by the haversine formula on the points'
    -- own coordinates, so no function's guess at axis order is involved.
    WHERE 2 * 6371000 * asin(sqrt(pow(sin(radians(ST_Y(edge) - lat) / 2), 2)
            + cos(radians(lat)) * cos(radians(ST_Y(edge))) * pow(sin(radians(ST_X(edge) - lon) / 2), 2)))
          > ${WILDERNESS_EDGE_M}
    UNION ALL
    -- The county or regional district the point is in, with no allowance at
    -- the line between two: a point is in one or the other.
    SELECT DISTINCT b.sample_id, r.source, r.source_id, 'county'
    FROM area_batch b JOIN ${G}.region r ON ST_Contains(r.geom, ST_Point(b.lon, b.lat))
    UNION ALL
    -- A point in no county at all, on a beach outside boundaries that stop
    -- at the shoreline, takes the nearest within COUNTY_SHORE_M: one row, so
    -- a tie (a point exactly on a line, which ST_Contains gives to neither)
    -- cannot take its source from one county and its id from the other.
    -- Not refused across a border the gazetteer does not cover: a point just
    -- inside Alberta is recorded in the BC district beside it, and only the
    -- stamp's state check keeps that off the sample's county.
    SELECT sample_id, source, source_id, 'county'
    FROM (SELECT b.sample_id, r.source, r.source_id,
                 ST_ClosestPoint(r.geom, ST_Point(b.lon, b.lat)) AS edge, b.lat, b.lon
          FROM area_batch b JOIN ${G}.region r ON ST_DWithin(r.geom, ST_Point(b.lon, b.lat), 0.03)
          WHERE NOT EXISTS (SELECT 1 FROM ${G}.region r2 WHERE ST_Contains(r2.geom, ST_Point(b.lon, b.lat)))) near,
         LATERAL (SELECT 2 * 6371000 * asin(sqrt(pow(sin(radians(ST_Y(edge) - lat) / 2), 2)
                    + cos(radians(lat)) * cos(radians(ST_Y(edge))) * pow(sin(radians(ST_X(edge) - lon) / 2), 2))) AS m)
    WHERE m <= ${COUNTY_SHORE_M}
    QUALIFY row_number() OVER (PARTITION BY sample_id ORDER BY m, source, source_id) = 1`);
  const now = new Date().toISOString();
  await conn.run("BEGIN TRANSACTION");
  try {
    // Each area a sample in this batch landed in, copied in or brought up to
    // this build. An area already copied from this build is left alone, so
    // its outline is written once a build rather than once a batch.
    await conn.run(
      `INSERT INTO area (source, source_id, kind, name, geom, gazetteer_build)
       SELECT g.source, g.source_id, g.kind, g.name, g.geom, $1
       FROM (${gazetteerAreas(G)}) g
       WHERE EXISTS (SELECT 1 FROM area_batch_hit h WHERE h.source = g.source AND h.source_id = g.source_id)
         AND NOT EXISTS (SELECT 1 FROM area a
                         WHERE a.source = g.source AND a.source_id = g.source_id AND a.gazetteer_build = $1)
       ON CONFLICT (source, source_id) DO UPDATE
         SET name = excluded.name, geom = excluded.geom, gazetteer_build = excluded.gazetteer_build`,
      [buildId],
    );
    await conn.run(`DELETE FROM sample_area WHERE sample_id IN (SELECT sample_id FROM area_batch)`);
    await conn.run(`DELETE FROM sample_area_derivation WHERE sample_id IN (SELECT sample_id FROM area_batch)`);
    await conn.run(
      `INSERT INTO sample_area_derivation (sample_id, latitude, longitude, gazetteer_build, derived_at)
       SELECT sample_id, lat, lon, $1, $2::TIMESTAMP FROM area_batch`,
      [buildId, now],
    );
    await conn.run(
      `INSERT INTO sample_area (sample_id, area_source, area_source_id)
       SELECT sample_id, source, source_id FROM area_batch_hit`,
    );
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
  const [found] = await rows<{ wilderness: number; county: number }>(
    conn,
    `SELECT count(DISTINCT sample_id) FILTER (WHERE kind = 'wilderness')::INTEGER AS wilderness,
            count(DISTINCT sample_id) FILTER (WHERE kind = 'county')::INTEGER AS county
     FROM area_batch_hit`,
  );
  return { wilderness: found?.wilderness ?? 0, county: found?.county ?? 0 };
}

/**
 * Write each sample's county from the county area its point is in
 * (beeline-313x, Peter, 2026-10-27), as the gazetteer writes it: the
 * Census's name in the US (Benton, Doña Ana), and in BC the district's name
 * as iNaturalist writes it (Capital, Comox Valley), which a label prints as
 * the province abbreviates it (src/label-text.ts). Only where all of these
 * hold, and nowhere else:
 *
 * - the sample has an observation. Every sample still to print does; the rest are
 *   the old system's records, whose county is what the record or a staff
 *   correction says (ADR 0004).
 * - it is from an active season and no label for it has printed. A printed
 *   sample's county is what its labels say, as a printed locality is
 *   (CONTEXT.md, Upstream); and a settled sample with no print recorded was
 *   most likely printed before Beeline kept the record, and will not print
 *   again either way (Peter, 2026-10-27).
 * - it is not frozen into a print run that has not printed. The run holds
 *   its label text from the freeze, so the record keeps the county the
 *   labels will carry (Peter, 2026-10-27).
 * - the sample's state or province is the point's. Where they disagree the
 *   sample is wrong in a way no county can fix, and a BC district on an
 *   Alberta sample would only make it worse.
 * - the point is in exactly one county.
 *
 * Minting still fills an empty county from iNaturalist (ingest/mint-samples.sql),
 * and the next stamp replaces it: so a sample is never without a county
 * waiting for the nightly. Returns how many samples changed.
 */
async function stampCounties(conn: Conn, G: string): Promise<number> {
  // The changes are worked out first and written after, as promotion writes
  // the sample (ingest/mint-samples.sql). DuckDB refused the one-statement
  // form, an UPDATE with these conditions on sample in its WHERE and a
  // RETURNING, as a foreign-key violation on a sample other tables refer to.
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE county_stamp AS
    SELECT s.entity_id AS sample_id, point.county
    FROM sample s
    JOIN (SELECT a.sample_id, any_value(r.county) AS county, any_value(r.state) AS state
          FROM sample_area_current a JOIN ${G}.region r ON r.source = a.source AND r.source_id = a.source_id
          WHERE a.kind = 'county'
          GROUP BY a.sample_id HAVING count(*) = 1) point ON point.sample_id = s.entity_id
    WHERE s.inat_observation_id IS NOT NULL
      AND s.state_province = point.state
      AND NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)
      AND NOT EXISTS (SELECT 1 FROM settled_sample ss WHERE ss.sample_id = s.entity_id)
      AND NOT EXISTS (SELECT 1 FROM sample_label_in_progress lp
                      WHERE lp.sample_id = s.entity_id AND lp.printing_count > 0)
      AND point.county IS NOT NULL
      AND s.county IS DISTINCT FROM point.county`);
  await conn.run(`UPDATE sample SET county = t.county FROM county_stamp t WHERE sample.entity_id = t.sample_id`);
  const [stamped] = await rows<{ n: number }>(conn, `SELECT count(*)::INTEGER AS n FROM county_stamp`);
  return stamped?.n ?? 0;
}

/** One line for the job's detail. */
export function describeAreas(r: AreaResult): string | null {
  if (r.gazetteerBuild === null) return "areas: no gazetteer on this machine";
  if (r.outdated) return "areas: the gazetteer predates them; rebuild it";
  const stamped = r.countiesStamped > 0 ? `; ${r.countiesStamped} county(ies) written from the coordinates` : "";
  if (r.pending === 0) return stamped === "" ? null : `areas${stamped}`;
  return `areas: ${r.pending} sample(s) tested, ${r.inWilderness} inside a wilderness, ${r.inCounty} in a county${stamped}`;
}

// CLI: pnpm area:derive [db] [gazetteer]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const instance = await openDuckDb(process.argv[2] ?? "beeline.duckdb");
  const conn = await instance.connect();
  const started = Date.now();
  // Checkpointed before closing, for derive-locality.ts's reason (beeline-c1b).
  try {
    const dbPath = process.argv[2] ?? "beeline.duckdb";
    const result = await deriveAreas(conn, process.argv[3] ?? "data/gazetteer.duckdb", { stampCounties: true });
    // The counties it wrote go into the sample log as the coordinates' doing,
    // where this is the store whose log this environment keeps.
    const paths = sampleLogFor(dbPath, process.env);
    // Only when it wrote some: the pass credits every difference since the
    // last one, so with nothing stamped it would credit another writer's.
    const recorded = paths === null || result.countiesStamped === 0
      ? null
      : await recordSampleChanges(duckdbReader(conn), paths, { source: "coordinates" });
    if (recorded?.refused != null) console.warn(`sample history not recorded: ${recorded.refused}`);
    await conn.run("CHECKPOINT");
    console.log(JSON.stringify({
      ...result,
      sampleChangesRecorded: recorded?.appended ?? null,
      seconds: Math.round((Date.now() - started) / 1000),
    }, null, 2));
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
