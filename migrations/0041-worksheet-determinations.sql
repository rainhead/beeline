-- Migration for schema/040_determinations.sql (beeline-pbk): the provenance
-- table for determinations imported from volunteer worksheets.
--
-- The new channel value, 'worksheet_import', is NOT here and cannot be:
-- DuckDB can neither add nor replace a CHECK on an existing table (ADR 0006),
-- and determination is referenced, so it cannot be rebuilt either. A deployed
-- store keeps rejecting the value until it is reseeded; the loader checks the
-- constraint before it reads a single file and says so, rather than failing
-- on its first INSERT.
CREATE TABLE worksheet_determination (
  determination_id INTEGER PRIMARY KEY REFERENCES determination(entity_id),
  file_id          TEXT NOT NULL,
  file_name        TEXT NOT NULL,
  file_modified_at TIMESTAMPTZ NOT NULL,
  sheet            TEXT NOT NULL,
  row_number       INTEGER NOT NULL,
  loaded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE worksheet_determination IS 'Provenance for determinations imported from volunteer worksheets: the Drive file, tab and row each one came from, and when that file was last changed. A later load records a determiner''s entry for a specimen only from a file changed after the one already recorded.';
COMMENT ON COLUMN worksheet_determination.file_id IS 'The Google Drive file id — stable across renames, unlike file_name.';
COMMENT ON COLUMN worksheet_determination.file_name IS 'The file''s title when it was loaded, for a person looking for it in Drive.';
COMMENT ON COLUMN worksheet_determination.file_modified_at IS 'Drive''s modifiedTime for the version loaded: an upper bound on when the entry was made, and what orders one determiner''s copies.';
COMMENT ON COLUMN worksheet_determination.row_number IS 'The spreadsheet row, 1-based as the sheet numbers it.';
