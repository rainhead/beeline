-- What a staff-set locality means, stated once (beeline-649).

-- The alarm: an override whose sample does not read it. The applier writes
-- both, and the follow rule skips overridden samples, so this is empty by
-- construction — the same shape as sample_elevation_stale and
-- specimen_field_number_stale, and asserted empty by test for the same
-- reason: an unrefreshed table is not a visibly broken one.
CREATE VIEW sample_locality_override_stale AS
SELECT o.sample_id, o.locality AS override_locality, s.locality AS sample_locality
FROM sample_locality_override o
JOIN sample s ON s.entity_id = o.sample_id
WHERE s.locality IS DISTINCT FROM o.locality;
COMMENT ON VIEW sample_locality_override_stale IS 'Overrides the sample row disagrees with. Empty by construction; a row here means a writer bypassed src/apply-sample-overlay.ts.';

-- The three-way merge's third case (ADR 0004): the observation now yields a
-- locality that is neither what the staffer saw nor what they wrote. The
-- override stands — a deliberate assertion beats an unreviewed upstream edit
-- — and this names the disagreement for the sample page, where staff decide
-- whether the new upstream value changes their mind. An observation that has
-- converged on the override is not here: nothing is in dispute.
CREATE VIEW sample_locality_override_diverged AS
SELECT o.sample_id, o.locality AS override_locality, o.observed_locality, loc.locality AS observation_locality
FROM sample_locality_override o
JOIN sample s ON s.entity_id = o.sample_id
LEFT JOIN observation_locality loc ON loc.inat_id = s.inat_observation_id
WHERE loc.locality IS DISTINCT FROM o.observed_locality
  AND loc.locality IS DISTINCT FROM o.locality;
COMMENT ON VIEW sample_locality_override_diverged IS 'Overrides whose observation has since moved to a third value: the override stands, and /samples/:id shows staff what iNaturalist now says.';

-- The same two statements for coordinates (beeline-942). Stale: the row and
-- the override disagree, or the row's source has stopped saying a person set
-- it. The tolerance is sample_elevation_stale's (schema/170): the reference
-- system's export precision, below which two writes of one point differ
-- only in rounding.
CREATE VIEW sample_location_override_stale AS
SELECT o.sample_id, o.latitude AS override_latitude, o.longitude AS override_longitude,
       loc.latitude AS sample_latitude, loc.longitude AS sample_longitude, loc.source
FROM sample_location_override o
LEFT JOIN sample_location loc ON loc.sample_id = o.sample_id
WHERE loc.sample_id IS NULL
   OR loc.source <> 'staff_entry'
   OR abs(loc.latitude - o.latitude) > 5e-5
   OR abs(loc.longitude - o.longitude) > 5e-5;
COMMENT ON VIEW sample_location_override_stale IS 'Coordinate overrides the sample_location row disagrees with. Empty by construction; a row here means a writer bypassed src/apply-sample-overlay.ts.';

-- Diverged: the observation now yields a point that is neither what the
-- staffer saw nor what they wrote. The override stands; the sample page says
-- what iNaturalist now says. An observation with no believed-true point is
-- not a third value, and one that has converged on the override is not in
-- dispute.
CREATE VIEW sample_location_override_diverged AS
SELECT o.sample_id, o.latitude AS override_latitude, o.longitude AS override_longitude,
       o.observed_latitude, o.observed_longitude,
       ol.latitude AS observation_latitude, ol.longitude AS observation_longitude,
       ol.coordinate_uncertainty_m AS observation_uncertainty_m
FROM sample_location_override o
JOIN sample s ON s.entity_id = o.sample_id
JOIN observation_location ol ON ol.inat_id = s.inat_observation_id
WHERE (abs(ol.latitude - o.latitude) > 5e-5 OR abs(ol.longitude - o.longitude) > 5e-5)
  AND (o.observed_latitude IS NULL
       OR abs(ol.latitude - o.observed_latitude) > 5e-5
       OR abs(ol.longitude - o.observed_longitude) > 5e-5);
COMMENT ON VIEW sample_location_override_diverged IS 'Coordinate overrides whose observation has since moved to a third point: the override stands, and /samples/:id shows staff where iNaturalist now puts it.';

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
