-- The private store (ADR 0003): attached at runtime as `private`, encrypted
-- as a whole in any real deployment. Applied by the app at boot when the
-- tables are missing (blow-away era; no migrations). No foreign keys reach
-- the main store — cross-database constraints don't exist, so person_id
-- references are by convention.

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

CREATE TABLE session (
  id           TEXT PRIMARY KEY,
  person_id    INTEGER NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT current_timestamp,
  last_seen_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE session IS 'Web sessions: the id is the bearer credential in the cookie, so the rows live here with the other credentials. Sliding 30-day expiry enforced at lookup; only approved people (an inat_account row) ever get one.';
COMMENT ON COLUMN session.person_id IS 'person.entity_id in the main store (no FK across databases).';
