-- Migration for schema/120: qc_rule_locality_format no longer flags a
-- locality that looks like a street address. Andony no longer remembers why
-- the old system forbade one, and a volunteer who writes one has made their
-- choice (Peter, 2026-10-31). A locality that is only a county is still
-- flagged, as the street suffixes used to flag it. The views that read this
-- one bind it by name, so it is replaced in place.

CREATE OR REPLACE VIEW qc_rule_locality_format AS
SELECT sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'locality_format' AS rule_name,
       concat_ws('; ',
         CASE WHEN len > 18 THEN concat('longer than 18 chars (', len, ')') END,
         CASE WHEN has_comma THEN 'contains comma' END,
         CASE WHEN has_quote THEN 'contains double quote' END,
         CASE WHEN is_county THEN 'names only a county' END
       ) AS details
FROM (
  SELECT s.entity_id AS sample_id,
         length(s.locality) AS len,
         position(',' IN s.locality) > 0 AS has_comma,
         position('"' IN s.locality) > 0 AS has_quote,
         lower(trim(s.locality)) LIKE '% county' AS is_county
  FROM sample s
  WHERE s.locality IS NOT NULL
) flags
WHERE len > 18 OR has_comma OR has_quote OR is_county;
