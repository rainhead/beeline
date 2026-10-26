-- A locality named from a sample's coordinates (beeline-7i6): the short place
-- name src/locality-rule.ts gives the believed-true point, offered beside the
-- locality the sample has. It is a proposal and never the sample's locality:
-- iNaturalist stays the authority, and a volunteer who likes the name pastes
-- it into the observation. Written by the nightly's derive step
-- (src/derive-locality.ts) from the gazetteer, a separate file built on a
-- workstation (ingest/gazetteer.sql).
--
-- Like an elevation, it is a statement about a point, so it records the
-- point it was named at, and schema/172 states when it still describes the
-- sample's. It also records which gazetteer build named it, since a new
-- build can name the same point differently; the derive step names again
-- every sample whose row came from another build.
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
