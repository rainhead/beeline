-- Migration for schema/177_ecdysis_upload_download.sql (beeline-8dx9.12): the log of downloads of an archive for upload to Ecdysis. The table is new and nothing existing changes.

-- Every download of an archive for upload to Ecdysis (beeline-8dx9.12), written by the app when the download completes.
-- Symbiota replaces a record it matches whole, so an archive made from one read of Ecdysis must be uploaded once: the
-- page refuses a second archive for a collection until the nightly read has run again, and says who took the first
-- and when (src/app/ecdysis-upload.ts, docs/architecture/the-upload-to-ecdysis.md). Rows are written by the app and
-- never changed (ADR 0007), so the table has no foreign keys: DuckDB will not update, or alter, a table another
-- table's key refers to, and nothing here needs it. The person is the signed-in staff member, as a person's id.
CREATE TABLE ecdysis_upload_download (
  entity_id                  INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  collection                 TEXT NOT NULL CHECK (collection <> ''),
  year                       INTEGER NOT NULL,
  filters                    TEXT NOT NULL,
  include_taxon_obscured     BOOLEAN NOT NULL,
  include_observer_obscured  BOOLEAN NOT NULL,
  specimens                  INTEGER NOT NULL CHECK (specimens >= 0),
  read_at                    TIMESTAMP NOT NULL,
  person_id                  INTEGER,
  downloaded_at              TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE ecdysis_upload_download IS 'One download of the archive for upload to an Ecdysis collection, recorded when the stream finished (a download the person abandoned is not recorded, and is not a file that could be uploaded). An archive is refused for a collection when a row here is later than the last successful read of it (read_at is that read''s time, kept so the page can say which read the file rested on), so there is one archive for each read of Ecdysis whatever the year or the filters.';
COMMENT ON COLUMN ecdysis_upload_download.entity_id IS 'A draw from entity_id_seq, not an identity anyone refers to: the order the rows were written in.';
COMMENT ON COLUMN ecdysis_upload_download.collection IS 'The collection by its program''s code, as ECDYSIS_COLLECTIONS names it: WaBA, BC.';
COMMENT ON COLUMN ecdysis_upload_download.year IS 'The collection year of the archive: the calendar year of its samples'' first days.';
COMMENT ON COLUMN ecdysis_upload_download.filters IS 'The Specimens listing filters given in the request, as a query string with its parameters sorted; empty for none.';
COMMENT ON COLUMN ecdysis_upload_download.include_taxon_obscured IS 'The downloader chose to include specimens whose taxon is obscured: their true coordinates are in the file and go public in Ecdysis.';
COMMENT ON COLUMN ecdysis_upload_download.include_observer_obscured IS 'The downloader chose to include specimens whose observer obscured or hid their own observation: their true coordinates are in the file and go public in Ecdysis.';
COMMENT ON COLUMN ecdysis_upload_download.specimens IS 'How many specimens the archive held.';
COMMENT ON COLUMN ecdysis_upload_download.read_at IS 'When the read of Ecdysis the archive rested on began (the cached archive''s read marker), UTC.';
COMMENT ON COLUMN ecdysis_upload_download.person_id IS 'Who downloaded it, a person''s entity_id; null for a staff login that is no person. Not a foreign key, on purpose (see the note above the table).';
COMMENT ON COLUMN ecdysis_upload_download.downloaded_at IS 'When the download finished, UTC.';
