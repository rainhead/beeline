-- Migration for schema/108_views_minting.sql, schema/120_views_qc_rules.sql
-- and schema/130_view_qc_finding.sql: one sample's QC findings without
-- computing every sample's, and the findings' text for every sample with
-- less work (beeline-poon).
--
-- No finding changes. On a copy of production's store of 2026-11-17, every
-- view below returns the same rows before and after: all 7,927 findings, the
-- 2,113 sample number conflicts, the 64,621 claims an observation makes on a
-- sample, and the coordinate limit of all 70,818 samples. The schema files
-- say why each is shaped as it is.
--
-- One thing does change for whoever writes the next rule: a finding about a
-- single specimen now carries its sample in sample_id as well as the specimen
-- in specimen_id, where before it left sample_id NULL and sample_qc_finding
-- looked the sample up. No rule is about a specimen yet, so no stored view
-- depends on the old arrangement.

CREATE OR REPLACE VIEW sample_claiming_observation AS
SELECT now_claims.sample_id, now_claims.inat_id
FROM (
  SELECT s.entity_id AS sample_id, c.inat_id
  FROM sample s
  JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
  JOIN inat_account a ON a.person_id = pc.person_id
  JOIN observation_sample_candidate c ON c.user_id = a.inat_user_id
                                     AND c.sample_number = s.sample_number
                                     AND c.observed_on = s.date_start
  WHERE s.date_end = s.date_start
  UNION ALL
  SELECT s.entity_id AS sample_id, c.inat_id
  FROM sample s
  JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
  JOIN inat_account a ON a.person_id = pc.person_id
  JOIN observation_sample_candidate c ON c.user_id = a.inat_user_id
                                     AND c.sample_number = s.sample_number
                                     AND c.observed_on BETWEEN s.date_start AND s.date_end
  WHERE s.date_end > s.date_start
) now_claims
WHERE NOT EXISTS (SELECT 1 FROM sample other
                  WHERE other.inat_observation_id = now_claims.inat_id
                    AND other.entity_id <> now_claims.sample_id)
UNION
SELECT sample_id, inat_observation_id FROM sample_legacy_observation;

CREATE OR REPLACE VIEW sample_several_observations AS
SELECT sample_id,
       CAST(count(*) AS INTEGER) AS observations,
       string_agg(CAST(inat_id AS TEXT), ', ' ORDER BY inat_id) AS inat_ids
FROM (SELECT sample_id, inat_id, count(*) OVER (PARTITION BY sample_id) AS claims
      FROM sample_claiming_observation) claim
WHERE claims > 1
GROUP BY sample_id;

CREATE OR REPLACE VIEW sample_coordinate_limit AS
SELECT s.entity_id AS sample_id,
       CASE WHEN s.date_end >= r.effective_from
              OR (p.sample_id IS NULL AND st.sample_id IS NULL)
            THEN r.uncertainty_m
            ELSE r.grandfathered_uncertainty_m END AS uncertainty_m
FROM sample s
CROSS JOIN coordinate_precision_rule r
LEFT JOIN printed_sample p ON p.sample_id = s.entity_id
LEFT JOIN settled_sample st ON st.sample_id = s.entity_id;

CREATE OR REPLACE VIEW sample_number_conflict AS
SELECT s.sample_id,
       concat('sample number ', s.sample_number, ' used ', count(*), ' times on ', s.date_start) AS details
FROM (SELECT s.entity_id AS sample_id, pc.person_id, s.date_start, s.sample_number
      FROM sample s
      JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id) s
JOIN (SELECT pc.person_id, s.date_start, s.sample_number
      FROM sample s
      JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id) same
  ON same.person_id = s.person_id
 AND same.date_start = s.date_start
 AND same.sample_number = s.sample_number
GROUP BY s.sample_id, s.sample_number, s.date_start
HAVING count(*) > 1
UNION ALL
SELECT s.entity_id,
       concat('sample number ', s.sample_number, ' is on ', o.observations, ' observations: ', o.inat_ids)
