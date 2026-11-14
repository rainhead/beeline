import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { jobHealth, type Job, type JobProblem, type LastOutcome } from "./jobs/framework.js";

/**
 * What is wrong with the jobs, for /jobs and for the alert beside "Jobs" in
 * the menu (beeline-222u).
 *
 * Two kinds of wrong. The first is `jobHealth`'s: the job's last run failed,
 * or it has not succeeded for longer than its schedule explains, or it has
 * never run. The second is a run that succeeded with a step in it that
 * failed: several of the nightly's steps are allowed to fail without failing
 * the run (src/app/jobs/registry.ts, `tolerantStep`), and until this such a
 * failure showed only in the middle of the run's detail. Finding areas failed
 * that way for four nights before anyone saw it (beeline-6cur).
 *
 * /healthz/jobs reports the first kind only, as before: it is polled from
 * outside, and a step that is allowed to fail is one whose failure the night
 * goes on from, so it is said to the staff who open the app and not to
 * whoever the outside check mails.
 */
export interface JobTrouble {
  name: string;
  /** `step-failed`: the last finished run succeeded, and these steps of it failed. */
  kind: JobProblem | "step-failed";
  /** When the run in question started; null for a job that has never run. */
  startedAt: Date | null;
  lastSucceeded: Date | null;
  /** That run's detail: the error when it failed, the summary otherwise. */
  detail: string | null;
  /** Labels of the steps that failed in that run, in the order they ran. */
  failedSteps: string[];
}

interface LatestRun extends LastOutcome {
  /** The most recent run that has finished, whose steps are the ones read. */
  finishedRunId: number | null;
  finishedStarted: Date | null;
  finishedDetail: string | null;
  finishedOutcome: LastOutcome["outcome"];
}

/**
 * Each job's latest run and latest success, one row per job rather than the
 * whole history: this is asked on admins' page loads as well as by the
 * health check.
 */
export async function latestRuns(db: Kysely<Database>): Promise<Map<string, LatestRun>> {
  const { rows } = await sql<{
    job_name: string;
    started: Date;
    succeeded: Date | null;
    outcome: LastOutcome["outcome"];
    detail: string | null;
    finished_run_id: number | null;
    finished_started: Date | null;
    finished_detail: string | null;
    finished_outcome: LastOutcome["outcome"];
  }>`
    -- arg_max_null, not arg_max, for what may be null: arg_max skips a row
    -- whose value is null, and would pair an older run's error with a newer
    -- run that left no detail, or call a job failing while it runs again.
    SELECT job_name,
           max(started_at) AS started,
           max(started_at) FILTER (WHERE outcome = 'succeeded') AS succeeded,
           arg_max_null(outcome, started_at) AS outcome,
           arg_max_null(detail, started_at) AS detail,
           arg_max(entity_id, started_at) FILTER (WHERE completed_at IS NOT NULL) AS finished_run_id,
           max(started_at) FILTER (WHERE completed_at IS NOT NULL) AS finished_started,
           arg_max_null(detail, started_at) FILTER (WHERE completed_at IS NOT NULL) AS finished_detail,
           arg_max_null(outcome, started_at) FILTER (WHERE completed_at IS NOT NULL) AS finished_outcome
    FROM job_run
    GROUP BY job_name`.execute(db);
  const date = (value: Date | null) => (value === null ? null : new Date(value));
  return new Map(
    rows.map((r) => [
      r.job_name,
      {
        started: new Date(r.started),
        succeeded: date(r.succeeded),
        outcome: r.outcome,
        detail: r.detail,
        finishedRunId: r.finished_run_id === null ? null : Number(r.finished_run_id),
        finishedStarted: date(r.finished_started),
        finishedDetail: r.finished_detail,
        finishedOutcome: r.finished_outcome,
      },
    ]),
  );
}

/** The labels of the steps that failed in each of these runs, in the order they ran. */
export async function failedStepsOf(db: Kysely<Database>, runIds: number[]): Promise<Map<number, string[]>> {
  const found = new Map<number, string[]>();
  if (runIds.length === 0) return found;
  const rows = await db
    .selectFrom("job_step")
    .select(["job_run_id", "label"])
    .where("failed", "=", true)
    .where("job_run_id", "in", runIds)
    .orderBy("step_number")
    .execute();
  for (const row of rows) {
    const id = Number(row.job_run_id);
    found.set(id, [...(found.get(id) ?? []), row.label]);
  }
  return found;
}

/** Every registered job with something wrong, in the registry's order. */
export async function jobTroubles(db: Kysely<Database>, jobs: Job[], now: Date): Promise<JobTrouble[]> {
  if (jobs.length === 0) return [];
  const latest = await latestRuns(db);
  const failed = await failedStepsOf(
    db,
    [...latest.values()].flatMap((r) => (r.finishedRunId === null ? [] : [r.finishedRunId])),
  );
  const stepsOf = (runId: number | null) => (runId === null ? [] : (failed.get(runId) ?? []));
  return jobHealth(jobs, latest, now).flatMap((health): JobTrouble[] => {
    const seen = latest.get(health.name);
    const failedSteps = stepsOf(seen?.finishedRunId ?? null);
    if (health.problem !== null) {
      return [
        {
          name: health.name,
          kind: health.problem,
          startedAt: seen?.started ?? null,
          lastSucceeded: health.lastSucceeded,
          detail: health.detail,
          // The steps of a failed run say where it failed; an overdue or
          // never-run job has no run worth quoting steps from.
          failedSteps: health.problem === "failing" && seen?.outcome === "failed" ? failedSteps : [],
        },
      ];
    }
    // Only of a run that succeeded. While a job runs again after a failed
    // run, the health check finds nothing wrong, and that run's failed step
    // is not a step that was allowed to fail (CodeRabbit).
    if (failedSteps.length === 0 || seen?.finishedOutcome !== "succeeded") return [];
    return [
      {
        name: health.name,
        kind: "step-failed",
        startedAt: seen?.finishedStarted ?? null,
        lastSucceeded: health.lastSucceeded,
        detail: seen?.finishedDetail ?? null,
        failedSteps,
      },
    ];
  });
}
