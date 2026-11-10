-- Migration for schema/040_determinations.sql (beeline-t8zv): an expert's own
-- sheet of determinations (src/load-determination-sheet.ts) records its
-- provenance in worksheet_determination too, so the table's comment no longer
-- says volunteer worksheets alone. Nothing else changes: the rows are the
-- same shape, and the channel is the existing 'worksheet_import'.
COMMENT ON TABLE worksheet_determination IS 'Provenance for determinations imported from a sheet: the Drive file, tab and row each one came from, and when that file was last changed. Two loaders write it: the volunteer worksheets (src/load-worksheets.ts), where a later load records a determiner''s entry for a specimen only from a file changed after the one already recorded, and an expert''s own sheet of determinations (src/load-determination-sheet.ts, is_expert true), where the file is one somebody sent and file_modified_at is when they sent it.';
