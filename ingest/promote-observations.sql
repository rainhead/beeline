-- Promote current observation state onto linked samples (linked =
-- sample.inat_observation_id has a row in observation_current). Three
-- concerns: geoprivacy flags, believed-true locations, and observer →
-- collector iNat account linkage. The whole file is a pure function of
-- observation_current_fields and the existing model — idempotent, meant to
-- re-run after every sync.

-- ── Geoprivacy flags ─────────────────────────────────────────────────────
-- The observation is the source of truth for its own privacy state, in both
-- directions: newly obscured samples gain a flag, un-obscured ones lose it.
-- iNat sends taxon_geoprivacy as the explicit string 'open' (not only null);
-- the sample vocabulary is obscured/private/NULL.
UPDATE sample SET
  geoprivacy       = nullif(f.geoprivacy, 'open'),
  taxon_geoprivacy = nullif(f.taxon_geoprivacy, 'open')
FROM observation_current_fields f
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
JOIN observation_current_fields f ON f.inat_id = s.inat_observation_id
WHERE (f.private_latitude IS NOT NULL AND f.private_longitude IS NOT NULL)
   OR (f.latitude IS NOT NULL AND f.longitude IS NOT NULL
       AND nullif(f.geoprivacy, 'open') IS NULL
       AND nullif(f.taxon_geoprivacy, 'open') IS NULL);

-- Upgrade in place. positional_accuracy describes the true location even on
-- obscured records, so it accompanies both sources. An elevation survives
-- when the coordinates it was derived from agree with the new pair within
-- the reference system's export precision — legacy Mongo carries exactly 4
-- decimal places (measured: 383,004/383,032 rows; every linked sample sits
-- within half-ULP of the iNat coordinates), so "same place, rounded" is a
-- delta of at most 5e-5 degrees (~5.5 m, well under an SRTM cell).
-- Genuinely moved coordinates clear the elevation together with its source
-- (CHECK pairs them), awaiting re-derivation (beeline-bqz).
UPDATE sample_location SET
  elevation_m = CASE WHEN abs(sample_location.latitude - c.latitude) <= 5e-5
                      AND abs(sample_location.longitude - c.longitude) <= 5e-5
                     THEN sample_location.elevation_m END,
  elevation_source_id = CASE WHEN abs(sample_location.latitude - c.latitude) <= 5e-5
                              AND abs(sample_location.longitude - c.longitude) <= 5e-5
                             THEN sample_location.elevation_source_id END,
  latitude = c.latitude,
  longitude = c.longitude,
  coordinate_uncertainty_m = c.coordinate_uncertainty_m,
  source = c.source
FROM observation_location_candidate c
WHERE sample_location.sample_id = c.sample_id;

INSERT INTO sample_location (sample_id, latitude, longitude,
                             coordinate_uncertainty_m, source)
SELECT c.sample_id, c.latitude, c.longitude, c.coordinate_uncertainty_m, c.source
FROM observation_location_candidate c
LEFT JOIN sample_location loc ON loc.sample_id = c.sample_id
WHERE loc.sample_id IS NULL;

-- ── iNat accounts (beeline-gju rides along) ──────────────────────────────
-- The observer of a sample's evidencing observation is its collector.
-- Candidate pairs are written only when unambiguous both ways: one observer
-- account per collector across their linked samples, one collector per
-- account, and neither side already claimed. Conflicts stay for staff.
CREATE OR REPLACE TEMP TABLE observer_collector_pair AS
SELECT s.collector_id                    AS person_id,
       f.user_id,
       arg_max(f.user_login, f.inat_id)  AS login
FROM sample s
JOIN observation_current_fields f ON f.inat_id = s.inat_observation_id
WHERE f.user_id IS NOT NULL AND f.user_login IS NOT NULL
GROUP BY s.collector_id, f.user_id;

-- Logins change; user id is the stable key. Refresh the cache.
UPDATE inat_account SET login = p.login
FROM observer_collector_pair p
WHERE inat_account.inat_user_id = p.user_id
  AND inat_account.login <> p.login;

INSERT INTO inat_account (person_id, inat_user_id, login)
SELECT p.person_id, p.user_id, p.login
FROM observer_collector_pair p
WHERE (SELECT count(*) FROM observer_collector_pair q
       WHERE q.person_id = p.person_id) = 1
  AND (SELECT count(*) FROM observer_collector_pair q
       WHERE q.user_id = p.user_id) = 1
  AND NOT EXISTS (SELECT 1 FROM inat_account a WHERE a.person_id = p.person_id)
  AND NOT EXISTS (SELECT 1 FROM inat_account a WHERE a.inat_user_id = p.user_id);
