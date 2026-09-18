-- Print runs (beeline-1kb.2, ADR 0008). A run is the batch act of printing:
-- the printer says "I'm ready to print now", and that moment FREEZES the set
-- of printable samples — the run creates their specimen rows, mints their
-- field numbers and occurrenceIDs, and snapshots what each label will say.
-- From then on the run moves prepared → approved → printed → mailed, or is
-- canceled before it prints. Nothing here is recomputable: a rebuild must
-- not remint (CONTEXT.md, Data handling), and a deployed store is migrated,
-- never reseeded (ADR 0006).
--
-- State is derived from the timestamps rather than kept in a column: the
-- CHECKs order them, and print_run_state (schema/155) names the state, so
-- there is no copy to police. Every "who" after prepared_by is a plain
-- INTEGER rather than a foreign key, deliberately: a foreign key makes the
-- column indexed, and DuckDB refuses to UPDATE an indexed column on a row an
-- incoming foreign key references (duckdb/duckdb#20246, pinned in
-- test/schema.test.ts) — and every run is referenced by its labels from the
-- moment it exists, so approving it would have been impossible. prepared_by
-- is written at INSERT and can stay a reference.
CREATE TABLE print_run (
  entity_id    INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  atlas_id     INTEGER REFERENCES atlas(entity_id),
  prepared_by  INTEGER NOT NULL REFERENCES person(entity_id),
  prepared_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by  INTEGER,
  approved_at  TIMESTAMPTZ,
  printed_by   INTEGER,
  printed_at   TIMESTAMPTZ,
  mailed_by    INTEGER,
  mailed_at    TIMESTAMPTZ,
  canceled_by  INTEGER,
  canceled_at  TIMESTAMPTZ,
  pdf_sha256   TEXT,
  note         TEXT,
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK ((printed_by IS NULL) = (printed_at IS NULL)),
  CHECK ((mailed_by IS NULL) = (mailed_at IS NULL)),
  CHECK ((canceled_by IS NULL) = (canceled_at IS NULL)),
  CHECK (printed_at IS NULL OR approved_at IS NOT NULL),
  CHECK (mailed_at IS NULL OR printed_at IS NOT NULL),
  CHECK (canceled_at IS NULL OR printed_at IS NULL),
  CHECK (approved_at IS NULL OR approved_at >= prepared_at),
  CHECK (printed_at IS NULL OR printed_at >= approved_at),
  CHECK (mailed_at IS NULL OR mailed_at >= printed_at)
);
COMMENT ON TABLE print_run IS 'One batch act of printing labels (CONTEXT.md, Print run). Preparing it is the freeze: the run creates specimen rows for every pending printable sample in its scope, mints their field numbers and occurrenceIDs, and snapshots each label in printed_label. State is derived from which timestamps are set (print_run_state): prepared → approved → printed → mailed, or canceled while unprinted. Once printed, the samples it covers stop following iNaturalist for date, locality and coordinates (printed_sample).';
COMMENT ON COLUMN print_run.atlas_id IS 'The run''s scope. NULL is the ordinary run today: every atlas that does not print its own labels (absent from atlas_printing), plus samples collected outside any atlas (print_scope_sample). Set, the run covers that atlas only, whether or not it prints its own — which is how an atlas that does runs one.';
COMMENT ON COLUMN print_run.prepared_by IS 'Who froze it. The one author column that is a foreign key, because it is written at INSERT, before any label references the run.';
COMMENT ON COLUMN print_run.approved_by IS 'Who proofed it and said print. A person entity_id, not a foreign key — see the note above the table.';
COMMENT ON COLUMN print_run.printed_by IS 'Who marked the labels as on paper. The moment that matters: from printed_at the samples in this run are locked against upstream edits to date, locality and coordinates.';
COMMENT ON COLUMN print_run.mailed_by IS 'Who marked the envelopes as sent. Per run for now; per collector when mailing addresses exist (beeline-1kb.6, beeline-1kb.16).';
COMMENT ON COLUMN print_run.canceled_by IS 'Who canceled it. Only an unprinted run can be canceled, and cancelling destroys nothing: its labels stay as history, its specimens keep their rows with field_number cleared (individuated_specimen, schema/117, takes them out of the count), and its numbers stay burned in minted_field_number.';
COMMENT ON COLUMN print_run.pdf_sha256 IS 'Hash of the sheets as first rendered, recorded so that a later re-render from printed_label can be checked byte-identical rather than assumed.';
COMMENT ON COLUMN print_run.note IS 'Free text from the printer: what was odd about this run, why it was canceled.';

