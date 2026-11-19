-- Migration for schema/050_qc.sql, 102, 108, 120, 150, 155 and 173: a settled
-- sample prints once staff have released it (beeline-3vs.7). Nothing from a
-- settled season printed from 2026-10-14, but trap bottles are pinned years
-- after they were collected, so a sample staff entered or recounted never got
-- labels. A release is one row in the new sample_print_release (a withdrawal
-- keeps the row and marks it withdrawn); settled_unreleased_sample names the
-- settled samples that still never print, and the views that read "settled" to
-- mean "never prints" read it instead. sample_mint_free_link no longer offers
-- a sample entered in Beeline to an observation, which would make its number,
-- count and place follow iNaturalist.
--
-- Nothing is backfilled: no sample is released by this migration. A settled
-- sample prints after a release, written when staff change its count, enter
-- the sample, or release it from its page; the 16 settled samples already
-- entered in Beeline are released by hand once staff confirm their bottles
-- hold no labels (GitHub #407). The views keep their columns, so they are
-- replaced in place and the views above them bind by name.

CREATE TABLE sample_print_release (
  sample_id   INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  released_by INTEGER REFERENCES person(entity_id),
  released_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
  reason      TEXT,
  withdrawn_at TIMESTAMP,
  withdrawn_by INTEGER REFERENCES person(entity_id),
  withdraw_reason TEXT
);
COMMENT ON TABLE sample_print_release IS 'A staff decision that a sample from a settled season may print its labels (beeline-3vs.7). It matters only once the season has settled: an active season''s samples print without one. Written straight to the store, with no overlay file, because production is never promoted again (ADR 0006), so a development store rebuilt from the old records loses it. No sample with a standing release follows an observation''s count, which promotion would otherwise put back (it does so for a sample that has an observation and no label on paper). Each writer sees to it: setSpecimenCount and releaseLabels refuse such a sample, a sample entered in Beeline has no observation, and minting does not link one to it (sample_mint_free_link, schema/108). A withdrawal keeps the row and records who withdrew it and when; settled_unreleased_sample treats a withdrawn row as no release, and a new release clears the withdrawal. Not a record of what printed: printed_sample is.';
COMMENT ON COLUMN sample_print_release.released_by IS 'The person who released it; null for a staff login that is no person, as sample_hold.held_by and sample_entry.entered_by are.';
COMMENT ON COLUMN sample_print_release.released_at IS 'When the release was written, UTC.';
COMMENT ON COLUMN sample_print_release.reason IS 'What staff said when they released it; null when they said nothing.';
COMMENT ON COLUMN sample_print_release.withdrawn_at IS 'When staff withdrew the release, UTC; null while it stands. A withdrawn row is no release.';
COMMENT ON COLUMN sample_print_release.withdrawn_by IS 'The person who withdrew it; null while it stands, or for a staff login that is no person.';
COMMENT ON COLUMN sample_print_release.withdraw_reason IS 'What staff said when they withdrew it; null when they said nothing.';

CREATE VIEW settled_unreleased_sample AS
SELECT st.sample_id
FROM settled_sample st
LEFT JOIN sample_print_release r ON r.sample_id = st.sample_id
WHERE r.sample_id IS NULL OR r.withdrawn_at IS NOT NULL;
COMMENT ON VIEW settled_unreleased_sample IS 'Samples from a settled season that staff have not released for printing, or whose release they withdrew: they never print, are never pending, are held to the loose 250 m coordinate limit and do not follow their point for place. A released settled sample is none of these: it prints like an active one.';
COMMENT ON VIEW settled_sample IS 'Samples from a settled season. Settled means "no longer asking", never "no longer changeable": these samples keep their flags and stay editable. They print only once staff have released them (sample_print_release); settled_unreleased_sample is the ones that never print (Peter, 2026-10-14, 2026-11-19).';

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

CREATE OR REPLACE VIEW sample_mint_free_link AS
SELECT sample_id, lead_inat_id, person_id, sample_number, observed_on
FROM (
  SELECT m.sample_id, m.lead_inat_id, m.person_id, m.sample_number, m.observed_on,
         row_number() OVER (PARTITION BY m.sample_id ORDER BY m.lead_inat_id) AS rn
  FROM sample_mint_match m
  WHERE m.inat_observation_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM sample_mint_ambiguous a WHERE a.lead_inat_id = m.lead_inat_id)
    -- A sample entered in Beeline is its own record (Beeline is its only one):
    -- linking an observation would make its number, count and locality follow
    -- iNaturalist and undo what staff typed or released (beeline-3vs.7). It
    -- stays in sample_mint_match, so sample_mint_pending still refuses to mint
    -- a second sample beside it.
    AND NOT EXISTS (SELECT 1 FROM sample_entry e WHERE e.sample_id = m.sample_id)
) ranked
WHERE rn = 1;
COMMENT ON VIEW sample_mint_free_link IS 'An existing sample, not one entered in Beeline, that cites no observation and whose collector, number and date range an unlinked observation matches: the link is free, and it is what carries believed-true coordinates and geoprivacy onto a record the legacy dump supplied without them.';

CREATE OR REPLACE VIEW sample_place_disagreement AS
SELECT s.entity_id AS sample_id,
       s.country, s.state_province,
       d.country AS point_country, d.state_province AS point_state_province,
       d.county_inside, d.county_inside_100m,
       EXISTS (SELECT 1 FROM printed_sample p WHERE p.sample_id = s.entity_id) AS printed,
       EXISTS (SELECT 1 FROM settled_unreleased_sample ss WHERE ss.sample_id = s.entity_id) AS settled
FROM sample_area_derivation d
JOIN sample_location l ON l.sample_id = d.sample_id
JOIN sample s ON s.entity_id = d.sample_id
WHERE abs(d.latitude - l.latitude) <= 5e-5
  AND abs(d.longitude - l.longitude) <= 5e-5
  AND d.state_province IS NOT NULL
  AND (d.county_inside_100m OR NOT d.county_inside)
  AND (s.state_province IS DISTINCT FROM d.state_province OR s.country IS DISTINCT FROM d.country);
COMMENT ON VIEW sample_place_disagreement IS 'Samples whose recorded state or province, or country, is not the one their point says (sample_area_derivation), leaving out points within 100 m of their county''s edge. county_inside is FALSE where the point is in no county and took the nearest on the shore. printed says a label is on paper, and settled says the sample is from a settled season that staff have not released for printing: the two kinds of sample the county stamp leaves alone for that reason; read counts split by season.';
