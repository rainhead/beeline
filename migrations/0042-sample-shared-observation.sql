-- Migration for the sample_shared_observation view in schema/108
-- (beeline-15k): one observation cited by several samples, named with the
-- shape that decides its repair. A new view only, so the delta is the schema
-- verbatim.

CREATE VIEW sample_shared_observation AS
WITH member AS (
  SELECT s.entity_id AS sample_id, s.inat_observation_id, s.sample_number,
         s.date_start, pc.person_id
  FROM sample s
  LEFT JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
  WHERE s.inat_observation_id IS NOT NULL
),
grp AS (
  SELECT inat_observation_id,
         CAST(count(*) AS INTEGER) AS samples_sharing,
         count(DISTINCT person_id) AS collectors,
         count(DISTINCT sample_number) AS numbers,
         count(DISTINCT date_start) AS dates
  FROM member
  GROUP BY inat_observation_id
  HAVING count(*) > 1
)
SELECT m.sample_id, m.inat_observation_id, g.samples_sharing,
       CASE WHEN g.collectors > 1 THEN 'different_collectors'
            WHEN g.numbers > 1 AND g.dates = 1 THEN 'same_date'
            WHEN g.numbers = 1 AND g.dates > 1 THEN 'same_number'
            WHEN g.numbers = 1 AND g.dates = 1 THEN 'duplicate'
            ELSE 'other' END AS shape
FROM member m
JOIN grp g ON g.inat_observation_id = m.inat_observation_id;
COMMENT ON VIEW sample_shared_observation IS 'A sample whose cited observation another sample also cites (beeline-15k). Promotion keys on that link, so every sample in the group is given one observation''s coordinates, geoprivacy, host and count comparison. shape is the group''s: different_collectors, same_date (numbers differ), same_number (dates differ), duplicate, or other. Not a constraint: legacy data carries it, and the repair depends on the shape.';
