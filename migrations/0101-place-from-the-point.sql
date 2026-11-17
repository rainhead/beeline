-- Migration for schema/038 and schema/173 (beeline-rax1): each sample's
-- area derivation records what its point says the country and state or
-- province are, and the version of the step that found them, and the new
-- view sample_place_disagreement reads them. DuckDB cannot add a NOT NULL
-- column to a table that has rows, so the table is replaced, as 0068 did for
-- the locality candidates. The rows it held come across as version 0 with no
-- place, older than any the step has, so the next nightly tests every sample
-- again; until then the areas it found still show, and the stamp, which reads
-- the place from here, changes nothing.

CREATE TEMP TABLE area_derivation_before AS SELECT * FROM sample_area_derivation;

DROP VIEW sample_ecoregion_missing;
DROP VIEW sample_area_current;
DROP TABLE sample_area_derivation;

-- Which samples have had their areas worked out, at which point and from which
-- gazetteer. A sample inside no area has a row here and none in sample_area,
-- which is what tells "inside nothing" from "not yet looked at".
--
-- It also records what the point says about the sample's state or province
-- and country, read from the one county it lies in (beeline-rax1). That is a
-- statement about this sample's point, made at the point and build it was
-- made for, and not an attribute of the county: nothing records that a county
-- lies inside a state (schema/038). sample.state_province is a different fact,
-- what the record and its labels say; the county stamp (src/derive-area.ts)
-- writes the one from the other where a sample still follows its point, and
-- sample_place_disagreement (schema/173) shows where they differ.
CREATE TABLE sample_area_derivation (
  sample_id       INTEGER PRIMARY KEY REFERENCES sample(entity_id),
  latitude        DOUBLE NOT NULL,
  longitude       DOUBLE NOT NULL,
  gazetteer_build TEXT NOT NULL,
  rule_version    INTEGER NOT NULL,
  country         TEXT,
  state_province  TEXT,
  county_inside   BOOLEAN,
  derived_at      TIMESTAMP NOT NULL
);
COMMENT ON TABLE sample_area_derivation IS 'The point and gazetteer build a sample''s areas (sample_area) were worked out at, as sample_locality_suggestion records them for a name: a moved point, a new build or a new rule is tested again. Also what that point says the sample''s country and state or province are.';
COMMENT ON COLUMN sample_area_derivation.latitude IS 'With longitude: the believed-true point the areas were found for. sample_area_current shows them only while the sample is still there.';
COMMENT ON COLUMN sample_area_derivation.rule_version IS 'AREA_RULE_VERSION in src/derive-area.ts when the areas were found. Raising that constant tests every sample again, as a new gazetteer build does.';
COMMENT ON COLUMN sample_area_derivation.country IS 'What the point says the country is: that of the one county or BC regional district it was found in (USA, CAN), however it was reached. NULL where it is in no county, or in two.';
COMMENT ON COLUMN sample_area_derivation.state_province IS 'What the point says the state or province is (OR, BC), from the same county as country. Not an attribute of the county: a statement about this sample''s point, which the sample''s own state_province may contradict.';
COMMENT ON COLUMN sample_area_derivation.county_inside IS 'TRUE where the point lies inside that county''s outline; FALSE where it lies outside every county and took the nearest within 1 km, on the shore (COUNTY_SHORE_M), which near a land border can be across it. NULL where there is no county.';

INSERT INTO sample_area_derivation (sample_id, latitude, longitude, gazetteer_build, rule_version, derived_at)
SELECT sample_id, latitude, longitude, gazetteer_build, 0, derived_at FROM area_derivation_before;
DROP TABLE area_derivation_before;

