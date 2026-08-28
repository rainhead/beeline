-- Current state of an observation = its latest load.
CREATE VIEW observation_current AS
SELECT entity_id, inat_id, sync_run_id, fetched_at, content, content_hash
FROM (
  SELECT ol.*,
         row_number() OVER (PARTITION BY inat_id ORDER BY fetched_at DESC, entity_id DESC) AS rn
  FROM observation_load ol
) latest
WHERE rn = 1;

-- Typed extraction over the JSON projection, so downstream rules stay free
-- of JSON functions. This view is the accepted DuckDB-flavored seam (ADR
-- 0001): json_extract and JSON[] casts would spell differently on Postgres.
-- The count OFV appears in the wild under two names; sampleId OFV values
-- include junk ('ID 1') — extraction is verbatim, findings judge validity.
CREATE VIEW observation_current_fields AS
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
  -- ancestor_ids is self-inclusive, so this is true for Tracheophyta
  -- (iNat taxon 211194) itself; NULL when the taxon is absent or the load
  -- predates ancestor_ids in the projection (clears on the next sync).
  list_contains(CAST(json_extract(o.content, '$.taxon.ancestor_ids') AS BIGINT[]), 211194) AS host_is_tracheophyte,
  json_extract_string(o.content, '$.quality_grade')                      AS quality_grade,
  (SELECT j.j ->> '$.value'
   FROM (SELECT unnest(CAST(json_extract(o.content, '$.ofvs') AS JSON[])) AS j) j
   WHERE j.j ->> '$.name' = 'sampleId' LIMIT 1)                          AS sample_number_raw,
  coalesce(
    (SELECT j.j ->> '$.value'
     FROM (SELECT unnest(CAST(json_extract(o.content, '$.ofvs') AS JSON[])) AS j) j
     WHERE j.j ->> '$.name' = 'numberOfSpecimens' LIMIT 1),
    (SELECT j.j ->> '$.value'
     FROM (SELECT unnest(CAST(json_extract(o.content, '$.ofvs') AS JSON[])) AS j) j
     WHERE j.j ->> '$.name' = 'Number of bees collected' LIMIT 1))       AS specimen_count_raw
FROM observation_current o;

-- Whether the stored projection still says what shredding the loads would.
--
-- observation_field (schema/060) is the one place a view's output is kept,
-- and the whole of its correctness is that a refresh ran. Nothing in the
-- engine enforces that: a sync that wrote loads and skipped the refresh, or
-- a store whose loads were inserted by hand, leaves three QC rules reading
-- an older answer with no way to tell. So the disagreement gets a name, the
-- same way sample_elevation_stale names an elevation about somewhere else
-- (schema/170) — and for the same reason, that correctness living in every
-- writer remembering is correctness one new writer can drop.
--
-- Symmetric: a row shredded differently, a load with no row, and a row whose
-- observation is gone are all staleness, and EXCEPT treats NULLs as equal,
-- which is what comparing two projections of the same JSON wants. A test
-- asserts it empty after a sync; nothing reads it at request time, so its
-- cost is the shred it is checking.
CREATE VIEW observation_field_stale AS
SELECT inat_id FROM (
  SELECT * FROM observation_current_fields
  EXCEPT
  SELECT * FROM observation_field
) missing
UNION
SELECT inat_id FROM (
  SELECT * FROM observation_field
  EXCEPT
  SELECT * FROM observation_current_fields
) extra;
