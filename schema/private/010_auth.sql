-- The private store (ADR 0003): attached at runtime as `private`, encrypted
-- as a whole in any real deployment. Applied by the app at boot when the
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
  access_token  TEXT NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT current_timestamp,
  last_login_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE inat_oauth_token IS 'iNaturalist OAuth access tokens — non-expiring credentials, the reason this store exists (ADR 0003). Stored at first sign-in, before approval, keyed by iNat user because a person row may not exist yet. Retention is minimized: purge after months of login inactivity and on membership drop (scheduled job, beeline-2c3.4).';
COMMENT ON COLUMN inat_oauth_token.login IS 'Cached at sign-in for staff to recognize pending accounts.';
COMMENT ON COLUMN inat_oauth_token.icon_url IS 'iNat profile picture URL, cached at sign-in; shown as the account-menu button. Stale until the next login (periodic re-fetch is beeline-1b7).';
