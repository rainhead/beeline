-- Named parks, nature reserves and islands from one OpenStreetMap extract
-- (data under the ODbL), for the gazetteer a locality is named from
-- (src/build-gazetteer.ts, beeline-7i6): the regional and city parks no
-- government layer gathers (Uplands Park, Thetis Lake), and the islands a
-- point on is named only from (Galiano Island, never Ganges on Salt Spring).
--
-- Outlines are assembled here from the raw ways and relations, because
-- GDAL's OSM reader stops early inside DuckDB. The result is written to
-- __OUT__ as Parquet, with each outline as WKB, so a slow extract (British
-- Columbia's takes minutes) is read once and not on every build.
-- __PBF__ and __OUT__ are substituted by the builder.
CREATE TEMP TABLE osm_want AS
SELECT kind, id, element_at(tags, 'name')[1] AS name, element_at(tags, 'leisure')[1] AS leisure,
       element_at(tags, 'boundary')[1] AS boundary, element_at(tags, 'protect_class')[1] AS protect_class,
       element_at(tags, 'place')[1] AS place, refs, ref_types
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
CREATE TEMP TABLE osm_part AS
SELECT kind AS owner_kind, id AS owner_id, id AS way_id FROM osm_want WHERE kind = 'way'
UNION ALL
SELECT owner_kind, owner_id, way_id FROM (
  SELECT kind AS owner_kind, id AS owner_id, unnest(refs) AS way_id, unnest(ref_types) AS t
  FROM osm_want WHERE kind = 'relation')
WHERE t = 'way';

CREATE TEMP TABLE osm_way_node AS
SELECT id AS way_id, unnest(refs) AS node_id, generate_subscripts(refs, 1) AS idx
FROM ST_ReadOSM('__PBF__')
WHERE kind = 'way' AND id IN (SELECT way_id FROM osm_part);

CREATE TEMP TABLE osm_node AS
SELECT id, lat, lon FROM ST_ReadOSM('__PBF__')
WHERE kind = 'node' AND id IN (SELECT node_id FROM osm_way_node);

CREATE TEMP TABLE osm_way_line AS
SELECT wn.way_id, ST_MakeLine(list(ST_Point(n.lon, n.lat) ORDER BY wn.idx)) AS geom
FROM osm_way_node wn JOIN osm_node n ON n.id = wn.node_id
GROUP BY wn.way_id HAVING count(*) >= 2;

COPY (
  SELECT concat(owner_kind, '/', owner_id) AS osm_id, name, protect_class, place IS NOT NULL AS is_island,
         ST_Area_Spheroid(ST_FlipCoordinates(g)) / 10000 AS area_ha, ST_AsWKB(g) AS wkb
  FROM (
    SELECT p.owner_kind, p.owner_id, any_value(w.name) AS name, any_value(w.protect_class) AS protect_class,
           any_value(w.place) AS place, ST_BuildArea(ST_Collect(list(l.geom))) AS g
    FROM osm_part p
    JOIN osm_want w ON w.kind = p.owner_kind AND w.id = p.owner_id
    JOIN osm_way_line l ON l.way_id = p.way_id
    GROUP BY p.owner_kind, p.owner_id
  )
  WHERE g IS NOT NULL AND NOT ST_IsEmpty(g)
) TO '__OUT__' (FORMAT parquet);

DROP TABLE osm_want;
DROP TABLE osm_part;
DROP TABLE osm_way_node;
DROP TABLE osm_node;
DROP TABLE osm_way_line;
