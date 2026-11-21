-- Every download of an archive for upload to Ecdysis (beeline-8dx9.12), and which specimens it held. Symbiota replaces a
-- record it matches whole, so an archive made from one read of Ecdysis must be uploaded once: the page refuses a
-- second archive for a collection until the nightly read has run again, and says who took the first and when
-- (src/app/ecdysis-upload.ts, docs/architecture/the-upload-to-ecdysis.md).
--
-- Rows are never updated (ADR 0007), so a download is three kinds of row: one when it starts, written in the same
-- transaction that decides it may start; one when its last byte has been written, with the number of specimens
-- actually written; and one for each specimen that archive held, which is what the associations file is built from.
-- A download that was abandoned or failed has the first row only. None of them has a foreign key: DuckDB will not
-- update, or alter, a table another table's key refers to, and a key to specimen would stop specimens being edited.
CREATE TABLE ecdysis_upload_download (
  entity_id                  INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  collection                 TEXT NOT NULL CHECK (collection <> ''),
  year                       INTEGER NOT NULL,
  filters                    TEXT NOT NULL,
  include_taxon_obscured     BOOLEAN NOT NULL,
  include_observer_obscured  BOOLEAN NOT NULL,
  planned_specimens          INTEGER NOT NULL CHECK (planned_specimens >= 0),
  read_at                    TIMESTAMP NOT NULL,
  person_id                  INTEGER,
  started_at                 TIMESTAMP NOT NULL DEFAULT current_timestamp,
  UNIQUE (collection, read_at)
);
COMMENT ON TABLE ecdysis_upload_download IS 'The start of a download of the archive for upload to an Ecdysis collection, written before its first byte. A download is an identity because the associations file is asked for by its id and its specimens refer to it. An archive is refused for a collection when a row here is later than the last successful read of it began, so there is one archive for each read of Ecdysis whatever the year or the filters. UNIQUE (collection, read_at) is what makes that hold when two requests arrive together: DuckDB takes snapshots and does not stop two transactions that each saw no download from both writing one, but it does refuse the second row with the same key.';
COMMENT ON COLUMN ecdysis_upload_download.entity_id IS 'The download''s identity, drawn from entity_id_seq (ADR 0002).';
COMMENT ON COLUMN ecdysis_upload_download.collection IS 'The collection by its program''s code, as ECDYSIS_COLLECTIONS names it: BC.';
COMMENT ON COLUMN ecdysis_upload_download.year IS 'The collection year of the archive: the calendar year of its samples'' first days.';
COMMENT ON COLUMN ecdysis_upload_download.filters IS 'The Specimens listing filters given in the request, as a query string with its parameters sorted; empty for none.';
COMMENT ON COLUMN ecdysis_upload_download.include_taxon_obscured IS 'The downloader chose to include specimens whose taxon is obscured: their true coordinates are in the file and go public in Ecdysis.';
COMMENT ON COLUMN ecdysis_upload_download.include_observer_obscured IS 'The downloader chose to include specimens whose observer obscured or hid their own observation: their true coordinates are in the file and go public in Ecdysis.';
COMMENT ON COLUMN ecdysis_upload_download.planned_specimens IS 'How many specimens the plan said the archive would hold. What it did hold is in ecdysis_upload_download_completed, since each page is checked again as it is written.';
COMMENT ON COLUMN ecdysis_upload_download.read_at IS 'When the read of Ecdysis the archive rested on began (the cached archive''s read marker), UTC.';
COMMENT ON COLUMN ecdysis_upload_download.person_id IS 'Who downloaded it, a person''s entity_id; null for a staff login that is no person. Not a foreign key, on purpose (see the note above the tables).';
COMMENT ON COLUMN ecdysis_upload_download.started_at IS 'When the download began, UTC. A download with no completion that began less than 15 minutes ago is shown as being written; an older one is shown as unfinished. Both block a second archive until the next read.';

CREATE TABLE ecdysis_upload_download_completed (
  download_id   INTEGER PRIMARY KEY,
  specimens     INTEGER NOT NULL CHECK (specimens >= 0),
  completed_at  TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE ecdysis_upload_download_completed IS 'The end of a download: its last byte was written by the server (the browser may still have been receiving it). A facet of ecdysis_upload_download, keyed by its id, written once. A download that was cancelled or failed has no row here, and no archive that could be uploaded.';
COMMENT ON COLUMN ecdysis_upload_download_completed.download_id IS 'The download this completes, an ecdysis_upload_download.entity_id. Not a foreign key, on purpose.';
COMMENT ON COLUMN ecdysis_upload_download_completed.specimens IS 'How many specimens the archive actually held, which is the rows of ecdysis_upload_download_specimen.';
COMMENT ON COLUMN ecdysis_upload_download_completed.completed_at IS 'When the last byte was written, UTC.';

CREATE TABLE ecdysis_upload_download_specimen (
  download_id  INTEGER NOT NULL,
  specimen_id  INTEGER NOT NULL,
  PRIMARY KEY (download_id, specimen_id)
);
COMMENT ON TABLE ecdysis_upload_download_specimen IS 'The specimens a completed download held, written with its completion: what the associations file for that archive is built from, and how the page tells whether Ecdysis holds them yet. About 8,000 rows for an upload.';
COMMENT ON COLUMN ecdysis_upload_download_specimen.download_id IS 'An ecdysis_upload_download.entity_id. Not a foreign key, on purpose.';
COMMENT ON COLUMN ecdysis_upload_download_specimen.specimen_id IS 'A specimen''s entity_id. Not a foreign key: one would stop the specimen being edited.';
