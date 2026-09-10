import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { isDue, runJob, startScheduler, type Job, type JobContext } from "../src/app/jobs/framework.js";
import { lastSyncStart, refreshPlaces } from "../src/app/jobs/registry.js";
import { createApp } from "../src/app/server.js";
import { createMemoryDb } from "./helpers.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function jobDeps() {
  const { instance, conn } = await createMemoryDb();
  return { db: createKysely(instance), conn };
}

describe("isDue", () => {
  const never = { started: null, succeeded: null };
  const ranAt = (iso: string) => ({ started: new Date(iso), succeeded: new Date(iso) });
  const failedAt = (iso: string) => ({ started: new Date(iso), succeeded: null });

  it("everyMinutes: due at start and after the interval", () => {
    const s = { kind: "everyMinutes", minutes: 60 } as const;
    const now = new Date("2026-08-22T12:00:00Z");
    expect(isDue(s, "interactive", now, never)).toBe(true);
    expect(isDue(s, "interactive", now, ranAt("2026-08-22T11:30:00Z"))).toBe(false);
    expect(isDue(s, "interactive", now, ranAt("2026-08-22T11:00:00Z"))).toBe(true);
  });

  it("weeklyLA: fires only on the LA weekday, once", () => {
    const s = { kind: "weeklyLA", weekday: 0, hour: 3 } as const;
    // 2026-08-23 is a Sunday; 10:01Z = 03:01 LA (PDT).
    expect(isDue(s, "night", new Date("2026-08-23T10:01:00Z"), never)).toBe(true);
    expect(isDue(s, "night", new Date("2026-08-23T09:01:00Z"), never)).toBe(false); // 02:01 LA, too early
    expect(isDue(s, "night", new Date("2026-08-24T10:01:00Z"), never)).toBe(false); // Monday
    // Already ran that Sunday → next Sunday.
    expect(isDue(s, "night", new Date("2026-08-23T11:30:00Z"), ranAt("2026-08-23T10:01:00Z"))).toBe(false);
    expect(isDue(s, "night", new Date("2026-08-30T10:01:00Z"), ranAt("2026-08-23T10:01:00Z"))).toBe(true);
  });

  it("dailyLA: fires once per LA day, at or after the hour", () => {
    const s = { kind: "dailyLA", hour: 2 } as const;
    // PDT is UTC-7: 08:59Z = 01:59 LA (too early), 09:01Z = 02:01 LA (due).
    expect(isDue(s, "night", new Date("2026-08-22T08:59:00Z"), never)).toBe(false);
    expect(isDue(s, "night", new Date("2026-08-22T09:01:00Z"), never)).toBe(true);
    // Already ran this LA day → not due again.
    expect(isDue(s, "night", new Date("2026-08-22T10:30:00Z"), ranAt("2026-08-22T09:01:00Z"))).toBe(false);
    // Next LA day → due again.
    expect(isDue(s, "night", new Date("2026-08-23T09:01:00Z"), ranAt("2026-08-22T09:01:00Z"))).toBe(true);
  });

  it("night jobs never start after the carve-out ends (beeline-7tt)", () => {
    const s = { kind: "dailyLA", hour: 2 } as const;
    // A 3pm deploy with no run yet today: 22:00Z = 15:00 LA.
    expect(isDue(s, "night", new Date("2026-08-22T22:00:00Z"), never)).toBe(false);
    // 11:59Z = 04:59 LA is still inside the window.
    expect(isDue(s, "night", new Date("2026-08-22T11:59:00Z"), never)).toBe(true);
    // An interactive daily job keeps the lower-bound-only behavior.
    expect(isDue(s, "interactive", new Date("2026-08-22T22:00:00Z"), never)).toBe(true);
  });

  it("a failed run retries after a pause instead of losing the day (beeline-40m)", () => {
    const s = { kind: "dailyLA", hour: 2 } as const;
    // Failed at 02:01 LA; 5 minutes later is too soon, 20 minutes later retries.
    expect(isDue(s, "night", new Date("2026-08-22T09:06:00Z"), failedAt("2026-08-22T09:01:00Z"))).toBe(false);
    expect(isDue(s, "night", new Date("2026-08-22T09:21:00Z"), failedAt("2026-08-22T09:01:00Z"))).toBe(true);
    // But never outside the night window: a 2am failure does not retry at noon.
    expect(isDue(s, "night", new Date("2026-08-22T19:00:00Z"), failedAt("2026-08-22T09:01:00Z"))).toBe(false);
    // A success earlier the same day always holds until tomorrow.
    expect(isDue(s, "night", new Date("2026-08-22T11:00:00Z"), ranAt("2026-08-22T09:01:00Z"))).toBe(false);
  });
});

