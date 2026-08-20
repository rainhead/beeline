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
FROM legacy_occurrence;

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
WHERE coordinateUncertaintyInMeters <> '' AND p_uncertainty IS NULL;

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
-- take the representative row (min _id); within-group disagreement is a
-- known follow-up, not yet a finding.
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
