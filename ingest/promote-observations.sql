-- Promote current observation state onto linked samples: geoprivacy flags
-- and believed-true locations. A pure function of observation_field and the
-- existing model — idempotent, meant to re-run after every sync.
--
-- THIRD of three steps, and the order is the point (beeline-oyq).
-- ingest/harvest-inat-accounts.sql runs first, so that minting can resolve an
-- observer to a person; ingest/mint-samples.sql runs second and sets
-- inat_observation_id on the samples it creates and free-links; and this file
-- keys on that column, so a sample minted on this pass gets its coordinates
-- on this pass. src/promote-observations.ts runs all three in one
-- transaction.

-- ── Geoprivacy flags ─────────────────────────────────────────────────────
-- The observation is the source of truth for its own privacy state, in both
-- directions: newly obscured samples gain a flag, un-obscured ones lose it.
-- iNat sends taxon_geoprivacy as the explicit string 'open' (not only null);
-- the sample vocabulary is obscured/private/NULL.
UPDATE sample SET
  geoprivacy       = nullif(f.geoprivacy, 'open'),
  taxon_geoprivacy = nullif(f.taxon_geoprivacy, 'open')
FROM observation_field f
WHERE sample.inat_observation_id = f.inat_id;

-- ── Location candidates ──────────────────────────────────────────────────
-- Trust is evidenced by the PRESENCE of private coordinates in the
-- projection: viewer_trusted_by_observer signals only personal trust, and
-- project-level trust delivers private_geojson with that flag false. An
-- unobscured observation's public coordinates are true by definition.
-- Obscured without private coordinates yields no candidate — deliberately
-- shifted pairs never enter the sample layer, so existing believed-true
-- rows (legacy private-preferred ingestion) are left untouched.
CREATE OR REPLACE TEMP TABLE observation_location_candidate AS
-- The private pair is used only whole: a half-present pair (never seen from
-- the API, but ruinous if mixed) falls back to the public coordinates.
SELECT s.entity_id AS sample_id,
       CASE WHEN f.private_latitude IS NOT NULL AND f.private_longitude IS NOT NULL
            THEN 'inat_trusted' ELSE 'inat_public' END AS source,
       CASE WHEN f.private_latitude IS NOT NULL AND f.private_longitude IS NOT NULL
            THEN f.private_latitude ELSE f.latitude END   AS latitude,
       CASE WHEN f.private_latitude IS NOT NULL AND f.private_longitude IS NOT NULL
            THEN f.private_longitude ELSE f.longitude END AS longitude,
       f.positional_accuracy                              AS coordinate_uncertainty_m
FROM sample s
JOIN observation_field f ON f.inat_id = s.inat_observation_id
WHERE (f.private_latitude IS NOT NULL AND f.private_longitude IS NOT NULL)
   OR (f.latitude IS NOT NULL AND f.longitude IS NOT NULL
       AND nullif(f.geoprivacy, 'open') IS NULL
       AND nullif(f.taxon_geoprivacy, 'open') IS NULL);

-- Upgrade in place. positional_accuracy describes the true location even on
-- obscured records, so it accompanies both sources. Coordinates move here
-- and the elevation stays where it was — which is exactly what makes the row
-- stale, and the next statement is what notices.
UPDATE sample_location SET
  latitude = c.latitude,
  longitude = c.longitude,
  coordinate_uncertainty_m = c.coordinate_uncertainty_m,
  source = c.source
FROM observation_location_candidate c
WHERE sample_location.sample_id = c.sample_id;

-- Drop every elevation the move left behind, so the row says "unknown"
-- rather than something confident about a place it was not read at, and
-- awaits re-derivation (beeline-bqz). The predicate is sample_elevation_stale
-- itself (schema/170) — the tolerance is stated once, there, and this and the
-- derive job read the same definition of "moved enough to matter". A writer
-- that skips this statement is not silently wrong any more, only late: the
-- derive job's pending set is the same view (beeline-x5c).
UPDATE sample_location SET
  elevation_m = NULL, elevation_source_id = NULL,
  elevation_latitude = NULL, elevation_longitude = NULL
WHERE sample_id IN (SELECT sample_id FROM sample_elevation_stale);

INSERT INTO sample_location (sample_id, latitude, longitude,
                             coordinate_uncertainty_m, source)
SELECT c.sample_id, c.latitude, c.longitude, c.coordinate_uncertainty_m, c.source
FROM observation_location_candidate c
LEFT JOIN sample_location loc ON loc.sample_id = c.sample_id
WHERE loc.sample_id IS NULL;
