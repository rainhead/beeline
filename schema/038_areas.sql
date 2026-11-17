-- Areas (beeline-9jd4): named places with an outline, and which of them each
-- sample's believed-true point lies inside. The kinds: the federal
-- wilderness, where collecting is forbidden except inside a national park the
-- program has a permit for (beeline-zdfz); the county, with BC's
-- regional districts as counties, so a sample's county can be read from its
-- point rather than from iNaturalist (beeline-313x); the EPA's Level III
-- ecoregion (beeline-l5so); and the places people collect in and name: the
-- national wildlife refuge, the WDFW wildlife area unit, the National Park
-- Service unit, the state or provincial park, any other park or reserve
-- OpenStreetMap outlines, and the island.
--
-- An area is reference data keyed by its source's own id, not an entity
-- (ADR 0002), as inat_place is: nothing is anchored on it, and an entity_id
-- would be drawn afresh by every reseed, moving any page addressed by it
-- (Peter, 2026-10-26). Areas are copied in from the gazetteer
-- (ingest/gazetteer.sql) by the nightly's derive step (src/derive-area.ts),
-- and only those at least one sample lies inside: the gazetteer holds every
-- wilderness and county in the country, and the store needs the few hundred
-- anybody collected in.
--
-- Nothing records that one area lies inside another (Peter, 2026-10-26):
-- containment is stored only between a sample and an area.
--
-- geom is GEOMETRY, which DuckDB 1.5 has built in: the store opens, copies
-- and migrates without the spatial extension, which only the derive step
-- loads. PostGIS has the same type (ADR 0001 names it as a seam).
CREATE TABLE area (
  source          TEXT NOT NULL CHECK (source IN ('wilderness.net', 'census', 'bc-abms', 'epa-cec', 'usfws', 'wdfw', 'nps', 'wa-parks', 'bc-parks', 'osm')),
  source_id       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('wilderness', 'county', 'ecoregion', 'refuge', 'wildlife_area', 'nps_unit', 'state_park', 'park', 'island')),
  name            TEXT NOT NULL,
  geom            GEOMETRY NOT NULL,
  gazetteer_build TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
);
COMMENT ON TABLE area IS 'A named place with an outline, copied from the gazetteer once a sample lies inside it (beeline-9jd4). Reference data keyed by its source''s own id, not an entity: a reseed must not move it.';
COMMENT ON COLUMN area.source IS 'Whose layer the outline comes from: wilderness.net is the National Wilderness Preservation System as Wilderness.net publishes it; census is the Census Bureau''s cartographic county boundaries; bc-abms is British Columbia''s legally defined administrative areas; epa-cec is the EPA''s Level III ecoregions of North America, the Commission for Environmental Cooperation''s file; usfws is the Fish and Wildlife Service''s refuge boundaries; wdfw is the Washington Department of Fish and Wildlife''s wildlife area units; nps is the National Park Service''s unit boundaries; wa-parks is Washington State Parks'' boundaries; bc-parks is BC''s parks, ecological reserves and protected areas; osm is OpenStreetMap (ODbL), for the parks and reserves no agency layer here gathers and for islands.';
COMMENT ON COLUMN area.source_id IS 'The source''s own id, which survives a rename: Wilderness.net''s WID (428 is the Daniel J. Evans Wilderness, called the Olympic Wilderness until 2017), a county''s Census GEOID (41003 is Benton County, Oregon), a regional district''s LGL_ADMIN_AREA_ID in BC''s layer, an ecoregion''s Level III code (7.1.9 is the Willamette Valley), a refuge''s ORGCODE (13588 is Ankeny NWR), a wildlife area unit''s SubUnitID, a National Park Service unit''s code (OLYM), a Washington state park''s ParkCode, a BC park''s ORCS number (0237-00), an OpenStreetMap element (relation/123). Outlines that share an id are one area.';
COMMENT ON COLUMN area.kind IS 'What sort of place: wilderness is a federally designated wilderness, never a wilderness study area (Peter, 2026-10-26); county is a US county or a BC regional district; ecoregion is an EPA Level III ecoregion; refuge is a national wildlife refuge, its conservation easements left out; wildlife_area is a unit of a WDFW wildlife area (Whiskey Dick, in L.T. Murray); nps_unit is a National Park Service unit, a park, monument or recreation area but no memorial; state_park is a Washington state park or a BC provincial park, protected area, ecological reserve or recreation area; park is any other park or reserve OpenStreetMap outlines, national forests left out, which is where Oregon''s state parks, county parks and land trust preserves are, and which repeats some refuges and parks the agency layers also give; island is an island of 100 ha or more.';
COMMENT ON COLUMN area.name IS 'The name as the source writes it: Steens Mountain Wilderness, Benton County, Capital Regional District, Willamette Valley, ANKENY NATIONAL WILDLIFE REFUGE, ELK FALLS PARK. The refuges and BC''s parks come in capitals, which a page shows in title case.';
COMMENT ON COLUMN area.gazetteer_build IS 'The gazetteer_build.build_id the row was last copied from.';

