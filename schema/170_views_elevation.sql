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

-- How vague a coordinate may be and still deserve an elevation. Stated once,
-- as a row, because ADR 0001 keeps schema SQL portable and a DuckDB macro is
-- not — and because a threshold repeated in two predicates is a threshold
-- that will one day be two thresholds.
--
-- 100 m (Peter, 2026-08-27). Below it the vertical error a horizontal slop
-- can hide is smaller than a label needs; well above it the DEM still returns
-- a confident integer that constrains nothing — the worst in the corpus is a
-- 2,979 km uncertainty carrying a 260 m elevation (beeline-6vc).
--
-- This used to be *tighter* than printing's 250 m, and the note here said so:
-- an elevation being a stricter claim than a locality string, a record could
-- be precise enough to print and too vague to be given a height. That gap has
-- closed from the other side. Printing now demands 100 m too (#22, and it was
-- always meant to), so for any sample whose date_end reaches that rule's
-- effective date the two coincide and no such record exists. It survives only among the
-- grandfathered ones, which keep 250 m for printing and are still refused an
-- elevation between 100 m and 250 m.
--
-- The numbers agreeing is a coincidence of two arguments reaching the same
-- place, not one threshold read twice: this one is about vertical relief, the
-- other about the resolution of a GPS reading. They are kept apart
-- deliberately, so that moving one does not silently move the other.
CREATE VIEW elevation_derivation_limit AS
SELECT 100 AS coordinate_uncertainty_m;

-- Elevations the coordinate beside them cannot support. Descriptive only:
-- nothing here removes them, because whether to is a decision with printable
-- labels behind it rather than a consequence of tightening derivation.
-- Measured on the dev store 2026-08-27: 1,558 rows, of which 744 sit under
-- the 250 m printing limit and so are on records that still print, and 1,546
-- came from iNaturalist rather than the legacy import — this is a live
-- upstream shape, not a historical mess (beeline-6vc).
CREATE VIEW sample_elevation_unsupportable AS
SELECT sample_id, coordinate_uncertainty_m, elevation_m, elevation_source_id
FROM sample_location
WHERE elevation_m IS NOT NULL
  AND coordinate_uncertainty_m > (SELECT coordinate_uncertainty_m FROM elevation_derivation_limit);

-- Everything the derive job should look at: never derived, or derived
-- somewhere else, minus the coordinates too vague to deserve one.
-- Deliberately not a QC rule — a missing or stale elevation
-- is derived from coordinates and is never the collector's gap to fill
-- (schema/120), so it belongs to the pipeline, not to anyone's flag list.
-- A coordinate too vague to deserve one is excluded rather than left to be
-- refused later: the job's gap count is then the work it can actually do, and
-- these rows do not read as a backlog that never clears.
CREATE VIEW sample_elevation_pending AS
SELECT sample_id, latitude, longitude FROM (
  SELECT sample_id, latitude, longitude, coordinate_uncertainty_m
  FROM sample_location WHERE elevation_m IS NULL
  UNION ALL
  SELECT s.sample_id, s.latitude, s.longitude, loc.coordinate_uncertainty_m
  FROM sample_elevation_stale s
  JOIN sample_location loc ON loc.sample_id = s.sample_id
) candidate
WHERE coordinate_uncertainty_m IS NULL
   OR coordinate_uncertainty_m <= (SELECT coordinate_uncertainty_m FROM elevation_derivation_limit);
