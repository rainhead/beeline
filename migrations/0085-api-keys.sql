-- Migration for schema/012_sign_in.sql (beeline-pnqr.1): personal API keys.

CREATE TABLE api_key (
  key_sha256   TEXT PRIMARY KEY CHECK (length(key_sha256) = 64),
  inat_user_id BIGINT NOT NULL,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  scope        TEXT NOT NULL CHECK (scope IN ('read', 'edit', 'staff')),
  created_at   TIMESTAMP NOT NULL DEFAULT current_timestamp,
  expires_at   TIMESTAMP NOT NULL,
  last_used_at TIMESTAMP,
  revoked_at   TIMESTAMP
);
COMMENT ON TABLE api_key IS 'Personal API keys (beeline-pnqr.1): a credential a person creates for a program of their own, such as a script or an AI assistant, to use in place of signing in. A key is accepted only under /api/v1/, as a bearer header, and a page never accepts one. Like a session it is keyed by iNat user and resolved through inat_account on every request, so unlinking the account stops the key. A row is kept after the key is revoked or expires, so that what the key did can still be traced to it.';
COMMENT ON COLUMN api_key.key_sha256 IS 'The SHA-256, in lowercase hex, of the key, never the key itself, for the reason session.id_sha256 gives: a copy of this table lets nobody in. The key carries 256 random bits, so a plain SHA-256 is enough. Its first 12 hex digits are the reference the person sees in their list of keys and that records of the key''s use carry.';
COMMENT ON COLUMN api_key.inat_user_id IS 'Whose key it is, by the one identifier that survives a rebuild (see session.inat_user_id).';
COMMENT ON COLUMN api_key.name IS 'What the person called the key when they made it, so they can tell their keys apart: where it is used, usually.';
COMMENT ON COLUMN api_key.scope IS 'The most the key may do, chosen when it was made: read (see what its person sees), edit (also correct its person''s own samples), or staff (what its person may do as staff). A ceiling and not a grant: a staff key works as one only while its person holds a person_admin row, which is checked on every request.';
COMMENT ON COLUMN api_key.expires_at IS 'When the key stops working. At most 90 days after it was made, the longest a session lasts, so a key that leaks does not work forever.';
COMMENT ON COLUMN api_key.last_used_at IS 'The key''s last request, to within five minutes (the write is throttled, as session.last_seen_at is). NULL until it is first used.';
COMMENT ON COLUMN api_key.revoked_at IS 'When the key was revoked, by its person or because their iNaturalist account was unlinked. NULL while it works.';
