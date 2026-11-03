-- Migration for schema/030_samples_specimens.sql: a specimen's disposition
-- and remarks, from a staff inventory (beeline-fud5). The table starts
-- empty; pnpm disposition:load fills it from the inventory file.

CREATE TABLE specimen_disposition (
  specimen_id INTEGER PRIMARY KEY REFERENCES specimen(entity_id),
  disposition TEXT CHECK (disposition IN ('in collection', 'missing')),
  remarks     TEXT NOT NULL CHECK (remarks <> ''),
  stated_by   TEXT NOT NULL CHECK (stated_by <> ''),
  stated_on   DATE NOT NULL,
  source      TEXT NOT NULL CHECK (source <> ''),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE specimen_disposition IS 'What became of the pin, as a person stated it after looking (dwc:disposition, dwc:occurrenceRemarks). Absent for the ordinary specimen nobody has had cause to remark on. Written by pnpm disposition:load from a staff inventory file; the legacy-format export and the Darwin Core archives carry both columns.';
COMMENT ON COLUMN specimen_disposition.disposition IS 'Darwin Core''s vocabulary, the two values the inventory can say: in collection (a pin with this label is in a box) or missing (no pin, and the record cannot be matched to one). Null where the remark says something else, such as that a label is still to print.';
COMMENT ON COLUMN specimen_disposition.remarks IS 'The remark as stated, or as corrected by the load: the words the exports write as occurrenceRemarks.';
COMMENT ON COLUMN specimen_disposition.stated_by IS 'Who looked: the name given to the load, not a person reference, since the inventory is a file and not an act in Beeline.';
COMMENT ON COLUMN specimen_disposition.stated_on IS 'The date the statement is good for, given to the load: the inventory''s date rather than the load''s.';
COMMENT ON COLUMN specimen_disposition.source IS 'The file the remark was read from, by name.';
