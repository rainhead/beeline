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
-- A settled sample (schema/102) is never pending: nothing from a settled
-- season is printed (Peter, 2026-10-14), whether it was minted late from an
-- old observation or had its count raised after the season ended.
--
-- The count is the freeze's definition, not the difference of two totals
-- (beeline-ni5m.13): the freeze fills every open place in 1..count, so what
-- is pending is the places at or below the count that no individuated
-- specimen holds. The two agreed until a count was lowered under an open
-- run — freeze 1..3, raise to 5, freeze 4 and 5, cancel the first run, lower
-- to 4 — where "count minus individuated" said 2 and the freeze minted 3, the
-- open places 1, 2 and 3, and schema/155 promises the Prepare screen and the
-- freeze cannot disagree. A specimen numbered above the count stays
-- individuated and is qc_rule_count_below_printed's to name.
CREATE VIEW pending_print_sample AS
SELECT s.entity_id AS sample_id,
       -- CAST because count() is 64-bit: the app reads this as a plain number.
       CAST(s.specimen_count - coalesce(printed.n, 0) AS INTEGER) AS pending_count
FROM printable_sample p
JOIN sample s ON s.entity_id = p.sample_id
LEFT JOIN (
  SELECT i.sample_id, count(*) AS n
  FROM individuated_specimen i
  JOIN sample held ON held.entity_id = i.sample_id
  WHERE i.specimen_number <= held.specimen_count
  GROUP BY i.sample_id
) printed ON printed.sample_id = s.entity_id
WHERE s.specimen_count > coalesce(printed.n, 0)
  AND NOT EXISTS (SELECT 1 FROM settled_sample st WHERE st.sample_id = s.entity_id);
