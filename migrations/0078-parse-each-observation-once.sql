-- Migration for schema/105_views_observation.sql: observation_current_fields
-- parses each load once, with json_transform, instead of once per
-- json_extract, and reads the observation fields with list_filter instead of
-- six correlated subqueries (beeline-dmoi). Its columns, their types and its
-- rows are unchanged: on a copy of the production store of 2026-11-07 the two
-- definitions return the same 65,939 rows, both of them equal to
-- observation_field. So the stored table needs no refresh, and the views that
-- read this one need nothing. What changes is the cost of refreshing
-- observation_field, which every sync run that loads anything new pays: the
-- process's peak memory rose by about 1.1 GB for it, and now rises by about
-- 120 MB.

CREATE OR REPLACE VIEW observation_current_fields AS
SELECT o.inat_id,
  CAST(o.j.observed_on AS DATE)                                          AS observed_on,
  -- A GeoJSON point is [longitude, latitude], and a list counts from 1 where
  -- a JSON path counts from 0: [2] here is what '$.coordinates[1]' was.
  CAST(o.j.geojson.coordinates[2] AS DOUBLE)                             AS latitude,
  CAST(o.j.geojson.coordinates[1] AS DOUBLE)                             AS longitude,
  CAST(o.j.private_geojson.coordinates[2] AS DOUBLE)                     AS private_latitude,
  CAST(o.j.private_geojson.coordinates[1] AS DOUBLE)                     AS private_longitude,
  CAST(o.j.positional_accuracy AS INTEGER)                               AS positional_accuracy,
  -- Stored because this view is a faithful shred of the load, NOT because
  -- anything should read it: an obscured public coordinate is a deliberately
  -- shifted pair with an inflated uncertainty, so it is not a weaker
  -- measurement of the location but not a measurement of it at all. Only true
  -- coordinates are useful, for us or for display (Peter, 2026-08-29) — which
  -- is the same stance that keeps shifted pairs out of the sample layer
  -- entirely (ADR 0003).
  CAST(o.j.public_positional_accuracy AS INTEGER)                        AS public_positional_accuracy,
  nullif(o.j.geoprivacy, 'null')                                         AS geoprivacy,
  nullif(o.j.taxon_geoprivacy, 'null')                                   AS taxon_geoprivacy,
  coalesce(CAST(o.j.viewer_trusted_by_observer AS BOOLEAN), false) AS viewer_trusted,
  CAST(o.j.user.id AS BIGINT)                                            AS user_id,
  o.j.user.login                                                         AS user_login,
  o.j.place_guess                                                        AS place_guess,
  CAST(o.j.taxon.id AS BIGINT)                                           AS host_taxon_id,
  o.j.taxon.name                                                         AS host_taxon_name,
  -- ancestor_ids is self-inclusive, so this is true for Tracheophyta
  -- (iNat taxon 211194) itself; NULL when the taxon is absent or the load
  -- predates ancestor_ids in the projection (clears on the next sync).
  list_contains(CAST(o.j.taxon.ancestor_ids AS BIGINT[]), 211194) AS host_is_tracheophyte,
  o.j.quality_grade                                                      AS quality_grade,
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
    list_filter(o.j.ofvs, lambda j: j ->> '$.name' = 'sampleId' AND nullif(trim(j ->> '$.value'), '') IS NOT NULL)[1] ->> '$.value',
    list_filter(o.j.ofvs, lambda j: j ->> '$.name' = 'sample id' AND nullif(trim(j ->> '$.value'), '') IS NOT NULL)[1] ->> '$.value')                      AS sample_number_raw,
  coalesce(
    list_filter(o.j.ofvs, lambda j: j ->> '$.name' = 'numberOfSpecimens' AND nullif(trim(j ->> '$.value'), '') IS NOT NULL)[1] ->> '$.value',
    list_filter(o.j.ofvs, lambda j: j ->> '$.name' = 'Number of bees collected' AND nullif(trim(j ->> '$.value'), '') IS NOT NULL)[1] ->> '$.value')       AS specimen_count_raw,
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
  list_filter(o.j.ofvs, lambda j: j ->> '$.name' = 'OBA Collection Method')[1] ->> '$.value'             AS collection_method_raw,
  -- The locality text, private-preferred, exactly as the coordinate rule and
  -- observation_place prefer their private forms: iNaturalist withholds
  -- place_guess on a private observation and delivers private_place_guess
  -- instead when the reader is trusted. Unexercised by the dev corpus, which
  -- was synced without trust (0 of 63,280 loads carry it) — carried because
  -- the reference implementation reads it first and a minted sample's
  -- locality is derived from it (observation_locality, schema/108).
  nullif(o.j.private_place_guess, '')                                    AS private_place_guess,
  -- The floral host's rank, which decides whether its name is italicised.
  -- Not a nicety: TaxonName derives italics from rank because the string
  -- cannot be read for it — 'Onagraceae' (family, upright) and
  -- 'Chamaenerion' (genus, italic) are both one word, and ~1,500 hosts in
  -- the corpus sit at tribe, family, subfamily or subtribe, where italics
  -- would be wrong. Already whitelisted by the sync and sitting in every
  -- stored load; this view simply never read it.
  o.j.taxon.rank                                                         AS host_taxon_rank,
  -- The observer's own notes (beeline-hza): iNaturalist's `description`, the
  -- free text under an observation. Blank counts as absent, as it does for
  -- the sample number above — a volunteer who opened the box and typed
  -- nothing has said nothing, and an empty string displayed is worse than no
  -- row at all.
  --
  -- Verbatim, and stored as written. The text can contain markdown and HTML,
  -- which is a display problem and not a storage one: whoever renders it
  -- escapes it (src/app/views/record.tsx). Rewriting it here would make the
  -- store disagree with iNaturalist about what the collector said, which is
  -- the one thing this column exists to record.
  -- Blank counts as absent, but the value stored is the ORIGINAL, not the
  -- trimmed one: trim() is the blankness TEST and never the stored
  -- expression. nullif(trim(x), '') would store x with its leading and
  -- trailing whitespace removed, which is a small edit to what the collector
  -- typed, and this column's whole claim is that it makes none (CodeRabbit,
  -- #83).
  CASE WHEN trim(coalesce(o.j.description, '')) = ''
       THEN NULL
       ELSE o.j.description END                                            AS notes,
  -- Whether a sample-number field is attached at all, blank or not
  -- (beeline-a04). sample_number_raw above treats blank as absent, and that
  -- is right for the number, but it loses the one thing a blank says: the
  -- three synced projects are traditional ones that REQUIRE 'sampleId' to
  -- join, and an empty value satisfies the requirement. So an observation in
  -- the project with the field attached and empty was put there as a
  -- collection record by someone who left the number for later — 34 in the
  -- open season on the dev store, against 100 settled, none of them samples.
  coalesce(len(list_filter(o.j.ofvs, lambda j: j ->> '$.name' IN ('sampleId', 'sample id'))) > 0, false)
                                                                         AS sample_number_field_attached
FROM (SELECT inat_id, json_transform(content, '{
        "observed_on": "VARCHAR",
        "geojson": {"coordinates": "JSON[]"},
        "private_geojson": {"coordinates": "JSON[]"},
        "positional_accuracy": "JSON",
        "public_positional_accuracy": "JSON",
        "geoprivacy": "VARCHAR",
        "taxon_geoprivacy": "VARCHAR",
        "viewer_trusted_by_observer": "JSON",
        "user": {"id": "JSON", "login": "VARCHAR"},
        "place_guess": "VARCHAR",
        "private_place_guess": "VARCHAR",
        "taxon": {"id": "JSON", "name": "VARCHAR", "rank": "VARCHAR", "ancestor_ids": "JSON"},
        "quality_grade": "VARCHAR",
        "description": "VARCHAR",
        "ofvs": "JSON[]"
      }') AS j
      FROM observation_current) o;
