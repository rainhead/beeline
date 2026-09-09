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
  label_name   TEXT
);
COMMENT ON TABLE person IS 'An identity to hang facts on — deliberately anemic. Every concern lives in its own satellite table with its own privacy and lifecycle; joining one in is a deliberate act. Name parts sit here because they answer "how to refer to this person"; a pronouns column sat here too until 2026-08-27, when it was removed as sensitive and unnecessary — anyone who wants to state theirs can say so in prose (beeline-6bw).';
COMMENT ON COLUMN person.display_name IS 'The full form, as this person is named on screen and in exports (Darwin Core recordedBy).';
COMMENT ON COLUMN person.given_name IS 'Given name(s), kept apart from the family name because a label prints the initial: P. Abrahamsen. Null where a name could not be parted (mononym, unparsed import) — the label form then falls back to display_name.';
COMMENT ON COLUMN person.family_name IS 'The whole family name, particles included (Van Otterloo, Vanden Heuvel, Benitez Alvarez): it is what survives abbreviation, so it is never re-split at print time.';
COMMENT ON COLUMN person.label_name IS 'What a label prints when derivation is wrong or unwanted — an override, so the derived form stays the default (see src/person-name.ts). Null ⇒ derived.';

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
--
-- Deliberately left alone by beeline-2yt, which gave every atlas_region a
-- verified place id including these six. Nothing reads this column — not a
-- query, view, or page — and atlas_region's is what observation_place joins
-- on, so filling these in would duplicate a fact to no reader. It would also
-- have to be an UPDATE on a deployed store, and DuckDB 1.5.5 refuses to write
-- an INDEXED column of a row an incoming foreign key references: inat_place_id
-- is UNIQUE and so indexed, and atlas_region.atlas_id references every row
-- here. That is a fight worth having only for a value somebody wants.
--
-- The index is the discriminator and the inbound reference alone is not:
-- UPDATE atlas SET name succeeds on the very same row. This comment used to
-- state only the second half, which also predicts that a sample's locality
-- cannot be refreshed — it can, and minting depends on it (beeline-6e9).
-- Both halves are pinned by test in test/schema.test.ts, so the day DuckDB
-- changes is a day something says so. A test also asserts the one id here
-- agrees with atlas_region's, so the two cannot drift apart while both exist.
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
  atlas_id       INTEGER REFERENCES atlas(entity_id),
  inat_place_id  BIGINT
);
-- Uniqueness as a named index rather than an inline UNIQUE, so that a store
-- brought forward by migration 0020 and one built fresh from here are the
-- same shape: a migration can only add the constraint this way (DuckDB has no
-- ALTER TABLE ADD CONSTRAINT), and two stores that differ in how they spell
-- the same rule are exactly what ADR 0006 exists to prevent.
CREATE UNIQUE INDEX atlas_region_inat_place_id_key ON atlas_region (inat_place_id);
COMMENT ON TABLE atlas_region IS 'State/province → the member atlas covering it, for the US and Canada. Geography assigns samples to atlases (schema/030); this is the lookup it does. Deliberately complete rather than data-shaped: a region absent from this table means "unrecognised", so listing only the six would make every other real place look like a typo.';
COMMENT ON COLUMN atlas_region.state_province IS 'The two-letter USPS or Canada Post code, exactly as a sample carries it — this is the join key, so the format is load-bearing: qc_rule_place_unrecognised fires on anything that does not match a row here.';
COMMENT ON COLUMN atlas_region.country IS 'ISO 3166-1 alpha-3, matching the ''USA'' the records already carry. Not part of the key — see the note above — but the truth a sample''s own country is checked against.';
COMMENT ON COLUMN atlas_region.atlas_id IS 'Null ⇒ no member atlas covers this region. That is an answer, not a gap: these are the records that belong to the umbrella program itself.';
COMMENT ON COLUMN atlas_region.inat_place_id IS 'This region''s iNaturalist place, so a sample minted from an observation can be given a state at all: iNat stamps observations with place ids and place_guess is free text ("Leach Botanical Garden"), so the two-letter code has to be reached through here (beeline-2yt). atlas.inat_place_id answers the same question for the six atlases only; every region needs one, and a test pins the six to agree.';

