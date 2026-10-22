-- Migration for schema/040_determinations.sql (gh-98): the museum's catalog
-- number, as Ecdysis reports it.
--
-- Andony, on Lincoln Best's advice (2026-10-21): Beeline must not fill
-- catalogNumber itself. Lincoln assigns Oregon's by hand, and Washington's
-- and British Columbia's come from Ecdysis; Beeline's own number goes out as
-- fieldNumber. The exports change in code; this is where the museum's number
-- is kept once the next Ecdysis load reads it. The table starts empty, and
-- the nightly ecdysis-fetch job fills it.

CREATE TABLE specimen_catalog_number (
  specimen_id    INTEGER PRIMARY KEY REFERENCES specimen(entity_id),
  catalog_number TEXT NOT NULL,
  occurrence_id  TEXT,
  loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE specimen_catalog_number IS 'The museum''s catalog number for a specimen (dwc:catalogNumber), as read from Ecdysis: WSDA_2303966 for Washington. Never derived from the field number, which is Beeline''s own number and goes out as dwc:fieldNumber (gh-98).';
COMMENT ON COLUMN specimen_catalog_number.occurrence_id IS 'The Symbiota occurrence recordID the number was read from.';
COMMENT ON COLUMN specimen_catalog_number.loaded_at IS 'When a load last wrote it.';
