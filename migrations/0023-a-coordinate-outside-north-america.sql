-- Migration for schema/050_qc.sql, schema/120_views_qc_rules.sql and
-- schema/130_view_qc_finding.sql (beeline-iwf): a coordinate that cannot be
-- where the record says it is.
--
-- The signature is a pin moved after its place_guess was written.
-- iNaturalist recomputes place_ids and leaves place_guess alone, so such an
-- observation carries an Oregon locality string and an empty place list — an
-- open-ocean point is inside no place. Nothing else in the store notices: a
-- sample's atlas comes from its state_province, never from its point, so the
-- record reads as well placed everywhere except the point itself.
--
-- coordinate_uncertainty already catches one of the four on the dev store,
-- and only by luck: the observation behind sample 122269 carries an accuracy
-- circle of 1,196 km. Two of the other three are a longitude with its sign
-- flipped — 44.1360, +120.7010 and 44.6807, +121.1523, central Oregon written
-- as central Asia — which is as precise as any other pin and which nothing
-- flags today. The fourth is a Portugal coordinate on a USA record.
--
-- Blocking, because a coordinate is exported and a printed specimen is
-- permanent. All four rows already block for other reasons, so nothing that
-- prints today stops printing; what changes is the case where the bad pin
-- carries a plausible accuracy.
--
-- The stack above qc_finding has to come down and go back up unchanged so the
-- union can gain an arm, exactly as in 0018 and 0022.

INSERT INTO qc_rule (name, severity, instructions) VALUES
  ('coordinate_out_of_region', 'blocking',
   'The coordinates on this record are not in North America, but the record says they should be. Usually the pin was moved on the observation after its location text was written, or a longitude lost its minus sign. Check the pin on the iNaturalist observation — if the record really was collected outside North America, set its country to match and ask staff to confirm it.');

DROP VIEW pending_print_sample;
DROP VIEW printable_sample;
DROP VIEW blocking_sample;
DROP VIEW sample_qc_finding;
DROP VIEW qc_finding;

-- The box is deliberately generous: 14..84 N, 172..50 W is Mexico through
-- Alaska and Greenland, plus coastal water. A member collecting in Baja or
-- the Yukon is not a defect, and the atlases' own footprint would be the
-- wrong bound — 144 open-season locations sit outside the western states,
-- which is members travelling.
--
-- The country clause is what stops this being the kind of finding that
-- damages data (beeline-4dt): a record that says NZL and sits in New Zealand
-- is honest, there is no way to satisfy a flag on it, and findings have no
-- accepted state. It is the fifth row outside the box, and the only one this
-- rule does not fire on.
CREATE VIEW qc_rule_coordinate_out_of_region AS
SELECT loc.sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'coordinate_out_of_region' AS rule_name,
       concat(round(loc.latitude, 4), ', ', round(loc.longitude, 4),
              ' is not in North America, but this record says ',
              coalesce(s.country, 'no country at all')) AS details
FROM sample_location loc
JOIN sample s ON s.entity_id = loc.sample_id
WHERE NOT (loc.latitude BETWEEN 14 AND 84 AND loc.longitude BETWEEN -172 AND -50)
  AND (s.country IS NULL OR s.country IN ('USA', 'CAN', 'MEX'));

CREATE VIEW qc_finding AS
SELECT * FROM qc_rule_missing_required_field
UNION ALL SELECT * FROM qc_rule_missing_recommended_field
UNION ALL SELECT * FROM qc_rule_obscured_no_true_coordinates
UNION ALL SELECT * FROM qc_rule_locality_format
UNION ALL SELECT * FROM qc_rule_place_unabbreviated
UNION ALL SELECT * FROM qc_rule_place_unrecognised
UNION ALL SELECT * FROM qc_rule_coordinate_uncertainty
UNION ALL SELECT * FROM qc_rule_coordinate_out_of_region
UNION ALL SELECT * FROM qc_rule_duplicate_sample_number
UNION ALL SELECT * FROM qc_rule_non_tracheophyte_host
UNION ALL SELECT * FROM qc_rule_count_mismatch
UNION ALL SELECT * FROM qc_rule_count_below_printed
UNION ALL SELECT * FROM qc_rule_observation_missing_upstream
UNION ALL SELECT sample_id, CAST(NULL AS INTEGER) AS specimen_id, rule_name, details
FROM sample_promotion_finding;

CREATE VIEW sample_qc_finding AS
SELECT coalesce(f.sample_id, sp.sample_id) AS sample_id,
       f.specimen_id,
       f.rule_name,
       f.details
FROM qc_finding f
LEFT JOIN specimen sp ON sp.entity_id = f.specimen_id;

CREATE VIEW blocking_sample AS
SELECT DISTINCT f.sample_id AS sample_id
FROM sample_qc_finding f
JOIN qc_rule r ON r.name = f.rule_name AND r.severity = 'blocking'
WHERE f.sample_id IS NOT NULL;

CREATE VIEW printable_sample AS
SELECT s.entity_id AS sample_id
FROM sample s
WHERE s.specimen_count > 0
  AND NOT EXISTS (SELECT 1 FROM blocking_sample b WHERE b.sample_id = s.entity_id);

CREATE VIEW pending_print_sample AS
SELECT s.entity_id AS sample_id,
       -- CAST because count() is 64-bit: the app reads this as a plain number.
       CAST(s.specimen_count - coalesce(printed.n, 0) AS INTEGER) AS pending_count
FROM printable_sample p
JOIN sample s ON s.entity_id = p.sample_id
LEFT JOIN (
  SELECT sample_id, count(*) AS n FROM specimen GROUP BY sample_id
) printed ON printed.sample_id = s.entity_id
WHERE s.specimen_count > coalesce(printed.n, 0);
