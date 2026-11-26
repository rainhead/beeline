-- Migration for schema/050_qc.sql, schema/120_views_qc_rules.sql and
-- schema/130_view_qc_finding.sql (beeline-qu2c): a blocking flag for an
-- unprinted one-day sample whose observation says another day, which the
-- nightly's date follow declined to move. Measured on production's copy of
-- 2026-11-25: no sample is in that state, so the flag raises nothing when
-- this runs.

INSERT INTO qc_rule (name, severity) VALUES ('observation_date_differs', 'blocking');

-- An unprinted sample whose one day is not its observation's (beeline-qu2c).
-- The date follow in ingest/mint-samples.sql moves an unprinted one-day
-- sample onto its observation's date, but declines where the move would
-- collide (a day another sample of the collector holds with the number, two
-- samples moving onto one day, a swap), where the observation is shared with
-- another sample or several observations claim the sample, or where it
-- cannot tell which one sample is meant. Nothing else would say so, and the
-- labels would print a date the volunteer has said is wrong. Blocking, so
-- they wait for staff to set the date (which writes sample_date_override and
-- clears the flag) or for the volunteer to correct the observation's date or
-- number. A sample whose date staff set, one of several days (an observation
-- cannot evidence a range) and a printed one (its date is the label's; not
-- on paper is specimen_on_paper's own test, schema/101, as qc_rule_sample_number
-- asks it) never raise it. Measured on production's copy of 2026-11-25: no
-- sample is in this state, so it raises nothing when deployed.
CREATE OR REPLACE VIEW qc_rule_observation_date_differs AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'observation_date_differs' AS rule_name,
       concat('observation: ', strftime(c.observed_on, '%-d %B %Y'), ' · sample: ', strftime(s.date_start, '%-d %B %Y')) AS details
FROM sample s
JOIN observation_sample_candidate c ON c.inat_id = s.inat_observation_id
WHERE s.date_end = s.date_start
  AND s.date_start <> c.observed_on
  AND NOT EXISTS (SELECT 1 FROM sample_date_override d WHERE d.sample_id = s.entity_id)
  AND NOT EXISTS (SELECT 1 FROM specimen_on_paper p WHERE p.sample_id = s.entity_id);
COMMENT ON VIEW qc_rule_observation_date_differs IS 'An unprinted sample of one day whose observation says another day, and whose date staff have not set: the date follow in ingest/mint-samples.sql declined to move it (a collision, a shared observation, several observations claiming it), so its labels would print a date the volunteer has said is wrong. Blocking (beeline-qu2c).';

CREATE OR REPLACE VIEW qc_finding AS
SELECT sample_id, specimen_id, rule_name, details,
       CAST(NULL AS TEXT) AS detail_taxon_name,
       CAST(NULL AS TEXT) AS detail_taxon_rank
FROM (
  SELECT * FROM qc_rule_missing_required_field
  UNION ALL SELECT * FROM qc_rule_missing_recommended_field
  UNION ALL SELECT * FROM qc_rule_obscured_no_true_coordinates
  UNION ALL SELECT * FROM qc_rule_locality_format
  UNION ALL SELECT * FROM qc_rule_place_unabbreviated
  UNION ALL SELECT * FROM qc_rule_place_unrecognised
  UNION ALL SELECT * FROM qc_rule_coordinate_uncertainty
  UNION ALL SELECT * FROM qc_rule_coordinate_out_of_region
  UNION ALL SELECT * FROM qc_rule_sample_number
  UNION ALL SELECT * FROM qc_rule_count_mismatch
  UNION ALL SELECT * FROM qc_rule_count_below_printed
  UNION ALL SELECT * FROM qc_rule_observation_missing_upstream
  UNION ALL SELECT * FROM qc_rule_observation_date_differs
  UNION ALL SELECT * FROM qc_rule_staff_hold
  -- Stored ingestion-time findings join the derived ones (schema/050).
  UNION ALL SELECT sample_id, CAST(NULL AS INTEGER) AS specimen_id, rule_name, details
  FROM sample_promotion_finding
) prose
UNION ALL SELECT * FROM qc_rule_non_tracheophyte_host;
