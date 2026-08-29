-- Migration for schema/010, schema/060, schema/065, schema/105 and schema/107
-- (beeline-2yt): read the two observation fields nothing was reading, and
-- teach the store what an iNaturalist place id means.
--
-- Three changes that travel together because the point of all of them is the
-- same: a sample minted from an observation (beeline-oyq) has to get its
-- sample number, its collection method and its geography from the
-- observation, and today the store can supply none of the three.
--
-- 1. THE 2018 SAMPLE-NUMBER FIELD. 'sampleId' is the 2019-onwards observation
--    field. The 2018 season used one named 'sample id', which neither Beeline
--    nor the reference implementation has ever read. It is not a stray field:
--    1,054 of its 1,532 usable values match a sample already in the store on
--    (collector, number, date), which a field nobody meant could not do.
--
-- 2. COLLECTION METHOD. 'OBA Collection Method' — net, pan trap, vane trap,
--    nest block — on 10,178 observations, and the only controlled vocabulary
--    the source offers for how a bee was caught.
--
-- 3. PLACES. place_guess is free text a phone wrote ('Leach Botanical
--    Garden'), so place_ids is the only route from an observation to a state,
--    and therefore to an atlas. inat_place caches what an id means;
--    observation_place reads it; atlas_region gains the place id of every
--    region so the two-letter code can be reached at all.
--
-- Verified against the dev corpus before this was written: observation_place
-- agrees with the legacy import's state on 57,241 of 57,278 linked samples,
-- resolves a state for every observation that has any place ids at all, and
-- observation_place_ambiguous — the tie-break's alarm — is empty.

-- ── 1 and 2: the projection ──────────────────────────────────────────────
-- The column is APPENDED, and appended last, because
-- refreshObservationFields inserts positionally and observation_field_stale
-- compares with EXCEPT: a TEXT column landing anywhere else swaps silently
-- with sample_number_raw and the alarm built for that cannot see it.
ALTER TABLE observation_field ADD COLUMN collection_method_raw TEXT;
COMMENT ON COLUMN observation_field.sample_number_raw IS 'The volunteer''s own sample number, from whichever of the two observation fields carries it — ''sampleId'' from 2019, ''sample id'' in 2018 (schema/105). Verbatim: values include junk (''ID 1'') and prefixed series (''dto41''), and findings judge validity.';
COMMENT ON COLUMN observation_field.collection_method_raw IS '''OBA Collection Method'': net, pan trap, vane trap, or nest block. The only controlled vocabulary the source offers for how a bee was caught — sample.protocol is free text and its vocabulary is still an open question for staff (docs/questions.md, Trap sampling q3).';

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
   WHERE j.j ->> '$.name' = 'OBA Collection Method' LIMIT 1)             AS collection_method_raw
FROM observation_current o;

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

-- Refreshed here rather than left for the next promotion, exactly as
-- migration 0017 argued: an unrefreshed table is not a visibly broken one —
-- the QC rules reading it would simply report an older answer, and
-- observation_field_stale would be the only thing that knew.
-- Columns named, for the reason migration 0017 now spells out at length: a
-- migration reads the view as the schema defines it today, so a SELECT * here
-- would break the moment a twenty-second column lands. (The runtime refresh,
-- src/refresh-observation-fields.ts, keeps its SELECT * on purpose — it is
-- meant to track the view wherever it goes, and observation_field_stale is
-- what catches it if the order ever diverges.)
DELETE FROM observation_field;
INSERT INTO observation_field (
  inat_id, observed_on, latitude, longitude, private_latitude, private_longitude,
  positional_accuracy, public_positional_accuracy, geoprivacy, taxon_geoprivacy,
  viewer_trusted, user_id, user_login, place_guess, host_taxon_id, host_taxon_name,
  host_is_tracheophyte, quality_grade, sample_number_raw, specimen_count_raw,
  collection_method_raw
)
SELECT
  inat_id, observed_on, latitude, longitude, private_latitude, private_longitude,
  positional_accuracy, public_positional_accuracy, geoprivacy, taxon_geoprivacy,
  viewer_trusted, user_id, user_login, place_guess, host_taxon_id, host_taxon_name,
  host_is_tracheophyte, quality_grade, sample_number_raw, specimen_count_raw,
  collection_method_raw
FROM observation_current_fields;

-- ── 3: places ────────────────────────────────────────────────────────────
CREATE TABLE inat_place (
  inat_place_id      BIGINT PRIMARY KEY,
  name               TEXT NOT NULL,
  admin_level        INTEGER,
  ancestor_place_ids BIGINT[],
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE inat_place IS 'iNaturalist places, cached so an observation''s place_ids can be read as country/state/county without an HTTP call inside promotion. Reference data, not an entity (ADR 0002): nothing anchors on a place.';
COMMENT ON COLUMN inat_place.admin_level IS 'iNat''s administrative rank: 0 country, 10 state/province, 20 county. NULL for the majority — ecoregions, parks, and the user-drawn places that make up most of an observation''s place_ids ("Willamette Valley EcoRegion", "Total Solar Eclipse 2017 Path of Totality"). Nullable because that is the common case, not an omission.';
COMMENT ON COLUMN inat_place.ancestor_place_ids IS 'Self-inclusive, and NULL on the continent-sized places that have no ancestors. Carried so a place can be told which country it is under without a second fetch — the discriminator between Georgia the state and Georgia the country.';
COMMENT ON COLUMN inat_place.fetched_at IS 'When this row was read from iNat. Places change shape and get merged upstream; nothing re-reads them on a schedule yet, so this is what would say how stale the answer is.';

-- The regions already exist on a deployed store, so their place ids arrive as
-- UPDATEs rather than with the seed INSERT that schema/010 carries.
ALTER TABLE atlas_region ADD COLUMN inat_place_id BIGINT;
COMMENT ON COLUMN atlas_region.inat_place_id IS 'This region''s iNaturalist place, so a sample minted from an observation can be given a state at all: iNat stamps observations with place ids and place_guess is free text ("Leach Botanical Garden"), so the two-letter code has to be reached through here (beeline-2yt). atlas.inat_place_id answers the same question for the six atlases only; every region needs one, and a test pins the six to agree.';

-- The index goes on BEFORE the values, not after: DuckDB refuses to create an
-- index while a table has outstanding updates in the transaction, and a
-- migration runs entirely inside one (src/migrate.ts) so there is no
-- CHECKPOINT to break it up. An all-NULL column takes the index happily, and
-- the UPDATE below is then enforced by it — which is the better order anyway.
CREATE UNIQUE INDEX atlas_region_inat_place_id_key ON atlas_region (inat_place_id);

UPDATE atlas_region SET inat_place_id = v.place_id
FROM (VALUES
  ('OR', 10), ('WA', 46), ('BC', 7085), ('ID', 22), ('NM', 9), ('OK', 12),
  ('AL', 19), ('AK', 6), ('AZ', 40), ('AR', 36), ('CA', 14), ('CO', 34),
  ('CT', 49), ('DE', 4), ('DC', 5), ('FL', 21), ('GA', 23), ('HI', 11),
  ('IL', 35), ('IN', 20), ('IA', 24), ('KS', 25), ('KY', 26), ('LA', 27),
  ('ME', 17), ('MD', 39), ('MA', 2), ('MI', 29), ('MN', 38), ('MS', 37),
  ('MO', 28), ('MT', 16), ('NE', 3), ('NV', 50), ('NH', 41), ('NJ', 51),
  ('NY', 48), ('NC', 30), ('ND', 13), ('OH', 31), ('PA', 42), ('RI', 8),
  ('SC', 43), ('SD', 44), ('TN', 45), ('TX', 18), ('UT', 52), ('VT', 47),
  ('VA', 7), ('WV', 33), ('WI', 32), ('WY', 15),
  ('AB', 6834), ('MB', 7590), ('NB', 7587), ('NL', 7289), ('NS', 6853),
  ('NT', 9079), ('NU', 13335), ('ON', 6883), ('PE', 9116), ('QC', 13336),
  ('SK', 7953), ('YT', 13337)
) AS v(state_province, place_id)
WHERE atlas_region.state_province = v.state_province;

-- atlas.inat_place_id is deliberately untouched (schema/010 says why):
-- nothing reads it, atlas_region's is what observation_place joins on, and
-- DuckDB will not UPDATE a row that an incoming foreign key references —
-- atlas_region.atlas_id does, so this migration cannot write it even if it
-- wanted to. Washington's 46 stays the one documented value, and is what the
-- derivation above was checked against.

CREATE VIEW observation_place AS
WITH resolved AS (
  SELECT e.inat_id, p.admin_level, p.inat_place_id, p.name,
         row_number() OVER (PARTITION BY e.inat_id, p.admin_level
                            ORDER BY p.inat_place_id) AS rn
  FROM (
    SELECT o.inat_id,
           unnest(CAST(coalesce(json_extract(o.content, '$.private_place_ids'),
                                json_extract(o.content, '$.place_ids')) AS BIGINT[])) AS place_id
    FROM observation_current o
  ) e
  JOIN inat_place p ON p.inat_place_id = e.place_id
  WHERE p.admin_level IN (0, 10, 20)
),
pivoted AS (
  SELECT inat_id,
         max(inat_place_id) FILTER (WHERE admin_level = 0)  AS country_place_id,
         max(name)          FILTER (WHERE admin_level = 0)  AS country_name,
         max(inat_place_id) FILTER (WHERE admin_level = 10) AS state_place_id,
         max(name)          FILTER (WHERE admin_level = 10) AS state_name,
         max(inat_place_id) FILTER (WHERE admin_level = 20) AS county_place_id,
         max(name)          FILTER (WHERE admin_level = 20) AS county_name
  FROM resolved WHERE rn = 1
  GROUP BY inat_id
)
SELECT o.inat_id,
       p.country_place_id, p.country_name,
       p.state_place_id, p.state_name,
       reg.state_province AS state_province,
       reg.country        AS country_code,
       p.county_place_id, p.county_name
FROM observation_current o
LEFT JOIN pivoted p ON p.inat_id = o.inat_id
LEFT JOIN atlas_region reg ON reg.inat_place_id = p.state_place_id;

CREATE VIEW observation_place_ambiguous AS
-- CAST because count() is 64-bit, as pending_print_sample does.
SELECT e.inat_id, p.admin_level, CAST(count(*) AS INTEGER) AS places,
       array_to_string(list_sort(list(p.name)), ' | ') AS names
FROM (
  SELECT o.inat_id,
         unnest(CAST(coalesce(json_extract(o.content, '$.private_place_ids'),
                              json_extract(o.content, '$.place_ids')) AS BIGINT[])) AS place_id
  FROM observation_current o
) e
JOIN inat_place p ON p.inat_place_id = e.place_id
WHERE p.admin_level IN (0, 10, 20)
GROUP BY e.inat_id, p.admin_level
HAVING count(*) > 1;

CREATE VIEW inat_place_uncached AS
SELECT DISTINCT unnest(CAST(coalesce(json_extract(o.content, '$.private_place_ids'),
                                     json_extract(o.content, '$.place_ids')) AS BIGINT[])) AS inat_place_id
FROM observation_current o
EXCEPT
SELECT inat_place_id FROM inat_place;

-- The cache itself is NOT filled here: it comes from an outbound HTTP fetch,
-- which a migration has no business making. Run `pnpm inat:fetch-places`
-- after this — until then observation_place resolves nothing, which
-- inat_place_uncached says out loud.
