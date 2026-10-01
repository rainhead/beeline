-- Settled seasons (beeline-2c3.24).
--
-- Collecting is seasonal, and a season closes. From 1 March, last year's
-- samples are settled: their flags are still true, still derived, and still
-- block printing — they just stop asking on the dashboard. Nothing here makes
-- a sample immutable; a settled sample is edited exactly like any other. This
-- is a rule about attention, and it lives with the QC views because that is
-- where the rules about what counts live, not in a route handler.

-- When the current season began: 1 March of this year, or of last year until
-- this year's 1 March arrives.
CREATE VIEW season AS
SELECT make_date(
         CAST(CASE WHEN EXTRACT(MONTH FROM current_date) >= 3
                   THEN EXTRACT(YEAR FROM current_date)
                   ELSE EXTRACT(YEAR FROM current_date) - 1 END AS INTEGER),
         3, 1) AS started_on;
COMMENT ON VIEW season IS 'One row: the date the current collecting season began. 1 March is the settling line — the point at which the previous season stops appearing on volunteers'' dashboards.';

-- Judged on date_end, so a trap line that ran across 1 March belongs to the
-- season it was emptied in rather than the one it was set in.
CREATE VIEW settled_sample AS
SELECT s.entity_id AS sample_id
FROM sample s, season
WHERE s.date_end < season.started_on;
COMMENT ON VIEW settled_sample IS 'Samples from a closed season. Settled means "no longer asking", never "no longer changeable": these samples keep their flags, keep their printability, and stay editable.';

-- Which season a sample belongs to, by the same 1 March line: the year its
-- season began. Judged on date_end, like settled_sample. Written without
-- interval arithmetic so a port reads it as it stands.
CREATE VIEW sample_season AS
SELECT entity_id AS sample_id,
       CAST(EXTRACT(YEAR FROM date_end) AS INTEGER)
         - CASE WHEN EXTRACT(MONTH FROM date_end) < 3 THEN 1 ELSE 0 END AS season
FROM sample;
COMMENT ON VIEW sample_season IS 'The season each sample belongs to, named by the year it began (1 March). A sample emptied in February belongs to the previous year''s season.';
