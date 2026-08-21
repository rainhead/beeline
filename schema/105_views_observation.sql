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