describe("runJob", () => {
  it("records a successful run with its detail", async () => {
    const deps = await jobDeps();
    const job: Job = {
      name: "greet",
      schedule: { kind: "everyMinutes", minutes: 1 },
      window: "interactive",
      run: async () => "did 3 things",
    };
    await runJob(deps, job);
    const run = await deps.db.selectFrom("job_run").selectAll().executeTakeFirstOrThrow();
    expect(run.outcome).toBe("succeeded");
    expect(run.detail).toBe("did 3 things");
    expect(run.completed_at).not.toBeNull();
  });

  it("records a failure loudly instead of throwing", async () => {
    const deps = await jobDeps();
    const job: Job = {
      name: "doomed",
      schedule: { kind: "everyMinutes", minutes: 1 },
      window: "night",
      run: async () => {
        throw new Error("upstream said 503");
      },
    };
    await runJob(deps, job);
    const run = await deps.db.selectFrom("job_run").selectAll().executeTakeFirstOrThrow();
    expect(run.outcome).toBe("failed");
    expect(run.detail).toBe("upstream said 503");
  });

  it("counts SLA breaches for interactive jobs; night jobs are exempt", async () => {
    const deps = await jobDeps();
    const slow = (name: string, window: "interactive" | "night"): Job => ({
      name,
      schedule: { kind: "everyMinutes", minutes: 1 },
      window,
      run: async (ctx) => {
        await ctx.step("slow chunk", () => sleep(20));
      },
    });
    await runJob({ ...deps, budgetMs: 1 }, slow("slow-interactive", "interactive"));
    await runJob({ ...deps, budgetMs: 1 }, slow("slow-night", "night"));
    const runs = await deps.db.selectFrom("job_run").select(["job_name", "sla_breaches"]).execute();
    expect(runs.find((r) => r.job_name === "slow-interactive")?.sla_breaches).toBe(1);
    expect(runs.find((r) => r.job_name === "slow-night")?.sla_breaches).toBe(0);
  });
});

describe("scheduler", () => {
  it("runs due jobs on tick and records history", async () => {
    const deps = await jobDeps();
    let ran = 0;
    const scheduler = startScheduler({
      ...deps,
      jobs: [
        {
          name: "ticker",
          schedule: { kind: "everyMinutes", minutes: 9999 },
          window: "interactive",
          run: async () => {
            ran += 1;
            return "tick";
          },
        },
      ],
      tickMs: 10,
    });
    try {
      await sleep(80);
      expect(ran).toBe(1); // due immediately, then not for 9999 minutes
      const run = await deps.db.selectFrom("job_run").selectAll().executeTakeFirstOrThrow();
      expect(run.outcome).toBe("succeeded");
    } finally {
      scheduler.stop();
    }
  });

  it("runNow runs regardless of schedule; unknown names are refused", async () => {
    const deps = await jobDeps();
    const scheduler = startScheduler({
      ...deps,
      jobs: [
        { name: "manual", schedule: { kind: "dailyLA", hour: 2 }, window: "night", run: async () => "on demand" },
      ],
      tickMs: 3_600_000,
    });
    try {
      expect(await scheduler.runNow("nope")).toBe(false);
      expect(await scheduler.runNow("manual")).toBe(true);
      const run = await deps.db.selectFrom("job_run").selectAll().executeTakeFirstOrThrow();
      expect(run.detail).toBe("on demand");
    } finally {
      scheduler.stop();
    }
  });
});

