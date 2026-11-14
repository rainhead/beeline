import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { jobTroubles } from "../src/app/job-trouble.js";
import { runJob, type Job } from "../src/app/jobs/framework.js";
import { refreshAreas, refreshLocalities } from "../src/app/jobs/registry.js";
import { createApp } from "../src/app/server.js";
import { createMemoryDb, scratchPaths } from "./helpers.js";

/**
 * A step that is allowed to fail without failing its run is still recorded
 * as failed, and /jobs and the menu say so (beeline-222u). Before this,
 * finding areas failed on production for four nights inside runs marked
 * succeeded, and nobody saw it (beeline-6cur).
 */
async function jobDeps() {
  const { instance, conn } = await createMemoryDb();
  return { db: createKysely(instance), conn };
}

const inat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const nightly = (run: Job["run"]): Job => ({
  name: "nightly-pipeline",
  schedule: { kind: "dailyLA", hour: 2 },
  window: "night",
  run,
});

/** A night whose areas step fails the way the real one does: caught, described, and reported as failed. */
const areasFail = nightly(async (ctx) => {
  await ctx.step("promote observations", async () => undefined);
  const detail = await ctx.step(
    "find areas",
    async () => "finding areas failed (Out of Memory Error)",
    () => true,
  );
  return `0 samples linked; ${detail}`;
});

const appFor = async (deps: Awaited<ReturnType<typeof jobDeps>>, jobs: Job[]) =>
  createApp({
    ...(await scratchPaths()),
    db: deps.db,
    config: { environment: "development", origin: "http://localhost:3054" },
    inat,
    resolveSession: async () => ({ personId: 1, login: "tester", iconUrl: null }),
    jobs: { list: jobs, start: async () => false },
  });

describe("a step that fails without failing its run", () => {
  it("is recorded as a failed step of a run that succeeded", async () => {
    const deps = await jobDeps();
    await runJob(deps, areasFail);
    const run = await deps.db.selectFrom("job_run").selectAll().executeTakeFirstOrThrow();
    expect(run.outcome).toBe("succeeded");
    expect(
      await deps.db.selectFrom("job_step").select(["label", "failed"]).orderBy("step_number").execute(),
    ).toEqual([
      { label: "promote observations", failed: false },
      { label: "find areas", failed: true },
    ]);
  });

  it("says it failed when the areas or localities step catches an error", async () => {
    const { conn } = await jobDeps();
    // A gazetteer that is not a database: attaching it throws.
    const broken = join(await mkdtemp(join(tmpdir(), "beeline-trouble-")), "gazetteer.duckdb");
    await writeFile(broken, "not a database");
    let failed = 0;
    const areas = await refreshAreas(conn, broken, undefined, () => (failed += 1));
    expect(areas.detail).toMatch(/^finding areas failed \(/);
    expect(await refreshLocalities(conn, broken, undefined, () => (failed += 1))).toMatch(/^naming localities failed \(/);
    expect(failed).toBe(2);
    // No gazetteer at all is not a failure: the step says there is none.
    failed = 0;
    await refreshAreas(conn, join(tmpdir(), "no-such-gazetteer.duckdb"), undefined, () => (failed += 1));
    expect(failed).toBe(0);
  });
});

describe("jobTroubles", () => {
  const now = new Date();

  it("names the job and the step when the last run finished with a failed step", async () => {
    const deps = await jobDeps();
    await runJob(deps, areasFail);
    expect(await jobTroubles(deps.db, [areasFail], now)).toEqual([
      expect.objectContaining({
        name: "nightly-pipeline",
        kind: "step-failed",
        failedSteps: ["find areas"],
        detail: "0 samples linked; finding areas failed (Out of Memory Error)",
      }),
    ]);
  });

  it("is empty once a later run's steps all work", async () => {
    const deps = await jobDeps();
    await runJob(deps, areasFail);
    const fine = nightly(async (ctx) => {
      await ctx.step("find areas", async () => "areas: 3 sample(s) tested", () => false);
    });
    await runJob(deps, fine);
    expect(await jobTroubles(deps.db, [fine], now)).toEqual([]);
  });

  it("reports a failed run as failing, with the step it failed at", async () => {
    const deps = await jobDeps();
    const failing = nightly(async (ctx) => {
      await ctx.step("promote observations", async () => {
        throw new Error("Constraint Error: duplicate key");
      });
    });
    await runJob(deps, failing);
    expect(await jobTroubles(deps.db, [failing], now)).toEqual([
      expect.objectContaining({ kind: "failing", failedSteps: ["promote observations"], detail: "Constraint Error: duplicate key" }),
    ]);
  });

  it("reports a job that has never run, and nothing for a store with no jobs registered", async () => {
    const deps = await jobDeps();
    expect(await jobTroubles(deps.db, [areasFail], now)).toEqual([expect.objectContaining({ kind: "never-run", failedSteps: [] })]);
    expect(await jobTroubles(deps.db, [], now)).toEqual([]);
  });
});

describe("the pages", () => {
  it("/jobs opens with what is wrong, and marks the run and the job", async () => {
    const deps = await jobDeps();
    await runJob(deps, areasFail);
    const page = await (await (await appFor(deps, [areasFail])).request("/jobs")).text();
    expect(page).toContain("1 job needs attention");
    expect(page).toContain("finished its last run");
    expect(page).toContain("but part of it failed: find areas.");
    // The run in the history no longer reads as a plain success.
    expect(page).toContain("a step failed");
    expect(page).not.toContain(">succeeded<");
    // And the job in the list of registered jobs says so too.
    expect(page).toContain("a step is failing");
  });

  it("the menu marks Jobs, and its own button, on every page while something is wrong", async () => {
    const deps = await jobDeps();
    await runJob(deps, areasFail);
    const home = await (await (await appFor(deps, [areasFail])).request("/glossary")).text();
    expect(home).toMatch(/<a href="\/jobs" class="menu-alert">Jobs /);
    expect(home).toContain("a job is failing");
    expect(home).toContain("nav-menu has-alert");
  });

  it("neither page says anything when every job's last run and its steps worked", async () => {
    const deps = await jobDeps();
    const fine = nightly(async (ctx) => {
      await ctx.step("find areas", async () => "areas: 3 sample(s) tested", () => false);
      return "fine";
    });
    await runJob(deps, fine);
    const app = await appFor(deps, [fine]);
    const jobs = await (await app.request("/jobs")).text();
    expect(jobs).not.toContain("needs attention");
    expect(jobs).not.toContain("menu-alert");
    const home = await (await app.request("/glossary")).text();
    expect(home).toContain('<a href="/jobs">Jobs</a>');
    expect(home).not.toContain("has-alert");
  });
});
