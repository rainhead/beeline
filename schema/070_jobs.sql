-- Scheduled-job run history (ADR 0005: ingestion is in-process scheduled
-- jobs; the queue is the database, never a message broker — the legacy
-- system's non-durable queue is the anti-pattern).

CREATE TABLE job_run (
  entity_id    INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  job_name     TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  outcome      TEXT CHECK (outcome IN ('succeeded', 'failed')),
  detail       TEXT,
  sla_breaches INTEGER NOT NULL DEFAULT 0
);
COMMENT ON TABLE job_run IS 'One execution of a registered job. A null outcome with a null completed_at means the run is live — or that the process died mid-run, which is exactly what the history page should surface.';
COMMENT ON COLUMN job_run.detail IS 'Success: a human-readable summary (counts). Failure: the error message. Failing loudly is the contract; an empty success from a partial run is the legacy bug this design buries.';
COMMENT ON COLUMN job_run.sla_breaches IS 'Steps of interactive-window jobs that exceeded the ADR 0005 write-budget (1s). Night-window jobs are exempt by design. Routine breaches are the PostgreSQL tripwire.';

-- Not an entity (ADR 0002): a step is a fact about its run, keyed by the run
-- and its place in it, the way observation_seen is keyed by what it
-- witnesses. Night jobs only: an interactive step answers to the one-second
-- budget and is counted in job_run.sla_breaches instead.
--
-- job_run_id names its run without a foreign key, on purpose: DuckDB will not
-- alter a table another table's foreign key references, so the key would
-- freeze job_run against every later migration (test/migrate.test.ts drops
-- one of its columns). Only runJob writes steps, always for the run it has
-- just inserted, and nothing deletes runs.
CREATE TABLE job_step (
  job_run_id   INTEGER NOT NULL,
  step_number  INTEGER NOT NULL,
  label        TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL,
  duration_ms  INTEGER NOT NULL,
  cpu_ms       INTEGER NOT NULL,
  stolen_ms    INTEGER,
  failed       BOOLEAN NOT NULL,
  rss_mb       INTEGER NOT NULL,
  peak_mb      INTEGER,
  duckdb_mb    INTEGER,
  duckdb_spilled_mb INTEGER,
  heap_mb      INTEGER NOT NULL,
  PRIMARY KEY (job_run_id, step_number)
);
COMMENT ON TABLE job_step IS 'One step of a night job''s run, with what it cost (beeline-e1xg). The console has the same figures for a few days; this keeps them for years, so the growth of the nightly work with the corpus can be seen and acted on before a night fails.';
COMMENT ON COLUMN job_step.step_number IS 'Order the steps started in within the run, from 1.';
COMMENT ON COLUMN job_step.stolen_ms IS 'CPU time the host gave to other machines during the step (/proc/stat). Null where that cannot be read, as on a Mac.';
COMMENT ON COLUMN job_step.failed IS 'True when the step threw: the run''s detail says why.';
COMMENT ON COLUMN job_step.rss_mb IS 'The process''s resident memory when the step ended.';
COMMENT ON COLUMN job_step.peak_mb IS 'The most resident memory the process held during this step, read from Linux''s high-water mark after resetting it at the step''s start. Null where the platform cannot reset it (anywhere but Linux), since the only other figure, the peak since the process started, never falls and so says nothing about one step.';
COMMENT ON COLUMN job_step.duckdb_mb IS 'Memory DuckDB''s own accounting held when the step ended: what memory_limit caps. Not all DuckDB''s memory, since what its JSON functions allocate is uncounted (beeline-dmoi). Null when it could not be read.';
COMMENT ON COLUMN job_step.duckdb_spilled_mb IS 'What DuckDB had written to its temporary files when the step ended. Null when it could not be read.';
COMMENT ON COLUMN job_step.heap_mb IS 'Node''s own heap when the step ended: the app''s JavaScript objects, nothing native.';
