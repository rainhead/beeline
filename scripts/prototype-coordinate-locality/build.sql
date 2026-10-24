-- PROTOTYPE (beeline-7i6) — throwaway. For a selection of samples, every
-- place a coordinate-derived locality could name: towns and notable peaks
-- nearby, the refuge the point falls in, and the county or regional district
-- of the point and of each place. The choice among them is made in page.html,
-- so the rule can be tuned by hand. __STORE__, __DL__ and __OUT__ are
-- substituted by build.sh.
LOAD spatial;
ATTACH '__STORE__' AS b (READ_ONLY);
ATTACH '__OSM__' AS osm (READ_ONLY);

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

-- National Park Service units, memorials left out.
CREATE TABLE nps_unit AS
SELECT UNIT_NAME AS unit, ST_MakeValid(geom::GEOMETRY) AS geom
FROM ST_Read('__DL__/nps_units.geojson')
WHERE UNIT_TYPE NOT IN ('National Memorials', 'Other Designations');

-- Washington state parks. Trails are corridors a point on is better named
-- for the town it passes (Palouse to Cascades runs through Easton), and an
-- unnamed "State Park Property" is no place anybody would recognise.
CREATE TABLE state_park AS
SELECT ParkName AS park, 'SP' AS suffix, ST_MakeValid(geom::GEOMETRY) AS geom
FROM ST_Read('__DL__/wa_state_parks.geojson')
WHERE Category NOT IN ('State Park Trail', 'State Park Property')
UNION ALL
-- BC's, which the province names 'ELK FALLS PARK': 'Elk Falls PP'.
SELECT regexp_replace(PROTECTED_LANDS_NAME, ' (PARK|PROTECTED AREA|ECOLOGICAL RESERVE|RECREATION AREA)$', ''),
       CASE PROTECTED_LANDS_DESIGNATION WHEN 'PROVINCIAL PARK' THEN 'PP' WHEN 'PROTECTED AREA' THEN 'PA'
            WHEN 'ECOLOGICAL RESERVE' THEN 'ER' ELSE 'RA' END,
       ST_MakeValid(geom::GEOMETRY)
FROM ST_Read('__DL__/bc_parks.geojson');

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
       CASE WHEN fclass = 'P' THEN 'town' WHEN fcode = 'PRK' THEN 'park' WHEN fclass = 'L' THEN 'locality' ELSE 'peak' END AS kind, fcode,
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
WHERE (fclass = 'P' AND fcode IN ('PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLC', 'PPLL', 'PPLS', 'PPLX'))
   -- City parks, for points inside a city: Jefferson Park, Seattle.
   OR (fclass = 'L' AND fcode = 'PRK')
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

CREATE TABLE base_nps AS
SELECT b.sample_id, any_value(n.unit) AS unit
FROM base b JOIN nps_unit n ON ST_Contains(n.geom, ST_Point(b.lon, b.lat)) GROUP BY b.sample_id;

-- The smallest named OpenStreetMap park or reserve a point is in, so a city
-- park inside a regional park keeps its own name.
CREATE TABLE base_osm AS
SELECT b.sample_id, arg_min(o.name, o.area_ha) AS name, round(min(o.area_ha), 1) AS area_ha
FROM base b JOIN osm.osm_park o ON ST_Contains(o.geom, ST_Point(b.lon, b.lat)) GROUP BY b.sample_id;

CREATE TABLE base_sp AS
SELECT b.sample_id, any_value(concat(p.park, '|', p.suffix)) AS park
FROM base b JOIN state_park p ON ST_Contains(p.geom, ST_Point(b.lon, b.lat)) GROUP BY b.sample_id;

-- Features that are not towns (a lake, a pass, a landmark) whose name a
-- volunteer already wrote as the locality of a sample within 10 km of it:
-- Takhlakh Lake. The seed of a curated gazetteer, for a person to review,
-- written out as gazetteer-seed.csv.
CREATE MACRO fold_name(s) AS
  regexp_replace(replace(replace(lower(s), 'mount ', 'mt '), 'mountain', 'mt'), '[^a-z0-9]', '', 'g');
