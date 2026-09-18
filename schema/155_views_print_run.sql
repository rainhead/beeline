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

-- Labels on their way: per sample, how many are in a live print run that has
-- not been mailed — still being printed (the run is prepared or approved),
-- or on paper and not yet in the post. This exists because the freeze takes
-- a sample out of pending_print_sample the moment it happens, and the
-- collector's front page listed only what was pending: a sample vanished
-- from it when its run was prepared, days before an envelope went anywhere,
-- which read as the labels having been dealt with (Peter, demonstrating the
-- first run, 2026-09-18). Waiting on labels ends when they are mailed, not
-- when somebody presses Prepare. A canceled run counts for nothing here; its
-- samples are pending again.
CREATE VIEW sample_label_in_progress AS
SELECT sp.sample_id,
       CAST(count(*) FILTER (WHERE r.printed_at IS NULL)     AS INTEGER) AS printing_count,
       CAST(count(*) FILTER (WHERE r.printed_at IS NOT NULL) AS INTEGER) AS printed_count,
       max(r.printed_at) AS printed_at
FROM printed_label pl
JOIN print_run r ON r.entity_id = pl.print_run_id
JOIN specimen sp ON sp.entity_id = pl.specimen_id
WHERE r.canceled_at IS NULL AND r.mailed_at IS NULL
GROUP BY sp.sample_id;
COMMENT ON VIEW sample_label_in_progress IS 'Per sample with labels in a live, unmailed print run: how many are still being printed and how many are printed but not yet mailed. What keeps a sample on its collector''s front page between the freeze and the envelope.';

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
