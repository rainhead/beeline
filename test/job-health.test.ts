import { describe, expect, test } from "vitest";
import { isOverdue, jobHealth, type Job, type LastOutcome } from "../src/app/jobs/framework.js";

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

/** The same calendar-day count the framework uses, restated so a test can name it. */
const laDaysBetweenForTest = (from: Date, to: Date) => {
  const day = (at: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  return Math.round((Date.parse(`${day(to)}T00:00:00Z`) - Date.parse(`${day(from)}T00:00:00Z`)) / 86_400_000);
};

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
    // An hourly job silent for three hours is overdue; a daily one is not.
    const stale = (j: Job) => only([j], new Map([[j.name, {
      started: ago(3 * HOUR), succeeded: ago(3 * HOUR), outcome: "succeeded" as const, detail: null,
    }]]))[0]!.problem;
    expect(stale(PURGE)).toBe("overdue");
    expect(stale(NIGHTLY)).toBeNull();
  });

  // The LA schedules run on LA calendar boundaries, and two days a year are
  // not 24 hours long. Counting elapsed milliseconds gets both wrong, in
  // opposite directions.
  describe("across a daylight-saving change", () => {
    const daily = { kind: "dailyLA" as const, hour: 2 };

    // 2026-11-01 is the fall-back: that LA day is 25 hours long.
    test("autumn: one missed run is not an alarm, though the day is 25 hours", () => {
      // Succeeded 31 Oct 02:00 PDT; now 03:00 PST on 1 November.
      const succeeded = new Date("2026-10-31T09:00:00Z");
      const now = new Date("2026-11-01T11:00:00Z");
      expect(laDaysBetweenForTest(succeeded, now)).toBe(1);
      expect(isOverdue(daily, succeeded, now)).toBe(false);
    });

    test("autumn: two missed runs alarm, and the extra hour does not stop them", () => {
      // 31 Oct 02:00 PDT to 2 Nov 02:00 PST is 49 hours, not 48 — the reason
      // a fixed two-day tolerance in milliseconds drifts here.
      const succeeded = new Date("2026-10-31T09:00:00Z");
      const now = new Date("2026-11-02T10:00:00Z");
      expect(now.getTime() - succeeded.getTime()).toBe(49 * HOUR);
      expect(isOverdue(daily, succeeded, now)).toBe(true);
    });

    test("spring: a 23-hour day does not delay a real alarm", () => {
      // 2026-03-08 is the spring-forward. Succeeded 7 March at 02:00 PST; it
      // is now 02:00 PDT on 9 March — 47 elapsed hours, and two missed runs.
      const succeeded = new Date("2026-03-07T10:00:00Z");
      const now = new Date("2026-03-09T09:00:00Z");
      expect(now.getTime() - succeeded.getTime()).toBeLessThan(48 * HOUR); // elapsed time would wait
      expect(isOverdue(daily, succeeded, now)).toBe(true);
    });

    test("an interval job is still judged on elapsed time, which is right for it", () => {
      const hourly = { kind: "everyMinutes" as const, minutes: 60 };
      const at = new Date("2026-11-01T09:00:00Z");
      expect(isOverdue(hourly, new Date(at.getTime() - 90 * 60_000), at)).toBe(false);
      expect(isOverdue(hourly, new Date(at.getTime() - 150 * 60_000), at)).toBe(true);
    });
  });

});
