-- Migration for schema/101_view_printed_sample.sql and
-- schema/120_views_qc_rules.sql: the same two views, computed with less work.
--
-- Every listing page and record page reads the QC findings for the whole
-- store, and these two were a third of it on the sandbox: the rule asking
-- whether an observation has stopped coming back paired every observation
-- with every sync run before checking the run's window (91 ms, now 21), and
-- printed_sample, which the duplicate sample number rule reads, asked two
-- subqueries per specimen (33 ms, now 8). Neither answer changes: on a copy
-- of the sandbox's store, both versions of each return the same rows, and the
-- rule did so again with 400 observations' sightings removed to make it fire.

CREATE OR REPLACE VIEW printed_sample AS
SELECT DISTINCT sp.sample_id
FROM specimen sp
LEFT JOIN (
  SELECT pl.specimen_id, bool_or(r.printed_at IS NOT NULL) AS on_paper
  FROM printed_label pl
  JOIN print_run r ON r.entity_id = pl.print_run_id
  GROUP BY pl.specimen_id
) label ON label.specimen_id = sp.entity_id
WHERE label.specimen_id IS NULL OR label.on_paper;
COMMENT ON VIEW printed_sample IS 'Samples with at least one label on paper: printed by a Beeline print run, or imported (the legacy system printed every specimen it holds). These keep their date, locality and coordinates when iNaturalist changes them; a sample frozen into an unprinted run is not here, so a canceled run holds nothing back.';

CREATE OR REPLACE VIEW qc_rule_observation_missing_upstream AS
WITH seen AS (
  SELECT sn.inat_id, r.source, max(r.started_at) AS last_seen_at
  FROM observation_seen sn
  JOIN sync_run r ON r.entity_id = sn.sync_run_id
  GROUP BY sn.inat_id, r.source
), last_seen AS (
  SELECT inat_id, max(last_seen_at) AS last_seen_at FROM seen GROUP BY inat_id
), linked AS (
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
 AND r.updated_since IS NULL
 AND (r.observer_user_id IS NULL OR r.observer_user_id = l.user_id)
 AND (r.window_start IS NULL OR l.observed_on >= r.window_start)
 AND (r.window_end IS NULL OR l.observed_on <= r.window_end)
GROUP BY l.sample_id, l.inat_observation_id;
