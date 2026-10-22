-- Migration for schema/010_people_atlases.sql, schema/050_qc.sql,
-- schema/120_views_qc_rules.sql and schema/130_view_qc_finding.sql
-- (beeline-1kb.7): a taxon-obscured sample prints only where its atlas has
-- said labels may carry the true point.
--
-- Arthur answered gh-13 for Oregon on 2026-10-21: its labels may, and until
-- an atlas answers, its taxon-obscured records stay unprintable. Before this,
-- nothing held them back once Beeline had the true point, so the first print
-- run would have put a rare plant's location on a Washington label.
--
-- The union gains an arm, so it and the roll-up over it come down and go
-- back up, as in 0034.

CREATE TABLE atlas_taxon_obscured_printing (
  atlas_id   INTEGER PRIMARY KEY REFERENCES atlas(entity_id),
  decided_by TEXT NOT NULL,
  decided_on DATE NOT NULL,
  source     TEXT NOT NULL
);
COMMENT ON TABLE atlas_taxon_obscured_printing IS 'Atlases whose labels may carry the true coordinates of a taxon-obscured record; presence is the answer. An atlas absent here has not answered, and its taxon-obscured samples do not print (qc_rule_taxon_obscured_awaiting_atlas).';
COMMENT ON COLUMN atlas_taxon_obscured_printing.decided_by IS 'Who answered for the atlas, by name.';
COMMENT ON COLUMN atlas_taxon_obscured_printing.source IS 'Where the answer was given: a link to the comment or message that holds it.';

-- Oregon's answer: its labels may carry the true point, and whether a rare
-- plant's name goes out with a record is Lincoln Best's call at upload, not
-- a label's.
INSERT INTO atlas_taxon_obscured_printing (atlas_id, decided_by, decided_on, source)
SELECT entity_id, 'Arthur Schrenk', DATE '2026-10-21',
       'https://github.com/rainhead/beeline/issues/13#issuecomment-6327141377'
FROM atlas WHERE code = 'OBA';

INSERT INTO qc_rule (name, severity, instructions) VALUES
  ('taxon_obscured_awaiting_atlas', 'blocking',
   'iNaturalist hides where the plant on this observation grows, because of its conservation status. A label carries the true location, and the atlas where this sample was collected has not yet said whether its labels may, so Beeline will not print a label for this sample until it does. There is nothing for you to fix.');

DROP VIEW sample_qc_finding;
DROP VIEW qc_finding;

CREATE VIEW qc_rule_taxon_obscured_awaiting_atlas AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'taxon_obscured_awaiting_atlas' AS rule_name,
       concat('taxon_geoprivacy=', s.taxon_geoprivacy, ', atlas=', coalesce(a.code, 'none')) AS details
FROM sample s
JOIN sample_location loc ON loc.sample_id = s.entity_id
LEFT JOIN sample_atlas sa ON sa.sample_id = s.entity_id
LEFT JOIN atlas a ON a.entity_id = sa.atlas_id
WHERE s.taxon_geoprivacy IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM atlas_taxon_obscured_printing ok WHERE ok.atlas_id = sa.atlas_id);

CREATE VIEW qc_finding AS
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
  -- Stored ingestion-time findings join the derived ones (schema/050).
  UNION ALL SELECT sample_id, CAST(NULL AS INTEGER) AS specimen_id, rule_name, details
  FROM sample_promotion_finding
) prose
UNION ALL SELECT * FROM qc_rule_non_tracheophyte_host;

CREATE VIEW sample_qc_finding AS
SELECT coalesce(f.sample_id, sp.sample_id) AS sample_id,
       f.specimen_id,
       f.rule_name,
       f.details,
       f.detail_taxon_name,
       f.detail_taxon_rank
FROM qc_finding f
LEFT JOIN specimen sp ON sp.entity_id = f.specimen_id;

-- The two comments that called the question open now say where the answer
-- lives.
COMMENT ON COLUMN sample.taxon_geoprivacy IS 'iNat taxon-driven obscuring: in this program, a host plant iNaturalist treats as rare. Whether its true coordinates may print is each atlas''s answer (atlas_taxon_obscured_printing); until the atlas gives one the sample does not print (docs/questions.md).';
COMMENT ON TABLE sample_location IS 'Believed-true coordinates, isolated in their own table: joining them in is a deliberate act, never an accident. Retention of source coordinate pairs (including obscured ones) is unconditional but lives in the staging/observation layer; revelation for taxon-obscured records is each atlas''s answer (atlas_taxon_obscured_printing, docs/questions.md).';
