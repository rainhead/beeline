-- Migration for schema/047 (beeline-kgyd.7): a volunteer's upload saved as
-- drafts. A new table that starts empty; no existing row changes.

CREATE TABLE upload_applied (
  upload_id   INTEGER PRIMARY KEY REFERENCES upload(entity_id),
  applied_by  INTEGER NOT NULL REFERENCES person(entity_id),
  applied_at  TIMESTAMPTZ NOT NULL,
  draft_count INTEGER NOT NULL CHECK (draft_count >= 0)
);
COMMENT ON TABLE upload_applied IS 'An upload whose changes were saved: for a volunteer''s file, its identifications written as drafts on Identify specimens, which the overnight job commits (src/commit-determinations.ts). At most one row per upload, written in the same transaction as the drafts. No row means nothing from the file was saved.';
COMMENT ON COLUMN upload_applied.applied_by IS 'The person signed in who saved them, who is the person the drafts are credited to.';
COMMENT ON COLUMN upload_applied.applied_at IS 'When they were saved.';
COMMENT ON COLUMN upload_applied.draft_count IS 'How many drafts were written: one for each identification the preview listed.';
