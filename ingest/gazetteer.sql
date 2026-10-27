-- The gazetteer a sample's locality is named from (beeline-7i6): every place
-- the rule in src/locality-rule.ts may name, and the boundaries that say
-- which county, town, park or island a point is in. Built on a workstation
-- by src/build-gazetteer.ts from the files scripts/fetch-gazetteer.sh
-- downloads, into its own DuckDB file, never into the store: it is a copy of
-- public data that a build reproduces, and a gigabyte of outlines has no
-- business in the nightly backup. __SOURCES__ is substituted by the builder;
-- the OpenStreetMap outlines arrive already read, in osm_area_staged.
--
-- Every geometry is longitude/latitude (WGS 84), the order ST_Point takes.
--
-- Licences, which follow the data: GeoNames is CC BY 4.0, OpenStreetMap is
-- the ODbL, so this file is ODbL too; the government layers are public
-- domain (US) or the Open Government Licence – British Columbia; the
-- wildernesses are Wilderness.net's compilation of the agencies' boundaries,
-- credited in the site footer.

-- Counties, and BC's regional districts as the province defines them now
-- (beeline-313x). A region id is country-state-code, US-OR-41003 (Benton
-- County, by its Census GEOID) or CA-BC-CAPRD: unique, which a name is not,
-- since Virginia has a Richmond County and a Richmond city. Each region also
-- carries its source's own id (source, source_id) and its full name, which is
-- how the derive step copies it into the store as an area (beeline-9jd4).
-- county is what a sample's county is written as (src/derive-area.ts): the
-- Census's name, or a district's name as iNaturalist writes it, Capital or
-- Comox Valley, which a label turns into the province's abbreviation
-- (src/label-text.ts, Peter, 2026-10-27).
-- Northern Rockies is a regional municipality outside every district, so it
-- stands in for one.
CREATE TABLE region AS
SELECT concat('US-', STUSPS, '-', GEOID) AS region_id, 'USA' AS country, STUSPS AS state,
       "NAME" AS county, 'census' AS source, GEOID AS source_id, NAMELSAD AS name, geom::GEOMETRY AS geom
FROM ST_Read('__SOURCES__/counties/cb_2023_us_county_500k.shp')
UNION ALL
SELECT concat('CA-BC-', ADMIN_AREA_ABBREVIATION), 'CAN', 'BC',
       regexp_replace(ADMIN_AREA_NAME, '^Regional District of | Regional District$| \(Unincorporated\)$', '', 'g'),
       'bc-abms', LGL_ADMIN_AREA_ID::TEXT, ADMIN_AREA_NAME, geom::GEOMETRY
FROM ST_Read('__SOURCES__/bc_rd.geojson')
UNION ALL
SELECT 'CA-BC-NRRM', 'CAN', 'BC', 'Northern Rockies', 'bc-abms', LGL_ADMIN_AREA_ID::TEXT, ADMIN_AREA_NAME, geom::GEOMETRY
FROM ST_Read('__SOURCES__/bc_muni.geojson') WHERE ADMIN_AREA_NAME LIKE '%Northern Rockies%';

-- National wildlife refuges. Fee, agreement and other refuge land;
-- conservation easements (E) are private land a visitor could not tell from
-- its neighbours.
CREATE TABLE refuge AS
SELECT ORGNAME AS name, ST_MakeValid(geom::GEOMETRY) AS geom
FROM (SELECT * FROM ST_Read('__SOURCES__/nwr_0.geojson')
      UNION ALL BY NAME SELECT * FROM ST_Read('__SOURCES__/nwr_500.geojson')
      UNION ALL BY NAME SELECT * FROM ST_Read('__SOURCES__/nwr_1000.geojson'))
WHERE INTTYPE1 <> 'E';

-- WDFW wildlife area units, named by the unit (Whiskey Dick, part of L.T.
-- Murray; beeline-9jd4).
CREATE TABLE wildlife_area_unit AS
SELECT WLAU_Name AS unit, WLA_Name AS area, ST_MakeValid(geom::GEOMETRY) AS geom
FROM ST_Read('__SOURCES__/wdfw_units.geojson');

-- National Park Service units, memorials left out.
CREATE TABLE nps_unit AS
SELECT UNIT_NAME AS unit, ST_MakeValid(geom::GEOMETRY) AS geom
FROM ST_Read('__SOURCES__/nps_units.geojson')
WHERE UNIT_TYPE NOT IN ('National Memorials', 'Other Designations');

