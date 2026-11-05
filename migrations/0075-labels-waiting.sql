-- Migration for schema/101_view_printed_sample.sql and
-- schema/155_views_print_run.sql: whether a specimen's label is on paper is
-- now asked per specimen (specimen_on_paper), printed_sample is the samples
-- that finds, and sample_labels_waiting counts each active sample's
-- specimens with no label on paper yet, for the listings' filter
-- (beeline-3v33). printed_sample's column does not change, so it is replaced
-- in place and the views that read it need nothing. Nothing in the store
-- changes.

CREATE VIEW specimen_on_paper AS
SELECT sp.entity_id AS specimen_id, sp.sample_id, sp.specimen_number
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
COMMENT ON VIEW specimen_on_paper IS 'Specimens whose label is on paper: printed by a Beeline print run, or imported (the legacy system printed every specimen it holds). A specimen in a run that has not printed, or only in canceled runs, is not here.';

CREATE OR REPLACE VIEW printed_sample AS
SELECT DISTINCT sample_id FROM specimen_on_paper;
COMMENT ON VIEW printed_sample IS 'Samples with at least one label on paper: printed by a Beeline print run, or imported (the legacy system printed every specimen it holds, and a reprint waiting for one does not change that). These keep their date, locality and coordinates when iNaturalist changes them; a sample frozen into an unprinted run is not here, so a canceled run holds nothing back.';

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
