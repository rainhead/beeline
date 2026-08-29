-- Where an observation is, as the model states places: a country, a state or
-- province, a county (beeline-2yt).
--
-- The source is `place_ids` — the places iNaturalist stamped the observation
-- with — resolved through the inat_place cache (schema/065). Country, state
-- and county come from here and nowhere else, because they have to be exact
-- codes a lookup can join on.
--
-- LOCALITY IS A DIFFERENT QUESTION and this view deliberately does not answer
-- it. `place_guess` is not raw geocoder output to be discarded: it is the
-- designed input to locality, and shaping it is part of the volunteer's
-- collecting workflow. The reference implementation reads it that way —
-- OccurrenceService.parseLocalityFromPlaceGuess splits on commas, takes the
-- first component when there are exactly three ('Corvallis, OR, US' ->
-- 'Corvallis'), and otherwise wraps the whole string in quote characters,
-- which is what makes qc_rule_locality_format's double-quote test fire. The
-- quoting IS the "a human must fix this" marker, and the fix is upstream on
-- iNaturalist, where the next sync collects it.
--
-- That rule produced the corpus we have: of 45,906 linked samples whose
-- place_guess has three parts, 38,212 carry exactly its first component as
-- their locality. Applied to the 1,441 samples a first minting pass would
-- create, it yields a clean label-usable locality for 566 of them and marks
-- the rest for a human — a worklist, not noise (beeline-oyq).
--
-- Note for whoever wires that up: the reference prefers `private_place_guess`
-- over `place_guess`, the same private-first rule this view applies to place
-- ids, and observation_current_fields does not extract it yet.
--
-- Deliberately NOT folded into observation_field. That table is stored rather
-- than derived, and the whole licence for storing it is that its only input
-- is observation_load, which nothing but a sync writes (schema/060). Joining
-- inat_place into it would give it a second input that a places fetch
-- changes, and observation_field_stale would then fire every time the cache
-- grew. So this stays a view, read at promotion rather than per request.
--
-- The state is the useful one: atlas_region keys on the two-letter code, so
-- this is the only route from an observation to an atlas.
--
-- One pass, not three. The obvious spelling is a LATERAL per level, each
-- selecting the lowest-id place of that admin_level — and it re-unnests the
-- JSON once per level per observation, which over 63k observations and 1.57M
-- place ids does not finish in two minutes. Shredding once and pivoting with
-- FILTER runs in well under a second, and is the same shape
-- observation_current_fields already uses to pull several values out of one
-- ofvs array.
CREATE VIEW observation_place AS
WITH resolved AS (
  SELECT e.inat_id, p.admin_level, p.inat_place_id, p.name,
         -- Lowest id wins a tie. Arbitrary, but STABLE, which is the property
         -- that matters: a tie broken differently on different runs would
         -- move a sample between atlases with nothing to show for it.
         -- observation_place_ambiguous names every tie, so "arbitrary" never
         -- has to be taken on trust.
         row_number() OVER (PARTITION BY e.inat_id, p.admin_level
                            ORDER BY p.inat_place_id) AS rn
  FROM (
    SELECT o.inat_id,
           -- Private first, exactly as the coordinate rule does
           -- (ingest/promote-observations.sql): iNaturalist withholds
           -- place_ids on a private observation the same way it withholds
           -- the point, and delivers private_place_ids instead when the
           -- reader is trusted. Without this branch a trusted private
           -- observation resolves to nowhere — which is the one population
           -- the whole trust apparatus exists to serve. Unexercised by the
           -- dev corpus, which was synced without trust: all 63,280 loads
           -- carry neither private_place_ids nor private_geojson, and the
           -- 60 private observations among them carry no place_ids at all,
           -- which is what makes them the only observations with no state.
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
-- Every observation, including the ones no place resolved for: "we have this
-- observation and cannot say where it is" is an answer something has to be
-- able to ask for, and an inner join would hide it.
SELECT o.inat_id,
       p.country_place_id, p.country_name,
       p.state_place_id, p.state_name,
       -- The two-letter code, which is what a sample carries and what
       -- atlas_region is keyed on. A state iNat knows and atlas_region does
       -- not leaves this null rather than dropping the row: "we know where
       -- this is and the model does not recognise it" is exactly the answer
       -- qc_rule_place_unrecognised exists to give.
       reg.state_province AS state_province,
       reg.country        AS country_code,
       p.county_place_id, p.county_name
FROM observation_current o
LEFT JOIN pivoted p ON p.inat_id = o.inat_id
LEFT JOIN atlas_region reg ON reg.inat_place_id = p.state_place_id;

-- Observations carrying two places at one administrative level.
--
-- observation_place picks the lowest id, and that is only defensible while
-- somebody can see how often it has to. In the `sample_elevation_stale`
-- idiom, and like it, a test asserts this empty against the real corpus —
-- if it ever fires, the tie-break stops being a formality and becomes a
-- decision about which place wins.
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

-- Places an observation names that the cache has never been told about.
--
-- The cache is filled by an outbound fetch (pnpm inat:fetch-places) and a
-- sync can bring in observations naming places it has never seen, so the two
-- go out of step in one direction only: this names the gap. It is also what
-- the fetcher selects, so the definition of "missing" is stated once.
CREATE VIEW inat_place_uncached AS
SELECT DISTINCT unnest(CAST(coalesce(json_extract(o.content, '$.private_place_ids'),
                                     json_extract(o.content, '$.place_ids')) AS BIGINT[])) AS inat_place_id
FROM observation_current o
EXCEPT
SELECT inat_place_id FROM inat_place;
