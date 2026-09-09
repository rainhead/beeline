-- Migration for schema/030, schema/060 and schema/105: carry the floral
-- host's rank, so its name can be printed as a scientific name.
--
-- The sample page rendered the host as bare text. By the project's own rule
-- names are derived, never typed (src/app/views/components/taxon.tsx): italics
-- come from the RANK, because the string cannot be read for it — 'Onagraceae'
-- (family, upright) and 'Chamaenerion' (genus, italic) are both one word. The
-- corpus makes that concrete: of 60,196 samples with a host, ~1,500 sit at
-- tribe, family, subfamily or subtribe, where italics would be wrong.
--
-- No re-sync is needed. `taxon.rank` has been in the sync's field whitelist
-- and in every stored load all along; observation_current_fields simply never
-- read it. So this migration can fill the column from what the store already
-- holds.
--
-- The 2,926 hosts that came from the legacy import rather than an observation
-- get their rank from ingest/promote-legacy.sql, which knows it as *which
-- plant column supplied the name* — nothing else records it.

-- ── The projection ───────────────────────────────────────────────────────
-- APPENDED LAST, as always: refreshObservationFields inserts positionally and
-- observation_field_stale compares with EXCEPT.
ALTER TABLE observation_field ADD COLUMN host_taxon_rank TEXT;
COMMENT ON COLUMN observation_field.host_taxon_rank IS 'The floral host''s rank, as iNaturalist gives it. Carried because italics are derived from rank and cannot be read off the name — ''Onagraceae'' and ''Chamaenerion'' are both one word and only one of them is italic (src/app/views/components/taxon.tsx).';

DROP VIEW observation_current_fields;
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
  nullif(json_extract_string(o.content, '$.private_place_guess'), '')    AS private_place_guess,
  -- The floral host's rank, which decides whether its name is italicised.
  -- Not a nicety: TaxonName derives italics from rank because the string
  -- cannot be read for it — 'Onagraceae' (family, upright) and
  -- 'Chamaenerion' (genus, italic) are both one word, and ~1,500 hosts in
  -- the corpus sit at tribe, family, subfamily or subtribe, where italics
  -- would be wrong. Already whitelisted by the sync and sitting in every
  -- stored load; this view simply never read it.
  json_extract_string(o.content, '$.taxon.rank')                         AS host_taxon_rank
FROM observation_current o;

-- Refilled here rather than left for the next promotion, for the reason
-- migrations 0017, 0020 and 0021 all give: an unrefreshed table is not a
-- visibly broken one. Columns named, never SELECT *.
DELETE FROM observation_field;
INSERT INTO observation_field (
  inat_id, observed_on, latitude, longitude, private_latitude, private_longitude,
  positional_accuracy, public_positional_accuracy, geoprivacy, taxon_geoprivacy,
  viewer_trusted, user_id, user_login, place_guess, host_taxon_id, host_taxon_name,
  host_is_tracheophyte, quality_grade, sample_number_raw, specimen_count_raw,
  collection_method_raw, private_place_guess, host_taxon_rank
)
SELECT
  inat_id, observed_on, latitude, longitude, private_latitude, private_longitude,
  positional_accuracy, public_positional_accuracy, geoprivacy, taxon_geoprivacy,
  viewer_trusted, user_id, user_login, place_guess, host_taxon_id, host_taxon_name,
  host_is_tracheophyte, quality_grade, sample_number_raw, specimen_count_raw,
  collection_method_raw, private_place_guess, host_taxon_rank
FROM observation_current_fields;

-- ── The sample ───────────────────────────────────────────────────────────
ALTER TABLE sample ADD COLUMN host_rank TEXT;
COMMENT ON COLUMN sample.host_rank IS 'The rank host_name_as_observed is at, so the name can be printed correctly: italics are derived from rank and the string cannot be read for it — ''Onagraceae'' (family) and ''Chamaenerion'' (genus) are both one word. From iNaturalist''s taxon.rank where the sample has an observation, and from which of the legacy plant columns supplied the name where it does not. Nullable: the legacy import has hosts whose column is unrecoverable, and an unknown rank prints upright rather than guessing.';

-- Fill what the store can already answer. The iNat-backed hosts come from the
-- projection just refreshed above; ingest/mint-samples.sql keeps them filled
-- on the same fill-only terms from here on. The legacy-only hosts stay NULL
-- until a re-promotion, and print upright meanwhile, which is the honest
-- answer rather than a guess.
UPDATE sample SET host_rank = f.host_taxon_rank
FROM observation_field f
WHERE sample.inat_observation_id = f.inat_id
  AND sample.host_rank IS NULL
  AND f.host_taxon_rank IS NOT NULL;
