-- Migration for schema/108_views_minting.sql and schema/120_views_qc_rules.sql
-- (beeline-4dt): a street suffix has to END its comma-separated phrase, and
-- the county half of observation_locality's administrative clause is stated
-- rather than left to the accident that used to cover it.
--
-- `st` is Saint and the abbreviation for State as well as Street, so the
-- inherited predicate told 168 samples that "St Helens" — a town in Columbia
-- County — looked like a street address, and another ~70 the same about
-- "Cottonwood Canyon St Prk". The only way for a volunteer to satisfy that
-- instruction is to write the locality wrongly, which makes it the one kind
-- of QC finding that damages data. `lane` and `county` collide the same way.
--
-- A Saint or a State precedes the rest of the name; a Street ends it. The
-- reasoning, the corpus measurements and the eight-observation cost on the
-- minting side are in schema/108_views_minting.sql beside the view.
--
-- The predicate also stops being a one-row view and becomes a macro, which
-- is a performance fix rather than a taste one and is measured in
-- schema/108_views_minting.sql: DuckDB compiles a regex once for a literal
-- pattern and once per row for anything else, so reading it out of a view
-- cost 1.1 s over the store's 67,304 localities against 17 ms inline. 0021
-- introduced that when it gave the word list one home; this keeps the one
-- home and gives the compiler its literal back. ADR 0001's third named
-- exception, on the same predicate as the second (beeline-5bm).
--
-- The comma now survives normalisation as its own token so the anchor can
-- see the end of a phrase that is not the end of the string ("NW Harrison
-- Blvd, Corvallis"). The stack of views above qc_rule_locality_format has to
-- come down and go back up unchanged, exactly as in 0018.
DROP VIEW pending_print_sample;
DROP VIEW printable_sample;
DROP VIEW blocking_sample;
DROP VIEW sample_qc_finding;
DROP VIEW qc_finding;
DROP VIEW qc_rule_locality_format;
DROP VIEW observation_locality;
DROP VIEW locality_street_suffix_pattern;

CREATE MACRO locality_street_suffix_pattern() AS
  concat(' (road|rd|street|str|st|avenue|ave|av|drive|dr|boulevard|blvd|court|ct|lane|ln|county)',
         '( +((ne|nw|se|sw|n|s|e|w)|[^ ]*[0-9][^ ]*))* *(,|$)');

CREATE VIEW qc_rule_locality_format AS
SELECT sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'locality_format' AS rule_name,
       concat_ws('; ',
         CASE WHEN len > 18 THEN concat('longer than 18 chars (', len, ')') END,
         CASE WHEN has_comma THEN 'contains comma' END,
         CASE WHEN has_quote THEN 'contains double quote' END,
         CASE WHEN is_street THEN 'looks like a street address' END
       ) AS details
FROM (
  SELECT norm.sample_id,
         length(norm.locality) AS len,
         position(',' IN norm.locality) > 0 AS has_comma,
         position('"' IN norm.locality) > 0 AS has_quote,
         regexp_matches(norm.norm, locality_street_suffix_pattern()) AS is_street
  FROM (
    SELECT s.entity_id AS sample_id, s.locality,
           concat(' ', replace(replace(lower(s.locality), '.', ' '), ',', ' , '), ' ') AS norm
    FROM sample s
    WHERE s.locality IS NOT NULL
  ) norm
) flags
WHERE len > 18 OR has_comma OR has_quote OR is_street;

CREATE VIEW qc_finding AS
SELECT * FROM qc_rule_missing_required_field
UNION ALL SELECT * FROM qc_rule_missing_recommended_field
UNION ALL SELECT * FROM qc_rule_obscured_no_true_coordinates
UNION ALL SELECT * FROM qc_rule_locality_format
UNION ALL SELECT * FROM qc_rule_place_unabbreviated
UNION ALL SELECT * FROM qc_rule_place_unrecognised
UNION ALL SELECT * FROM qc_rule_coordinate_uncertainty
UNION ALL SELECT * FROM qc_rule_duplicate_sample_number
UNION ALL SELECT * FROM qc_rule_non_tracheophyte_host
UNION ALL SELECT * FROM qc_rule_count_mismatch
UNION ALL SELECT * FROM qc_rule_count_below_printed
UNION ALL SELECT * FROM qc_rule_observation_missing_upstream
UNION ALL SELECT sample_id, CAST(NULL AS INTEGER) AS specimen_id, rule_name, details
FROM sample_promotion_finding;

CREATE VIEW sample_qc_finding AS
SELECT coalesce(f.sample_id, sp.sample_id) AS sample_id,
       f.specimen_id,
       f.rule_name,
       f.details
FROM qc_finding f
LEFT JOIN specimen sp ON sp.entity_id = f.specimen_id;

CREATE VIEW blocking_sample AS
SELECT DISTINCT f.sample_id AS sample_id
FROM sample_qc_finding f
JOIN qc_rule r ON r.name = f.rule_name AND r.severity = 'blocking'
WHERE f.sample_id IS NOT NULL;

CREATE VIEW printable_sample AS
SELECT s.entity_id AS sample_id
FROM sample s
WHERE s.specimen_count > 0
  AND NOT EXISTS (SELECT 1 FROM blocking_sample b WHERE b.sample_id = s.entity_id);

CREATE VIEW pending_print_sample AS
SELECT s.entity_id AS sample_id,
       -- CAST because count() is 64-bit: the app reads this as a plain number.
       CAST(s.specimen_count - coalesce(printed.n, 0) AS INTEGER) AS pending_count
FROM printable_sample p
JOIN sample s ON s.entity_id = p.sample_id
LEFT JOIN (
  SELECT sample_id, count(*) AS n FROM specimen GROUP BY sample_id
) printed ON printed.sample_id = s.entity_id
WHERE s.specimen_count > coalesce(printed.n, 0);

-- The minting side: the component normalisation now matches the pattern's
-- contract, and a component naming the observation's own county is refused
-- on its own terms. 'Lane Co.' used to be refused by the accident of `lane`
-- being a street suffix, and the anchor takes that accident away — but the
-- accident was covering a larger hole (beeline-bev): only the long spelling
-- 'Wheeler County' was ever refused, so 583 observations read 'Deschutes
-- Co.' where the guess also said 'Bend'. Existing samples keep the locality
-- they have; the refresh is fill-only.
--
-- Matched only with 'County', 'Co' or 'Co.' after it and never bare: a
-- county is routinely named after its own seat and iNaturalist writes plain
-- 'City, State, Country', so a bare component equal to the county name is
-- nearly always the city — 1,304 of them in the corpus, Hood River and
-- Yakima and Nanaimo. schema/108_views_minting.sql has the full count.
CREATE VIEW observation_locality AS
WITH guess AS (
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
  WHERE length(c.part) BETWEEN 2 AND 18
    AND NOT regexp_matches(
          concat(' ', replace(replace(lower(c.part), '.', ' '), ',', ' , '), ' '),
          locality_street_suffix_pattern())
    AND NOT regexp_matches(c.part, '[0-9]{5}')
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
COMMENT ON VIEW observation_locality IS 'The locality a sample minted from an observation carries: the first comma-separated component of its (private-preferred) place_guess that reads like a place name. An observation with no such component is absent here, and the sample it mints blocks honestly as missing_required_field — which the volunteer fixes upstream on iNaturalist, as SOP.';
