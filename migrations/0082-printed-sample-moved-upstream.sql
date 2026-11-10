-- Migration for schema/175_views_locality_override.sql (beeline-1kb.17.1):
-- samples Beeline printed whose observation has since moved more than 100 m.

-- A printed sample whose observation now puts it somewhere else (beeline-1kb.17.1,
-- GitHub #298). Once labels print, the point stops following iNaturalist, so
-- a volunteer who moves the pin afterwards leaves the record agreeing with a
-- label that may be wrong. Usually the move is a fix: sample 797063 printed
-- in Nevada County, California, because the pin was dropped on the wrong
-- "Wolf Mountain", and was moved to Lane County, Oregon four days later.
-- Only staff can say which side is right, so this is not a QC flag; it is
-- what the sample page offers staff "Use iNaturalist's location" from.
--
-- 100 m, not a comparison of digits: it is what the label's three decimal
-- places resolve (Andony, GitHub #22), and a move of a few metres across a
-- rounding boundary changes nothing anyone would reprint for. A sample whose
-- point staff have set is not here: sample_location_override_diverged says
-- where its observation has gone. power(), not pow(), so the haversine is
-- the same text in Postgres (ADR 0001).
--
-- Only samples Beeline printed a label for. On the store of 2026-11-10 the
-- same test over every printed sample found 542 more, every one a point
-- imported from the old Beeline, a median 3 km from its observation and
-- some an ocean away (sample 113085's observation is in China): those say
-- the old system held a different point, or linked the wrong observation,
-- not that a volunteer moved a pin, and one click is the wrong tool for them.
-- They are beeline-1kb.17's to show.
--
-- The country, state and county of the new point are not columns: they come
-- from observation_place, which works out every observation's place before
-- it narrows to one, and joined here it cost every printed sample's page
-- 140 ms on a workstation to find, almost always, nothing. Whoever finds a
-- row reads observation_place for that one observation.
CREATE VIEW sample_location_label_diverged AS
SELECT d.*
FROM (
  SELECT s.entity_id AS sample_id,
         loc.latitude, loc.longitude,
         ol.latitude AS observation_latitude, ol.longitude AS observation_longitude,
         ol.coordinate_uncertainty_m AS observation_uncertainty_m,
         2 * 6371000 * asin(sqrt(
           power(sin(radians(ol.latitude - loc.latitude) / 2), 2)
           + cos(radians(loc.latitude)) * cos(radians(ol.latitude))
             * power(sin(radians(ol.longitude - loc.longitude) / 2), 2))) AS distance_m
  FROM sample s
  JOIN sample_location loc ON loc.sample_id = s.entity_id
  JOIN observation_location ol ON ol.inat_id = s.inat_observation_id
  WHERE EXISTS (SELECT 1 FROM specimen sp
                JOIN specimen_label sl ON sl.specimen_id = sp.entity_id
                WHERE sp.sample_id = s.entity_id AND sl.printed_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM sample_location_override o WHERE o.sample_id = s.entity_id)
) d
WHERE d.distance_m > 100;
COMMENT ON VIEW sample_location_label_diverged IS 'Samples Beeline has printed a label for, with no staff-set point, whose observation now puts them more than 100 m from where the sample (and so its labels) says: where iNaturalist puts it now (observation_place has the country, state and county). /samples/:id offers staff the observation''s location from here (beeline-1kb.17.1).';
