-- Sample numbers that never reached Beeline (beeline-a04, beeline-virz).
--
-- Minting reads an observation as a collection record only when it carries a
-- sample number (observation_sample_candidate, schema/108). Two ways a record
-- can fall short of that leave no trace anywhere else, and both are the
-- volunteer's to put right on iNaturalist, so they are named here for the
-- front page to ask about. Neither is a QC rule: a finding is keyed to a
-- sample (schema/050), and the whole point of both is that there is no
-- sample.

-- ── An observation with its sample number left blank ─────────────────────
-- The three synced projects are traditional projects that REQUIRE 'sampleId'
-- to join, and an empty value satisfies the requirement. So a volunteer can
-- add an observation to the project with the field attached and empty, mean
-- to fill it in later, and never come back. With no number it is never a
-- candidate, so minting never considers it, and the dashboard's zero-count
-- placeholder — keyed on having a number — never shows it either.
--
-- Some write the number in the notes instead ('Sample 2 - ground', '1C red
-- cuckoo'), which is how this was found. The notes are shown beside the row
-- and NEVER parsed into a number: '1C red cuckoo' and '$8 Mt' are why, since
-- a guess here creates a collecting event nobody recorded, and field numbers
-- are permanent. The record holds the number in the collector's own words;
-- what is missing is a prompt to the one person who can confirm it.
--
-- Notes are not required, though the first measurement asked for a digit in
-- them. That requirement came from a wrong premise — that some app versions
-- cannot set fields at all, so the notes were the only place a number could
-- be — and the field attached and empty is the stronger signal: whoever put
-- it there meant this observation as a collection record. On the dev store
-- the open season holds 14 such observations from 8 people, none with a
-- number in the notes, and the settled seasons 51 from 31 people, 4 with one.
--
-- Only an observer who is a person here is asked, since only a person can
-- sign in to be asked. The three open-season observations that first showed
-- the problem ('2', '1', '1C red cuckoo') are not among the 14 for exactly
-- that reason: their observer has no sample, so promotion has never made
-- them a person.
--
-- An observation already a sample, by its link or by a legacy record naming
-- it, is not asked about: the sample has its number.
CREATE VIEW observation_unnumbered AS
SELECT f.inat_id, a.person_id, f.user_id, f.user_login, f.observed_on, f.notes
FROM observation_field f
JOIN inat_account a ON a.inat_user_id = f.user_id
WHERE f.sample_number_field_attached
  AND f.sample_number_raw IS NULL
  AND f.observed_on IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sample s WHERE s.inat_observation_id = f.inat_id)
  AND NOT EXISTS (SELECT 1 FROM sample_legacy_observation l WHERE l.inat_observation_id = f.inat_id);
COMMENT ON VIEW observation_unnumbered IS 'Observations in a sampling project with their sample-number field attached and left blank, whose observer is a person here, that are not a sample: a collection record nobody numbered, which minting therefore never sees. Carries the notes, where a volunteer sometimes wrote the number instead — shown to them, never parsed (beeline-a04).';

