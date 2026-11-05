-- Migration for schema/155_views_print_run.sql: a new view, so nothing in
-- the store changes (beeline-fq3j).
--
-- Labels in a run that has not printed, whose sample no longer has the
-- values they were made from (beeline-fq3j). A run's labels are fixed when
-- it is prepared, but its samples are not printed yet, so they still follow
-- iNaturalist and the nightly jobs, and staff can still edit them: on the
-- first production run (2026-11-04) localities were being corrected during
-- proofing, and the run page said nothing about which labels those edits had
-- left behind. printed_label keeps the values each label was rendered from
-- (src/print-run.ts, inputFor), so the comparison is with those, never with
-- the label text. One row per label and field that differs, the field named
-- in a fixed vocabulary so the run page can word it.
--
-- The collector line is not compared: a label keeps its text, not the list
-- of collectors it was made from.
CREATE VIEW printed_label_out_of_date AS
WITH open_label AS (
  SELECT pl.print_run_id, pl.specimen_id, sp.sample_id,
         pl.locality, pl.county, pl.state_province, pl.country,
         pl.latitude, pl.longitude, pl.elevation_m, pl.date_start, pl.date_end
  FROM printed_label pl
  JOIN print_run r ON r.entity_id = pl.print_run_id
  JOIN specimen sp ON sp.entity_id = pl.specimen_id
  WHERE r.printed_at IS NULL AND r.canceled_at IS NULL
),
pair AS (
  SELECT l.*,
         s.locality AS now_locality, s.county AS now_county,
         s.state_province AS now_state_province, s.country AS now_country,
         loc.latitude AS now_latitude, loc.longitude AS now_longitude, loc.elevation_m AS now_elevation_m,
         s.date_start AS now_date_start, s.date_end AS now_date_end
  FROM open_label l
  JOIN sample s ON s.entity_id = l.sample_id
  LEFT JOIN sample_location loc ON loc.sample_id = l.sample_id
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
FROM pair WHERE date_start IS DISTINCT FROM now_date_start OR date_end IS DISTINCT FROM now_date_end;
COMMENT ON VIEW printed_label_out_of_date IS 'Labels in a run not yet printed (and not canceled) whose sample has changed since the run was prepared: one row per label and changed field (locality, county, state_province, country, coordinates, elevation, dates), with the value on the label and the value now. The run page lists these so the printer can cancel and prepare again, or print and reprint (beeline-fq3j). The collector line is not compared.';