describe("shutdown (beeline-fth)", () => {
  /** A promise the test resolves by hand, so a job can be held mid-step. */
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }
  const daily = { schedule: { kind: "dailyLA", hour: 2 }, window: "night" } as const;

  it("stop() waits for the running job, which finishes and is recorded as a success", async () => {
    const deps = await jobDeps();
    const hold = deferred();
    const scheduler = startScheduler({
      ...deps,
      jobs: [{ name: "slow", ...daily, run: (ctx) => ctx.step("only", () => hold.promise.then(() => "done")) }],
      tickMs: 3_600_000,
    });
    const started = scheduler.runNow("slow");
    await sleep(10);
    expect(scheduler.running()).toBe("slow");
    let stopped = false;
    const stopping = scheduler.stop({ graceMs: 5_000 }).then(() => (stopped = true));
    await sleep(30);
    expect(stopped).toBe(false); // still waiting: the job is inside its grace
    hold.resolve();
    await stopping;
    expect(await started).toBe(true);
    const run = await deps.db.selectFrom("job_run").selectAll().executeTakeFirstOrThrow();
    expect(run.outcome).toBe("succeeded");
    expect(run.detail).toBe("done");
  });

  it("past the grace the job is interrupted: its next step refuses and the failure names it", async () => {
    const deps = await jobDeps();
    const hold = deferred();
    let second = false;
    const scheduler = startScheduler({
      ...deps,
      jobs: [
        {
          name: "two-step",
          ...daily,
          run: async (ctx) => {
            await ctx.step("first", () => hold.promise);
            await ctx.step("second", async () => void (second = true));
          },
        },
      ],
      tickMs: 3_600_000,
    });
    void scheduler.runNow("two-step");
    await sleep(10);
    const stopping = scheduler.stop({ graceMs: 20 });
    await sleep(60); // grace expires while the first step is still held
    hold.resolve();
    await stopping;
    expect(second).toBe(false);
    const run = await deps.db.selectFrom("job_run").selectAll().executeTakeFirstOrThrow();
    expect(run.outcome).toBe("failed");
    expect(run.detail).toBe("interrupted by shutdown before step 'second'");
  });

  it("the context's signal reaches a step that is waiting on something else", async () => {
    const deps = await jobDeps();
    const waitForAbort = (ctx: JobContext) =>
      new Promise<string>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const scheduler = startScheduler({
      ...deps,
      jobs: [{ name: "waiting", ...daily, run: (ctx) => ctx.step("wait", () => waitForAbort(ctx)) }],
      tickMs: 3_600_000,
    });
    void scheduler.runNow("waiting");
    await sleep(10);
    await scheduler.stop({ graceMs: 20 });
    const run = await deps.db.selectFrom("job_run").selectAll().executeTakeFirstOrThrow();
    expect(run.outcome).toBe("failed");
    expect(run.detail).toBe("aborted");
  });

  it("nothing starts once stop() has been called", async () => {
    const deps = await jobDeps();
    let ran = 0;
    const scheduler = startScheduler({
      ...deps,
      jobs: [{ name: "late", schedule: { kind: "everyMinutes", minutes: 1 }, window: "interactive", run: async () => void (ran += 1) }],
      tickMs: 10,
    });
    await scheduler.stop();
    expect(await scheduler.runNow("late")).toBe(false);
    await sleep(50);
    expect(ran).toBe(0);
  });

  it("runJob without a scheduler has a signal that never fires", async () => {
    const deps = await jobDeps();
    const job: Job = {
      name: "plain",
      ...daily,
      run: async (ctx) => (ctx.signal.aborted ? "aborted" : "fine"),
    };
    await runJob(deps, job);
    const run = await deps.db.selectFrom("job_run").selectAll().executeTakeFirstOrThrow();
    expect(run.detail).toBe("fine");
  });
});

describe("boot reconciliation", () => {
  it("marks runs orphaned by a crash as failed so they stop holding the day's slot", async () => {
    const deps = await jobDeps();
    await deps.db.insertInto("job_run").values({ job_name: "nightly-pipeline" }).execute();
    const scheduler = startScheduler({ ...deps, jobs: [], tickMs: 10 });
    try {
      await sleep(50);
      const run = await deps.db.selectFrom("job_run").selectAll().executeTakeFirstOrThrow();
      expect(run.outcome).toBe("failed");
      expect(run.completed_at).not.toBeNull();
      expect(run.detail).toContain("orphaned");
    } finally {
      scheduler.stop();
    }
  });
});

describe("the nightly's places step (beeline-0oj)", () => {
  const failing = (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.inaturalist.org");
  }) as unknown as typeof fetch;

  it("an unreachable places endpoint is reported, and the run goes on to promote", async () => {
    const { conn } = await jobDeps();
    // One observation naming a place the cache has never seen, so there is
    // something to ask for and the request actually fails.
    await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
    await conn.run(
      `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
       VALUES (1, (SELECT max(entity_id) FROM sync_run), '{"id":1,"place_ids":[10]}', 'h1')`,
    );
    const summary = await refreshPlaces(conn, { requestDelayMs: 0, fetchImpl: failing });
    expect(summary).toMatch(/places fetch failed \(getaddrinfo ENOTFOUND/);
    expect(summary).toMatch(/promoting with the cache as it stands/);
  });

  it("says when there was nothing to ask, so the detail distinguishes quiet from broken", async () => {
    const { conn } = await jobDeps();
    expect(await refreshPlaces(conn, { requestDelayMs: 0, fetchImpl: failing })).toBe("places cache complete");
  });
});

