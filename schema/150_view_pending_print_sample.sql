-- What is waiting on labels: printable, and not yet printed. Until print runs
-- exist (beeline-1kb.2) the proof of printing is the specimen row itself —
-- specimens are individuated by printing, so a sample with fewer specimen rows
-- than its working count has that many labels still to come. This is the same
-- proxy qc_rule_count_below_printed reads from the other direction. Legacy
-- promotion writes one specimen per historical row (production is essentially
-- all printed); iNat promotion writes only the count, so everything synced is
-- pending here.
-- Membership follows printable_sample, so the waiver clause and the per-atlas
-- geoprivacy policy reach this view without the app knowing.
CREATE VIEW pending_print_sample AS
SELECT s.entity_id AS sample_id,
       -- CAST because count() is 64-bit: the app reads this as a plain number.
       CAST(s.specimen_count - coalesce(printed.n, 0) AS INTEGER) AS pending_count
FROM printable_sample p
JOIN sample s ON s.entity_id = p.sample_id
LEFT JOIN (
  SELECT sample_id, count(*) AS n FROM specimen GROUP BY sample_id
) printed ON printed.sample_id = s.entity_id
WHERE s.specimen_count > coalesce(printed.n, 0);
