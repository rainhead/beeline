CREATE TABLE determination (
  entity_id       INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  specimen_id     INTEGER NOT NULL REFERENCES specimen(entity_id),
  animal_id       INTEGER NOT NULL REFERENCES animal(entity_id),
  qualifier       TEXT CHECK (qualifier IN ('cf.', 'aff.', 'nr.')),
  verbatim_identification TEXT,
  sex             TEXT,
  caste           TEXT,
  determiner_id   INTEGER REFERENCES person(entity_id),
  determiner_name TEXT,
  is_expert       BOOLEAN NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('in_app', 'ecdysis_import', 'legacy_import')),
  determined_on   DATE,
  determined_on_precision TEXT CHECK (determined_on_precision IN ('month', 'year')),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes           TEXT,
  CHECK (nullif(trim(verbatim_identification), '') IS NOT NULL
         OR (channel = 'legacy_import' AND verbatim_identification IS NULL))
);
COMMENT ON TABLE determination IS 'A person asserting a taxon (and sex/caste) for a specimen. Append-only events: a correction is a newer event, never an edit. The volunteer draft/commit boundary lives in the app — only deliberate assertions become rows.';
COMMENT ON COLUMN determination.qualifier IS 'Open nomenclature: how sure the determiner was. cf. — resembles this species, needs confirming; aff. — close to it but probably something else; nr. — near it. All three modify a species-rank assertion and none of them is expressible as a coarser one: dropping to genus throws away the resemblance the determiner actually observed. sp./spp. are deliberately absent, being what a genus-rank determination already means (beeline-tgu).';
COMMENT ON COLUMN determination.verbatim_identification IS 'The name as the determiner wrote it, kept beside the node it resolved to — and required — never blank — on every channel but legacy_import, because not every name will resolve to an ITIS taxon and this is then the only record of what was said (beeline-45v). Legacy import may omit it, never blank it: most of its determinations arrive as parted columns with no whole name to keep, and promotion invents none — with one exception, where a curated decision (a spelling alias, an adopted ITIS name) moves a determination to a node other than the one its own columns spell. The spelling the source used is recorded here then, because nothing else would say what was written (beeline-bph). Ecdysis import (phase 7) brings names from a system that records both.';
COMMENT ON COLUMN determination.determiner_name IS 'Imports name people we may not resolve to a person row.';
COMMENT ON COLUMN determination.determined_on IS 'When the determination was made, if known. Read with determined_on_precision: a source that knows only the year says so there rather than by leaving this empty.';
COMMENT ON COLUMN determination.determined_on_precision IS 'How much of determined_on the source actually stated. NULL ⇒ the day; ''month'' ⇒ the month, the day being its first; ''year'' ⇒ the year, the date being January 1st. Ecdysis holds a bare year on a third of its determinations and "s.d." on the rest (beeline-9ut), and a year written as a date without this beside it would read as a confident January (CONTEXT.md, a value that is not there).';
COMMENT ON COLUMN determination.recorded_at IS 'When it crossed into Beeline — with one exception: an identification Ecdysis had already superseded is recorded at the moment Ecdysis entered it (beeline-9ut), so imported history lands in the past where it belongs and can never be the record. Drives determination-of-record ordering and, later, notifications; ecdysis_identification.loaded_at says when any import crossed.';

-- Which Ecdysis identification each imported determination came from
-- (beeline-9ut). Symbiota gives every identification in its history a
-- recordID (a UUID), and its Darwin Core archive carries the whole history:
-- one row per identification with the moment it was entered, and one of
-- them flagged current. The loader (src/load-ecdysis.ts) keys on that id,
-- so loading an export twice, or a later export of the same collection,
-- records only what is new. A flat occurrence export carries only the
-- current identification and no id for it, so the loader derives one from
-- the occurrence's recordID and the identification's own fields.
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
