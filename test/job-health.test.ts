import { describe, expect, test } from "vitest";
import { expectedPeriodMs, jobHealth, type Job, type LastOutcome } from "../src/app/jobs/framework.js";

/**
 * beeline-6td: the nightly pipeline failed on every run for about half a day
 * and nothing said so. job_run recorded it and /jobs displayed it, to an admin
 * who went looking; it was found by accident, reading a boot log for an
 * unrelated reason.
 *
 * The two problems below are separable and the tests keep them apart, because
 * measuring only elapsed time collapses them: a job that has never succeeded
 * and a job that stopped succeeding look identical that way, and they call for
 * opposite responses.
 */
const NIGHTLY: Job = { name: "nightly-pipeline", schedule: { kind: "dailyLA", hour: 2 }, window: "night", run: async () => {} };
const PURGE: Job = { name: "session-purge", schedule: { kind: "everyMinutes", minutes: 60 }, window: "interactive", run: async () => {} };

const now = new Date("2026-09-02T20:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const HOUR = 60 * 60_000;

const only = (jobs: Job[], last: Map<string, LastOutcome>) => jobHealth(jobs, last, now);

describe("jobHealth", () => {
  test("a run that failed is a problem immediately, with no waiting period", () => {
    // The real incident: succeeded yesterday, failed this morning, retries
    // exhausted. Elapsed time alone would still call this healthy.
    const last = new Map<string, LastOutcome>([
      ["nightly-pipeline", {
        started: ago(9 * HOUR),
        succeeded: ago(33 * HOUR),
        outcome: "failed",
        detail: "Out of Memory Error: failed to allocate data of size 8.0 MiB",
      }],
    ]);
    const [h] = only([NIGHTLY], last);
    expect(h!.problem).toBe("failing");
    expect(h!.detail).toContain("Out of Memory");
  });

  test("one missed window is not an alarm", () => {
    // A deploy landing at 02:00, or a single failed attempt that will retry.
    const last = new Map<string, LastOutcome>([
      ["nightly-pipeline", { started: ago(30 * HOUR), succeeded: ago(30 * HOUR), outcome: "succeeded", detail: "ok" }],
    ]);
    expect(only([NIGHTLY], last)[0]!.problem).toBeNull();
  });

  test("two missed windows is", () => {
    const last = new Map<string, LastOutcome>([
      ["nightly-pipeline", { started: ago(50 * HOUR), succeeded: ago(50 * HOUR), outcome: "succeeded", detail: "ok" }],
    ]);
    expect(only([NIGHTLY], last)[0]!.problem).toBe("overdue");
  });

  test("never having run is its own answer, not staleness", () => {
    // A job registered but never scheduled — a deployment left half-finished
    // — must not read as one that broke, because the fix is different.
    expect(only([NIGHTLY], new Map())[0]!.problem).toBe("never-run");
    const started = new Map<string, LastOutcome>([
      ["nightly-pipeline", { started: ago(HOUR), succeeded: null, outcome: null, detail: null }],
    ]);
    expect(only([NIGHTLY], started)[0]!.problem).toBe("never-run");
  });

  test("a healthy job is silent", () => {
    const last = new Map<string, LastOutcome>([
      ["session-purge", { started: ago(HOUR / 2), succeeded: ago(HOUR / 2), outcome: "succeeded", detail: "0 purged" }],
    ]);
    expect(only([PURGE], last)[0]!.problem).toBeNull();
  });

  test("tolerance follows the schedule, not a constant", () => {
    expect(expectedPeriodMs({ kind: "everyMinutes", minutes: 60 })).toBe(HOUR);
    expect(expectedPeriodMs({ kind: "dailyLA", hour: 2 })).toBe(24 * HOUR);
    expect(expectedPeriodMs({ kind: "weeklyLA", weekday: 0, hour: 3 })).toBe(7 * 24 * HOUR);
    // An hourly job silent for three hours is overdue; a daily one is not.
    const stale = (j: Job) => only([j], new Map([[j.name, {
      started: ago(3 * HOUR), succeeded: ago(3 * HOUR), outcome: "succeeded" as const, detail: null,
    }]]))[0]!.problem;
    expect(stale(PURGE)).toBe("overdue");
    expect(stale(NIGHTLY)).toBeNull();
  });
});
