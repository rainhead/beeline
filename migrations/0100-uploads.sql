-- Migration for schema/047: files people upload to be compared with what
-- Beeline says (beeline-kgyd). The table starts empty.

CREATE TABLE upload (
  entity_id   INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  uploaded_by INTEGER NOT NULL REFERENCES person(entity_id),
  uploaded_at TIMESTAMPTZ NOT NULL,
  file_name   TEXT NOT NULL,
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_size   INTEGER NOT NULL CHECK (byte_size > 0),
  row_count   INTEGER NOT NULL CHECK (row_count > 0),
  reference   TEXT
);
COMMENT ON TABLE upload IS 'A file somebody uploaded to be compared with what Beeline says: an edited copy of the specimens download. The bytes are kept on disk as upload.xlsx in a folder named for the upload''s id under the uploads directory; this row never changes. The CHECKs are here because a deployed store can never gain one (ADR 0006): a file is never empty, holds a row, and its hash is 64 hex digits.';
COMMENT ON COLUMN upload.uploaded_by IS 'The person who was signed in when the file was uploaded.';
COMMENT ON COLUMN upload.uploaded_at IS 'When the file arrived.';
COMMENT ON COLUMN upload.file_name IS 'The name the file had on the uploader''s computer, as sent. The copy on disk is always named upload.xlsx, so this name never reaches the file system.';
COMMENT ON COLUMN upload.sha256 IS 'The hash of the file''s bytes, so the copy on disk can be checked against what arrived.';
COMMENT ON COLUMN upload.byte_size IS 'The file''s size in bytes.';
COMMENT ON COLUMN upload.row_count IS 'How many data rows the file holds, the header row not counted.';
COMMENT ON COLUMN upload.reference IS 'The request behind the file, so a change can be traced to who asked for it: an email''s message id or an issue link. Never an address or a name.';
