-- Migration for schema/037 and schema/172 (beeline-7i6): a locality named
-- from a sample's coordinates, offered beside its own. The table arrives
-- empty; the nightly's derive step fills it once the gazetteer is on the
-- machine (docs/runbooks/deploy-fly.md). The delta is the schema verbatim.

CREATE TABLE sample_locality_suggestion (
  sample_id       INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  locality        TEXT NOT NULL,
  basis           TEXT NOT NULL CHECK (basis IN (
                    'refuge', 'wildlife_area', 'national_park', 'state_park', 'local_park', 'neighbourhood',
                    'town_limits', 'island', 'feature', 'peak', 'town', 'hamlet', 'large_reserve', 'distance')),
  latitude        DOUBLE NOT NULL,
  longitude       DOUBLE NOT NULL,
  gazetteer_build TEXT NOT NULL,
  derived_at      TIMESTAMP NOT NULL
);
COMMENT ON TABLE sample_locality_suggestion IS 'A locality named from the sample''s believed-true coordinates by src/locality-rule.ts (beeline-7i6): a proposal shown beside the sample''s own locality, never written into it. Only sample_locality_suggestion_current is about the point the sample has now.';
COMMENT ON COLUMN sample_locality_suggestion.basis IS 'Which step of the rule named the point: inside a refuge, a wildlife area unit, a national park unit, a state or provincial park, a local park; a city neighbourhood; inside a town''s limits; on an island; a feature volunteers named nearby; a peak; a nearby town; a hamlet; inside a large reserve; or a distance and direction from a far town.';
COMMENT ON COLUMN sample_locality_suggestion.latitude IS 'With longitude: the point the name was given for, so the store can say whether it still describes the sample''s (schema/172), as elevation_latitude does for an elevation.';
COMMENT ON COLUMN sample_locality_suggestion.gazetteer_build IS 'The gazetteer_build.build_id of the gazetteer that named it. A new build names every sample again.';

CREATE VIEW sample_locality_suggestion_current AS
SELECT g.sample_id, g.locality, g.basis, g.gazetteer_build, g.derived_at
FROM sample_locality_suggestion g
JOIN sample_location l ON l.sample_id = g.sample_id
WHERE abs(g.latitude - l.latitude) <= 5e-5
  AND abs(g.longitude - l.longitude) <= 5e-5;
