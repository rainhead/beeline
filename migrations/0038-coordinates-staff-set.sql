-- Migration for schema/030_samples_specimens.sql, schema/105_views_observation.sql
-- and schema/175_views_locality_override.sql (beeline-942): coordinates
-- staff have set on a sample, which promotion never overwrites, and the
-- observation's believed-true point as a view promotion and the page share.
-- The table is empty on arrival; observation promotion fills it from
-- data/sample-overlay.csv.
CREATE VIEW observation_location AS
SELECT f.inat_id,
       CASE WHEN f.private_latitude IS NOT NULL AND f.private_longitude IS NOT NULL
            THEN 'inat_trusted' ELSE 'inat_public' END AS source,
       CASE WHEN f.private_latitude IS NOT NULL AND f.private_longitude IS NOT NULL
            THEN f.private_latitude ELSE f.latitude END   AS latitude,
       CASE WHEN f.private_latitude IS NOT NULL AND f.private_longitude IS NOT NULL
            THEN f.private_longitude ELSE f.longitude END AS longitude,
       f.positional_accuracy                              AS coordinate_uncertainty_m
FROM observation_field f
WHERE (f.private_latitude IS NOT NULL AND f.private_longitude IS NOT NULL)
   OR (f.latitude IS NOT NULL AND f.longitude IS NOT NULL
       AND nullif(f.geoprivacy, 'open') IS NULL
       AND nullif(f.taxon_geoprivacy, 'open') IS NULL);
COMMENT ON VIEW observation_location IS 'Per observation with believed-true coordinates: the private pair where trust delivers one, else the public pair of an unobscured observation, with its source and uncertainty. Promotion writes it onto linked samples; nothing is here for an obscured observation without trust.';

CREATE TABLE sample_location_override (
  sample_id                INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  latitude                 DOUBLE NOT NULL,
  longitude                DOUBLE NOT NULL,
  coordinate_uncertainty_m INTEGER,
  observed_latitude        DOUBLE,
  observed_longitude       DOUBLE,
  observed_uncertainty_m   INTEGER,
  observed_source          TEXT,
  set_by                   INTEGER REFERENCES person(entity_id),
  reason                   TEXT,
  CHECK (latitude BETWEEN -90 AND 90),
  CHECK (longitude BETWEEN -180 AND 180),
  CHECK (coordinate_uncertainty_m IS NULL OR coordinate_uncertainty_m > 0),
  CHECK ((observed_latitude IS NULL) = (observed_longitude IS NULL)),
  CHECK ((observed_latitude IS NULL) = (observed_source IS NULL))
);
COMMENT ON TABLE sample_location_override IS 'Coordinates a staff member set on a sample, which promotion never overwrites: the location upgrade (ingest/promote-observations.sql) skips samples with a row here. Re-derived at the end of observation promotion from data/sample-overlay.csv; sample_location carries the same point with source staff_entry, and sample_location_override_stale asserts the two agree.';
COMMENT ON COLUMN sample_location_override.observed_latitude IS 'With observed_longitude, observed_uncertainty_m and observed_source: the sample_location row as it stood when the override was written — the merge base, and what removal restores. All null where the sample had no coordinates then.';

CREATE VIEW sample_location_override_stale AS
SELECT o.sample_id, o.latitude AS override_latitude, o.longitude AS override_longitude,
       loc.latitude AS sample_latitude, loc.longitude AS sample_longitude, loc.source
FROM sample_location_override o
LEFT JOIN sample_location loc ON loc.sample_id = o.sample_id
WHERE loc.sample_id IS NULL
   OR loc.source <> 'staff_entry'
   OR abs(loc.latitude - o.latitude) > 5e-5
   OR abs(loc.longitude - o.longitude) > 5e-5;
COMMENT ON VIEW sample_location_override_stale IS 'Coordinate overrides the sample_location row disagrees with. Empty by construction; a row here means a writer bypassed src/apply-sample-overlay.ts.';

-- Diverged: the observation now yields a point that is neither what the
-- staffer saw nor what they wrote. The override stands; the sample page says
-- what iNaturalist now says. An observation with no believed-true point is
-- not a third value, and one that has converged on the override is not in
-- dispute.
CREATE VIEW sample_location_override_diverged AS
SELECT o.sample_id, o.latitude AS override_latitude, o.longitude AS override_longitude,
       o.observed_latitude, o.observed_longitude,
       ol.latitude AS observation_latitude, ol.longitude AS observation_longitude,
       ol.coordinate_uncertainty_m AS observation_uncertainty_m
FROM sample_location_override o
JOIN sample s ON s.entity_id = o.sample_id
JOIN observation_location ol ON ol.inat_id = s.inat_observation_id
WHERE (abs(ol.latitude - o.latitude) > 5e-5 OR abs(ol.longitude - o.longitude) > 5e-5)
  AND (o.observed_latitude IS NULL
       OR abs(ol.latitude - o.observed_latitude) > 5e-5
       OR abs(ol.longitude - o.observed_longitude) > 5e-5);
COMMENT ON VIEW sample_location_override_diverged IS 'Coordinate overrides whose observation has since moved to a third point: the override stands, and /samples/:id shows staff where iNaturalist now puts it.';
