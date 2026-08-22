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
