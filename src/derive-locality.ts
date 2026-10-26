import type { DuckDBConnection } from "@duckdb/node-api";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadSpatial, openDuckDb } from "./db.js";
import {
  nameLocality,
  type GazetteerPlace,
  type LocalityBasis,
  type LocalityEvidence,
  type Near,
  type UsedFeature,
} from "./locality-rule.js";

/**
 * Name each sample's locality from its coordinates (beeline-7i6), into
 * sample_locality_suggestion (schema/037). The nightly runs it after
 * elevations; `pnpm locality:derive` runs it by hand.
 *
 * The gazetteer is a separate file (ingest/gazetteer.sql), attached read-only
 * for the run and detached after. Without one there is nothing to do, and
 * the step says so rather than failing: a suggestion is never a QC finding
 * and never blocks printing.
 *
 * A sample is named when it has no name yet, when its coordinates have moved
 * from the point it was named at, or when its name came from another
 * gazetteer build. Samples are named in batches, each its own transaction,
 * so a run stopped part-way keeps what it did.
 */

// The gazetteer is attached under a name of its own for each run. ATTACH
// and DETACH act on the whole database instance, which the nightly and
// "Check iNaturalist now" share, so with one fixed name a check finishing
// could detach the gazetteer from under a nightly that had just started.
let attachments = 0;

export interface LocalityResult {
  /** Null when there was no gazetteer to read. */
  gazetteerBuild: string | null;
  pending: number;
  named: number;
  /** Points nothing in the gazetteer could name: no town in reach at all. */
  unnamed: number;
  byBasis: Partial<Record<LocalityBasis, number>>;
}

export interface DeriveLocalityOptions {
  signal?: AbortSignal;
  batchSize?: number;
  /**
   * Name only the samples this iNaturalist user collected, as "Check
   * iNaturalist now" does for the person who clicked: someone is waiting, and
   * the rest of the store is the nightly's.
   */
  observerUserId?: number;
}

type Conn = DuckDBConnection;

async function rows<T>(conn: Conn, sql: string, params?: unknown[]): Promise<T[]> {
  const reader = await conn.runAndReadAll(sql, params as never);
  return reader.getRowObjectsJS() as T[];
}

export async function deriveLocalities(
  conn: Conn,
  gazetteerPath: string,
  opts: DeriveLocalityOptions = {},
): Promise<LocalityResult> {
  const result: LocalityResult = { gazetteerBuild: null, pending: 0, named: 0, unnamed: 0, byBasis: {} };
  try {
    await access(gazetteerPath);
  } catch {
    return result;
  }
  await loadSpatial(conn);
  const G = `gazetteer_${++attachments}`;
  await conn.run(`ATTACH '${gazetteerPath.replaceAll("'", "''")}' AS ${G} (READ_ONLY)`);
  try {
    const [build] = await rows<{ build_id: string }>(conn, `SELECT build_id FROM ${G}.gazetteer_build`);
    if (build === undefined) throw new Error(`${gazetteerPath} has no gazetteer_build row: rebuild it`);
    result.gazetteerBuild = build.build_id;
    await createMacros(conn);
    const pending = await rows<{ sample_id: number; lat: number; lon: number }>(
      conn,
      `SELECT l.sample_id, l.latitude AS lat, l.longitude AS lon
         FROM sample_location l
         LEFT JOIN sample_locality_suggestion g ON g.sample_id = l.sample_id
        WHERE (g.sample_id IS NULL OR g.gazetteer_build <> $1
               OR abs(g.latitude - l.latitude) > 5e-5 OR abs(g.longitude - l.longitude) > 5e-5)
          AND ($2::BIGINT IS NULL OR l.sample_id IN (
                SELECT sc.sample_id FROM sample_collector sc
                JOIN inat_account a ON a.person_id = sc.person_id
                WHERE a.inat_user_id = $2::BIGINT))
        ORDER BY l.sample_id`,
      [build.build_id, opts.observerUserId ?? null],
    );
    result.pending = pending.length;
    if (pending.length === 0) return result;
    await usedFeatures(conn, G);
    const size = opts.batchSize ?? 5000;
    for (let i = 0; i < pending.length; i += size) {
      opts.signal?.throwIfAborted();
      const batch = pending.slice(i, i + size);
      const evidence = await gather(conn, batch, G);
      const now = new Date().toISOString();
      const named: unknown[][] = [];
      for (const p of batch) {
        const n = nameLocality(evidence.get(p.sample_id)!);
        if (n === null) {
          result.unnamed += 1;
          continue;
        }
        named.push([p.sample_id, n.locality, n.basis, p.lat, p.lon, build.build_id, now]);
        result.byBasis[n.basis] = (result.byBasis[n.basis] ?? 0) + 1;
      }
      await write(conn, named);
      result.named += named.length;
    }
    return result;
  } finally {
    await conn.run(`DETACH ${G}`);
  }
}

