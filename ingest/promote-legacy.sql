-- Promote legacy_occurrence staging rows into the model. Pipeline SQL, not
-- schema: DuckDB-specific constructs (macros, arg_min, try_cast) are fine
-- here per ADR 0001. Runs once against a freshly built + staged database
-- (src/promote-legacy.ts guards that the model is empty).
--
-- Person grain is the NAME PAIR, not the iNat login (surveyed 2026-08-20):
-- 68,566 rows have no login at all (CSV-era), several logins are shared
-- accounts spanning multiple people (pandg, molfamily), and 67 name pairs
-- span multiple logins. Logins attach as inat_account only when the mapping
-- is unambiguous in both directions.
--
-- kind: a sample with a date range is a trap sample — the definitional
-- criterion (CONTEXT.md); sampleId prefixes also occur on net data (G/R/…).

-- ── Corrections over staging (ADR 0004, frozen-upstream case) ───────────
-- Staff fixes for rows whose upstream is frozen or wrong forever, keyed by
-- Mongo _id + staging column name, curated in git (the CSV survives the
-- blow-away era the way determiner-aliases.csv does). Three-way per ADR
-- 0004 with the staged row as "theirs": staged = base → applies; staged =
-- new (someone fixed upstream after all) → retires; staged moved elsewhere
-- → the correction stands and a finding opens. The correctable vocabulary
-- is the identity/parse/label columns promotion reads — extend the three
-- lists below together when widening it.
-- Two correction files share one vocabulary and one merge rule: the
-- git-curated CSV (staff, reviewed in PRs) and the app-written store
-- (data/corrections.csv — volunteers' in-app sample edits, beeline-2c3.8,
-- outside the blow-away path so they survive rebuilds). The app keeps one
-- current row per (_id, field) (src/corrections.ts), and where both files
-- correct the same field the app row wins — it is newer by construction;
-- staff graduate app rows into the git CSV when curating.
CREATE TABLE legacy_app_correction AS
SELECT * FROM read_csv('{{APP_CORRECTIONS}}', header = true, columns = {
  '_id': 'VARCHAR', 'field': 'VARCHAR', 'base_value': 'VARCHAR',
  'new_value': 'VARCHAR', 'author': 'VARCHAR', 'reason': 'VARCHAR'});

CREATE TABLE legacy_correction AS
SELECT * FROM legacy_app_correction
UNION ALL
SELECT g.*
FROM read_csv('{{LEGACY_CORRECTIONS}}', header = true, columns = {
  '_id': 'VARCHAR', 'field': 'VARCHAR', 'base_value': 'VARCHAR',
  'new_value': 'VARCHAR', 'author': 'VARCHAR', 'reason': 'VARCHAR'}) g
WHERE NOT EXISTS (
  SELECT 1 FROM legacy_app_correction a
  WHERE a._id = g._id AND a.field = g.field
);

CREATE OR REPLACE VIEW legacy_correction_state AS
SELECT c.*,
  CASE c.field
    WHEN 'firstName' THEN r.firstName WHEN 'lastName' THEN r.lastName
    WHEN 'sampleId' THEN r.sampleId WHEN 'specimenId' THEN r.specimenId
    WHEN 'day' THEN r.day WHEN 'month' THEN r.month WHEN 'year' THEN r.year
    WHEN 'day2' THEN r.day2 WHEN 'month2' THEN r.month2 WHEN 'year2' THEN r.year2
    WHEN 'decimalLatitude' THEN r.decimalLatitude
    WHEN 'decimalLongitude' THEN r.decimalLongitude
    WHEN 'coordinateUncertaintyInMeters' THEN r.coordinateUncertaintyInMeters
    WHEN 'verbatimElevation' THEN r.verbatimElevation
    WHEN 'country' THEN r.country WHEN 'stateProvince' THEN r.stateProvince
    WHEN 'county' THEN r.county WHEN 'locality' THEN r.locality
    WHEN 'samplingProtocol' THEN r.samplingProtocol
    WHEN 'fieldNumber' THEN r.fieldNumber
  END AS staged_value,
  CASE
    WHEN r._id IS NULL THEN 'orphaned'
    WHEN staged_value IS NULL THEN 'invalid_field'
    WHEN staged_value = coalesce(c.new_value, '') THEN 'retired'
    WHEN staged_value = coalesce(c.base_value, '') THEN 'applies'
    ELSE 'conflict'
  END AS status
FROM legacy_correction c
LEFT JOIN legacy_occurrence r ON r._id = c._id;

