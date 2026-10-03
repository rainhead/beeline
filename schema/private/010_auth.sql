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

CREATE TABLE inat_sign_in (
  inat_user_id  BIGINT PRIMARY KEY,
  login         TEXT NOT NULL,
  icon_url      TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT current_timestamp,
  last_login_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE inat_sign_in IS 'Who has signed in with iNaturalist, when, and what they look like: a sign-in record, not a credential. Until 2026-08-28 it was inat_oauth_token and held every volunteer''s non-expiring OAuth access token, which nothing ever read back — the session cookie authenticates a request, and sync authenticates as the pipeline rather than as a volunteer — so the column was dropped and the table renamed to say what it holds (beeline-cj6). Rows are written before approval, keyed by iNat user because a person row may not exist yet. Kept, with no purge (Peter, 2026-10-03): with the token gone a row is a login, a public avatar URL and two dates, and it is what /people answers "last seen" from for anyone with no recorded visit. A retention rule for everything personal would belong to the data-handling policy (beeline-bla), not to one table (beeline-zg4).';
COMMENT ON COLUMN inat_sign_in.login IS 'Cached at sign-in for staff to recognize pending accounts.';
COMMENT ON COLUMN inat_sign_in.icon_url IS 'iNat profile picture URL, cached at sign-in; shown as the account-menu button. Stale until the next login (periodic re-fetch is beeline-1b7).';