-- Federal wildernesses, every agency's (Wilderness.net; beeline-9jd4), one
-- row per wilderness: the layer splits one that two agencies manage into a
-- feature each (Mount Jefferson, Forest Service and BLM), which share the
-- WID. Never a locality; the derive step copies the ones samples lie inside
-- into the store as areas (src/derive-area.ts).
CREATE TABLE wilderness AS
SELECT WID::TEXT AS wid, min(NAME) AS name, string_agg(DISTINCT Agency, ',' ORDER BY Agency) AS agency,
       ST_MakeValid(ST_Union_Agg(ST_MakeValid(geom::GEOMETRY))) AS geom
FROM (SELECT * FROM ST_Read('__SOURCES__/wilderness_0.geojson')
      UNION ALL BY NAME SELECT * FROM ST_Read('__SOURCES__/wilderness_300.geojson')
      UNION ALL BY NAME SELECT * FROM ST_Read('__SOURCES__/wilderness_600.geojson'))
GROUP BY WID;

-- Washington state parks, and BC's provincial parks, protected areas,
-- ecological reserves and recreation areas, each with the suffix its label
-- carries. A state park trail is a corridor a point on is better named for
-- the town it passes (Palouse to Cascades runs through Easton), and an
-- unnamed "State Park Property" is no place anybody would recognise. BC
-- writes its names in capitals and with the designation: ELK FALLS PARK.
CREATE TABLE state_park AS
SELECT ParkName AS park, 'SP' AS suffix, ST_MakeValid(geom::GEOMETRY) AS geom
FROM ST_Read('__SOURCES__/wa_state_parks.geojson')
WHERE Category NOT IN ('State Park Trail', 'State Park Property')
UNION ALL
SELECT regexp_replace(PROTECTED_LANDS_NAME, ' (PARK|PROTECTED AREA|ECOLOGICAL RESERVE|RECREATION AREA)$', ''),
       CASE PROTECTED_LANDS_DESIGNATION WHEN 'PROVINCIAL PARK' THEN 'PP' WHEN 'PROTECTED AREA' THEN 'PA'
            WHEN 'ECOLOGICAL RESERVE' THEN 'ER' ELSE 'RA' END,
       ST_MakeValid(geom::GEOMETRY)
FROM ST_Read('__SOURCES__/bc_parks.geojson');

-- Town limits: a point inside one is in that town, whatever is nearest.
-- Census-designated places are kept apart as kind 'cdp', since they are
-- unincorporated names. Northern Rockies is a municipality the size of a
-- regional district, so it is no town. BC tells its two pairs of namesakes
-- apart as "North Vancouver - City" and "Langley - District", which is too
-- long for a label and not how anybody writes either.
CREATE TABLE town_limits AS
SELECT "NAME" AS name, CASE WHEN LSAD = '57' THEN 'cdp' ELSE 'city' END AS kind, geom::GEOMETRY AS geom
FROM ST_Read('__SOURCES__/places/cb_2023_us_place_500k.shp')
UNION ALL
SELECT regexp_replace(ADMIN_AREA_ABBREVIATION, ' - (City|District)$', ''), 'city', geom::GEOMETRY
FROM ST_Read('__SOURCES__/bc_muni.geojson')
WHERE ADMIN_AREA_NAME NOT LIKE '%Northern Rockies%';

-- OpenStreetMap's parks and reserves (is_island false) and islands.
-- National forests and grasslands (protection class 6) are left out of the
-- parks: they cover most of the back country and would name it all
-- "Deschutes National Forest". Islets under 100 ha are left out of the
-- islands: most are in rivers (Norwood Island in the Willamette), where a
-- point on the bank would otherwise be given to them.
CREATE TABLE osm_area AS
SELECT osm_id, name, area_ha, is_island, ST_MakeValid(ST_GeomFromWKB(wkb)) AS geom
FROM osm_area_staged
WHERE (is_island AND area_ha >= 100) OR (NOT is_island AND coalesce(protect_class, '') <> '6');

-- GeoNames, read whole; both the places and the features come out of it.
CREATE TEMP TABLE geonames AS
SELECT id::INTEGER AS id, name, alt, lat::DOUBLE AS lat, lon::DOUBLE AS lon, fclass, fcode, cc, a1,
       coalesce(try_cast(pop AS BIGINT), 0) AS pop
