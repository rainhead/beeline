-- Printability, over samples: the sketch's conjunction collapses into the QC
-- layer — required fields and obscured-without-true-coordinates are themselves
-- blocking rules, so printable = a positive count and no blocking finding on
-- the sample or its specimens. A print run freezes printable samples into
-- specimens.
-- Pending the per-atlas geoprivacy answers (docs/questions.md), taxon-obscured
-- records with true coordinates still print only because no rule yet says
-- otherwise; the per-atlas policy gate lands when the answers do.

-- Which samples a blocking finding lands on. Both routes a finding can take
-- are already resolved by sample_qc_finding (schema/130), so this is one key
-- the planner can hash-anti-join against — the point of beeline-2c3.22, where
-- an OR over two different keys inside printability's NOT EXISTS refused to
-- decorrelate and cost eleven seconds on the flagship page.
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
