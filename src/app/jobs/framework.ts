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
    { kind: "dailyLA"; hour: number };

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

/** Calendar date and hour of an instant, in the night-window's timezone. */
export function laParts(instant: Date): { date: string; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: LA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value])) as Record<string, string>;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function isDue(schedule: Schedule, now: Date, lastStarted: Date | null): boolean {
  switch (schedule.kind) {
    case "everyMinutes":
      return lastStarted === null || now.getTime() - lastStarted.getTime() >= schedule.minutes * 60_000;
    case "dailyLA": {
      const nowLA = laParts(now);
      if (nowLA.hour < schedule.hour) return false;
      return lastStarted === null || laParts(lastStarted).date !== nowLA.date;
    }
  }
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
  try {
    const detail = await job.run(ctx);
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

  const lastStarts = async (): Promise<Map<string, Date>> => {
    const rows = await deps.db
      .selectFrom("job_run")
      .select(["job_name"])
      .select(({ fn }) => fn.max("started_at").as("at"))
      .groupBy("job_name")
      .execute();
    return new Map(rows.map((r) => [r.job_name, r.at]));
  };

  const tick = async () => {
    if (busy !== null) return;
    busy = "(scheduling)";
    try {
      const last = await lastStarts();
      for (const job of deps.jobs) {
        if (isDue(job.schedule, now(), last.get(job.name) ?? null)) {
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
        await runJob(deps, job);
      } finally {
        busy = null;
      }
      return true;
    },
    running: () => busy,
  };
}
