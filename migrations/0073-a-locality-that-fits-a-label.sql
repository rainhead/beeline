-- Migration for schema/174_views_locality_fallback.sql: where iNaturalist
-- gives no locality fit for a label, a sample that has not printed takes the
-- one Beeline names from its coordinates (beeline-pimo). The view, and then
-- the update promotion and naming localities make from now on, so the
-- samples held for it on the deployed store are ready at once rather than
-- after the next nightly. Boot's reconcile records the change in each
-- sample's history.

CREATE VIEW sample_locality_fallback AS
SELECT s.entity_id AS sample_id, s.locality AS observed_locality, sug.locality
FROM sample s
JOIN observation_field f ON f.inat_id = s.inat_observation_id
JOIN sample_locality_suggestion_current sug ON sug.sample_id = s.entity_id
WHERE NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)
  AND NOT EXISTS (SELECT 1 FROM sample_locality_override o WHERE o.sample_id = s.entity_id)
  AND (s.locality IS NULL OR trim(s.locality) = ''
       OR s.entity_id IN (SELECT sample_id FROM qc_rule_locality_format));
COMMENT ON VIEW sample_locality_fallback IS 'Unprinted iNat-linked samples, with no locality a person set, whose locality is missing or unfit for a label, beside the name Beeline gives their coordinates, which they take (beeline-pimo). Applied by observation promotion and by naming localities, so empty after either.';

COMMENT ON VIEW observation_locality IS 'The locality a sample minted from an observation carries: the first comma-separated component of its (private-preferred) place_guess that reads like a place name, however long. A component too long for a label is taken as written; an observation with no usable component is absent here. Either way the unprinted sample takes the locality Beeline names from its coordinates instead (sample_locality_fallback, beeline-pimo), and a fix upstream on iNaturalist that yields a name fit for a label wins on the next promotion, since an unprinted sample follows its observation (beeline-kza).';

UPDATE sample SET locality = fb.locality
FROM sample_locality_fallback fb
WHERE sample.entity_id = fb.sample_id;
