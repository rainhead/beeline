-- Migration for schema/010 (atlas_printing), schema/030
-- (specimen.occurrence_id), schema/035_print_runs.sql,
-- schema/117_view_individuated_specimen.sql, schema/155_views_print_run.sql,
-- and the two views that now count individuated specimens rather than
-- specimen rows — qc_rule_count_below_printed (schema/120) and
-- pending_print_sample (schema/150) — for beeline-1kb.2: print runs exist.
-- The tables arrive empty; no backfill, since nothing Beeline has printed
-- yet, and with no print runs the two replaced views answer exactly as
-- before. Two things DuckDB would not let a migration do shaped the schema
-- itself: it cannot ADD COLUMN with a constraint, and it cannot add a
-- NOT NULL column to a table other tables reference at all — which is why
-- "prints its own labels" is a satellite row (atlas_printing) and not a
-- column on atlas, and why occurrence_id's uniqueness is an index rather
-- than an inline UNIQUE. It also refuses to create an index in the
-- transaction that altered the table ("outstanding updates"), and
-- pnpm db:migrate runs each file in one, so that index is 0031's.
ALTER TABLE specimen ADD COLUMN occurrence_id TEXT;
COMMENT ON COLUMN specimen.field_number IS 'The number Beeline issues and prints on the label (CONTEXT.md, beeline-nfo) — never the museum''s catalog number, which arrives from Ecdysis with its institutional prefix and gets its own column when import lands. Opaque verbatim text: all four historical identifier eras land here, including the era of duplicates — so no UNIQUE. A number Beeline mints is written here AND as a row in minted_field_number (schema/035), whose PRIMARY KEY is the guarantee (ADR 0008); specimen_field_number_stale (schema/155) checks that the two agree. Not indexed, deliberately: an indexed column on a row a determination references could never be updated (duckdb/duckdb#20246), and a duplicate repair will one day update this one.';
COMMENT ON COLUMN specimen.occurrence_id IS 'dwc:occurrenceID — the specimen''s permanent identity downstream, minted once by a print run (a UUID v7, generated in src/print-run.ts) and never changed (ADR 0008 §1). NULL on every imported specimen: the legacy corpus''s own occurrenceIDs are not unique (216 values on 598 records, beeline-1kb.14) and are kept in staging until the export phase decides what to publish for them. Nothing reads meaning out of it.';

-- Which atlases print their own labels: a row is the flag, the way a
-- person_admin row is. None today — Oregon prints for the whole program, so
-- a print run with no atlas covers every atlas absent from this table, plus
-- samples outside any atlas (print_scope_sample, schema/155); add an atlas
-- here and its samples wait for a run scoped to it. A satellite rather than
-- a column on atlas because DuckDB cannot add a NOT NULL column to a table
-- other tables reference (atlas_region does), so a migration could not have
-- put the column there without leaving a nullable one that a fresh build
-- would not have.
CREATE TABLE atlas_printing (
  atlas_id INTEGER PRIMARY KEY REFERENCES atlas(entity_id)
);
COMMENT ON TABLE atlas_printing IS 'Atlases that print their own labels; presence is the flag. Empty today: Oregon prints for every atlas. An unscoped print run freezes the samples of every atlas NOT here (print_scope_sample), and an atlas here gets labels only from a run scoped to it.';

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

-- Which specimen rows count as individuated — as holding a place in the
-- sample's 1..N that a label has been, or is about to be, printed for. Every
-- specimen row does, except one whose every label belongs to a canceled
-- print run. Cancelling a run destroys nothing (schema/035): DuckDB cannot
-- delete a referenced row in the transaction that removed its references
-- (its foreign-key checking is eager), and a cancel that half-succeeded
-- would leave specimens no run holds, which read as printed. So a canceled
-- run keeps its labels as history, its specimens keep their rows with the
-- field number cleared and burned in the registry, and this view is what
-- takes them back out of the count — pending_print_sample (schema/150) and
-- qc_rule_count_below_printed (schema/120) both read it, and the next run's
-- freeze re-adopts the rows rather than inserting beside them. An imported
-- specimen has no labels at all and is individuated by the first test.
CREATE VIEW individuated_specimen AS
SELECT sp.entity_id AS specimen_id, sp.sample_id, sp.specimen_number
FROM specimen sp
WHERE NOT EXISTS (SELECT 1 FROM printed_label pl WHERE pl.specimen_id = sp.entity_id)
   OR EXISTS (SELECT 1 FROM printed_label pl
              JOIN print_run r ON r.entity_id = pl.print_run_id
              WHERE pl.specimen_id = sp.entity_id AND r.canceled_at IS NULL);
