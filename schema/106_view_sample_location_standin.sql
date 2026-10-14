-- A sample whose coordinates are a point iNaturalist published to hide the
-- real one (beeline-b34). When an observation is obscured, iNaturalist
-- publishes a random point inside a grid square about 20 km across, and the
-- old system stored that point and printed it on labels wherever it had no
-- access to the true one: 271 printed specimens on production on 2026-09-22.
-- Arthur decided on 2026-10-14 (oregon-bee-project/OBP-Server#60) that the
-- record holds the true point even though the pins do not: "The accuracy of
-- beeline data takes precedence here." Observation promotion takes the true
-- point onto every sample named here, printed or not, and so empties the
-- view; a row that survives a promotion is a defect.
--
-- The test is the distance from the true point, never equality with the
-- point iNaturalist publishes today: it draws a new one whenever the
-- observation's coordinates are edited, so a stand-in stored years ago
-- rarely matches today's. Only an imported point qualifies, since Beeline
-- itself never stores a published stand-in (observation_location yields
-- nothing for an obscured observation without trust), and only on an
-- observation that is obscured now, so on an open observation a printed
-- point the observer moved later keeps what the label says (beeline-1kb.17).
-- On an obscured one, a move of 100 m or more after printing cannot be told
-- from a stand-in and is taken too, which Arthur's rule allows. 100 m is
-- well clear of the old system's four decimal places (about 11 m) and well
-- short of a stand-in's typical distance (several km).
--
-- The distance is equirectangular, which is ample at these scales and
-- portable (ADR 0001).
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
