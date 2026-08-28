-- Migration for schema/170_views_elevation.sql (beeline-6vc): refuse to
-- derive an elevation for a coordinate too vague to support one.
--
-- A DEM lookup returns a confident integer whatever you hand it. The worst in
-- the corpus is a 2,979 km uncertainty carrying a 260 m elevation; that number
-- constrains nothing, and an elevation printed on a label is permanent.
--
-- Threshold 100 m (Peter, 2026-08-27), which is tighter than the 250 m at
-- which qc_rule_coordinate_uncertainty blocks printing — an elevation is a
-- stricter claim than a locality string. This changes what gets *derived*
-- from here on and removes nothing: sample_elevation_unsupportable names the
-- ones already present — 1,558 on the dev store, 744 of them under the 250 m
-- printing limit and so on records that still print, and 1,546 of them from
-- iNaturalist rather than the legacy import, which makes this a live upstream
-- shape rather than a historical mess.
DROP VIEW sample_elevation_pending;

CREATE VIEW elevation_derivation_limit AS
SELECT 100 AS coordinate_uncertainty_m;

CREATE VIEW sample_elevation_unsupportable AS
SELECT sample_id, coordinate_uncertainty_m, elevation_m, elevation_source_id
FROM sample_location
WHERE elevation_m IS NOT NULL
  AND coordinate_uncertainty_m > (SELECT coordinate_uncertainty_m FROM elevation_derivation_limit);

CREATE VIEW sample_elevation_pending AS
SELECT sample_id, latitude, longitude FROM (
  SELECT sample_id, latitude, longitude, coordinate_uncertainty_m
  FROM sample_location WHERE elevation_m IS NULL
  UNION ALL
  SELECT s.sample_id, s.latitude, s.longitude, loc.coordinate_uncertainty_m
  FROM sample_elevation_stale s
  JOIN sample_location loc ON loc.sample_id = s.sample_id
) candidate
WHERE coordinate_uncertainty_m IS NULL
   OR coordinate_uncertainty_m <= (SELECT coordinate_uncertainty_m FROM elevation_derivation_limit);
