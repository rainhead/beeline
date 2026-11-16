-- Migration for schema/042 and schema/112: what a museum publishes about
-- Beeline's specimens, read from its Darwin Core archive (beeline-muke).
--
-- The tables start empty but for the one dataset, OSAC's "Oregon Bee Atlas".
-- pnpm archive:fetch and pnpm archive:load, run by hand, fill them.

-- What a museum publishes about Beeline's specimens, read from the Darwin
-- Core archive it publishes to GBIF (beeline-muke). The first is OSAC's
-- "Oregon Bee Atlas" dataset, the only place Oregon's expert identifications
-- are published: OSAC's own database is private, and the old Beeline stopped
-- receiving expert names at cutover.
--
-- STORED ROWS KEEP WHAT THE ARCHIVE SAID. A statement is one record of one
-- version as published, and is never changed. What Beeline makes of it —
-- which specimen it names, which name in the tree it gives — is
-- archive_reading, which every load restates, and the views below.
--
-- A statement is not a determination. The archive gives one current
-- identification per record with a bare year and no time of change, and the
-- old Beeline's expert names carry no date at all, so where the two differ
-- nothing says which is newer. A load therefore records a determination only
-- where Beeline holds no expert name for the specimen (Peter, 2026-11-15:
-- "play this conservatively", in the hope that the determiner will send his
-- determinations directly), or to revise a determination an earlier load of
-- the same record made. Everything else stays here, shown on the specimen's
-- page as what the museum publishes, so that nothing an archive says is
-- hidden and nothing Beeline holds is changed in place.
--
-- Not entities (ADR 0002): nothing anchors on a statement. A dataset is named
-- by GBIF's key for it, a record by its dwc:occurrenceID, which OSAC has kept
-- unchanged for every record across the six versions it published in 2026.

CREATE TABLE archive_dataset (
  dataset_key   TEXT PRIMARY KEY,
  publisher     TEXT NOT NULL,
  title         TEXT NOT NULL,
  specimen_term TEXT NOT NULL
);
COMMENT ON TABLE archive_dataset IS 'A dataset a museum publishes to GBIF whose records are Beeline''s specimens. A load refuses a dataset that is not here: which column of an archive names the specimen is a decision somebody makes once per dataset.';
COMMENT ON COLUMN archive_dataset.dataset_key IS 'GBIF''s key for the dataset, the UUID in its GBIF address. GBIF''s registry says where the publisher''s own archive is, which is what a load reads: GBIF''s copy respells names to its own taxonomy.';
COMMENT ON COLUMN archive_dataset.publisher IS 'The publisher as a page names it: "OSAC".';
COMMENT ON COLUMN archive_dataset.title IS 'The dataset''s title as published.';
COMMENT ON COLUMN archive_dataset.specimen_term IS 'The Darwin Core term whose value is the specimen''s field number in Beeline. No CHECK lists the terms, since a deployed store''s CHECK can never be widened (ADR 0006); the loader holds the list of terms it can read (src/load-archive.ts, SPECIMEN_TERMS).';

INSERT INTO archive_dataset (dataset_key, publisher, title, specimen_term)
VALUES ('1fa69ff3-3e40-465f-927f-12b1484d3731', 'OSAC', 'Oregon Bee Atlas', 'fieldNumber');

CREATE TABLE archive_version (
  dataset_key  TEXT NOT NULL REFERENCES archive_dataset(dataset_key),
  version      TEXT NOT NULL,
  sequence     INTEGER NOT NULL,
  published_on DATE NOT NULL,
  sha256       TEXT NOT NULL,
  records      INTEGER NOT NULL,
  loaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_key, version),
  UNIQUE (dataset_key, sequence)
);
COMMENT ON TABLE archive_version IS 'A published version of a dataset that has been loaded. Versions are loaded in the order they were published; a load refuses one published before the newest already loaded.';
COMMENT ON COLUMN archive_version.version IS 'The version as the publisher numbers it, from the packageId of the archive''s eml.xml: "1.9".';
COMMENT ON COLUMN archive_version.sequence IS 'The order the versions were loaded in, from 1. What orders a dataset''s versions: a version number does not sort as text (1.10 after 1.9), and OSAC published two versions on one day.';
COMMENT ON COLUMN archive_version.published_on IS 'The publication date the archive''s eml.xml states.';
COMMENT ON COLUMN archive_version.sha256 IS 'The hash of the version''s occurrence file, so the file a load read can be told from another under the same version number.';
COMMENT ON COLUMN archive_version.records IS 'How many records the version holds.';

