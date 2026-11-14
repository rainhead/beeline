import type { JobOutcome } from "../../model.js";
import type { StepTrendRow } from "../job-steps.js";
import type { JobTrouble } from "../job-trouble.js";
import type { Job, Schedule } from "../jobs/framework.js";
import type { Messages } from "../messages/index.js";
import { Absent, Button, Callout, Chip, DataTable, EmptyState, Meta, OrAbsent, PageHeader } from "./components/index.js";
import { AlertIcon } from "./icons.js";

export interface JobRunRow {
  job_name: string;
  started_at: Date;
  completed_at: Date | null;
  outcome: JobOutcome | null;
  detail: string | null;
  sla_breaches: number;
  /** Labels of the steps of this run that failed, in the order they ran. */
  failed_steps: string[];
}

const scheduleLabel = (m: Messages, s: Schedule) =>
  s.kind === "everyMinutes"
    ? m.jobs.everyMinutes(s.minutes)
    : s.kind === "dailyLA"
      ? m.jobs.dailyLA(s.hour)
      : m.jobs.weeklyLA(m.jobs.weekdays[s.weekday] ?? String(s.weekday), s.hour);

function Outcome({ m, run }: { m: Messages; run: JobRunRow }) {
  // A run that finished with a failed step in it did not simply succeed
  // (beeline-222u): some steps are allowed to fail without failing the run.
  if (run.outcome === "succeeded" && run.failed_steps.length > 0) {
    // Named under the chip, so an old run still says which once a later
    // night has worked and the list at the top of the page is gone.
    return (
      <>
        <Chip tone="blocking">{m.jobs.outcomeStepFailed(run.failed_steps.length)}</Chip>
        <Meta block>{run.failed_steps.join(", ")}</Meta>
      </>
    );
  }
  if (run.outcome === "succeeded") return <Chip tone="success">{m.jobs.outcomeSucceeded}</Chip>;
  if (run.outcome === "failed") {
    return (
      <>
        <Chip tone="blocking">{m.jobs.outcomeFailed}</Chip>
        {run.failed_steps.length > 0 ? <Meta block>{run.failed_steps.join(", ")}</Meta> : null}
      </>
    );
  }
  return <Chip>{m.jobs.outcomeRunning}</Chip>;
}

/** One sentence saying what is wrong with a job. */
function troubleSentence(m: Messages, t: JobTrouble): string {
  const when = t.startedAt === null ? null : m.format.dateTime(t.startedAt);
  // Joined here, not in the catalog: a message only interpolates what it is given.
  const steps = t.failedSteps.join(", ");
  switch (t.kind) {
    case "failing":
      return m.jobs.trouble.failing(when, steps === "" ? null : steps);
    case "step-failed":
      return m.jobs.trouble.stepFailed(when, steps);
    case "overdue":
      return m.jobs.trouble.overdue(t.lastSucceeded === null ? null : m.format.dateTime(t.lastSucceeded));
    case "never-run":
      return m.jobs.trouble.neverRun;
  }
}

/**
 * What is wrong, first on the page and in so many words (beeline-222u): the
 * tables below held it already, but a failed step sat in the middle of a
 * detail on a run marked succeeded, and nobody read it for four nights.
 */
function Troubles({ m, troubles }: { m: Messages; troubles: JobTrouble[] }) {
  if (troubles.length === 0) return null;
  return (
    <section class="job-troubles" aria-labelledby="job-troubles-heading">
      <Callout tone="blocking">
        <h2 id="job-troubles-heading">
          <AlertIcon /> {m.jobs.trouble.heading(troubles.length)}
        </h2>
        <ul>
          {troubles.map((t) => (
            <li>
              <p>
                <code>{t.name}</code> {troubleSentence(m, t)}
              </p>
              {t.detail !== null && t.kind !== "overdue" ? <p class="job-trouble-detail">{t.detail}</p> : null}
            </li>
          ))}
        </ul>
      </Callout>
    </section>
  );
}