-- The areas a sample lies inside, where they were worked out at the point the
-- sample has now (beeline-9jd4). Areas found for somewhere else are not shown:
-- the coordinates moved, or the sample has none now, and the next nightly
-- tests it again. The tolerance is schema/170's, for its reason.
CREATE VIEW sample_area_current AS
SELECT sa.sample_id, a.source, a.source_id, a.kind, a.name
FROM sample_area sa
JOIN area a ON a.source = sa.area_source AND a.source_id = sa.area_source_id
JOIN sample_area_derivation d ON d.sample_id = sa.sample_id
JOIN sample_location l ON l.sample_id = sa.sample_id
WHERE abs(d.latitude - l.latitude) <= 5e-5
  AND abs(d.longitude - l.longitude) <= 5e-5;

-- Located samples that no ecoregion was found for (beeline-l5so): the file
-- covers the land, so a point in the sea off the coast, or in a country the
-- file leaves out, is in none, and so is a sample the derive step has not yet
-- tested against a gazetteer that holds ecoregions: with a gazetteer built
-- before they were added, every located sample is here, which is the signal
-- to rebuild it. A check count, so it says
-- which season the sample is in: ask it split, never as one number.
CREATE VIEW sample_ecoregion_missing AS
SELECT d.sample_id, EXISTS (SELECT 1 FROM settled_sample ss WHERE ss.sample_id = d.sample_id) AS settled
FROM sample_area_derivation d
JOIN sample_location l ON l.sample_id = d.sample_id
WHERE abs(d.latitude - l.latitude) <= 5e-5
  AND abs(d.longitude - l.longitude) <= 5e-5
  AND NOT EXISTS (SELECT 1 FROM sample_area_current c WHERE c.sample_id = d.sample_id AND c.kind = 'ecoregion');
COMMENT ON VIEW sample_ecoregion_missing IS 'Samples with a believed-true point, tested for areas at that point, that lie in no EPA ecoregion (a point in the sea beyond 1 km of the shore, or outside the file''s coverage), and every located sample while the gazetteer predates ecoregions, which is the signal to rebuild it. settled says whether the sample is from a settled season, so the count is read split: active seasons against settled ones.';

-- Samples whose recorded state or province, or country, is not what their
-- point says (beeline-rax1). The county stamp (src/derive-area.ts) makes the
-- two agree on every sample that follows its point, so what is left here is
-- mostly what it leaves alone on purpose: a printed sample, whose place is
-- what its labels say, a settled one, an old-system record, one frozen into
-- a run that has not printed, and a point on the shore whose nearest county
-- is in another state (county_inside FALSE). A sample tested by "Check
-- iNaturalist now" and not yet stamped by the nightly is here too, until the
-- nightly. A sample in no county, or in two, is never here: its point says
-- nothing about the state.
--
-- A report, not a QC finding: it blocks nothing and changes nothing that
-- prints, and on a printed or settled sample the volunteer can rarely fix it
-- (Peter, 2026-11-17). Staff see it on the sample page. Only the point's
-- currency is checked, so after a change to AREA_RULE_VERSION or a new
-- gazetteer it shows the earlier answer until the nightly tests again.
CREATE VIEW sample_place_disagreement AS
SELECT s.entity_id AS sample_id,
       s.country, s.state_province,
       d.country AS point_country, d.state_province AS point_state_province,
       d.county_inside,
       EXISTS (SELECT 1 FROM printed_sample p WHERE p.sample_id = s.entity_id) AS printed,
       EXISTS (SELECT 1 FROM settled_sample ss WHERE ss.sample_id = s.entity_id) AS settled
FROM sample_area_derivation d
JOIN sample_location l ON l.sample_id = d.sample_id
JOIN sample s ON s.entity_id = d.sample_id
WHERE abs(d.latitude - l.latitude) <= 5e-5
  AND abs(d.longitude - l.longitude) <= 5e-5
  AND d.state_province IS NOT NULL
  AND (s.state_province IS DISTINCT FROM d.state_province OR s.country IS DISTINCT FROM d.country);
COMMENT ON VIEW sample_place_disagreement IS 'Samples whose recorded state or province, or country, is not the one their point says (sample_area_derivation), with whether the point is inside its county or only near it on the shore. printed and settled say why the county stamp left it; read counts split by season.';
