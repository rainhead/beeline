-- Migration for schema/050_qc.sql, 102, 120, 150 and 155: a settled sample
-- prints once staff have released it (beeline-3vs.7). Nothing from a settled
-- season printed from 2026-10-14, but trap bottles are pinned years after they
-- were collected, so a sample staff entered or recounted never got labels. A
-- release is one row in the new sample_print_release; settled_unreleased_sample
-- names the settled samples that still never print, and the three views that
-- read "settled" to mean "never prints" read it instead.
--
-- Nothing is backfilled: no sample is released by this migration. A settled
-- sample prints after a release, written when staff set its count, enter the
-- sample, or release it from its page; the 16 settled samples already entered
-- in Beeline are released by hand once staff confirm their bottles hold no
-- labels (GitHub #407). The three views keep their columns, so they are
-- replaced in place and the views above them bind by name.

CREATE TABLE sample_print_release (
  sample_id   INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  released_by INTEGER REFERENCES person(entity_id),
  released_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
  reason      TEXT
);
COMMENT ON TABLE sample_print_release IS 'A staff decision that a sample from a settled season may print its labels (beeline-3vs.7). It matters only once the season has settled: an active season''s samples print without one. Written straight to the store, with no overlay file, because production is never promoted again (ADR 0006), so a development store rebuilt from the old records loses it. No sample with a release row follows an observation''s count, which promotion would otherwise put back (it does so for a sample that has an observation and no label on paper). Each writer sees to it: setSpecimenCount refuses such a sample, releaseLabels refuses it, and a sample entered in Beeline has no observation. Not a record of what printed: printed_sample is.';
COMMENT ON COLUMN sample_print_release.released_by IS 'The person who released it; null for a staff login that is no person, as sample_hold.held_by and sample_entry.entered_by are.';
COMMENT ON COLUMN sample_print_release.released_at IS 'When the release was written, UTC.';
COMMENT ON COLUMN sample_print_release.reason IS 'What staff said when they released it; null when they said nothing.';

CREATE VIEW settled_unreleased_sample AS
SELECT st.sample_id
FROM settled_sample st
LEFT JOIN sample_print_release r ON r.sample_id = st.sample_id
WHERE r.sample_id IS NULL;
COMMENT ON VIEW settled_unreleased_sample IS 'Samples from a settled season that staff have not released for printing: they never print, are never pending, are held to the loose 250 m coordinate limit and do not follow their point for place. A released settled sample is none of these: it prints like an active one.';

CREATE OR REPLACE VIEW pending_print_sample AS
SELECT s.entity_id AS sample_id,
       -- CAST because count() is 64-bit: the app reads this as a plain number.
       CAST(s.specimen_count - coalesce(printed.n, 0) AS INTEGER) AS pending_count
FROM printable_sample p
JOIN sample s ON s.entity_id = p.sample_id
LEFT JOIN (
  SELECT i.sample_id, count(*) AS n
  FROM individuated_specimen i
  JOIN sample held ON held.entity_id = i.sample_id
  WHERE i.specimen_number <= held.specimen_count
  GROUP BY i.sample_id
) printed ON printed.sample_id = s.entity_id
WHERE s.specimen_count > coalesce(printed.n, 0)
  AND NOT EXISTS (SELECT 1 FROM settled_unreleased_sample st WHERE st.sample_id = s.entity_id);

CREATE OR REPLACE VIEW sample_labels_waiting AS
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
  AND NOT EXISTS (SELECT 1 FROM settled_unreleased_sample st WHERE st.sample_id = s.entity_id);
COMMENT ON VIEW sample_labels_waiting IS 'Samples in an active season, or a settled one staff have released for printing, with specimens whose labels are not on paper yet, and how many: printable or held back by a flag, and including specimens in a run that has not printed. The listings'' "waiting on labels" filter (beeline-3v33).';

CREATE OR REPLACE VIEW sample_coordinate_limit AS
SELECT s.entity_id AS sample_id,
       CASE WHEN s.date_end >= r.effective_from
              OR (p.sample_id IS NULL AND st.sample_id IS NULL)
            THEN r.uncertainty_m
            ELSE r.grandfathered_uncertainty_m END AS uncertainty_m
FROM sample s
CROSS JOIN coordinate_precision_rule r
LEFT JOIN printed_sample p ON p.sample_id = s.entity_id
LEFT JOIN settled_unreleased_sample st ON st.sample_id = s.entity_id;
COMMENT ON VIEW sample_coordinate_limit IS 'Per sample: the coordinate uncertainty above which it cannot be printed. 100 m, except 250 m for a sample collected before 2 September 2026 that has printed or is in a settled season and not released for printing.';
