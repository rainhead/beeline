-- Migration for schema/030_samples_specimens.sql and
-- schema/175_views_locality_override.sql (beeline-649): a locality staff
-- have set on a sample, which promotion never overwrites. The table is
-- empty on arrival; observation promotion fills it from
-- data/sample-overlay.csv, which nothing has written yet.
CREATE TABLE sample_locality_override (
  sample_id         INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  locality          TEXT NOT NULL CHECK (locality <> ''),
  observed_locality TEXT,
  set_by            INTEGER REFERENCES person(entity_id),
  reason            TEXT
);
COMMENT ON TABLE sample_locality_override IS 'A locality a staff member set on a sample, which promotion never overwrites: the follow rule (ingest/mint-samples.sql) skips samples with a row here. Re-derived at the end of observation promotion from data/sample-overlay.csv, the durable record; sample.locality is written beside it because every read uses that column, and sample_locality_override_stale asserts the two agree.';
COMMENT ON COLUMN sample_locality_override.observed_locality IS 'What observation_locality yielded when the override was written — the merge base. sample_locality_override_diverged names the overrides whose observation has since moved to a third value.';
COMMENT ON COLUMN sample_locality_override.set_by IS 'Whoever set it, resolved from the overlay row''s author login through inat_account at apply time; null where the login no longer resolves.';

CREATE VIEW sample_locality_override_stale AS
SELECT o.sample_id, o.locality AS override_locality, s.locality AS sample_locality
FROM sample_locality_override o
JOIN sample s ON s.entity_id = o.sample_id
WHERE s.locality IS DISTINCT FROM o.locality;
COMMENT ON VIEW sample_locality_override_stale IS 'Overrides the sample row disagrees with. Empty by construction; a row here means a writer bypassed src/apply-sample-overlay.ts.';

CREATE VIEW sample_locality_override_diverged AS
SELECT o.sample_id, o.locality AS override_locality, o.observed_locality, loc.locality AS observation_locality
FROM sample_locality_override o
JOIN sample s ON s.entity_id = o.sample_id
LEFT JOIN observation_locality loc ON loc.inat_id = s.inat_observation_id
WHERE loc.locality IS DISTINCT FROM o.observed_locality
  AND loc.locality IS DISTINCT FROM o.locality;
COMMENT ON VIEW sample_locality_override_diverged IS 'Overrides whose observation has since moved to a third value: the override stands, and /samples/:id shows staff what iNaturalist now says.';
