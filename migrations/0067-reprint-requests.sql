-- Migration for schema/035, schema/101, schema/117 and schema/155 (gh-218,
-- beeline-1kb.5.1): reprint requests. One new table, arriving empty, and the
-- views that tell a reprint from a first print. printed_sample and
-- individuated_specimen change meaning only for a specimen with a reprint,
-- and there is none yet, so nothing they say about the store today moves:
-- both now ask whether a run minted the specimen its number rather than
-- whether it has any label, because an imported specimen can have a label
-- now. print_run_state and specimen_label gain a column each.

CREATE TABLE reprint_request (
  entity_id    INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  specimen_id  INTEGER NOT NULL REFERENCES specimen(entity_id),
  requested_by INTEGER NOT NULL REFERENCES person(entity_id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason       TEXT CHECK (reason IN ('never_received', 'damaged', 'data_corrected')),
  note         TEXT,
  withdrawn_by INTEGER,
  withdrawn_at TIMESTAMPTZ,
  CHECK ((withdrawn_by IS NULL) = (withdrawn_at IS NULL)),
  CHECK (withdrawn_at IS NULL OR withdrawn_at >= requested_at)
);
COMMENT ON TABLE reprint_request IS 'A request to print a specimen''s label again under its existing field number (gh-218). Answered by the first uncanceled print run prepared at or after it that holds a label for the specimen; pending_reprint is the ones not yet answered. A reason is optional (Peter, 2026-10-30).';
COMMENT ON COLUMN reprint_request.reason IS 'Why, as one of the quick choices, or NULL: never_received (the label did not arrive), damaged (cut, marred or lost), data_corrected (the record was fixed after the label printed). The note can say more, or say it instead.';
COMMENT ON COLUMN reprint_request.withdrawn_by IS 'Who took the request back before a run took it. A person entity_id, not a foreign key, so the withdrawing UPDATE touches no index.';

CREATE VIEW printed_label_reprint AS
SELECT pl.print_run_id, pl.specimen_id
FROM printed_label pl
WHERE NOT EXISTS (
  SELECT 1 FROM minted_field_number m
  WHERE m.print_run_id = pl.print_run_id AND m.field_number = pl.number_text
);
COMMENT ON VIEW printed_label_reprint IS 'The labels that are reprints: their run did not mint the number they carry, which it did for every first print. A reprint is of a number minted in an earlier run, or of an imported specimen''s.';

CREATE OR REPLACE VIEW printed_sample AS
SELECT DISTINCT sp.sample_id
FROM specimen sp
LEFT JOIN (
  SELECT pl.specimen_id,
         bool_or(r.printed_at IS NOT NULL) AS on_paper,
         bool_or(m.field_number IS NOT NULL) AS minted
  FROM printed_label pl
  JOIN print_run r ON r.entity_id = pl.print_run_id
  LEFT JOIN minted_field_number m ON m.print_run_id = pl.print_run_id AND m.field_number = pl.number_text
  GROUP BY pl.specimen_id
) label ON label.specimen_id = sp.entity_id
WHERE label.specimen_id IS NULL OR label.on_paper OR NOT label.minted;
COMMENT ON VIEW printed_sample IS 'Samples with at least one label on paper: printed by a Beeline print run, or imported (the legacy system printed every specimen it holds, and a reprint waiting for one does not change that). These keep their date, locality and coordinates when iNaturalist changes them; a sample frozen into an unprinted run is not here, so a canceled run holds nothing back.';

CREATE OR REPLACE VIEW individuated_specimen AS
SELECT sp.entity_id AS specimen_id, sp.sample_id, sp.specimen_number
FROM specimen sp
WHERE NOT EXISTS (SELECT 1 FROM printed_label pl
                  JOIN minted_field_number m
                    ON m.print_run_id = pl.print_run_id AND m.field_number = pl.number_text
                  WHERE pl.specimen_id = sp.entity_id)
   OR EXISTS (SELECT 1 FROM printed_label pl
              JOIN print_run r ON r.entity_id = pl.print_run_id
              WHERE pl.specimen_id = sp.entity_id AND r.canceled_at IS NULL);
COMMENT ON VIEW individuated_specimen IS 'Specimen rows that occupy a place in their sample''s count: imported ones, and ones a live (uncanceled) print run holds a label for. A specimen left behind by a canceled run is not here until a later run re-adopts it; a canceled reprint takes nothing out.';

CREATE OR REPLACE VIEW print_run_state AS
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
       CAST(coalesce(l.collector_count, 0) AS INTEGER) AS collector_count,
       CAST(coalesce(l.reprint_count, 0)   AS INTEGER) AS reprint_count
FROM print_run r
LEFT JOIN (
  SELECT pl.print_run_id,
         count(*)                      AS label_count,
         max(pl.sheet)                 AS sheet_count,
         count(DISTINCT sp.sample_id)  AS sample_count,
         count(DISTINCT pc.person_id)  AS collector_count,
         count(rp.specimen_id)         AS reprint_count
  FROM printed_label pl
  JOIN specimen sp ON sp.entity_id = pl.specimen_id
  JOIN sample_primary_collector pc ON pc.sample_id = sp.sample_id
  LEFT JOIN printed_label_reprint rp ON rp.print_run_id = pl.print_run_id AND rp.specimen_id = pl.specimen_id
  GROUP BY pl.print_run_id
) l ON l.print_run_id = r.entity_id;
COMMENT ON VIEW print_run_state IS 'Per print run: its state (prepared, approved, printed, mailed, canceled) derived from which timestamps are set, and how many labels, sheets, samples and collectors it holds, and how many of the labels are reprints. A canceled run keeps its counts: its labels stay as the record of what was prepared and never printed.';

CREATE OR REPLACE VIEW specimen_label AS
SELECT pl.specimen_id, pl.print_run_id, pl.sheet, pl.cell, pl.number_text,
       s.state, r.prepared_at, r.approved_at, r.printed_at, r.mailed_at, r.canceled_at,
       (rp.specimen_id IS NOT NULL) AS reprint
FROM printed_label pl
JOIN print_run r ON r.entity_id = pl.print_run_id
JOIN print_run_state s ON s.print_run_id = r.entity_id
LEFT JOIN printed_label_reprint rp ON rp.print_run_id = pl.print_run_id AND rp.specimen_id = pl.specimen_id;
COMMENT ON VIEW specimen_label IS 'One row per label a specimen has had: which run, where on which sheet, how far that run got, and whether it was a reprint (printed_label_reprint). None is an imported specimen that has never been reprinted.';

CREATE VIEW pending_reprint AS
SELECT q.entity_id AS reprint_request_id, q.specimen_id, sp.sample_id,
       q.requested_by, q.requested_at, q.reason, q.note
FROM reprint_request q
JOIN specimen sp ON sp.entity_id = q.specimen_id
WHERE q.withdrawn_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM printed_label pl
    JOIN print_run r ON r.entity_id = pl.print_run_id
    WHERE pl.specimen_id = q.specimen_id
      AND r.canceled_at IS NULL
      AND r.prepared_at >= q.requested_at);
