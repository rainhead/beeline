-- Areas (beeline-9jd4): named places with an outline, and which of them each
-- sample's believed-true point lies inside. The first kind is the federal
-- wilderness, where collecting is forbidden except inside a national park the
-- program has a permit for (beeline-zdfz); refuges, wildlife area units,
-- parks, islands and counties are to follow.
--
-- An area is reference data keyed by its source's own id, not an entity
-- (ADR 0002), as inat_place is: nothing is anchored on it, and an entity_id
-- would be drawn afresh by every reseed, moving any page addressed by it
-- (Peter, 2026-10-26). Areas are copied in from the gazetteer
-- (ingest/gazetteer.sql) by the nightly's derive step (src/derive-area.ts),
-- and only those at least one sample lies inside: the gazetteer holds every
-- wilderness in the country, and the store needs the few dozen anybody
-- collected in.
--
-- Nothing records that one area lies inside another (Peter, 2026-10-26):
-- containment is stored only between a sample and an area.
--
-- geom is GEOMETRY, which DuckDB 1.5 has built in: the store opens, copies
-- and migrates without the spatial extension, which only the derive step
-- loads. PostGIS has the same type (ADR 0001 names it as a seam).
CREATE TABLE area (
  source          TEXT NOT NULL CHECK (source IN ('wilderness.net')),
  source_id       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('wilderness')),
  name            TEXT NOT NULL,
  geom            GEOMETRY NOT NULL,
  gazetteer_build TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
);
COMMENT ON TABLE area IS 'A named place with an outline, copied from the gazetteer once a sample lies inside it (beeline-9jd4). Reference data keyed by its source''s own id, not an entity: a reseed must not move it.';
COMMENT ON COLUMN area.source IS 'Whose layer the outline comes from: wilderness.net is the National Wilderness Preservation System as Wilderness.net publishes it.';
COMMENT ON COLUMN area.source_id IS 'The source''s own id, which survives a rename: Wilderness.net''s WID (428 is the Daniel J. Evans Wilderness, called the Olympic Wilderness until 2017).';
COMMENT ON COLUMN area.kind IS 'What sort of place: wilderness is a federally designated wilderness, never a wilderness study area (Peter, 2026-10-26).';
COMMENT ON COLUMN area.name IS 'The name as the source writes it: Steens Mountain Wilderness.';
COMMENT ON COLUMN area.gazetteer_build IS 'The gazetteer_build.build_id the row was last copied from.';

-- Which samples have had their areas worked out, at which point and from which
-- gazetteer. A sample inside no area has a row here and none in sample_area,
-- which is what tells "inside nothing" from "not yet looked at".
CREATE TABLE sample_area_derivation (
  sample_id       INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  latitude        DOUBLE NOT NULL,
  longitude       DOUBLE NOT NULL,
  gazetteer_build TEXT NOT NULL,
  derived_at      TIMESTAMP NOT NULL
);
COMMENT ON TABLE sample_area_derivation IS 'The point and gazetteer build a sample''s areas (sample_area) were worked out at, as sample_locality_suggestion records them for a name: a moved point or a new build is tested again.';
COMMENT ON COLUMN sample_area_derivation.latitude IS 'With longitude: the believed-true point the areas were found for. sample_area_current shows them only while the sample is still there.';

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
COMMENT ON TABLE sample_area IS 'Each area a sample''s believed-true point lies inside, whatever its kind. Inside a wilderness means more than 100 m inside its outline, the program''s allowance for GPS error (Peter, 2026-10-26). Worked out at the point and build in sample_area_derivation.';
