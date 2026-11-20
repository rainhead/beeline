-- Migration for schema/038, 050, 102, 108, 120, 150, 155 and 173: a settled
-- sample prints once staff have released it (beeline-3vs.7). Nothing from a
-- settled season printed from 2026-10-14, but trap bottles are pinned years
-- after they were collected, so a sample staff entered or recounted never got
-- labels. A release or a withdrawal is a row of its own in
-- sample_print_release_event, never changed; sample_print_release is the view
-- of the samples whose latest event is a release, and settled_unreleased_sample
-- names the settled samples that still never print. The views that read
-- "settled" to mean "never prints" read it instead.
--
-- A released settled sample whose county, state and country follow its point
-- is not pending until the nightly's county stamp has looked at it
-- (sample_place_stamped, sample_awaiting_place): a label made before would carry
-- the place that was typed. One that does not follow its point prints at once.
-- sample_mint_free_link no longer offers a sample entered in Beeline, or one
-- staff released, to an observation, which would make its number, count and
-- place follow iNaturalist.
--
-- Nothing is backfilled: no sample is released by this migration. A settled
-- sample prints after a release, written when staff change its count, enter
-- the sample, or release it from its page; the 16 settled samples already
-- entered in Beeline are released by hand once staff confirm their bottles
-- hold no labels (GitHub #407). The views keep their columns, so they are
-- replaced in place and the views above them bind by name.

CREATE TABLE sample_print_release_event (
  entity_id INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  sample_id INTEGER NOT NULL REFERENCES sample(entity_id),
  action    TEXT NOT NULL CHECK (action IN ('release', 'withdraw')),
  person_id INTEGER REFERENCES person(entity_id),
  decided_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
  reason    TEXT
);
COMMENT ON TABLE sample_print_release_event IS 'One staff decision that a sample from a settled season may print its labels (a release), or may not any more (a withdrawal), as a row of its own that is never changed (beeline-3vs.7). A sample''s standing is its latest event, the one written last: the highest entity_id, which comes from a sequence (sample_print_release, schema/102). It matters only once the season has settled: an active season''s samples print without one. Written straight to the store, with no overlay file, because production is never promoted again (ADR 0006), so a development store rebuilt from the old records loses it. No sample with a standing release follows an observation''s count, which promotion would otherwise put back (it does so for a sample that has an observation and no label on paper): setSpecimenCount and releaseLabels refuse such a sample, a sample entered in Beeline has no observation, and minting links no observation to an entered or released sample (sample_mint_free_link, schema/108). Not a record of what printed: printed_sample is.';
COMMENT ON COLUMN sample_print_release_event.entity_id IS 'A draw from entity_id_seq, not an identity anyone refers to: the order the rows were written in, which makes a sample''s latest event the one with the highest, as minted_field_number.entity_id does for a specimen''s latest number (ADR 0008 §6); decided_at is for people and is not compared.';
COMMENT ON COLUMN sample_print_release_event.action IS 'A release lets the sample print once its season has settled; a withdrawal takes that back. Withdrawing is refused while the sample''s labels are in a print run that has not printed (releaseLabels, src/app/sample-corrections.ts).';
COMMENT ON COLUMN sample_print_release_event.person_id IS 'The person who decided it; null for a staff login that is no person, as sample_hold.held_by and sample_entry.entered_by are.';
COMMENT ON COLUMN sample_print_release_event.decided_at IS 'When the decision was written, UTC.';
COMMENT ON COLUMN sample_print_release_event.reason IS 'What staff said, or null when they said nothing.';

CREATE TABLE sample_place_stamped (
  sample_id  INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  latitude   DOUBLE NOT NULL,
  longitude  DOUBLE NOT NULL,
  stamped_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE sample_place_stamped IS 'Samples the county stamp has looked at, at which point and when: written only for a settled sample staff released for printing, whose place follows its point, once its point has been tested against the gazetteer (sample_area_derivation) and the stamp has run. Where the point lies in no single county there is nothing to stamp and the row says only that the stamp had the chance. sample_awaiting_place (schema/150) reads it.';
COMMENT ON COLUMN sample_place_stamped.latitude IS 'With longitude: the point the sample had when the stamp looked; a row is evidence only while the sample is still there.';
COMMENT ON COLUMN sample_place_stamped.stamped_at IS 'When the stamp looked, UTC; compared with when the release was written.';

CREATE VIEW sample_print_release AS
SELECT e.sample_id, e.person_id AS released_by, e.decided_at AS released_at, e.reason
FROM sample_print_release_event e
WHERE e.action = 'release'
  AND NOT EXISTS (SELECT 1 FROM sample_print_release_event later
                  WHERE later.sample_id = e.sample_id
                    AND later.entity_id > e.entity_id);
COMMENT ON VIEW sample_print_release IS 'Samples whose latest release or withdrawal (sample_print_release_event, in the order the rows were written: entity_id comes from a sequence) is a release, with who released them, when, and why. A sample staff released and then withdrew is not here, and one they released again after a withdrawal is.';

CREATE VIEW settled_unreleased_sample AS
SELECT st.sample_id
FROM settled_sample st
LEFT JOIN sample_print_release r ON r.sample_id = st.sample_id
WHERE r.sample_id IS NULL;
COMMENT ON VIEW settled_unreleased_sample IS 'Samples from a settled season that staff have not released for printing, or whose release they withdrew: they never print, are never pending, are held to the loose 250 m coordinate limit and do not follow their point for place. A released settled sample is none of these: it prints like an active one, once its place is worked out where it follows its point (sample_awaiting_place, schema/150).';
COMMENT ON VIEW settled_sample IS 'Samples from a settled season. Settled means "no longer asking", never "no longer changeable": these samples keep their flags and stay editable, though a trap sample entered in Beeline is then edited on its form only by whoever entered it and by staff (Peter, 2026-11-19). They print only once staff have released them (sample_print_release_event); settled_unreleased_sample is the ones that never print (Peter, 2026-10-14, 2026-11-19).';

CREATE VIEW sample_follows_point AS
SELECT s.entity_id AS sample_id
FROM sample s
WHERE EXISTS (SELECT 1 FROM sample_location_override o WHERE o.sample_id = s.entity_id)
   OR ((s.inat_observation_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM sample_entry e WHERE e.sample_id = s.entity_id))
       AND NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)
       AND NOT EXISTS (SELECT 1 FROM settled_unreleased_sample ss WHERE ss.sample_id = s.entity_id));
