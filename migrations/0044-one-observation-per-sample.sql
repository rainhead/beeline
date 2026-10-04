-- Migration for schema/030, schema/050, schema/108, schema/119, schema/120 and
-- schema/130 (beeline-0199): several iNaturalist observations claiming one
-- sample number is a collector error (Peter, 2026-10-04), and
-- duplicate_sample_number, which counted samples, never saw it, because
-- legacy promotion and minting both merge on the key it grouped by.
--
-- A new table, filled here from the legacy staging a deployed store holds
-- (legacy_specimen_number, which legacy promotion builds, and
-- legacy_occurrence) as promotion fills it on a fresh build; a store with no
-- legacy promotion behind it cannot run this and should be rebuilt, which the
-- one deployed store — the sandbox — is not. Three new views; the two
-- sample-number rules become one view, qc_rule_sample_number, which emits
-- either name; and a new rule row for printed samples. printed_sample moved
-- from schema/155 to schema/119 only so the rules can read it; its definition
-- is unchanged and it is already in the store.
CREATE TABLE sample_legacy_observation (
  sample_id           INTEGER NOT NULL REFERENCES sample(entity_id),
  inat_observation_id BIGINT NOT NULL,
  PRIMARY KEY (sample_id, inat_observation_id)
);
COMMENT ON TABLE sample_legacy_observation IS 'The iNaturalist observations an imported sample''s legacy records named in their URLs, written by legacy promotion because staging is the only place that can see them. More than one row for a sample is a collector error the reference system merged and printed (beeline-0199).';

INSERT INTO sample_legacy_observation (sample_id, inat_observation_id)
SELECT DISTINCT n.sample_id, CAST(regexp_extract(lo.url, '([0-9]+)$', 1) AS BIGINT)
FROM legacy_specimen_number n
JOIN legacy_occurrence lo ON lo._id = n._id
WHERE regexp_matches(lo.url, '/observations/[0-9]+$');

UPDATE qc_rule
   SET instructions = 'Each sample has its own number, and this one is on more than one of your observations or samples that day — the flag lists them. Renumber all but one on iNaturalist so each sample that day is distinct, and where the flag names one to keep, keep that one.'
 WHERE name = 'duplicate_sample_number';
INSERT INTO qc_rule (name, severity, instructions) VALUES
  ('shared_sample_number_printed', 'warning',
   'This sample''s number is on more than one observation or sample from the same day, and its labels are already printed. Nothing to change on iNaturalist: the labels are right as printed, and staff will correct the record.');

COMMENT ON VIEW sample_multi_observation IS 'A sample more than one observation claims, which is a collector error (beeline-0199). It cites one; a scalar link cannot say more. This is what explains a count_mismatch finding on a sample whose count is the total over all of them.';

CREATE VIEW sample_claiming_observation AS
SELECT s.entity_id AS sample_id, c.inat_id
FROM sample s
JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
JOIN inat_account a ON a.person_id = pc.person_id
JOIN observation_sample_candidate c ON c.user_id = a.inat_user_id
                                   AND c.sample_number = s.sample_number
                                   AND c.observed_on BETWEEN s.date_start AND s.date_end
WHERE NOT EXISTS (SELECT 1 FROM sample other
                  WHERE other.inat_observation_id = c.inat_id AND other.entity_id <> s.entity_id)
UNION
SELECT sample_id, inat_observation_id FROM sample_legacy_observation;
COMMENT ON VIEW sample_claiming_observation IS 'Each iNaturalist observation that claims a sample: its collector''s observations carrying its number on its dates now, and those its legacy records came from (sample_legacy_observation). A cited observation since renumbered claims it no longer.';

CREATE VIEW sample_several_observations AS
SELECT co.sample_id,
       CAST(count(*) AS INTEGER) AS observations,
       string_agg(CAST(co.inat_id AS TEXT), ', ' ORDER BY co.inat_id) AS inat_ids,
       max(CASE WHEN co.inat_id = s.inat_observation_id THEN co.inat_id END) AS cited_inat_id
FROM sample_claiming_observation co
JOIN sample s ON s.entity_id = co.sample_id
GROUP BY co.sample_id
HAVING count(*) > 1;
COMMENT ON VIEW sample_several_observations IS 'A sample more than one observation claims: a collector error (Peter, 2026-10-04), and one of the two shapes of sample_number_conflict (schema/120).';

CREATE VIEW sample_number_conflict AS
SELECT s.entity_id AS sample_id,
       concat('sample number ', s.sample_number, ' used ', dup.n, ' times on ', s.date_start) AS details,
       CAST(NULL AS BIGINT) AS keep_inat_id
FROM sample s
JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
JOIN (
  SELECT pc.person_id, s.date_start, s.sample_number, count(*) AS n
  FROM sample s
  JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
  GROUP BY pc.person_id, s.date_start, s.sample_number
  HAVING count(*) > 1
) dup ON dup.person_id = pc.person_id
     AND dup.date_start = s.date_start
     AND dup.sample_number = s.sample_number
UNION ALL
SELECT s.entity_id,
       concat('sample number ', s.sample_number, ' is on ', o.observations, ' observations: ', o.inat_ids),
       o.cited_inat_id
FROM sample s
JOIN sample_several_observations o ON o.sample_id = s.entity_id;
COMMENT ON VIEW sample_number_conflict IS 'A sample whose number its collector used more than once that day: two samples sharing (collector, date, number), or several observations claiming one (beeline-0199). keep_inat_id is the claiming observation the sample cites, the one to keep. qc_rule_sample_number reads it.';

CREATE VIEW qc_rule_sample_number AS
SELECT c.sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       CASE WHEN p.sample_id IS NULL THEN 'duplicate_sample_number' ELSE 'shared_sample_number_printed' END AS rule_name,
       CASE WHEN p.sample_id IS NULL AND c.keep_inat_id IS NOT NULL
            THEN concat(c.details, '; keep ', c.keep_inat_id, ', the one this sample cites')
            ELSE c.details END AS details
FROM sample_number_conflict c
LEFT JOIN printed_sample p ON p.sample_id = c.sample_id;

CREATE OR REPLACE VIEW qc_finding AS
SELECT sample_id, specimen_id, rule_name, details,
       CAST(NULL AS TEXT) AS detail_taxon_name,
       CAST(NULL AS TEXT) AS detail_taxon_rank
FROM (
  SELECT * FROM qc_rule_missing_required_field
  UNION ALL SELECT * FROM qc_rule_missing_recommended_field
  UNION ALL SELECT * FROM qc_rule_obscured_no_true_coordinates
  UNION ALL SELECT * FROM qc_rule_locality_format
  UNION ALL SELECT * FROM qc_rule_place_unabbreviated
  UNION ALL SELECT * FROM qc_rule_place_unrecognised
  UNION ALL SELECT * FROM qc_rule_coordinate_uncertainty
  UNION ALL SELECT * FROM qc_rule_coordinate_out_of_region
  UNION ALL SELECT * FROM qc_rule_sample_number
  UNION ALL SELECT * FROM qc_rule_count_mismatch
  UNION ALL SELECT * FROM qc_rule_count_below_printed
  UNION ALL SELECT * FROM qc_rule_observation_missing_upstream
  -- Stored ingestion-time findings join the derived ones (schema/050).
  UNION ALL SELECT sample_id, CAST(NULL AS INTEGER) AS specimen_id, rule_name, details
  FROM sample_promotion_finding
) prose
UNION ALL SELECT * FROM qc_rule_non_tracheophyte_host;

DROP VIEW qc_rule_duplicate_sample_number;