-- Which samples have had their areas worked out, at which point and from which
-- gazetteer. A sample inside no area has a row here and none in sample_area,
-- which is what tells "inside nothing" from "not yet looked at".
--
-- It also records what the point says about the sample's state or province
-- and country, read from the one county it lies in (beeline-rax1). That is a
-- statement about this sample's point, made at the point and build it was
-- made for, and not an attribute of the county: nothing records that a county
-- lies inside a state (above). sample.state_province is a different fact,
-- what the record and its labels say; the county stamp (src/derive-area.ts)
-- writes the one from the other where a sample still follows its point, and
-- sample_place_disagreement (schema/173) shows where they differ.
CREATE TABLE sample_area_derivation (
  sample_id       INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  latitude        DOUBLE NOT NULL,
  longitude       DOUBLE NOT NULL,
  gazetteer_build TEXT NOT NULL,
  rule_version    INTEGER NOT NULL,
  country         TEXT,
  state_province  TEXT,
  county_inside   BOOLEAN,
  county_inside_100m BOOLEAN,
  derived_at      TIMESTAMP NOT NULL
);
COMMENT ON TABLE sample_area_derivation IS 'The point and gazetteer build a sample''s areas (sample_area) were worked out at, as sample_locality_suggestion records them for a name: a moved point, a new build or a new rule is tested again. Also what that point says the sample''s country and state or province are.';
COMMENT ON COLUMN sample_area_derivation.latitude IS 'With longitude: the believed-true point the areas were found for. sample_area_current shows them only while the sample is still there.';
COMMENT ON COLUMN sample_area_derivation.rule_version IS 'AREA_RULE_VERSION in src/derive-area.ts when the areas were found. Raising that constant tests every sample again, as a new gazetteer build does.';
COMMENT ON COLUMN sample_area_derivation.country IS 'What the point says the country is: that of the one county or BC regional district it was found in (USA, CAN), however it was reached. NULL where it is in no county, or in two.';
COMMENT ON COLUMN sample_area_derivation.state_province IS 'What the point says the state or province is (OR, BC), from the same county as country. Not an attribute of the county: a statement about this sample''s point, which the sample''s own state_province may contradict.';
COMMENT ON COLUMN sample_area_derivation.county_inside IS 'TRUE where the point lies inside that county''s outline; FALSE where it lies outside every county and took the nearest within 1 km, on the shore (COUNTY_SHORE_M), which near a land border can be across it. NULL where there is no county.';
COMMENT ON COLUMN sample_area_derivation.county_inside_100m IS 'TRUE where the point is at least 100 m inside that county: a square 200 m across, centred on it, lies wholly inside the outline. FALSE nearer the edge, and on the shore. 100 m is the program''s allowance for GPS error, so a point nearer may be in the next county or state; sample_place_disagreement leaves those out. The square''s corners reach about 141 m.';

-- No foreign key to area: DuckDB updates a referenced row as a delete and an
-- insert, and refuses the delete, so one would stop a new gazetteer build from
-- ever refreshing an area's name or outline. The derive step writes an area
-- before any row naming it, and removes only areas nothing names.
CREATE TABLE sample_area (
  sample_id      INTEGER NOT NULL REFERENCES sample(entity_id),
  area_source    TEXT NOT NULL,
  area_source_id TEXT NOT NULL,
  PRIMARY KEY (sample_id, area_source, area_source_id)
);
COMMENT ON TABLE sample_area IS 'Each area a sample''s believed-true point lies inside, whatever its kind. Inside a wilderness means more than 100 m inside its outline, the program''s allowance for GPS error (Peter, 2026-10-26); a county is simply the one the point is in, and so is an ecoregion, or for a point on the shore the nearest within 1 km; a refuge, park or island is one whose outline the point is inside, with no allowance (Peter, 2026-11-13, for refuges). Worked out at the point and build in sample_area_derivation.';
