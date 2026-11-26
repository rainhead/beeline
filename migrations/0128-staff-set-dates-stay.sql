-- Migration for schema/030_samples_specimens.sql (beeline-qu2c): a date staff set
-- on a sample is the sample's date and the nightly never moves it. A new table;
-- no row is written by the migration.
--
-- No existing staff date can be lost: before this change staff could not set
-- the date of an unprinted sample with an observation, and the date follow
-- moves only those. On production's copy of 2026-11-25 no such sample has a
-- date differing from its observation's, so the first nightly moves no date.
CREATE TABLE sample_date_override (
  sample_id INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  set_by    INTEGER REFERENCES person(entity_id),
  set_at    TIMESTAMP NOT NULL DEFAULT current_timestamp,
  reason    TEXT
);
COMMENT ON TABLE sample_date_override IS 'A sample whose dates a staff member set in Beeline, which promotion never moves: the date follow in ingest/mint-samples.sql skips samples with a row here (beeline-qu2c). Without a row, an unprinted one-day sample with an observation takes the observation''s date. Written straight to the store with the change, with no overlay file, because production is never promoted again (ADR 0006); sample.date_start and date_end are the dates themselves and every read uses them. A row is never removed: taking a staff date away so the sample follows iNaturalist again is not built.';
COMMENT ON COLUMN sample_date_override.set_by IS 'Whoever set the dates last; null for a staff login that is no person.';
COMMENT ON COLUMN sample_date_override.set_at IS 'When the dates were last set by staff, UTC.';
COMMENT ON COLUMN sample_date_override.reason IS 'What staff said the last time they set the dates, or null when they said nothing.';
