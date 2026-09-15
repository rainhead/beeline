-- Migration for schema/108_views_minting.sql (beeline-kza): a place name too
-- long for a label is minted as written and flagged, instead of the rule
-- skipping to the next component, which was usually a postal town and
-- sometimes one kilometres from where the bees were collected; and a Canadian
-- postcode or a Google plus code is never a locality.
--
-- The flag this now raises is clearable because ingest/mint-samples.sql lets
-- an unprinted sample's locality follow its observation — a promotion change,
-- which reaches a deployed store on its next promotion with no reseed and no
-- backfill. Nothing in the model reads observation_locality, so the view is
-- replaced alone.
DROP VIEW observation_locality;

CREATE VIEW observation_locality AS
WITH guess AS (
  -- Private first, exactly as observation_place and the coordinate rule do.
  SELECT f.inat_id,
         coalesce(nullif(trim(f.private_place_guess), ''),
                  nullif(trim(f.place_guess), '')) AS text
  FROM observation_field f
),
component AS (
  SELECT g.inat_id, c.position, trim(c.part) AS part
  FROM guess g,
  LATERAL (SELECT unnest(str_split_regex(g.text, ',\s*'))                  AS part,
                  generate_subscripts(str_split_regex(g.text, ',\s*'), 1)  AS position) c
  WHERE g.text IS NOT NULL
),
usable AS (
  SELECT c.inat_id, c.position, c.part
  FROM component c
  WHERE length(c.part) >= 2
    AND NOT regexp_matches(
          concat(' ', replace(replace(lower(c.part), '.', ' '), ',', ' , '), ' '),
          locality_street_suffix_pattern())
    AND NOT regexp_matches(c.part, '[0-9]{5}')
    -- A Canadian postcode ('BC V0H 1T5') and a Google plus code ('MGF8+RH')
    -- name no place a person can read, and neither has five digits in a row
    -- for the ZIP clause above to catch (beeline-kza).
    AND NOT regexp_matches(upper(c.part), '\b[A-Z][0-9][A-Z] ?[0-9][A-Z][0-9]\b')
    AND NOT regexp_matches(upper(c.part), '[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}')
    AND NOT regexp_matches(c.part, '^[0-9]')
    AND upper(c.part) NOT IN (SELECT state_province FROM atlas_region)
    AND upper(c.part) NOT IN (SELECT country FROM atlas_region)
    AND upper(c.part) NOT IN ('US', 'CA', 'MX', 'UNITED STATES', 'CANADA', 'MEXICO')
    AND NOT regexp_full_match(upper(c.part), '(US|CA)-[A-Z]{2}')
    AND NOT EXISTS (SELECT 1 FROM observation_place p
                    WHERE p.inat_id = c.inat_id
                      AND (upper(c.part) = upper(p.country_name)
                        OR upper(c.part) = upper(p.state_name)
                        OR upper(c.part) IN (concat(upper(p.county_name), ' COUNTY'),
                                             concat(upper(p.county_name), ' CO'),
                                             concat(upper(p.county_name), ' CO.'))))
)
SELECT inat_id, part AS locality, position AS component
FROM (SELECT u.*, row_number() OVER (PARTITION BY u.inat_id ORDER BY u.position) AS rn FROM usable u) ranked
WHERE rn = 1;
COMMENT ON VIEW observation_locality IS 'The locality a sample minted from an observation carries: the first comma-separated component of its (private-preferred) place_guess that reads like a place name, however long. A component too long for a label is taken as written and flagged by qc_rule_locality_format; an observation with no usable component is absent here, and the sample it mints blocks as missing_required_field. Either is the volunteer''s to fix upstream on iNaturalist, as SOP, and an unprinted sample follows its observation, so the fix arrives on the next promotion (beeline-kza).';
