-- Migration for schema/066, schema/105 and schema/120, with a data repair: a
-- floral host identified as Homo sapiens is no host (beeline-rfkj.11).
--
-- On iNaturalist, Homo sapiens as an observation's taxon is a user's flag that
-- the observation is not really one of anything (Peter, 2026-11-15). Minting
-- copied it into the sample as the host, and qc_rule_non_tracheophyte_host
-- then blocked the sample as if the volunteer had identified the wrong
-- subject. inat_taxon_not_a_host names such taxa; observation_host is the host
-- a sample takes from its observation, with them removed; minting, the QC
-- rule and the dashboard read it.
--
-- THE REPAIR. Every sample whose stored host is such a taxon loses its host:
-- the three host columns become NULL, as for a sample whose observation names
-- no plant. On production's store of 2026-11-15 that is 47 samples: 46
-- settled ones with host id 43584 (34 of them printed), and one sample of
-- 2026 with the name and no id, promoted from old Beeline's plant columns. No
-- label prints the host, so nothing on paper changes. None of the 47 had
-- held a plant that the flag replaced: the legacy rows of the 34 that came
-- from old Beeline name Homo sapiens or nothing, and the sample history since
-- it began (27 September 2026) shows no host going from a plant to Homo
-- sapiens. The values need not be kept here: the observations still say Homo
-- sapiens (observation_field is untouched), and the app's first boot after
-- this migration records each change in the sample history with its old
-- value (source "reconcile", src/app/main.ts), which should report 47.
--
-- The UPDATE is safe to run twice: the second time no sample holds such a
-- host. The DDL before it is not, like any migration's.

-- Taxa that, given as an observation's taxon, mean the observation names NO
-- host, rather than a host that is not a plant (beeline-rfkj.11). Homo
-- sapiens is how an iNaturalist user flags an observation as not really an
-- observation of anything (Peter, 2026-11-15); it is not the bee, which is
-- what the other animals identified as an observation's subject are (Andrena,
-- Apis mellifera), and which qc_rule_non_tracheophyte_host rightly catches.
-- Seeded here, so another such taxon is a row and not code. Applied where a
-- host is written (observation_host, schema/105; ingest/promote-legacy.sql by
-- name), never at read time, because a sample's host columns are read in a
-- dozen places and one missed reader would send the flag to GBIF. (The export
-- to old Beeline still gives old Beeline's own rows back their own plant
-- columns, Homo sapiens included, as it does every column it imported.)
CREATE TABLE inat_taxon_not_a_host (
  inat_taxon_id BIGINT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  reason        TEXT NOT NULL
);
COMMENT ON TABLE inat_taxon_not_a_host IS 'iNaturalist taxa that, as an observation''s taxon, mean the observation names no floral host (beeline-rfkj.11). observation_host gives such an observation no host, so minting writes none and a sample keeps what it has; legacy promotion drops a host of this name. Seeded in the schema.';
COMMENT ON COLUMN inat_taxon_not_a_host.name IS 'The taxon''s scientific name, as iNaturalist and old Beeline''s plant columns write it, for the legacy rows, which carry the name and no id.';
COMMENT ON COLUMN inat_taxon_not_a_host.reason IS 'Why the taxon means no host, in a few words.';
INSERT INTO inat_taxon_not_a_host VALUES
  (43584, 'Homo sapiens', 'An iNaturalist user''s way of flagging an observation as not an observation of anything (Peter, 2026-11-15).');

-- The floral host an observation names, as a sample is to take it
-- (beeline-rfkj.11): observation_field's host columns, except that a taxon
-- in inat_taxon_not_a_host (Homo sapiens, a user's flag) is no host at all,
-- so every column is NULL, as for an observation with no taxon. Minting
-- (ingest/mint-samples.sql), the QC rule on the host
-- (qc_rule_non_tracheophyte_host) and the dashboard's unminted observations
-- read this and not observation_field, so the three agree; observation_field
-- stays a faithful copy of the load.
CREATE VIEW observation_host AS
SELECT f.inat_id,
       CASE WHEN x.inat_taxon_id IS NULL THEN f.host_taxon_id END        AS host_taxon_id,
       CASE WHEN x.inat_taxon_id IS NULL THEN f.host_taxon_name END      AS host_taxon_name,
       CASE WHEN x.inat_taxon_id IS NULL THEN f.host_taxon_rank END      AS host_taxon_rank,
       CASE WHEN x.inat_taxon_id IS NULL THEN f.host_is_tracheophyte END AS host_is_tracheophyte
FROM observation_field f
LEFT JOIN inat_taxon_not_a_host x ON x.inat_taxon_id = f.host_taxon_id;
COMMENT ON VIEW observation_host IS 'Each observation''s floral host as a sample takes it: observation_field''s host_taxon_id, host_taxon_name, host_taxon_rank and host_is_tracheophyte, all NULL where the taxon is one that means no host (inat_taxon_not_a_host). What minting, qc_rule_non_tracheophyte_host and the dashboard read.';

DROP VIEW qc_rule_non_tracheophyte_host;
CREATE VIEW qc_rule_non_tracheophyte_host AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'non_tracheophyte_host' AS rule_name,
       CASE WHEN f.host_taxon_name IS NULL
            THEN concat('observation taxon ', CAST(f.host_taxon_id AS TEXT), ' is not a vascular plant')
       END AS details,
       f.host_taxon_name AS detail_taxon_name,
       f.host_taxon_rank AS detail_taxon_rank
FROM sample s
JOIN observation_host f ON f.inat_id = s.inat_observation_id
WHERE f.host_is_tracheophyte IS FALSE;

UPDATE sample SET host_inat_taxon_id = NULL, host_name_as_observed = NULL, host_rank = NULL
WHERE host_inat_taxon_id IN (SELECT inat_taxon_id FROM inat_taxon_not_a_host)
   OR (host_inat_taxon_id IS NULL AND host_name_as_observed IN (SELECT name FROM inat_taxon_not_a_host));
