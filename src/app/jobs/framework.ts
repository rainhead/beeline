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
  /**
   * Aborted when the process has been asked to shut down and has run out of
   * patience (beeline-fth). `step()` refuses to start once it is, so a job
   * made of steps winds down at its next boundary without knowing about it;
   * a step that can run long on its own — the sync's paging loop — passes it
   * to whatever it waits on.
   */
  signal: AbortSignal;
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
 * Calendar days between two instants, counted in the night-window's timezone.
 *
 * Not elapsed milliseconds divided by 86,400,000, because the LA schedules run
 * on LA calendar boundaries and two days a year are not 24 hours long. At the
 * autumn change two scheduled runs sit 49 hours apart, so a fixed 48-hour
 * tolerance calls a job overdue having missed only one — a spurious alarm, and
 * a spurious alarm is how somebody learns to ignore the alarm this whole thing
 * exists to raise. At the spring change the same arithmetic delays a real one.
 */
function laDaysBetween(from: Date, to: Date): number {
  const midnight = (at: Date) => Date.parse(`${laParts(at).date}T00:00:00Z`);
  return Math.round((midnight(to) - midnight(from)) / 86_400_000);
}

/**
 * Has this job been silent for longer than its schedule can explain?
 *
 * Two missed runs, so one skipped window — a deploy landing at 02:00, a single
 * failed attempt that will retry — is not an alarm. Counted the way each
 * schedule itself counts: elapsed minutes for an interval job, LA calendar
 * days for the ones that run on LA calendar boundaries.
 */
export function isOverdue(schedule: Schedule, lastSucceeded: Date, now: Date): boolean {
  switch (schedule.kind) {
    case "everyMinutes":
      return now.getTime() - lastSucceeded.getTime() > 2 * schedule.minutes * 60_000;
    case "dailyLA":
      return laDaysBetween(lastSucceeded, now) >= 2;
    case "weeklyLA":
      return laDaysBetween(lastSucceeded, now) >= 14;
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
    else if (isOverdue(job.schedule, lastSucceeded, now)) problem = "overdue";
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

/** What a step throws when shutdown reaches it first; job_run.detail says which step. */
export class JobInterrupted extends Error {
  constructor(label: string) {
    super(`interrupted by shutdown before step '${label}'`);
    this.name = "JobInterrupted";
  }
}

/** Run one job to completion, recording the run. Never throws: failures land in job_run. */
export async function runJob(
  deps: Pick<SchedulerDeps, "db" | "conn" | "budgetMs">,
  job: Job,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const budget = deps.budgetMs ?? 1000;
  const { db, conn } = deps;
  const run = await db.insertInto("job_run").values({ job_name: job.name }).returning("entity_id").executeTakeFirstOrThrow();
  let breaches = 0;
  const ctx: JobContext = {
    db,
    conn,
    log: (message) => console.log(`[job ${job.name}] ${message}`),
    signal,
    async step(label, fn) {
      // Checked at the boundary and nowhere else: a step that has started is
      // the unit of work worth finishing, and a step that has not is the
      // cheapest place to stop.
      if (signal.aborted) throw new JobInterrupted(label);
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
  /**
   * Stop scheduling and settle whatever is running (beeline-fth).
   *
   * Resolves only once no job is running, so the caller can close the
   * connection the job was using. Two phases: for `graceMs` the running job
   * is left alone, because the common case is a nightly with seconds left and
   * a run that finishes is one that need not be retried. Past that the job is
   * asked to stop — its context's signal aborts, so the next `step()` refuses
   * and the sync's paging loop stops at its next request — and the running
   * DuckDB query, if any, is interrupted so its transaction rolls back rather
   * than holding the connection. The job's failure is recorded like any
   * other, and the daily schedule retries it after its usual pause. Never
   * rejects: nothing about a job's failure should stand between the caller
   * and closing the store.
   */
  stop(opts?: { graceMs?: number }): Promise<void>;
  /** Run a job immediately regardless of schedule. False if unknown, stopping, or something is already running. */
  runNow(name: string): Promise<boolean>;
  running(): string | null;
}

export function startScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => new Date());
  let busy: string | null = null;
  /** The run in flight, so stop() has something to await; null when idle. */
  let inFlight: Promise<void> | null = null;
  let stopping = false;
  const shutdown = new AbortController();

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

  /** Run one job, tracked so a shutdown can wait for it. */
  const track = async (job: Job) => {
    busy = job.name;
    inFlight = runJob(deps, job, shutdown.signal);
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  };

  const tick = async () => {
    if (busy !== null || stopping) return;
    busy = "(scheduling)";
    try {
      await reconciled;
      const last = await lastRuns();
      for (const job of deps.jobs) {
        if (stopping) break;
        if (isDue(job.schedule, job.window, now(), last.get(job.name) ?? NEVER)) {
          await track(job);
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

  const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

  return {
    async stop(opts = {}) {
      stopping = true;
      clearInterval(interval);
      const running = inFlight;
      if (running === null) return;
      const grace = opts.graceMs ?? 0;
      if (grace > 0) await Promise.race([running, settle(grace)]);
      if (inFlight !== null) {
        console.warn(`[scheduler] job '${busy}' still running after ${grace}ms grace: interrupting it`);
        shutdown.abort();
        // A query in flight is cancelled; an idle connection is untouched, and
        // the abort above is what reaches a job that is waiting on the network.
        deps.conn.interrupt();
      }
      // runJob never throws, so this is the run finishing, one way or the other.
      await running;
    },
    async runNow(name) {
      const job = deps.jobs.find((j) => j.name === name);
      if (job === undefined || busy !== null || stopping) return false;
      busy = job.name;
      try {
        await reconciled; // never insert a live run the orphan sweep could catch
        await track(job);
      } finally {
        busy = null;
      }
      return true;
    },
    running: () => busy,
  };
}
