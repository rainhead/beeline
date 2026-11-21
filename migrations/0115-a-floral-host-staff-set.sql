-- Migration for schema/030_samples_specimens.sql, schema/116_view_sample_host.sql,
-- schema/120_views_qc_rules.sql and schema/175_views_locality_override.sql
-- (beeline-hlay): staff set a sample's floral host in Beeline, and it stops
-- following the sample's observation.
--
-- A new table for the host staff set, its two views, the QC rule on a
-- non-vascular host now reading a host set in Beeline in place of the
-- observation's, and two comments that said the host is always
-- iNaturalist's. Nothing is written to any sample: no row exists until staff
-- set one. The ingest statements that follow the observation
-- (ingest/mint-samples.sql) are not part of the store.

CREATE TABLE sample_host_override (
  sample_id                   INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  host_inat_taxon_id          BIGINT,
  host_name                   TEXT,
  host_rank                   TEXT,
  observed_host_inat_taxon_id BIGINT,
  observed_host_name          TEXT,
  observed_host_rank          TEXT,
  set_by                      INTEGER REFERENCES person(entity_id),
  reason                      TEXT NOT NULL CHECK (reason <> ''),
  CHECK ((host_inat_taxon_id IS NULL) = (host_name IS NULL)),
  CHECK ((host_inat_taxon_id IS NULL) = (host_rank IS NULL))
);
COMMENT ON TABLE sample_host_override IS 'A floral host a staff member set on a sample, or their statement that it has none, which promotion never overwrites: both statements about the host in ingest/mint-samples.sql skip samples with a row here. Re-derived at the end of observation promotion from data/sample-overlay.csv, the durable record; sample.host_inat_taxon_id, host_name_as_observed and host_rank are written beside it because every read uses them, and sample_host_override_stale asserts the two agree.';
COMMENT ON COLUMN sample_host_override.host_inat_taxon_id IS 'The iNaturalist taxon staff set as the host. Null, with host_name and host_rank, where staff say the sample has no floral host.';
COMMENT ON COLUMN sample_host_override.host_name IS 'The taxon''s name as iNaturalist gave it when staff set it, kept here and in the overlay file and never read back from the taxon cache.';
COMMENT ON COLUMN sample_host_override.host_rank IS 'The taxon''s rank as iNaturalist gave it when staff set it.';
COMMENT ON COLUMN sample_host_override.observed_host_inat_taxon_id IS 'With observed_host_name and observed_host_rank: what the sample held as its host when the override was written, which is the merge base and what removal restores. All null where it had no host. The id alone is null for a host that was only a name. A second save keeps the first base.';
COMMENT ON COLUMN sample_host_override.set_by IS 'Whoever set it, resolved from the overlay row''s author login through inat_account at apply time; null where the login no longer resolves.';
COMMENT ON COLUMN sample_host_override.reason IS 'Why staff set it. Required.';

-- The rule's view, as schema/120 now has it. qc_finding reads it by name.
CREATE OR REPLACE VIEW qc_rule_non_tracheophyte_host AS
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
WHERE f.host_is_tracheophyte IS FALSE
  AND NOT EXISTS (SELECT 1 FROM sample_host_override o WHERE o.sample_id = s.entity_id)
UNION ALL
-- A host staff set is judged by that host and never by the observation
-- (beeline-hlay). It was checked when it was set, so this fires only on a row
-- that reached the overlay file another way, and only where the taxon cache's
-- lineage says the host is no vascular plant: an unknown lineage does not, and
-- no floral host never does.
SELECT s.entity_id, CAST(NULL AS INTEGER), 'non_tracheophyte_host',
       CASE WHEN o.host_name IS NULL
            THEN concat('staff host taxon ', CAST(o.host_inat_taxon_id AS TEXT), ' is not a vascular plant')
       END,
       o.host_name, o.host_rank
FROM sample s
JOIN sample_host_override o ON o.sample_id = s.entity_id
JOIN sample_host h ON h.sample_id = s.entity_id
WHERE h.is_vascular IS FALSE;

CREATE VIEW sample_host_override_stale AS
SELECT o.sample_id, o.host_inat_taxon_id AS override_host_inat_taxon_id, o.host_name AS override_host_name, o.host_rank AS override_host_rank,
       s.host_inat_taxon_id AS sample_host_inat_taxon_id, s.host_name_as_observed AS sample_host_name, s.host_rank AS sample_host_rank
FROM sample_host_override o
JOIN sample s ON s.entity_id = o.sample_id
WHERE s.host_inat_taxon_id IS DISTINCT FROM o.host_inat_taxon_id
   OR s.host_name_as_observed IS DISTINCT FROM o.host_name
   OR s.host_rank IS DISTINCT FROM o.host_rank;
COMMENT ON VIEW sample_host_override_stale IS 'Host overrides the sample row disagrees with, in any of the three host columns. Empty by construction; a row here means a writer bypassed src/apply-sample-overlay.ts.';

-- Diverged: the observation now names a plant that is neither what the sample
-- held when staff set the host nor what staff set. The override stands, and
-- the sample page says what iNaturalist now gives. An observation that names
-- no plant is not a third value, since the follow rule ignores one too
-- (observation_host is NULL where the taxon means no host).
CREATE VIEW sample_host_override_diverged AS
SELECT o.sample_id, o.host_inat_taxon_id AS override_host_inat_taxon_id, o.observed_host_inat_taxon_id,
       h.host_taxon_id AS observation_host_inat_taxon_id, h.host_taxon_name AS observation_host_name,
       h.host_taxon_rank AS observation_host_rank
FROM sample_host_override o
JOIN sample s ON s.entity_id = o.sample_id
JOIN observation_host h ON h.inat_id = s.inat_observation_id
WHERE h.host_taxon_id IS NOT NULL
  AND h.host_taxon_id IS DISTINCT FROM o.host_inat_taxon_id
  AND h.host_taxon_id IS DISTINCT FROM o.observed_host_inat_taxon_id;
COMMENT ON VIEW sample_host_override_diverged IS 'Host overrides whose observation has since moved to a third plant: the override stands, and /samples/:id shows staff what iNaturalist now gives.';

COMMENT ON COLUMN sample.host_inat_taxon_id IS 'Floral host as an iNat taxon reference — hosts never live in the curated animal table. With host_name_as_observed and host_rank it follows the sample''s observation on every promotion, printed or not, while the observation carries a taxon (ingest/mint-samples.sql, beeline-ni5m.7): a label never carries the host, so a later identification is taken. Except where staff have set the host in Beeline (sample_host_override): then all three columns are what staff set, or all null for a sample staff say has no floral host, and the observation no longer changes them. On a sample with no observation it is what the import stated, or what staff set.';
COMMENT ON COLUMN sample_host.resolved_by IS 'id: the sample''s own host id, an identification on iNaturalist or a plant staff set in Beeline (sample_host_override). name: the sample has no id and its host name was looked up (beeline-rfkj.5).';
