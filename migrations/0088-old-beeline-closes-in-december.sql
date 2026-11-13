-- Migration for schema/035_print_runs.sql (beeline-4vwu): the old Beeline
-- closes at the end of December 2026, not in February 2027, so the table's
-- comment says so.

COMMENT ON TABLE legacy_copy IS 'A specimen printed by Beeline as last copied into the old Beeline''s master list, so volunteers can enter determinations for it there until the end of December 2026 (beeline-83b8.18, src/legacy-copy.ts). One row per specimen, written only once the old system has been read back and holds what was sent. The old record''s id is not a column because it is derived: beeline-specimen- followed by specimen_id, which is how beeline-c43w tells a record that started here from one the old system made.';
