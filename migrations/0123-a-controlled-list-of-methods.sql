-- Migration for schema/031_methods.sql, schema/121_views_method.sql and the
-- comments on sample.protocol and sample.sampling_effort (schema/030)
-- (beeline-ni5m.15): a controlled list of methods, each sample's method beside
-- it, and what the method as written (sample.protocol) maps to. sample_method is
-- backfilled from sample.protocol through method_text, so a sample whose text is
-- empty or not listed gets no row and is on sample_without_method; on production
-- on 2026-11-23 that was one sample of 70,859. A sample's trap count is
-- sample_method.trap_count, the one place it is kept, and only for a method that
-- is a trap: here it is the count the sample's effort text states in the form the
-- forms write ("6 vane traps"), or else the count its method as written states.
-- That is the last place a count is read from text. The old effort column is
-- written from the stored count from here on, and this migration writes it from
-- the count too where it differs. Nothing is added to sample
-- itself, which DuckDB refuses for a table that other tables reference.
--
-- A deploy and the change log: the method and the trap count are now fields of
-- a sample's history (src/sample-change.ts), which changes the header of the
-- stored snapshot, so the first pass after the deploy takes the corpus as its new
-- baseline and files nothing as an arrival. A change made after the previous pass
-- and before that one is not recorded. Run a pass immediately before deploying
-- and nothing is lost.
--
-- Rolling the release back after this migration: the old code writes a method as
-- written without its sample_method row, so after rolling forward again the
-- nightly's check (sample_method_out_of_step) fails until the rows are
-- repaired. With the app stopped, this one statement repairs them from
-- method_text and the count the old code wrote into the effort:
--
--   MERGE INTO sample_method m
--   USING (SELECT s.entity_id AS sample_id, t.method_code,
--                 CASE WHEN d.is_trap THEN coalesce(
--                   TRY_CAST(nullif(regexp_extract(lower(s.sampling_effort), '^([1-9][0-9]{0,5}) .*(trap|nest)s?$', 1), '') AS INTEGER),
--                   t.trap_count) END AS trap_count
--          FROM sample s JOIN method_text t ON t.text = s.protocol JOIN method d ON d.code = t.method_code) x
--   ON m.sample_id = x.sample_id
--   WHEN MATCHED AND (m.method_code IS DISTINCT FROM x.method_code OR m.trap_count IS DISTINCT FROM x.trap_count)
--     THEN UPDATE SET method_code = x.method_code, trap_count = x.trap_count
--   WHEN NOT MATCHED THEN INSERT (sample_id, method_code, trap_count) VALUES (x.sample_id, x.method_code, x.trap_count)
--   WHEN NOT MATCHED BY SOURCE THEN DELETE;

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

-- The count: for a trap method, the count the effort states in the form trapEffort writes (a whole number of one to
-- six digits, a space, and a kind of trap ending in trap, traps, nest or nests; "45 minutes" states none), else the
-- count the method as written states; for a method that is not a trap, none.
INSERT INTO sample_method (sample_id, method_code, trap_count)
SELECT s.entity_id, t.method_code,
       CASE WHEN d.is_trap THEN coalesce(
         TRY_CAST(nullif(regexp_extract(lower(s.sampling_effort), '^([1-9][0-9]{0,5}) .*(trap|nest)s?$', 1), '') AS INTEGER),
         t.trap_count) END
FROM sample s
JOIN method_text t ON t.text = s.protocol
JOIN method d ON d.code = t.method_code;

-- The old effort column, from the stored count, as the one writer writes it: on production this changes nothing.
UPDATE sample SET sampling_effort = x.expected
FROM (SELECT m.sample_id,
             CASE WHEN m.trap_count IS NULL THEN NULL
                  ELSE concat(m.trap_count, ' ', m.method_code, CASE WHEN m.trap_count = 1 OR lower(m.method_code) LIKE '%s' THEN '' ELSE 's' END) END AS expected
      FROM sample_method m) x
