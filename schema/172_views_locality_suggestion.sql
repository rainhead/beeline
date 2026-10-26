-- The locality named from a sample's coordinates, where it is still about the
-- point the sample has (beeline-7i6). A name given for somewhere else is not
-- shown: the coordinates moved, or the sample has none now, and the next
-- nightly names it again. The tolerance is schema/170's, for its reason: the
-- legacy export carries four decimal places, so a smaller difference is the
-- same point rounded.
CREATE VIEW sample_locality_suggestion_current AS
SELECT g.sample_id, g.locality, g.basis, g.gazetteer_build, g.derived_at
FROM sample_locality_suggestion g
JOIN sample_location l ON l.sample_id = g.sample_id
WHERE abs(g.latitude - l.latitude) <= 5e-5
  AND abs(g.longitude - l.longitude) <= 5e-5;
