-- Rule *definitions* are views (schema/120); qc_finding is their UNION —
-- derived, never stored. Rule *metadata* is data, seeded below. Waivers are
-- sketched (docs/schema-sketch.md) and return with the self-service QC phase.

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
   'Two of your samples on the same day share a sample number. Renumber one of the observations so each sample that day is distinct.'),
  ('count_mismatch', 'warning',
   'Your iNaturalist observation and this sample disagree about how many specimens were collected. Update whichever side is wrong.'),
  ('count_below_printed', 'warning',
   'The specimen count is now lower than the number of labels already printed for this sample. Nothing to fix in the data — but some printed labels may never be attached to a specimen.'),
  ('within_sample_disagreement', 'warning',
   'The legacy records merged into this sample disagreed about a field; the earliest record''s value was kept. Review the alternatives listed and correct the sample if the kept value is wrong.'),
  ('observation_missing_upstream', 'blocking',
   'The iNaturalist observation backing this sample was not returned by a sync that should have included it. It may have been deleted, removed from the project, or had its observation date changed. Staff investigate before any further printing for this sample.');
