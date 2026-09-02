-- Migration for schema/050_qc.sql, schema/120_views_qc_rules.sql and
-- schema/170_views_elevation.sql: tighten the coordinate precision a label
-- may carry from 250 m to 100 m, for records collected from now on (#22).
--
-- 100 m is the answer and always was — it is the resolution of three decimal
-- places of latitude, which is what a GPS reports. The 250 m that had been in
-- force was a transcription error rather than a decision (Andony,
-- 2026-08-31).
--
-- It cannot be applied backwards, and that is the whole shape of this
-- migration. A volunteer can tighten the pin on their own iNaturalist
-- observation and the next sync picks it up, but only while they still hold
-- the specimens; for older records the bees have often long since left their
-- possession, and blocking those would demand a correction nobody can make.
-- So the threshold becomes a function of when the sample was collected, and
-- records predating the change keep 250 m for good.
--
-- Measured on the deployed store before writing this: of 62,790 printable
-- samples, 314 sit in the 100-250 m band and would be caught by a retroactive
-- rule. Applied forward, it blocks NOTHING today — the newest sample in the
-- store ended 2026-08-31 — so this costs no volunteer a record they could not
-- already fix, which is exactly what was asked for. It begins to bite only as
-- new collecting arrives.
--
-- The stack above qc_finding has to come down and go back up unchanged so the
-- union's arm can be replaced, exactly as in 0018, 0022 and 0023.

UPDATE qc_rule
   SET instructions = 'The location accuracy is worse than this record allows — the flag says by how much, and which limit applied. Records from 2 September 2026 onwards must be within 100 m, the resolution of a GPS reading; for a trap, the day it was emptied is the one that counts. Earlier records keep the 250 m that was in force when they were collected. Improve the pin accuracy on the observation, or ask staff if the uncertainty is genuine.'
 WHERE name = 'coordinate_uncertainty';

DROP VIEW pending_print_sample;
DROP VIEW printable_sample;
DROP VIEW blocking_sample;
DROP VIEW sample_qc_finding;
DROP VIEW qc_finding;
DROP VIEW qc_rule_coordinate_uncertainty;

CREATE VIEW coordinate_precision_rule AS
SELECT 100 AS uncertainty_m,
       250 AS grandfathered_uncertainty_m,
       DATE '2026-09-02' AS effective_from;

CREATE VIEW sample_coordinate_limit AS
SELECT s.entity_id AS sample_id,
       CASE WHEN s.date_end >= r.effective_from
            THEN r.uncertainty_m
            ELSE r.grandfathered_uncertainty_m END AS uncertainty_m
FROM sample s
CROSS JOIN coordinate_precision_rule r;

CREATE VIEW qc_rule_coordinate_uncertainty AS
SELECT loc.sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'coordinate_uncertainty' AS rule_name,
       -- Names the limit that applied, not a constant: two are in force, and
       -- a volunteer reading the flag needs to know which one their record
       -- was held to.
       concat(loc.coordinate_uncertainty_m, ' m > ', lim.uncertainty_m, ' m') AS details
FROM sample_location loc
JOIN sample_coordinate_limit lim ON lim.sample_id = loc.sample_id
WHERE loc.coordinate_uncertainty_m > lim.uncertainty_m;

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
-- Stored ingestion-time findings join the derived ones (schema/050).
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
