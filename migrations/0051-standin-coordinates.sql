-- Migration for schema/106_view_sample_location_standin.sql (beeline-b34):
-- imported coordinates that are a point iNaturalist published to hide the
-- real one. The reasoning is in schema/106; observation promotion replaces
-- each with the true point on its next pass.
CREATE VIEW sample_location_standin AS
SELECT s.entity_id AS sample_id,
       l.latitude, l.longitude,
       ol.latitude AS true_latitude, ol.longitude AS true_longitude,
       round(111195 * sqrt(power(l.latitude - ol.latitude, 2)
             + power((l.longitude - ol.longitude) * cos(radians(ol.latitude)), 2))) AS distance_m
FROM sample s
JOIN sample_location l ON l.sample_id = s.entity_id
JOIN observation_field f ON f.inat_id = s.inat_observation_id
JOIN observation_location ol ON ol.inat_id = f.inat_id
WHERE l.source = 'legacy_import'
  AND ol.source = 'inat_trusted'
  AND (nullif(f.geoprivacy, 'open') IS NOT NULL OR nullif(f.taxon_geoprivacy, 'open') IS NOT NULL)
  AND 111195 * sqrt(power(l.latitude - ol.latitude, 2)
      + power((l.longitude - ol.longitude) * cos(radians(ol.latitude)), 2)) >= 100;
COMMENT ON VIEW sample_location_standin IS 'Samples whose imported coordinates lie 100 m or more from the true point of their obscured observation: a point iNaturalist published to hide the real one, which the old system stored and printed (beeline-b34). Observation promotion replaces each with the true point, printed or not (Arthur, 2026-10-14), so this is empty after every promotion.';
