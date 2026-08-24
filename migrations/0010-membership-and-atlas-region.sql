-- Migration for schema/010_people_atlases.sql (beeline-lcl): people and
-- specimens from outside any member atlas.
--
-- Two absences stopped meaning two things each. On the person side,
-- person_home_atlas had no way to say "asked, and the answer is no atlas" —
-- Master Melittology membership without a member atlas is a real state, and
-- the only way to express it was to have no row, which already meant "not
-- asked". On the sample side, atlas_id NULL could not tell "collected outside
-- the six" from "geography did not resolve".
--
-- Sample atlas assignments are unchanged by this: atlas_region reproduces the
-- CASE that promote-legacy.sql used, region for region.

-- Which atlas covers a state or province — the mapping legacy promotion used
-- to carry as a six-way CASE, moved into the schema so it can be queried and
-- so its silences can be told apart (beeline-lcl).
--
-- A row with a NULL atlas_id is the point of the table: it says "we know this
-- region and no member atlas covers it", which is what 632 samples in Nevada,
-- Kansas, Arizona and the Yukon actually are — real Master Melittologist
-- records, not failures. No row at all is the other thing: a place the model
-- does not recognise, which is a defect worth flagging rather than filing
-- silently under "outside" (qc_rule_place_unrecognised).
--
-- Keyed on the state or province alone. Adding country to the key would buy
-- no discrimination — no US state code collides with a Canadian one — while
-- costing the sample whose country is blank, and the one whose collector is
-- Canadian and whose country field followed her rather than her coordinates.
-- Country is recorded here so that disagreement can be reported instead.
CREATE TABLE atlas_region (
  state_province TEXT PRIMARY KEY,
  country        TEXT NOT NULL,
  atlas_id       INTEGER REFERENCES atlas(entity_id)
);
COMMENT ON TABLE atlas_region IS 'State/province → the member atlas covering it, for the US and Canada. Geography assigns samples to atlases (schema/030); this is the lookup it does. Deliberately complete rather than data-shaped: a region absent from this table means "unrecognised", so listing only the six would make every other real place look like a typo.';
COMMENT ON COLUMN atlas_region.state_province IS 'The two-letter USPS or Canada Post code, exactly as a sample carries it — this is the join key, so the format is load-bearing: qc_rule_place_unrecognised fires on anything that does not match a row here.';
COMMENT ON COLUMN atlas_region.country IS 'ISO 3166-1 alpha-3, matching the ''USA'' the records already carry. Not part of the key — see the note above — but the truth a sample''s own country is checked against.';
COMMENT ON COLUMN atlas_region.atlas_id IS 'Null ⇒ no member atlas covers this region. That is an answer, not a gap: these are the records that belong to the umbrella program itself.';

INSERT INTO atlas_region (state_province, country, atlas_id)
SELECT r.state_province, r.country, a.entity_id
FROM (VALUES
  -- The six, in the order schema declares them.
  ('OR', 'USA', 'OBA'), ('WA', 'USA', 'WaBA'), ('BC', 'CAN', 'BC'),
  ('ID', 'USA', 'ID'),  ('NM', 'USA', 'NM'),   ('OK', 'USA', 'OK'),
  -- Everywhere else Master Melittologists have collected, or could.
  ('AL', 'USA', NULL), ('AK', 'USA', NULL), ('AZ', 'USA', NULL), ('AR', 'USA', NULL),
  ('CA', 'USA', NULL), ('CO', 'USA', NULL), ('CT', 'USA', NULL), ('DE', 'USA', NULL),
  ('DC', 'USA', NULL), ('FL', 'USA', NULL), ('GA', 'USA', NULL), ('HI', 'USA', NULL),
  ('IL', 'USA', NULL), ('IN', 'USA', NULL), ('IA', 'USA', NULL), ('KS', 'USA', NULL),
  ('KY', 'USA', NULL), ('LA', 'USA', NULL), ('ME', 'USA', NULL), ('MD', 'USA', NULL),
  ('MA', 'USA', NULL), ('MI', 'USA', NULL), ('MN', 'USA', NULL), ('MS', 'USA', NULL),
  ('MO', 'USA', NULL), ('MT', 'USA', NULL), ('NE', 'USA', NULL), ('NV', 'USA', NULL),
  ('NH', 'USA', NULL), ('NJ', 'USA', NULL), ('NY', 'USA', NULL), ('NC', 'USA', NULL),
  ('ND', 'USA', NULL), ('OH', 'USA', NULL), ('PA', 'USA', NULL), ('RI', 'USA', NULL),
  ('SC', 'USA', NULL), ('SD', 'USA', NULL), ('TN', 'USA', NULL), ('TX', 'USA', NULL),
  ('UT', 'USA', NULL), ('VT', 'USA', NULL), ('VA', 'USA', NULL), ('WV', 'USA', NULL),
  ('WI', 'USA', NULL), ('WY', 'USA', NULL),
  ('AB', 'CAN', NULL), ('MB', 'CAN', NULL), ('NB', 'CAN', NULL), ('NL', 'CAN', NULL),
  ('NS', 'CAN', NULL), ('NT', 'CAN', NULL), ('NU', 'CAN', NULL), ('ON', 'CAN', NULL),
  ('PE', 'CAN', NULL), ('QC', 'CAN', NULL), ('SK', 'CAN', NULL), ('YT', 'CAN', NULL)
) AS r(state_province, country, atlas_code)
LEFT JOIN atlas a ON a.code = r.atlas_code;

