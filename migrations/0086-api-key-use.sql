-- Migration for schema/012_sign_in.sql (beeline-pnqr.6): which key made each change through the API.

CREATE TABLE api_key_use (
  used_at    TIMESTAMP NOT NULL DEFAULT current_timestamp,
  key_sha256 TEXT NOT NULL CHECK (length(key_sha256) = 64),
  method     TEXT NOT NULL,
  route      TEXT NOT NULL,
  subject    TEXT,
  status     INTEGER NOT NULL
);
COMMENT ON TABLE api_key_use IS 'One row for each request under /api/v1/ that is not a GET or a HEAD, written after the request was answered (beeline-pnqr.6): the way to trace a change to the key that made it. A read leaves no row, since reads change nothing, and the key''s last use is on api_key. A row is written whatever the answer was, so a refused request is traced too. Not referenced from api_key, because a table that another table references cannot have its rows updated in DuckDB, and api_key''s last_used_at is updated on use. Carried across a reseed with api_key.';
COMMENT ON COLUMN api_key_use.used_at IS 'When the request was answered.';
COMMENT ON COLUMN api_key_use.key_sha256 IS 'The key that made the request, by api_key.key_sha256: the full hash and never the key.';
COMMENT ON COLUMN api_key_use.method IS 'The HTTP method: POST, PUT, PATCH or DELETE.';
COMMENT ON COLUMN api_key_use.route IS 'The route pattern that answered, such as /api/v1/samples/:id/edit, and never the path, so what a record is called appears only in subject. A request no route answered is recorded with the pattern of the catch-all.';
COMMENT ON COLUMN api_key_use.subject IS 'What the request was about, where the route names one: the sample''s id for a route under /samples/:id, the job''s name for /jobs/:name. NULL otherwise.';
COMMENT ON COLUMN api_key_use.status IS 'The HTTP status the request was answered with.';
