-- Migration for schema/030 and schema/035 (beeline-1kb.15), after 0060 has
-- dropped the index: empties specimen.occurrence_id and restates the comments
-- that said the freeze minted it.
--
-- The column stays behind. DuckDB cannot drop a column on a table others
-- reference (migrations/README.md), and labels and determinations reference
-- specimen, so a deployed store keeps it, empty and unread, until its next
-- reseed; `db:migrate --check` names it as drift until then, as it does
-- animal.itis_tsn (0058). The UUIDs it held were minted by rehearsal print
-- runs on the sandbox and were never published.

UPDATE specimen SET occurrence_id = NULL WHERE occurrence_id IS NOT NULL;
COMMENT ON COLUMN specimen.occurrence_id IS 'Unused since beeline-1kb.15: Beeline no longer mints an occurrenceID (ADR 0008, second amendment). Left empty because DuckDB cannot drop a column on a referenced table; a reseed removes it.';
COMMENT ON TABLE print_run IS 'One batch act of printing labels (CONTEXT.md, Print run). Preparing it is the freeze: the run creates specimen rows for every pending printable sample in its scope, mints their field numbers (no occurrenceID: the museum database assigns that, ADR 0008), and snapshots each label in printed_label. State is derived from which timestamps are set (print_run_state): prepared → approved → printed → mailed, or canceled while unprinted. Once printed, the samples it covers stop following iNaturalist for date, locality and coordinates (printed_sample).';
