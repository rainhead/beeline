-- Migration for schema/030_samples_specimens.sql (beeline-1kb.11).
-- Vocabulary decided in beeline-nfo: the number Beeline mints and prints is
-- the FIELD number. 'Catalog number' is the museum's identifier, arriving
-- from Ecdysis with its institutional prefix (WSDA_2303966), and the name is
-- reserved for the column that import will bring back. Screens, the message
-- catalog, and the CSV header already said field_number; the store lagged.
--
-- This is a table rebuild rather than the one-line rename it should be.
-- DuckDB 1.5.5 refuses ALTER TABLE ... RENAME COLUMN (and DROP COLUMN) on any
-- table involved in a foreign key, whether or not the column is part of one —
-- specimen sits between sample and determination, so both directions block.
-- ADD COLUMN is permitted, but leaving the old column behind fails the point.
-- So: copy out, drop, recreate from schema/030 and schema/040 verbatim, copy
-- back with entity_ids preserved, and rebuild every view that reads either
-- table. Worth re-testing when DuckDB moves past 1.5.x (beeline-c1b).

DROP VIEW pending_print_sample;
DROP VIEW printable_sample;
DROP VIEW blocking_sample;
DROP VIEW sample_qc_finding;
DROP VIEW determination_of_record;

CREATE TABLE mig0007_specimen AS SELECT * FROM specimen;
CREATE TABLE mig0007_determination AS SELECT * FROM determination;

DROP TABLE determination;
DROP TABLE specimen;

CREATE TABLE specimen (
  entity_id       INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  sample_id       INTEGER NOT NULL REFERENCES sample(entity_id),
  specimen_number INTEGER NOT NULL,
  field_number    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sample_id, specimen_number)
);
COMMENT ON TABLE specimen IS 'One physical insect. Specimens are individuated by printing: until a print run freezes, a sample has only specimen_count. Historical ingestion also lands here — production is 99.9997% printed.';
COMMENT ON COLUMN specimen.specimen_number IS '1..N within the sample at freeze time.';
COMMENT ON COLUMN specimen.field_number IS 'The number Beeline issues and prints on the label (CONTEXT.md, beeline-nfo) — never the museum''s catalog number, which arrives from Ecdysis with its institutional prefix and gets its own column when import lands. Opaque verbatim text: all four historical identifier eras land here, including the era of duplicates — so no UNIQUE. Uniqueness becomes a hard guarantee only for the numbers Beeline itself mints, returning with the printing phase.';

INSERT INTO specimen (entity_id, sample_id, specimen_number, field_number, created_at)
SELECT entity_id, sample_id, specimen_number, catalog_number, created_at FROM mig0007_specimen;

CREATE TABLE determination (
  entity_id       INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  specimen_id     INTEGER NOT NULL REFERENCES specimen(entity_id),
  animal_id       INTEGER NOT NULL REFERENCES animal(entity_id),
  sex             TEXT,
  caste           TEXT,
  determiner_id   INTEGER REFERENCES person(entity_id),
  determiner_name TEXT,
  is_expert       BOOLEAN NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('in_app', 'ecdysis_import', 'legacy_import')),
  determined_on   DATE,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes           TEXT
);
COMMENT ON TABLE determination IS 'A person asserting a taxon (and sex/caste) for a specimen. Append-only events: a correction is a newer event, never an edit. The volunteer draft/commit boundary lives in the app — only deliberate assertions become rows.';
COMMENT ON COLUMN determination.determiner_name IS 'Imports name people we may not resolve to a person row.';
COMMENT ON COLUMN determination.determined_on IS 'When the determination was made, if known.';
COMMENT ON COLUMN determination.recorded_at IS 'When it crossed into Beeline; drives determination-of-record ordering and, later, notifications.';

INSERT INTO determination (entity_id, specimen_id, animal_id, sex, caste, determiner_id,
                           determiner_name, is_expert, channel, determined_on, recorded_at, notes)
SELECT entity_id, specimen_id, animal_id, sex, caste, determiner_id,
       determiner_name, is_expert, channel, determined_on, recorded_at, notes
FROM mig0007_determination;

DROP TABLE mig0007_determination;
DROP TABLE mig0007_specimen;

CREATE VIEW determination_of_record AS
SELECT entity_id, specimen_id, animal_id, sex, caste, determiner_id, determiner_name,
       is_expert, channel, determined_on, recorded_at, notes
FROM (
  SELECT d.*,
         row_number() OVER (
           PARTITION BY specimen_id
           ORDER BY is_expert DESC, recorded_at DESC, entity_id DESC
         ) AS rn
  FROM determination d
) ranked
WHERE rn = 1;

CREATE VIEW sample_qc_finding AS
SELECT coalesce(f.sample_id, sp.sample_id) AS sample_id,
       f.specimen_id,
       f.rule_name,
       f.details
FROM qc_finding f
LEFT JOIN specimen sp ON sp.entity_id = f.specimen_id;

CREATE VIEW blocking_sample AS
SELECT DISTINCT f.sample_id AS sample_id
FROM sample_qc_finding f
JOIN qc_rule r ON r.name = f.rule_name AND r.severity = 'blocking'
WHERE f.sample_id IS NOT NULL;

CREATE VIEW printable_sample AS
SELECT s.entity_id AS sample_id
FROM sample s
WHERE s.specimen_count > 0
  AND NOT EXISTS (SELECT 1 FROM blocking_sample b WHERE b.sample_id = s.entity_id);

CREATE VIEW pending_print_sample AS
SELECT s.entity_id AS sample_id,
       CAST(s.specimen_count - coalesce(printed.n, 0) AS INTEGER) AS pending_count
FROM printable_sample p
JOIN sample s ON s.entity_id = p.sample_id
LEFT JOIN (
  SELECT sample_id, count(*) AS n FROM specimen GROUP BY sample_id
) printed ON printed.sample_id = s.entity_id
WHERE s.specimen_count > coalesce(printed.n, 0);
