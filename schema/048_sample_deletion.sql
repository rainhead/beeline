-- A trap sample entered in Beeline and deleted by staff (beeline-kgyd.4.10). Written in the same transaction that
-- removes the sample's satellite rows, before the sample itself goes, so that a deletion cut short can be finished
-- and a deletion that was finished stays visible: the sample change log cannot say that a sample is gone (ADR 0007),
-- and a change that leaves no trace is one nobody can see. No foreign key to sample, since the sample is gone.
CREATE TABLE sample_deletion (
  entity_id     INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  sample_id     INTEGER NOT NULL,
  sample_number TEXT NOT NULL,
  deleted_by    INTEGER NOT NULL REFERENCES person(entity_id),
  deleted_at    TIMESTAMPTZ NOT NULL,
  reason        TEXT
);
COMMENT ON TABLE sample_deletion IS 'A trap sample entered in Beeline that staff deleted, with who and when (src/trap-sample.ts deleteTrapSample). Written in the transaction that removes the sample''s satellite rows, ahead of the sample row, so a deletion cut short between the two is finished by deleting again. The row stays after the sample is gone. An entity (ADR 0002) with its own key, and no foreign key to sample, since the sample no longer exists: an id the store draws again after being put back to an earlier copy can have several records, a fresh deletion always writes a new one, and finishing a cut-short deletion (a sample with a record, no entry mark and no collector) writes none.';
COMMENT ON COLUMN sample_deletion.sample_id IS 'The id the sample had. Not a foreign key and not unique.';
COMMENT ON COLUMN sample_deletion.sample_number IS 'The number the sample had, so the record says which sample it was.';
COMMENT ON COLUMN sample_deletion.deleted_by IS 'The person signed in who deleted it.';
COMMENT ON COLUMN sample_deletion.deleted_at IS 'When its satellite rows were removed, which is when the deletion began.';
COMMENT ON COLUMN sample_deletion.reason IS 'Why, if the person said; the page does not ask yet.';
