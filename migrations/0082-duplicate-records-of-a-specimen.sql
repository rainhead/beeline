-- Migration for schema/040_determinations.sql: old-Beeline records promotion
-- set aside as second prints, tied back to their specimen (beeline-iuva). The
-- table starts empty; a one-time repair (src/repair-legacy-skipped.ts) fills it.

CREATE TABLE legacy_duplicate_record (
  _id         TEXT PRIMARY KEY,
  specimen_id INTEGER NOT NULL REFERENCES specimen(entity_id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE legacy_duplicate_record IS 'An old-Beeline record promotion set aside as a second print of a specimen it holds, tied to that specimen (beeline-iuva): its determinations were carried to the specimen, and the nightly import of volunteers'' determinations from the old Beeline reads it as one of the specimen''s records.';
COMMENT ON COLUMN legacy_duplicate_record._id IS 'The old record''s id, as in legacy_occurrence.';
COMMENT ON COLUMN legacy_duplicate_record.recorded_at IS 'When the repair tied it to the specimen.';
