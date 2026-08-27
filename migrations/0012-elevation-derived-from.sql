-- Migration for schema/030_samples_specimens.sql and schema/170_views_elevation.sql
-- (beeline-x5c): record the coordinates an elevation was derived from.
--
-- elevation_m is documented as a property of the coordinates beside it, and
-- nothing enforced that. Correctness lived in each coordinate writer
-- remembering to clear the elevation on a move — one statement in observation
-- promotion did, and staff entry, legacy re-promotion, the phase-3 coordinate
-- upgrade and corrections are all paths that would have had to learn it
-- separately. A stale elevation prints on a physical label and is permanent.
--
-- Backfill: every elevation this store already holds was derived from the
-- coordinates it sits beside, either by OBP-Server at legacy import or by the
-- derive job, and no coordinate has moved under one since. So the existing
-- pair is the honest answer, and after this migration sample_elevation_stale
-- is empty — as a fresh build's is.
ALTER TABLE sample_location ADD COLUMN elevation_latitude DOUBLE;
ALTER TABLE sample_location ADD COLUMN elevation_longitude DOUBLE;

UPDATE sample_location
   SET elevation_latitude = latitude, elevation_longitude = longitude
 WHERE elevation_m IS NOT NULL;

COMMENT ON COLUMN sample_location.elevation_latitude IS 'The coordinates the elevation was derived from, so the store can answer whether it is still about this point. Without them, moving latitude/longitude leaves an elevation that is silently about somewhere else and no query can tell — the drift is only visible if every writer remembers to clear it (beeline-x5c).';
COMMENT ON COLUMN sample_location.elevation_longitude IS 'See elevation_latitude. Paired with it by CHECK, and with elevation_m through it: an elevation never exists without the point it describes.';

-- DuckDB cannot add a CHECK to an existing table, so the two new pairing
-- constraints (elevation_m ⇔ elevation_latitude ⇔ elevation_longitude) exist
-- on freshly built stores and not here. The views below are what actually
-- keeps a deployed store honest — a violation shows up as a stale row rather
-- than a refused write — and the constraints arrive on the next rebuild.

CREATE VIEW sample_elevation_stale AS
SELECT sample_id, latitude, longitude, elevation_m,
       elevation_latitude, elevation_longitude
FROM sample_location
WHERE elevation_m IS NOT NULL
  AND (abs(elevation_latitude - latitude) > 5e-5
    OR abs(elevation_longitude - longitude) > 5e-5);

CREATE VIEW sample_elevation_pending AS
SELECT sample_id, latitude, longitude FROM sample_location
WHERE elevation_m IS NULL
UNION ALL
SELECT sample_id, latitude, longitude FROM sample_elevation_stale;
