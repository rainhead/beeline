-- Web sessions. Re-appliable on its own: src/app/db.ts drops and recreates
-- this table when it finds the pre-beeline-ten shape, and reads the DDL
-- from here so there is only ever one copy of it.

CREATE TABLE session (
  id           TEXT PRIMARY KEY,
  inat_user_id BIGINT NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT current_timestamp,
  last_seen_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE session IS 'Web sessions: the id is the bearer credential in the cookie, so the rows live here with the other credentials. Sliding 30-day expiry enforced at lookup; only approved people (an inat_account row) ever get one.';
COMMENT ON COLUMN session.inat_user_id IS 'Who signed in, by the one identifier that survives a rebuild. It used to be person.entity_id, and a db:reseed redraws those — so every session resolved to whoever inherited its number, and a volunteer browsed as somebody else under a mine scope forced for them (beeline-ten). The person is resolved through inat_account at request time instead, which also means unbinding an account ends its sessions and rebinding moves them, both of which are what those words should do.';
