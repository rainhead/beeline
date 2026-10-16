-- Migration for beeline-yso: a sync run can ask for one observer's
-- observations, as the dashboard's "Check iNaturalist now" does. The run says
-- whose (schema/060), and deletion detection counts it as covering that
-- observer's observations only (schema/120). The view is copied whole.
ALTER TABLE sync_run ADD COLUMN observer_user_id BIGINT;
COMMENT ON COLUMN sync_run.observer_user_id IS 'Set on a run that asked for one iNaturalist user''s observations, as the dashboard''s "Check iNaturalist now" does (beeline-yso). Such a run covers that observer and nobody else: deletion detection counts it only for their observations, and it never sets the nightly''s incremental watermark.';

CREATE OR REPLACE VIEW qc_rule_observation_missing_upstream AS
WITH last_seen AS (
  SELECT sn.inat_id, max(r.started_at) AS last_seen_at
  FROM observation_seen sn
  JOIN sync_run r ON r.entity_id = sn.sync_run_id
  GROUP BY sn.inat_id
), seen_source AS (
  SELECT DISTINCT sn.inat_id, r.source
  FROM observation_seen sn
  JOIN sync_run r ON r.entity_id = sn.sync_run_id
)
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'observation_missing_upstream' AS rule_name,
       concat('observation ', s.inat_observation_id, ' missing from ',
              count(*), ' completed covering run(s), latest started ',
              max(r.started_at)) AS details
FROM sample s
JOIN observation_field f ON f.inat_id = s.inat_observation_id
JOIN last_seen ls ON ls.inat_id = f.inat_id
JOIN seen_source ss ON ss.inat_id = f.inat_id
JOIN sync_run r
  ON r.source = ss.source
 AND r.completed_at IS NOT NULL
 AND r.started_at > ls.last_seen_at
 -- Incremental (updated_since) runs fetch only the changed subset: they can
 -- never prove an observation gone, so they are not covering runs.
 AND r.updated_since IS NULL
 -- A run that asked for one observer's observations (the dashboard's
 -- "Check iNaturalist now", beeline-yso) proves absence for that observer
 -- only: it covers everyone else's observations no more than an
 -- incremental run does.
 AND (r.observer_user_id IS NULL OR r.observer_user_id = f.user_id)
 AND (r.window_start IS NULL OR f.observed_on >= r.window_start)
 AND (r.window_end IS NULL OR f.observed_on <= r.window_end)
GROUP BY s.entity_id, s.inat_observation_id;
