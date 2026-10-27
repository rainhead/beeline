-- Migration for schema/038 (beeline-9jd4): counties and BC's regional
-- districts become a kind of area, from two more sources. DuckDB cannot alter
-- a CHECK constraint, so area is made again, keeping its rows: nothing refers
-- to it by foreign key. The samples' areas stay as they are, so the wilderness
-- notes stay up until a gazetteer built from this commit's
-- ingest/gazetteer.sql arrives; until then the nightly says the gazetteer
-- predates areas, and once it does, its new build tests every sample again.

DROP VIEW sample_area_current;
CREATE TABLE area_kept AS SELECT source, source_id, kind, name, geom, gazetteer_build FROM area;
DROP TABLE area;

CREATE TABLE area (
  source          TEXT NOT NULL CHECK (source IN ('wilderness.net', 'census', 'bc-abms')),
  source_id       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('wilderness', 'county')),
  name            TEXT NOT NULL,
  geom            GEOMETRY NOT NULL,
  gazetteer_build TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
);
COMMENT ON TABLE area IS 'A named place with an outline, copied from the gazetteer once a sample lies inside it (beeline-9jd4). Reference data keyed by its source''s own id, not an entity: a reseed must not move it.';
COMMENT ON COLUMN area.source IS 'Whose layer the outline comes from: wilderness.net is the National Wilderness Preservation System as Wilderness.net publishes it; census is the Census Bureau''s cartographic county boundaries; bc-abms is British Columbia''s legally defined administrative areas.';
COMMENT ON COLUMN area.source_id IS 'The source''s own id, which survives a rename: Wilderness.net''s WID (428 is the Daniel J. Evans Wilderness, called the Olympic Wilderness until 2017), a county''s Census GEOID (41003 is Benton County, Oregon), a regional district''s LGL_ADMIN_AREA_ID in BC''s layer.';
COMMENT ON COLUMN area.kind IS 'What sort of place: wilderness is a federally designated wilderness, never a wilderness study area (Peter, 2026-10-26); county is a US county or a BC regional district.';
COMMENT ON COLUMN area.name IS 'The name as the source writes it: Steens Mountain Wilderness, Benton County, Capital Regional District.';
COMMENT ON COLUMN area.gazetteer_build IS 'The gazetteer_build.build_id the row was last copied from.';
INSERT INTO area (source, source_id, kind, name, geom, gazetteer_build)
SELECT source, source_id, kind, name, geom, gazetteer_build FROM area_kept;
DROP TABLE area_kept;
COMMENT ON TABLE sample_area IS 'Each area a sample''s believed-true point lies inside, whatever its kind. Inside a wilderness means more than 100 m inside its outline, the program''s allowance for GPS error (Peter, 2026-10-26); a county is simply the one the point is in. Worked out at the point and build in sample_area_derivation.';

CREATE VIEW sample_area_current AS
SELECT sa.sample_id, a.source, a.source_id, a.kind, a.name
FROM sample_area sa
JOIN area a ON a.source = sa.area_source AND a.source_id = sa.area_source_id
JOIN sample_area_derivation d ON d.sample_id = sa.sample_id
JOIN sample_location l ON l.sample_id = sa.sample_id
WHERE abs(d.latitude - l.latitude) <= 5e-5
  AND abs(d.longitude - l.longitude) <= 5e-5;