async function createMacros(conn: Conn): Promise<void> {
  await conn.run(`
    CREATE OR REPLACE TEMP MACRO hav_km(lat1, lon1, lat2, lon2) AS
      2 * 6371 * asin(sqrt(pow(sin(radians(lat2 - lat1) / 2), 2)
        + cos(radians(lat1)) * cos(radians(lat2)) * pow(sin(radians(lon2 - lon1) / 2), 2)));
    -- Degrees from the first point to the second, 0–360.
    CREATE OR REPLACE TEMP MACRO bearing_deg(lat1, lon1, lat2, lon2) AS
      (degrees(atan2(sin(radians(lon2 - lon1)) * cos(radians(lat2)),
        cos(radians(lat1)) * sin(radians(lat2))
          - sin(radians(lat1)) * cos(radians(lat2)) * cos(radians(lon2 - lon1)))) + 360) % 360;
    -- How many degrees of longitude make km at this latitude, for the boxes
    -- that pre-filter a distance. A degree of latitude is about 111 km
    -- everywhere and a degree of longitude only that times cos(latitude):
    -- 79 km at Atlin, so a box in fixed degrees there reached a town 39 km
    -- east and not one 45 km east (Fable's review).
    CREATE OR REPLACE TEMP MACRO lon_deg(km, lat) AS km / (111.32 * cos(radians(lat)));
    -- A locality folded as ingest/gazetteer.sql folds a feature's name.
    CREATE OR REPLACE TEMP MACRO fold_locality_name(s) AS
      regexp_replace(replace(replace(lower(s), 'mount ', 'mt '), 'mountain', 'mt'), '[^a-z0-9]', '', 'g');
  `);
}

/**
 * Features that are not towns (a lake, a pass, a landmark) whose name
 * volunteers have already written as the locality of samples within 10 km
 * of it, with how many samples and how many collectors: Takhlakh Lake. Read
 * from the whole store once a run, since any sample's locality counts.
 */
