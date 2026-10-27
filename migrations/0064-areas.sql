-- Migration for schema/038 and schema/173 (beeline-9jd4): areas, and which
-- samples lie inside them. The tables arrive empty; the nightly's derive step
-- fills them once a gazetteer with wildernesses is on the machine
-- (docs/runbooks/deploy-fly.md). GEOMETRY is a core type in DuckDB 1.5, so
-- this runs without the spatial extension. The delta is the schema verbatim.

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

CREATE TABLE sample_area_derivation (
  sample_id       INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  latitude        DOUBLE NOT NULL,
  longitude       DOUBLE NOT NULL,
  gazetteer_build TEXT NOT NULL,
  derived_at      TIMESTAMP NOT NULL
);
COMMENT ON TABLE sample_area_derivation IS 'The point and gazetteer build a sample''s areas (sample_area) were worked out at, as sample_locality_suggestion records them for a name: a moved point or a new build is tested again.';
COMMENT ON COLUMN sample_area_derivation.latitude IS 'With longitude: the believed-true point the areas were found for. sample_area_current shows them only while the sample is still there.';

CREATE TABLE sample_area (
  sample_id      INTEGER NOT NULL REFERENCES sample(entity_id),
  area_source    TEXT NOT NULL,
  area_source_id TEXT NOT NULL,
  PRIMARY KEY (sample_id, area_source, area_source_id)
);
COMMENT ON TABLE sample_area IS 'Each area a sample''s believed-true point lies inside, whatever its kind. Inside a wilderness means more than 100 m inside its outline, the program''s allowance for GPS error (Peter, 2026-10-26). Worked out at the point and build in sample_area_derivation.';

CREATE VIEW sample_area_current AS
SELECT sa.sample_id, a.source, a.source_id, a.kind, a.name
FROM sample_area sa
JOIN area a ON a.source = sa.area_source AND a.source_id = sa.area_source_id
JOIN sample_area_derivation d ON d.sample_id = sa.sample_id
JOIN sample_location l ON l.sample_id = sa.sample_id
WHERE abs(d.latitude - l.latitude) <= 5e-5
  AND abs(d.longitude - l.longitude) <= 5e-5;
