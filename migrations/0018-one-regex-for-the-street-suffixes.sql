-- Migration for schema/120_views_qc_rules.sql (beeline-2c3.37): the street
-- suffix check becomes one regular expression instead of nineteen LIKE
-- passes over every locality in the store.
--
-- 206 ms -> 16 ms on the dev store, and with the observation projection
-- stored (beeline-2c3.36) this rule was the ENTIRE remaining cost of
-- scanning qc_finding — every other rule is 7 ms or less. Every QC read in
-- the app goes through that union, so this is the QC home, both listings,
-- printability and both record pages.
--
-- Semantics are unchanged, and that was checked rather than reasoned about:
-- run over all 66,065 localities in the dev store (4,539 distinct), the two
-- predicates disagree on none, and the rule's own output is the same 4,100
-- rows with an empty symmetric difference. The space-padded `norm` is what
-- supplies the word boundaries, so no lookbehind is needed and the
-- alternation is a faithful translation of the reference implementation's
-- includesIllegalSuffix.
--
-- This drops dialect neutrality for this one predicate, deliberately (Peter,
-- 2026-08-28): `regexp_matches` returns a boolean on DuckDB and text[] on
-- Postgres, so a port rewrites it — a known line of work rather than a
-- silent difference. `~` would have been the portable-looking spelling and
-- is the trap: DuckDB's `~` is regexp_full_match, Postgres's is a partial
-- match, so it answers differently in the two engines without erroring.
--
-- The qc_finding union and everything above it sit on this view, so the
-- stack comes down in dependency order and goes back up unchanged.
DROP VIEW pending_print_sample;
DROP VIEW printable_sample;
DROP VIEW blocking_sample;
DROP VIEW sample_qc_finding;
DROP VIEW qc_finding;
DROP VIEW qc_rule_locality_format;

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
         -- The same seventeen words the reference checks, each still
         -- required to stand alone between spaces.
         regexp_matches(norm.norm,
           ' (road|rd|street|str|st|avenue|ave|av|drive|dr|boulevard|blvd|court|ct|lane|ln|county) '
         ) AS is_street
  FROM (
    SELECT s.entity_id AS sample_id, s.locality,
           concat(' ', replace(replace(lower(s.locality), ',', ' '), '.', ' '), ' ') AS norm
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