CREATE TABLE archive_statement (
  dataset_key      TEXT NOT NULL REFERENCES archive_dataset(dataset_key),
  occurrence_id    TEXT NOT NULL,
  version          TEXT NOT NULL,
  withdrawn        BOOLEAN NOT NULL DEFAULT false,
  field_number     TEXT,
  catalog_number   TEXT,
  recorded_by      TEXT,
  event_date       DATE,
  scientific_name  TEXT,
  family           TEXT,
  genus            TEXT,
  subgenus         TEXT,
  specific_epithet TEXT,
  taxon_rank       TEXT,
  identified_by    TEXT,
  date_identified  TEXT,
  sex              TEXT,
  PRIMARY KEY (dataset_key, occurrence_id, version),
  FOREIGN KEY (dataset_key, version) REFERENCES archive_version(dataset_key, version),
  CHECK (NOT withdrawn OR (field_number IS NULL AND catalog_number IS NULL AND scientific_name IS NULL
                           AND genus IS NULL AND specific_epithet IS NULL AND identified_by IS NULL
                           AND date_identified IS NULL AND sex IS NULL))
);
COMMENT ON TABLE archive_statement IS 'What a dataset said about one of its records, as published, from the version in which it first said it: a row for a record''s first appearance and one for each later version in which any of these columns changed. A version that repeats the last statement adds nothing. Never updated.';
COMMENT ON COLUMN archive_statement.occurrence_id IS 'dwc:occurrenceID exactly as published, the scheme included: OSAC writes http: on some and https: on others, and GBIF reads a changed string as another record.';
COMMENT ON COLUMN archive_statement.version IS 'The first version loaded that said this.';
COMMENT ON COLUMN archive_statement.withdrawn IS 'True where the version no longer holds the record: the other columns are then empty. A record that returns gets a new statement.';
COMMENT ON COLUMN archive_statement.field_number IS 'The value of the dataset''s specimen term (archive_dataset.specimen_term), as published.';
COMMENT ON COLUMN archive_statement.catalog_number IS 'dwc:catalogNumber: the museum''s own number, which OSAC gives only the specimens it has catalogued.';
COMMENT ON COLUMN archive_statement.recorded_by IS 'dwc:recordedBy as published; several collectors are joined with a pipe. Read to confirm the field number, never to change a collector.';
COMMENT ON COLUMN archive_statement.event_date IS 'The day collected, from dwc:year, month and day, or NULL where they are not a date. Read to confirm the field number.';
COMMENT ON COLUMN archive_statement.scientific_name IS 'dwc:scientificName as published, authorship included.';
COMMENT ON COLUMN archive_statement.date_identified IS 'dwc:dateIdentified as published: a bare year in OSAC''s dataset.';
COMMENT ON COLUMN archive_statement.sex IS 'dwc:sex as published, in the publisher''s spelling.';

-- What the last load made of each record's newest statement. Derived, and
-- restated for the whole dataset by every load, so that a name the tree has
-- since gained, or a specimen whose field number was corrected, is read
-- afresh; nothing is decided here that a later load cannot decide again.
-- No foreign keys to what it reads: a load replaces the dataset's rows in
-- one transaction, and a derived table must never stand in the way of a
-- change to a specimen, a name or a person.
CREATE TABLE archive_reading (
  dataset_key   TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  version       TEXT NOT NULL,
  specimen_id   INTEGER,
  animal_id     INTEGER,
  determiner_id INTEGER,
  sex           TEXT CHECK (sex IN ('female', 'male', 'gynandromorph')),
  determined_on DATE,
  held          TEXT,
  detail        TEXT,
  PRIMARY KEY (dataset_key, occurrence_id)
);
COMMENT ON TABLE archive_reading IS 'How the last load read each record''s newest statement: the specimen it names, the name in the tree it gives, and why not where it could not be read. Replaced for the whole dataset by every load.';
COMMENT ON COLUMN archive_reading.version IS 'The version of the statement read (archive_statement.version).';
COMMENT ON COLUMN archive_reading.specimen_id IS 'The one specimen carrying the statement''s field number, or NULL where none or several do.';
COMMENT ON COLUMN archive_reading.animal_id IS 'The name the statement gives, as a node of the tree, or NULL where it could not be placed.';
COMMENT ON COLUMN archive_reading.determined_on IS '1 January of the year the statement gives as dateIdentified; a year is all OSAC states.';
COMMENT ON COLUMN archive_reading.held IS 'Why the statement could not be read as a determination of one specimen (src/load-archive.ts, HELD_REASONS), or NULL where it could.';
COMMENT ON COLUMN archive_reading.detail IS 'What the held reason is about: the name that is not in the tree, the collector the sample has.';

CREATE TABLE archive_determination (
  determination_id INTEGER PRIMARY KEY REFERENCES determination(entity_id),
  dataset_key      TEXT NOT NULL REFERENCES archive_dataset(dataset_key),
  occurrence_id    TEXT NOT NULL,
  version          TEXT NOT NULL,
  loaded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (dataset_key, occurrence_id, version) REFERENCES archive_statement(dataset_key, occurrence_id, version)
);
COMMENT ON TABLE archive_determination IS 'Provenance for determinations a load recorded from an archive: the dataset, the record and the version whose statement each one is. Their channel is worksheet_import with is_expert true, because DuckDB cannot add a channel value to a deployed store''s CHECK (ADR 0006); a row here, and none in worksheet_determination, is what says a determination came from a published archive.';
COMMENT ON COLUMN archive_determination.version IS 'The version of the statement recorded (archive_statement.version).';

