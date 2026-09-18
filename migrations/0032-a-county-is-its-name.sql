-- Migration for schema/107_views_place.sql (beeline-gr7): a county is the
-- name before iNaturalist's disambiguating suffix. observation_place took
-- inat_place.name verbatim, and for the handful of counties iNaturalist
-- disambiguates that is 'Franklin County, US, WA' — which the fill-only
-- refresh wrote into sample.county, and which the first print run anyone
-- prepared put on 172 labels as 'USA:WA:Franklin County, US, WACo …'.
--
-- The view is replaced, and the samples already carrying the suffixed form
-- are repaired by the same rule, since a fill-only refresh never revisits a
-- value it has filled. The legacy import carries the form too ('Washington ,
-- US, ID', with the geocoder's stray space), and the reference implementation
-- papered over two of them in its label code; this repairs those rows as
-- well. county is not what a printed label is locked on — the lock is about
-- edits arriving from iNaturalist — and the repaired value is what the label
-- was always meant to say. The sample change log records the repair at the
-- next boot, attributed to the pass.
CREATE OR REPLACE VIEW observation_place AS
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
       p.county_place_id,
       -- iNaturalist names most counties bare ('Benton') and disambiguates a
       -- handful by appending the country and state: 'Franklin County, US, WA',
       -- 'Lincoln County, US, WA', 'Washington County, US, ID'. Taken verbatim
       -- that filled sample.county, and a label printed
       -- 'USA:WA:Franklin County, US, WACo Hanford Reach NM' — 172 of them in
       -- the first run anyone prepared (Peter, 2026-09-18; beeline-gr7). So
       -- the name is what stands before the first comma, and the ' County'
       -- that only the disambiguated form carries comes off with the suffix. A
       -- bare 'Strathcona County' is left alone: that is its name.
       CASE WHEN p.county_name LIKE '%,%'
            THEN CASE WHEN trim(split_part(p.county_name, ',', 1)) LIKE '% County'
                      THEN left(trim(split_part(p.county_name, ',', 1)),
                                length(trim(split_part(p.county_name, ',', 1))) - 7)
                      ELSE trim(split_part(p.county_name, ',', 1)) END
            ELSE p.county_name END AS county_name
FROM observation_current o
LEFT JOIN pivoted p ON p.inat_id = o.inat_id
LEFT JOIN atlas_region reg ON reg.inat_place_id = p.state_place_id;

UPDATE sample
SET county = CASE WHEN trim(split_part(county, ',', 1)) LIKE '% County'
                  THEN left(trim(split_part(county, ',', 1)), length(trim(split_part(county, ',', 1))) - 7)
                  ELSE trim(split_part(county, ',', 1)) END
WHERE county LIKE '%,%';
