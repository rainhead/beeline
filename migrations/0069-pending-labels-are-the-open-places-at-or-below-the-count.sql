-- Migration for schema/150_view_pending_print_sample.sql: the pending count
-- is the freeze's definition (beeline-ni5m.13).
--
-- The freeze fills every open place in 1..count, and the view said "count
-- minus individuated specimens". They agreed until a count was lowered under
-- an open run: freeze 1..3, raise the count to 5, freeze 4 and 5, cancel the
-- first run, lower the count to 4. The view then said 2 labels pending and
-- the next freeze minted 3, for the open places 1, 2 and 3, where schema/155
-- promises the Prepare screen and the freeze read one view and cannot
-- disagree. Found by a property-based test on 2026-10-30. The view now
-- counts only individuated specimens at or below the count; a specimen
-- numbered above it stays individuated and is qc_rule_count_below_printed's
-- to name. print_scope_sample reads this view and needs no change.

CREATE OR REPLACE VIEW pending_print_sample AS
SELECT s.entity_id AS sample_id,
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