-- One row per corrected record; a correction TO empty pivots as '' (never
-- NULL), so coalesce in the overlay cannot mistake it for "no correction".
CREATE OR REPLACE VIEW legacy_correction_pivot AS
SELECT _id,
  max(CASE WHEN field = 'firstName' THEN coalesce(new_value, '') END) AS firstName,
  max(CASE WHEN field = 'lastName' THEN coalesce(new_value, '') END) AS lastName,
  max(CASE WHEN field = 'sampleId' THEN coalesce(new_value, '') END) AS sampleId,
  max(CASE WHEN field = 'specimenId' THEN coalesce(new_value, '') END) AS specimenId,
  max(CASE WHEN field = 'day' THEN coalesce(new_value, '') END) AS day,
  max(CASE WHEN field = 'month' THEN coalesce(new_value, '') END) AS month,
  max(CASE WHEN field = 'year' THEN coalesce(new_value, '') END) AS year,
  max(CASE WHEN field = 'day2' THEN coalesce(new_value, '') END) AS day2,
  max(CASE WHEN field = 'month2' THEN coalesce(new_value, '') END) AS month2,
  max(CASE WHEN field = 'year2' THEN coalesce(new_value, '') END) AS year2,
  max(CASE WHEN field = 'decimalLatitude' THEN coalesce(new_value, '') END) AS decimalLatitude,
  max(CASE WHEN field = 'decimalLongitude' THEN coalesce(new_value, '') END) AS decimalLongitude,
  max(CASE WHEN field = 'coordinateUncertaintyInMeters' THEN coalesce(new_value, '') END) AS coordinateUncertaintyInMeters,
  max(CASE WHEN field = 'verbatimElevation' THEN coalesce(new_value, '') END) AS verbatimElevation,
  max(CASE WHEN field = 'country' THEN coalesce(new_value, '') END) AS country,
  max(CASE WHEN field = 'stateProvince' THEN coalesce(new_value, '') END) AS stateProvince,
  max(CASE WHEN field = 'county' THEN coalesce(new_value, '') END) AS county,
  max(CASE WHEN field = 'locality' THEN coalesce(new_value, '') END) AS locality,
  max(CASE WHEN field = 'samplingProtocol' THEN coalesce(new_value, '') END) AS samplingProtocol,
  max(CASE WHEN field = 'fieldNumber' THEN coalesce(new_value, '') END) AS fieldNumber
FROM legacy_correction_state
WHERE status IN ('applies', 'conflict')
GROUP BY _id;

CREATE OR REPLACE VIEW legacy_occurrence_corrected AS
SELECT r.* REPLACE (
  coalesce(o.firstName, r.firstName) AS firstName,
  coalesce(o.lastName, r.lastName) AS lastName,
  coalesce(o.sampleId, r.sampleId) AS sampleId,
  coalesce(o.specimenId, r.specimenId) AS specimenId,
  coalesce(o.day, r.day) AS day,
  coalesce(o.month, r.month) AS month,
  coalesce(o.year, r.year) AS year,
  coalesce(o.day2, r.day2) AS day2,
  coalesce(o.month2, r.month2) AS month2,
  coalesce(o.year2, r.year2) AS year2,
  coalesce(o.decimalLatitude, r.decimalLatitude) AS decimalLatitude,
  coalesce(o.decimalLongitude, r.decimalLongitude) AS decimalLongitude,
  coalesce(o.coordinateUncertaintyInMeters, r.coordinateUncertaintyInMeters) AS coordinateUncertaintyInMeters,
  coalesce(o.verbatimElevation, r.verbatimElevation) AS verbatimElevation,
  coalesce(o.country, r.country) AS country,
  coalesce(o.stateProvince, r.stateProvince) AS stateProvince,
  coalesce(o.county, r.county) AS county,
  coalesce(o.locality, r.locality) AS locality,
  coalesce(o.samplingProtocol, r.samplingProtocol) AS samplingProtocol,
  coalesce(o.fieldNumber, r.fieldNumber) AS fieldNumber
)
FROM legacy_occurrence r
LEFT JOIN legacy_correction_pivot o ON o._id = r._id;

-- ── Parsing ─────────────────────────────────────────────────────────────
-- Months arrive mostly numeric with a roman-numeral minority.
CREATE OR REPLACE MACRO legacy_month(m) AS coalesce(
  try_cast(m AS INTEGER),
  CASE upper(trim(m))
    WHEN 'I' THEN 1 WHEN 'II' THEN 2 WHEN 'III' THEN 3 WHEN 'IV' THEN 4
    WHEN 'V' THEN 5 WHEN 'VI' THEN 6 WHEN 'VII' THEN 7 WHEN 'VIII' THEN 8
    WHEN 'IX' THEN 9 WHEN 'X' THEN 10 WHEN 'XI' THEN 11 WHEN 'XII' THEN 12
  END);

