-- Printability, over samples: the sketch's conjunction collapses into the QC
-- layer — required fields and obscured-without-true-coordinates are themselves
-- blocking rules, so printable = a positive count and no blocking finding on
-- the sample or its specimens. A print run freezes printable samples into
-- specimens.
-- Pending the per-atlas geoprivacy answers (docs/questions.md), taxon-obscured
-- records with true coordinates still print only because no rule yet says
-- otherwise; the per-atlas policy gate lands when the answers do.
CREATE VIEW printable_sample AS
SELECT s.id AS sample_id
FROM sample s
WHERE s.specimen_count > 0
  AND NOT EXISTS (
    SELECT 1 FROM qc_finding f
    JOIN qc_rule r ON r.name = f.rule_name
    WHERE r.severity = 'blocking'
      AND (f.sample_id = s.id
           OR f.specimen_id IN (SELECT sp.id FROM specimen sp WHERE sp.sample_id = s.id))
  );
