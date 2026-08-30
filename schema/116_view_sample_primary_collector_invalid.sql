-- A sample whose primary collector is not well-defined: no position-1 row in
-- its collector list, or more than one.
--
-- This is what remains of sample_primary_collector_mismatch after
-- beeline-6e9 dropped sample.collector_id. That view's middle arm — a head
-- naming somebody other than the column — policed a denormalisation, and
-- died with it: the fact is now written once, so there is nothing left to
-- disagree. The two arms that survive are about the list itself, and the
-- engine still cannot hold them — the primary key is (sample_id, person_id),
-- so nothing stops two collectors both claiming position 1, and NOT NULL has
-- no way to say "at least one row over there". A sample absent from
-- sample_primary_collector is invisible to "my samples", attribution, and
-- the duplicate-number rule; one present twice fans every join out. Neither
-- failure points at its cause from the outside, which is why this view
-- exists and is asserted empty by test — the same shape as
-- determination_misplaced_qualifier (schema/115) and sample_elevation_stale
-- (schema/170).
--
-- Two writers maintain the invariant today — ingest/promote-legacy.sql and
-- ingest/mint-samples.sql — and the next arrives with collector
-- reassignment, which beeline-6e9's fix makes possible: an UPDATE that
-- retargets person_id keeps the head; a DELETE that removes it does not.
CREATE VIEW sample_primary_collector_invalid AS
SELECT s.entity_id AS sample_id,
       -- CAST because count() is 64-bit, as pending_print_sample does.
       CAST(coalesce(head.n, 0) AS INTEGER) AS at_position_1
FROM sample s
LEFT JOIN (
  SELECT sample_id, count(*) AS n
  FROM sample_collector
  WHERE position = 1
  GROUP BY sample_id
) head ON head.sample_id = s.entity_id
WHERE coalesce(head.n, 0) <> 1;
COMMENT ON VIEW sample_primary_collector_invalid IS 'Samples with no head to their collector list, or two. Exactly one position-1 sample_collector row per sample is the invariant the engine cannot express; asserted empty after each promotion.';
