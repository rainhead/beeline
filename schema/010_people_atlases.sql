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
