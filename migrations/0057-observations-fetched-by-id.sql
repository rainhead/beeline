-- Migration for beeline-7vsw: a sync run can ask for particular observations
-- by id — the ones samples cite that no sync has read — rather than for a
-- project. The run says so (schema/060), and deletion detection never counts
-- it as covering an observation it did not ask for (schema/120). The view is
-- copied whole.
ALTER TABLE sync_run ADD COLUMN fetched_by_id BOOLEAN DEFAULT false;
COMMENT ON COLUMN sync_run.fetched_by_id IS 'True on a run that asked for particular observations by id rather than for a project: the observations samples cite that no sync had read (beeline-7vsw), source ''observation-ids''. It proves nothing about any observation it did not ask for, so deletion detection never counts it as a covering run; it names no project, so no project''s watermark reads it.';

CREATE OR REPLACE VIEW qc_rule_observation_missing_upstream AS
WITH seen AS (
  -- When each observation was last returned, by each source that returned it.
  SELECT sn.inat_id, r.source, max(r.started_at) AS last_seen_at
  FROM observation_seen sn
  JOIN sync_run r ON r.entity_id = sn.sync_run_id
  GROUP BY sn.inat_id, r.source
), last_seen AS (
  SELECT inat_id, max(last_seen_at) AS last_seen_at FROM seen GROUP BY inat_id
), linked AS (
  -- A sample's observation, once per source that has returned it, with the
  -- last time any source did.
  SELECT s.entity_id AS sample_id, s.inat_observation_id, f.user_id, f.observed_on,
         ss.source, ls.last_seen_at
  FROM sample s
  JOIN observation_field f ON f.inat_id = s.inat_observation_id
  JOIN last_seen ls ON ls.inat_id = f.inat_id
  JOIN seen ss ON ss.inat_id = f.inat_id
)
SELECT l.sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'observation_missing_upstream' AS rule_name,
       concat('observation ', l.inat_observation_id, ' missing from ',
              count(*), ' completed covering run(s), latest started ',
              max(r.started_at)) AS details
FROM linked l
JOIN sync_run r
  ON r.source = l.source
 AND r.completed_at IS NOT NULL
 AND r.started_at > l.last_seen_at
 -- Incremental (updated_since) runs fetch only the changed subset: they can
 -- never prove an observation gone, so they are not covering runs.
 AND r.updated_since IS NULL
 -- A run that asked for one observer's observations (the dashboard's
 -- "Check iNaturalist now", beeline-yso) proves absence for that observer
 -- only: it covers everyone else's observations no more than an
 -- incremental run does.
 AND (r.observer_user_id IS NULL OR r.observer_user_id = l.user_id)
 -- A run that asked for particular observations by id (beeline-7vsw) is
 -- silent about every observation it did not ask for.
 AND NOT coalesce(r.fetched_by_id, false)
 AND (r.window_start IS NULL OR l.observed_on >= r.window_start)
 AND (r.window_end IS NULL OR l.observed_on <= r.window_end)
GROUP BY l.sample_id, l.inat_observation_id;
