-- Observation history (restored from the sketch now that phase 3 builds it).
-- Append-only; the pipeline is a pure transform over these rows — that's
-- what makes it re-runnable. Both are entities (ADR 0002): findings and
-- corrections about staged observations anchor on load rows.

CREATE TABLE sync_run (
  entity_id     INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  source        TEXT NOT NULL,
  authenticated BOOLEAN NOT NULL,
  window_start  DATE,
  window_end    DATE,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
COMMENT ON TABLE sync_run IS 'One execution of a fetch over one source+window. Runs are transactional: an incomplete run persists nothing, so a present row with null completed_at cannot occur — the column survives for the day that invariant needs loosening.';
COMMENT ON COLUMN sync_run.source IS 'iNat project id — provenance only, never atlas assignment (that is geographic).';
COMMENT ON COLUMN sync_run.authenticated IS 'Unauthenticated runs abort unless explicitly requested (dev only) — never silently anonymous: an anonymous fetch sees no private coordinates and must not masquerade as a trusted read.';

CREATE TABLE observation_load (
  entity_id    INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  inat_id      BIGINT NOT NULL,
  sync_run_id  INTEGER NOT NULL REFERENCES sync_run(entity_id),
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  content      JSON NOT NULL,
  content_hash TEXT NOT NULL
);
COMMENT ON TABLE observation_load IS 'Append-only: a new row only when the whitelisted projection''s hash changes. The projection is the v2 fields parameter itself — the API returns only what we whitelist.';
COMMENT ON COLUMN observation_load.content_hash IS 'sha256 of the canonical (recursively key-sorted) JSON projection.';