-- Country to ISO 3166-1 alpha-3, matching the 'USA' that most records already
-- carry. Canada arrived spelled both ways, which split British Columbia's
-- records (2,321 'CA' + 1,497 'CAN') as well as the Yukon's — a difference
-- nothing meant and every count had to work around.
UPDATE sample SET country = 'CAN' WHERE country = 'CA';
UPDATE sample SET country = 'NZL' WHERE country = 'NZ';

CREATE TABLE person_membership (
  person_id INTEGER PRIMARY KEY REFERENCES person(entity_id),
  kind      TEXT NOT NULL CHECK (kind IN ('atlas', 'program')),
  atlas_id  INTEGER REFERENCES atlas(entity_id),
  CHECK ((kind = 'atlas') = (atlas_id IS NOT NULL))
);
COMMENT ON TABLE person_membership IS 'Where a person belongs: a member atlas, or the umbrella program with no atlas. A row is an answer somebody gave; absent = never asked, which is the honest default — no row is not the same as OBA, and it is not the same as "no atlas applies" either.';
COMMENT ON COLUMN person_membership.kind IS '''atlas'' ⇒ a member atlas, named by atlas_id. ''program'' ⇒ Master Melittology itself, under OBA staff''s auspices, with no member atlas. iNat project 99706 (''outside of Oregon'') is this state''s operational expression, and is already administered that way upstream.';
COMMENT ON COLUMN person_membership.atlas_id IS 'Set by staff, never inferred from where their samples landed — a Washington volunteer collecting in Oregon is still WaBA. Null exactly when kind is ''program''.';

-- Every home atlas recorded so far is an atlas membership; the program-only
-- case is what this migration makes sayable, so it starts empty.
INSERT INTO person_membership (person_id, kind, atlas_id)
SELECT person_id, 'atlas', atlas_id FROM person_home_atlas;

DROP TABLE person_home_atlas;

-- ── The rule that keeps atlas_id honest ──────────────────────────────────
-- Being outside the six is ordinary and stays unflagged; a place the lookup
-- cannot find, or one whose country contradicts it, is the thing worth seeing
-- (schema/120). Two samples on the sandbox fire it today, and they are right.
INSERT INTO qc_rule (name, severity, instructions) VALUES
  ('place_unrecognised', 'warning',
   'The state or province on this record is not one Beeline recognises, or does not agree with the country beside it. Use the two-letter US state or Canadian province code (UT, BC), and a country that matches it. Records from outside the US and Canada are expected here and are not a mistake — staff can confirm them.');

-- Whether the stated place resolves to a region at all — the rule that keeps
-- sample.atlas_id honest (beeline-lcl). Collecting outside the six atlases is
-- ordinary and unflagged: atlas_region carries a row for every US state and
-- Canadian province, and a NULL atlas on one of those rows means "no member
-- atlas covers this", not "something went wrong". What this fires on is a
-- place the lookup cannot find, and a place whose country contradicts it —
-- Bonnie Zand collecting in Kane County, Utah with her usual CAN in the
-- country field, which the old six-way CASE filed silently under "outside".
-- A missing state_province is missing_required_field's to report, not this
-- rule's: one root cause, one flag.
CREATE VIEW qc_rule_place_unrecognised AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'place_unrecognised' AS rule_name,
       CASE WHEN reg.state_province IS NULL
            THEN concat('state_province ''', s.state_province, ''' is not a US state or Canadian province')
            ELSE concat('country ''', s.country, ''' disagrees: ', s.state_province, ' is in ', reg.country)
       END AS details
FROM sample s
LEFT JOIN atlas_region reg ON reg.state_province = s.state_province
WHERE s.state_province IS NOT NULL
  AND (reg.state_province IS NULL OR (s.country IS NOT NULL AND s.country <> reg.country));

CREATE OR REPLACE VIEW qc_finding AS
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
-- Stored ingestion-time findings join the derived ones (schema/050).
UNION ALL SELECT sample_id, CAST(NULL AS INTEGER) AS specimen_id, rule_name, details
FROM sample_promotion_finding;
