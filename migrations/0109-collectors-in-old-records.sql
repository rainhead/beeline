-- needs: legacy_correction_state, legacy_correction_pivot, legacy_occurrence_corrected
--
-- Migration for ingest/promote-legacy.sql: recordedBy becomes a correctable
-- field of the old Beeline's records, so staff can correct a sample's
-- collectors and the legacy-format export and its comparison read the records
-- as corrected (beeline-kgyd.4.5). The three views that read the corrections
-- are promotion's, not the schema's, and production is never promoted again
-- (ADR 0006), so they are recreated here as promotion now makes them. A store
-- nothing was promoted into has none of them, and the first line has the
-- migration recorded there without running (src/migrate.ts).
--
-- Kept the same as the views in ingest/promote-legacy.sql:
-- test/sample-collectors-migration.test.ts compares them.

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
    WHEN 'recordedBy' THEN coalesce(r.recordedBy, '')
  END AS staged_value,
  CASE
    WHEN r._id IS NULL THEN 'orphaned'
    WHEN staged_value IS NULL THEN 'invalid_field'
    WHEN staged_value = coalesce(c.base_value, '')
      OR staged_value = coalesce(c.new_value, '') THEN 'applies'
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
  max(CASE WHEN field = 'fieldNumber' THEN coalesce(new_value, '') END) AS fieldNumber,
  max(CASE WHEN field = 'recordedBy' THEN coalesce(new_value, '') END) AS recordedBy
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
  coalesce(o.fieldNumber, r.fieldNumber) AS fieldNumber,
  coalesce(o.recordedBy, r.recordedBy) AS recordedBy
)
FROM legacy_occurrence r
LEFT JOIN legacy_correction_pivot o ON o._id = r._id;
