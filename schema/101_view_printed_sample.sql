-- Defined ahead of minting (schema/108) and the QC rules (schema/120), which
-- read it to tell a sample still to print from one already on paper
-- (beeline-0199). It reads tables only, so it can sit this early; it lived
-- in schema/155 with the print-run views until then.
--
-- Which labels are reprints (gh-218): a label whose run did not mint the
-- number it carries. Every first print has its registry row in its own run —
-- a burned one too, which keeps its number and run when the cancel takes its
-- specimen away (schema/035) — so a label with none there is a later print
-- under a number minted before, or one an imported specimen brought from the
-- old system. Read off the registry rather than written on the label, so
-- there is no flag to keep in step with it.
CREATE VIEW printed_label_reprint AS
SELECT pl.print_run_id, pl.specimen_id
FROM printed_label pl
WHERE NOT EXISTS (
  SELECT 1 FROM minted_field_number m
  WHERE m.print_run_id = pl.print_run_id AND m.field_number = pl.number_text
);
COMMENT ON VIEW printed_label_reprint IS 'The labels that are reprints: their run did not mint the number they carry, which it did for every first print. A reprint is of a number minted in an earlier run, or of an imported specimen''s.';

-- Samples whose labels are on paper — the ones that stop following
-- iNaturalist for date, locality and coordinates (CONTEXT.md, Upstream;
-- beeline-1kb.2). A specimen row is on paper when a printed run holds a
-- label for it, OR when no run ever minted it a number, which is every
-- imported specimen: the legacy system printed them, the labels are on pins,
-- and Peter decided (2026-09-14) that they lock too. A specimen frozen into
-- a run that has not printed, or only into runs since canceled, is on paper
-- by neither test, so a canceled run locks nothing and neither does a
-- prepared one — and a printed specimen being reprinted in a later,
-- unprinted run stays locked, because its first run still says printed.
-- "Minted" and not "has any label", because an imported specimen can have
-- one now: a reprint waiting in an unprinted run would otherwise unlock a
-- sample whose labels have been on pins for years (gh-218). Promotion reads
-- this view (ingest/mint-samples.sql, ingest/promote-observations.sql);
-- nothing else should reinvent it.
--
-- Both tests read off one pass over the labels, each specimen's labels
-- reduced to whether any is in a printed run and whether any minted it: no
-- first print is the imported case. The EXISTS / NOT EXISTS pair this
-- replaced asked two questions as two subqueries over ~400,000 specimens,
-- 33 ms against 8 ms on the sandbox's store, and the QC rules read this view
-- on every listing page (migrations/0056).
CREATE VIEW printed_sample AS
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
