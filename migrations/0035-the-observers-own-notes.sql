-- Migration for schema/060_sync.sql and schema/105_views_observation.sql
-- (beeline-hza): the observer's free text on an iNaturalist observation.
--
-- Numbered 0035 because PR #81 (beeline-dys) holds 0034; filename order is
-- apply order and a gap is harmless if that one does not land.
--
-- An observation carries a `description` — where a collector writes the
-- plant's condition, the weather, who they were with, why a count is odd.
-- Nothing in Beeline has ever held it, and not because the projection skipped
-- it: the sync's field whitelist IS what gets stored (src/sync-inat.ts), and
-- it never asked. So every load in a deployed store has no notes in it, and
-- this migration cannot backfill them — only a re-sync can, and until one
-- runs the column is correctly empty everywhere.
--
-- The column goes LAST on observation_field, which is load-bearing rather
-- than tidy: refreshObservationFields inserts positionally and
-- observation_field_stale compares with EXCEPT, so a TEXT column added in
-- the middle would swap silently with its neighbour and the alarm built for
-- exactly that could not see it. For the same reason the refresh below names
-- its columns instead of SELECT *: this delta is pinned to its moment, and
-- the view it reads keeps growing.
ALTER TABLE observation_field ADD COLUMN notes TEXT;
COMMENT ON COLUMN observation_field.notes IS 'The observer''s free text on the iNaturalist observation (its `description`), where a collector writes what no observation field holds — the plant''s condition, the weather, who they were with, why a count is odd. Verbatim and possibly containing markdown or HTML, which is the renderer''s problem: nothing here rewrites what the collector said. Blank is stored as NULL. Absent from every load synced before beeline-hza, because the sync''s field whitelist IS the projection and did not ask for it.';

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
  nullif(trim(json_extract_string(o.content, '$.description')), '')      AS notes
FROM observation_current o;

-- Fill the new column from the loads already in the store. It will be NULL
-- for every one of them, because no load fetched before this change carries
-- a description — which is the point of doing it rather than assuming: the
-- table has to agree with the view or observation_field_stale fires, and
-- "empty because nothing was asked for" has to be a state the store can
-- reach honestly. Notes arrive as observations are re-fetched.
UPDATE observation_field f
SET notes = v.notes
FROM observation_current_fields v
WHERE v.inat_id = f.inat_id;
