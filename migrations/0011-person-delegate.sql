-- Migration for schema/010_people_atlases.sql (beeline-oyl): one person may
-- act for another.
--
-- A household shares one iNat login, but inat_account is 1:1 and stays that
-- way. The partner who does not hold the login cannot sign in, and `mine`
-- scope is forced for volunteers, so their samples are unreachable by the only
-- person who can: 1,087 of the Pedersons' 2,233 are in that state today, all
-- of them correctly attributed and none of them visible.
--
-- Adds the table only. No rows: who may act for whom is a staff decision,
-- recorded in the person overlay as `acts_for` and replayed from there, so a
-- deployed store picks the grants up the same way it picks up every other
-- decision about people — not from this file.
CREATE TABLE person_delegate (
  person_id   INTEGER NOT NULL REFERENCES person(entity_id),
  acts_for_id INTEGER NOT NULL REFERENCES person(entity_id),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by  TEXT,
  PRIMARY KEY (person_id, acts_for_id),
  CHECK (person_id <> acts_for_id)
);
COMMENT ON TABLE person_delegate IS 'person_id may see and act on acts_for_id''s samples (beeline-oyl). Presence is the grant; revoking deletes the row. Reach, not credit: attribution and Master Melittology progress stay with the person who collected.';
COMMENT ON COLUMN person_delegate.person_id IS 'The delegate — the one who signs in. Holds an iNat account by definition, since a person who cannot sign in cannot act for anybody.';
COMMENT ON COLUMN person_delegate.acts_for_id IS 'The person acted for, typically the household partner who does not hold the shared login. Usually has no inat_account at all, which is the state this table exists to make workable.';
COMMENT ON COLUMN person_delegate.granted_by IS 'iNat login of the staff member who granted it. Not a foreign key: the granter may be gone — same stance as person_admin.granted_by.';
