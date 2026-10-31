-- Named campgrounds from one OpenStreetMap extract (data under the ODbL), for
-- the gazetteer a locality is named from (beeline-4hxe): collectors camp in
-- the back country, where the nearest town is a long way off and the
-- campground is the name that says where. OpenStreetMap maps one as a point
-- or as an outline (tourism=camp_site); an outline is taken at the mean of
-- its corners, which is near enough for a name offered within 1.5 km.
-- A closed campground is left out (Peter, 2026-10-30): mappers say so in
-- brackets after the name, 'Silvertip Campground (closed)', or with
-- opening_hours=closed. One that is gone for good is usually retagged
-- disused:tourism, which this never reads.
-- __PBF__ and __OUT__ are substituted by the builder.
CREATE TEMP TABLE camp_want AS
SELECT kind, id, element_at(tags, 'name')[1] AS name, lat, lon, refs
FROM ST_ReadOSM('__PBF__')
WHERE kind IN ('node', 'way')
  AND element_at(tags, 'tourism')[1] = 'camp_site'
  AND element_at(tags, 'name')[1] IS NOT NULL
  AND NOT regexp_matches(lower(element_at(tags, 'name')[1]), '[(\[][^)\]]*closed[^)\]]*[)\]]\s*$')
  AND coalesce(element_at(tags, 'opening_hours')[1], '') <> 'closed';

CREATE TEMP TABLE camp_way_node AS
SELECT id AS way_id, unnest(refs) AS node_id FROM camp_want WHERE kind = 'way';

CREATE TEMP TABLE camp_node AS
SELECT id, lat, lon FROM ST_ReadOSM('__PBF__')
WHERE kind = 'node' AND id IN (SELECT node_id FROM camp_way_node);

COPY (
  SELECT concat('node/', id) AS osm_id, name, lat, lon FROM camp_want WHERE kind = 'node'
  UNION ALL
  SELECT concat('way/', w.way_id), any_value(c.name), avg(n.lat), avg(n.lon)
  FROM camp_way_node w
  JOIN camp_node n ON n.id = w.node_id
  JOIN camp_want c ON c.kind = 'way' AND c.id = w.way_id
  GROUP BY w.way_id
) TO '__OUT__' (FORMAT parquet);

DROP TABLE camp_want;
DROP TABLE camp_way_node;
DROP TABLE camp_node;
