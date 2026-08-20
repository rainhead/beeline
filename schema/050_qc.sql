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

-- The required/recommended split mirrors the reference implementation
-- (nonEmptyFields vs LABEL_REQUIRED_FIELDS): county is flagged when empty but
-- does not block printing; elevation is derived, so never the collector's gap.
-- Two reference rules await reference data (beeline-kw8.6): unabbreviated
-- country/state, non-tracheophyte host.
INSERT INTO qc_rule (name, severity, instructions) VALUES
  ('missing_required_field', 'blocking',
   'A field the label needs is empty. Fill it in on the iNaturalist observation (or here for trap samples) and it will clear on the next sync.'),
  ('missing_recommended_field', 'warning',
   'A field the record should carry is empty. Filling it in improves the record but does not block printing.'),
  ('obscured_no_true_coordinates', 'blocking',
   'The coordinates are obscured by iNaturalist geoprivacy and Beeline does not hold the true coordinates. Join the project with trusted coordinate access, or clear the geoprivacy setting on the observation.'),
  ('locality_format', 'blocking',
   'The locality must be a short place name (18 characters or fewer) without commas, quotes, or street addresses — it is printed on a 3pt label. Example: Corvallis not 5th St, Corvallis OR.'),
  ('coordinate_uncertainty', 'blocking',
   'The location accuracy is worse than 250 m. Improve the pin accuracy on the observation, or ask staff if the uncertainty is genuine.'),
  ('duplicate_sample_number', 'blocking',
   'Two of your samples on the same day share a sample number. Renumber one of the observations so each sample that day is distinct.'),
  ('count_below_printed', 'warning',
   'The specimen count is now lower than the number of labels already printed for this sample. Nothing to fix in the data — but some printed labels may never be attached to a specimen.');