CREATE OR REPLACE MACRO legacy_date(d, m, y) AS
  CAST(try_strptime(y || '-' || legacy_month(m) || '-' || d, '%Y-%m-%d') AS DATE);

-- '30' and '30.5' both count; garbage does not.
CREATE OR REPLACE MACRO legacy_int(s) AS
  coalesce(try_cast(s AS INTEGER), CAST(try_cast(s AS DOUBLE) AS INTEGER));

CREATE OR REPLACE VIEW legacy_parsed AS
SELECT *,
  nullif(trim(firstName), '')  AS fn,
  nullif(trim(lastName), '')   AS ln,
  nullif(trim(sampleId), '')   AS sid,
  legacy_date(day, month, year)                                  AS p_date_start,
  CASE WHEN year2 <> '' THEN legacy_date(day2, month2, year2) END AS p_date_end,
  try_cast(specimenId AS INTEGER)          AS p_specimen_number,
  try_cast(decimalLatitude AS DOUBLE)      AS p_lat,
  try_cast(decimalLongitude AS DOUBLE)     AS p_lon,
  legacy_int(coordinateUncertaintyInMeters) AS p_uncertainty,
  legacy_int(verbatimElevation)            AS p_elevation,
  try_cast(regexp_extract(url, '([0-9]+)$', 1) AS BIGINT) AS p_inat_obs_id
FROM legacy_occurrence_corrected;

-- ── Deduplication ───────────────────────────────────────────────────────
-- The hash-id bug duplicated specimens: same (person, date, sample,
-- specimen) printed under two fieldNumbers on two dates. Keep the latest
-- print, deterministically; losers become findings.
CREATE OR REPLACE VIEW legacy_ranked AS
SELECT *,
  row_number() OVER (
    PARTITION BY fn, ln, sid, p_date_start, p_specimen_number
    ORDER BY try_strptime(dateLabelPrint, '%d-%b-%y') DESC NULLS LAST,
             fieldNumber DESC, _id
  ) AS dup_rank
FROM legacy_parsed;

-- ── Findings over staging ───────────────────────────────────────────────
-- Keyed by Mongo _id: this is where problems live for rows that never
-- become samples (beeline-42y). severity 'blocking' rows do not promote.
CREATE OR REPLACE VIEW legacy_promotion_finding AS
SELECT _id, 'missing_person' AS rule, 'blocking' AS severity,
       'no first or last name' AS details
FROM legacy_parsed WHERE fn IS NULL AND ln IS NULL
UNION ALL
SELECT _id, 'missing_sample_number', 'blocking', 'sampleId is empty'
FROM legacy_parsed WHERE sid IS NULL
UNION ALL
SELECT _id, 'bad_date', 'blocking',
       concat('unparseable date ', day, '/', month, '/', year)
FROM legacy_parsed WHERE p_date_start IS NULL
UNION ALL
SELECT _id, 'bad_date', 'blocking',
       concat('end date ', day2, '/', month2, '/', year2, ' precedes start or is unparseable')
