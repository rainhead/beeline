-- Migration for schema/012_sign_in.sql (beeline-pnqr.9): who revoked an API
-- key and why, and whether the account it was made under has since changed hands.
--
-- Of the two kinds of CHECK in ADR 0006, this is the one a deployed store
-- cannot gain: DuckDB has no ALTER TABLE ... ADD CONSTRAINT, and ADD COLUMN
-- will not take a CHECK, so `revoked_reason` is added here as plain TEXT and
-- only a fresh build restricts it to owner, staff, account_changed and
-- account_gone. `--check` does not compare constraints, so it reports a match.
-- Nothing needs a second home for the rule: the four values are written in one
-- place, `src/app/api-keys.ts`, typed in `src/model.ts`, and nothing reads the
-- column to decide whether a key works. Keys revoked before this migration keep
-- both columns NULL, which the keys list shows as a plain "Revoked <date>".

ALTER TABLE api_key ADD COLUMN revoked_by TEXT;
ALTER TABLE api_key ADD COLUMN revoked_reason TEXT;
ALTER TABLE api_key ADD COLUMN account_changed_at TIMESTAMP;
COMMENT ON COLUMN api_key.revoked_by IS 'The iNaturalist login of whoever revoked the key, as they were known then: the owner''s own login when the owner did it, the staff member''s when staff did it, or when staff changed the iNaturalist account the key was made under. NULL while the key works, for a key the nightly job revoked because its account was linked to nobody, and for a key revoked before this column existed.';
COMMENT ON COLUMN api_key.revoked_reason IS 'Why the key was revoked: owner (its person did, on /keys), staff (a staff member did, on the person''s page), account_changed (staff unlinked or changed the iNaturalist account on /people), or account_gone (the nightly job found the account linked to nobody). NULL while the key works and for a key revoked before this column existed.';
COMMENT ON COLUMN api_key.account_changed_at IS 'When the iNaturalist account this key was made under was unlinked or linked to someone else, stamped on every key of the account whether it was working, revoked or expired. From then on the key belongs to whoever held the account before, not to whoever holds it now, so it is left out of the new holder''s own list of keys and shown to staff apart from theirs. NULL for a key of an account that has stayed with the same person.';
COMMENT ON COLUMN api_key.revoked_at IS 'When the key was revoked: by its person, by a staff member, because staff unlinked or changed its iNaturalist account, or because the nightly job found that account linked to nobody (see revoked_reason). NULL while it works. A key that merely expired has no revoked_at.';
