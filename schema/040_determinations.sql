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
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes           TEXT
);
COMMENT ON TABLE determination IS 'A person asserting a taxon (and sex/caste) for a specimen. Append-only events: a correction is a newer event, never an edit. The volunteer draft/commit boundary lives in the app — only deliberate assertions become rows.';
COMMENT ON COLUMN determination.qualifier IS 'Open nomenclature: how sure the determiner was. cf. — resembles this species, needs confirming; aff. — close to it but probably something else; nr. — near it. All three modify a species-rank assertion and none of them is expressible as a coarser one: dropping to genus throws away the resemblance the determiner actually observed. sp./spp. are deliberately absent, being what a genus-rank determination already means (beeline-tgu).';
COMMENT ON COLUMN determination.verbatim_identification IS 'The name as the source wrote it, kept beside the node it resolved to. Legacy staging is re-pullable today and frozen at cutover, after which this is the only record of what was actually said; Ecdysis import (phase 7) brings names from a system that records both.';
COMMENT ON COLUMN determination.determiner_name IS 'Imports name people we may not resolve to a person row.';
COMMENT ON COLUMN determination.determined_on IS 'When the determination was made, if known.';
COMMENT ON COLUMN determination.recorded_at IS 'When it crossed into Beeline; drives determination-of-record ordering and, later, notifications.';
