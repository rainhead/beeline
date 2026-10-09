-- Migration for schema/060_sync.sql, schema/105_views_observation.sql and
-- schema/109_views_sample_numbering.sql (beeline-a04, beeline-virz): sample
-- numbers that never reached Beeline. The reasoning is in schema/109.
--
-- observation_field gains whether a sample-number field is attached at all,
-- since sample_number_raw reads a blank value as absent and a blank is how an
-- observation joins a project that requires the field without a number. The
-- column goes LAST, for the reason 0035 gives: the refresh inserts
-- positionally and observation_field_stale compares with EXCEPT. Unlike
-- notes, every stored load already carries its ofvs, so the fill below is the
-- real value, not a placeholder awaiting a re-sync.
ALTER TABLE observation_field ADD COLUMN sample_number_field_attached BOOLEAN;
COMMENT ON COLUMN observation_field.sample_number_field_attached IS 'Whether the observation carries a sample-number field at all (''sampleId'', or 2018''s ''sample id''), blank or not. sample_number_raw cannot say this, because it reads a blank value as absent: a field attached and left empty is how an observation joins a project that requires the field without a number (beeline-a04), and it is the evidence observation_unnumbered (schema/109) asks the volunteer about.';

CREATE OR REPLACE VIEW observation_current_fields AS
SELECT o.inat_id,
  CAST(json_extract_string(o.content, '$.observed_on') AS DATE)          AS observed_on,
  CAST(json_extract(o.content, '$.geojson.coordinates[1]') AS DOUBLE)    AS latitude,
  CAST(json_extract(o.content, '$.geojson.coordinates[0]') AS DOUBLE)    AS longitude,
  CAST(json_extract(o.content, '$.private_geojson.coordinates[1]') AS DOUBLE) AS private_latitude,
  CAST(json_extract(o.content, '$.private_geojson.coordinates[0]') AS DOUBLE) AS private_longitude,
  CAST(json_extract(o.content, '$.positional_accuracy') AS INTEGER)      AS positional_accuracy,
  CAST(json_extract(o.content, '$.public_positional_accuracy') AS INTEGER) AS public_positional_accuracy,
  nullif(json_extract_string(o.content, '$.geoprivacy'), 'null')         AS geoprivacy,
  nullif(json_extract_string(o.content, '$.taxon_geoprivacy'), 'null')   AS taxon_geoprivacy,
  coalesce(CAST(json_extract(o.content, '$.viewer_trusted_by_observer') AS BOOLEAN), false) AS viewer_trusted,
  CAST(json_extract(o.content, '$.user.id') AS BIGINT)                   AS user_id,
  json_extract_string(o.content, '$.user.login')                         AS user_login,
  json_extract_string(o.content, '$.place_guess')                        AS place_guess,
  CAST(json_extract(o.content, '$.taxon.id') AS BIGINT)                  AS host_taxon_id,
  json_extract_string(o.content, '$.taxon.name')                         AS host_taxon_name,
  list_contains(CAST(json_extract(o.content, '$.taxon.ancestor_ids') AS BIGINT[]), 211194) AS host_is_tracheophyte,
  json_extract_string(o.content, '$.quality_grade')                      AS quality_grade,
  coalesce(
    (SELECT j.j ->> '$.value'
     FROM (SELECT unnest(CAST(json_extract(o.content, '$.ofvs') AS JSON[])) AS j) j
     WHERE j.j ->> '$.name' = 'sampleId'
       AND nullif(trim(j.j ->> '$.value'), '') IS NOT NULL LIMIT 1),
    (SELECT j.j ->> '$.value'
     FROM (SELECT unnest(CAST(json_extract(o.content, '$.ofvs') AS JSON[])) AS j) j
     WHERE j.j ->> '$.name' = 'sample id'
       AND nullif(trim(j.j ->> '$.value'), '') IS NOT NULL LIMIT 1))                      AS sample_number_raw,
  coalesce(
    (SELECT j.j ->> '$.value'
     FROM (SELECT unnest(CAST(json_extract(o.content, '$.ofvs') AS JSON[])) AS j) j
     WHERE j.j ->> '$.name' = 'numberOfSpecimens'
       AND nullif(trim(j.j ->> '$.value'), '') IS NOT NULL LIMIT 1),
    (SELECT j.j ->> '$.value'
     FROM (SELECT unnest(CAST(json_extract(o.content, '$.ofvs') AS JSON[])) AS j) j
     WHERE j.j ->> '$.name' = 'Number of bees collected'
       AND nullif(trim(j.j ->> '$.value'), '') IS NOT NULL LIMIT 1))       AS specimen_count_raw,
  (SELECT j.j ->> '$.value'
   FROM (SELECT unnest(CAST(json_extract(o.content, '$.ofvs') AS JSON[])) AS j) j
   WHERE j.j ->> '$.name' = 'OBA Collection Method' LIMIT 1)             AS collection_method_raw,
  nullif(json_extract_string(o.content, '$.private_place_guess'), '')    AS private_place_guess,
  json_extract_string(o.content, '$.taxon.rank')                         AS host_taxon_rank,
  CASE WHEN trim(coalesce(json_extract_string(o.content, '$.description'), '')) = ''
       THEN NULL
       ELSE json_extract_string(o.content, '$.description') END           AS notes,
  EXISTS (SELECT 1
          FROM (SELECT unnest(CAST(json_extract(o.content, '$.ofvs') AS JSON[])) AS j) j
          WHERE j.j ->> '$.name' IN ('sampleId', 'sample id'))           AS sample_number_field_attached
FROM observation_current o;

UPDATE observation_field f
SET sample_number_field_attached = v.sample_number_field_attached
FROM observation_current_fields v
WHERE v.inat_id = f.inat_id;

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
  HAVING count(*) = count(CASE WHEN n >= 1 AND CAST(n AS TEXT) = sample_number THEN 1 END)
),
daily_numbering AS (
  SELECT person_id, season
  FROM collecting_day
  GROUP BY person_id, season
  HAVING 2 * sum(starts_at_one) >= count(*)
),
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
