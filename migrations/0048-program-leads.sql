-- Migration for schema/010_people_atlases.sql (beeline-7c1): programs, and
-- who leads each. The reasoning is in schema/010.
--
-- Both tables are new, so this is the schema's own DDL and seed. Leads are
-- not seeded: they arrive through the person overlay (field leads), which
-- the app applies the moment staff save them and promotion replays.
CREATE TABLE program (
  entity_id INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  code      TEXT UNIQUE NOT NULL,
  name      TEXT NOT NULL,
  atlas_id  INTEGER UNIQUE REFERENCES atlas(entity_id)
);
COMMENT ON TABLE program IS 'A program people take part in: each atlas, Master Melittology itself, and the BLM surveys. The overlay names a program by its code.';
COMMENT ON COLUMN program.atlas_id IS 'The atlas this program is, for a program with a region. Null for one without: Master Melittology, the BLM surveys.';

INSERT INTO program (code, name, atlas_id) SELECT code, name, entity_id FROM atlas ORDER BY entity_id;
INSERT INTO program (code, name, atlas_id) VALUES
  ('MM',  'Master Melittology', NULL),
  ('BLM', 'BLM surveys',        NULL);

CREATE TABLE program_lead (
  program_id INTEGER NOT NULL REFERENCES program(entity_id),
  person_id  INTEGER NOT NULL REFERENCES person(entity_id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by TEXT,
  PRIMARY KEY (program_id, person_id)
);
COMMENT ON TABLE program_lead IS 'person_id leads program_id: the program''s work is theirs to take up, and its questions theirs to answer. Set from /people through the person overlay (field leads). Grants no access.';
COMMENT ON COLUMN program_lead.granted_by IS 'iNat login of whoever recorded it. Not a foreign key: the granter may be gone — same stance as person_admin.granted_by.';
