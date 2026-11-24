-- How a sample's bees were caught, as a controlled list (beeline-ni5m.15;
-- Peter, 2026-11-23: "a controlled method vocabulary, and a verbatim method
-- field"). The words as written stay in sample.protocol; the list is beside
-- sample and not a column of it, because DuckDB will not add a NOT NULL,
-- CHECKed or foreign-keyed column to a table that other tables reference,
-- and sample is referenced by seventeen. So a sample's method is a row of
-- sample_method, and absence of a row is a sample with no method yet.

CREATE TABLE method (
  code       TEXT PRIMARY KEY,
  -- One to six characters with no space at either end, in plain portable SQL (no exception to ADR 0001 for a regular
  -- expression). That the word is printable ASCII, which a label's method box needs, cannot be said without one, so
  -- test/method-seed.test.ts holds every seeded word to it and a migration that adds a method must pass that test.
  label_word TEXT NOT NULL CHECK (length(label_word) BETWEEN 1 AND 6 AND label_word = trim(label_word)),
  is_trap    BOOLEAN NOT NULL
);
COMMENT ON TABLE method IS 'The ways a sample''s bees are caught: a controlled list, seeded here like qc_rule because a view joins it and a change to it is a migration. A code is permanent, since sample_method and method_text refer to it.';
COMMENT ON COLUMN method.code IS 'The method as a person reads it ("pan trap"), also the text written to sample.protocol for a sample made in Beeline.';
COMMENT ON COLUMN method.label_word IS 'The word a label prints for this method, one to six plain ASCII characters, with no space at either end, so that it fits the label''s method box (METHOD_WORD_LIMIT in src/label-text.ts). The table checks the length and the spaces; a test checks that the seeded words are ASCII.';
COMMENT ON COLUMN method.is_trap IS 'True where the device is set out and collected later: the sample''s plant is then near the trap and not a floral host, the sample may span days, and effort is counted in trap-days.';

INSERT INTO method (code, label_word, is_trap) VALUES
  ('aerial net', 'net', false),
  ('vacuum', 'vacuum', false),
  ('pan trap', 'trap', true),
  ('vane trap', 'trap', true),
  ('bottle trap', 'trap', true),
  ('malaise trap', 'trap', true),
  ('pan and vane traps', 'trap', true),
  ('trap nest', 'nest', true);

CREATE TABLE sample_method (
  sample_id   INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  method_code TEXT NOT NULL REFERENCES method(code),
  trap_count  INTEGER CHECK (trap_count >= 1)
);
COMMENT ON TABLE sample_method IS 'How a sample''s bees were caught: one method per sample. Absent for a sample whose method as written is not one method_text knows (sample_without_method lists them). Written in the same transaction as sample.protocol by every writer, and sample_method_out_of_step asserts that the two agree.';
COMMENT ON COLUMN sample_method.method_code IS 'The sample''s method, from the list in method.';
COMMENT ON COLUMN sample_method.trap_count IS 'How many traps: the one place a sample''s trap count is kept, and nothing reads one from anywhere else. Null where nobody has said, and always null for a method that is not a trap (a CHECK cannot read method, so sample_method_out_of_step asserts it).';

CREATE TABLE method_text (
  text        TEXT PRIMARY KEY,
  method_code TEXT NOT NULL REFERENCES method(code),
  trap_count  INTEGER CHECK (trap_count >= 1)
);
COMMENT ON TABLE method_text IS 'Which method each wording in sample.protocol means, matched on the exact text as stored: the wordings production held on 2026-11-23, and each method''s own code. A sample whose text is here gets its method from this table (promotion, the carry-over of held-back records, the migration). Seeded here and by migrations like qc_rule, so that a view can join it.';
COMMENT ON COLUMN method_text.trap_count IS 'The number of traps the text states ("6 vane traps" is 6), null where it states none.';

INSERT INTO method_text (text, method_code, trap_count) VALUES
  ('aerial net', 'aerial net', NULL),
  ('net', 'aerial net', NULL),
  ('vacuum', 'vacuum', NULL),
  ('trap nest', 'trap nest', NULL),
  ('pan trap', 'pan trap', NULL),
  ('pan traps', 'pan trap', NULL),
  ('pantrap', 'pan trap', NULL),
  ('Pan trap', 'pan trap', NULL),
  ('pan', 'pan trap', NULL),
  ('yellow pan trap', 'pan trap', NULL),
  ('blue pan trap', 'pan trap', NULL),
  ('white pan traps', 'pan trap', NULL),
  ('16 pan traps', 'pan trap', 16),
  ('25 Pan Traps', 'pan trap', 25),
  ('50 Pan Traps', 'pan trap', 50),
  ('vane trap', 'vane trap', NULL),
  ('vane traps', 'vane trap', NULL),
  ('Vane trap', 'vane trap', NULL),
  ('blue vane trap', 'vane trap', NULL),
  ('4 vane traps', 'vane trap', 4),
  ('6 vane traps', 'vane trap', 6),
  ('6 Vane Traps', 'vane trap', 6),
  ('10 vane traps', 'vane trap', 10),
  ('12 vane traps', 'vane trap', 12),
  ('12 Vane Traps', 'vane trap', 12),
  ('16 vane traps', 'vane trap', 16),
  ('18 vane traps', 'vane trap', 18),
  ('24 vane traps', 'vane trap', 24),
  ('72 vane traps', 'vane trap', 72),
  ('bottle trap', 'bottle trap', NULL),
  ('white bottle trap', 'bottle trap', NULL),
  ('malaise trap', 'malaise trap', NULL),
  ('pan and vane traps', 'pan and vane traps', NULL),
  ('pan traps and vane traps', 'pan and vane traps', NULL);