FROM sample s
JOIN sample_several_observations o ON o.sample_id = s.entity_id;

CREATE OR REPLACE VIEW qc_rule_sample_number AS
SELECT c.sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'duplicate_sample_number' AS rule_name,
       string_agg(c.details, '; ' ORDER BY c.details) AS details
FROM sample_number_conflict c
WHERE NOT EXISTS (SELECT 1 FROM specimen_on_paper p WHERE p.sample_id = c.sample_id)
GROUP BY c.sample_id;

CREATE OR REPLACE VIEW qc_rule_observation_missing_upstream AS
SELECT o.sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'observation_missing_upstream' AS rule_name,
       concat('observation ', o.inat_observation_id, ' not returned by a sync since ',
              CAST(CAST(o.last_seen_at AS DATE) AS VARCHAR)) AS details
FROM (
  SELECT s.entity_id AS sample_id, s.inat_observation_id, f.user_id, f.observed_on, seen_by.source,
         max(max(seen_by.started_at)) OVER (PARTITION BY s.entity_id) AS last_seen_at
  FROM sample s
  JOIN observation_field f ON f.inat_id = s.inat_observation_id
  JOIN observation_seen sn ON sn.inat_id = s.inat_observation_id
  JOIN sync_run seen_by ON seen_by.entity_id = sn.sync_run_id
  GROUP BY s.entity_id, s.inat_observation_id, f.user_id, f.observed_on, seen_by.source
) o
JOIN sync_run r
  ON r.source = o.source
 AND r.completed_at IS NOT NULL
 AND r.started_at > o.last_seen_at
 AND r.updated_since IS NULL
 AND (r.observer_user_id IS NULL OR r.observer_user_id = o.user_id)
 AND NOT coalesce(r.fetched_by_id, false)
 AND (r.window_start IS NULL OR o.observed_on >= r.window_start)
 AND (r.window_end IS NULL OR o.observed_on <= r.window_end)
GROUP BY o.sample_id, o.inat_observation_id, o.last_seen_at
UNION ALL
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'observation_missing_upstream' AS rule_name,
       concat('observation ', s.inat_observation_id, ' not found on iNaturalist since ',
              CAST(CAST(ab.absent_since AS DATE) AS VARCHAR)) AS details
FROM sample s
JOIN observation_absent ab ON ab.inat_id = s.inat_observation_id
WHERE NOT EXISTS (SELECT 1 FROM observation_field f WHERE f.inat_id = s.inat_observation_id);

CREATE OR REPLACE VIEW sample_qc_finding AS
SELECT f.sample_id,
       f.specimen_id,
       f.rule_name,
       f.details,
       f.detail_taxon_name,
       f.detail_taxon_rank
FROM qc_finding f
WHERE NOT EXISTS (
  SELECT 1 FROM sample_qc_waiver w
  WHERE w.sample_id = f.sample_id
    AND w.rule_name = f.rule_name
    AND w.in_force
    AND NOT EXISTS (SELECT 1 FROM qc_rule_unwaivable u WHERE u.name = w.rule_name));

COMMENT ON VIEW sample_claiming_observation IS 'Each iNaturalist observation that claims a sample: its collector''s observations carrying its number on its dates now, and those its legacy records came from (sample_legacy_observation). A cited observation since renumbered claims it no longer.';
COMMENT ON VIEW sample_several_observations IS 'A sample more than one observation claims: a collector error (Peter, 2026-10-04), and one of the two shapes of sample_number_conflict (schema/120).';
COMMENT ON VIEW sample_coordinate_limit IS 'Per sample: the coordinate uncertainty above which it cannot be printed. 100 m, except 250 m for a sample collected before 2 September 2026 that has printed or is in a settled season.';
COMMENT ON VIEW sample_number_conflict IS 'A sample whose number its collector used more than once that day: two samples sharing (collector, date, number), or several observations claiming one (beeline-0199). qc_rule_sample_number flags it where the sample is not yet printed; a printed one is named here and flagged nowhere.';
