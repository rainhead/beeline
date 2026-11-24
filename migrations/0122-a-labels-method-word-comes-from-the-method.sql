-- Migration for schema/155_views_print_run.sql and schema/035_print_runs.sql:
-- the word printed_label_out_of_date compares a label's method with now comes
-- from the sample's method text (beeline-lmlh), not from the sample's kind.
-- nest if the text contains "nest", else trap if it contains "trap", else net
-- if it contains "net", ignoring case. Old Beeline's label code (since
-- January 2025) also used the text, testing net, then trap, then nest with the
-- first match winning, so it printed "trap" for "trap nest" where Beeline says
-- "nest"; for every other text production holds the two agree. A text naming
-- none of the three is the word itself ("vacuum") only for a sample of kind
-- net, when it is plain ASCII of at most 6 characters (Peter's limit for legibility; up to 12 would fit the
-- label's method box); otherwise, and where the text is empty, the word is the
-- sample's kind. It mirrors methodText (src/label-text.ts), making tabs, line
-- breaks and no-break spaces spaces with translate() before trimming. The
-- view is replaced in place; no table changes and no column does, and nothing
-- reads the view from another view. The whole view and its comment are
-- restated, since replacing a view drops its comment. The comment on
-- printed_label.method_text, which said "net, trap or nest", is restated too.

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
         s.kind AS now_kind,
         trim(translate(coalesce(s.protocol, ''),
                        concat(chr(9), chr(10), chr(11), chr(12), chr(13), chr(160)), '      '), ' ') AS now_raw
  FROM open_label l
  JOIN sample s ON s.entity_id = l.sample_id
  LEFT JOIN sample_location loc ON loc.sample_id = l.sample_id
),
pair AS (
  SELECT j.*,
         CASE WHEN now_raw = '' THEN now_kind
              WHEN lower(now_raw) LIKE '%nest%' THEN 'nest'
              WHEN lower(now_raw) LIKE '%trap%' THEN 'trap'
              WHEN lower(now_raw) LIKE '%net%' THEN 'net'
              WHEN now_kind = 'net' AND length(now_raw) <= 6 AND regexp_full_match(now_raw, '[ -~]+') THEN lower(now_raw)
              ELSE now_kind END AS now_method
  FROM joined j
)
SELECT print_run_id, specimen_id, sample_id, 'locality' AS field,
       locality AS on_label, now_locality AS now
FROM pair WHERE locality IS DISTINCT FROM now_locality
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'county', county, now_county
FROM pair WHERE county IS DISTINCT FROM now_county
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'state_province', state_province, now_state_province
FROM pair WHERE state_province IS DISTINCT FROM now_state_province
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'country', country, now_country
FROM pair WHERE country IS DISTINCT FROM now_country
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'coordinates',
       concat(CAST(latitude AS TEXT), ' ', CAST(longitude AS TEXT)),
       CASE WHEN now_latitude IS NOT NULL THEN concat(CAST(now_latitude AS TEXT), ' ', CAST(now_longitude AS TEXT)) END
FROM pair WHERE latitude IS DISTINCT FROM now_latitude OR longitude IS DISTINCT FROM now_longitude
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'elevation',
       CAST(elevation_m AS TEXT), CAST(now_elevation_m AS TEXT)
FROM pair WHERE elevation_m IS DISTINCT FROM now_elevation_m
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'dates',
       concat(CAST(date_start AS TEXT), ' – ', CAST(date_end AS TEXT)),
       concat(CAST(now_date_start AS TEXT), ' – ', CAST(now_date_end AS TEXT))
FROM pair WHERE date_start IS DISTINCT FROM now_date_start OR date_end IS DISTINCT FROM now_date_end
UNION ALL
SELECT print_run_id, specimen_id, sample_id, 'method', method_text, now_method
FROM pair WHERE method_text IS DISTINCT FROM now_method;
COMMENT ON VIEW printed_label_out_of_date IS 'Labels in a run not yet printed (and not canceled) whose sample has changed since the run was prepared: one row per label and changed field (locality, county, state_province, country, coordinates, elevation, dates, method), with the value on the label and the value now. The method is the word the label prints (from the protocol text: nest, trap or net, a short plain text as itself for a net sample, otherwise the kind), so a change of kind or protocol that leaves the word alone is not a change. The run page lists these so the printer can cancel and prepare again, or print and reprint (beeline-fq3j). The collector line is not compared.';
COMMENT ON COLUMN printed_label.method_text IS 'The word the method box prints (methodText, src/label-text.ts): nest, trap or net where the method text of the sample contains it, in that order; otherwise a short plain-ASCII method text as itself for a net sample (vacuum); otherwise the kind of the sample.';
