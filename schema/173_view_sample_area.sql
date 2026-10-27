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
