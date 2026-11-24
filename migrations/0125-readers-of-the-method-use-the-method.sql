-- Migration for schema/035, 120 and 155 (beeline-ni5m.15, stage two): three readers of a sample's method text move to its method.
-- printed_label_out_of_date compares a label with the word the sample would print now, which is the label_word of its method (the
-- sample's kind where it has no method), as methodText does (src/label-text.ts) and not the word worked out from the text. On the
-- production copy of 2026-11-24 the two words agree for every sample with a method, so no label becomes out of date. The view
-- qc_rule_missing_required_field reports a missing method as a sample with no sample_method row, still named "protocol" in its
-- details; today it flags the same samples. Neither view is read by another view in a way that needs restating. Each view is
-- restated whole, and the comment of printed_label_out_of_date with it, since replacing a view drops its comment; the comment on
-- printed_label.method_text changes too.

CREATE OR REPLACE VIEW printed_label_out_of_date AS
WITH open_label AS (
  SELECT pl.print_run_id, pl.specimen_id, sp.sample_id,
         pl.locality, pl.county, pl.state_province, pl.country,
         pl.latitude, pl.longitude, pl.elevation_m, pl.date_start, pl.date_end,
         pl.method_text
  FROM printed_label pl
  JOIN print_run r ON r.entity_id = pl.print_run_id
  JOIN specimen sp ON sp.entity_id = pl.specimen_id
  WHERE r.printed_at IS NULL AND r.canceled_at IS NULL
),
joined AS (
  SELECT l.*,
         s.locality AS now_locality, s.county AS now_county,
         s.state_province AS now_state_province, s.country AS now_country,
         loc.latitude AS now_latitude, loc.longitude AS now_longitude, loc.elevation_m AS now_elevation_m,
         s.date_start AS now_date_start, s.date_end AS now_date_end,
         coalesce(md.label_word, s.kind) AS now_method
  FROM open_label l
  JOIN sample s ON s.entity_id = l.sample_id
  LEFT JOIN sample_method sm ON sm.sample_id = s.entity_id
  LEFT JOIN method md ON md.code = sm.method_code
  LEFT JOIN sample_location loc ON loc.sample_id = l.sample_id
)
SELECT print_run_id, specimen_id, sample_id, 'locality' AS field,
       locality AS on_label, now_locality AS now
FROM joined WHERE locality IS DISTINCT FROM now_locality
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'county', county, now_county
FROM joined WHERE county IS DISTINCT FROM now_county
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'state_province', state_province, now_state_province
FROM joined WHERE state_province IS DISTINCT FROM now_state_province
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'country', country, now_country
FROM joined WHERE country IS DISTINCT FROM now_country
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'coordinates',
       concat(CAST(latitude AS TEXT), ' ', CAST(longitude AS TEXT)),
       CASE WHEN now_latitude IS NOT NULL THEN concat(CAST(now_latitude AS TEXT), ' ', CAST(now_longitude AS TEXT)) END
FROM joined WHERE latitude IS DISTINCT FROM now_latitude OR longitude IS DISTINCT FROM now_longitude
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'elevation',
       CAST(elevation_m AS TEXT), CAST(now_elevation_m AS TEXT)
FROM joined WHERE elevation_m IS DISTINCT FROM now_elevation_m
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'dates',
       concat(CAST(date_start AS TEXT), ' – ', CAST(date_end AS TEXT)),
       concat(CAST(now_date_start AS TEXT), ' – ', CAST(now_date_end AS TEXT))
FROM joined WHERE date_start IS DISTINCT FROM now_date_start OR date_end IS DISTINCT FROM now_date_end
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'method', method_text, now_method
FROM joined WHERE method_text IS DISTINCT FROM now_method;
COMMENT ON VIEW printed_label_out_of_date IS 'Labels in a run not yet printed (and not canceled) whose sample has changed since the run was prepared: one row per label and changed field (locality, county, state_province, country, coordinates, elevation, dates, method), with the value on the label and the value now. The method is the word the label prints (the label word of the sample''s method, or its kind where it has no method), so a change of kind or method that leaves the word alone is not a change. The run page lists these so the printer can cancel and prepare again, or print and reprint (beeline-fq3j). The collector line is not compared.';

CREATE OR REPLACE VIEW qc_rule_missing_required_field AS
SELECT sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'missing_required_field' AS rule_name,
       concat_ws(', ',
         CASE WHEN missing_location THEN 'location' END,
         CASE WHEN country IS NULL THEN 'country' END,
         CASE WHEN state_province IS NULL THEN 'state_province' END,
         CASE WHEN locality IS NULL THEN 'locality' END,
         CASE WHEN missing_method THEN 'protocol' END
       ) AS details
FROM (
  SELECT s.entity_id AS sample_id, s.country, s.state_province, s.locality,
         (loc.sample_id IS NULL AND s.geoprivacy IS NULL AND s.taxon_geoprivacy IS NULL) AS missing_location,
         (m.sample_id IS NULL) AS missing_method
  FROM sample s
  LEFT JOIN sample_location loc ON loc.sample_id = s.entity_id
  LEFT JOIN sample_method m ON m.sample_id = s.entity_id
) t
WHERE missing_location
   OR country IS NULL OR state_province IS NULL
   OR locality IS NULL OR missing_method;

COMMENT ON COLUMN printed_label.method_text IS 'The word the method box prints (methodText, src/label-text.ts): the label word of the sample''s method (net, trap, nest or vacuum), or the kind of the sample where it has no method.';
