-- Migration for schema/050, schema/108 and schema/120 (beeline-0199): one
-- observation is one sample (Peter, 2026-10-04). Minting makes one sample per
-- observation and mints beside an unprinted sample citing another, never
-- beside a printed one or one citing nothing; a printed sample whose number
-- its collector used twice is no longer flagged, so the
-- shared_sample_number_printed rule goes and duplicate_sample_number's words
-- change. printed_sample moved to schema/101 unchanged and is already here.
--
-- Not here, because a migration cannot do it: legacy promotion now splits a
-- merged legacy sample by observation, and that reaches a deployed store
-- only through `pnpm db:reseed`. An unprinted sample's number following its
-- observation is in ingest/mint-samples.sql, which the next promotion runs.

-- One repair minting under the old rule leaves behind. It made one sample
-- of several observations sharing a number, citing one and counting all of
-- them; the next promotion now mints each of the others as its own sample,
-- so left alone those specimens would be counted twice — and an unprinted
-- sample's count is how many labels print (on the sandbox, 2026-10-04: 15
-- samples, 141 specimens). So each such sample, not yet printed, takes its
-- own observation's count. A printed one keeps what its labels say, and so
-- does any imported one: its count is its legacy records, not a sum minting
-- made (every imported sample is printed anyway; this says so rather than
-- relying on it — CodeRabbit on #133).
-- sample_multi_observation is still the old shape when this runs: a sample
-- whose collector's other observations carry its number on its dates.
UPDATE sample SET specimen_count = c.specimen_count
FROM sample_multi_observation smo
JOIN observation_sample_candidate c ON c.inat_id = smo.cited_inat_id
WHERE sample.entity_id = smo.sample_id
  AND sample.specimen_count > c.specimen_count
  AND NOT EXISTS (SELECT 1 FROM printed_sample p WHERE p.sample_id = sample.entity_id)
  AND NOT EXISTS (SELECT 1 FROM sample_legacy_observation lo WHERE lo.sample_id = sample.entity_id);

UPDATE qc_rule
   SET instructions = 'Each sample has its own number, and this one is on more than one of your samples that day. Renumber all but one of their observations on iNaturalist; until their labels print, the samples follow.'
 WHERE name = 'duplicate_sample_number';
DELETE FROM qc_rule WHERE name = 'shared_sample_number_printed';

CREATE OR REPLACE VIEW sample_mint_group AS
SELECT a.person_id,
       c.sample_number,
       c.observed_on,
       CAST(1 AS INTEGER)               AS observations,
       c.inat_id                        AS lead_inat_id,
       c.specimen_count
FROM observation_sample_candidate c
JOIN inat_account a ON a.inat_user_id = c.user_id
WHERE NOT EXISTS (SELECT 1 FROM sample s WHERE s.inat_observation_id = c.inat_id)
  AND NOT EXISTS (SELECT 1 FROM sample_legacy_observation lo WHERE lo.inat_observation_id = c.inat_id);
COMMENT ON VIEW sample_mint_group IS 'Unlinked collection records, one per observation, each the sample it will become: one observation is one sample (beeline-0199). lead_inat_id is the observation; an observation an imported sample''s legacy records came from is excluded, since those specimens are on pins already.';

CREATE OR REPLACE VIEW sample_mint_ambiguous AS
SELECT person_id, sample_number, observed_on, lead_inat_id,
       CAST(count(*) AS INTEGER) AS samples,
       array_to_string(list_sort(list(sample_id)), ' | ') AS sample_ids
FROM sample_mint_match
WHERE inat_observation_id IS NULL
GROUP BY person_id, sample_number, observed_on, lead_inat_id
HAVING count(*) > 1;
COMMENT ON VIEW sample_mint_ambiguous IS 'An unlinked observation matching two or more existing samples that cite none: neither linked nor minted, since picking one silently would be worse than saying so. Samples already citing another observation do not count — they are other collecting events, and the observation is minted beside them (beeline-0199).';

CREATE OR REPLACE VIEW sample_mint_free_link AS
SELECT sample_id, lead_inat_id, person_id, sample_number, observed_on
FROM (
  SELECT m.sample_id, m.lead_inat_id, m.person_id, m.sample_number, m.observed_on,
         row_number() OVER (PARTITION BY m.sample_id ORDER BY m.lead_inat_id) AS rn
  FROM sample_mint_match m
  WHERE m.inat_observation_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM sample_mint_ambiguous a WHERE a.lead_inat_id = m.lead_inat_id)
) ranked
WHERE rn = 1;
COMMENT ON VIEW sample_mint_free_link IS 'An existing sample that cites no observation and whose collector, number and date range an unlinked observation matches: the link is free, and it is what carries believed-true coordinates and geoprivacy onto a record the legacy dump supplied without them.';

CREATE OR REPLACE VIEW sample_mint_pending AS
SELECT g.*
FROM sample_mint_group g
WHERE NOT EXISTS (SELECT 1 FROM sample_mint_match m
                  WHERE m.lead_inat_id = g.lead_inat_id
                    AND (m.inat_observation_id IS NULL
                         OR EXISTS (SELECT 1 FROM printed_sample p WHERE p.sample_id = m.sample_id)));
COMMENT ON VIEW sample_mint_pending IS 'The samples ingest/mint-samples.sql will create on its next run, one per observation: an observation matching no existing sample, or only unprinted ones citing other observations (beeline-0199). One matching a sample citing nothing, or a printed sample, is not minted.';

CREATE OR REPLACE VIEW sample_several_observations AS
SELECT sample_id,
       CAST(count(*) AS INTEGER) AS observations,
       string_agg(CAST(inat_id AS TEXT), ', ' ORDER BY inat_id) AS inat_ids
FROM sample_claiming_observation
GROUP BY sample_id
HAVING count(*) > 1;
COMMENT ON VIEW sample_several_observations IS 'A sample more than one observation claims: a collector error (Peter, 2026-10-04), and one of the two shapes of sample_number_conflict (schema/120).';

CREATE OR REPLACE VIEW sample_number_conflict AS
SELECT s.entity_id AS sample_id,
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
SELECT s.entity_id,
       concat('sample number ', s.sample_number, ' is on ', o.observations, ' observations: ', o.inat_ids)
FROM sample s
JOIN sample_several_observations o ON o.sample_id = s.entity_id;
COMMENT ON VIEW sample_number_conflict IS 'A sample whose number its collector used more than once that day: two samples sharing (collector, date, number), or several observations claiming one (beeline-0199). qc_rule_sample_number flags it where the sample is not yet printed; a printed one is named here and flagged nowhere.';

CREATE OR REPLACE VIEW qc_rule_sample_number AS
SELECT c.sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'duplicate_sample_number' AS rule_name,
       c.details
FROM sample_number_conflict c
WHERE NOT EXISTS (SELECT 1 FROM printed_sample p WHERE p.sample_id = c.sample_id);
