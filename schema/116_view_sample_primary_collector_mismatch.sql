-- A sample whose primary collector is not the one at the head of its list.
--
-- sample.collector_id and sample_collector position 1 are the same fact
-- written twice: whose numbering the sample follows. schema/030 says so in a
-- COMMENT and then says why it is only a comment — "an invariant promotion
-- maintains, not a constraint the engine can express". It spans two tables
-- and depends on a row's position, so no CHECK reaches it.
--
-- One writer maintains it today — ingest/promote-legacy.sql, and only it —
-- so the invariant is in far less danger than the count of write paths
-- suggests. What it is waiting for is the second: trap-sample entry, which
-- has no interface yet because the staff registry questions are unanswered,
-- and any correction path that lets a collector be added to a sample. Each
-- of those is a new place to forget, and the check is worth having before
-- them rather than after. When it drifts the two sides disagree about whose
-- sample numbering a sample follows, and
-- nothing notices: every view reads one side or the other, never both.
-- qc_rule_duplicate_sample_number groups by collector_id; the listings, the
-- QC home and the record pages read the list. So the disagreement would show
-- as a duplicate that isn't one, or a sample missing from its own collector's
-- "mine", and neither points at the cause (beeline-daa, from the Symbiota
-- archaeology: every denormalisation is a permanent tax on every future write
-- path).
--
-- Hence a view, asserted empty by a test — the same shape as
-- determination_misplaced_qualifier (schema/115) and sample_elevation_stale
-- (schema/170), and for the same reason. Empty on the dev store across 66,294
-- samples when this was written; the point is not that it is dirty but that
-- nothing has been checking.
--
-- Three ways to be wrong, and the count is what separates them:
--   0 — no position-1 row at all, so the list has no head
--   1 — a head that names somebody other than collector_id
--   2+ — two collectors both at position 1, which makes "position 1"
--        ambiguous and the invariant unstatable. The primary key is
--        (sample_id, person_id), so nothing stops it.
-- first_collector is meaningful only where at_position_1 = 1; above that it
-- is one of the contenders, and the count is what a reader should believe.
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
