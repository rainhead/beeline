-- Migration for schema/030 (beeline-1kb.15): Beeline no longer mints an
-- occurrenceID. A specimen gets one from the museum database its record
-- reaches, which Symbiota assigns, and every export leaves the field blank
-- until then (ADR 0008, amended 2026-10-23).
--
-- specimen.occurrence_id stays behind. DuckDB cannot drop a column on a table
-- others reference (migrations/README.md), and determinations reference
-- specimen, so a deployed store keeps the column, emptied and unread, until
-- its next reseed; `db:migrate --check` names it as drift until then, as it
-- does animal.itis_tsn (0058). The index goes first, because DuckDB will not
-- update an indexed column on a row a foreign key references
-- (duckdb/duckdb#20246). The UUIDs it held were minted by rehearsal print
-- runs on the sandbox and were never published.

DROP INDEX specimen_occurrence_id_idx;
UPDATE specimen SET occurrence_id = NULL WHERE occurrence_id IS NOT NULL;
COMMENT ON COLUMN specimen.occurrence_id IS 'Unused since beeline-1kb.15: Beeline no longer mints an occurrenceID (ADR 0008, amended 2026-10-23). Left empty because DuckDB cannot drop a column on a referenced table; a reseed removes it.';