export function Jobs(props: { m: Messages; jobs: Job[]; runs: JobRunRow[]; steps: StepTrendRow[]; troubles: JobTrouble[] }) {
  const { m } = props;
  const troubled = new Map(props.troubles.map((t) => [t.name, t]));
  return (
    <>
      <PageHeader title={m.jobs.heading} lede={m.jobs.intro} />
      <Troubles m={m} troubles={props.troubles} />

      <h2>{m.jobs.registered}</h2>
      <DataTable columns={[m.jobs.colJob, m.jobs.colSchedule, m.jobs.colWindow, ""]}>
        {props.jobs.map((job) => (
          <tr>
            <td>
              <code>{job.name}</code>
              {troubled.has(job.name) ? (
                <>
                  {" "}
                  <Chip tone="blocking">{m.jobs.trouble.chip[troubled.get(job.name)!.kind]}</Chip>
                </>
              ) : null}
              <Meta block>{m.jobs.descriptions[job.name]}</Meta>
            </td>
            <td>{scheduleLabel(m, job.schedule)}</td>
            <td>{job.window === "night" ? m.jobs.windowNight : m.jobs.windowInteractive}</td>
            <td>
              <form method="post" action={`/jobs/run/${job.name}`}>
                <Button variant="tonal">{m.jobs.runNow}</Button>
              </form>
            </td>
          </tr>
        ))}
      </DataTable>

      <h2>{m.jobs.recentRuns}</h2>
      {props.runs.length === 0 ? (
        <EmptyState>{m.jobs.noRuns}</EmptyState>
      ) : (
        <DataTable
          columns={[
            m.jobs.colJob,
            m.jobs.colStarted,
            m.jobs.colDuration,
            m.jobs.colOutcome,
            m.jobs.colBreaches,
            m.jobs.colDetail,
          ]}
        >
          {props.runs.map((run) => (
            <tr>
              <td>
                <code>{run.job_name}</code>
              </td>
              <td>{m.format.dateTime(run.started_at)}</td>
              <td>
                {run.completed_at === null
                  ? <Absent label={m.jobs.stillRunning} spelled />
                  : m.jobs.durationSeconds(Math.round((run.completed_at.getTime() - run.started_at.getTime()) / 1000))}
              </td>
              <td>
                <Outcome m={m} run={run} />
              </td>
              {/* Almost every run breaches nothing, so a dash rather than a column of noughts. */}
              <td>{run.sla_breaches > 0 ? run.sla_breaches : <Absent label={m.absence.none} />}</td>
              <td>
                <OrAbsent value={run.detail} label={m.absence.none} />
              </td>
            </tr>
          ))}
        </DataTable>
      )}

      <h2>{m.jobs.steps}</h2>
      <p>{m.jobs.stepsIntro}</p>
      {props.steps.length === 0 ? (
        <EmptyState>{m.jobs.noSteps}</EmptyState>
      ) : (
        byJob(props.steps).map(([jobName, steps]) => (
          <>
            <h3>
              <code>{jobName}</code>
            </h3>
            <DataTable
              columns={[
                m.jobs.colStep,
                m.jobs.colLastRun,
                m.jobs.colTook,
                m.jobs.colMemory,
                m.jobs.colDuckDb,
                m.jobs.colQuarterAgo,
                m.jobs.colMonthAgo,
                m.jobs.colThisWeek,
              ]}
            >
              {steps.map((step) => (
                <tr>
                  <td>
                    {step.label}
                    {step.last_failed ? (
                      <>
                        {" "}
                        <Chip tone="blocking">{m.jobs.stepFailed}</Chip>
                      </>
                    ) : null}
                  </td>
                  <td>{m.format.dateTime(step.last_started_at)}</td>
                  <td>{m.jobs.duration(step.last_duration_ms)}</td>
                  <td>
                    <Megabytes m={m} value={step.last_peak_mb} />
                  </td>
                  <td>
                    <Megabytes m={m} value={step.last_duckdb_mb} />
                  </td>
                  <td>
                    <Megabytes m={m} value={step.peak_quarter_ago_mb} />
                  </td>
                  <td>
                    <Megabytes m={m} value={step.peak_month_ago_mb} />
                  </td>
                  <td>
                    <Megabytes m={m} value={step.peak_week_mb} />
                  </td>
                </tr>
              ))}
            </DataTable>
          </>
        ))
      )}
    </>
  );
}

/** The steps grouped by job, in the order stepTrend returns them. */
function byJob(steps: StepTrendRow[]): [string, StepTrendRow[]][] {
  const groups = new Map<string, StepTrendRow[]>();
  for (const step of steps) groups.set(step.job_name, [...(groups.get(step.job_name) ?? []), step]);
  return [...groups];
}

/** A peak is unknown wherever the store was written off Linux; a dash says so rather than a zero. */
function Megabytes({ m, value }: { m: Messages; value: number | null }) {
  return value === null ? <Absent label={m.absence.notRecorded} /> : <>{m.jobs.megabytes(value)}</>;
}
