-- Migration for schema/030, schema/050, schema/108, schema/119, schema/120 and
-- schema/130 (beeline-0199): several iNaturalist observations claiming one
-- sample number is a collector error (Peter, 2026-10-04), and
-- duplicate_sample_number, which counted samples, never saw it, because
-- legacy promotion and minting both merge on the key it groups by.
--
-- A new table (filled by the next legacy promotion, so empty on a deployed
-- store until it is reseeded: the iNaturalist side works at once), two new
-- views, a new rule for printed samples, and the duplicate rule gaining an
-- arm. printed_sample moved from schema/155 to schema/119 only so the rules
-- can read it; its definition is unchanged and it is already in the store.

CREATE TABLE sample_legacy_observation (
  sample_id           INTEGER NOT NULL REFERENCES sample(entity_id),
  inat_observation_id BIGINT NOT NULL,
  PRIMARY KEY (sample_id, inat_observation_id)
);
COMMENT ON TABLE sample_legacy_observation IS 'The iNaturalist observations an imported sample''s legacy records named in their URLs, written by legacy promotion because staging is the only place that can see them. More than one row for a sample is a collector error the reference system merged and printed (beeline-0199).';

UPDATE qc_rule
   SET instructions = 'Each sample is one iNaturalist observation with its own number, and this number is on more than one of your observations or samples that day — the flag lists them. Renumber all but one on iNaturalist so each sample that day is distinct.'
 WHERE name = 'duplicate_sample_number';
INSERT INTO qc_rule (name, severity, instructions) VALUES
  ('shared_sample_number_printed', 'warning',
   'More than one iNaturalist observation carries this sample''s number on the same day, and its labels are already printed, each with its own observation''s place. Nothing to change on iNaturalist: the labels are right, and staff will split this sample.');

COMMENT ON VIEW sample_multi_observation IS 'A sample more than one observation claims, which is a collector error (beeline-0199). It cites one; a scalar link cannot say more. This is what explains a count_mismatch finding on a sample whose count is the total over all of them.';

CREATE VIEW sample_claiming_observation AS
SELECT s.entity_id AS sample_id, s.inat_observation_id AS inat_id
FROM sample s
WHERE s.inat_observation_id IS NOT NULL
UNION
SELECT s.entity_id, c.inat_id
FROM sample s
JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
JOIN inat_account a ON a.person_id = pc.person_id
JOIN observation_sample_candidate c ON c.user_id = a.inat_user_id
                                   AND c.sample_number = s.sample_number
                                   AND c.observed_on BETWEEN s.date_start AND s.date_end
UNION
SELECT sample_id, inat_observation_id FROM sample_legacy_observation;
COMMENT ON VIEW sample_claiming_observation IS 'Each iNaturalist observation that claims a sample: the one it cites, its collector''s others carrying its number on its dates, and those its legacy records came from (sample_legacy_observation).';

CREATE VIEW sample_several_observations AS
SELECT sample_id,
       CAST(count(*) AS INTEGER) AS observations,
       string_agg(CAST(inat_id AS TEXT), ', ' ORDER BY inat_id) AS inat_ids
FROM sample_claiming_observation
GROUP BY sample_id
HAVING count(*) > 1;
COMMENT ON VIEW sample_several_observations IS 'A sample more than one observation claims: a collector error (Peter, 2026-10-04). duplicate_sample_number reads it for a sample not yet printed, shared_sample_number_printed for one that is.';

CREATE OR REPLACE VIEW qc_rule_duplicate_sample_number AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'duplicate_sample_number' AS rule_name,
       concat('sample number ', s.sample_number, ' used ', dup.n, ' times on ', s.date_start) AS details
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
SELECT s.entity_id, CAST(NULL AS INTEGER), 'duplicate_sample_number',
       concat('sample number ', s.sample_number, ' is on ', o.observations,
              ' observations: ', o.inat_ids)
FROM sample s
JOIN sample_several_observations o ON o.sample_id = s.entity_id
WHERE NOT EXISTS (SELECT 1 FROM printed_sample p WHERE p.sample_id = s.entity_id);

CREATE VIEW qc_rule_shared_sample_number_printed AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'shared_sample_number_printed' AS rule_name,
       concat('sample number ', s.sample_number, ' is on ', o.observations,
              ' observations: ', o.inat_ids) AS details
FROM sample s
JOIN sample_several_observations o ON o.sample_id = s.entity_id
WHERE EXISTS (SELECT 1 FROM printed_sample p WHERE p.sample_id = s.entity_id);

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
  UNION ALL SELECT * FROM qc_rule_duplicate_sample_number
  UNION ALL SELECT * FROM qc_rule_shared_sample_number_printed
  UNION ALL SELECT * FROM qc_rule_count_mismatch
  UNION ALL SELECT * FROM qc_rule_count_below_printed
  UNION ALL SELECT * FROM qc_rule_observation_missing_upstream
  -- Stored ingestion-time findings join the derived ones (schema/050).
  UNION ALL SELECT sample_id, CAST(NULL AS INTEGER) AS specimen_id, rule_name, details
  FROM sample_promotion_finding
) prose
UNION ALL SELECT * FROM qc_rule_non_tracheophyte_host;
