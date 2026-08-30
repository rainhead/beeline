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
  -- Two field names, two eras. 'sampleId' is the 2019-onwards field; the 2018
  -- season used one named 'sample id', which nothing in Beeline or in the
  -- reference implementation has ever read (docs/reference-implementation.md:
  -- "No sample id ⇒ no rows"). It is not a stray: 1,054 of its 1,532 usable
  -- values match a sample already in the store on (collector, number, date),
  -- which a field nobody meant could not do. 1,608 of its 1,636 uses are
  -- 2018; the rest are stragglers, so this reads it by name rather than by
  -- season. Where an observation carries both, 'sampleId' wins and
  -- observation_sample_number_conflict names any disagreement. Empty on the
  -- corpus as it stands: 31 observations carry both fields, 17 with a value in
  -- each, and every one of those 17 agrees. The view earns its place as a
  -- guard rather than as a worklist — nothing enforces that the two fields
  -- stay in step, and a preference is only honest while the thing it overrules
  -- is visible.
  --
  -- A BLANK field counts as absent, which is why each arm tests the value
  -- rather than letting coalesce do it: coalesce falls through on NULL only,
  -- so a present-but-empty 'sampleId' would win, project as '', and take the
  -- real 2018 value with it — silently, since the conflict view drops blanks
  -- too. 119 observations carry a blank 'sampleId' and 2 of them carry a real
  -- 'sample id' underneath it. The same guard is on the count arms below: no
  -- observation needs it there today (349 blanks, none masking a value), and
  -- it is the same rule, so it is spelled the same way rather than waiting
  -- for the first one that does.
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
  -- How the bee was caught, and the only controlled vocabulary in any of
  -- this: four values across 10,178 observations — net, pan trap, vane trap,
  -- nest block — with no effort smuggled into the string, which is exactly
  -- the failure mode the production free text shows ('6 Vane Traps') and
  -- docs/questions.md asks about (Trap sampling, q3). Verbatim like every
  -- other extraction here; whether it maps onto sample.protocol's vocabulary
  -- is a question for staff, not for this view.
  --
  -- NEW COLUMNS GO LAST, always: refreshObservationFields inserts positionally
  -- (INSERT INTO observation_field SELECT * FROM this view) and
  -- observation_field_stale below compares with EXCEPT, which is positional
  -- too — so a TEXT column added in the middle swaps silently with
  -- sample_number_raw and the alarm built for exactly that cannot see it.
  (SELECT j.j ->> '$.value'
   FROM (SELECT unnest(CAST(json_extract(o.content, '$.ofvs') AS JSON[])) AS j) j
   WHERE j.j ->> '$.name' = 'OBA Collection Method' LIMIT 1)             AS collection_method_raw,
  -- The locality text, private-preferred, exactly as the coordinate rule and
  -- observation_place prefer their private forms: iNaturalist withholds
  -- place_guess on a private observation and delivers private_place_guess
  -- instead when the reader is trusted. Unexercised by the dev corpus, which
  -- was synced without trust (0 of 63,280 loads carry it) — carried because
  -- the reference implementation reads it first and a minted sample's
  -- locality is derived from it (observation_locality, schema/108).
  nullif(json_extract_string(o.content, '$.private_place_guess'), '')    AS private_place_guess
FROM observation_current o;

-- The two sample-number fields disagreeing on one observation.
--
-- sample_number_raw above prefers 'sampleId', and a preference is only honest
-- if the thing it overrules is visible. Empty today: of the 31 observations
-- carrying both fields, 17 have a value in each and all 17 agree. (The other
-- 14 have a blank on one side, which is not a disagreement and is handled
-- above by treating blank as absent — the two were conflated when this was
-- first written, and the 14 was reported here as a conflict count.) A view
-- rather than a QC rule because it is
-- about an observation, and a finding is keyed to a sample (schema/050) —
-- most of these have no sample yet, which is the whole of beeline-oyq.
CREATE VIEW observation_sample_number_conflict AS
SELECT o.inat_id, modern.value AS sample_id_value, legacy.value AS sample_id_2018_value
FROM observation_current o,
LATERAL (SELECT (SELECT j.j ->> '$.value'
                 FROM (SELECT unnest(CAST(json_extract(o.content, '$.ofvs') AS JSON[])) AS j) j
                 WHERE j.j ->> '$.name' = 'sampleId' LIMIT 1) AS value) modern,
LATERAL (SELECT (SELECT j.j ->> '$.value'
                 FROM (SELECT unnest(CAST(json_extract(o.content, '$.ofvs') AS JSON[])) AS j) j
                 WHERE j.j ->> '$.name' = 'sample id' LIMIT 1) AS value) legacy
WHERE nullif(trim(modern.value), '') IS NOT NULL
  AND nullif(trim(legacy.value), '') IS NOT NULL
  AND trim(modern.value) <> trim(legacy.value);

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
