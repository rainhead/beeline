-- Migration for schema/040_determinations.sql (beeline-9ut): a precision
-- beside determination.determined_on, and the table that keys imported
-- determinations to the Ecdysis identifications they came from. The CHECK
-- on the new column is in the schema and not here: DuckDB cannot add a
-- constraint to an existing table (ADR 0006), and the loader is its only
-- writer.
ALTER TABLE determination ADD COLUMN determined_on_precision TEXT;

-- The record view names its columns, so it is restated to carry the new one.
CREATE OR REPLACE VIEW determination_of_record AS
SELECT entity_id, specimen_id, animal_id, qualifier, verbatim_identification,
       sex, caste, determiner_id, determiner_name,
       is_expert, channel, determined_on, determined_on_precision, recorded_at, notes
FROM (
  SELECT d.*,
         row_number() OVER (
           PARTITION BY specimen_id
           ORDER BY is_expert DESC, recorded_at DESC, entity_id DESC
         ) AS rn
  FROM determination d
) ranked
WHERE rn = 1;

COMMENT ON COLUMN determination.determined_on IS 'When the determination was made, if known. Read with determined_on_precision: a source that knows only the year says so there rather than by leaving this empty.';
COMMENT ON COLUMN determination.determined_on_precision IS 'How much of determined_on the source actually stated. NULL ⇒ the day; ''month'' ⇒ the month, the day being its first; ''year'' ⇒ the year, the date being January 1st. Ecdysis holds a bare year on a third of its determinations and "s.d." on the rest (beeline-9ut), and a year written as a date without this beside it would read as a confident January (CONTEXT.md, a value that is not there).';

COMMENT ON COLUMN determination.recorded_at IS 'When it crossed into Beeline — with one exception: an identification Ecdysis had already superseded is recorded at the moment Ecdysis entered it (beeline-9ut), so imported history lands in the past where it belongs and can never be the record. Drives determination-of-record ordering and, later, notifications; ecdysis_identification.loaded_at says when any import crossed.';

CREATE TABLE ecdysis_identification (
  record_id        TEXT PRIMARY KEY,
  determination_id INTEGER NOT NULL REFERENCES determination(entity_id),
  occurrence_id    TEXT,
  entered_at       TIMESTAMP,
  loaded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE ecdysis_identification IS 'Provenance and idempotence for determinations imported from Ecdysis: the Symbiota identification recordID each one came from. A row here means that identification is already recorded, whatever export it next arrives in.';
COMMENT ON COLUMN ecdysis_identification.occurrence_id IS 'The Symbiota occurrence recordID the identification hangs off — dwc:occurrenceID as Ecdysis publishes it.';
COMMENT ON COLUMN ecdysis_identification.entered_at IS 'When the identification was entered in Ecdysis (its initialTimeStamp, exported as modified). What orders the history within one load; recorded_at on the determination stays the moment it crossed into Beeline.';