-- What a published archive says now about each of its records: the newest
-- statement, by the order its versions were loaded in (schema/042).
CREATE VIEW archive_statement_current AS
SELECT dataset_key, occurrence_id, version, withdrawn, field_number, catalog_number, recorded_by, event_date,
       scientific_name, family, genus, subgenus, specific_epithet, taxon_rank, identified_by, date_identified, sex
FROM (
  SELECT s.*,
         row_number() OVER (PARTITION BY s.dataset_key, s.occurrence_id ORDER BY v.sequence DESC) AS rn
  FROM archive_statement s
  JOIN archive_version v ON v.dataset_key = s.dataset_key AND v.version = s.version
) ranked
WHERE rn = 1;
COMMENT ON VIEW archive_statement_current IS 'The newest statement of each record of each dataset, a withdrawal included.';

-- What a museum publishes about a specimen, for the specimen's page: one row
-- for each record of a dataset that names the specimen and is still
-- published. is_record says the specimen's determination of record is one a
-- load recorded from this dataset AND still says what the record says now,
-- so the page need not say it twice. A record the publisher has since
-- changed to something a load could not record (a name the tree lacks, a
-- determiner nobody has placed) is therefore not the record, and is shown.
-- agrees says the name the archive gives is the name of the
-- specimen's expert determination of record, with no qualifier on it. Where
-- neither holds, the museum publishes something Beeline does not say, and
-- the page shows it (Peter, 2026-11-15: every difference is visible).
CREATE VIEW archive_note AS
SELECT r.specimen_id, d.dataset_key, d.publisher, c.occurrence_id, c.version, c.catalog_number,
       c.scientific_name, c.identified_by, c.date_identified, c.sex,
       r.animal_id, r.held,
       coalesce(ad.determination_id IS NOT NULL AND r.held IS NULL
                AND rec.animal_id = r.animal_id AND rec.qualifier IS NULL
                AND rec.sex IS NOT DISTINCT FROM r.sex
                AND rec.determined_on IS NOT DISTINCT FROM r.determined_on
                AND rec.determiner_name IS NOT DISTINCT FROM c.identified_by, false) AS is_record,
       coalesce(rec.is_expert AND rec.animal_id = r.animal_id AND rec.qualifier IS NULL, false) AS agrees
FROM archive_reading r
JOIN archive_dataset d ON d.dataset_key = r.dataset_key
JOIN archive_statement_current c ON c.dataset_key = r.dataset_key AND c.occurrence_id = r.occurrence_id
LEFT JOIN determination_of_record rec ON rec.specimen_id = r.specimen_id
LEFT JOIN archive_determination ad ON ad.determination_id = rec.entity_id AND ad.dataset_key = r.dataset_key
WHERE r.specimen_id IS NOT NULL AND NOT c.withdrawn;
COMMENT ON VIEW archive_note IS 'What a published archive says about a specimen now: its name as published, who identified it and in what year, and whether Beeline''s determination of record is one a load recorded from the dataset that still says the same (is_record), or gives the same name (agrees).';
COMMENT ON COLUMN archive_note.held IS 'Why the load could not read the statement as a determination (a name the tree lacks, a determiner nobody has placed), or NULL.';

-- Where a museum publishes a name other than the one Beeline's expert
-- determination of record gives: the worklist for a person, since nothing in
-- either source says which is newer. Split by season with settled, as every
-- check is (AGENTS.md).
CREATE VIEW archive_disagreement AS
SELECT n.dataset_key, n.publisher, n.occurrence_id, n.specimen_id, sp.field_number,
       n.scientific_name AS published_name, n.identified_by AS published_by, n.date_identified AS published_year,
       n.animal_id AS published_animal_id,
       rec.entity_id AS determination_id, rec.animal_id, rec.qualifier, rec.channel,
       sp.sample_id IN (SELECT sample_id FROM settled_sample) AS settled
FROM archive_note n
JOIN specimen sp ON sp.entity_id = n.specimen_id
JOIN determination_of_record rec ON rec.specimen_id = n.specimen_id AND rec.is_expert
WHERE NOT n.is_record AND NOT n.agrees;
COMMENT ON VIEW archive_disagreement IS 'Specimens whose expert determination of record gives a name other than the one a published archive gives, or gives it with a qualifier, or whose published name the tree could not place. Nothing is recorded for these: neither source says which name is newer.';
COMMENT ON COLUMN archive_disagreement.published_animal_id IS 'The published name as a node of the tree, or NULL where it could not be placed.';
COMMENT ON COLUMN archive_disagreement.settled IS 'Whether the specimen''s sample is from a settled season (settled_sample).';
