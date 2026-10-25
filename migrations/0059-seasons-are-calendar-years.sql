-- Migration for schema/102 and schema/109 (beeline-rxn8): a season is the
-- calendar year of a sample's first day, and a past season settles on the
-- 1 March after it, judged by today's date in Oregon. The reasoning is in
-- schema/102. `season` changes its columns (started_on becomes
-- current_season and active_since), and the views that read it are the
-- app's, so they change with it in the same deploy. Only views change;
-- the rest is the schema verbatim.

CREATE OR REPLACE VIEW season AS
WITH today AS (
  SELECT CAST(current_timestamp AT TIME ZONE 'America/Los_Angeles' AS DATE) AS d
)
SELECT CAST(EXTRACT(YEAR FROM d) AS INTEGER) AS current_season,
       make_date(CAST(EXTRACT(YEAR FROM d) AS INTEGER)
                   - CASE WHEN EXTRACT(MONTH FROM d) < 3 THEN 1 ELSE 0 END,
                 1, 1) AS active_since
FROM today;
COMMENT ON VIEW season IS 'One row, about today in Oregon: the current season (this calendar year), and the first day of the oldest active season — 1 January of last year until 1 March, when last season settles, and 1 January of this year from then on.';

CREATE OR REPLACE VIEW settled_sample AS
SELECT s.entity_id AS sample_id
FROM sample s, season
WHERE s.date_start < season.active_since;
COMMENT ON VIEW settled_sample IS 'Samples from a settled season. Settled means "no longer asking", never "no longer changeable": these samples keep their flags and stay editable. Nothing of theirs is printed any more: pending_print_sample leaves them out (Peter, 2026-10-14).';

CREATE OR REPLACE VIEW sample_season AS
SELECT entity_id AS sample_id,
       CAST(EXTRACT(YEAR FROM date_start) AS INTEGER) AS season
FROM sample;
COMMENT ON VIEW sample_season IS 'The season each sample belongs to: the calendar year of its first day, as the taxonomists count.';

CREATE OR REPLACE VIEW sample_number_gap AS
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
         CAST(EXTRACT(YEAR FROM collected_on) AS INTEGER) AS season
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
