-- Migration for schema/170_views_elevation.sql: an elevation with no
-- coordinates behind it is stale.
--
-- 0012 added elevation_latitude/elevation_longitude and could not add the
-- CHECK that pairs them with elevation_m, because DuckDB has no ALTER TABLE
-- ADD CONSTRAINT (ADR 0006). It said the views were what keeps a deployed
-- store honest instead. They were not, quite: `abs(NULL - latitude) > 5e-5`
-- is NULL, so a row with an elevation and no point was neither stale nor
-- pending — invisible to both views, on exactly the stores that lack the
-- CHECK. The safety net had a hole where it was load-bearing.
--
-- Replacing the view rather than editing 0012, which may already have been
-- applied. `db:migrate --check` compares tables and columns, never view
-- bodies, so an edited 0012 would also have gone unreported.
DROP VIEW sample_elevation_pending;
DROP VIEW sample_elevation_stale;

CREATE VIEW sample_elevation_stale AS
SELECT sample_id, latitude, longitude, elevation_m,
       elevation_latitude, elevation_longitude
FROM sample_location
WHERE elevation_m IS NOT NULL
  AND (elevation_latitude IS NULL
    OR elevation_longitude IS NULL
    OR abs(elevation_latitude - latitude) > 5e-5
    OR abs(elevation_longitude - longitude) > 5e-5);

CREATE VIEW sample_elevation_pending AS
SELECT sample_id, latitude, longitude FROM sample_location
WHERE elevation_m IS NULL
UNION ALL
SELECT sample_id, latitude, longitude FROM sample_elevation_stale;
