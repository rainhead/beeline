-- Migration for schema/050, schema/120 and schema/130 (beeline-plu,
-- beeline-1kb.9): staff holds and waivers. Two tables and the list of flags
-- no waiver can set aside, the staff_hold rule and its view, and qc_finding
-- and sample_qc_finding replaced so a hold is a finding and a waived finding
-- is left out. The reasoning is in schema/050. Nothing existing changes
-- shape, and both tables arrive empty; the next observation promotion, or a
-- staff decision on a sample page, fills them from data/sample-overlay.csv.
-- qc_rule_observation_missing_upstream is replaced too: its text now says
-- when the observation was last returned rather than counting the runs that
-- missed it, which changed with every sync and would lapse a waiver on it.

INSERT INTO qc_rule (name, severity, instructions) VALUES
  ('staff_hold', 'blocking',
   'Staff are holding this sample back from printing. Their note says why. If it asks you to change something, change it; staff will lift the hold once they are satisfied, since fixing the record does not lift it by itself.');

CREATE TABLE sample_hold (
  sample_id INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  reason    TEXT NOT NULL CHECK (reason <> ''),
  held_by   INTEGER REFERENCES person(entity_id)
);
COMMENT ON TABLE sample_hold IS 'A sample staff are holding back from printing (beeline-plu). Re-derived at the end of observation promotion from data/sample-overlay.csv, the durable record. qc_rule_staff_hold (schema/120) makes each row a blocking finding, with the reason as its details: the note is for the collector, who may have something to fix, and for the printer, who needs to know why the sample is not in the run.';
COMMENT ON COLUMN sample_hold.held_by IS 'Whoever placed it, resolved from the overlay row''s author login through inat_account at apply time; null where the login no longer resolves.';

-- Waiving these would print something false, or override a decision that is
-- an atlas's rather than a judgement about one sample (Peter, 2026-10-25):
-- a shifted point printed as the true one, a taxon-obscured point an atlas
-- has not agreed to reveal, a label with a blank in it. A hold is lifted, not
-- waived. Listed as data so sample_qc_finding refuses a waiver on these even
-- if a row for one reaches sample_qc_waiver.
CREATE TABLE qc_rule_unwaivable (
  name TEXT PRIMARY KEY REFERENCES qc_rule(name)
);
COMMENT ON TABLE qc_rule_unwaivable IS 'The blocking rules no waiver can set aside (beeline-1kb.9): sample_qc_finding ignores a waiver on any of these.';
INSERT INTO qc_rule_unwaivable (name) VALUES
  ('obscured_no_true_coordinates'),
  ('taxon_obscured_awaiting_atlas'),
  ('missing_required_field'),
  ('staff_hold');

-- One waiver per flag per sample: none of the waivable blocking rules fires
-- twice on one sample (schema/120), so (sample, rule) names the finding, and
-- `finding` is what it said — its details, and the taxon where a finding
-- names one, joined as sample_qc_finding compares them.
CREATE TABLE sample_qc_waiver (
  sample_id INTEGER NOT NULL REFERENCES sample(entity_id),
  rule_name TEXT NOT NULL REFERENCES qc_rule(name),
  finding   TEXT NOT NULL,
  reason    TEXT NOT NULL CHECK (reason <> ''),
  waived_by INTEGER REFERENCES person(entity_id),
  in_force  BOOLEAN NOT NULL,
  PRIMARY KEY (sample_id, rule_name)
);
COMMENT ON TABLE sample_qc_waiver IS 'A blocking flag staff have judged fine on one sample, so it prints (beeline-1kb.9). Re-derived at the end of observation promotion from data/sample-overlay.csv. In force only while the flag still says `finding`; ignored for the rules in qc_rule_unwaivable.';
COMMENT ON COLUMN sample_qc_waiver.in_force IS 'Whether the flag still fires on this sample and says `finding`, as of the last time the overlay was applied (every promotion, every staff decision). sample_qc_finding reads this rather than comparing text, which would cost every finding its text.';
COMMENT ON COLUMN sample_qc_waiver.finding IS 'What the flag said when it was waived: concat_ws('' '', details, detail_taxon_name), the comparison sample_qc_finding makes.';
COMMENT ON COLUMN sample_qc_waiver.waived_by IS 'Whoever waived it, resolved from the overlay row''s author login through inat_account at apply time; null where the login no longer resolves.';

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
GROUP BY l.sample_id, l.inat_observation_id;

CREATE VIEW qc_rule_staff_hold AS
SELECT h.sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'staff_hold' AS rule_name,
       h.reason AS details
FROM sample_hold h;

CREATE OR REPLACE VIEW qc_finding AS
SELECT sample_id, specimen_id, rule_name, details,
       CAST(NULL AS TEXT) AS detail_taxon_name,
       CAST(NULL AS TEXT) AS detail_taxon_rank
FROM (
  SELECT * FROM qc_rule_missing_required_field
  UNION ALL SELECT * FROM qc_rule_missing_recommended_field
  UNION ALL SELECT * FROM qc_rule_obscured_no_true_coordinates
  UNION ALL SELECT * FROM qc_rule_taxon_obscured_awaiting_atlas
  UNION ALL SELECT * FROM qc_rule_locality_format
  UNION ALL SELECT * FROM qc_rule_place_unabbreviated
  UNION ALL SELECT * FROM qc_rule_place_unrecognised
  UNION ALL SELECT * FROM qc_rule_coordinate_uncertainty
  UNION ALL SELECT * FROM qc_rule_coordinate_out_of_region
  UNION ALL SELECT * FROM qc_rule_sample_number
  UNION ALL SELECT * FROM qc_rule_count_mismatch
  UNION ALL SELECT * FROM qc_rule_count_below_printed
  UNION ALL SELECT * FROM qc_rule_observation_missing_upstream
  UNION ALL SELECT * FROM qc_rule_staff_hold
  -- Stored ingestion-time findings join the derived ones (schema/050).
  UNION ALL SELECT sample_id, CAST(NULL AS INTEGER) AS specimen_id, rule_name, details
  FROM sample_promotion_finding
) prose
UNION ALL SELECT * FROM qc_rule_non_tracheophyte_host;

CREATE OR REPLACE VIEW sample_qc_finding AS
SELECT coalesce(f.sample_id, sp.sample_id) AS sample_id,
       f.specimen_id,
       f.rule_name,
       f.details,
       f.detail_taxon_name,
       f.detail_taxon_rank
FROM qc_finding f
LEFT JOIN specimen sp ON sp.entity_id = f.specimen_id
WHERE NOT EXISTS (
  SELECT 1 FROM sample_qc_waiver w
  WHERE w.sample_id = coalesce(f.sample_id, sp.sample_id)
    AND w.rule_name = f.rule_name
    AND w.in_force
    AND NOT EXISTS (SELECT 1 FROM qc_rule_unwaivable u WHERE u.name = w.rule_name));
