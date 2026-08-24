-- Migration for schema/160_view_settled_sample.sql (beeline-2c3.24).
-- Deployed stores predate the season and settled_sample views; fresh builds
-- have them from the schema.

CREATE VIEW season AS
SELECT make_date(
         CAST(CASE WHEN EXTRACT(MONTH FROM current_date) >= 3
                   THEN EXTRACT(YEAR FROM current_date)
                   ELSE EXTRACT(YEAR FROM current_date) - 1 END AS INTEGER),
         3, 1) AS started_on;

CREATE VIEW settled_sample AS
SELECT s.entity_id AS sample_id
FROM sample s, season
WHERE s.date_end < season.started_on;
