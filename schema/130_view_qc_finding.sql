CREATE VIEW qc_finding AS
SELECT * FROM qc_rule_missing_required_field
UNION ALL SELECT * FROM qc_rule_missing_recommended_field
UNION ALL SELECT * FROM qc_rule_obscured_no_true_coordinates
UNION ALL SELECT * FROM qc_rule_locality_format
UNION ALL SELECT * FROM qc_rule_coordinate_uncertainty
UNION ALL SELECT * FROM qc_rule_duplicate_sample_number
UNION ALL SELECT * FROM qc_rule_count_below_printed;