describe("lastSyncStart (incremental watermark, beeline-bwy)", () => {
  const insertRun = (
    deps: Awaited<ReturnType<typeof jobDeps>>,
    startedAt: string,
    updatedSince: string | null,
  ) =>
    deps.conn.run(
      `INSERT INTO sync_run (source, authenticated, started_at, completed_at, updated_since)
       VALUES ('99706', true, TIMESTAMPTZ '${startedAt}', TIMESTAMPTZ '${startedAt}' + INTERVAL 10 MINUTE,
               ${updatedSince === null ? "NULL" : `TIMESTAMPTZ '${updatedSince}'`})`,
    );

  it("a windowed sweep does not advance the watermark past the last incremental run", async () => {
    const deps = await jobDeps();
    await insertRun(deps, "2026-08-01 09:00:00+00", null); // bootstrap sweep
    await insertRun(deps, "2026-08-02 09:00:00+00", "2026-08-01 08:00:00+00"); // incremental
    await insertRun(deps, "2026-08-20 21:00:00+00", null); // manual daytime sweep
    const at = await lastSyncStart(deps.db, "99706");
    expect(at?.toISOString()).toBe("2026-08-02T09:00:00.000Z");
  });

  it("with no incremental run yet, the latest completed sweep bootstraps the chain", async () => {
    const deps = await jobDeps();
    await insertRun(deps, "2026-08-01 09:00:00+00", null);
    await insertRun(deps, "2026-08-08 09:00:00+00", null);
    const at = await lastSyncStart(deps.db, "99706");
    expect(at?.toISOString()).toBe("2026-08-08T09:00:00.000Z");
  });
});

describe("/jobs page", () => {
  it("lists registered jobs and recent runs; run-now triggers a run", async () => {
    const deps = await jobDeps();
    const job: Job = {
      name: "manual",
      schedule: { kind: "dailyLA", hour: 2 },
      window: "night",
      run: async () => "pressed the button",
    };
    const inat: InatClient = {
      authorizeUrl: () => "unused",
      exchangeCode: () => Promise.reject(new Error("not under test")),
      identity: () => Promise.reject(new Error("not under test")),
    };
    const app = createApp({
      db: deps.db,
      config: { environment: "development", origin: "http://localhost:3054" },
      inat,
      resolveSession: async () => ({ personId: 1, login: "tester", iconUrl: null }),
      jobs: { list: [job], runNow: async (name) => (name === "manual" ? (await runJob(deps, job), true) : false) },
    });

    const before = await (await app.request("/jobs")).text();
    expect(before).toContain("manual");
    expect(before).toContain("daily at 2:00 Pacific");
    expect(before).toContain("No runs yet.");

    const post = await app.request("/jobs/run/manual", {
      method: "POST",
      headers: { origin: "http://localhost:3054" },
    });
    expect(post.status).toBe(302);

    const after = await (await app.request("/jobs")).text();
    expect(after).toContain("pressed the button");
    expect(after).toContain("succeeded");
  });

  it("outside development, /jobs is admin-only (beeline-6va)", async () => {
    const deps = await jobDeps();
    // The roster lives in the store now, not in config: a grant is a
    // person_admin row, and person 1 is the signed-in volunteer below.
    await deps.conn.run(`INSERT INTO person (entity_id, display_name) VALUES (1, 'A Volunteer')`);
    const grant = async (yes: boolean) => {
      await deps.conn.run(`DELETE FROM person_admin`);
      if (yes) await deps.conn.run(`INSERT INTO person_admin (person_id) VALUES (1)`);
    };
    await grant(false);
    const inat: InatClient = {
      authorizeUrl: () => "unused",
      exchangeCode: () => Promise.reject(new Error("not under test")),
      identity: () => Promise.reject(new Error("not under test")),
    };
    const appFor = () =>
      createApp({
        db: deps.db,
        config: { environment: "sandbox", origin: "https://beeline.example" },
        inat,
        resolveSession: async () => ({ personId: 1, login: "volunteer", iconUrl: null }),
        jobs: { list: [], runNow: async () => true },
      });

    const gated = appFor();
    expect((await gated.request("/jobs")).status).toBe(403);
    const run = await gated.request("/jobs/run/nightly-pipeline", {
      method: "POST",
      headers: { origin: "https://beeline.example" },
    });
    expect(run.status).toBe(403);
    // The nav links to the admin surface disappear with the access; the
    // glossary is a page a plain volunteer can still reach.
    const volunteerNav = await (await gated.request("/glossary")).text();
    expect(volunteerNav).not.toContain(`href="/jobs"`);
    expect(volunteerNav).not.toContain(`href="/design"`);
    expect(volunteerNav).toContain(`href="/glossary"`);
    // /design is off the nav but not walled off: it reads no records, so a
    // volunteer who follows a link to it gets the page.
    expect((await gated.request("/design")).status).toBe(200);

    await grant(true);
    const admin = appFor();
    expect((await admin.request("/jobs")).status).toBe(200);
  });
});
