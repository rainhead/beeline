-- Migration for schema/070_jobs.sql (beeline-222u): a step that is allowed to
-- fail without failing its run is now recorded as failed, so the column's
-- comment says a succeeded run can hold a failed step.

COMMENT ON COLUMN job_step.failed IS 'True when the step threw, which fails the run, or when it is a step that is allowed to fail without failing the run and said it did (beeline-222u): the run''s detail says why either way. So a run with outcome succeeded can hold a failed step, and /jobs and the menu say so.';
