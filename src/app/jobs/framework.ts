import type { DuckDBConnection } from "@duckdb/node-api";
import { sql, type Kysely } from "kysely";
import type { Database } from "../../model.js";

/**
 * The in-process job framework (ADR 0005). Jobs run inside the one process
 * that owns the database, one at a time; run history lives in job_run.
 * Interactive-window jobs chunk their work into step() calls that are timed
 * against the 1-second write budget; night-window jobs (00:00–05:00
 * America/Los_Angeles) are exempt and may run long.
 */

export type JobWindow = "interactive" | "night";

export type Schedule =
  | { kind: "everyMinutes"; minutes: number }
  | /** Once per LA calendar day, at or after this hour (schedule night jobs ≥ 0 and < 5). */
    { kind: "dailyLA"; hour: number }
  | /** Once per week: on this LA weekday (0 = Sunday), at or after this hour. */
    { kind: "weeklyLA"; weekday: number; hour: number };

export interface JobContext {
  db: Kysely<Database>;
  conn: DuckDBConnection;
  log(message: string): void;
  /** Run one chunk of work; timed against the SLA budget for interactive jobs. */
  step<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

export interface Job {
  name: string;
  schedule: Schedule;
  window: JobWindow;
  /** The returned string becomes job_run.detail — say what happened, with counts. */
  run(ctx: JobContext): Promise<string | void>;
}

const LA = "America/Los_Angeles";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Calendar date, hour, and weekday (0 = Sunday) of an instant, in the night-window's timezone. */
export function laParts(instant: Date): { date: string; hour: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: LA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value])) as Record<string, string>;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    weekday: WEEKDAYS.indexOf(parts.weekday!),
  };
}

/** End of the night carve-out: night jobs must not START at or after this LA hour (beeline-7tt). */
const NIGHT_END_HOUR = 5;
/** Pause between retries of a failed daily/weekly run — not every tick (beeline-40m). */
const RETRY_MS = 15 * 60_000;

export interface LastRuns {
  /** Most recent start, any outcome (orphans are reconciled to failed at boot). */
  started: Date | null;
  /** Most recent start that ran to success. */
  succeeded: Date | null;
}

/** Done for the LA day only once SUCCEEDED that day; a failed attempt retries after a pause. */
function dueToday(now: Date, todayLA: string, last: LastRuns): boolean {
  if (last.succeeded !== null && laParts(last.succeeded).date === todayLA) return false;
  if (last.started !== null && laParts(last.started).date === todayLA) {
    return now.getTime() - last.started.getTime() >= RETRY_MS;
  }
  return true;
}

export function isDue(schedule: Schedule, window: JobWindow, now: Date, last: LastRuns): boolean {
  switch (schedule.kind) {
    case "everyMinutes":
      return last.started === null || now.getTime() - last.started.getTime() >= schedule.minutes * 60_000;
    case "dailyLA": {
      const nowLA = laParts(now);
      if (nowLA.hour < schedule.hour) return false;
      if (window === "night" && nowLA.hour >= NIGHT_END_HOUR) return false;
      return dueToday(now, nowLA.date, last);
    }
    case "weeklyLA": {
      const nowLA = laParts(now);
      if (nowLA.weekday !== schedule.weekday || nowLA.hour < schedule.hour) return false;
      if (window === "night" && nowLA.hour >= NIGHT_END_HOUR) return false;
      return dueToday(now, nowLA.date, last);
    }
  }
}

/**
 * How often a schedule expects to succeed. Used only to judge staleness, never
 * to decide a run — isDue above is the authority on that.
 */
export function expectedPeriodMs(schedule: Schedule): number {
  switch (schedule.kind) {
    case "everyMinutes":
      return schedule.minutes * 60_000;
    case "dailyLA":
      return 24 * 60 * 60_000;
    case "weeklyLA":
      return 7 * 24 * 60 * 60_000;
  }
}

/** What is wrong with a job, if anything. */
export type JobProblem =
  /** Its most recent run ended in failure. Immediate: no waiting period. */
  | "failing"
  /** It has not succeeded in long enough that two runs must have been missed. */
  | "overdue"
  /** It has never run at all — a job registered but never scheduled, or a store with no history. */
  | "never-run";

export interface JobHealth {
  name: string;
  problem: JobProblem | null;
  lastSucceeded: Date | null;
  /** job_run.detail of the most recent run: the error text when it failed. */
  detail: string | null;
}

/** The most recent run of a job, as the health check reads it. */
export interface LastOutcome extends LastRuns {
  outcome: "succeeded" | "failed" | null;
  detail: string | null;
}

/**
 * Judge every registered job. Two problems rather than one, because they are
 * different failures and the interesting one is invisible to the other
 * (beeline-6td).
 *
 * `failing` is the run that happened and did not work — the nightly OOMing at
 * a memory limit set too low, which is how this was found. It needs no
 * tolerance: the store says the last attempt failed, and that is true now.
 *
 * `overdue` is the run that did not happen at all: a dead scheduler, a machine
 * that never came up, a job whose retries were exhausted long enough ago that
 * the failure has scrolled out of the history. Tolerance is two full periods,
 * so a single missed window — a deploy landing at 02:00, one failed attempt
 * that will retry — is not an alarm. It fires when something has been wrong
 * for longer than the schedule can explain.
 *
 * `never-run` is kept separate from `overdue` deliberately: a job that has
 * never succeeded looks identical to one that stopped succeeding if you only
 * measure elapsed time, and they call for opposite responses — one is a
 * deployment that was never finished, the other a thing that broke.
 */
