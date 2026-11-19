-- Seasons, and when they settle (beeline-2c3.24, beeline-rxn8).
--
-- A season is a calendar year of collecting: a sample's season is the year
-- of its first day, which is how the taxonomists count and how the Darwin
-- Core archives are cut (Peter, 2026-10-23). Collecting in the program's
-- range happens between spring and autumn, so "the 2025 season" and 2025 are
-- the same thing; a trap set on 28 December belongs to the year it was set.
--
-- Two pairs of words, kept apart (Peter, 2026-10-25):
--
--   current, past     A fact about the calendar. The current season is the
--                     year it is today in Oregon.
--   active, settled   Whether Beeline still asks about a season's samples.
--                     The current season is always active. The season
--                     before it stays active until 1 March, when turnover
--                     is due at the conference, and then settles; so in
--                     January and February two seasons are active.
--
-- Until beeline-rxn8 the year itself ran from 1 March, judged by a sample's
-- last day, so a February trap sample counted in the previous season here
-- and in its own year in the archives.
--
-- Settling is a rule about attention: a settled sample's flags are still
-- true, still derived, and still block printing — they just stop asking on
-- the dashboard, unless staff have released the sample for printing (below). Nothing here makes a sample immutable; a settled sample is
-- edited exactly like any other. It lives with the QC views because that is
-- where the rules about what counts live, not in a route handler.
--
-- It is also a rule about printing: a settled sample prints only once staff
-- have released it (sample_print_release_event, schema/050; beeline-3vs.7).
-- Nothing from a settled season printed at all from 2026-10-14 until then.
-- A full sync on the sandbox had minted 818 samples from observations the old
-- system never recorded, 441 of them from 2018, and every one read as labels
-- waiting: nobody pins a bee eight years later, so a sample like that is a
-- record of what was observed, not a print job. But trap bottles are pinned
-- years after they were collected, so a sample staff entered or whose count
-- they set did need labels (Peter, 2026-11-19). Staff releasing a sample is
-- the explicit act that tells the two apart: what a count copied from
-- iNaturalist leaves behind stays unprinted. settled_unreleased_sample is the
-- settled samples that still never print, and pending_print_sample (schema/150)
-- leaves out those. That is why these views sit here, ahead of the printing
-- views, where printed_sample (schema/101) sits for the same reason.

-- Today is read in Oregon's time zone, not the session's UTC (src/db.ts),
-- whose new year arrives at 4 p.m. Pacific on 31 December. AT TIME ZONE on a
-- timestamp with time zone yields the local wall-clock time in DuckDB and
-- Postgres alike. Written without interval arithmetic so a port reads it as
-- it stands.
CREATE VIEW season AS
WITH today AS (
  SELECT CAST(current_timestamp AT TIME ZONE 'America/Los_Angeles' AS DATE) AS d
)
SELECT CAST(EXTRACT(YEAR FROM d) AS INTEGER) AS current_season,
       make_date(CAST(EXTRACT(YEAR FROM d) AS INTEGER)
                   - CASE WHEN EXTRACT(MONTH FROM d) < 3 THEN 1 ELSE 0 END,
                 1, 1) AS active_since
FROM today;
COMMENT ON VIEW season IS 'One row, about today in Oregon: the current season (this calendar year), and the first day of the oldest active season — 1 January of last year until 1 March, when last season settles, and 1 January of this year from then on.';

CREATE VIEW settled_sample AS
SELECT s.entity_id AS sample_id
FROM sample s, season
WHERE s.date_start < season.active_since;
COMMENT ON VIEW settled_sample IS 'Samples from a settled season. Settled means "no longer asking", never "no longer changeable": these samples keep their flags and stay editable, though a trap sample entered in Beeline is then edited on its form only by whoever entered it and by staff (Peter, 2026-11-19). They print only once staff have released them (sample_print_release_event); settled_unreleased_sample is the ones that never print (Peter, 2026-10-14, 2026-11-19).';

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

CREATE VIEW sample_season AS
SELECT entity_id AS sample_id,
       CAST(EXTRACT(YEAR FROM date_start) AS INTEGER) AS season
FROM sample;
COMMENT ON VIEW sample_season IS 'The season each sample belongs to: the calendar year of its first day, as the taxonomists count.';
