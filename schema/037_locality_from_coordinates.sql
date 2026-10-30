-- The localities named for a sample's coordinates (beeline-7i6, beeline-4hxe):
-- the short place names src/locality-rule.ts gives the believed-true point,
-- best first, offered beside the locality the sample has. Rank 1 is the one
-- the pages call the suggestion; ranks 2 to 4 are the alternatives a person
-- may choose instead. It is a proposal and never the sample's locality:
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
CREATE TABLE sample_locality_candidate (
  sample_id       INTEGER NOT NULL REFERENCES sample(entity_id),
  rank            INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 4),
  locality        TEXT NOT NULL,
  basis           TEXT NOT NULL CHECK (basis IN (
                    'used_own', 'used', 'campground',
                    'refuge', 'wildlife_area', 'national_park', 'state_park', 'local_park', 'neighbourhood',
                    'town_limits', 'island', 'feature', 'peak', 'town', 'hamlet', 'large_reserve', 'distance')),
  latitude        DOUBLE NOT NULL,
  longitude       DOUBLE NOT NULL,
  gazetteer_build TEXT NOT NULL,
  derived_at      TIMESTAMP NOT NULL,
  PRIMARY KEY (sample_id, rank)
);
COMMENT ON TABLE sample_locality_candidate IS 'The localities named for the sample''s believed-true coordinates by src/locality-rule.ts (beeline-7i6, beeline-4hxe), best first: rank 1 is the suggestion, 2 to 4 the alternatives. Proposals shown beside the sample''s own locality, never written into it. Only the *_current views are about the point the sample has now.';
COMMENT ON COLUMN sample_locality_candidate.rank IS 'Best first. The best weights names already written for samples within a kilometre, the collector''s own first; a refuge outranks everything (src/locality-rule.ts, localityCandidates).';
COMMENT ON COLUMN sample_locality_candidate.basis IS 'Why the name was offered: the locality of the collector''s other samples here, of other samples here; a campground beside it; inside a refuge, a wildlife area unit, a national park unit, a state or provincial park, a local park; a city neighbourhood; inside a town''s limits; on an island; a feature volunteers named nearby; a peak; a nearby town; a hamlet; inside a large reserve; or a distance and direction from a far town.';
COMMENT ON COLUMN sample_locality_candidate.latitude IS 'With longitude: the point the name was given for, so the store can say whether it still describes the sample''s (schema/172), as elevation_latitude does for an elevation.';
COMMENT ON COLUMN sample_locality_candidate.gazetteer_build IS 'The gazetteer_build.build_id of the gazetteer that named it. A new build names every sample again.';
