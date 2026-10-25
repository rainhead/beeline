-- Rule *definitions* are views (schema/120); qc_finding is their UNION —
-- derived, never stored. Rule *metadata* is data, seeded below. Holds and
-- waivers, the staff decisions over findings, are at the end of this file.

CREATE TABLE qc_rule (
  name         TEXT PRIMARY KEY,
  severity     TEXT NOT NULL CHECK (severity IN ('blocking', 'warning')),
  instructions TEXT NOT NULL
);
COMMENT ON TABLE qc_rule IS 'Metadata for the QC rules whose definitions are the qc_rule_* views. blocking prevents printing; warning informs.';
COMMENT ON COLUMN qc_rule.instructions IS 'The self-service "what to do" copy shown with a finding.';

-- Findings only ingestion can see: once staging is discarded, the model
-- cannot re-derive them, so they are stored rows rather than a view —
-- the one exception to findings-are-derived. Unioned into qc_finding
-- (schema/130) like every rule view.
CREATE TABLE sample_promotion_finding (
  sample_id INTEGER NOT NULL REFERENCES sample(entity_id),
  rule_name TEXT NOT NULL REFERENCES qc_rule(name),
  details   TEXT NOT NULL
);
COMMENT ON TABLE sample_promotion_finding IS 'Sample-keyed findings persisted at ingestion time because only the staging layer can observe them (e.g. within-sample disagreement between the legacy rows that merged into one sample). Not an entity (ADR 0002): anchored on the sample it describes.';

-- The required/recommended split mirrors the reference implementation
-- (nonEmptyFields vs LABEL_REQUIRED_FIELDS): county is flagged when empty but
-- does not block printing; elevation is derived, so never the collector's gap.
INSERT INTO qc_rule (name, severity, instructions) VALUES
  ('missing_required_field', 'blocking',
   'A field the label needs is empty. Fill it in on the iNaturalist observation (or here for trap samples) and it will clear on the next sync.'),
  ('missing_recommended_field', 'warning',
   'A field the record should carry is empty. Filling it in improves the record but does not block printing.'),
  ('obscured_no_true_coordinates', 'blocking',
   'The coordinates are obscured by iNaturalist geoprivacy and Beeline does not hold the true coordinates. Join the project with trusted coordinate access, or clear the geoprivacy setting on the observation.'),
  ('taxon_obscured_awaiting_atlas', 'blocking',
   'iNaturalist hides where the plant on this observation grows, because of its conservation status. A label carries the true location, and Beeline prints it only where the bee atlas for that place has agreed. No atlas has agreed for where this sample was collected, so its labels will not print for now. There is nothing for you to fix.'),
  ('locality_format', 'blocking',
   'The locality must be a short place name (18 characters or fewer) without commas, quotes, or street addresses — it is printed on a 3pt label. Example: Corvallis not 5th St, Corvallis OR.'),
  ('place_unabbreviated', 'blocking',
   'Country and state/province must be abbreviations (USA not United States; OR not Oregon) — the label cell is tiny.'),
  ('place_unrecognised', 'warning',
   'The state or province on this record is not one Beeline recognises, or does not agree with the country beside it. Use the two-letter US state or Canadian province code (UT, BC), and a country that matches it. Records from outside the US and Canada are expected here and are not a mistake — staff can confirm them.'),
  ('coordinate_uncertainty', 'blocking',
   'The location accuracy is worse than this record allows — the flag says by how much, and which limit applied. Records from 2 September 2026 onwards must be within 100 m, the resolution of a GPS reading; for a trap, the day it was emptied is the one that counts. Earlier records keep the 250 m that was in force when they were collected. Improve the pin accuracy on the observation, or ask staff if the uncertainty is genuine.'),
  ('coordinate_out_of_region', 'blocking',
   'The coordinates on this record are not in North America, but the record says they should be. Usually the pin was moved on the observation after its location text was written, or a longitude lost its minus sign. Check the pin on the iNaturalist observation — if the record really was collected outside North America, set its country to match and ask staff to confirm it.'),
  ('non_tracheophyte_host', 'blocking',
   'The iNaturalist observation should be identified as the floral host — a vascular plant. Its current identification is something else (a moss, alga, fungus, or the bee itself). Correct the observation''s identification to the plant the bee was collected from and it will clear on the next sync.'),
  ('duplicate_sample_number', 'blocking',
   'Each sample has its own number, and this one is on more than one of your samples that day. Renumber all but one of their observations on iNaturalist; until their labels print, the samples follow.'),
  ('count_mismatch', 'warning',
   'Your iNaturalist observation and this sample disagree about how many specimens were collected. Update whichever side is wrong.'),
  ('count_below_printed', 'warning',
   'The specimen count is now lower than the number of labels already printed for this sample. Nothing to fix in the data — but some printed labels may never be attached to a specimen.'),
  ('within_sample_disagreement', 'warning',
   'The legacy records merged into this sample disagreed about a field; the earliest record''s value was kept. Review the alternatives listed and correct the sample if the kept value is wrong.'),
  ('observation_missing_upstream', 'blocking',
   'The iNaturalist observation backing this sample was not returned by a sync that should have included it. It may have been deleted, removed from the project, or had its observation date changed. Staff investigate before any further printing for this sample.');

-- ── Holds and waivers: staff decisions about QC (beeline-plu, beeline-1kb.9) ──
--
-- Two decisions a rule cannot make. A HOLD is staff saying a record no rule
-- catches is wrong: it keeps the sample from printing until an admin lifts
-- it, and the collector fixing the record does not lift it, because nothing
-- can tell that the doubt is answered (Peter, 2026-09-18). A WAIVER is the
-- inverse: a blocking flag fires on a sample staff judge to be fine, and they
-- let it print (Peter, 2026-10-25). Both are kept in data/sample-overlay.csv,
-- the durable record a rebuild replays (src/sample-overlay.ts), and applied
-- here by src/apply-sample-overlay.ts, like the locality and coordinate
-- overrides.
--
-- A hold is a finding like any other — the qc_rule_staff_hold arm of
-- qc_finding (schema/130) — so printability, the front page and the
-- listings take it out of print with no code of their own. A waiver takes
-- one finding out of sample_qc_finding (schema/130), and only while the flag
-- still says what it said when it was waived: if the record changes and the
-- flag's wording with it, the finding is back.
--
-- Whether a waiver still applies is STORED (in_force), not compared in the
-- view. Comparing in sample_qc_finding made every finding build its text —
-- qc_rule_sample_number's above all — and printability 80% slower on the
-- dev store with no waivers at all (63 ms to 115 ms, review of the branch).
-- The applier rechecks every waiver each time it runs, which is the end of
-- every observation promotion and every staff decision: the two ways a
-- waivable flag's text changes on a sample that has an observation.

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
