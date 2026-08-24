-- Printability, over samples: the sketch's conjunction collapses into the QC
-- layer — required fields and obscured-without-true-coordinates are themselves
-- blocking rules, so printable = a positive count and no blocking finding on
-- the sample or its specimens. A print run freezes printable samples into
-- specimens.
-- Pending the per-atlas geoprivacy answers (docs/questions.md), taxon-obscured
-- records with true coordinates still print only because no rule yet says
-- otherwise; the per-atlas policy gate lands when the answers do.

-- Which samples a blocking finding lands on, by both routes a finding can
-- take: keyed to the sample itself, or to one of its specimens. Written as a
-- UNION rather than as an OR inside printability's NOT EXISTS, because a
-- correlated OR over two different keys does not decorrelate — it degrades
-- into a scan of every finding per sample, and at 66k samples that was eleven
-- seconds on the flagship page (beeline-2c3.22).
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