FROM legacy_parsed WHERE year2 <> '' AND (p_date_end IS NULL OR p_date_end < p_date_start)
UNION ALL
SELECT _id, 'bad_specimen_number', 'blocking',
       concat('specimenId ''', specimenId, '''')
FROM legacy_parsed WHERE p_specimen_number IS NULL OR p_specimen_number <= 0
UNION ALL
SELECT _id, 'duplicate_specimen', 'blocking',
       concat('same specimen as a later print; fieldNumber ', fieldNumber)
FROM legacy_ranked WHERE dup_rank > 1
UNION ALL
SELECT _id, 'bad_coordinates', 'warning',
       concat('unparseable: ', decimalLatitude, ', ', decimalLongitude)
FROM legacy_parsed
WHERE (decimalLatitude <> '' OR decimalLongitude <> '')
  AND (p_lat IS NULL OR p_lon IS NULL)
UNION ALL
SELECT _id, 'bad_elevation', 'warning',
       concat('unparseable: ''', verbatimElevation, '''')
FROM legacy_parsed WHERE verbatimElevation <> '' AND p_elevation IS NULL
UNION ALL
SELECT _id, 'bad_uncertainty', 'warning',
       concat('unparseable: ''', coordinateUncertaintyInMeters, '''')
FROM legacy_parsed
WHERE coordinateUncertaintyInMeters <> '' AND p_uncertainty IS NULL
UNION ALL
-- Correction housekeeping (ADR 0004): a conflicted correction stands but
-- staff re-review; orphaned/invalid corrections are CSV mistakes to fix.
SELECT _id, 'correction_conflict', 'warning',
       concat(field, ': correction ''', coalesce(new_value, ''),
              ''' stands, but upstream moved from ''', coalesce(base_value, ''),
              ''' to ''', staged_value, '''')
FROM legacy_correction_state WHERE status = 'conflict'
UNION ALL
SELECT _id, 'correction_orphaned', 'warning',
       concat(field, ': no staging row with this _id')
FROM legacy_correction_state WHERE status = 'orphaned'
UNION ALL
SELECT _id, 'correction_invalid_field', 'warning',
       concat('''', field, ''' is not a correctable column')
FROM legacy_correction_state WHERE status = 'invalid_field'
UNION ALL
SELECT _id, 'correction_duplicate', 'warning',
       concat(field, ': ', count(*), ' corrections for one field — the max new_value wins')
FROM legacy_correction_state
GROUP BY _id, field HAVING count(*) > 1;

CREATE OR REPLACE VIEW legacy_promotable AS
SELECT * FROM legacy_ranked r
WHERE dup_rank = 1
  AND NOT EXISTS (
    SELECT 1 FROM legacy_promotion_finding f
    WHERE f._id = r._id AND f.severity = 'blocking'
  );

-- ── People ──────────────────────────────────────────────────────────────
CREATE TABLE legacy_person_map AS
SELECT fn, ln, nextval('entity_id_seq') AS person_id
FROM (SELECT DISTINCT fn, ln FROM legacy_promotable);

INSERT INTO person (entity_id, display_name)
SELECT person_id, concat_ws(' ', fn, ln) FROM legacy_person_map;

-- iNat accounts: only where login ↔ name pair is unambiguous both ways.
INSERT INTO inat_account (person_id, inat_user_id, login)
SELECT m.person_id, c.uid, c.login
FROM (
  SELECT login, max(uid) AS uid, arg_min(fn, fn) AS fn, arg_min(ln, ln) AS ln
  FROM (
    SELECT DISTINCT userLogin AS login, fn, ln, try_cast(userId AS BIGINT) AS uid
    FROM legacy_promotable
    WHERE userLogin <> '' AND try_cast(userId AS BIGINT) IS NOT NULL
  ) pairs
  GROUP BY login
  HAVING count(DISTINCT (fn, ln)) = 1
) c
JOIN legacy_person_map m ON m.fn IS NOT DISTINCT FROM c.fn AND m.ln IS NOT DISTINCT FROM c.ln
QUALIFY row_number() OVER (PARTITION BY m.person_id ORDER BY c.login) = 1;

-- ── Samples ─────────────────────────────────────────────────────────────
-- One sample per (person, start date, sample number). Descriptive fields
-- take the representative row (min _id); within-group disagreement becomes
-- a sample_promotion_finding below.
CREATE TABLE legacy_sample_map AS
SELECT
  m.person_id,
  r.sid, r.p_date_start,
  coalesce(max(r.p_date_end), r.p_date_start)      AS date_end,
  CASE WHEN max(r.p_date_end) IS NOT NULL THEN 'trap' ELSE 'net' END AS kind,
  count(*)                                          AS specimen_count,
  arg_min(r.country, r._id)                         AS country,
  arg_min(r.stateProvince, r._id)                   AS state_province,
  arg_min(r.county, r._id)                          AS county,
  arg_min(r.locality, r._id)                        AS locality,
  arg_min(r.samplingProtocol, r._id)                AS protocol,
  arg_min(r.p_inat_obs_id, r._id)                   AS inat_obs_id,
  arg_min(coalesce(
    nullif(r.speciesPlant, ''), nullif(r.genusPlant, ''), nullif(r.familyPlant, ''),
    nullif(r.orderPlant, ''), nullif(r.phylumPlant, '')), r._id) AS host_name,
  arg_min(r.p_lat, r._id)                           AS lat,
  arg_min(r.p_lon, r._id)                           AS lon,
  arg_min(r.p_uncertainty, r._id)                   AS uncertainty,
  arg_min(r.p_elevation, r._id)                     AS elevation,
  nextval('entity_id_seq')                          AS sample_id
FROM legacy_promotable r
JOIN legacy_person_map m ON m.fn IS NOT DISTINCT FROM r.fn AND m.ln IS NOT DISTINCT FROM r.ln
GROUP BY m.person_id, r.sid, r.p_date_start;

INSERT INTO sample (entity_id, kind, collector_id, atlas_id, sample_number,
                    date_start, date_end, specimen_count, inat_observation_id,
                    host_name_as_observed, country, state_province, county,
                    locality, protocol)
SELECT s.sample_id, s.kind, s.person_id,
       a.entity_id,
       s.sid, s.p_date_start, s.date_end, s.specimen_count, s.inat_obs_id,
       s.host_name,
       nullif(s.country, ''), nullif(s.state_province, ''),
       nullif(s.county, ''), nullif(s.locality, ''), nullif(s.protocol, '')
FROM legacy_sample_map s
LEFT JOIN atlas a ON a.code = CASE s.state_province
  WHEN 'OR' THEN 'OBA' WHEN 'WA' THEN 'WaBA' WHEN 'BC' THEN 'BC'
  WHEN 'ID' THEN 'ID'  WHEN 'NM' THEN 'NM'   WHEN 'OK' THEN 'OK' END;

-- ── Locations ───────────────────────────────────────────────────────────
-- Production Mongo has no coordinate provenance (nothing obscured-marked
-- either), so everything lands as source 'legacy_import'; phase-3 sync can
-- upgrade. Elevations were derived by OBP-Server from SRTM tiles — one
-- shared source row, since per-record tile identity is unrecoverable.
INSERT INTO elevation_source (description)
VALUES ('legacy verbatimElevation: OBP-Server SRTM 1-arc-second lookup, tile unrecorded');

INSERT INTO sample_location (sample_id, latitude, longitude,
                             coordinate_uncertainty_m, elevation_m,
                             elevation_source_id, source)
SELECT s.sample_id, s.lat, s.lon, s.uncertainty, s.elevation,
       CASE WHEN s.elevation IS NOT NULL
            THEN (SELECT entity_id FROM elevation_source
                  WHERE description LIKE 'legacy verbatimElevation%') END,
       'legacy_import'
FROM legacy_sample_map s
WHERE s.lat IS NOT NULL AND s.lon IS NOT NULL;

-- ── Specimens ───────────────────────────────────────────────────────────
INSERT INTO specimen (sample_id, specimen_number, catalog_number)
SELECT s.sample_id, r.p_specimen_number, nullif(r.fieldNumber, '')
FROM legacy_promotable r
JOIN legacy_person_map m ON m.fn IS NOT DISTINCT FROM r.fn AND m.ln IS NOT DISTINCT FROM r.ln
JOIN legacy_sample_map s
  ON s.person_id = m.person_id AND s.sid = r.sid
 AND s.p_date_start IS NOT DISTINCT FROM r.p_date_start;

-- ── Within-sample disagreement (beeline-o8g) ────────────────────────────
-- The rows behind one sample can disagree on a descriptive field; the
-- representative (min _id) value was kept above, and the disagreement is
-- persisted as a sample-keyed finding — once staging is gone the model
-- alone cannot re-derive it. An empty value is "no opinion", not a
-- disagreement (a kept blank already surfaces through the missing_* rules).
-- This is also the entire residual of the errorFlags reconciliation:
-- legacy flagged per row, we flag per sample.
INSERT INTO sample_promotion_finding (sample_id, rule_name, details)
WITH member AS (
  SELECT s.sample_id, r.country, r.stateProvince, r.county, r.locality,
         r.samplingProtocol, r.p_lat, r.p_lon
  FROM legacy_promotable r
  JOIN legacy_person_map m ON m.fn IS NOT DISTINCT FROM r.fn AND m.ln IS NOT DISTINCT FROM r.ln
  JOIN legacy_sample_map s
    ON s.person_id = m.person_id AND s.sid = r.sid
   AND s.p_date_start IS NOT DISTINCT FROM r.p_date_start
), field_value AS (
  SELECT sample_id, 'country' AS field, nullif(country, '') AS value FROM member
  UNION ALL SELECT sample_id, 'state_province', nullif(stateProvince, '') FROM member
  UNION ALL SELECT sample_id, 'county', nullif(county, '') FROM member
  UNION ALL SELECT sample_id, 'locality', nullif(locality, '') FROM member
  UNION ALL SELECT sample_id, 'protocol', nullif(samplingProtocol, '') FROM member
  UNION ALL SELECT sample_id, 'coordinates',
    CASE WHEN p_lat IS NOT NULL AND p_lon IS NOT NULL
         THEN concat(p_lat, ' ', p_lon) END FROM member
)
SELECT sample_id, 'within_sample_disagreement',
       concat(field, ': ', array_to_string(list_sort(list(DISTINCT value)), ' | '))
FROM field_value
WHERE value IS NOT NULL
GROUP BY sample_id, field
HAVING count(DISTINCT value) > 1;
