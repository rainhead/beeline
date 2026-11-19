-- Migration for schema/014_registrations.sql (beeline-w8ab.7): a keyed
-- fingerprint of each registration's email address, for linking a person at
-- sign-in. A new table and an index; no existing row changes. The design is
-- explained at the table in schema/014.

CREATE TABLE ideal_logic_email_fingerprint (
  ideal_logic_id TEXT PRIMARY KEY,
  fingerprint    TEXT NOT NULL
);
-- Not unique: two registrations can share an address, and then nobody is linked by it.
CREATE INDEX ideal_logic_email_fingerprint_fp ON ideal_logic_email_fingerprint (fingerprint);
COMMENT ON TABLE ideal_logic_email_fingerprint IS 'A keyed fingerprint of the email address of each registration in Ideal Logic, so that a person signing in with a confirmed iNaturalist email can be matched to a registration without any address being stored. Replaced whole by each night''s ideal-logic-registrants job; empty where REGISTRATION_EMAIL_KEY is not set. It cannot be turned back into an address without the secret. Someone holding both this table and the secret could test whether a guessed address is registered, which is why the secret is never stored here. Holds a row for every registration, not only the ones ideal_logic_registrant keeps, and has no name.';
COMMENT ON COLUMN ideal_logic_email_fingerprint.ideal_logic_id IS 'Ideal Logic''s id for the registration, as in ideal_logic_registrant. Not a foreign key: a registration with no row there is still fingerprinted.';
COMMENT ON COLUMN ideal_logic_email_fingerprint.fingerprint IS 'HMAC-SHA256, as hex, of the registration''s email address trimmed and lower-cased, under the secret REGISTRATION_EMAIL_KEY. Not unique: two registrations may share an address, and then nothing is linked by it.';
