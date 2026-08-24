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

-- Staged columns coalesce to '' here: a key absent from the source document
-- stages as NULL, and both CSVs anchor fixes to such fields on base_value ''
-- (the app writes member[field] ?? ''). NULL staged_value therefore means
-- exactly "field name outside the correctable vocabulary" (beeline-qeu).
CREATE OR REPLACE VIEW legacy_correction_state AS
SELECT c.*,
  CASE c.field
    WHEN 'firstName' THEN coalesce(r.firstName, '') WHEN 'lastName' THEN coalesce(r.lastName, '')
    WHEN 'sampleId' THEN coalesce(r.sampleId, '') WHEN 'specimenId' THEN coalesce(r.specimenId, '')
    WHEN 'day' THEN coalesce(r.day, '') WHEN 'month' THEN coalesce(r.month, '') WHEN 'year' THEN coalesce(r.year, '')
    WHEN 'day2' THEN coalesce(r.day2, '') WHEN 'month2' THEN coalesce(r.month2, '') WHEN 'year2' THEN coalesce(r.year2, '')
    WHEN 'decimalLatitude' THEN coalesce(r.decimalLatitude, '')
    WHEN 'decimalLongitude' THEN coalesce(r.decimalLongitude, '')
    WHEN 'coordinateUncertaintyInMeters' THEN coalesce(r.coordinateUncertaintyInMeters, '')
    WHEN 'verbatimElevation' THEN coalesce(r.verbatimElevation, '')
    WHEN 'country' THEN coalesce(r.country, '') WHEN 'stateProvince' THEN coalesce(r.stateProvince, '')
    WHEN 'county' THEN coalesce(r.county, '') WHEN 'locality' THEN coalesce(r.locality, '')
    WHEN 'samplingProtocol' THEN coalesce(r.samplingProtocol, '')
    WHEN 'fieldNumber' THEN coalesce(r.fieldNumber, '')
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
-- Who collected is recordedBy, not firstName/lastName. Two thirds of trap
-- specimens were collected by a pair, and only recordedBy holds them as a
-- Darwin Core list — 'Michael O''Loughlin | Dan O''Loughlin' — while the name
-- columns hold whatever the entry form allowed that year ('Michael and Dan',
-- 'Michael | Dan', surnames doubled or not). Keying identity on the list's
-- members is what stops one couple becoming three fake people, and it merges
-- their joint rows with the samples each of them collected alone.
CREATE OR REPLACE VIEW legacy_collector_name AS
WITH pairs AS (
  SELECT DISTINCT fn, ln,
    CASE WHEN nullif(trim(recordedBy), '') IS NULL
         THEN [concat_ws(' ', fn, ln)]  -- 4 rows in 383k; the name columns are the fallback
         ELSE list_transform(string_split(recordedBy, '|'), x -> trim(x))
    END AS names
  FROM legacy_promotable
)
SELECT fn, ln, i AS pos, names[i] AS name
FROM pairs, range(1, len(names) + 1) g(i)
WHERE nullif(trim(names[i]), '') IS NOT NULL;

-- A pair that names exactly one collector. Name parts and iNat accounts are
-- believed only from these: on a joint row, firstName/lastName describe the
-- group, and userLogin belongs to whoever happened to file it.
CREATE OR REPLACE VIEW legacy_solo_pair AS
SELECT fn, ln FROM legacy_collector_name GROUP BY fn, ln HAVING max(pos) = 1;

CREATE TABLE legacy_person_name AS
SELECT name, nextval('entity_id_seq') AS person_id
FROM (SELECT DISTINCT name FROM legacy_collector_name);

-- Name parts survive promotion: a label prints the initial and the whole
-- family name, which cannot be recovered from a joined display name
-- (Van Otterloo, Benitez Alvarez). See src/person-name.ts. Someone who only
-- ever appears inside a joint recordedBy has no parted name to take, and
-- keeps NULL parts — their label falls back to the full name.
-- ...and only where that one name is the pair's own: a pair whose recordedBy
-- names somebody else ('Mark Gorman' rows recorded by 'Pam Arion') would
-- otherwise hand Pam the name parts off Mark's columns. Matched
-- case-insensitively, so 'Amy GRotta' still takes Amy's parts.
CREATE TABLE legacy_person_parts AS
SELECT c.name,
       arg_min(c.fn, concat(c.fn, ' ', c.ln)) AS fn,
       arg_min(c.ln, concat(c.fn, ' ', c.ln)) AS ln
FROM legacy_collector_name c
JOIN legacy_solo_pair sp ON sp.fn IS NOT DISTINCT FROM c.fn AND sp.ln IS NOT DISTINCT FROM c.ln
WHERE lower(c.name) = lower(concat_ws(' ', c.fn, c.ln))
GROUP BY c.name;

INSERT INTO person (entity_id, display_name, given_name, family_name)
SELECT n.person_id, n.name, nullif(p.fn, ''), nullif(p.ln, '')
FROM legacy_person_name n
LEFT JOIN legacy_person_parts p ON p.name = n.name;

-- Every (fn, ln) pair resolves to the person named first in its recordedBy —
-- the primary collector, whose sample numbering the rows carry. Downstream
-- joins still key on the raw pair; the joint pairs now land on a real person.
--
-- Exactly one row per pair, or every downstream join fans out (a pair mapped
-- to two people duplicates its samples, and with them its specimens). Five
-- pairs in 383k rows disagree with themselves about who was listed first —
-- 'Mark Gorman' rows whose recordedBy starts 'Pam Arion', 'Amy Grotta' rows
-- spelled 'Amy GRotta'. The pair's own name columns break the tie, and plain
-- name order breaks it when none matches, so the choice is deterministic;
-- the person not chosen still exists and still lands in sample_collector.
CREATE TABLE legacy_person_map AS
SELECT fn, ln, person_id FROM (
  SELECT c.fn, c.ln, n.person_id,
         row_number() OVER (
           PARTITION BY c.fn, c.ln
           ORDER BY CASE WHEN lower(c.name) = lower(concat_ws(' ', c.fn, c.ln)) THEN 0 ELSE 1 END,
                    c.name
         ) AS rn
  FROM legacy_collector_name c
  JOIN legacy_person_name n ON n.name = c.name
  WHERE c.pos = 1
) ranked
WHERE rn = 1;

