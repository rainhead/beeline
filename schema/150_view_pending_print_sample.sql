-- What is waiting on labels: printable, and not yet frozen into a print
-- run. Specimens are individuated by printing — a run's freeze creates the
-- specimen rows for what it takes (schema/035) — so a sample with fewer
-- individuated specimens (schema/117: a canceled run's do not count) than
-- its working count has that many labels still to come, and a sample a
-- prepared run holds is not pending even though nothing is on paper yet,
-- which is what stops a second run taking it. The same count read from the
-- other direction is qc_rule_count_below_printed. Rows appear here
-- when samples arrive unprinted — minted from iNaturalist, in-app trap entry
-- — or when a count is raised above what was already frozen; the legacy
-- import writes one specimen per historical row, so it contributes none.
-- Membership follows printable_sample, so the waiver clause and the
-- per-atlas geoprivacy policy reach this view without the app knowing. A
-- run with no atlas freezes the subset print_scope_sample names (schema/155).
CREATE VIEW pending_print_sample AS
SELECT s.entity_id AS sample_id,
       -- CAST because count() is 64-bit: the app reads this as a plain number.
       CAST(s.specimen_count - coalesce(printed.n, 0) AS INTEGER) AS pending_count
FROM printable_sample p
JOIN sample s ON s.entity_id = p.sample_id
LEFT JOIN (
  SELECT sample_id, count(*) AS n FROM individuated_specimen GROUP BY sample_id
) printed ON printed.sample_id = s.entity_id
WHERE s.specimen_count > coalesce(printed.n, 0);
