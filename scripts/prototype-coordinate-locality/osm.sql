-- PROTOTYPE (beeline-7i6) — throwaway. Named parks and nature reserves from
-- an OpenStreetMap extract (data under the ODbL), for the regional and
-- municipal parks no government layer gathers: Uplands Park, Thetis Lake;
-- and named islands (place=island or islet), so a point on Galiano Island is
-- not named for Ganges, a town on another island.
-- Outlines are assembled here from the raw ways and relations, since GDAL's
-- OSM reader stops early inside DuckDB. __PBF__ and __REGION__ are
-- substituted by build.sh, once per extract.
LOAD spatial;
CREATE TABLE IF NOT EXISTS osm_park (region TEXT, osm_id TEXT, name TEXT, leisure TEXT, boundary TEXT, area_ha DOUBLE, geom GEOMETRY, protect_class TEXT, place TEXT);
DELETE FROM osm_park WHERE region = '__REGION__';

CREATE TEMP TABLE want AS
SELECT kind, id, element_at(tags, 'name')[1] AS name, element_at(tags, 'leisure')[1] AS leisure,
       element_at(tags, 'boundary')[1] AS boundary, element_at(tags, 'protect_class')[1] AS protect_class,
       element_at(tags, 'place')[1] AS place, refs, ref_roles, ref_types
FROM ST_ReadOSM('__PBF__')
WHERE kind IN ('way', 'relation') AND element_at(tags, 'name')[1] IS NOT NULL
  AND (element_at(tags, 'leisure')[1] IN ('park', 'nature_reserve')
       OR element_at(tags, 'boundary')[1] IN ('protected_area', 'national_park')
       OR element_at(tags, 'place')[1] IN ('island', 'islet'))
  -- OpenStreetMap tags First Nations reserves as protected areas (class 24),
  -- and an Indian reserve is no park to name on a label.
  AND coalesce(element_at(tags, 'protect_class')[1], '') <> '24'
  AND coalesce(element_at(tags, 'boundary')[1], '') <> 'aboriginal_lands';

-- Each wanted outline's ways: a way is its own, a relation's are its members.
CREATE TEMP TABLE part AS
SELECT kind AS owner_kind, id AS owner_id, id AS way_id FROM want WHERE kind = 'way'
UNION ALL
SELECT owner_kind, owner_id, way_id FROM (
  SELECT kind AS owner_kind, id AS owner_id, unnest(refs) AS way_id, unnest(ref_types) AS t FROM want WHERE kind = 'relation')
WHERE t = 'way';

CREATE TEMP TABLE way_node AS
SELECT id AS way_id, unnest(refs) AS node_id, generate_subscripts(refs, 1) AS idx
FROM ST_ReadOSM('__PBF__')
WHERE kind = 'way' AND id IN (SELECT way_id FROM part);

CREATE TEMP TABLE node AS
SELECT id, lat, lon FROM ST_ReadOSM('__PBF__')
WHERE kind = 'node' AND id IN (SELECT node_id FROM way_node);

CREATE TEMP TABLE way_line AS
SELECT wn.way_id, ST_MakeLine(list(ST_Point(n.lon, n.lat) ORDER BY wn.idx)) AS geom
FROM way_node wn JOIN node n ON n.id = wn.node_id
GROUP BY wn.way_id HAVING count(*) >= 2;

INSERT INTO osm_park
SELECT '__REGION__', concat(owner_kind, '/', owner_id), name, leisure, boundary,
       ST_Area_Spheroid(ST_FlipCoordinates(g)) / 10000, g, protect_class, place
FROM (
  SELECT p.owner_kind, p.owner_id, any_value(w.name) AS name, any_value(w.leisure) AS leisure,
         any_value(w.boundary) AS boundary, any_value(w.protect_class) AS protect_class, any_value(w.place) AS place, ST_BuildArea(ST_Collect(list(l.geom))) AS g
  FROM part p
  JOIN want w ON w.kind = p.owner_kind AND w.id = p.owner_id
  JOIN way_line l ON l.way_id = p.way_id
  GROUP BY p.owner_kind, p.owner_id
)
WHERE g IS NOT NULL AND NOT ST_IsEmpty(g);

SELECT leisure, boundary, count(*) AS n, round(median(area_ha), 1) AS median_ha FROM osm_park
WHERE region = '__REGION__' GROUP BY ALL ORDER BY n DESC;
