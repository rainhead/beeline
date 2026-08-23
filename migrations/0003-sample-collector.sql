-- Migration for schema/030_samples_specimens.sql's sample_collector
-- (beeline-77j). Existing samples get their primary collector as position 1;
-- second collectors arrive when legacy promotion re-runs and reads
-- recordedBy, which is the only place they were ever recorded.

CREATE TABLE sample_collector (
  sample_id INTEGER NOT NULL REFERENCES sample(entity_id),
  person_id INTEGER NOT NULL REFERENCES person(entity_id),
  position  INTEGER NOT NULL CHECK (position >= 1),
  PRIMARY KEY (sample_id, person_id)
);

INSERT INTO sample_collector (sample_id, person_id, position)
SELECT entity_id, collector_id, 1 FROM sample;