FROM read_csv(['__SOURCES__/us/US.txt', '__SOURCES__/ca/CA.txt'], delim = '\t', header = false, quote = '', escape = '',
  all_varchar = true,
  columns = {'id': 'VARCHAR', 'name': 'VARCHAR', 'asciiname': 'VARCHAR', 'alt': 'VARCHAR', 'lat': 'VARCHAR',
             'lon': 'VARCHAR', 'fclass': 'VARCHAR', 'fcode': 'VARCHAR', 'cc': 'VARCHAR', 'cc2': 'VARCHAR',
             'a1': 'VARCHAR', 'a2': 'VARCHAR', 'a3': 'VARCHAR', 'a4': 'VARCHAR', 'pop': 'VARCHAR',
             'elev': 'VARCHAR', 'dem': 'VARCHAR', 'tz': 'VARCHAR', 'mod': 'VARCHAR'});

-- The places the rule names by distance: towns ('town', with a population
-- or none), notable peaks, and named localities nobody is counted in
-- (Galena, BC). Abandoned, historical, religious and neighbourhood entries
-- are left out of the towns. A peak with a name in some other language
-- stands in for "notable": GeoNames carries no prominence.
CREATE TEMP TABLE place_raw AS
SELECT id, name, lat, lon,
       CASE WHEN fclass = 'P' THEN 'town' WHEN fclass = 'L' THEN 'locality' ELSE 'peak' END AS kind,
       fcode, pop
FROM geonames
WHERE (fclass = 'P' AND fcode IN ('PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLC', 'PPLL', 'PPLS', 'PPLX'))
   OR (fclass = 'T' AND fcode IN ('MT', 'PK', 'PKS', 'MTS', 'BUTE', 'HLL') AND coalesce(alt, '') <> '')
   OR (fclass = 'L' AND fcode IN ('AREA', 'LCTY'));

-- Features that are not towns, which the rule names only where volunteers
-- have already written the name for samples near it (Takhlakh Lake, Chinook
-- Pass). Rivers, creeks, valleys, ridges, ranges, plains, canals and trails
-- are long, and GeoNames places each at one point (a stream at its mouth),
-- so being near that point says little. A park or reserve is named only
-- when a point is inside it (Bonnie Zand, 2026-10-26: volunteers collect
-- beside parks they have no permit for), which an outline says and a point
-- cannot. Washington, Oregon and Idaho, as the prototype measured.
CREATE TEMP TABLE feature_raw AS
SELECT id, name, lat, lon, concat(fclass, '.', coalesce(fcode, '')) AS code, a1 AS state
FROM geonames
WHERE cc = 'US' AND a1 IN ('WA', 'OR', 'ID') AND fclass <> 'P'
  AND concat(fclass, '.', fcode) NOT IN ('H.STM', 'H.STMI', 'H.STMS', 'H.STMX', 'H.CNL', 'T.VAL', 'T.VALS',
                                         'T.RDGE', 'T.MTS', 'T.PLN', 'R.TRL',
                                         'L.PRK', 'L.RES', 'L.RESN', 'L.RESW', 'L.RESF');

-- The island a place or a feature is on: the smallest within about 300 m,
-- since a town on the shore can sit just outside its island's outline (the
-- Salish Sea basemap's decision 018, Cattle Point).
CREATE TEMP TABLE point_island AS
SELECT p.id, arg_min(i.osm_id, i.area_ha) AS island_id
FROM (SELECT id, lat, lon FROM place_raw UNION SELECT id, lat, lon FROM feature_raw) p
JOIN osm_area i ON i.is_island AND ST_DWithin(i.geom, ST_Point(p.lon, p.lat), 0.003)
GROUP BY p.id;

CREATE TEMP TABLE place_region AS
SELECT p.id, any_value(r.region_id) AS region_id
FROM place_raw p JOIN region r ON ST_Intersects(r.geom, ST_Point(p.lon, p.lat))
GROUP BY p.id;

CREATE TABLE place AS
SELECT p.*, pr.region_id, pi.island_id
FROM place_raw p LEFT JOIN place_region pr USING (id) LEFT JOIN point_island pi USING (id);

-- fold is the name as fold_locality_name (src/derive-locality.ts) folds a
-- locality a volunteer wrote, so the two meet on equality.
CREATE TABLE feature AS
SELECT f.*, pi.island_id,
       regexp_replace(replace(replace(lower(f.name), 'mount ', 'mt '), 'mountain', 'mt'), '[^a-z0-9]', '', 'g') AS fold
FROM feature_raw f LEFT JOIN point_island pi USING (id);

DROP TABLE geonames;
DROP TABLE place_raw;
DROP TABLE feature_raw;
DROP TABLE point_island;
DROP TABLE place_region;