COMMENT ON VIEW pending_reprint IS 'Reprint requests waiting for a run: neither withdrawn nor taken by an uncanceled print run prepared since. Includes those a flag is holding back; printable_reprint is what a run takes.';

CREATE VIEW printable_reprint AS
SELECT p.*
FROM pending_reprint p
JOIN specimen sp ON sp.entity_id = p.specimen_id
WHERE sp.field_number IS NOT NULL
  AND NOT EXISTS (
  SELECT 1 FROM sample_qc_finding f
  JOIN qc_rule_unwaivable u ON u.name = f.rule_name
  WHERE f.sample_id = p.sample_id);
COMMENT ON VIEW printable_reprint IS 'The pending reprints a print run can take: those of a specimen with a field number whose sample has no finding from qc_rule_unwaivable (a staff hold, a missing required field, an obscured point without a true one, a taxon-obscured point awaiting its atlas). The rest wait in pending_reprint.';

CREATE VIEW print_scope_reprint AS
SELECT p.*
FROM printable_reprint p
LEFT JOIN sample_atlas sa ON sa.sample_id = p.sample_id
LEFT JOIN atlas_printing ap ON ap.atlas_id = sa.atlas_id
WHERE ap.atlas_id IS NULL;
COMMENT ON VIEW print_scope_reprint IS 'The printable reprints an unscoped print run takes: those of samples filed under an atlas that does not print its own labels, or under none. A run scoped to one atlas reads printable_reprint joined to sample_atlas instead.';
