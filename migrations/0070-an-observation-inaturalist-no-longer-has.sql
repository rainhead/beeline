-- Migration for schema/060_sync.sql and schema/120_views_qc_rules.sql: an
-- observation iNaturalist no longer has is recorded and flagged (beeline-wcc6).
--
-- A sample can cite an observation no sync ever returned. On the sandbox 480
-- samples cite 474 such observations, deleted before the first sync, and the
-- nightly asks iNaturalist for them by id every night and gets nothing back.
-- That answer was thrown away, so their pages read as "not read yet" and
-- nothing flagged them. It is now kept in observation_absent, and
-- qc_rule_observation_missing_upstream gains a branch for samples whose
-- observation is there and was never read. The table starts empty: the next
-- nightly fills it.

CREATE TABLE observation_absent (
  inat_id      BIGINT PRIMARY KEY,
  absent_since TIMESTAMPTZ NOT NULL DEFAULT now(),
  asked_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE observation_absent IS 'Observation ids a by-id run asked iNaturalist for and did not get back: deleted upstream (or hidden from the token that asked) while a sample still cites them. Removed when a later by-id run returns the observation. A sample whose observation is here and not in observation_field is flagged observation_missing_upstream, and its page says the observation is no longer on iNaturalist.';
COMMENT ON COLUMN observation_absent.absent_since IS 'The first time iNaturalist answered without it. Stays put while it stays absent, because the flag quotes it and a waiver is tied to what the flag says (schema/050).';
COMMENT ON COLUMN observation_absent.asked_at IS 'The last time iNaturalist was asked and answered without it: how old the verdict is.';

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
       -- Says when the observation was last returned, which stays put until
       -- a sync returns it again and the flag clears: a waiver is tied to
       -- what the flag says (schema/050), and a count of the runs that
       -- missed it changed with every sync.
       concat('observation ', l.inat_observation_id, ' not returned by a sync since ',
              CAST(CAST(max(l.last_seen_at) AS DATE) AS VARCHAR)) AS details
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
GROUP BY l.sample_id, l.inat_observation_id
-- And the observation no sync ever returned, which iNaturalist answered
-- without when asked for it by id (schema/060 observation_absent,
-- beeline-wcc6): the legacy records cite hundreds deleted before the first
-- sync, and the branch above cannot see them, since it starts from a
-- projection they never had. The date is the first time iNaturalist said so,
-- which stays put for the waiver's sake as last_seen_at does above.
UNION ALL
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'observation_missing_upstream' AS rule_name,
       concat('observation ', s.inat_observation_id, ' not found on iNaturalist since ',
              CAST(CAST(ab.absent_since AS DATE) AS VARCHAR)) AS details
FROM sample s
JOIN observation_absent ab ON ab.inat_id = s.inat_observation_id
WHERE NOT EXISTS (SELECT 1 FROM observation_field f WHERE f.inat_id = s.inat_observation_id);
