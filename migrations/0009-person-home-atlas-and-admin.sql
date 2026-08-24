-- Migration for schema/010_people_atlases.sql (beeline-2c3.11, roster screen).
--
-- Two satellites in the anemic-person style: where a person belongs, and
-- whether they may use the admin surface. Both are additive — no existing
-- table changes — so this is the one-line-per-table case the schema style is
-- meant to produce.
--
-- person_admin arrives empty on purpose. src/app/db.ts seeds it from the
-- checked-in ADMIN_LOGINS at boot when it is empty, so the store that runs
-- this migration is admin-less for exactly as long as it takes to restart,
-- and a later revocation is not undone by the next boot.

CREATE TABLE person_home_atlas (
  person_id INTEGER PRIMARY KEY REFERENCES person(entity_id),
  atlas_id  INTEGER NOT NULL REFERENCES atlas(entity_id)
);
COMMENT ON TABLE person_home_atlas IS 'The atlas a person belongs to. Absent = unknown, which is the honest default: no row is not the same as OBA.';
COMMENT ON COLUMN person_home_atlas.atlas_id IS 'Set by staff, never inferred from where their samples landed — a Washington volunteer collecting in Oregon is still WaBA.';

CREATE TABLE person_admin (
  person_id  INTEGER PRIMARY KEY REFERENCES person(entity_id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by TEXT
);
COMMENT ON TABLE person_admin IS 'Admin rights: /jobs, /people, /design, and the listings scope picker. Presence is the grant; revoking deletes the row.';
COMMENT ON COLUMN person_admin.granted_by IS 'iNat login of whoever granted it, or ''seed'' for the checked-in bootstrap roster. Not a foreign key: the granter may be gone.';
