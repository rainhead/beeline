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
       s.state, r.prepared_at, r.approved_at, r.printed_at, r.mailed_at, r.canceled_at,
       (rp.specimen_id IS NOT NULL) AS reprint
FROM printed_label pl
JOIN print_run r ON r.entity_id = pl.print_run_id
JOIN print_run_state s ON s.print_run_id = r.entity_id
LEFT JOIN printed_label_reprint rp ON rp.print_run_id = pl.print_run_id AND rp.specimen_id = pl.specimen_id;
COMMENT ON VIEW specimen_label IS 'One row per label a specimen has had: which run, where on which sheet, how far that run got, and whether it was a reprint (printed_label_reprint). None is an imported specimen that has never been reprinted.';

-- Reprint requests not yet answered (gh-218, schema/035): not withdrawn, and
-- no uncanceled run prepared at or after the request holds a label for the
-- specimen. A request is answered the moment a run freezes it, as a sample
-- stops being pending at the freeze, and a cancel brings it back here by
-- itself. This is everything asked for, blocked or not; what a run can take
-- is printable_reprint.
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

-- What a run can take of them. A reprint is a person asking for one label,
-- so it is not held to printability: an imported sample can carry flags that
-- were never anybody's to fix, and the reprint of a label already on a pin
-- should not wait on them. It waits only on the flags no waiver can set
-- aside (qc_rule_unwaivable, schema/050), because those are the ones that
-- would print something false or something an atlas has not agreed to: a
-- staff hold, a field the label cannot be printed without, an obscured point
-- with no true one behind it, or a taxon-obscured point its atlas has not
-- said may print. Nothing from a settled season is excluded, unlike
-- pending_print_sample: a person asked for this label. And a reprint needs a
-- number to print: a request is refused for a specimen without one, so this
-- only matters if its number is taken away after it was asked for.
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

-- The reprints an unscoped run takes, by the same rule as print_scope_sample.
CREATE VIEW print_scope_reprint AS
SELECT p.*
FROM printable_reprint p
LEFT JOIN sample_atlas sa ON sa.sample_id = p.sample_id
LEFT JOIN atlas_printing ap ON ap.atlas_id = sa.atlas_id
WHERE ap.atlas_id IS NULL;
COMMENT ON VIEW print_scope_reprint IS 'The printable reprints an unscoped print run takes: those of samples filed under an atlas that does not print its own labels, or under none. A run scoped to one atlas reads printable_reprint joined to sample_atlas instead.';

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

-- Labels in a run that has not printed, whose sample no longer has the
-- values they were made from (beeline-fq3j). A run's labels are fixed when
-- it is prepared, but its samples are not printed yet, so they still follow
-- iNaturalist and the nightly jobs, and staff can still edit them: on the
-- first production run (2026-11-04) localities were being corrected during
-- proofing, and the run page said nothing about which labels those edits had
-- left behind. printed_label keeps the values each label was rendered from
-- (src/print-run.ts, inputFor), so the comparison is with those, never with
-- the label text. One row per label and field that differs, the field named
-- in a fixed vocabulary so the run page can word it.
--
-- The collector line is not compared: a label keeps its text, not the list
-- of collectors it was made from.
CREATE VIEW printed_label_out_of_date AS
WITH open_label AS (
  SELECT pl.print_run_id, pl.specimen_id, sp.sample_id,
         pl.locality, pl.county, pl.state_province, pl.country,
         pl.latitude, pl.longitude, pl.elevation_m, pl.date_start, pl.date_end
  FROM printed_label pl
  JOIN print_run r ON r.entity_id = pl.print_run_id
  JOIN specimen sp ON sp.entity_id = pl.specimen_id
  WHERE r.printed_at IS NULL AND r.canceled_at IS NULL
),
pair AS (
  SELECT l.*,
         s.locality AS now_locality, s.county AS now_county,
         s.state_province AS now_state_province, s.country AS now_country,
         loc.latitude AS now_latitude, loc.longitude AS now_longitude, loc.elevation_m AS now_elevation_m,
         s.date_start AS now_date_start, s.date_end AS now_date_end
  FROM open_label l
  JOIN sample s ON s.entity_id = l.sample_id
  LEFT JOIN sample_location loc ON loc.sample_id = l.sample_id
)
SELECT print_run_id, specimen_id, sample_id, 'locality' AS field,
       locality AS on_label, now_locality AS now
FROM pair WHERE locality IS DISTINCT FROM now_locality
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'county', county, now_county
FROM pair WHERE county IS DISTINCT FROM now_county
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'state_province', state_province, now_state_province
FROM pair WHERE state_province IS DISTINCT FROM now_state_province
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'country', country, now_country
FROM pair WHERE country IS DISTINCT FROM now_country
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'coordinates',
       concat(CAST(latitude AS TEXT), ' ', CAST(longitude AS TEXT)),
       CASE WHEN now_latitude IS NOT NULL THEN concat(CAST(now_latitude AS TEXT), ' ', CAST(now_longitude AS TEXT)) END
FROM pair WHERE latitude IS DISTINCT FROM now_latitude OR longitude IS DISTINCT FROM now_longitude
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'elevation',
       CAST(elevation_m AS TEXT), CAST(now_elevation_m AS TEXT)
FROM pair WHERE elevation_m IS DISTINCT FROM now_elevation_m
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'dates',
       concat(CAST(date_start AS TEXT), ' – ', CAST(date_end AS TEXT)),
       concat(CAST(now_date_start AS TEXT), ' – ', CAST(now_date_end AS TEXT))
FROM pair WHERE date_start IS DISTINCT FROM now_date_start OR date_end IS DISTINCT FROM now_date_end;
COMMENT ON VIEW printed_label_out_of_date IS 'Labels in a run not yet printed (and not canceled) whose sample has changed since the run was prepared: one row per label and changed field (locality, county, state_province, country, coordinates, elevation, dates), with the value on the label and the value now. The run page lists these so the printer can cancel and prepare again, or print and reprint (beeline-fq3j). The collector line is not compared.';

-- How many of each sample's specimens have no label on paper yet
-- (beeline-3v33), for the listings: "waiting on labels" as a filter, and the
-- count beside the sample's specimens. Unlike pending_print_sample it does not
-- ask whether the sample can print, so a sample held back by a flag is here,
-- which is the question staff ask of it: what still needs labels, and (with
-- the Flags filter) what is stopping it. A specimen in a run that has not
-- printed is still waiting. Settled samples are left out, as they are from
-- printing: nothing from a settled season prints, so none of it is waiting.
-- Specimens numbered above the count do not count against it, as in
-- pending_print_sample (qc_rule_count_below_printed names them).
CREATE VIEW sample_labels_waiting AS
SELECT s.entity_id AS sample_id,
       CAST(s.specimen_count - coalesce(paper.n, 0) AS INTEGER) AS waiting
FROM sample s
LEFT JOIN (
  SELECT o.sample_id, count(*) AS n
  FROM specimen_on_paper o
  JOIN sample held ON held.entity_id = o.sample_id
  WHERE o.specimen_number <= held.specimen_count
  GROUP BY o.sample_id
) paper ON paper.sample_id = s.entity_id
WHERE s.specimen_count > coalesce(paper.n, 0)
  AND NOT EXISTS (SELECT 1 FROM settled_sample st WHERE st.sample_id = s.entity_id);
COMMENT ON VIEW sample_labels_waiting IS 'Samples in an active season with specimens whose labels are not on paper yet, and how many: printable or held back by a flag, and including specimens in a run that has not printed. The listings'' "waiting on labels" filter (beeline-3v33).';
