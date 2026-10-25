-- Migration for schema/030 (beeline-1kb.15): Beeline no longer mints an
-- occurrenceID. A specimen gets one from the museum database its record
-- reaches, which Symbiota assigns, and every export leaves the field blank
-- until then (ADR 0008, second amendment).
--
-- This drops the column's unique index and nothing else; 0061 empties the
-- column. The two cannot share a migration, because each migration runs in
-- one transaction and DuckDB still treats the column as indexed until the
-- DROP INDEX commits, so the UPDATE in the same transaction fails on every
-- specimen a label or a determination references (duckdb/duckdb#20246).

DROP INDEX specimen_occurrence_id_idx;
