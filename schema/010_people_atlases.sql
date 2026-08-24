-- Scope: this schema covers what MongoDB ingestion (roadmap phase 2) needs.
-- Entities sketched but not yet needed — email/mailing addresses, iNat sync
-- history, corrections, waivers, print runs, minted catalog numbers — stay in
-- docs/schema-sketch.md and get (re)reviewed when their phase arrives.

-- One global id sequence shared by every table: an id names exactly one entity
-- across the whole model (Datomic-style), so polymorphic references are never
-- ambiguous. See ADR 0001.
CREATE SEQUENCE entity_id_seq;

CREATE TABLE person (
  entity_id    INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  display_name TEXT NOT NULL,
  given_name   TEXT,
  family_name  TEXT,
  label_name   TEXT,
  pronouns     TEXT CHECK (pronouns IN ('he', 'she', 'they'))
);
COMMENT ON TABLE person IS 'An identity to hang facts on — deliberately anemic. Every concern lives in its own satellite table with its own privacy and lifecycle; joining one in is a deliberate act. Name parts and pronouns sit here together because all of them answer "how to refer to this person".';
COMMENT ON COLUMN person.display_name IS 'The full form, as this person is named on screen and in exports (Darwin Core recordedBy).';
COMMENT ON COLUMN person.given_name IS 'Given name(s), kept apart from the family name because a label prints the initial: P. Abrahamsen. Null where a name could not be parted (mononym, unparsed import) — the label form then falls back to display_name.';
COMMENT ON COLUMN person.family_name IS 'The whole family name, particles included (Van Otterloo, Vanden Heuvel, Benitez Alvarez): it is what survives abbreviation, so it is never re-split at print time.';
COMMENT ON COLUMN person.label_name IS 'What a label prints when derivation is wrong or unwanted — an override, so the derived form stays the default (see src/person-name.ts). Null ⇒ derived.';
COMMENT ON COLUMN person.pronouns IS 'Self-filled; null = unstated (render neutrally, never guess). Starting vocabulary he/she/they — widening the CHECK is expected, and is cheap pre-cutover.';

CREATE TABLE inat_account (
  person_id    INTEGER PRIMARY KEY REFERENCES person(entity_id),
  inat_user_id BIGINT NOT NULL UNIQUE,
  login        TEXT NOT NULL
);
COMMENT ON TABLE inat_account IS 'A person exists before (or without) an iNaturalist account.';
COMMENT ON COLUMN inat_account.inat_user_id IS 'The stable key; logins change.';
COMMENT ON COLUMN inat_account.login IS 'Cached for display and matching, refreshed on sync.';

CREATE TABLE person_orcid (
  person_id INTEGER PRIMARY KEY REFERENCES person(entity_id),
  orcid     TEXT NOT NULL UNIQUE
);
COMMENT ON TABLE person_orcid IS 'ORCiD where known — scholarly attribution for determiners and authors in exports. Some iNaturalist profiles note them; recorded as confirmed, never guessed.';

CREATE TABLE atlas (
  entity_id     INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  code          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  inat_place_id BIGINT UNIQUE
);
COMMENT ON TABLE atlas IS 'A member program of the Master Melittologist umbrella: OBA, WaBA, BC, ID, NM, OK. Samples are assigned to atlases by geography, never by pipeline or iNat project.';
COMMENT ON COLUMN atlas.inat_place_id IS 'The atlas''s iNaturalist place (Washington = 46). iNat stamps observations with place ids, so geographic assignment is a lookup, never a computation.';

-- The six member atlases. Place ids are filled in as they are verified
-- against iNat (only Washington's is documented so far).
INSERT INTO atlas (code, name, inat_place_id) VALUES
  ('OBA',  'Oregon Bee Atlas',           NULL),
  ('WaBA', 'Washington Bee Atlas',       46),
  ('BC',   'British Columbia Bee Atlas', NULL),
  ('ID',   'Idaho Bee Atlas',            NULL),
  ('NM',   'New Mexico Bee Atlas',       NULL),
  ('OK',   'Oklahoma Bee Atlas',         NULL);

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

-- Where a person belongs in the program, as distinct from where their samples
-- fall. Geography assigns a sample; it cannot assign a person, who may collect
-- across a border, move, or belong to the program before collecting anything
-- (beeline-2c3.11). Its own table because the answer is editorial — staff set
-- it, promotion never guesses it — and because it carries the atlas colorway
-- the volunteer's own pages are branded with.
--
-- Membership has two shapes, and the reason this is not just a nullable
-- atlas_id is that a *missing row* has to keep meaning one thing. Master
-- Melittology membership without a member atlas is real (beeline-lcl): a
-- Nevada volunteer works under OBA staff's auspices without being an Oregon
-- Bee Atlas volunteer, and writing OBA here would make them indistinguishable
-- from a Corvallis regular in every listing, export, and atlas-branded page.
-- So kind says which case it is, and absence is reserved for "not asked yet".
--
-- Who administers a program-only member is a separate fact, deliberately not
-- modelled: OBA staff do, and there is no second administering body to tell
-- them apart from until per-atlas staff roles exist (beeline-lcl).
CREATE TABLE person_membership (
  person_id INTEGER PRIMARY KEY REFERENCES person(entity_id),
  kind      TEXT NOT NULL CHECK (kind IN ('atlas', 'program')),
  atlas_id  INTEGER REFERENCES atlas(entity_id),
  CHECK ((kind = 'atlas') = (atlas_id IS NOT NULL))
);
COMMENT ON TABLE person_membership IS 'Where a person belongs: a member atlas, or the umbrella program with no atlas. A row is an answer somebody gave; absent = never asked, which is the honest default — no row is not the same as OBA, and it is not the same as "no atlas applies" either.';
COMMENT ON COLUMN person_membership.kind IS '''atlas'' ⇒ a member atlas, named by atlas_id. ''program'' ⇒ Master Melittology itself, under OBA staff''s auspices, with no member atlas. iNat project 99706 (''outside of Oregon'') is this state''s operational expression, and is already administered that way upstream.';
COMMENT ON COLUMN person_membership.atlas_id IS 'Set by staff, never inferred from where their samples landed — a Washington volunteer collecting in Oregon is still WaBA. Null exactly when kind is ''program''.';

-- Who may use the admin surface. A table rather than a config array so the
-- roster is editable by the people who own it (beeline-eft added five names
-- by deploy); src/app/config.ts ADMIN_LOGINS remains the bootstrap seed, so a
-- store that has never been granted anything still lets its keeper in.
CREATE TABLE person_admin (
  person_id  INTEGER PRIMARY KEY REFERENCES person(entity_id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by TEXT
);
COMMENT ON TABLE person_admin IS 'Admin rights: /jobs, /people, /design, and the listings scope picker. Presence is the grant; revoking deletes the row.';
COMMENT ON COLUMN person_admin.granted_by IS 'iNat login of whoever granted it, or ''seed'' for the checked-in bootstrap roster. Not a foreign key: the granter may be gone.';
