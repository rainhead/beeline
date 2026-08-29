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
  updated_since TIMESTAMPTZ,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
COMMENT ON TABLE sync_run IS 'One execution of a fetch over one source+window. Runs are transactional: an incomplete run persists nothing, so a present row with null completed_at cannot occur — the column survives for the day that invariant needs loosening.';
COMMENT ON COLUMN sync_run.source IS 'iNat project id — provenance only, never atlas assignment (that is geographic).';
COMMENT ON COLUMN sync_run.authenticated IS 'Unauthenticated runs abort unless explicitly requested (dev only) — never silently anonymous: an anonymous fetch sees no private coordinates and must not masquerade as a trusted read.';
COMMENT ON COLUMN sync_run.updated_since IS 'Non-null = an incremental run: only observations updated at/after this instant were requested. Such a run proves nothing about absence (not-updated is not gone), so deletion detection (qc_rule_observation_missing_upstream) ignores it as a covering run; presence rows it writes still count.';

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

-- Not an entity (ADR 0002): nothing anchors on a presence fact — it is pure
-- bookkeeping for deletion detection, keyed by what it witnesses.
CREATE TABLE observation_seen (
  sync_run_id INTEGER NOT NULL REFERENCES sync_run(entity_id),
  inat_id     BIGINT NOT NULL,
  PRIMARY KEY (sync_run_id, inat_id)
);
COMMENT ON TABLE observation_seen IS 'Every observation a run fetched, changed or not. Loads are hash-deduped, so a missing load row cannot distinguish unchanged from gone — deletion detection (qc_rule_observation_missing_upstream) reads presence from here instead.';

-- The shredded form of each observation's current load, stored rather than
-- derived — the one place in this schema where a *view's* output is kept.
--
-- observation_current_fields (schema/105) is the definition and stays the
-- definition; this is its materialisation, and everything downstream reads
-- this. The reason is cost: shredding 63k JSON projections takes ~200 ms,
-- almost all of it in the two correlated `$.ofvs` subqueries, and three QC
-- rules read it — so the whole qc_finding union cost ~670 ms and the
-- flagship page, both listings, printability and the record pages each paid
-- it. Reading this instead takes the union to ~205 ms (beeline-2c3.36).
--
-- Storing derived data is exactly what schema/050 forbids for findings, and
-- the exception is licensed by a property findings do not have: this table's
-- only input is observation_load, which nothing but a sync writes. A finding
-- also depends on `sample` (the in-app editor writes it and promises the
-- flags update immediately) and on `specimen` (printing), so a stored
-- finding would need invalidating from three directions; this needs it from
-- one. `refreshObservationFields` (src/refresh-observation-fields.ts) runs
-- inside the sync run's own transaction, so loads and their shredded form
-- agree at every commit boundary, and again at the head of promotion, which
-- is how a reseeded or hand-staged store gets one at all. Disagreement has a
-- name: observation_field_stale (schema/105).
--
-- Not an entity (ADR 0002): nothing anchors on a shredded field — it is the
-- load row it came from that things anchor on, and this is keyed by what it
-- describes.
CREATE TABLE observation_field (
  inat_id                    BIGINT PRIMARY KEY,
  observed_on                DATE,
  latitude                   DOUBLE,
  longitude                  DOUBLE,
  private_latitude           DOUBLE,
  private_longitude          DOUBLE,
  positional_accuracy        INTEGER,
  public_positional_accuracy INTEGER,
  geoprivacy                 TEXT,
  taxon_geoprivacy           TEXT,
  viewer_trusted             BOOLEAN,
  user_id                    BIGINT,
  user_login                 TEXT,
  place_guess                TEXT,
  host_taxon_id              BIGINT,
  host_taxon_name            TEXT,
  host_is_tracheophyte       BOOLEAN,
  quality_grade              TEXT,
  sample_number_raw          TEXT,
  specimen_count_raw         TEXT,
  -- Append only. The refresh inserts positionally and observation_field_stale
  -- compares with EXCEPT, so column ORDER here is load-bearing and must match
  -- observation_current_fields exactly (schema/105 says the same thing there).
  collection_method_raw      TEXT
);
COMMENT ON TABLE observation_field IS 'The materialisation of observation_current_fields (schema/105), which remains its definition. Refreshed whole inside the sync run that changes observation_load — its only input — and never written by anything else. Read this, not the view: the view costs ~200 ms per scan and three QC rules go through it.';
COMMENT ON COLUMN observation_field.inat_id IS 'One row per observation, so the PRIMARY KEY is the observation itself — the constraint says out loud what the "current load" definition already guarantees.';
COMMENT ON COLUMN observation_field.host_is_tracheophyte IS 'NULL when the taxon is absent or the load predates ancestor_ids in the projection — the distinction qc_rule_non_tracheophyte_host relies on, so it is carried rather than defaulted.';
COMMENT ON COLUMN observation_field.sample_number_raw IS 'The volunteer''s own sample number, from whichever of the two observation fields carries it — ''sampleId'' from 2019, ''sample id'' in 2018 (schema/105). Verbatim: values include junk (''ID 1'') and prefixed series (''dto41''), and findings judge validity.';
COMMENT ON COLUMN observation_field.collection_method_raw IS '''OBA Collection Method'': net, pan trap, vane trap, or nest block. The only controlled vocabulary the source offers for how a bee was caught, and evidence for the open protocol-vocabulary question (docs/questions.md, Trap sampling q3). DO NOT drive sample.protocol from it: an iNat-backed sample is an aerial-net sample (Peter, 2026-08-29), which the corpus bears out — 56,937 of 57,278 linked samples carry ''aerial net'' whatever this field says, its 83 non-net values disagree with the record about a third of the time (''pan trap'' here against ''aerial net'' there, 12 of 52), and an observation carries one date so it cannot evidence a trap''s range anyway.';
