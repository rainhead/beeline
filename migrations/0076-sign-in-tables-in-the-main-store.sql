-- Migration for schema/012_sign_in.sql: the private store's four tables move
-- into the main store (beeline-4tdh), with a session kept as the SHA-256 of
-- its cookie rather than the cookie itself (beeline-5l84). The tables are
-- created empty here; the app fills them from the deployed private store at
-- its first boot afterwards (absorbPrivateStore, src/app/db.ts), because only
-- the app holds that store's key and migrations are plain SQL run before it
-- starts (ADR 0006).

CREATE TABLE inat_sign_in (
  inat_user_id  BIGINT PRIMARY KEY,
  login         TEXT NOT NULL,
  icon_url      TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT current_timestamp,
  last_login_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE inat_sign_in IS 'Who has signed in with iNaturalist, when, and what they look like: a sign-in record, not a credential. Until 2026-08-28 it was inat_oauth_token and held every volunteer''s non-expiring OAuth access token, which nothing ever read back — the session cookie authenticates a request, and sync authenticates as the pipeline rather than as a volunteer — so the column was dropped and the table renamed to say what it holds (beeline-cj6). Rows are written before approval, keyed by iNat user because a person row may not exist yet, which is what lists the people turned away at sign-in. Kept, with no purge (Peter, 2026-10-03): a row is a login, a public avatar URL and two dates, and it is what /people answers "last seen" from for anyone with no recorded visit. A retention rule for everything personal would belong to the data-handling policy (beeline-bla), not to one table (beeline-zg4).';
COMMENT ON COLUMN inat_sign_in.login IS 'Cached at sign-in for staff to recognize pending accounts.';
COMMENT ON COLUMN inat_sign_in.icon_url IS 'iNat profile picture URL, cached at sign-in; shown as the account-menu button. Stale until the next login (periodic re-fetch is beeline-1b7).';

CREATE TABLE session (
  id_sha256    TEXT PRIMARY KEY CHECK (length(id_sha256) = 64),
  inat_user_id BIGINT NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT current_timestamp,
  last_seen_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE session IS 'Web sessions. A session ends 30 days after its last request, and 90 days after it began however often it is used (beeline-jpau), both enforced at lookup; only approved people (an inat_account row) ever get one.';
COMMENT ON COLUMN session.id_sha256 IS 'The SHA-256, in lowercase hex, of the random value the browser holds in its session cookie, never that value itself (beeline-5l84). The cookie is the credential: anyone holding it is signed in as its owner. Kept as a hash, a copy of this table, from a backup or anywhere else, signs nobody in. The cookie carries 256 random bits, so a plain SHA-256 is enough and no slow password hash is needed. Its first 12 hex digits are the session reference that feedback emails and logs carry (sessionRef).';
COMMENT ON COLUMN session.inat_user_id IS 'Who signed in, by the one identifier that survives a rebuild. It used to be person.entity_id, and a db:reseed redraws those — so every session resolved to whoever inherited its number, and a volunteer browsed as somebody else under a mine scope forced for them (beeline-ten). The person is resolved through inat_account at request time instead, which also means unbinding an account ends its sessions and rebinding moves them, both of which are what those words should do.';
COMMENT ON COLUMN session.created_at IS 'When the person signed in. The 90-day limit on a session is counted from here, so a stolen cookie stops working even if it keeps being used.';
COMMENT ON COLUMN session.last_seen_at IS 'The session''s last request, to within five minutes (the slide is throttled, beeline-cla). The 30-day idle limit is counted from here.';

CREATE TABLE person_activity (
  inat_user_id BIGINT PRIMARY KEY,
  last_seen_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE person_activity IS 'When each signed-in person was last here, one row per iNaturalist user. Written on the request path but throttled to an hour, since the only question asked of it — is this volunteer still turning up? — is not answered better by a finer figure. Kept apart from session so that ending sessions cannot age it (beeline-dji).';
COMMENT ON COLUMN person_activity.inat_user_id IS 'Who was here, by the one identifier that survives a rebuild. Never person.entity_id: a db:reseed redraws those, which is how sessions came to resolve to whoever inherited the number (beeline-ten).';
COMMENT ON COLUMN person_activity.last_seen_at IS 'The last request this person made, to the hour. Kept, like the sign-in record beside it, with no purge (beeline-zg4): a date per person is what the roster needs to ask whether a volunteer is still turning up, and nothing about it is a credential.';

CREATE TABLE impersonation (
  admin_login  TEXT NOT NULL,
  person_name  TEXT NOT NULL,
  started_at   TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE impersonation IS 'One row per time a staff member switched into viewing Beeline as somebody else (beeline-jjt). Append-only; nothing reads it yet beyond a hand query, and nothing purges it.';
COMMENT ON COLUMN impersonation.admin_login IS 'The staff member''s iNaturalist login at the time — the same attribution the corrections overlay and the change logs use for an author. A login can be renamed upstream, so this is a name rather than a key, which is what an audit line wants: who, as they were known then.';
COMMENT ON COLUMN impersonation.person_name IS 'Whose view was taken, by display name — the way the switch cookie and the overlay name a person, and never person.entity_id, which a rebuild redraws (beeline-ten).';
COMMENT ON COLUMN impersonation.started_at IS 'When the switch was turned on. There is no ended_at: the switch ends when the cookie is cleared or the session ends, and neither reliably passes through a route that could record it.';
