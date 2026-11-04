-- Where iNaturalist gives no locality fit for a label, Beeline's does
-- (Peter, 2026-11-04, beeline-pimo).
--
-- An unprinted sample's locality follows its observation (ingest/mint-samples.sql):
-- the first usable part of place_guess. Where there is none ("Wheeler County,
-- US-OR, US") or it is too long for a label ("Commerce Station Inbound"), the
-- sample used to be held from printing until the volunteer changed
-- iNaturalist or adopted a name by hand, and on the production store at the
-- first print run that held 44 samples of the active season. It now takes
-- the name Beeline gives its coordinates (schema/172). The volunteer keeps
-- both ways to change it: a place_guess that yields a name fit for a label
-- wins on the next promotion, and adopting another candidate writes the
-- sample overlay, which stands over both.
--
-- "Fit for a label" is qc_rule_locality_format's verdict, read by name, so
-- the two cannot disagree; every candidate passes it (src/locality-rule.ts,
-- fits()). Printed samples are left alone, since their locality is what the
-- labels say, and so is one a person set (sample_locality_override). Only
-- iNat-linked samples: anything else has no observation to follow, and its
-- locality is whatever a person typed. Every season, not only the active
-- ones: a sample that never printed would otherwise flip back to the unfit
-- name on the night its season settles.
--
-- Empty after every promotion and every naming of localities, both of
-- which apply it; a row here between them is a sample minted tonight that
-- has just been named.
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
