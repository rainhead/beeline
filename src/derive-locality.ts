import type { DuckDBConnection } from "@duckdb/node-api";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadSpatial, openDuckDb } from "./db.js";
import {
  LOCALITY_RULE_VERSION,
  MAX_LOCALITY_LENGTH,
  localityCandidates,
  type GazetteerPlace,
  type LocalityBasis,
  type LocalityEvidence,
  type NamedLocality,
  type Near,
  type UsedFeature,
} from "./locality-rule.js";

/**
 * Name each sample's locality from its coordinates (beeline-7i6), into
 * sample_locality_candidate (schema/037): the best name and up to three
 * alternatives (beeline-4hxe). The nightly runs it after elevations;
 * `pnpm locality:derive` runs it by hand. `localityCandidatesAt` names one
 * point that is not a sample yet, for a form that is about to make one.
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
  /** Why the best name was chosen, counted. */
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
         LEFT JOIN sample_locality_candidate g ON g.sample_id = l.sample_id AND g.rank = 1
        WHERE (g.sample_id IS NULL OR g.gazetteer_build <> $1 OR g.rule_version <> $3
               OR abs(g.latitude - l.latitude) > 5e-5 OR abs(g.longitude - l.longitude) > 5e-5)
          AND ($2::BIGINT IS NULL OR l.sample_id IN (
                SELECT sc.sample_id FROM sample_collector sc
                JOIN inat_account a ON a.person_id = sc.person_id
                WHERE a.inat_user_id = $2::BIGINT))
        ORDER BY l.sample_id`,
      [build.build_id, opts.observerUserId ?? null, LOCALITY_RULE_VERSION],
    );
    result.pending = pending.length;
    if (pending.length === 0) return result;
    await usedFeatures(conn, G);
    await usedLocalities(conn, G);
    const size = opts.batchSize ?? 5000;
    for (let i = 0; i < pending.length; i += size) {
      opts.signal?.throwIfAborted();
      const batch = pending.slice(i, i + size);
      await loadBatch(conn, batch);
      // Whose names count as the collector's own: everyone on the sample.
      await conn.run(`
        CREATE OR REPLACE TEMP TABLE locality_batch_person AS
        SELECT sc.sample_id, sc.person_id FROM sample_collector sc
        WHERE sc.sample_id IN (SELECT sample_id FROM locality_batch)`);
      const evidence = await gather(conn, batch, G);
      const now = new Date().toISOString();
      const named: unknown[][] = [];
      for (const p of batch) {
        const cands = localityCandidates(evidence.get(p.sample_id)!);
        if (cands.length === 0) {
          result.unnamed += 1;
          continue;
        }
        cands.forEach((c, k) =>
          named.push([p.sample_id, k + 1, c.locality, c.basis, p.lat, p.lon, build.build_id, LOCALITY_RULE_VERSION, now]),
        );
        result.named += 1;
        result.byBasis[cands[0]!.basis] = (result.byBasis[cands[0]!.basis] ?? 0) + 1;
      }
      await write(conn, named);
    }
    return result;
  } finally {
    await conn.run(`DETACH ${G}`);
  }
}

export interface PointCandidates {
  gazetteerBuild: string;
  candidates: NamedLocality[];
}

// The point lookup builds the same temp tables as a run and is called from
// requests that can overlap on one connection, so one at a time per
// connection: two would write each other's locality_batch.
const pointQueues = new WeakMap<Conn, Promise<unknown>>();

/**
 * The candidate localities for a point no sample has yet (beeline-4hxe), as
 * a form entering a sample offers them: the best and up to three more, the
 * names these people have already used nearby counting as their own. Null
 * when there is no gazetteer on this machine.
 */
export async function localityCandidatesAt(
  conn: Conn,
  gazetteerPath: string,
  point: { latitude: number; longitude: number },
  personIds: readonly number[],
): Promise<PointCandidates | null> {
  const run = (pointQueues.get(conn) ?? Promise.resolve()).then(() => candidatesAt(conn, gazetteerPath, point, personIds));
  pointQueues.set(conn, run.catch(() => {}));
  return run;
}

async function candidatesAt(
  conn: Conn,
  gazetteerPath: string,
  point: { latitude: number; longitude: number },
  personIds: readonly number[],
): Promise<PointCandidates | null> {
  try {
    await access(gazetteerPath);
  } catch {
    return null;
  }
  await loadSpatial(conn);
  const G = `gazetteer_${++attachments}`;
  await conn.run(`ATTACH '${gazetteerPath.replaceAll("'", "''")}' AS ${G} (READ_ONLY)`);
  try {
    const [build] = await rows<{ build_id: string }>(conn, `SELECT build_id FROM ${G}.gazetteer_build`);
    if (build === undefined) throw new Error(`${gazetteerPath} has no gazetteer_build row: rebuild it`);
    await createMacros(conn);
    await usedFeatures(conn, G);
    await usedLocalities(conn, G);
    // No sample has this id: entity ids start at 1.
    const batch = [{ sample_id: 0, lat: point.latitude, lon: point.longitude }];
    await loadBatch(conn, batch);
    await conn.run(`CREATE OR REPLACE TEMP TABLE locality_batch_person (sample_id INTEGER, person_id INTEGER)`);
    for (const id of personIds) await conn.run(`INSERT INTO locality_batch_person VALUES (0, $1)`, [id]);
    const evidence = await gather(conn, batch, G);
    return { gazetteerBuild: build.build_id, candidates: localityCandidates(evidence.get(0)!) };
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

/**
 * Every located sample's locality, filed in cells of 0.02 degrees so the
 * names near a point are an equality join on its cell and the eight around
 * it: at least 1.2 km in every direction as far north as the atlases reach,
 * more than the kilometre a used name is read from. Read from the whole
 * store once a run, since any sample's locality counts (beeline-4hxe).
 */
async function usedLocalities(conn: Conn, G: string): Promise<void> {
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE locality_used_sample AS
    SELECT s.entity_id AS sample_id, regexp_replace(s.locality, ' {2,}', ' ', 'g') AS locality,
           l.latitude AS lat, l.longitude AS lon,
           CAST(floor(l.latitude / 0.02) AS INTEGER) AS cy, CAST(floor(l.longitude / 0.02) AS INTEGER) AS cx
    FROM sample s JOIN sample_location l ON l.sample_id = s.entity_id
    WHERE s.locality IS NOT NULL AND trim(s.locality) <> ''`);
  await correctSpellings(conn, G);
}

/**
 * A locality somebody wrote that is one letter from a place's name in the
 * gazetteer within about 10 km is taken as a misspelling of it, and offered
 * in the gazetteer's spelling (beeline-5j10): "Miwaukie" is Milwaukie,
 * "Terrrebonne" Terrebonne, "CottageGrove" Cottage Grove. Two spellings of
 * one name then count as one name already used, with both their samples.
 *
 * Guarded, because a real local name can be one letter from another place's
 * (2026-10-30, on the sandbox store: of 107 names one or two letters from a
 * place nearby, two letters was mostly wrong, "Alsea" to Alder, and these
 * guards left 58, every one a typo):
 *  - a name that is any place's name, anywhere, is left as written: San
 *    Antonio is not San Antonito, nor Colville Coville;
 *  - a plural is not a misspelling: Lava Lakes and Lava Lake are both places;
 *  - an apostrophe or a full stop is not a misspelling (Mary's Peak), and
 *    the candidates fold those together anyway (src/locality-rule.ts);
 *  - a space may be added where the writer ran words together, never taken
 *    out: Salt Spring Island is that island's official name, though
 *    OpenStreetMap runs it together;
 *  - exactly one place nearby is one letter off, and its name fits a label.
 */
async function correctSpellings(conn: Conn, G: string): Promise<void> {
  const [hasCamp] = await rows<{ n: number }>(
    conn,
    `SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE database_name = '${G}' AND table_name = 'campground'`,
  );
  // Filed in cells of 0.1 by 0.2 degrees, so a name is compared only with the
  // gazetteer's names in its cell and the eight around it: comparing each
  // with every name took longer than the rest of the step together.
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE locality_gazetteer_name AS
    SELECT name, lat, lon, CAST(floor(lat / 0.1) AS INTEGER) AS gy, CAST(floor(lon / 0.2) AS INTEGER) AS gx
    FROM (SELECT name, lat, lon FROM ${G}.place
          UNION ALL SELECT name, lat, lon FROM ${G}.feature
          UNION ALL SELECT name, ST_Y(ST_Centroid(geom)), ST_X(ST_Centroid(geom)) FROM ${G}.osm_area WHERE name IS NOT NULL
          ${hasCamp!.n > 0 ? `UNION ALL SELECT name, lat, lon FROM ${G}.campground` : ""})`);
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE locality_spelling AS
    WITH unknown AS (
      SELECT DISTINCT locality, cy, cx, (cy + 0.5) * 0.02 AS lat, (cx + 0.5) * 0.02 AS lon FROM locality_used_sample
      WHERE lower(locality) NOT IN (SELECT lower(name) FROM locality_gazetteer_name)),
    cell AS (
      SELECT k.*, CAST(floor(k.lat / 0.1) AS INTEGER) + dy AS gy, CAST(floor(k.lon / 0.2) AS INTEGER) + dx AS gx
      FROM unknown k, range(-1, 2) t1(dy), range(-1, 2) t2(dx)),
    near AS (
      SELECT k.locality, k.cy, k.cx, z.name
      FROM cell k JOIN locality_gazetteer_name z ON z.gy = k.gy AND z.gx = k.gx
      WHERE abs(z.lat - k.lat) < 0.1 AND abs(z.lon - k.lon) < lon_deg(11, z.lat)
        AND abs(length(z.name) - length(k.locality)) <= 1 AND length(z.name) <= ${MAX_LOCALITY_LENGTH}
        AND levenshtein(lower(k.locality), lower(z.name)) = 1
        AND lower(z.name) <> concat(lower(k.locality), 's') AND lower(k.locality) <> concat(lower(z.name), 's')
        AND regexp_replace(lower(z.name), '[.''’]', '', 'g') <> regexp_replace(lower(k.locality), '[.''’]', '', 'g')
        AND NOT (regexp_replace(lower(z.name), '[^a-z0-9]', '', 'g') = regexp_replace(lower(k.locality), '[^a-z0-9]', '', 'g')
                 AND length(regexp_replace(z.name, '[A-Za-z0-9]', '', 'g')) < length(regexp_replace(k.locality, '[A-Za-z0-9]', '', 'g'))))
    SELECT locality, cy, cx, any_value(name) AS spelling
    FROM near GROUP BY locality, cy, cx HAVING count(DISTINCT name) = 1`);
  await conn.run(`
    UPDATE locality_used_sample u SET locality = s.spelling
    FROM locality_spelling s WHERE u.locality = s.locality AND u.cy = s.cy AND u.cx = s.cx`);
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

async function loadBatch(conn: Conn, batch: Array<{ sample_id: number; lat: number; lon: number }>): Promise<void> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE locality_batch (sample_id INTEGER, lat DOUBLE, lon DOUBLE)`);
  const appender = await conn.createAppender("locality_batch", "main", "temp");
  for (const p of batch) {
    appender.appendInteger(p.sample_id);
    appender.appendDouble(p.lat);
    appender.appendDouble(p.lon);
    appender.endRow();
  }
  appender.closeSync();
}

