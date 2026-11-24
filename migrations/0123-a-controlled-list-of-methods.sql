-- Migration for schema/031_methods.sql, schema/121_views_method.sql and the
-- comment on sample.protocol (schema/030) (beeline-ni5m.15): a controlled list
-- of methods, each sample's method beside it, and what the method as written
-- (sample.protocol) maps to. The tables and views are made here as the schema
-- makes them. sample_method is backfilled from sample.protocol through
-- method_text, so a sample whose text is empty or not listed gets no row and is
-- on sample_without_method; on production on 2026-11-23 that was one sample of
-- 70,859. Nothing is added to sample itself, which DuckDB refuses for a table
-- that other tables reference. The trap count is the one the text states, or
-- failing that the number the sample's effort starts with, where a sample
-- entered in Beeline keeps it. Nothing that reads a sample's method changes.
--
-- What a deploy loses in the change log: this change adds the method and the
-- trap count to the fields the sample history records (src/sample-change.ts),
-- which changes the header of the stored snapshot, so the first pass after the
-- deploy takes the corpus as its new baseline and logs nothing as an arrival.
-- A change to a sample that is made after the previous pass and before that
-- one is not recorded. Run a pass immediately before deploying and nothing is
-- lost.

CREATE TABLE method (
  code       TEXT PRIMARY KEY,
  label_word TEXT NOT NULL CHECK (regexp_full_match(label_word, '[ -~]{1,6}')),
  is_trap    BOOLEAN NOT NULL
);
COMMENT ON TABLE method IS 'The ways a sample''s bees are caught: a controlled list, seeded here like qc_rule because a view joins it and a change to it is a migration. A code is permanent, since sample_method and method_text refer to it. Nothing reads a sample''s method from here yet except the lists the forms offer: the label, the plant relationship and the exports still read sample.protocol.';
COMMENT ON COLUMN method.code IS 'The method as a person reads it ("pan trap"), also the text written to sample.protocol for a sample made in Beeline.';
COMMENT ON COLUMN method.label_word IS 'The word a label prints for this method, one to six plain ASCII characters so that it fits the label''s method box (METHOD_WORD_LIMIT in src/label-text.ts).';
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
COMMENT ON TABLE sample_method IS 'How a sample''s bees were caught: one method per sample. Absent for a sample whose method as written is not one method_text knows (sample_without_method lists them). Written in the same transaction as sample.protocol by every writer, and sample_method_text_mismatch asserts that the two agree.';
COMMENT ON COLUMN sample_method.method_code IS 'The sample''s method, from the list in method.';
COMMENT ON COLUMN sample_method.trap_count IS 'How many traps, null where nobody has said. From the leading number of the method as written ("6 vane traps") or from what a person entered. Nothing reads it yet: sample.sampling_effort still carries the count as text.';

CREATE TABLE method_text (
  text        TEXT PRIMARY KEY,
  method_code TEXT NOT NULL REFERENCES method(code),
  trap_count  INTEGER CHECK (trap_count >= 1)
);
COMMENT ON TABLE method_text IS 'Which method each wording in sample.protocol means, matched on the exact text as stored: the wordings production held on 2026-11-23, and each method''s own code. A sample whose text is here gets its method from this table (promotion, the carry-over of held-back records, the migration). Seeded here and by migrations like qc_rule, so that a view can join it and a change to it is a migration that corrects the rows.';
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

INSERT INTO sample_method (sample_id, method_code, trap_count)
SELECT s.entity_id, t.method_code,
       -- The count the text states, or else the one the sample's effort starts with ("6 vane traps"), which is where a
       -- sample entered in Beeline has kept it.
       coalesce(t.trap_count, nullif(TRY_CAST(regexp_extract(s.sampling_effort, '^([0-9]+) ', 1) AS INTEGER), 0))
FROM sample s
JOIN method_text t ON t.text = s.protocol;

CREATE VIEW sample_without_method AS
SELECT s.entity_id AS sample_id, s.sample_number, s.protocol
FROM sample s
WHERE NOT EXISTS (SELECT 1 FROM sample_method m WHERE m.sample_id = s.entity_id);
COMMENT ON VIEW sample_without_method IS 'Samples with no method: their method as written is empty or is not one method_text knows. A worklist, not a failure: one such sample exists on production. A sample is a row here until someone chooses its method.';

CREATE VIEW sample_method_text_mismatch AS
SELECT s.entity_id AS sample_id, s.protocol, m.method_code AS stored_method_code, t.method_code AS text_method_code,
       m.trap_count AS stored_trap_count, t.trap_count AS text_trap_count
FROM sample s
JOIN method_text t ON t.text = s.protocol
LEFT JOIN sample_method m ON m.sample_id = s.entity_id
WHERE m.method_code IS DISTINCT FROM t.method_code
   OR (t.trap_count IS NOT NULL AND m.trap_count IS NULL);
COMMENT ON VIEW sample_method_text_mismatch IS 'Samples whose method as written is in method_text but whose stored method differs from what the text gives, or has lost the trap count the text states. Always empty: it proves that every writer of sample.protocol writes sample_method in the same transaction, and the nightly fails when it is not. A trap count a person set that differs from the one the text states is a correction and is not listed, and neither is a count the text does not state.';

CREATE VIEW sample_kind_method_mismatch AS
SELECT s.entity_id AS sample_id, s.kind, m.method_code, md.is_trap
FROM sample s
JOIN sample_method m ON m.sample_id = s.entity_id
JOIN method md ON md.code = m.method_code
WHERE (s.kind = 'trap') <> md.is_trap;
COMMENT ON VIEW sample_kind_method_mismatch IS 'Samples whose kind says trap where the method is not a trap, or net where it is. Informational: kind is set from the dates and the method as written, and a later change makes it follow the method (976 on production on 2026-11-23, all in settled seasons).';

COMMENT ON COLUMN sample.protocol IS 'The method as written, and never parsed: for a sample from old records the text as they wrote it or as staff corrected it (''vane trap'', ''6 Vane Traps''); for a sample made in Beeline the code of its method. The method itself is sample_method (schema/031), which every writer sets in the same transaction, and sample_method_text_mismatch asserts the two agree.';
