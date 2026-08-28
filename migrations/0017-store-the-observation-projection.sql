-- Migration for schema/060_sync.sql, schema/105 and schema/120
-- (beeline-2c3.36): store the shredded observation projection instead of
-- re-deriving it on every read.
--
-- observation_current_fields shreds 63k JSON projections in ~200 ms, nearly
-- all of it in the two correlated $.ofvs subqueries, and three QC rules read
-- it — so scanning qc_finding cost ~670 ms, and the QC home, both listings,
-- printability and the record pages each paid that. Reading a stored copy
-- takes the union to ~205 ms. The view stays: it is still the definition,
-- and now also what the table is refreshed from and checked against.
--
-- Findings themselves stay derived (schema/050). What makes this projection
-- the exception is that its only input is observation_load, which nothing
-- but a sync writes — where a finding also depends on `sample`, which the
-- in-app editor writes while promising the flags update immediately, and on
-- `specimen`, which printing will write.
--
-- Filled here rather than left for the next promotion. An empty table is not
-- a visibly broken one: the three rules below would simply report nothing,
-- and printability would call every sample clean. Two hundred milliseconds
-- to leave the store correct at the moment this commits.

CREATE TABLE observation_field (
  inat_id                    BIGINT PRIMARY KEY,
  observed_on                DATE,
  latitude                   DOUBLE,
  longitude                  DOUBLE,
  private_latitude           DOUBLE,
  private_longitude          DOUBLE,
  positional_accuracy        INTEGER,
  public_positional_accuracy INTEGER,
  geoprivacy                 TEXT,
  taxon_geoprivacy           TEXT,
  viewer_trusted             BOOLEAN,
  user_id                    BIGINT,
  user_login                 TEXT,
  place_guess                TEXT,
  host_taxon_id              BIGINT,
  host_taxon_name            TEXT,
  host_is_tracheophyte       BOOLEAN,
  quality_grade              TEXT,
  sample_number_raw          TEXT,
  specimen_count_raw         TEXT
);
COMMENT ON TABLE observation_field IS 'The materialisation of observation_current_fields (schema/105), which remains its definition. Refreshed whole inside the sync run that changes observation_load — its only input — and never written by anything else. Read this, not the view: the view costs ~200 ms per scan and three QC rules go through it.';
COMMENT ON COLUMN observation_field.inat_id IS 'One row per observation, so the PRIMARY KEY is the observation itself — the constraint says out loud what the "current load" definition already guarantees.';
COMMENT ON COLUMN observation_field.host_is_tracheophyte IS 'NULL when the taxon is absent or the load predates ancestor_ids in the projection — the distinction qc_rule_non_tracheophyte_host relies on, so it is carried rather than defaulted.';

INSERT INTO observation_field SELECT * FROM observation_current_fields;

-- The three rules, repointed from the view to the table. DuckDB will not drop
-- a view something else depends on, and the qc_finding union — plus
-- printability and the pending-print list above it — sits on all three, so
-- the whole stack comes down in dependency order and goes back up unchanged.
DROP VIEW pending_print_sample;
DROP VIEW printable_sample;
DROP VIEW blocking_sample;
DROP VIEW sample_qc_finding;
DROP VIEW qc_finding;
DROP VIEW qc_rule_non_tracheophyte_host;
DROP VIEW qc_rule_count_mismatch;
DROP VIEW qc_rule_observation_missing_upstream;

CREATE VIEW qc_rule_non_tracheophyte_host AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'non_tracheophyte_host' AS rule_name,
       concat('observation taxon ', coalesce(f.host_taxon_name, CAST(f.host_taxon_id AS TEXT)),
              ' is not a vascular plant') AS details
FROM sample s
JOIN observation_field f ON f.inat_id = s.inat_observation_id
WHERE f.host_is_tracheophyte IS FALSE;

CREATE VIEW qc_rule_count_mismatch AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'count_mismatch' AS rule_name,
       concat('observation says ', f.specimen_count_raw, ' but sample count is ', s.specimen_count) AS details
FROM sample s
JOIN observation_field f ON f.inat_id = s.inat_observation_id
WHERE try_cast(f.specimen_count_raw AS INTEGER) IS NOT NULL
  AND try_cast(f.specimen_count_raw AS INTEGER) <> s.specimen_count;

CREATE VIEW qc_rule_observation_missing_upstream AS
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
 AND (r.window_start IS NULL OR f.observed_on >= r.window_start)
 AND (r.window_end IS NULL OR f.observed_on <= r.window_end)
GROUP BY s.entity_id, s.inat_observation_id;

CREATE VIEW qc_finding AS
SELECT * FROM qc_rule_missing_required_field
UNION ALL SELECT * FROM qc_rule_missing_recommended_field
UNION ALL SELECT * FROM qc_rule_obscured_no_true_coordinates
UNION ALL SELECT * FROM qc_rule_locality_format
UNION ALL SELECT * FROM qc_rule_place_unabbreviated
UNION ALL SELECT * FROM qc_rule_place_unrecognised
UNION ALL SELECT * FROM qc_rule_coordinate_uncertainty
UNION ALL SELECT * FROM qc_rule_duplicate_sample_number
UNION ALL SELECT * FROM qc_rule_non_tracheophyte_host
UNION ALL SELECT * FROM qc_rule_count_mismatch
UNION ALL SELECT * FROM qc_rule_count_below_printed
UNION ALL SELECT * FROM qc_rule_observation_missing_upstream
UNION ALL SELECT sample_id, CAST(NULL AS INTEGER) AS specimen_id, rule_name, details
FROM sample_promotion_finding;

CREATE VIEW sample_qc_finding AS
SELECT coalesce(f.sample_id, sp.sample_id) AS sample_id,
       f.specimen_id,
       f.rule_name,
       f.details
FROM qc_finding f
LEFT JOIN specimen sp ON sp.entity_id = f.specimen_id;

CREATE VIEW blocking_sample AS
SELECT DISTINCT f.sample_id AS sample_id
FROM sample_qc_finding f
JOIN qc_rule r ON r.name = f.rule_name AND r.severity = 'blocking'
WHERE f.sample_id IS NOT NULL;

CREATE VIEW printable_sample AS
SELECT s.entity_id AS sample_id
FROM sample s
WHERE s.specimen_count > 0
  AND NOT EXISTS (SELECT 1 FROM blocking_sample b WHERE b.sample_id = s.entity_id);

CREATE VIEW pending_print_sample AS
SELECT s.entity_id AS sample_id,
       -- CAST because count() is 64-bit: the app reads this as a plain number.
       CAST(s.specimen_count - coalesce(printed.n, 0) AS INTEGER) AS pending_count
FROM printable_sample p
JOIN sample s ON s.entity_id = p.sample_id
LEFT JOIN (
  SELECT sample_id, count(*) AS n FROM specimen GROUP BY sample_id
) printed ON printed.sample_id = s.entity_id
WHERE s.specimen_count > coalesce(printed.n, 0);

-- And the alarm for the one thing that can now go silently wrong.
CREATE VIEW observation_field_stale AS
SELECT inat_id FROM (
  SELECT * FROM observation_current_fields
  EXCEPT
  SELECT * FROM observation_field
) missing
UNION
SELECT inat_id FROM (
  SELECT * FROM observation_field
  EXCEPT
  SELECT * FROM observation_current_fields
) extra;