async function usedFeatures(conn: Conn, G: string): Promise<void> {
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE locality_used_feature AS
    SELECT f.id, any_value(f.name) AS name, any_value(f.code) AS code, any_value(f.lat) AS lat,
           any_value(f.lon) AS lon, any_value(f.island_id) AS island_id,
           count(DISTINCT s.entity_id)::INTEGER AS samples, count(DISTINCT pc.person_id)::INTEGER AS collectors
    FROM sample s
    JOIN sample_location l ON l.sample_id = s.entity_id
    LEFT JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
    JOIN ${G}.feature f ON f.fold = fold_locality_name(s.locality)
      AND abs(f.lat - l.latitude) < 0.1 AND abs(f.lon - l.longitude) < lon_deg(11, l.latitude)
    WHERE s.locality IS NOT NULL AND hav_km(l.latitude, l.longitude, f.lat, f.lon) <= 10
    GROUP BY f.id`);
}

interface PlaceRow {
  sample_id: number;
  id: number;
  name: string;
  kind: GazetteerPlace["kind"];
  fcode: string;
  pop: number;
  region_id: string | null;
  island_id: string | null;
  km: number;
  brg: number;
}

const near = (r: PlaceRow): Near<GazetteerPlace> => ({
  at: { id: r.id, name: r.name, kind: r.kind, fcode: r.fcode, pop: r.pop, regionId: r.region_id, islandId: r.island_id },
  km: r.km,
  bearing: r.brg,
});

/** What the gazetteer says about each point in a batch. */
async function gather(
  conn: Conn,
  batch: Array<{ sample_id: number; lat: number; lon: number }>,
  G: string,
): Promise<Map<number, LocalityEvidence>> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE locality_batch (sample_id INTEGER, lat DOUBLE, lon DOUBLE)`);
  const appender = await conn.createAppender("locality_batch", "main", "temp");
  for (const p of batch) {
    appender.appendInteger(p.sample_id);
    appender.appendDouble(p.lat);
    appender.appendDouble(p.lon);
    appender.endRow();
  }
  appender.closeSync();
  const ev = new Map<number, LocalityEvidence>();
  for (const p of batch) {
    ev.set(p.sample_id, {
      regionId: null, refuge: null, wildlifeArea: null, nationalPark: null, statePark: null, parks: [],
      island: null, townLimits: null, nearby: [], farTowns: [], features: [],
    });
  }
  const of = (id: number) => ev.get(id)!;

  await conn.run(`
    CREATE OR REPLACE TEMP TABLE locality_batch_region AS
    SELECT b.sample_id, any_value(r.region_id) AS region_id
    FROM locality_batch b JOIN ${G}.region r ON ST_Intersects(r.geom, ST_Point(b.lon, b.lat))
    GROUP BY b.sample_id`);
  for (const r of await rows<{ sample_id: number; region_id: string }>(conn, `SELECT * FROM locality_batch_region`)) {
    of(r.sample_id).regionId = r.region_id;
  }

  const inside = (table: string, cols: string) => `
    SELECT b.sample_id, ${cols}
    FROM locality_batch b JOIN ${G}.${table} t ON ST_Contains(t.geom, ST_Point(b.lon, b.lat))
    GROUP BY b.sample_id`;
  for (const r of await rows<{ sample_id: number; name: string }>(conn, inside("refuge", "min(t.name) AS name"))) {
    of(r.sample_id).refuge = r.name;
  }
  for (const r of await rows<{ sample_id: number; unit: string; area: string }>(
    conn,
    inside("wildlife_area_unit", "min(t.unit) AS unit, arg_min(t.area, t.unit) AS area"),
  )) {
    of(r.sample_id).wildlifeArea = { unit: r.unit, area: r.area };
  }
  for (const r of await rows<{ sample_id: number; unit: string }>(conn, inside("nps_unit", "min(t.unit) AS unit"))) {
    of(r.sample_id).nationalPark = r.unit;
  }
  for (const r of await rows<{ sample_id: number; park: string; suffix: string }>(
    conn,
    inside("state_park", "min(t.park) AS park, arg_min(t.suffix, t.park) AS suffix"),
  )) {
    of(r.sample_id).statePark = { park: r.park, suffix: r.suffix };
  }
  // A city's limits first, where a census-designated place overlaps one.
  for (const r of await rows<{ sample_id: number; name: string; kind: "city" | "cdp" }>(
    conn,
    inside(
      "town_limits",
      `arg_min(t.name, (CASE t.kind WHEN 'city' THEN 0 ELSE 1 END, t.name)) AS name,
       arg_min(t.kind, (CASE t.kind WHEN 'city' THEN 0 ELSE 1 END, t.name)) AS kind`,
    ),
  )) {
    of(r.sample_id).townLimits = { name: r.name, kind: r.kind };
  }
  // The named parks and reserves a point is in, smallest first, so a city
  // park inside a regional park keeps its own name. Never a federal
  // wilderness: collecting there is forbidden except where it overlaps a
  // national park the program has a permit for (only Olympic, 2026-10-26),
  // so a wilderness is never a label's locality (Peter, 2026-10-26).
  // OpenStreetMap names every one "... Wilderness", and its protection
  // class alone would also catch wilderness study areas and others.
  for (const r of await rows<{ sample_id: number; name: string; ha: number }>(
    conn,
    `SELECT b.sample_id, o.name, o.area_ha AS ha
       FROM locality_batch b JOIN ${G}.osm_area o
         ON NOT o.is_island AND ST_Contains(o.geom, ST_Point(b.lon, b.lat))
      WHERE NOT regexp_matches(o.name, ' Wilderness$')
      ORDER BY b.sample_id, o.area_ha, o.osm_id`,
  )) {
    of(r.sample_id).parks.push({ name: r.name, ha: r.ha });
  }
  // The island a point is inside (the smallest, for an islet in a lake on an
  // island), else the nearest whose shore is within about 300 m, so a point
  // on Lopez's beach is not given to an islet just offshore.
  for (const r of await rows<{ sample_id: number; id: string; name: string; ha: number }>(
    conn,
    `SELECT sample_id,
            arg_min(osm_id, (CASE WHEN inside THEN area_ha ELSE 1e12 + dist END, osm_id)) AS id,
            arg_min(name, (CASE WHEN inside THEN area_ha ELSE 1e12 + dist END, osm_id)) AS name,
            arg_min(area_ha, (CASE WHEN inside THEN area_ha ELSE 1e12 + dist END, osm_id)) AS ha
       FROM (SELECT b.sample_id, i.osm_id, i.name, i.area_ha,
                    ST_Contains(i.geom, ST_Point(b.lon, b.lat)) AS inside,
                    ST_Distance(i.geom, ST_Point(b.lon, b.lat)) AS dist
               FROM locality_batch b JOIN ${G}.osm_area i
                 ON i.is_island AND ST_DWithin(i.geom, ST_Point(b.lon, b.lat), 0.003))
      GROUP BY sample_id`,
  )) {
    of(r.sample_id).island = { id: r.id, name: r.name, ha: r.ha };
  }

  const placeCols = `p.id, p.name, p.kind, p.fcode, p.pop::DOUBLE AS pop, p.region_id, p.island_id`;
  // Towns with people in them within 50 km, the nearest 20; unpopulated
  // towns, named localities and peaks within 20 km, the nearest 8 of each,
  // so hamlets cannot crowd out the towns.
  for (const r of await rows<PlaceRow>(
    conn,
    `SELECT * FROM (
       SELECT b.sample_id, ${placeCols}, hav_km(b.lat, b.lon, p.lat, p.lon) AS km,
              bearing_deg(p.lat, p.lon, b.lat, b.lon) AS brg
         FROM locality_batch b JOIN ${G}.place p
           ON p.lat BETWEEN b.lat - 0.46 AND b.lat + 0.46 AND p.lon BETWEEN b.lon - lon_deg(51, b.lat) AND b.lon + lon_deg(51, b.lat))
      WHERE (kind = 'town' AND pop > 0 AND km <= 50) OR ((kind <> 'town' OR pop = 0) AND km <= 20)
      QUALIFY row_number() OVER (PARTITION BY sample_id, kind = 'town' AND pop > 0, kind ORDER BY km, id)
              <= CASE WHEN kind = 'town' AND pop > 0 THEN 20 ELSE 8 END
      ORDER BY sample_id, km, id`,
  )) {
    of(r.sample_id).nearby.push(near(r));
  }
  // The nearest towns with people in them, however far, for a point nothing
  // nearer names: the ten nearest, and the three nearest in the point's own
  // state or province, which those ten may not include (Atlin's are in
  // Alaska). Ten, because far from anywhere the distance and direction
  // leave little room for a name: at Pink Mountain, BC, "121km SE Ft St.
  // John" and "115km N Hudson's Hope" are both too long, and Taylor is the
  // nearest town that fits.
  for (const r of await rows<PlaceRow>(
    conn,
    `SELECT DISTINCT * FROM (
       (SELECT b.sample_id, ${placeCols}, hav_km(b.lat, b.lon, p.lat, p.lon) AS km,
               bearing_deg(p.lat, p.lon, b.lat, b.lon) AS brg
          FROM locality_batch b JOIN ${G}.place p ON p.kind = 'town' AND p.pop > 0
           AND p.lat BETWEEN b.lat - 1.5 AND b.lat + 1.5 AND p.lon BETWEEN b.lon - lon_deg(170, b.lat) AND b.lon + lon_deg(170, b.lat)
        QUALIFY row_number() OVER (PARTITION BY b.sample_id ORDER BY km, p.id) <= 10)
       UNION ALL
       (SELECT b.sample_id, ${placeCols}, hav_km(b.lat, b.lon, p.lat, p.lon) AS km,
               bearing_deg(p.lat, p.lon, b.lat, b.lon) AS brg
          FROM locality_batch b
          JOIN locality_batch_region br ON br.sample_id = b.sample_id
          JOIN ${G}.place p ON p.kind = 'town' AND p.pop > 0
           AND p.lat BETWEEN b.lat - 3 AND b.lat + 3 AND p.lon BETWEEN b.lon - lon_deg(340, b.lat) AND b.lon + lon_deg(340, b.lat)
           AND split_part(p.region_id, '-', 1) = split_part(br.region_id, '-', 1)
           AND split_part(p.region_id, '-', 2) = split_part(br.region_id, '-', 2)
        QUALIFY row_number() OVER (PARTITION BY b.sample_id ORDER BY km, p.id) <= 3))
     ORDER BY sample_id, km, id`,
  )) {
    of(r.sample_id).farTowns.push(near(r));
  }
  for (const r of await rows<{
    sample_id: number;
    id: number;
    name: string;
    code: string;
    samples: number;
    collectors: number;
    island_id: string | null;
    km: number;
  }>(
    conn,
    `SELECT b.sample_id, u.id, u.name, u.code, u.samples, u.collectors, u.island_id,
            hav_km(b.lat, b.lon, u.lat, u.lon) AS km
       FROM locality_batch b JOIN locality_used_feature u
         ON abs(u.lat - b.lat) < 0.05 AND abs(u.lon - b.lon) < lon_deg(5.6, b.lat)
      WHERE hav_km(b.lat, b.lon, u.lat, u.lon) <= 5
      ORDER BY b.sample_id, km, u.id`,
  )) {
    const at: UsedFeature = {
      id: r.id, name: r.name, code: r.code, samples: r.samples, collectors: r.collectors, islandId: r.island_id,
    };
    of(r.sample_id).features.push({ at, km: r.km });
  }
  return ev;
}