-- iNat accounts: the account a person actually files under, measured by how
-- many of their records carry it (beeline-eft).
--
-- A login is not a name. It appears on a record because someone typed that
-- record in, so an active volunteer's login also lands on records they
-- entered for other people: 'amelathopoulos' sits on 3,019 of Andony's rows
-- and 151 of Emily Carlson's. Treating that spread as ambiguity discarded the
-- busiest — most trustworthy — logins and left the person bound to whatever
-- stray survived, so one typo'd row beat three thousand good ones. Weight
-- decides both directions instead: the account belongs to whoever files most
-- under it, and a person is bound to the login most of their records carry.
INSERT INTO inat_account (person_id, inat_user_id, login)
WITH login_person AS (
  SELECT r.userLogin AS login, try_cast(r.userId AS BIGINT) AS uid,
         m.person_id, count(*) AS records
  FROM legacy_promotable r
  JOIN legacy_solo_pair sp ON sp.fn IS NOT DISTINCT FROM r.fn AND sp.ln IS NOT DISTINCT FROM r.ln
  JOIN legacy_person_map m ON m.fn IS NOT DISTINCT FROM r.fn AND m.ln IS NOT DISTINCT FROM r.ln
  WHERE r.userLogin <> '' AND try_cast(r.userId AS BIGINT) IS NOT NULL
  GROUP BY 1, 2, 3
),
-- Whose account it is. Keyed on uid, not the login string: the same account
-- can appear under an old and a new name, and inat_user_id is what is
-- actually unique. A tie names nobody — two people with equal claim on one
-- account is a person-split to investigate, not a coin to flip.
owned AS (
  SELECT * FROM login_person
  QUALIFY row_number() OVER (PARTITION BY uid ORDER BY records DESC, person_id) = 1
      AND records > coalesce(lead(records) OVER (PARTITION BY uid ORDER BY records DESC, person_id), 0)
)
-- One row per person: of the accounts they own, the one they file under.
SELECT person_id, uid, login FROM owned
QUALIFY row_number() OVER (PARTITION BY person_id ORDER BY records DESC, login) = 1;

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

-- Everyone who collected each sample, primary first. A sample can gather rows
-- recorded both jointly and solo, and the O'Loughlins wrote their pair in both
-- orders, so a person is taken once at their earliest position and the whole
-- list is renumbered with the primary pinned to 1.
INSERT INTO sample_collector (sample_id, person_id, position)
SELECT sample_id, person_id,
       row_number() OVER (PARTITION BY sample_id ORDER BY is_primary DESC, first_pos, person_id)
FROM (
  SELECT s.sample_id,
         n.person_id,
         min(c.pos) AS first_pos,
         max(CASE WHEN n.person_id = s.person_id THEN 1 ELSE 0 END) AS is_primary
  FROM legacy_promotable r
  JOIN legacy_person_map m ON m.fn IS NOT DISTINCT FROM r.fn AND m.ln IS NOT DISTINCT FROM r.ln
  JOIN legacy_sample_map s
    ON s.person_id = m.person_id AND s.sid IS NOT DISTINCT FROM r.sid AND s.p_date_start = r.p_date_start
  JOIN legacy_collector_name c ON c.fn IS NOT DISTINCT FROM r.fn AND c.ln IS NOT DISTINCT FROM r.ln
  JOIN legacy_person_name n ON n.name = c.name
  GROUP BY s.sample_id, n.person_id
) g;

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
-- specimen_number is 1..N *within the sample* (schema/030), and a sample can
-- now gather staged rows that legacy numbered in separate series: the
-- O'Loughlins' trap line was recorded both as "Michael and Dan O'Loughlin"
-- and as "Michael O'Loughlin", each numbered from 1, and both spellings
-- resolve to one person and therefore one sample (beeline-77j). Copying the
-- legacy number would collide on (sample_id, specimen_number) for 20 samples,
-- so the number is assigned here, per sample, ordered by the legacy number
-- and then by _id so a re-run assigns the same numbers.
--
-- Every staged row keeps its own specimen: the two series may or may not be
-- the same physical bees (same print date, different fieldNumber batches,
-- determinations on only one side — beeline-vyq), and ingestion does not get
-- to decide that by dropping rows. fieldNumber, the identity that is
-- physically on the label, rides along untouched.
CREATE TABLE legacy_specimen_number AS
SELECT r._id,
       s.sample_id,
       CAST(row_number() OVER (PARTITION BY s.sample_id
                               ORDER BY r.p_specimen_number, r._id) AS INTEGER) AS specimen_number
FROM legacy_promotable r
JOIN legacy_person_map m ON m.fn IS NOT DISTINCT FROM r.fn AND m.ln IS NOT DISTINCT FROM r.ln
JOIN legacy_sample_map s
  ON s.person_id = m.person_id AND s.sid = r.sid
 AND s.p_date_start IS NOT DISTINCT FROM r.p_date_start;

INSERT INTO specimen (sample_id, specimen_number, field_number)
SELECT n.sample_id, n.specimen_number, nullif(r.fieldNumber, '')
FROM legacy_specimen_number n
JOIN legacy_promotable r ON r._id = n._id;

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
