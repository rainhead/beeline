-- When somebody was last here, kept where no change to their credentials can
-- take it away. Re-appliable on its own, like the tables beside it.
--
-- This exists because the roster's "Last seen" column used to read the session
-- row, and sessions are destroyed for good reasons that have nothing to do
-- with activity: an expiry purge, an account rebind, and — twice on
-- 2026-08-27 — a rekey that dropped the table rather than translate rows keyed
-- on an id that had become untrustworthy (beeline-ten). Every one of those was
-- right for auth, and each silently aged the column, in the safe-looking
-- direction of an older date (beeline-dji). Activity is a fact about a person,
-- not about a credential, so it is recorded where a credential's lifecycle
-- cannot reach it.

CREATE TABLE person_activity (
  inat_user_id BIGINT PRIMARY KEY,
  last_seen_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE person_activity IS 'When each signed-in person was last here, one row per iNaturalist user. Written on the request path but throttled to an hour, since the only question asked of it — is this volunteer still turning up? — is not answered better by a finer figure. Not a credential; it lives in the private store because it is about a person rather than about a record, the same reason inat_oauth_token.last_login_at does.';
COMMENT ON COLUMN person_activity.inat_user_id IS 'Who was here, by the one identifier that survives a rebuild. Never person.entity_id: a db:reseed redraws those, which is how sessions came to resolve to whoever inherited the number (beeline-ten). The row outliving both the session and the main store is the whole point, so it cannot be keyed on something either of them redraws.';
COMMENT ON COLUMN person_activity.last_seen_at IS 'The last request this person made, to the hour. Belongs with the OAuth token for retention: whenever a token is dropped for login inactivity this row goes with it, since an account no longer stored is not one whose comings and goings are worth keeping. No job does that to either of them yet (beeline-zg4) — only sessions are purged today.';
