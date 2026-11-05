-- Migration for schema/030_samples_specimens.sql: sample_entry, the mark on
-- a sample somebody entered in Beeline (beeline-3vs.2). A new table that
-- nothing refers to yet, so it is created as the schema declares it.

CREATE TABLE sample_entry (
  sample_id  INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  entered_by INTEGER REFERENCES person(entity_id),
  entered_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE sample_entry IS 'A sample entered in Beeline (beeline-3vs.2), with who entered it and when (UTC). Beeline is the only record of such a sample, so it is edited directly; samples without a row came from iNaturalist or the old Beeline.';
COMMENT ON COLUMN sample_entry.entered_by IS 'The person who entered it, not anyone they were acting for. Null when entered by a staff login that is no person.';
