-- Migration for schema/047 and schema/048 (beeline-kgyd.4.10): staff apply a samples file, and delete a trap sample.
-- upload_applied now says it serves both kinds of upload, and two new tables, empty to begin with, record what
-- applying did to each row and which trap samples staff deleted. No existing row changes.
COMMENT ON TABLE upload_applied IS 'An upload whose changes were taken up. For a volunteer''s file: its identifications written as drafts on Identify specimens, which the overnight job commits (src/commit-determinations.ts). For staff''s samples file: its rows queued to be applied, one upload_sample_outcome row each, which the apply-uploads job works through. At most one row per upload, written in the same transaction as the drafts or the queued rows. No row means nothing from the file was taken up.';
COMMENT ON COLUMN upload_applied.applied_by IS 'The person signed in who applied it: the person the drafts are credited to, or the staff member whose samples the job creates.';
COMMENT ON COLUMN upload_applied.applied_at IS 'When it was applied: when the drafts were saved, or when the rows were queued.';
COMMENT ON COLUMN upload_applied.draft_count IS 'How many drafts were written for a volunteer''s file, one for each identification the preview listed; for staff''s samples file, how many rows were queued to be made (pending), not counting the rows left alone, which also have an upload_sample_outcome row.';

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

-- A trap sample entered in Beeline and deleted by staff (beeline-kgyd.4.10). Written in the same transaction that
-- removes the sample's satellite rows, before the sample itself goes, so that a deletion cut short can be finished
-- and a deletion that was finished stays visible: the sample change log cannot say that a sample is gone (ADR 0007),
-- and a change that leaves no trace is one nobody can see. No foreign key to sample, since the sample is gone.
CREATE TABLE sample_deletion (
  sample_id     INTEGER PRIMARY KEY,
  sample_number TEXT NOT NULL,
  deleted_by    INTEGER NOT NULL REFERENCES person(entity_id),
  deleted_at    TIMESTAMPTZ NOT NULL,
  reason        TEXT
);
COMMENT ON TABLE sample_deletion IS 'A trap sample entered in Beeline that staff deleted, with who and when (src/trap-sample.ts deleteTrapSample). Written in the transaction that removes the sample''s satellite rows, ahead of the sample row, so a deletion cut short between the two is finished by deleting again. The row stays after the sample is gone. No foreign key to sample, since the sample no longer exists; an id the store draws again after being put back to an earlier copy can meet an old row here, which is why finishing a deletion also requires that the sample has no collector.';
COMMENT ON COLUMN sample_deletion.sample_id IS 'The id the sample had. Not a foreign key.';
COMMENT ON COLUMN sample_deletion.sample_number IS 'The number the sample had, so the record says which sample it was.';
COMMENT ON COLUMN sample_deletion.deleted_by IS 'The person signed in who deleted it.';
COMMENT ON COLUMN sample_deletion.deleted_at IS 'When its satellite rows were removed, which is when the deletion began.';
COMMENT ON COLUMN sample_deletion.reason IS 'Why, if the person said; the page does not ask yet.';
