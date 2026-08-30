-- The primary collector of each sample: the head of its sample_collector
-- list. One definition, because "whose sample numbering is this" is asked in
-- five places — minting's reconcile (schema/108), the duplicate-sample-number
-- rule (schema/120), account harvesting and determination attribution
-- (ingest/) — and each growing its own position-1 join is how the last
-- denormalisation started (beeline-daa).
--
-- This view replaced sample.collector_id (beeline-6e9): the column was the
-- same fact written twice, a view existed only to police the copy, and the
-- copy could never be UPDATEd — DuckDB refuses to write an indexed column on
-- a row an incoming foreign key references, and every sample is referenced.
-- Reassigning a collector is now UPDATE sample_collector SET person_id,
-- which works, because nothing references sample_collector.
--
-- Exactly one row per sample is the invariant, not a property of the query:
-- a sample with no position-1 row is absent here, and one with two appears
-- twice. sample_primary_collector_invalid (schema/116) names both states and
-- is asserted empty by test.
CREATE VIEW sample_primary_collector AS
SELECT sample_id, person_id
FROM sample_collector
WHERE position = 1;
COMMENT ON VIEW sample_primary_collector IS 'The head of each sample''s collector list — whose sample numbering it is. The one definition of "primary collector" since sample.collector_id was dropped (beeline-6e9); exactly one row per sample is guarded by sample_primary_collector_invalid.';
