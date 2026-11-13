-- Migration for schema/012_sign_in.sql (beeline-pnqr.6): which key made each change through the API.

CREATE TABLE api_key_use (
  used_at    TIMESTAMP NOT NULL DEFAULT current_timestamp,
  key_sha256 TEXT NOT NULL CHECK (length(key_sha256) = 64),
  method     TEXT NOT NULL,
  route      TEXT NOT NULL,
  subject    TEXT,
  outcome    TEXT,
  reference  TEXT,
  status     INTEGER NOT NULL
);
COMMENT ON TABLE api_key_use IS 'One row for each request under /api/v1/ that is not a GET or a HEAD, written after the request was answered (beeline-pnqr.6): the way to trace a change to the key that made it. A read leaves no row, since reads change nothing, and the key''s last use is on api_key. A row is written whatever the answer was, so a refused request is traced too. Not referenced from api_key, because a table that another table references cannot have its rows updated in DuckDB, and api_key''s last_used_at is updated on use. Kept for good, with no purge, as the sign-in records are: it is the trace from a change to the key that made it, and it holds one small row for each write request by a handful of key holders. Carried across a reseed with api_key, with the sample ids taken out of it (see subject).';
COMMENT ON COLUMN api_key_use.used_at IS 'When the request was answered.';
COMMENT ON COLUMN api_key_use.key_sha256 IS 'The key that made the request, by api_key.key_sha256: the full hash and never the key.';
COMMENT ON COLUMN api_key_use.method IS 'The HTTP method: POST, PUT, PATCH or DELETE.';
COMMENT ON COLUMN api_key_use.route IS 'The route pattern that answered, such as /api/v1/samples/:id/edit, and never the path, so what a record is called appears only in subject. A request that no route answered is recorded with the catch-all''s pattern, /api/v1/*, and one that a check ahead of the routes refused with that check''s, such as /api/v1/samples/*.';
COMMENT ON COLUMN api_key_use.subject IS 'What the request was about, where the route names one: the sample''s id for a route under /samples/:id, the job''s name for /jobs/:name. NULL otherwise. A reseed redraws sample ids, so a reseed carries these rows with the subject of a sample route set to NULL, since the number would name a different sample afterwards; job names are kept.';
COMMENT ON COLUMN api_key_use.outcome IS 'What the handler answered, in its own words: saved, removed, unchanged or would_save for a correction, the name of a refusal (not_found, printed, busy and so on), invalid_request, recorded_not_applied for a correction that was written to its file but lost a write conflict applying it to the store, or started for a job. NULL where no handler said, such as a request refused before it reached one. It tells a dry run, a save and a request that changed nothing apart, which status alone does not.';
COMMENT ON COLUMN api_key_use.reference IS 'A pointer to the request behind the change, given by the caller: the id of the message that asked for it, or a link to the issue. Never an address or a name, since comments and exports of this store are public. NULL when the caller gave none. It is kept here and nowhere else: not in the overlay files, not on a page, and not in the change''s history reason, which stays what it was. The trace runs from the history entry (who, when, through the API) to the row here for the same key, sample and moment.';
COMMENT ON COLUMN api_key_use.status IS 'The HTTP status the request was answered with.';
