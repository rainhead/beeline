CREATE VIEW qc_finding AS
SELECT * FROM qc_rule_missing_required_field
UNION ALL SELECT * FROM qc_rule_missing_recommended_field
UNION ALL SELECT * FROM qc_rule_obscured_no_true_coordinates
UNION ALL SELECT * FROM qc_rule_locality_format
UNION ALL SELECT * FROM qc_rule_place_unabbreviated
UNION ALL SELECT * FROM qc_rule_coordinate_uncertainty
UNION ALL SELECT * FROM qc_rule_duplicate_sample_number
UNION ALL SELECT * FROM qc_rule_non_tracheophyte_host
UNION ALL SELECT * FROM qc_rule_count_mismatch
UNION ALL SELECT * FROM qc_rule_count_below_printed
UNION ALL SELECT * FROM qc_rule_observation_missing_upstream
-- Stored ingestion-time findings join the derived ones (schema/050).
UNION ALL SELECT sample_id, CAST(NULL AS INTEGER) AS specimen_id, rule_name, details
FROM sample_promotion_finding;

-- The same findings, keyed to the sample each one belongs to, by both routes a
-- finding can take: keyed to the sample itself, or to one of its specimens.
-- Everything that asks "what is wrong with this sample" — printability
-- (schema/140) and the listings' flag chips (src/app/listings.ts) — reads this,
-- so there is one definition of the roll-up rather than one per caller
-- (beeline-2c3.29). The LEFT JOIN, rather than a UNION of the two routes,
-- scans the qc_finding union once instead of twice: half the work of the shape
-- it replaces, on a view that already costs most of a second (beeline-2c3.23).
CREATE VIEW sample_qc_finding AS
SELECT coalesce(f.sample_id, sp.sample_id) AS sample_id,
       f.specimen_id,
       f.rule_name,
       f.details
FROM qc_finding f
LEFT JOIN specimen sp ON sp.entity_id = f.specimen_id;
