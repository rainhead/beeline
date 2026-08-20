-- Scope: this schema covers what MongoDB ingestion (roadmap phase 2) needs.
-- Entities sketched but not yet needed — email/mailing addresses, iNat sync
-- history, corrections, waivers, print runs, minted catalog numbers — stay in
-- docs/schema-sketch.md and get (re)reviewed when their phase arrives.

-- One global id sequence shared by every table: an id names exactly one entity
-- across the whole model (Datomic-style), so polymorphic references are never
-- ambiguous. See ADR 0001.
CREATE SEQUENCE entity_id_seq;

CREATE TABLE person (
  id           INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  display_name TEXT NOT NULL
);
COMMENT ON TABLE person IS 'An identity to hang facts on — deliberately anemic. Every concern lives in its own satellite table with its own privacy and lifecycle; joining one in is a deliberate act.';

CREATE TABLE inat_account (
  person_id    INTEGER PRIMARY KEY REFERENCES person(id),
  inat_user_id BIGINT NOT NULL UNIQUE,
  login        TEXT NOT NULL
);
COMMENT ON TABLE inat_account IS 'A person exists before (or without) an iNaturalist account.';
COMMENT ON COLUMN inat_account.inat_user_id IS 'The stable key; logins change.';
COMMENT ON COLUMN inat_account.login IS 'Cached for display and matching, refreshed on sync.';

CREATE TABLE atlas (
  id            INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  code          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  inat_place_id BIGINT UNIQUE
);
COMMENT ON TABLE atlas IS 'A member program of the Master Melittologist umbrella: OBA, WaBA, BC, ID, NM, OK. Samples are assigned to atlases by geography, never by pipeline or iNat project.';
COMMENT ON COLUMN atlas.inat_place_id IS 'The atlas''s iNaturalist place (Washington = 46). iNat stamps observations with place ids, so geographic assignment is a lookup, never a computation.';
