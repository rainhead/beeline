-- What a staff-set locality means, stated once (beeline-649).

-- The alarm: an override whose sample does not read it. The applier writes
-- both, and the follow rule skips overridden samples, so this is empty by
-- construction — the same shape as sample_elevation_stale and
-- specimen_field_number_stale, and asserted empty by test for the same
-- reason: an unrefreshed table is not a visibly broken one.
CREATE VIEW sample_locality_override_stale AS
SELECT o.sample_id, o.locality AS override_locality, s.locality AS sample_locality
FROM sample_locality_override o
JOIN sample s ON s.entity_id = o.sample_id
WHERE s.locality IS DISTINCT FROM o.locality;
COMMENT ON VIEW sample_locality_override_stale IS 'Overrides the sample row disagrees with. Empty by construction; a row here means a writer bypassed src/apply-sample-overlay.ts.';

-- The three-way merge's third case (ADR 0004): the observation now yields a
-- locality that is neither what the staffer saw nor what they wrote. The
-- override stands — a deliberate assertion beats an unreviewed upstream edit
-- — and this names the disagreement for the sample page, where staff decide
-- whether the new upstream value changes their mind. An observation that has
-- converged on the override is not here: nothing is in dispute.
CREATE VIEW sample_locality_override_diverged AS
SELECT o.sample_id, o.locality AS override_locality, o.observed_locality, loc.locality AS observation_locality
FROM sample_locality_override o
JOIN sample s ON s.entity_id = o.sample_id
LEFT JOIN observation_locality loc ON loc.inat_id = s.inat_observation_id
WHERE loc.locality IS DISTINCT FROM o.observed_locality
  AND loc.locality IS DISTINCT FROM o.locality;
COMMENT ON VIEW sample_locality_override_diverged IS 'Overrides whose observation has since moved to a third value: the override stands, and /samples/:id shows staff what iNaturalist now says.';