-- Place ids were derived twice and agreed: iNaturalist's own autocomplete
-- filtered to admin_level 10 under the right country, and — independently —
-- the place id that actually appears on the observations behind the samples
-- already filed under each code. The second reaches only the 22 regions the
-- corpus has records for, which is exactly why it is worth having: it is what
-- would catch a plausible-but-wrong name match. Oregon 10, Washington 46
-- (agreeing with atlas.inat_place_id, the one id documented before this).
INSERT INTO atlas_region (state_province, country, atlas_id, inat_place_id)
SELECT r.state_province, r.country, a.entity_id, r.inat_place_id
FROM (VALUES
  -- The six, in the order schema declares them.
  ('OR', 'USA', 'OBA', 10), ('WA', 'USA', 'WaBA', 46), ('BC', 'CAN', 'BC', 7085),
  ('ID', 'USA', 'ID', 22),  ('NM', 'USA', 'NM', 9),   ('OK', 'USA', 'OK', 12),
  -- Everywhere else Master Melittologists have collected, or could.
  ('AL', 'USA', NULL, 19), ('AK', 'USA', NULL, 6), ('AZ', 'USA', NULL, 40), ('AR', 'USA', NULL, 36),
  ('CA', 'USA', NULL, 14), ('CO', 'USA', NULL, 34), ('CT', 'USA', NULL, 49), ('DE', 'USA', NULL, 4),
  ('DC', 'USA', NULL, 5), ('FL', 'USA', NULL, 21), ('GA', 'USA', NULL, 23), ('HI', 'USA', NULL, 11),
  ('IL', 'USA', NULL, 35), ('IN', 'USA', NULL, 20), ('IA', 'USA', NULL, 24), ('KS', 'USA', NULL, 25),
  ('KY', 'USA', NULL, 26), ('LA', 'USA', NULL, 27), ('ME', 'USA', NULL, 17), ('MD', 'USA', NULL, 39),
  ('MA', 'USA', NULL, 2), ('MI', 'USA', NULL, 29), ('MN', 'USA', NULL, 38), ('MS', 'USA', NULL, 37),
  ('MO', 'USA', NULL, 28), ('MT', 'USA', NULL, 16), ('NE', 'USA', NULL, 3), ('NV', 'USA', NULL, 50),
  ('NH', 'USA', NULL, 41), ('NJ', 'USA', NULL, 51), ('NY', 'USA', NULL, 48), ('NC', 'USA', NULL, 30),
  ('ND', 'USA', NULL, 13), ('OH', 'USA', NULL, 31), ('PA', 'USA', NULL, 42), ('RI', 'USA', NULL, 8),
  ('SC', 'USA', NULL, 43), ('SD', 'USA', NULL, 44), ('TN', 'USA', NULL, 45), ('TX', 'USA', NULL, 18),
  ('UT', 'USA', NULL, 52), ('VT', 'USA', NULL, 47), ('VA', 'USA', NULL, 7), ('WV', 'USA', NULL, 33),
  ('WI', 'USA', NULL, 32), ('WY', 'USA', NULL, 15),
  ('AB', 'CAN', NULL, 6834), ('MB', 'CAN', NULL, 7590), ('NB', 'CAN', NULL, 7587), ('NL', 'CAN', NULL, 7289),
  ('NS', 'CAN', NULL, 6853), ('NT', 'CAN', NULL, 9079), ('NU', 'CAN', NULL, 13335), ('ON', 'CAN', NULL, 6883),
  ('PE', 'CAN', NULL, 9116), ('QC', 'CAN', NULL, 13336), ('SK', 'CAN', NULL, 7953), ('YT', 'CAN', NULL, 13337)
) AS r(state_province, country, atlas_code, inat_place_id)
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

-- Who may act for somebody else. A household shares one iNat login, but an
-- account belongs to exactly one person (inat_account is 1:1, and beeline-oyl
-- decided it stays that way): the partner who does not hold it has no way to
-- sign in, and `mine` scope is forced for volunteers, so nobody who can log in
-- can see their samples. The Pedersons are 1,146 and 1,087 samples under one
-- login, correctly attributed to two people, and half of them unreachable.
--
-- This grants reach, never credit. Samples, labels, recordedBy and Master
-- Melittology progress stay on the person who collected — a delegate sees and
-- acts, and the work remains the other person's. Directional on purpose:
-- Gretchen acting for Robert does not imply the reverse, because a household
-- where only one partner still collects should not silently become mutual.
--
-- Granted by staff rather than by the person represented, which is the part
-- that surprises: the obvious rule — the subject consents — cannot work here,
-- since being unable to sign in is the whole reason the row exists.
CREATE TABLE person_delegate (
  person_id   INTEGER NOT NULL REFERENCES person(entity_id),
  acts_for_id INTEGER NOT NULL REFERENCES person(entity_id),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by  TEXT,
  PRIMARY KEY (person_id, acts_for_id),
  CHECK (person_id <> acts_for_id)
);
COMMENT ON TABLE person_delegate IS 'person_id may see and act on acts_for_id''s samples (beeline-oyl). Presence is the grant; revoking deletes the row. Reach, not credit: attribution and Master Melittology progress stay with the person who collected.';
COMMENT ON COLUMN person_delegate.person_id IS 'The delegate — the one who signs in, so in practice the holder of the household''s iNat account. Not enforced: a grant to someone with no account is inert rather than refused, because the same overlay pass may bind their account after this row is applied.';
COMMENT ON COLUMN person_delegate.acts_for_id IS 'The person acted for, typically the household partner who does not hold the shared login. Usually has no inat_account at all, which is the state this table exists to make workable.';
COMMENT ON COLUMN person_delegate.granted_by IS 'iNat login of the staff member who granted it. Not a foreign key: the granter may be gone — same stance as person_admin.granted_by.';