-- The registry: the INSERT is the mint (ADR 0008 §5–6). Uniqueness among the
-- numbers Beeline mints is this PRIMARY KEY and nothing else — no code
-- assigns a field number except by inserting a row here, and a number absent
-- from this table was not minted by Beeline. It cannot see the 383,031
-- imported numbers on specimen.field_number, so not colliding with those is
-- a stated rule (the seed reads the imported ceiling too, src/print-run.ts)
-- checked by minted_field_number_collision (schema/155). One row per NUMBER,
-- not per specimen: a duplicate repair mints a specimen a second number and
-- the first row stays, so specimen_id is a plain reference and the current
-- number is the latest row — ordered by minted_at, then entity_id, exactly as
-- determination_of_record orders determinations (schema/110).
CREATE TABLE minted_field_number (
  field_number TEXT PRIMARY KEY,
  entity_id    INTEGER NOT NULL UNIQUE DEFAULT nextval('entity_id_seq'),
  print_run_id INTEGER NOT NULL REFERENCES print_run(entity_id),
  specimen_id  INTEGER REFERENCES specimen(entity_id),
  minted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE minted_field_number IS 'Every field number Beeline has ever issued, one row per number, and the PRIMARY KEY is the uniqueness guarantee (ADR 0008 §5). Legacy numbers are not here: they are attributes on specimen, governed by nothing. A row whose specimen_id is NULL is a BURNED number — minted in a run that was then canceled — and is never reissued; gaps are harmless and reuse never is.';
COMMENT ON COLUMN minted_field_number.entity_id IS 'A draw from entity_id_seq, not the key: the tie-break that makes "a specimen''s latest number" deterministic when two mints share a second (ADR 0008 §6), as determination_of_record uses it.';
COMMENT ON COLUMN minted_field_number.specimen_id IS 'The specimen this number was minted for; NULL once the run that minted it was canceled, which burns the number (the specimen row stays, with its field_number cleared, for the next run to re-adopt). Not unique: a duplicate repair gives one specimen two rows, of which the latest is current.';

-- What went on paper. Six strings exactly as the label renders them, the
-- values they were rendered from, and where on which sheet — so the sheets
-- can be re-rendered from this table alone, byte-identical, with nothing
-- live read; so a later comparison against iNaturalist (beeline-1kb.17) has
-- the printed VALUES and not just their 3-decimal text; and so a wrong label
-- can be named by run and sheet (reference-implementation.md, requirement
-- 5). Keyed by (run, specimen) rather than by specimen, because a reprint is
-- a later run holding the same specimen under the same number, and the rows
-- across runs are that specimen's label history (ADR 0008 §10).
CREATE TABLE printed_label (
  print_run_id     INTEGER NOT NULL REFERENCES print_run(entity_id),
  specimen_id      INTEGER NOT NULL REFERENCES specimen(entity_id),
  sheet            INTEGER NOT NULL CHECK (sheet >= 1),
  cell             INTEGER NOT NULL CHECK (cell >= 0 AND cell < 250),
  location_text    TEXT NOT NULL,
  coordinates_text TEXT NOT NULL,
  date_text        TEXT NOT NULL,
  collector_text   TEXT NOT NULL,
  method_text      TEXT NOT NULL,
  number_text      TEXT NOT NULL,
  latitude         DOUBLE NOT NULL,
  longitude        DOUBLE NOT NULL,
  elevation_m      INTEGER,
  date_start       DATE NOT NULL,
  date_end         DATE NOT NULL,
  locality         TEXT,
  county           TEXT,
  state_province   TEXT,
  country          TEXT,
  warnings         TEXT,
  PRIMARY KEY (print_run_id, specimen_id),
  UNIQUE (print_run_id, sheet, cell)
);
COMMENT ON TABLE printed_label IS 'One label in one print run: the snapshot of what went on paper (CONTEXT.md, Label). The *_text columns are the six fields exactly as rendered; the columns after them are the sample values they were rendered from at freeze time, kept because a printed label is immutable fact and the sample is not. A specimen printed twice has two rows; the latest in an uncanceled run is the current intended label. A canceled run''s rows stay: they say what was prepared and never printed.';
COMMENT ON COLUMN printed_label.sheet IS '1-based page of the run''s PDF.';
COMMENT ON COLUMN printed_label.cell IS 'Position on the sheet, 0..249 row-major over 25 rows of 10. Cells are skipped between collectors (a blank label, so the sheet can be cut apart by collector), which is why a sheet can hold fewer than 250 labels.';
COMMENT ON COLUMN printed_label.location_text IS 'e.g. USA:OR:BentonCo Corvallis — country:state[:county] locality, the county abbreviated for BC regional districts (src/label-text.ts).';
COMMENT ON COLUMN printed_label.coordinates_text IS 'e.g. 44.565 -123.262 72m — three decimals, elevation when known.';
COMMENT ON COLUMN printed_label.date_text IS 'e.g. 14.VII2025-3.2 — day.RomanMonth[-day.RomanMonth]year-sample.specimen; a trap range prints both ends.';
COMMENT ON COLUMN printed_label.collector_text IS 'The collector line: labelName() for one collector, both joined with & for a pair (Andony, gh-17: paired trap collectors always both print).';
COMMENT ON COLUMN printed_label.method_text IS 'net, trap or nest.';
COMMENT ON COLUMN printed_label.number_text IS 'The field number as printed, which is also what the DataMatrix encodes.';
COMMENT ON COLUMN printed_label.warnings IS 'What the proofer should look at, semicolon-separated: a missing county, a line the label had to shrink to fit (location over 38 characters, collector over 22, method over 5). Never a block — the run prints regardless — and NULL when there is nothing to say.';
