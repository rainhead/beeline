-- Migration for schema/120_views_qc_rules.sql: count_mismatch also names an
-- observation whose count is not a number at all (beeline-ni5m.1).
--
-- An unprinted sample's count now follows its observation on every
-- promotion (ingest/mint-samples.sql), but only while the observation
-- carries a positive whole number. One whose count went to 'lots' was left
-- on its old count, and the rule, which compared only counts that cast,
-- said nothing, so the sample would have printed that count without a word.
-- The rule now fires on any non-blank count the sample has not taken, and
-- says which kind it was. The ingest change needs no migration: promotion
-- reads the file.

CREATE OR REPLACE VIEW qc_rule_count_mismatch AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'count_mismatch' AS rule_name,
       CASE WHEN try_cast(f.specimen_count_raw AS INTEGER) IS NULL
            THEN concat('observation says ''', f.specimen_count_raw, ''', which is not a count, but sample count is ', s.specimen_count)
            ELSE concat('observation says ', f.specimen_count_raw, ' but sample count is ', s.specimen_count) END AS details
FROM sample s
JOIN observation_field f ON f.inat_id = s.inat_observation_id
WHERE nullif(trim(f.specimen_count_raw), '') IS NOT NULL
  AND try_cast(f.specimen_count_raw AS INTEGER) IS DISTINCT FROM s.specimen_count;