COMMENT ON VIEW individuated_specimen IS 'Specimen rows that occupy a place in their sample''s count: imported ones, and ones a live (uncanceled) print run holds a label for. A specimen left behind by a canceled run is not here until a later run re-adopts it.';

-- schema/120: the count rule reads individuated specimens.
CREATE OR REPLACE VIEW qc_rule_count_below_printed AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'count_below_printed' AS rule_name,
       concat(printed.n, ' specimens printed but count is ', s.specimen_count) AS details
FROM sample s
JOIN (
  SELECT sample_id, count(*) AS n FROM individuated_specimen GROUP BY sample_id
) printed ON printed.sample_id = s.entity_id
WHERE printed.n > s.specimen_count;

-- schema/150: pending counts individuated specimens.
CREATE OR REPLACE VIEW pending_print_sample AS
SELECT s.entity_id AS sample_id,
       -- CAST because count() is 64-bit: the app reads this as a plain number.
       CAST(s.specimen_count - coalesce(printed.n, 0) AS INTEGER) AS pending_count
FROM printable_sample p
JOIN sample s ON s.entity_id = p.sample_id
LEFT JOIN (
  SELECT sample_id, count(*) AS n FROM individuated_specimen GROUP BY sample_id
) printed ON printed.sample_id = s.entity_id
WHERE s.specimen_count > coalesce(printed.n, 0);

-- What the print-run tables (schema/035) mean, as views. After 150 because
-- print_scope_sample reads pending_print_sample.

-- A run's state, read off its timestamps. The CHECKs on print_run order
-- them; this is the one place the ordering is turned into a word.
CREATE VIEW print_run_state AS
SELECT r.entity_id AS print_run_id,
       CASE WHEN r.canceled_at IS NOT NULL THEN 'canceled'
            WHEN r.mailed_at   IS NOT NULL THEN 'mailed'
            WHEN r.printed_at  IS NOT NULL THEN 'printed'
            WHEN r.approved_at IS NOT NULL THEN 'approved'
            ELSE 'prepared' END AS state,
       -- CAST because count() is 64-bit, as pending_print_sample does.
       CAST(coalesce(l.label_count, 0)     AS INTEGER) AS label_count,
       CAST(coalesce(l.sheet_count, 0)     AS INTEGER) AS sheet_count,
       CAST(coalesce(l.sample_count, 0)    AS INTEGER) AS sample_count,
       CAST(coalesce(l.collector_count, 0) AS INTEGER) AS collector_count
FROM print_run r
LEFT JOIN (
  SELECT pl.print_run_id,
         count(*)                      AS label_count,
         max(pl.sheet)                 AS sheet_count,
         count(DISTINCT sp.sample_id)  AS sample_count,
         count(DISTINCT pc.person_id)  AS collector_count
  FROM printed_label pl
  JOIN specimen sp ON sp.entity_id = pl.specimen_id
  JOIN sample_primary_collector pc ON pc.sample_id = sp.sample_id
  GROUP BY pl.print_run_id
) l ON l.print_run_id = r.entity_id;
COMMENT ON VIEW print_run_state IS 'Per print run: its state (prepared, approved, printed, mailed, canceled) derived from which timestamps are set, and how many labels, sheets, samples and collectors it holds. A canceled run keeps its counts: its labels stay as the record of what was prepared and never printed.';

-- What a run with no atlas covers: every pending sample whose atlas does not
-- print its own labels (no atlas_printing row, schema/010), and every pending
-- sample outside the atlases (either no sample_atlas row, or a row a human
-- set to no atlas). Oregon prints for the whole program today, so with
-- atlas_printing empty this is simply pending_print_sample; the table is what
-- lets one atlas take over its own printing without a code change. The
-- Prepare screen's counts and the freeze itself both read this view, so they
-- cannot disagree.
CREATE VIEW print_scope_sample AS
SELECT p.sample_id, p.pending_count
FROM pending_print_sample p
LEFT JOIN sample_atlas sa ON sa.sample_id = p.sample_id
LEFT JOIN atlas_printing ap ON ap.atlas_id = sa.atlas_id
WHERE ap.atlas_id IS NULL;
COMMENT ON VIEW print_scope_sample IS 'The pending samples an unscoped print run freezes: those filed under an atlas that does not print its own labels (absent from atlas_printing), or under no atlas at all. A run scoped to one atlas reads pending_print_sample joined to sample_atlas instead.';

