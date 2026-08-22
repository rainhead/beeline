import type { JobOutcome } from "../../model.js";
import type { Job, Schedule } from "../jobs/framework.js";
import type { Messages } from "../messages/index.js";

export interface JobRunRow {
  job_name: string;
  started_at: Date;
  completed_at: Date | null;
  outcome: JobOutcome | null;
  detail: string | null;
  sla_breaches: number;
}

const scheduleLabel = (m: Messages, s: Schedule) =>
  s.kind === "everyMinutes" ? m.jobs.everyMinutes(s.minutes) : m.jobs.dailyLA(s.hour);

function Outcome({ m, run }: { m: Messages; run: JobRunRow }) {
  if (run.outcome === "succeeded") return <span class="chip">{m.jobs.outcomeSucceeded}</span>;
  if (run.outcome === "failed") return <span class="chip error">{m.jobs.outcomeFailed}</span>;
  return <span class="chip">{m.jobs.outcomeRunning}</span>;
}

export function Jobs(props: { m: Messages; jobs: Job[]; runs: JobRunRow[] }) {
  const { m } = props;
  return (
    <>
      <h1>{m.jobs.heading}</h1>
      <p>{m.jobs.intro}</p>

      <h2>{m.jobs.registered}</h2>
      <table>
        <thead>
          <tr>
            <th>{m.jobs.colJob}</th>
            <th>{m.jobs.colSchedule}</th>
            <th>{m.jobs.colWindow}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {props.jobs.map((job) => (
            <tr>
              <td>
                <code>{job.name}</code>
              </td>
              <td>{scheduleLabel(m, job.schedule)}</td>
              <td>{job.window === "night" ? m.jobs.windowNight : m.jobs.windowInteractive}</td>
              <td>
                <form method="post" action={`/jobs/run/${job.name}`} style="margin: 0">
                  <button class="tonal">{m.jobs.runNow}</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{m.jobs.recentRuns}</h2>
      {props.runs.length === 0 ? (
        <p>{m.jobs.noRuns}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{m.jobs.colJob}</th>
              <th>{m.jobs.colStarted}</th>
              <th>{m.jobs.colDuration}</th>
              <th>{m.jobs.colOutcome}</th>
              <th>{m.jobs.colBreaches}</th>
              <th>{m.jobs.colDetail}</th>
            </tr>
          </thead>
          <tbody>
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
          </tbody>
        </table>
      )}
    </>
  );
}
