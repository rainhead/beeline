-- Migration for schema/105_views_observation.sql: the geoprivacy flags on a
-- sample get the stale view every other stored copy has (beeline-ni5m.8).
--
-- sample.geoprivacy and sample.taxon_geoprivacy are rewritten from the
-- observation projection on every promotion and written by nothing else, so
-- on a linked sample they are a copy. The copies of an elevation, a minted
-- number, an override and an Ecdysis id each have a view naming a copy a
-- writer left behind; these did not, and they decide whether a location is
-- withheld. The promotion statement now reads this view as its predicate.
-- Nothing in the store changes: the view is empty wherever the last
-- promotion ran to the end.

CREATE VIEW sample_geoprivacy_stale AS
SELECT s.entity_id AS sample_id,
       s.geoprivacy, s.taxon_geoprivacy,
       nullif(f.geoprivacy, 'open')       AS observation_geoprivacy,
       nullif(f.taxon_geoprivacy, 'open') AS observation_taxon_geoprivacy
FROM sample s
JOIN observation_field f ON f.inat_id = s.inat_observation_id
WHERE s.geoprivacy       IS DISTINCT FROM nullif(f.geoprivacy, 'open')
   OR s.taxon_geoprivacy IS DISTINCT FROM nullif(f.taxon_geoprivacy, 'open');
COMMENT ON VIEW sample_geoprivacy_stale IS 'Linked samples whose geoprivacy or taxon_geoprivacy disagrees with their observation''s projection: the flags are a copy promotion rewrites, and this names a copy a writer left behind. Empty after every observation promotion; what that promotion''s flag statement updates.';
