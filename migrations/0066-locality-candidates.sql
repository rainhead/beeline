-- Migration for schema/037 and schema/172 (beeline-4hxe): the one suggested
-- locality per sample becomes up to four candidates, best first, and the
-- bases gain the names already used nearby and campgrounds. DuckDB cannot
-- change a CHECK in place, so the table is replaced; the suggestions it held
-- come across as rank 1, and the nightly's derive step fills in the rest the
-- next time it names each sample (a new gazetteer build names them all).

DROP VIEW sample_locality_suggestion_current;

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

INSERT INTO sample_locality_candidate
SELECT sample_id, 1, locality, basis, latitude, longitude, gazetteer_build, derived_at
FROM sample_locality_suggestion;

DROP TABLE sample_locality_suggestion;

CREATE VIEW sample_locality_candidate_current AS
SELECT g.sample_id, g.rank, g.locality, g.basis, g.gazetteer_build, g.derived_at
FROM sample_locality_candidate g
JOIN sample_location l ON l.sample_id = g.sample_id
WHERE abs(g.latitude - l.latitude) <= 5e-5
  AND abs(g.longitude - l.longitude) <= 5e-5;
COMMENT ON VIEW sample_locality_candidate_current IS 'Every candidate locality still about the sample''s point, best first by rank.';

CREATE VIEW sample_locality_suggestion_current AS
SELECT sample_id, locality, basis, gazetteer_build, derived_at
FROM sample_locality_candidate_current
WHERE rank = 1;
COMMENT ON VIEW sample_locality_suggestion_current IS 'The best candidate locality for the sample''s point (rank 1 of sample_locality_candidate_current).';
