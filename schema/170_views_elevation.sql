-- Whether a derived elevation still describes the coordinates it sits beside.
--
-- elevation_m is documented as "a property of these believed-true
-- coordinates, derived from them" (schema/030). Nothing enforced that: a
-- writer that moved latitude/longitude and left the elevation alone produced
-- a row asserting an elevation for a point it was never measured at, and no
-- query could tell. Correctness lived in each writer remembering to clear it,
-- which is a rule every new write path gets a fresh chance to miss —
-- staff_entry, legacy re-promotion, the phase-3 coordinate upgrade,
-- corrections (beeline-x5c).
--
-- Now elevation_latitude/elevation_longitude record the point, and these two
-- views own the rule. The derive job reads sample_elevation_pending, so a
-- forgotten clear self-heals on the next run instead of waiting to be
-- noticed; sample_elevation_stale is what a test asserts empty after
-- promotion, and what says so out loud if it is not.
--
-- The tolerance is the reference system's export precision: legacy Mongo
-- carries 4 decimal places, so "same place, rounded" is a delta of at most
-- 5e-5 degrees (~5.5 m, well under an SRTM cell). Below that a re-derivation
-- would read the same DEM pixel and change nothing.
-- An elevation whose point is unknown is not known to be about this point,
-- so it is stale too. On a fresh build the CHECK makes that state
-- unreachable; on a store migrated by 0012 it is reachable, because DuckDB
-- cannot add a CHECK to an existing table (ADR 0006) — which is exactly the
-- store this view is the safety net for. Without the NULL clause the
-- comparison yields NULL, the row is neither stale nor pending, and the net
-- has a hole precisely where it is load-bearing.
CREATE VIEW sample_elevation_stale AS
SELECT sample_id, latitude, longitude, elevation_m,
       elevation_latitude, elevation_longitude
FROM sample_location
WHERE elevation_m IS NOT NULL
  AND (elevation_latitude IS NULL
    OR elevation_longitude IS NULL
    OR abs(elevation_latitude - latitude) > 5e-5
    OR abs(elevation_longitude - longitude) > 5e-5);

-- Everything the derive job should look at: never derived, or derived
-- somewhere else. Deliberately not a QC rule — a missing or stale elevation
-- is derived from coordinates and is never the collector's gap to fill
-- (schema/120), so it belongs to the pipeline, not to anyone's flag list.
CREATE VIEW sample_elevation_pending AS
SELECT sample_id, latitude, longitude FROM sample_location
WHERE elevation_m IS NULL
UNION ALL
SELECT sample_id, latitude, longitude FROM sample_elevation_stale;
