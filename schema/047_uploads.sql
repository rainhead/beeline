-- Files people upload (beeline-kgyd): an edited copy of the specimens
-- download, which Beeline compares with what it says now. The bytes are kept
-- on disk (config uploadsDir, one folder per upload), not here: a file of up
-- to 20 MB would swell the store and every backup of it. This row says whose
-- file it is, when it came, and what it hashed to, so that the copy on disk
-- can be told from another.
--
-- An entity (ADR 0002): later slices record what an upload changed and point
-- at it. No row is ever updated.

CREATE TABLE upload (
  entity_id   INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  uploaded_by INTEGER NOT NULL REFERENCES person(entity_id),
  uploaded_at TIMESTAMPTZ NOT NULL,
  file_name   TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  byte_size   INTEGER NOT NULL,
  row_count   INTEGER NOT NULL,
  reference   TEXT
);
COMMENT ON TABLE upload IS 'A file somebody uploaded to be compared with what Beeline says: an edited copy of the specimens download. The bytes are kept on disk under the uploads directory, in a folder named for the upload''s id; this row never changes.';
COMMENT ON COLUMN upload.uploaded_by IS 'The person who was signed in when the file was uploaded.';
COMMENT ON COLUMN upload.uploaded_at IS 'When the file arrived.';
COMMENT ON COLUMN upload.file_name IS 'The name the file had on the uploader''s computer, as sent. The copy on disk is named from it, reduced to a safe base name.';
COMMENT ON COLUMN upload.sha256 IS 'The hash of the file''s bytes, so the copy on disk can be checked against what arrived.';
COMMENT ON COLUMN upload.byte_size IS 'The file''s size in bytes.';
COMMENT ON COLUMN upload.row_count IS 'How many data rows the file holds, the header row not counted.';
COMMENT ON COLUMN upload.reference IS 'The request behind the file, so a change can be traced to who asked for it: an email''s message id or an issue link. Never an address or a name.';