COMMENT ON VIEW sample_follows_point IS 'Samples whose county, state and country follow their point, as the nightly''s county stamp writes them (src/derive-area.ts, stampCounties): one whose point staff set (sample_location_override), printed or not, or one with an observation or entered in Beeline that has no label on paper and is in an active season or released from a settled one. The one definition of "follows its point": the stamp, the staff correction of the place and sample_awaiting_place all read it.';

CREATE VIEW sample_awaiting_place AS
SELECT s.entity_id AS sample_id
FROM sample s
JOIN settled_sample st ON st.sample_id = s.entity_id
JOIN sample_print_release r ON r.sample_id = s.entity_id
JOIN sample_follows_point f ON f.sample_id = s.entity_id
LEFT JOIN (
  SELECT p.sample_id, p.stamped_at
  FROM sample_place_stamped p
  JOIN sample_location l ON l.sample_id = p.sample_id
  WHERE abs(p.latitude - l.latitude) <= 5e-5 AND abs(p.longitude - l.longitude) <= 5e-5
) looked ON looked.sample_id = s.entity_id AND looked.stamped_at >= r.released_at
WHERE looked.sample_id IS NULL;
COMMENT ON VIEW sample_awaiting_place IS 'Settled samples staff have released for printing whose county, state and country follow their point (sample_follows_point: an observation, an entry in Beeline or a staff point, and no label on paper unless staff set the point) and which the nightly''s county stamp has not looked at since the release, at the sample''s present point (sample_place_stamped, schema/038): they wait here, and are not pending, so no label carries a place typed before the point was read. A released sample that does not follow its point (old records) is never here. A sample with no point is here too, since it cannot print anyway.';

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
  AND NOT EXISTS (SELECT 1 FROM settled_unreleased_sample st WHERE st.sample_id = s.entity_id)
  AND NOT EXISTS (SELECT 1 FROM sample_awaiting_place w WHERE w.sample_id = s.entity_id);

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
    -- A sample entered in Beeline is its own record (Beeline is its only one),
    -- and one staff released for printing has had its count and place vouched
    -- for: linking an observation would make its number, count and locality
    -- follow iNaturalist and undo that (beeline-3vs.7). Both stay in
    -- sample_mint_match, so sample_mint_pending still refuses to mint a second
    -- sample beside them.
    AND NOT EXISTS (SELECT 1 FROM sample_entry e WHERE e.sample_id = m.sample_id)
    AND NOT EXISTS (SELECT 1 FROM sample_print_release r WHERE r.sample_id = m.sample_id)
) ranked
WHERE rn = 1;
COMMENT ON VIEW sample_mint_free_link IS 'An existing sample, neither one entered in Beeline nor one staff released for printing, that cites no observation and whose collector, number and date range an unlinked observation matches: the link is free, and it is what carries believed-true coordinates and geoprivacy onto a record the legacy dump supplied without them.';

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
