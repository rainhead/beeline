import type { JobOutcome } from "../../model.js";
import type { Job, Schedule } from "../jobs/framework.js";
import type { Messages } from "../messages/index.js";
import { Button, Chip, DataTable, EmptyState, Meta, PageHeader } from "./components/index.js";

export interface JobRunRow {
  job_name: string;
  started_at: Date;
  completed_at: Date | null;
  outcome: JobOutcome | null;
  detail: string | null;
  sla_breaches: number;
}

const scheduleLabel = (m: Messages, s: Schedule) =>
  s.kind === "everyMinutes"
    ? m.jobs.everyMinutes(s.minutes)
    : s.kind === "dailyLA"
      ? m.jobs.dailyLA(s.hour)
      : m.jobs.weeklyLA(m.jobs.weekdays[s.weekday] ?? String(s.weekday), s.hour);

function Outcome({ m, run }: { m: Messages; run: JobRunRow }) {
  if (run.outcome === "succeeded") return <Chip tone="success">{m.jobs.outcomeSucceeded}</Chip>;
  if (run.outcome === "failed") return <Chip tone="blocking">{m.jobs.outcomeFailed}</Chip>;
  return <Chip>{m.jobs.outcomeRunning}</Chip>;
}

export function Jobs(props: { m: Messages; jobs: Job[]; runs: JobRunRow[] }) {
  const { m } = props;
  return (
    <>
      <PageHeader title={m.jobs.heading} lede={m.jobs.intro} />

      <h2>{m.jobs.registered}</h2>
      <DataTable columns={[m.jobs.colJob, m.jobs.colSchedule, m.jobs.colWindow, ""]}>
        {props.jobs.map((job) => (
          <tr>
            <td>
              <code>{job.name}</code>
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
                  ? "—"
                  : m.jobs.durationSeconds(Math.round((run.completed_at.getTime() - run.started_at.getTime()) / 1000))}
              </td>
              <td>
                <Outcome m={m} run={run} />
              </td>
              <td>{run.sla_breaches > 0 ? run.sla_breaches : "—"}</td>
              <td>{run.detail}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}
