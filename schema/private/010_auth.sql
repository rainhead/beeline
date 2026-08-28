-- The private store (ADR 0003): attached at runtime as `private`, encrypted
-- as a whole in any real deployment. It no longer holds volunteers' OAuth
-- tokens (2026-08-28) — it holds session ids, which are bearer credentials in
-- their own right, and a record of who has been here, which is nobody's
-- business but the program's.
--
-- ONE iNaturalist token is still kept, and deliberately not here: the pipeline
-- credential that authenticated sync reads use, in `data/secrets/inat-oauth-
-- token`, mode 600. It belongs to the program rather than to a volunteer —
-- Peter's registration today, Andony's in production (beeline-5ep). If a need
-- for a per-volunteer token ever appears, it wants its own decision and its
-- own retention rule, not the revival of a column nothing read. Applied by the app at boot when the
-- tables are missing (blow-away era; no migrations). No foreign keys reach
-- the main store — cross-database constraints don't exist, so references are
-- by convention.
--
-- Split per table so a table can be re-applied on its own: this store
-- outlives the blow-away era, so a change to it is patched in at boot
-- (src/app/db.ts) rather than by rebuild, and a patch that recreated a table
-- from an inline copy of this DDL would be a second copy to drift from
-- (it did: the deployed sandbox lost every COMMENT ON).

CREATE TABLE inat_oauth_token (
  inat_user_id  BIGINT PRIMARY KEY,
  login         TEXT NOT NULL,
  icon_url      TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT current_timestamp,
  last_login_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE inat_oauth_token IS 'Who has signed in with iNaturalist, when, and what they look like — no longer the token itself (Peter, 2026-08-28). It held every volunteer''s non-expiring OAuth access token, which nothing ever read back: the session cookie is what authenticates a request, and sync authenticates as the pipeline rather than as a volunteer. A credential kept for no reason is a credential leaked for no reason. The name is now wrong and is kept only until the rename lands. Rows are still written before approval, keyed by iNat user because a person row may not exist yet, and retention is still minimized (beeline-2c3.4).';
COMMENT ON COLUMN inat_oauth_token.login IS 'Cached at sign-in for staff to recognize pending accounts.';
COMMENT ON COLUMN inat_oauth_token.icon_url IS 'iNat profile picture URL, cached at sign-in; shown as the account-menu button. Stale until the next login (periodic re-fetch is beeline-1b7).';
