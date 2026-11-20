-- Migration for schema/010_people_atlases.sql, schema/030_samples_specimens.sql,
-- schema/050_qc.sql, schema/120_views_qc_rules.sql,
-- schema/130_view_qc_finding.sql and schema/155_views_print_run.sql
-- (beeline-pnag): a rare host plant no longer stops a sample's labels
-- printing.
--
-- Peter decided at the taxonomist meeting of 2026-11-20 that the rule
-- taxon_obscured_awaiting_atlas was a mistake. How to handle the coordinates
-- of a rare plant is a question for export, and it must not hold back a
-- sample's labels. He decided the same day that labels and every export carry
-- true coordinates until an atlas says otherwise. Oregon's answer of
-- 2026-10-21 (gh-13) agrees. On production's copy of the store of
-- 2026-11-20 the rule flagged 10 samples from active seasons (all in
-- Washington; 9 already printed, 1 with labels still to come) and 42 from
-- settled seasons.
--
-- This file takes the rule out of the findings and drops the table of the
-- atlases' answers, which nothing reads once the rule is gone. The next file,
-- 0114, deletes the rule's row in qc_rule. They are two because DuckDB will
-- not delete a referenced row in the transaction that removed the rows
-- referencing it, and each migration is one transaction (as 0071 and 0072).
-- No waiver and no stored finding names the rule on production, measured on
-- 2026-11-20, but the deletes below keep a store that has one from failing.

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
  UNION ALL SELECT * FROM qc_rule_staff_hold
  -- Stored ingestion-time findings join the derived ones (schema/050).
  UNION ALL SELECT sample_id, CAST(NULL AS INTEGER) AS specimen_id, rule_name, details
  FROM sample_promotion_finding
) prose
UNION ALL SELECT * FROM qc_rule_non_tracheophyte_host;

DROP VIEW qc_rule_taxon_obscured_awaiting_atlas;

DELETE FROM qc_rule_unwaivable WHERE name = 'taxon_obscured_awaiting_atlas';
DELETE FROM sample_qc_waiver WHERE rule_name = 'taxon_obscured_awaiting_atlas';
DELETE FROM sample_promotion_finding WHERE rule_name = 'taxon_obscured_awaiting_atlas';

DROP TABLE atlas_taxon_obscured_printing;

COMMENT ON COLUMN sample.taxon_geoprivacy IS 'iNat taxon-driven obscuring: in this program, a host plant iNaturalist treats as rare. Labels, and what staff download and send on, carry its true coordinates, and no atlas''s rule withholds them (Peter, 2026-11-20; docs/questions.md).';
COMMENT ON TABLE sample_location IS 'Believed-true coordinates, isolated in their own table: joining them in is a deliberate act, never an accident. Retention of source coordinate pairs (including obscured ones) is unconditional but lives in the staging/observation layer; labels, and what staff download and send on, carry a taxon-obscured record''s true coordinates, and no atlas''s rule withholds them (Peter, 2026-11-20; docs/questions.md).';
COMMENT ON VIEW printable_reprint IS 'The pending reprints a print run can take: those of a specimen with a field number whose sample has no finding from qc_rule_unwaivable (a staff hold, a missing required field, an obscured point without a true one). The rest wait in pending_reprint.';
