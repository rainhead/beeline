-- The localities named for a sample's coordinates, where they are still about
-- the point the sample has (beeline-7i6). A name given for somewhere else is
-- not shown: the coordinates moved, or the sample has none now, and the next
-- nightly names it again. The tolerance is schema/170's, for its reason: the
-- legacy export carries four decimal places, so a smaller difference is the
-- same point rounded.
CREATE VIEW sample_locality_candidate_current AS
SELECT g.sample_id, g.rank, g.locality, g.basis, g.gazetteer_build, g.derived_at
FROM sample_locality_candidate g
JOIN sample_location l ON l.sample_id = g.sample_id
WHERE abs(g.latitude - l.latitude) <= 5e-5
  AND abs(g.longitude - l.longitude) <= 5e-5;
COMMENT ON VIEW sample_locality_candidate_current IS 'Every candidate locality still about the sample''s point, best first by rank.';

-- The best of them: what the pages call the suggestion.
CREATE VIEW sample_locality_suggestion_current AS
SELECT sample_id, locality, basis, gazetteer_build, derived_at
FROM sample_locality_candidate_current
WHERE rank = 1;
COMMENT ON VIEW sample_locality_suggestion_current IS 'The best candidate locality for the sample''s point (rank 1 of sample_locality_candidate_current).';
