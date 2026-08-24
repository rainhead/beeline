-- Migration for schema/140_view_printable_sample.sql (beeline-2c3.22).
-- Same membership, different shape: printability's correlated NOT EXISTS
-- tested sample-keyed and specimen-keyed findings with an OR, which does not
-- decorrelate — 11 seconds over 66k samples, and every read of
-- pending_print_sample and the QC home paid it. The two routes become a
-- UNION the planner can hash-anti-join.

DROP VIEW pending_print_sample;
DROP VIEW printable_sample;

CREATE VIEW blocking_sample AS
SELECT f.sample_id AS sample_id
FROM qc_finding f
JOIN qc_rule r ON r.name = f.rule_name AND r.severity = 'blocking'
WHERE f.sample_id IS NOT NULL
UNION
SELECT sp.sample_id
FROM qc_finding f
JOIN qc_rule r ON r.name = f.rule_name AND r.severity = 'blocking'
JOIN specimen sp ON sp.entity_id = f.specimen_id;

CREATE VIEW printable_sample AS
SELECT s.entity_id AS sample_id
FROM sample s
WHERE s.specimen_count > 0
  AND NOT EXISTS (SELECT 1 FROM blocking_sample b WHERE b.sample_id = s.entity_id);

CREATE VIEW pending_print_sample AS
SELECT s.entity_id AS sample_id,
       CAST(s.specimen_count - coalesce(printed.n, 0) AS INTEGER) AS pending_count
FROM printable_sample p
JOIN sample s ON s.entity_id = p.sample_id
LEFT JOIN (
  SELECT sample_id, count(*) AS n FROM specimen GROUP BY sample_id
) printed ON printed.sample_id = s.entity_id
WHERE s.specimen_count > coalesce(printed.n, 0);