-- Samples whose labels are on paper — the ones that stop following
-- iNaturalist for date, locality and coordinates (CONTEXT.md, Upstream;
-- beeline-1kb.2). A specimen row is on paper when a printed run holds a
-- label for it, OR when no run holds any label for it at all, which is every
-- imported specimen: the legacy system printed them, the labels are on pins,
-- and Peter decided (2026-09-14) that they lock too. A specimen frozen into
-- a run that has not printed, or only into runs since canceled, is on paper
-- by neither test, so a canceled run locks nothing and neither does a
-- prepared one — and a printed specimen being reprinted in a later,
-- unprinted run stays locked, because its first run still says printed. Promotion reads this view (ingest/mint-samples.sql,
-- ingest/promote-observations.sql); nothing else should reinvent it.
CREATE VIEW printed_sample AS
SELECT DISTINCT sp.sample_id
FROM specimen sp
WHERE EXISTS (
        SELECT 1 FROM printed_label pl
        JOIN print_run r ON r.entity_id = pl.print_run_id
        WHERE pl.specimen_id = sp.entity_id AND r.printed_at IS NOT NULL)
   OR NOT EXISTS (
        SELECT 1 FROM printed_label pl WHERE pl.specimen_id = sp.entity_id);
COMMENT ON VIEW printed_sample IS 'Samples with at least one label on paper: printed by a Beeline print run, or imported (the legacy system printed every specimen it holds). These keep their date, locality and coordinates when iNaturalist changes them; a sample frozen into an unprinted run is not here, so a canceled run holds nothing back.';

-- A specimen's labels, with the state of the run each came from: what the
-- specimen page shows and what the proofing lookup reads beside a number
-- (reference-implementation.md, requirement 6). An imported specimen has no
-- rows here, which the page spells out rather than leaving blank.
CREATE VIEW specimen_label AS
SELECT pl.specimen_id, pl.print_run_id, pl.sheet, pl.cell, pl.number_text,
       s.state, r.prepared_at, r.approved_at, r.printed_at, r.mailed_at, r.canceled_at
FROM printed_label pl
JOIN print_run r ON r.entity_id = pl.print_run_id
JOIN print_run_state s ON s.print_run_id = r.entity_id;
COMMENT ON VIEW specimen_label IS 'One row per label a specimen has had: which run, where on which sheet, and how far that run got. Two rows for one specimen is a reprint; none is an imported specimen.';

-- The current number a minted specimen carries, derived exactly as
-- determination_of_record derives the determination (schema/110): the latest
-- registry row, ordered by minted_at then entity_id, since after a duplicate
-- repair the replacement number is not reliably the larger (ADR 0008 §6).
CREATE VIEW specimen_minted_field_number AS
SELECT specimen_id, field_number, print_run_id, minted_at
FROM (
  SELECT m.*,
         row_number() OVER (
           PARTITION BY specimen_id
           ORDER BY minted_at DESC, entity_id DESC
         ) AS rn
  FROM minted_field_number m
  WHERE specimen_id IS NOT NULL
) ranked
WHERE rn = 1;
COMMENT ON VIEW specimen_minted_field_number IS 'Per specimen Beeline has minted a number for: the number it currently carries, the latest registry row. Its earlier rows are its superseded numbers — dwc:otherCatalogNumbers, when the export needs them.';

-- Two checks the engine cannot hold, asserted empty by test, the shape of
-- sample_elevation_stale. The first: specimen.field_number is the column
-- every read uses, and the registry is the guarantee, so the two must agree
-- on every minted specimen. The second is ADR 0008 §7: the registry's key
-- cannot see the imported numbers, so a mint that lands on a number some
-- imported specimen already wears is only ever caught here.
CREATE VIEW specimen_field_number_stale AS
SELECT c.specimen_id, sp.field_number AS carried, c.field_number AS minted
FROM specimen_minted_field_number c
JOIN specimen sp ON sp.entity_id = c.specimen_id
WHERE sp.field_number IS DISTINCT FROM c.field_number;
COMMENT ON VIEW specimen_field_number_stale IS 'Minted specimens whose specimen.field_number is not the number the registry says is current. Expected empty; a row means a writer touched one and not the other.';

CREATE VIEW minted_field_number_collision AS
SELECT m.field_number, m.specimen_id AS minted_for, sp.entity_id AS also_on
FROM minted_field_number m
JOIN specimen sp ON sp.field_number = m.field_number
WHERE sp.entity_id IS DISTINCT FROM m.specimen_id;
COMMENT ON VIEW minted_field_number_collision IS 'Minted numbers that some other specimen also carries — an imported one, since two minted rows cannot share a number. Expected empty: the seed reads the imported ceiling as well as the registry (ADR 0008 §7).';
