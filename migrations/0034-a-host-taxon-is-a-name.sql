-- Migration for schema/120_views_qc_rules.sql and schema/130_view_qc_finding.sql
-- (beeline-dys): the one QC rule whose detail is a scientific name now reports
-- it as one.
--
-- `qc_rule_non_tracheophyte_host` spelled the host taxon into its prose
-- details, and both screens that render a finding put details inside a
-- <code> — so Homo sapiens, Andrena and Apis mellifera reached a volunteer
-- dressed as machine values, upright and monospaced, which /design/type and
-- /design/names both forbid. No view could do better, because a string cannot
-- say which of Homo sapiens and Insecta takes italics; only the rank can.
--
-- So the rule reports detail_taxon_name and detail_taxon_rank, the union
-- carries them NULL for every other rule, and FindingDetail renders a taxon
-- through TaxonName. `details` stays the fallback for the case where the
-- projection has a taxon id and no name.
--
-- Views only: nothing stored changes, and the findings themselves are
-- unaffected in number or in which samples they block.
DROP VIEW sample_qc_finding;
DROP VIEW qc_finding;
DROP VIEW qc_rule_non_tracheophyte_host;

CREATE VIEW qc_rule_non_tracheophyte_host AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'non_tracheophyte_host' AS rule_name,
       CASE WHEN f.host_taxon_name IS NULL
            THEN concat('observation taxon ', CAST(f.host_taxon_id AS TEXT), ' is not a vascular plant')
       END AS details,
       f.host_taxon_name AS detail_taxon_name,
       f.host_taxon_rank AS detail_taxon_rank
FROM sample s
JOIN observation_field f ON f.inat_id = s.inat_observation_id
WHERE f.host_is_tracheophyte IS FALSE;

CREATE VIEW qc_finding AS
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
  UNION ALL SELECT * FROM qc_rule_duplicate_sample_number
  UNION ALL SELECT * FROM qc_rule_count_mismatch
  UNION ALL SELECT * FROM qc_rule_count_below_printed
  UNION ALL SELECT * FROM qc_rule_observation_missing_upstream
  UNION ALL SELECT sample_id, CAST(NULL AS INTEGER) AS specimen_id, rule_name, details
  FROM sample_promotion_finding
) prose
UNION ALL SELECT * FROM qc_rule_non_tracheophyte_host;

CREATE VIEW sample_qc_finding AS
SELECT coalesce(f.sample_id, sp.sample_id) AS sample_id,
       f.specimen_id,
       f.rule_name,
       f.details,
       f.detail_taxon_name,
       f.detail_taxon_rank
FROM qc_finding f
LEFT JOIN specimen sp ON sp.entity_id = f.specimen_id;
