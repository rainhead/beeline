-- Migration for schema/130_view_qc_finding.sql and
-- schema/140_views_printability.sql (beeline-2c3.29).
-- The listings' flag chips rolled up sample-keyed findings only, while
-- blocking_sample counted both routes — two definitions of one idea, which
-- agree only while no specimen-level rule exists. sample_qc_finding becomes
-- the single roll-up both read. Resolving the two routes with a LEFT JOIN
-- rather than a UNION also scans the qc_finding union once instead of twice:
-- printability over the sandbox's 66k samples went 1.1s -> 0.5s.

DROP VIEW pending_print_sample;
DROP VIEW printable_sample;
DROP VIEW blocking_sample;

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
       CAST(s.specimen_count - coalesce(printed.n, 0) AS INTEGER) AS pending_count
FROM printable_sample p
JOIN sample s ON s.entity_id = p.sample_id
LEFT JOIN (
  SELECT sample_id, count(*) AS n FROM specimen GROUP BY sample_id
) printed ON printed.sample_id = s.entity_id
WHERE s.specimen_count > coalesce(printed.n, 0);
