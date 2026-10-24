-- PROTOTYPE (beeline-7i6) — throwaway. For a selection of samples, every
-- place a coordinate-derived locality could name: towns and notable peaks
-- nearby, the refuge the point falls in, and the county or regional district
-- of the point and of each place. The choice among them is made in page.html,
-- so the rule can be tuned by hand. __STORE__, __DL__ and __OUT__ are
-- substituted by build.sh.
LOAD spatial;
ATTACH '__STORE__' AS b (READ_ONLY);

CREATE MACRO hav_km(lat1, lon1, lat2, lon2) AS
  2 * 6371 * asin(sqrt(pow(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * pow(sin(radians(lon2 - lon1) / 2), 2)));
-- Bearing from the first point to the second, 0–360.
CREATE MACRO bearing_deg(lat1, lon1, lat2, lon2) AS
  (degrees(atan2(sin(radians(lon2 - lon1)) * cos(radians(lat2)),
    cos(radians(lat1)) * sin(radians(lat2))
      - sin(radians(lat1)) * cos(radians(lat2)) * cos(radians(lon2 - lon1)))) + 360) % 360;

-- Counties, and BC's regional districts as the province defines them now.
CREATE TABLE region AS
SELECT concat('US-', STUSPS, '-', "NAME") AS region_id, 'USA' AS country, STUSPS AS state,
       "NAME" AS county, geom::GEOMETRY AS geom
FROM ST_Read('__DL__/counties/cb_2023_us_county_500k.shp')
UNION ALL
SELECT concat('CA-BC-', ADMIN_AREA_ABBREVIATION), 'CAN', 'BC', ADMIN_AREA_ABBREVIATION, geom::GEOMETRY
FROM ST_Read('__DL__/bc_rd.geojson')
UNION ALL
SELECT 'CA-BC-NRRM', 'CAN', 'BC', 'NRRM', geom::GEOMETRY FROM ST_Read('__DL__/bc_nrrm.geojson');

-- Fee, agreement and other refuge land; conservation easements (E) are
-- private land a visitor could not tell from its neighbours.
CREATE TABLE refuge AS
SELECT ORGNAME AS org, ST_MakeValid(geom::GEOMETRY) AS geom
FROM (SELECT * FROM ST_Read('__DL__/nwr_0.geojson')
      UNION ALL BY NAME SELECT * FROM ST_Read('__DL__/nwr_500.geojson')
      UNION ALL BY NAME SELECT * FROM ST_Read('__DL__/nwr_1000.geojson'))
WHERE INTTYPE1 <> 'E';

-- WDFW wildlife area units: Wenas, Whiskey Dick (part of L.T. Murray).
CREATE TABLE wildlife_area_unit AS
SELECT WLAU_Name AS unit, WLA_Name AS area, ST_MakeValid(geom::GEOMETRY) AS geom
FROM ST_Read('__DL__/wdfw_units.geojson');

-- Town limits: a point inside one is in that town, whatever is nearest.
-- Census-designated places are kept apart, since they are unincorporated
-- names a volunteer may or may not know. Northern Rockies is a municipality
-- the size of a regional district, so it is no town.
CREATE TABLE town_limits AS
SELECT "NAME" AS name, CASE WHEN LSAD = '57' THEN 'cdp' ELSE 'city' END AS kind, geom::GEOMETRY AS geom
FROM ST_Read('__DL__/places/cb_2023_us_place_500k.shp')
UNION ALL
SELECT ADMIN_AREA_ABBREVIATION, 'city', geom::GEOMETRY FROM ST_Read('__DL__/bc_muni.geojson')
WHERE ADMIN_AREA_NAME NOT LIKE '%Northern Rockies%';

CREATE TABLE place AS
SELECT id::INTEGER AS id, name, lat::DOUBLE AS lat, lon::DOUBLE AS lon,
       CASE WHEN fclass = 'P' THEN 'town' WHEN fclass = 'L' THEN 'locality' ELSE 'peak' END AS kind, fcode,
       coalesce(try_cast(pop AS BIGINT), 0) AS pop,
       coalesce(try_cast(elev AS INTEGER), try_cast(dem AS INTEGER)) AS elev,
       ST_Point(lon::DOUBLE, lat::DOUBLE) AS pt
FROM read_csv(['__DL__/us/US.txt', '__DL__/ca/CA.txt'], delim = '\t', header = false, quote = '', escape = '',
  all_varchar = true,
  columns = {'id': 'VARCHAR', 'name': 'VARCHAR', 'asciiname': 'VARCHAR', 'alt': 'VARCHAR', 'lat': 'VARCHAR',
             'lon': 'VARCHAR', 'fclass': 'VARCHAR', 'fcode': 'VARCHAR', 'cc': 'VARCHAR', 'cc2': 'VARCHAR',
             'a1': 'VARCHAR', 'a2': 'VARCHAR', 'a3': 'VARCHAR', 'a4': 'VARCHAR', 'pop': 'VARCHAR',
             'elev': 'VARCHAR', 'dem': 'VARCHAR', 'tz': 'VARCHAR', 'mod': 'VARCHAR'})
-- Abandoned, historical, religious and neighbourhood entries left out.
WHERE (fclass = 'P' AND fcode IN ('PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLC', 'PPLL', 'PPLS'))
   -- A peak with a name in some other language is a stand-in for "notable":
   -- GeoNames carries no prominence.
   OR (fclass = 'T' AND fcode IN ('MT', 'PK', 'PKS', 'MTS', 'BUTE', 'HLL') AND coalesce(alt, '') <> '')
   -- A named area or locality with nobody counted in it: Galena, BC, which
   -- is where its collector says he was.
   OR (fclass = 'L' AND fcode IN ('AREA', 'LCTY'));

CREATE TABLE place_region AS
SELECT p.id, any_value(r.region_id) AS region_id
FROM place p JOIN region r ON ST_Intersects(r.geom, p.pt) GROUP BY p.id;

-- Samples whose point may be shown: no obscured or private observation.
CREATE TABLE base AS
SELECT s.entity_id AS sample_id, l.latitude AS lat, l.longitude AS lon,
       l.coordinate_uncertainty_m AS unc, s.locality, s.county AS store_county,
       s.state_province AS store_state, ss.season, st.sample_id IS NULL AS open_season,
       ps.sample_id IS NOT NULL AS printed, q.sample_id IS NOT NULL AS flagged, q.details AS flag,
       pc_person.display_name AS collector
FROM b.sample s
LEFT JOIN b.sample_primary_collector pc ON pc.sample_id = s.entity_id
LEFT JOIN b.person pc_person ON pc_person.entity_id = pc.person_id
JOIN b.sample_location l ON l.sample_id = s.entity_id
JOIN b.sample_season ss ON ss.sample_id = s.entity_id
LEFT JOIN b.settled_sample st ON st.sample_id = s.entity_id
LEFT JOIN b.printed_sample ps ON ps.sample_id = s.entity_id
LEFT JOIN b.qc_rule_locality_format q ON q.sample_id = s.entity_id
LEFT JOIN b.observation_field o ON o.inat_id = s.inat_observation_id
WHERE coalesce(o.geoprivacy, 'open') = 'open' AND coalesce(o.taxon_geoprivacy, 'open') = 'open';

CREATE TABLE base_refuge AS
SELECT b.sample_id, any_value(r.org) AS org
FROM base b JOIN refuge r ON ST_Contains(r.geom, ST_Point(b.lon, b.lat)) GROUP BY b.sample_id;

CREATE TABLE base_wla AS
SELECT b.sample_id, any_value(w.unit) AS unit, any_value(w.area) AS area
FROM base b JOIN wildlife_area_unit w ON ST_Contains(w.geom, ST_Point(b.lon, b.lat)) GROUP BY b.sample_id;

-- The whole open season, every sample in a refuge or a wildlife area, and a fixed random
-- 4,000 of the settled seasons; and, for a local review, every sample of the
-- collector named in __COLLECTOR__, marked as extra so the shared copy leaves
-- them out.
SELECT setseed(0.7);
CREATE TABLE settled_pick AS SELECT sample_id FROM base WHERE NOT open_season ORDER BY random() LIMIT 4000;
CREATE TABLE sel AS
SELECT * FROM (
  SELECT b.*, br.org AS refuge, bw.unit AS wla, bw.area AS wla_area,
         NOT (b.open_season OR br.org IS NOT NULL OR bw.unit IS NOT NULL
              OR b.sample_id IN (SELECT sample_id FROM settled_pick)) AS extra
  FROM base b LEFT JOIN base_refuge br USING (sample_id) LEFT JOIN base_wla bw USING (sample_id)
)
WHERE NOT extra OR collector = '__COLLECTOR__';

CREATE TABLE sel_region AS
SELECT s.sample_id, any_value(r.region_id) AS region_id
FROM sel s JOIN region r ON ST_Intersects(r.geom, ST_Point(s.lon, s.lat)) GROUP BY s.sample_id;

CREATE TABLE sel_limits AS
SELECT s.sample_id, arg_min(t.name, CASE t.kind WHEN 'city' THEN 0 ELSE 1 END) AS name,
       min(t.kind) AS kind
FROM sel s JOIN town_limits t ON ST_Intersects(t.geom, ST_Point(s.lon, s.lat)) GROUP BY s.sample_id;

-- Towns with a population within 50 km, unpopulated towns and named
-- localities within 20 km, notable peaks within 20 km: the nearest 20 of
-- each, so hamlets cannot crowd out the towns.
CREATE TABLE cand AS
SELECT sample_id, id AS place_id, round(km, 2) AS km, round(brg) AS brg
FROM (
  SELECT s.sample_id, p.id, p.kind, p.pop, hav_km(s.lat, s.lon, p.lat, p.lon) AS km,
         bearing_deg(p.lat, p.lon, s.lat, s.lon) AS brg
  FROM sel s JOIN place p
    ON p.lat BETWEEN s.lat - 0.46 AND s.lat + 0.46 AND p.lon BETWEEN s.lon - 0.7 AND s.lon + 0.7
)
WHERE (kind = 'town' AND pop > 0 AND km <= 50) OR (kind IN ('town', 'locality') AND km <= 20) OR (kind = 'peak' AND km <= 20)
QUALIFY row_number() OVER (PARTITION BY sample_id, kind = 'town' AND pop > 0, kind = 'peak' ORDER BY km) <= 20;

COPY (
  SELECT p.id, p.name, p.kind, p.fcode, p.pop, p.elev, pr.region_id
  FROM place p LEFT JOIN place_region pr USING (id)
  WHERE p.id IN (SELECT place_id FROM cand)
) TO '__OUT__/places.json' (FORMAT json, ARRAY true);

COPY (
  SELECT region_id, country, state, county FROM region
  WHERE region_id IN (SELECT region_id FROM sel_region UNION SELECT region_id FROM place_region
                      WHERE id IN (SELECT place_id FROM cand))
) TO '__OUT__/regions.json' (FORMAT json, ARRAY true);

COPY (
  SELECT s.sample_id AS i, round(s.lat, 4) AS lat, round(s.lon, 4) AS lon, s.unc, s.locality AS loc,
         s.store_county AS sc, s.store_state AS ss, s.season, s.open_season AS open, s.printed,
         s.flag, s.collector AS who, s.extra, s.refuge AS ref, s.wla, s.wla_area, sr.region_id AS reg, tl.name AS tl, tl.kind AS tlk,
         coalesce((SELECT list([c.place_id, c.km, c.brg] ORDER BY c.km) FROM cand c WHERE c.sample_id = s.sample_id), []) AS c
  FROM sel s LEFT JOIN sel_region sr USING (sample_id) LEFT JOIN sel_limits tl USING (sample_id)
  ORDER BY s.sample_id
) TO '__OUT__/samples.json' (FORMAT json, ARRAY true);
