-- Files people upload (beeline-kgyd): an edited copy of the specimens
-- download, which Beeline compares with what it says now. The bytes are kept
-- on disk (config uploadsDir, one folder per upload), not here: a file of up
-- to 20 MB would swell the store and every backup of it. A second copy is kept
-- in the Drive folder of received files (beeline-kgyd.1), where a store put
-- back from a backup can still find it. This row says whose file it is, when
-- it came, what it hashed to, so that the copy on disk can be told from
-- another, and where the copy in Drive is.
--
-- An entity (ADR 0002): later slices record what an upload changed and point
-- at it. No row is ever updated.

CREATE TABLE upload (
  entity_id   INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  uploaded_by INTEGER NOT NULL REFERENCES person(entity_id),
  uploaded_at TIMESTAMPTZ NOT NULL,
  file_name   TEXT NOT NULL,
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_size   INTEGER NOT NULL CHECK (byte_size > 0),
  row_count   INTEGER NOT NULL CHECK (row_count > 0),
  reference   TEXT,
  drive_file_id TEXT
);
COMMENT ON TABLE upload IS 'A file somebody uploaded to be compared with what Beeline says: an edited copy of the specimens download. The bytes are kept on disk as upload.xlsx in a folder named for the upload''s id under the uploads directory, and a copy in the Drive folder of received files (drive_file_id); this row never changes. The CHECKs are here because a deployed store can never gain one (ADR 0006): a file is never empty, holds a row, and its hash is 64 hex digits.';
COMMENT ON COLUMN upload.uploaded_by IS 'The person who was signed in when the file was uploaded.';
COMMENT ON COLUMN upload.uploaded_at IS 'When the file arrived.';
COMMENT ON COLUMN upload.file_name IS 'The name the file had on the uploader''s computer, as sent. The copy on disk is always named upload.xlsx, so this name never reaches the file system.';
COMMENT ON COLUMN upload.sha256 IS 'The hash of the file''s bytes, so the copy on disk can be checked against what arrived.';
COMMENT ON COLUMN upload.byte_size IS 'The file''s size in bytes.';
COMMENT ON COLUMN upload.row_count IS 'How many data rows the file holds, the header row not counted.';
COMMENT ON COLUMN upload.drive_file_id IS 'The Drive id of the copy kept in the "Beeline received files" folder (RECEIVED_FOLDER in src/received-files.ts), stored as the file arrived and before this row was written. NULL where the app keeps no copy in Drive (a workstation or a test, which have no key) and for uploads made before 2026-11-18.';
COMMENT ON COLUMN upload.reference IS 'The request behind the file, so a change can be traced to who asked for it: an email''s message id or an issue link. Never an address or a name.';

-- An upload whose changes were taken up (beeline-kgyd.7, beeline-kgyd.4.10):
-- a volunteer's identifications saved as drafts on Identify specimens, which
-- the overnight job commits; or staff's samples file, whose new rows are
-- queued to become trap samples. One row per upload, written in the same
-- transaction as the drafts or the queued rows, so the key is what stops two
-- submissions of one preview both applying.
CREATE TABLE upload_applied (
  upload_id   INTEGER PRIMARY KEY REFERENCES upload(entity_id),
  applied_by  INTEGER NOT NULL REFERENCES person(entity_id),
  applied_at  TIMESTAMPTZ NOT NULL,
  draft_count INTEGER NOT NULL CHECK (draft_count >= 0)
);
COMMENT ON TABLE upload_applied IS 'An upload whose changes were taken up. For a volunteer''s file: its identifications written as drafts on Identify specimens, which the overnight job commits (src/commit-determinations.ts). For staff''s samples file: its rows queued to be applied, one upload_sample_outcome row each, which the apply-uploads job works through. At most one row per upload, written in the same transaction as the drafts or the queued rows. No row means nothing from the file was taken up.';
COMMENT ON COLUMN upload_applied.applied_by IS 'The person signed in who applied it: the person the drafts are credited to, or the staff member whose samples the job creates.';
COMMENT ON COLUMN upload_applied.applied_at IS 'When it was applied: when the drafts were saved, or when the rows were queued.';
COMMENT ON COLUMN upload_applied.draft_count IS 'How many drafts were written for a volunteer''s file, one for each identification the preview listed; for staff''s samples file, how many rows were queued to be made (pending), not counting the rows left alone, which also have an upload_sample_outcome row.';

-- What applying a samples file did to each row (beeline-kgyd.4.10). Written
-- as 'pending' in the transaction that claims the upload, and updated to what
-- happened as the apply-uploads job gets to each row, so a restart finds the
-- rows still to do, and the file handed back with notes can say what became
-- of every row. No foreign key to sample: a trap sample made here can be
-- deleted again (src/trap-sample.ts deleteTrapSample), and the record of what
-- the upload did must outlive it.
CREATE TABLE upload_sample_outcome (
  upload_id     INTEGER NOT NULL REFERENCES upload(entity_id),
  row_number    INTEGER NOT NULL CHECK (row_number >= 2),
  unit          TEXT NOT NULL CHECK (length(unit) > 0),
  outcome       TEXT NOT NULL CHECK (outcome IN ('pending', 'created', 'applied', 'unchanged', 'refused', 'skipped')),
  sample_id     INTEGER,
  sample_number TEXT,
  payload       TEXT,
  detail        TEXT,
  recorded_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (upload_id, row_number, unit)
);
COMMENT ON TABLE upload_sample_outcome IS 'What applying a staff member''s samples file did to each row it queued, by row and by unit. Written pending when the upload is applied and updated as the apply-uploads job does each row, in file order. No foreign key to sample, so the record outlives a trap sample that was made from the file and deleted. The CHECKs are here because a deployed store can never gain one (ADR 0006).';
COMMENT ON COLUMN upload_sample_outcome.row_number IS 'The row in the file, the header being row 1, so the first data row is 2.';
COMMENT ON COLUMN upload_sample_outcome.unit IS '''row'' for a whole row, which is all that is written so far: a new row, made into a trap sample. Later a group of cells of an existing sample (method_dates, trap_count, ...). Part of the key, and never null, so the key has no null in it.';
COMMENT ON COLUMN upload_sample_outcome.outcome IS 'pending: queued, not done. created: a trap sample was made from a new row. applied: a change to an existing sample was made. unchanged: nothing needed changing. refused: the row was checked again when its turn came and could not be used (detail says why). skipped: the row was left alone on purpose, such as a look-alike that was not ticked.';
COMMENT ON COLUMN upload_sample_outcome.sample_id IS 'The sample made or changed, once there is one. Not a foreign key: the sample may have been deleted since.';
COMMENT ON COLUMN upload_sample_outcome.sample_number IS 'The sample''s number as the file gave it, so the record still says which sample it was after the sample is gone.';
COMMENT ON COLUMN upload_sample_outcome.payload IS 'What the job is to write, as JSON, worked out and checked when the upload was applied, including the person ids its collectors came to. The job writes exactly this, so it does not depend on the file or on matching names again.';
COMMENT ON COLUMN upload_sample_outcome.detail IS 'For a refused or skipped row, the sentence saying why.';
COMMENT ON COLUMN upload_sample_outcome.recorded_at IS 'When the row was queued, and then when its outcome was recorded.';