WHERE sample.entity_id = x.sample_id AND sample.sampling_effort IS DISTINCT FROM x.expected;

CREATE VIEW sample_without_method AS
SELECT s.entity_id AS sample_id, s.sample_number, s.protocol
FROM sample s
WHERE NOT EXISTS (SELECT 1 FROM sample_method m WHERE m.sample_id = s.entity_id);
COMMENT ON VIEW sample_without_method IS 'Samples with no method: their method as written is empty or is not one method_text knows. A worklist, not a failure: a sample stays on it until someone chooses its method.';

CREATE VIEW sample_method_out_of_step AS
WITH shown AS (
  SELECT s.entity_id AS sample_id, s.protocol, s.sampling_effort,
         m.method_code AS stored_method_code, m.trap_count AS stored_trap_count, d.is_trap,
         t.method_code AS text_method_code,
         -- What the one writer of the old effort column writes (setSampleMethodRow, src/sample-method-row.ts): the count and the method,
         -- plural where there is more than one; none where there is no count.
         CASE WHEN m.trap_count IS NULL THEN NULL
              ELSE concat(m.trap_count, ' ', m.method_code, CASE WHEN m.trap_count = 1 OR lower(m.method_code) LIKE '%s' THEN '' ELSE 's' END)
         END AS expected_effort
  FROM sample s
  LEFT JOIN method_text t ON t.text = s.protocol
  LEFT JOIN sample_method m ON m.sample_id = s.entity_id
  LEFT JOIN method d ON d.code = m.method_code
)
SELECT sample_id, protocol, sampling_effort, stored_method_code, text_method_code, stored_trap_count, expected_effort,
       CASE WHEN stored_method_code IS DISTINCT FROM text_method_code THEN 'method'
            WHEN stored_trap_count IS NOT NULL AND NOT is_trap THEN 'count'
            ELSE 'effort' END AS clause
FROM shown
WHERE stored_method_code IS DISTINCT FROM text_method_code
   OR (stored_trap_count IS NOT NULL AND NOT is_trap)
   OR sampling_effort IS DISTINCT FROM expected_effort;
COMMENT ON VIEW sample_method_out_of_step IS 'Samples whose method, trap count or old effort column is not what the sample says. Each row names the clause it fails: method (the stored method is not the one method_text gives the method as written, and no row where the text is not listed, so a row on an unlisted text and no row on a listed one both fail), count (a trap count on a method that is not a trap), effort (sample.sampling_effort is not the text the one writer would write for the stored count and method). The trap count is sample_method.trap_count and is never read from text. Always empty: every writer keeps all of it in one transaction, and the nightly fails when this view is not empty.';

CREATE VIEW sample_kind_method_mismatch AS
SELECT s.entity_id AS sample_id, s.kind, m.method_code, md.is_trap
FROM sample s
JOIN sample_method m ON m.sample_id = s.entity_id
JOIN method md ON md.code = m.method_code
WHERE (s.kind = 'trap') <> md.is_trap;
COMMENT ON VIEW sample_kind_method_mismatch IS 'Samples whose kind says trap where the method is not a trap, or net where it is. Informational and not asserted: kind is set from the dates and the method as written, so the two disagree where the end date and the words do (976 on production on 2026-11-23, all in settled seasons).';

COMMENT ON COLUMN sample.protocol IS 'The method as written, and never parsed: for a sample from old records the text as they wrote it or as staff corrected it (''vane trap'', ''6 Vane Traps''); for a sample made in Beeline the code of its method. The method itself is sample_method (schema/031), which every writer sets in the same transaction, and sample_method_out_of_step asserts the two agree.';
COMMENT ON COLUMN sample.sampling_effort IS 'The old effort column, kept filled until it is retired and never read: it is the text setSampleMethodRow (src/sample-method-row.ts) writes from sample_method.trap_count and the method ("6 vane traps"), and null where there is no count. The trap count is sample_method.trap_count; sample_method_out_of_step asserts the two agree.';