CREATE TABLE gn_feature AS
SELECT id::INTEGER AS id, name, lat::DOUBLE AS lat, lon::DOUBLE AS lon, fclass, fcode, a1 AS state
FROM read_csv('__DL__/us/US.txt', delim = '\t', header = false, quote = '', escape = '', all_varchar = true,
  columns = {'id': 'VARCHAR', 'name': 'VARCHAR', 'asciiname': 'VARCHAR', 'alt': 'VARCHAR', 'lat': 'VARCHAR',
             'lon': 'VARCHAR', 'fclass': 'VARCHAR', 'fcode': 'VARCHAR', 'cc': 'VARCHAR', 'cc2': 'VARCHAR',
             'a1': 'VARCHAR', 'a2': 'VARCHAR', 'a3': 'VARCHAR', 'a4': 'VARCHAR', 'pop': 'VARCHAR',
             'elev': 'VARCHAR', 'dem': 'VARCHAR', 'tz': 'VARCHAR', 'mod': 'VARCHAR'})
WHERE a1 IN ('WA', 'OR', 'ID') AND fclass <> 'P'
  -- Rivers, creeks, valleys, ridges, ranges, plains, canals and trails are
  -- long, and GeoNames places each at one point (a stream at its mouth), so
  -- being near that point says little: "Deschutes River" is no landmark.
  AND concat(fclass, '.', fcode) NOT IN ('H.STM', 'H.STMI', 'H.STMS', 'H.STMX', 'H.CNL', 'T.VAL', 'T.VALS',
                                         'T.RDGE', 'T.MTS', 'T.PLN', 'R.TRL');
CREATE TABLE used_feature AS
SELECT g.id, any_value(g.name) AS name, any_value(concat(g.fclass, '.', coalesce(g.fcode, ''))) AS code, any_value(g.state) AS state,
       any_value(g.lat) AS lat, any_value(g.lon) AS lon,
       count(DISTINCT b.sample_id) AS samples, count(DISTINCT b.collector) AS collectors,
       string_agg(DISTINCT b.locality, ' | ') AS written_as
FROM base b
JOIN gn_feature g ON fold_name(g.name) = fold_name(b.locality)
  AND abs(g.lat - b.lat) < 0.1 AND abs(g.lon - b.lon) < 0.14
WHERE hav_km(b.lat, b.lon, g.lat, g.lon) <= 10
GROUP BY g.id;
COPY (SELECT id AS geonames_id, name, code, state, lat, lon, samples, collectors, written_as
      FROM used_feature ORDER BY state, samples DESC) TO '__OUT__/gazetteer-seed.csv' (HEADER);

