-- Migration for schema/116_view_sample_primary_collector_mismatch.sql
-- (beeline-daa): name the invariant that sample.collector_id is the person at
-- position 1 of sample_collector, so something can check it.
--
-- Additive — one view, no existing object touched. Empty on the dev store
-- across all 66,294 samples when this was written, and the point is not that
-- it is dirty but that nothing had been checking: the rule spans two tables
-- and depends on a row's position, so no CHECK reaches it, and schema/030 has
-- only ever been able to state it in a COMMENT.
CREATE VIEW sample_primary_collector_mismatch AS
SELECT s.entity_id AS sample_id,
       s.collector_id,
       -- CAST because count() is 64-bit, as pending_print_sample does.
       CAST(coalesce(head.n, 0) AS INTEGER) AS at_position_1,
       head.person_id AS first_collector
FROM sample s
LEFT JOIN (
  SELECT sample_id, count(*) AS n, min(person_id) AS person_id
  FROM sample_collector
  WHERE position = 1
  GROUP BY sample_id
) head ON head.sample_id = s.entity_id
WHERE coalesce(head.n, 0) <> 1
   OR head.person_id <> s.collector_id;