/**
 * What the gazetteer and the store say about each point in locality_batch,
 * whose collectors are in locality_batch_person.
 */
async function gather(
  conn: Conn,
  batch: Array<{ sample_id: number; lat: number; lon: number }>,
  G: string,
): Promise<Map<number, LocalityEvidence>> {
  const ev = new Map<number, LocalityEvidence>();
  for (const p of batch) {
    ev.set(p.sample_id, {
      regionId: null, county: null, refuge: null, wildlifeArea: null, nationalPark: null, statePark: null, parks: [],
      island: null, townLimits: null, nearby: [], farTowns: [], features: [], campgrounds: [], used: [],
    });
  }
  const of = (id: number) => ev.get(id)!;

  await conn.run(`
    CREATE OR REPLACE TEMP TABLE locality_batch_region AS
    SELECT b.sample_id, arg_min(r.region_id, r.region_id) AS region_id, arg_min(r.county, r.region_id) AS county
    FROM locality_batch b JOIN ${G}.region r ON ST_Intersects(r.geom, ST_Point(b.lon, b.lat))
    GROUP BY b.sample_id`);
  for (const r of await rows<{ sample_id: number; region_id: string; county: string | null }>(conn, `SELECT * FROM locality_batch_region`)) {
    of(r.sample_id).regionId = r.region_id;
    of(r.sample_id).county = r.county;
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
  // OpenStreetMap names every one "... Wilderness", now and then with "Area"
  // or a unit after it ("North Fork John Day Wilderness - Baldy Unit"); its
  // protection class alone would also catch wilderness study areas and
  // others. BC's "... Wilderness Provincial Park"s, the BLM's "... Wilderness
  // Study Area"s and a city's "Wilderness Park" are not matched.
  for (const r of await rows<{ sample_id: number; name: string; ha: number }>(
    conn,
    `SELECT b.sample_id, o.name, o.area_ha AS ha
       FROM locality_batch b JOIN ${G}.osm_area o
         ON NOT o.is_island AND ST_Contains(o.geom, ST_Point(b.lon, b.lat))
      WHERE NOT regexp_matches(o.name, ' Wilderness( Area)?( - [^,]+ Unit)?$')
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
  // Campgrounds within 1.5 km, from a gazetteer built since they were added
  // (beeline-4hxe); an older one simply has none.
  const [hasCamp] = await rows<{ n: number }>(
    conn,
    `SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE database_name = '${G}' AND table_name = 'campground'`,
  );
  if (hasCamp!.n > 0) {
    for (const r of await rows<{ sample_id: number; name: string; km: number }>(
      conn,
      `SELECT * FROM (
         SELECT b.sample_id, c.name, hav_km(b.lat, b.lon, c.lat, c.lon) AS km
           FROM locality_batch b JOIN ${G}.campground c
             ON abs(c.lat - b.lat) < 0.014 AND abs(c.lon - b.lon) < lon_deg(1.6, b.lat))
        WHERE km <= 1.5
        ORDER BY sample_id, km, name`,
    )) {
      of(r.sample_id).campgrounds.push({ name: r.name, km: r.km });
    }
  }
  // The localities written for samples within a kilometre, how many carry
  // each, how many of those the point's own collectors collected, and how
  // near the nearest is. A sample's own locality is not evidence for itself.
  for (const r of await rows<{ sample_id: number; locality: string; samples: number; own: number; km: number }>(
    conn,
    `WITH b AS (
       SELECT b.sample_id, b.lat, b.lon, CAST(floor(b.lat / 0.02) AS INTEGER) + dy AS cy,
              CAST(floor(b.lon / 0.02) AS INTEGER) + dx AS cx
       FROM locality_batch b, range(-1, 2) t1(dy), range(-1, 2) t2(dx)),
     near AS (
       SELECT b.sample_id, u.sample_id AS other, u.locality, hav_km(b.lat, b.lon, u.lat, u.lon) AS km
       FROM b JOIN locality_used_sample u ON u.cy = b.cy AND u.cx = b.cx
       WHERE u.sample_id <> b.sample_id),
     own AS (
       SELECT DISTINCT n.sample_id, n.other
       FROM near n
       JOIN sample_collector sc ON sc.sample_id = n.other
       JOIN locality_batch_person bp ON bp.sample_id = n.sample_id AND bp.person_id = sc.person_id)
     SELECT n.sample_id, n.locality, count(*)::INTEGER AS samples, count(o.other)::INTEGER AS own, min(n.km) AS km
     FROM near n LEFT JOIN own o ON o.sample_id = n.sample_id AND o.other = n.other
     WHERE n.km <= 1
     GROUP BY n.sample_id, n.locality
     ORDER BY n.sample_id, km, n.locality`,
  )) {
    of(r.sample_id).used.push({ locality: r.locality, samples: r.samples, own: r.own, km: r.km });
  }
  return ev;
}

/** Replace the batch's rows: its samples' old names go, whether or not each was named again. */
async function write(conn: Conn, named: unknown[][]): Promise<void> {
  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run(`DELETE FROM sample_locality_candidate WHERE sample_id IN (SELECT sample_id FROM locality_batch)`);
    for (let i = 0; i < named.length; i += 500) {
      const chunk = named.slice(i, i + 500);
      const values = chunk.map((_, j) => `(${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => `$${j * 9 + k}`).join(", ")})`);
      await conn.run(
        `INSERT INTO sample_locality_candidate
           (sample_id, rank, locality, basis, latitude, longitude, gazetteer_build, rule_version, derived_at)
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