-- The whole open season, every sample in a refuge or a wildlife area, and a fixed random
-- 4,000 of the settled seasons; and, for a local review, every sample of the
-- collector named in __COLLECTOR__, marked as extra so the shared copy leaves
-- them out.
SELECT setseed(0.7);
CREATE TABLE settled_pick AS SELECT sample_id FROM base WHERE NOT open_season ORDER BY random() LIMIT 4000;
CREATE TABLE sel AS
SELECT * FROM (
  SELECT b.*, br.org AS refuge, bw.unit AS wla, bw.area AS wla_area, bs.park AS state_park, bn.unit AS nps, bo.name AS osm_park, bo.area_ha AS osm_park_ha,
         NOT (b.open_season OR br.org IS NOT NULL OR bw.unit IS NOT NULL OR bs.park IS NOT NULL OR bn.unit IS NOT NULL
              OR bo.name IS NOT NULL
              OR b.sample_id IN (SELECT sample_id FROM settled_pick)) AS extra
  FROM base b LEFT JOIN base_refuge br USING (sample_id) LEFT JOIN base_wla bw USING (sample_id) LEFT JOIN base_sp bs USING (sample_id)
  LEFT JOIN base_nps bn USING (sample_id)
  LEFT JOIN base_osm bo USING (sample_id)
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
SELECT sample_id, id AS place_id, round(km, 1) AS km, round(brg) AS brg
FROM (
  SELECT s.sample_id, p.id, p.kind, p.pop, hav_km(s.lat, s.lon, p.lat, p.lon) AS km,
         bearing_deg(p.lat, p.lon, s.lat, s.lon) AS brg
  FROM sel s JOIN place p
    ON p.lat BETWEEN s.lat - 0.46 AND s.lat + 0.46 AND p.lon BETWEEN s.lon - 0.7 AND s.lon + 0.7
)
WHERE (kind = 'town' AND pop > 0 AND km <= 50) OR (kind IN ('town', 'locality') AND km <= 20) OR (kind = 'peak' AND km <= 20)
   OR (kind = 'park' AND km <= 1.5)
QUALIFY row_number() OVER (PARTITION BY sample_id, kind = 'town' AND pop > 0, kind ORDER BY km)
        <= CASE WHEN kind = 'town' AND pop > 0 THEN 20 ELSE 8 END;

-- The nearest town with people in it, however far, for a point nothing
-- nearer names: a locality must exist for the label to print.
CREATE TABLE far_town AS
SELECT s.sample_id, p.id AS place_id, round(hav_km(s.lat, s.lon, p.lat, p.lon), 1) AS km,
       round(bearing_deg(p.lat, p.lon, s.lat, s.lon)) AS brg
FROM sel s JOIN place p ON p.kind = 'town' AND p.pop > 0
  AND p.lat BETWEEN s.lat - 1.5 AND s.lat + 1.5 AND p.lon BETWEEN s.lon - 2 AND s.lon + 2
WHERE NOT EXISTS (SELECT 1 FROM cand c JOIN place q ON q.id = c.place_id
                  WHERE c.sample_id = s.sample_id AND q.kind = 'town' AND q.pop > 0 AND c.km <= 30)
QUALIFY row_number() OVER (PARTITION BY s.sample_id ORDER BY km) <= 3;

COPY (
  SELECT p.id, p.name, p.kind, p.fcode, p.pop, p.elev, pr.region_id
  FROM place p LEFT JOIN place_region pr USING (id)
  WHERE p.id IN (SELECT place_id FROM cand UNION SELECT place_id FROM far_town)
) TO '__OUT__/places.json' (FORMAT json, ARRAY true);

COPY (SELECT id, name, code, samples, collectors FROM used_feature) TO '__OUT__/features.json' (FORMAT json, ARRAY true);

COPY (
  SELECT region_id, country, state, county FROM region
  WHERE region_id IN (SELECT region_id FROM sel_region UNION SELECT region_id FROM place_region
                      WHERE id IN (SELECT place_id FROM cand UNION SELECT place_id FROM far_town))
) TO '__OUT__/regions.json' (FORMAT json, ARRAY true);

COPY (
  SELECT s.sample_id AS i, round(s.lat, 4) AS lat, round(s.lon, 4) AS lon, s.unc, s.locality AS loc,
         s.store_county AS sc, s.store_state AS ss, s.season, s.open_season AS open, s.printed,
         s.flag, s.collector AS who, s.extra, s.refuge AS ref, s.state_park AS sp, s.nps, s.osm_park AS op, s.osm_park_ha AS oph,
         (SELECT list([ft.place_id, ft.km, ft.brg] ORDER BY ft.km) FROM far_town ft WHERE ft.sample_id = s.sample_id) AS nt,
         (SELECT list([u.id, round(hav_km(s.lat, s.lon, u.lat, u.lon), 2)] ORDER BY hav_km(s.lat, s.lon, u.lat, u.lon))
          FROM used_feature u WHERE abs(u.lat - s.lat) < 0.05 AND abs(u.lon - s.lon) < 0.07
            AND hav_km(s.lat, s.lon, u.lat, u.lon) <= 5) AS f, s.wla, s.wla_area, sr.region_id AS reg, tl.name AS tl, tl.kind AS tlk,
         coalesce((SELECT list([c.place_id, c.km, c.brg] ORDER BY c.km) FROM cand c WHERE c.sample_id = s.sample_id), []) AS c
  FROM sel s LEFT JOIN sel_region sr USING (sample_id) LEFT JOIN sel_limits tl USING (sample_id)
  ORDER BY s.sample_id
) TO '__OUT__/samples.json' (FORMAT json, ARRAY true);