-- ── A number skipped in a day's run ──────────────────────────────────────
-- Sample numbers restart every collecting day: in the 2026 season 215 of 222
-- collectors number that way, a day's first sample being 1. So a day that
-- reads 1, 2, 4 has a 3 that is either a number the volunteer skipped, which
-- is fine, or a sample whose observation never reached the project with its
-- number — left out of the project, or in it with the number blank, or never
-- posted — which is a vial with no record. Only the volunteer knows which,
-- so this is advisory and blocks nothing.
--
-- Checked against iNaturalist on fourteen open-season gaps before building
-- it: one missing number was an observation outside the project, carrying
-- the number and a count of 11; the rest had no observation at all.
--
-- What it asks about, and why each limit is there:
--
--   daily numbering   Only a collector who numbers per day is judged, read
--                     per season as at least half their collecting days
--                     including a sample 1. The few who number in a running
--                     series across days (251–280 over nine days) or by a
--                     code (3193…54440) would otherwise read as hundreds of
--                     missing numbers a day. Their series could be judged
--                     too; nobody has asked.
--   short jumps       A day's run starts at 1 and climbs by one, and a
--                     jump of up to three missing numbers is a skip. A
--                     longer jump starts another run: some collectors keep a
--                     second series on the same day (1, 2, 3, 101, 102),
--                     and reading that as 97 missed samples asks a question
--                     with no answer. Without the limit the open season
--                     showed 2,546 missing numbers on 237 days; of the
--                     twelve days missing more than ten that were read, ten
--                     were a second run at 101. With it: 287 on 208 days,
--                     for 69 people. A number missing from the top end
--                     leaves no trace, which is the price of a rule that
--                     cannot know how many samples a day held.
--   integers only     A day carrying any number that is not a plain
--                     integer ('3a', 'ID 1') is skipped whole: it might be
--                     the missing one, and guessing is the thing this file
--                     refuses to do.
--   samples count     A sample with no observation still uses its number,
--                     so an imported record fills its own place in the run
--                     (none of these in the open season, where every sample
--                     has its observation).
--   explained days    A day whose missing numbers are no more than its
--                     observations in observation_unnumbered is not listed:
--                     the unnumbered observations are, most likely, those
--                     numbers, and the page already asks about each.
--
-- Out-of-order numbers (sample 5 dated before sample 3) are not judged:
-- numbers restart daily, so the only order within a day is the time of day,
-- which the projection does not carry.
--
-- The day is the observation's date, and a sample's date_end, the date its
-- observation carries (schema/108). The season is the year it began on 1
-- March, as sample_season (schema/160) states it — restated rather than read,
-- since that view is applied after this one and is about samples.
CREATE VIEW sample_number_gap AS
WITH used AS (
  SELECT a.person_id, f.observed_on AS collected_on, trim(f.sample_number_raw) AS sample_number
  FROM observation_field f
  JOIN inat_account a ON a.inat_user_id = f.user_id
  WHERE f.sample_number_raw IS NOT NULL AND f.observed_on IS NOT NULL
  UNION ALL
  SELECT pc.person_id, s.date_end, trim(s.sample_number)
  FROM sample s
  JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
  WHERE s.inat_observation_id IS NULL
),
numbered AS (
  SELECT person_id, collected_on, sample_number,
         try_cast(sample_number AS INTEGER) AS n,
         CAST(EXTRACT(YEAR FROM collected_on) AS INTEGER)
           - CASE WHEN EXTRACT(MONTH FROM collected_on) < 3 THEN 1 ELSE 0 END AS season
  FROM used
),
collecting_day AS (
  SELECT person_id, collected_on, season,
         max(CASE WHEN n = 1 THEN 1 ELSE 0 END) AS starts_at_one
  FROM numbered
  GROUP BY person_id, collected_on, season
  -- '007' casts to 7 without being written as 7, so the cast must round-trip
  -- or the day is skipped; 0 and below are not a place in a run.
  HAVING count(*) = count(CASE WHEN n >= 1 AND CAST(n AS TEXT) = sample_number THEN 1 END)
),
daily_numbering AS (
  SELECT person_id, season
  FROM collecting_day
  GROUP BY person_id, season
  HAVING 2 * sum(starts_at_one) >= count(*)
),
-- Each number a day holds, beside the one before it, with a 0 ahead of the
-- day's first so that a run starting at 3 is missing its 1 and 2.
present AS (
  SELECT DISTINCT d.person_id, d.collected_on, d.season, x.n
  FROM collecting_day d
  JOIN daily_numbering dn ON dn.person_id = d.person_id AND dn.season = d.season
  JOIN numbered x ON x.person_id = d.person_id AND x.collected_on = d.collected_on
  UNION
  SELECT d.person_id, d.collected_on, d.season, 0
  FROM collecting_day d
  JOIN daily_numbering dn ON dn.person_id = d.person_id AND dn.season = d.season
),
step AS (
  SELECT person_id, collected_on, season, n,
         lag(n) OVER (PARTITION BY person_id, collected_on ORDER BY n) AS previous
  FROM present
),
missing AS (
  SELECT s.person_id, s.collected_on, s.season, CAST(g.n AS INTEGER) AS sample_number
  FROM step s
  CROSS JOIN LATERAL generate_series(s.previous + 1, s.n - 1) AS g(n)
  WHERE s.n - s.previous BETWEEN 2 AND 4
)
SELECT m.person_id, m.collected_on, m.season, m.sample_number
FROM missing m
WHERE (SELECT count(*) FROM missing m2
       WHERE m2.person_id = m.person_id AND m2.collected_on = m.collected_on)
    > (SELECT count(*) FROM observation_unnumbered u
       WHERE u.person_id = m.person_id AND u.observed_on = m.collected_on);
COMMENT ON VIEW sample_number_gap IS 'A number missing from a collector''s run of sample numbers on one day — 1, 2, 4 has no 3 — for collectors who number per day. Either skipped, which is fine, or a sample whose observation never reached the project with its number. Advisory: only the volunteer knows which (beeline-virz). Days fully explained by observation_unnumbered are left out.';
