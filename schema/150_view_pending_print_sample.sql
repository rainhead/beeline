-- Released settled samples still to be placed (beeline-3vs.7): see the
-- comment on the view. It sits first because pending_print_sample reads it.
CREATE VIEW sample_awaiting_place AS
SELECT s.entity_id AS sample_id
FROM sample s
JOIN settled_sample st ON st.sample_id = s.entity_id
JOIN sample_print_release r ON r.sample_id = s.entity_id
LEFT JOIN (
  SELECT p.sample_id, p.stamped_at
  FROM sample_place_stamped p
  JOIN sample_location l ON l.sample_id = p.sample_id
  WHERE abs(p.latitude - l.latitude) <= 5e-5 AND abs(p.longitude - l.longitude) <= 5e-5
) looked ON looked.sample_id = s.entity_id AND looked.stamped_at >= r.released_at
WHERE (s.inat_observation_id IS NOT NULL OR EXISTS (SELECT 1 FROM sample_entry e WHERE e.sample_id = s.entity_id))
  AND NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)
  AND looked.sample_id IS NULL;
COMMENT ON VIEW sample_awaiting_place IS 'Settled samples staff have released for printing whose county, state and country follow their point (they have an observation, or were entered in Beeline, and no label is on paper) and which the nightly''s county stamp has not looked at since the release, at the sample''s present point (sample_place_stamped, schema/038): they wait here, and are not pending, so no label carries a place typed before the point was read. A released sample that does not follow its point (old records, printed) is never here. A sample with no point is here too, since it cannot print anyway.';

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
-- A settled sample (schema/102) is pending only once staff have released it
-- (sample_print_release, schema/102; Peter, 2026-11-19): trap bottles are
-- pinned years after they were collected, so a sample staff entered, or whose
-- count they set, prints whatever its season. One minted late from an old
-- observation, or whose count only iNaturalist gave, stays out, as every
-- settled sample did from 2026-10-14 (Peter), because nobody pins those. And
-- a released one that follows its point for its county, state and country is
-- not pending until the nightly's county stamp has placed it
-- (sample_awaiting_place, above): a label made before would carry what was
-- typed, and a printed label is permanent.
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
  AND NOT EXISTS (SELECT 1 FROM settled_unreleased_sample st WHERE st.sample_id = s.entity_id)
  AND NOT EXISTS (SELECT 1 FROM sample_awaiting_place w WHERE w.sample_id = s.entity_id);
