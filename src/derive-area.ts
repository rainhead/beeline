import type { DuckDBConnection } from "@duckdb/node-api";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadSpatial, openDuckDb } from "./db.js";

/**
 * Work out which areas each sample's believed-true point lies inside
 * (beeline-9jd4), into sample_area (schema/038), copying each area a sample
 * lands in from the gazetteer into the store. The nightly runs it before
 * naming localities; "Check iNaturalist now" runs it for the checked
 * person's samples; `pnpm area:derive` runs it by hand. The only kind so far
 * is the federal wilderness (beeline-zdfz).
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

export interface AreaResult {
  /** Null when there was no gazetteer to read. */
  gazetteerBuild: string | null;
  pending: number;
  /** Of the samples tested, how many lie inside at least one area. */
  inside: number;
  /** The gazetteer was built before it held any areas: nothing was tested. */
  outdated: boolean;
}

export interface DeriveAreaOptions {
  signal?: AbortSignal;
  batchSize?: number;
  /** Test only the samples this iNaturalist user collected, as deriveLocalities does. */
  observerUserId?: number;
}

type Conn = DuckDBConnection;

async function rows<T>(conn: Conn, sql: string, params?: unknown[]): Promise<T[]> {
  const reader = await conn.runAndReadAll(sql, params as never);
  return reader.getRowObjectsJS() as T[];
}

export async function deriveAreas(conn: Conn, gazetteerPath: string, opts: DeriveAreaOptions = {}): Promise<AreaResult> {
  const result: AreaResult = { gazetteerBuild: null, pending: 0, inside: 0, outdated: false };
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
    // A gazetteer from before the wildernesses were added (beeline-9jd4) is
    // still good for localities; it only has no areas to test against.
    const [{ n: tables } = { n: 0 }] = await rows<{ n: number }>(
      conn,
      `SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE database_name = $1 AND table_name = 'wilderness'`,
      [G],
    );
    if (tables === 0) {
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
      result.inside += await testBatch(conn, pending.slice(i, i + size), G, build.build_id);
    }
    // An area no sample lies inside any more goes: the store keeps only the
    // areas somebody collected in.
    await conn.run(`DELETE FROM area a WHERE NOT EXISTS (
      SELECT 1 FROM sample_area sa WHERE sa.area_source = a.source AND sa.area_source_id = a.source_id)`);
    return result;
  } finally {
    await conn.run(`DETACH ${G}`);
  }
}

/** Replace one batch's areas; returns how many of its samples lie inside one. */
async function testBatch(
  conn: Conn,
  batch: Array<{ sample_id: number; lat: number; lon: number }>,
  G: string,
  buildId: string,
): Promise<number> {
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
    SELECT DISTINCT sample_id, 'wilderness.net' AS source, wid AS source_id
    FROM (SELECT b.sample_id, b.lat, b.lon, w.wid,
                 ST_ClosestPoint(ST_Boundary(w.geom), ST_Point(b.lon, b.lat)) AS edge
          FROM area_batch b JOIN ${G}.wilderness w ON ST_Contains(w.geom, ST_Point(b.lon, b.lat)))
    -- Metres to the nearest edge, by the haversine formula on the points'
    -- own coordinates, so no function's guess at axis order is involved.
    WHERE 2 * 6371000 * asin(sqrt(pow(sin(radians(ST_Y(edge) - lat) / 2), 2)
            + cos(radians(lat)) * cos(radians(ST_Y(edge))) * pow(sin(radians(ST_X(edge) - lon) / 2), 2)))
          > ${WILDERNESS_EDGE_M}`);
  const now = new Date().toISOString();
  await conn.run("BEGIN TRANSACTION");
  try {
    // Each area a sample in this batch landed in, copied in or brought up to
    // this build. An area already copied from this build is left alone, so
    // its outline is written once a build rather than once a batch.
    await conn.run(
      `INSERT INTO area (source, source_id, kind, name, geom, gazetteer_build)
       SELECT 'wilderness.net', w.wid, 'wilderness', w.name, w.geom, $1
       FROM ${G}.wilderness w
       WHERE w.wid IN (SELECT source_id FROM area_batch_hit WHERE source = 'wilderness.net')
         AND NOT EXISTS (SELECT 1 FROM area a
                         WHERE a.source = 'wilderness.net' AND a.source_id = w.wid AND a.gazetteer_build = $1)
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
  const [found] = await rows<{ n: number }>(conn, `SELECT count(DISTINCT sample_id)::INTEGER AS n FROM area_batch_hit`);
  return found?.n ?? 0;
}

/** One line for the job's detail. */
export function describeAreas(r: AreaResult): string | null {
  if (r.gazetteerBuild === null) return "areas: no gazetteer on this machine";
  if (r.outdated) return "areas: the gazetteer predates them; rebuild it";
  if (r.pending === 0) return null;
  return `areas: ${r.pending} sample(s) tested, ${r.inside} inside a wilderness`;
}

// CLI: pnpm area:derive [db] [gazetteer]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const instance = await openDuckDb(process.argv[2] ?? "beeline.duckdb");
  const conn = await instance.connect();
  const started = Date.now();
  // Checkpointed before closing, for derive-locality.ts's reason (beeline-c1b).
  try {
    const result = await deriveAreas(conn, process.argv[3] ?? "data/gazetteer.duckdb");
    await conn.run("CHECKPOINT");
    console.log(JSON.stringify({ ...result, seconds: Math.round((Date.now() - started) / 1000) }, null, 2));
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