/** Replace the batch's rows: its samples' old names go, whether or not each was named again. */
async function write(conn: Conn, named: unknown[][]): Promise<void> {
  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run(`DELETE FROM sample_locality_suggestion WHERE sample_id IN (SELECT sample_id FROM locality_batch)`);
    for (let i = 0; i < named.length; i += 500) {
      const chunk = named.slice(i, i + 500);
      const values = chunk.map((_, j) => `(${[1, 2, 3, 4, 5, 6, 7].map((k) => `$${j * 7 + k}`).join(", ")})`);
      await conn.run(
        `INSERT INTO sample_locality_suggestion
           (sample_id, locality, basis, latitude, longitude, gazetteer_build, derived_at)
         VALUES ${values.join(", ")}`,
        chunk.flat() as never,
      );
    }
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}

/** One line for the job's detail. */
export function describeLocalities(r: LocalityResult): string | null {
  if (r.gazetteerBuild === null) return "localities: no gazetteer on this machine";
  if (r.pending === 0) return null;
  return `localities ${r.named}/${r.pending} named` + (r.unnamed > 0 ? `, ${r.unnamed} with nothing in reach` : "");
}

// CLI: pnpm locality:derive [db] [gazetteer]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const instance = await openDuckDb(process.argv[2] ?? "beeline.duckdb");
  const conn = await instance.connect();
  const started = Date.now();
  // Checkpointed before closing: an unreplayed WAL is the state DuckDB 1.5.5
  // can fail to open (beeline-c1b), and the runbook runs this on the store.
  try {
    const result = await deriveLocalities(conn, process.argv[3] ?? "data/gazetteer.duckdb");
    await conn.run("CHECKPOINT");
    console.log(JSON.stringify({ ...result, seconds: Math.round((Date.now() - started) / 1000) }, null, 2));
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