export function jobHealth(jobs: Job[], last: Map<string, LastOutcome>, now: Date): JobHealth[] {
  return jobs.map((job) => {
    const seen = last.get(job.name);
    const lastSucceeded = seen?.succeeded ?? null;
    const detail = seen?.detail ?? null;
    let problem: JobProblem | null = null;
    if (seen === undefined || seen.started === null) problem = "never-run";
    else if (seen.outcome === "failed") problem = "failing";
    else if (lastSucceeded === null) problem = "never-run";
    else if (now.getTime() - lastSucceeded.getTime() > 2 * expectedPeriodMs(job.schedule)) problem = "overdue";
    return { name: job.name, problem, lastSucceeded, detail };
  });
}

export interface SchedulerDeps {
  db: Kysely<Database>;
  conn: DuckDBConnection;
  jobs: Job[];
  tickMs?: number;
  /** Interactive-window step budget; override only in tests. */
  budgetMs?: number;
  now?: () => Date;
}

/** Run one job to completion, recording the run. Never throws: failures land in job_run. */
export async function runJob(deps: Pick<SchedulerDeps, "db" | "conn" | "budgetMs">, job: Job): Promise<void> {
  const budget = deps.budgetMs ?? 1000;
  const { db, conn } = deps;
  const run = await db.insertInto("job_run").values({ job_name: job.name }).returning("entity_id").executeTakeFirstOrThrow();
  let breaches = 0;
  const ctx: JobContext = {
    db,
    conn,
    log: (message) => console.log(`[job ${job.name}] ${message}`),
    async step(label, fn) {
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        const ms = performance.now() - t0;
        if (job.window === "interactive" && ms > budget) {
          breaches += 1;
          console.warn(`[job ${job.name}] SLA breach: step '${label}' took ${Math.round(ms)}ms (budget ${budget}ms)`);
        }
      }
    },
  };
  const finish = (outcome: "succeeded" | "failed", detail: string | null) =>
    db
      .updateTable("job_run")
      .set({ completed_at: sql`now()`, outcome, detail, sla_breaches: breaches })
      .where("entity_id", "=", run.entity_id)
      .execute();
  ctx.log("started");
  try {
    const detail = await job.run(ctx);
    ctx.log(`succeeded${detail ? `: ${detail}` : ""}`);
    await finish("succeeded", detail ?? null);
  } catch (err) {
    console.error(`[job ${job.name}] failed:`, err);
    await finish("failed", (err as Error).message);
  }
}

export interface Scheduler {
  stop(): void;
  /** Run a job immediately regardless of schedule. False if unknown or something is already running. */
  runNow(name: string): Promise<boolean>;
  running(): string | null;
}

export function startScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => new Date());
  let busy: string | null = null;

  // A run left without completed_at means the process died mid-job: mark it
  // failed so it stops occupying the day's schedule slot (beeline-40m). Runs
  // once, before any scheduling; nothing is running yet in this process.
  const reconciled = deps.db
    .updateTable("job_run")
    .set({ completed_at: sql`now()`, outcome: "failed", detail: "orphaned: the process exited mid-run" })
    .where("completed_at", "is", null)
    .execute()
    .then(() => undefined)
    .catch((err: unknown) => console.error("job_run orphan reconciliation failed:", err));

  const lastRuns = async (): Promise<Map<string, LastRuns>> => {
    const rows = await deps.db
      .selectFrom("job_run")
      .select(["job_name"])
      .select(({ fn }) => fn.max("started_at").as("started"))
      .select(sql<Date | null>`max(CASE WHEN outcome = 'succeeded' THEN started_at END)`.as("succeeded"))
      .groupBy("job_name")
      .execute();
    return new Map(rows.map((r) => [r.job_name, { started: r.started, succeeded: r.succeeded }]));
  };

  const NEVER: LastRuns = { started: null, succeeded: null };

  const tick = async () => {
    if (busy !== null) return;
    busy = "(scheduling)";
    try {
      await reconciled;
      const last = await lastRuns();
      for (const job of deps.jobs) {
        if (isDue(job.schedule, job.window, now(), last.get(job.name) ?? NEVER)) {
          busy = job.name;
          await runJob(deps, job);
        }
      }
    } finally {
      busy = null;
    }
  };

  const interval = setInterval(() => {
    tick().catch((err: unknown) => console.error("scheduler tick failed:", err));
  }, deps.tickMs ?? 60_000);
  interval.unref();

  return {
    stop: () => clearInterval(interval),
    async runNow(name) {
      const job = deps.jobs.find((j) => j.name === name);
      if (job === undefined || busy !== null) return false;
      busy = job.name;
      try {
        await reconciled; // never insert a live run the orphan sweep could catch
        await runJob(deps, job);
      } finally {
        busy = null;
      }
      return true;
    },
    running: () => busy,
  };
}
