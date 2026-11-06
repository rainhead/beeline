-- The areas a sample lies inside, where they were worked out at the point the
-- sample has now (beeline-9jd4). Areas found for somewhere else are not shown:
-- the coordinates moved, or the sample has none now, and the next nightly
-- tests it again. The tolerance is schema/170's, for its reason.
CREATE VIEW sample_area_current AS
SELECT sa.sample_id, a.source, a.source_id, a.kind, a.name
FROM sample_area sa
JOIN area a ON a.source = sa.area_source AND a.source_id = sa.area_source_id
JOIN sample_area_derivation d ON d.sample_id = sa.sample_id
JOIN sample_location l ON l.sample_id = sa.sample_id
WHERE abs(d.latitude - l.latitude) <= 5e-5
  AND abs(d.longitude - l.longitude) <= 5e-5;

-- Located samples that no ecoregion was found for (beeline-l5so): the file
-- covers the land, so a point in the sea off the coast, or in a country the
-- file leaves out, is in none, and so is a sample the derive step has not yet
-- tested against a gazetteer that holds ecoregions. A check count, so it says
-- which season the sample is in: ask it split, never as one number.
CREATE VIEW sample_ecoregion_missing AS
SELECT d.sample_id, EXISTS (SELECT 1 FROM settled_sample ss WHERE ss.sample_id = d.sample_id) AS settled
FROM sample_area_derivation d
JOIN sample_location l ON l.sample_id = d.sample_id
WHERE abs(d.latitude - l.latitude) <= 5e-5
  AND abs(d.longitude - l.longitude) <= 5e-5
  AND NOT EXISTS (SELECT 1 FROM sample_area_current c WHERE c.sample_id = d.sample_id AND c.kind = 'ecoregion');
COMMENT ON VIEW sample_ecoregion_missing IS 'Samples with a believed-true point, tested for areas at that point, that lie in no EPA ecoregion (a point in the sea beyond 1 km of the shore, or outside the file''s coverage). settled says whether the sample is from a settled season, so the count is read split: active seasons against settled ones.';
