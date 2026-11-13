import { Hono } from "hono";
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApi } from "../src/app/api.js";
import { createKey, KEY_SCOPES } from "../src/app/api-keys.js";
import { startScheduler, type Job, type Scheduler } from "../src/app/jobs/framework.js";
import { createApp } from "../src/app/server.js";
import { noSession } from "../src/app/session.js";
import { createMemoryDb, rows, scratchPaths } from "./helpers.js";

const unusedInat: InatClient = {
  authorizeUrl: () => "https://inat.example/authorize",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const STAFF_UID = 111;
const VOLUNTEER_UID = 222;
const schedulers: { scheduler: Scheduler; finish: () => void }[] = [];
afterEach(async () => {
  // Let the job that waits to be told finish first: a stop waits for whatever is running.
  for (const s of schedulers.splice(0)) {
    s.finish();
    await s.scheduler.stop({ graceMs: 0 });
  }
});

/**
 * The jobs endpoints of the API (beeline-pnqr.5), over a real scheduler: one
 * job that finishes at once, one that waits to be told, and one that fails.
 * A staff member and a volunteer each hold keys. Run on the sandbox
 * environment, since development makes everyone staff.
 */
async function fixture() {
  const { instance, conn } = await createMemoryDb();
  await conn.run(`INSERT INTO person (display_name) VALUES ('Staff Member'), ('Vera Volunteer')`);
  const [[staff], [volunteer]] = (await rows(conn, `SELECT entity_id FROM person ORDER BY display_name`)) as [[number], [number]];
  await conn.run(
    `INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${staff}, ${STAFF_UID}, 'staff'), (${volunteer}, ${VOLUNTEER_UID}, 'vera')`,
  );
  await conn.run(`INSERT INTO person_admin (person_id, granted_by) VALUES (${staff}, 'peter')`);
  const db = createKysely(instance);
  let finish!: () => void;
  const held = new Promise<void>((resolve) => (finish = resolve));
  const jobs: Job[] = [
    { name: "quick", schedule: { kind: "dailyLA", hour: 2 }, window: "night", run: async (ctx) => (await ctx.step("count", async () => {}), "3 things counted") },
    { name: "long", schedule: { kind: "weeklyLA", weekday: 0, hour: 1 }, window: "night", run: async () => (await held, "finished") },
    { name: "broken", schedule: { kind: "dailyLA", hour: 3 }, window: "night", run: async () => { throw new Error("the source was unreachable"); } },
  ];
  // A long tick, and every job already run today as far as the schedule knows, so nothing starts by itself.
  const scheduler = startScheduler({ db, conn, jobs, tickMs: 3_600_000 });
  schedulers.push({ scheduler, finish });
  const app = createApp({
    ...(await scratchPaths()),
    db,
    config: { environment: "sandbox", origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: noSession,
    jobs: { list: jobs, start: (n) => scheduler.start(n), startRun: (n) => scheduler.startRun(n), running: () => scheduler.running(), runningRun: () => scheduler.runningRun() },
  });
  const key = async (uid: number, scope: string) => {
    const made = await createKey(db, { inatUserId: uid, name: "test", scope, lifetimeDays: 30, offered: KEY_SCOPES });
    if ("problem" in made) throw new Error(made.problem);
    return made.key;
  };
  const ask = (path: string, k?: string, method = "GET") =>
    app.request(path, { method, headers: k === undefined ? {} : { authorization: `Bearer ${k}` } });
  const idle = () => vi.waitFor(() => expect(scheduler.running()).toBeNull());
  return { app, db, conn, ask, key, scheduler, finish, idle, staffKey: await key(STAFF_UID, "staff") };
}

describe("starting and watching jobs through the API", () => {
  it("starts a job, answers with the run to watch, and that run then says how it went", async () => {
    const { ask, staffKey, idle } = await fixture();
    const started = await ask("/api/v1/jobs/quick", staffKey, "POST");
    expect(started.status).toBe(202);
    const { run } = (await started.json()) as { run: { id: number; job: string; status: string } };
    expect(run).toMatchObject({ job: "quick" });
    expect(started.headers.get("location")).toBe(`/api/v1/jobs/runs/${run.id}`);

    await idle();
    const watched = await ask(`/api/v1/jobs/runs/${run.id}`, staffKey);
    expect(watched.status).toBe(200);
    expect(await watched.json()).toMatchObject({
      run: {
        id: run.id,
        job: "quick",
        status: "succeeded",
        detail: "3 things counted",
        steps: [{ number: 1, label: "count", failed: false }],
      },
    });
  });

  it("answers while the job is still running, and refuses a second job until it ends", async () => {
    const { ask, staffKey, finish, idle, scheduler } = await fixture();
    const started = await ask("/api/v1/jobs/long", staffKey, "POST");
    expect(started.status).toBe(202);
    const { run } = (await started.json()) as { run: { id: number; status: string; completed_at: string | null } };
    expect(run.status).toBe("running");
    expect(run.completed_at).toBeNull();
    // The scheduler names this very run as the one in hand, and lets go of it only when it ends.
    expect(scheduler.runningRun()).toBe(run.id);

    const second = await ask("/api/v1/jobs/quick", staffKey, "POST");
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "busy", running: "long" });
    // Nothing was recorded for the refused one.
    expect(((await (await ask("/api/v1/jobs/runs?job=quick", staffKey)).json()) as { runs: unknown[] }).runs).toEqual([]);
    expect(((await (await ask("/api/v1/jobs", staffKey)).json()) as { running: string }).running).toBe("long");

    finish();
    await idle();
    expect(scheduler.runningRun()).toBeNull();
    expect(((await (await ask(`/api/v1/jobs/runs/${run.id}`, staffKey)).json()) as { run: { status: string; detail: string } }).run).toMatchObject({
      status: "succeeded",
      detail: "finished",
    });
    expect((await ask("/api/v1/jobs/quick", staffKey, "POST")).status).toBe(202);
  });

  it("says a failed run failed, with the reason", async () => {
    const { ask, staffKey, idle } = await fixture();
    const { run } = (await (await ask("/api/v1/jobs/broken", staffKey, "POST")).json()) as { run: { id: number } };
    await idle();
    const after = (await (await ask(`/api/v1/jobs/runs/${run.id}`, staffKey)).json()) as { run: { status: string; detail: string } };
    expect(after.run.status).toBe("failed");
    expect(after.run.detail).toContain("the source was unreachable");
  });

  it("lists every registered job with its schedule and latest run, and recent runs newest first", async () => {
    const { ask, staffKey, idle } = await fixture();
    await ask("/api/v1/jobs/quick", staffKey, "POST");
    await idle();
    await ask("/api/v1/jobs/broken", staffKey, "POST");
    await idle();
    await ask("/api/v1/jobs/quick", staffKey, "POST");
    await idle();

    const listed = (await (await ask("/api/v1/jobs", staffKey)).json()) as {
      running: string | null;
      jobs: { name: string; window: string; schedule: unknown; latest_run: { status: string } | null }[];
    };
    expect(listed.running).toBeNull();
    expect(listed.jobs.map((j) => [j.name, j.latest_run?.status ?? null])).toEqual([
      ["quick", "succeeded"],
      ["long", null],
      ["broken", "failed"],
    ]);
    expect(listed.jobs[1]).toMatchObject({ window: "night", schedule: { kind: "weeklyLA", weekday: 0, hour: 1 } });

    const runs = (await (await ask("/api/v1/jobs/runs", staffKey)).json()) as { runs: { job: string }[] };
    expect(runs.runs.map((r) => r.job)).toEqual(["quick", "broken", "quick"]);
    const one = (await (await ask("/api/v1/jobs/runs?job=quick&limit=1", staffKey)).json()) as { runs: { job: string }[] };
    expect(one.runs.map((r) => r.job)).toEqual(["quick"]);
    expect((await ask("/api/v1/jobs/runs?limit=lots", staffKey)).status).toBe(400);
  });

  it("calls a run the process died in unfinished, not running, even while its job runs again", async () => {
    const { ask, staffKey, conn } = await fixture();
    // A run of `long` that never completed: the process stopped under it.
    await conn.run(`INSERT INTO job_run (job_name) VALUES ('long')`);
    const [[orphan]] = (await rows(conn, `SELECT entity_id FROM job_run`)) as [[number]];
    const status = async (id: number) =>
      ((await (await ask(`/api/v1/jobs/runs/${id}`, staffKey)).json()) as { run: { status: string } }).run.status;
    expect(await status(orphan)).toBe("unfinished");
    const { run } = (await (await ask("/api/v1/jobs/long", staffKey, "POST")).json()) as { run: { id: number } };
    expect(await status(run.id)).toBe("running");
    expect(await status(orphan)).toBe("unfinished");
  });

  it("does not call a run unfinished because the scheduler moved on while the run was being read", async () => {
    const { db, conn, key } = await fixture();
    const staffKey = await key(STAFF_UID, "staff");
    const insert = async () =>
      Number(((await rows(conn, `INSERT INTO job_run (job_name) VALUES ('long') RETURNING entity_id`)) as [[number]])[0][0]);
    // A scheduler whose answer changes between the two times one request asks it.
    const statusWith = async (path: string, runningRun: () => number | null) => {
      const api = new Hono().route("/api/v1", createApi({ db, isStaff: async () => true, jobs: { list: [], runningRun } }));
      const body = (await (await api.request(path, { headers: { authorization: `Bearer ${staffKey}` } })).json()) as {
        run?: { status: string };
        runs?: { status: string }[];
      };
      return (body.run ?? body.runs![0]!).status;
    };
    const answering = (answers: (number | null)[]) => {
      const left = [...answers];
      return () => (left.length > 1 ? left.shift()! : left[0]!);
    };

    const id = await insert();
    for (const path of [`/api/v1/jobs/runs/${id}`, "/api/v1/jobs/runs?limit=1"]) {
      // The run finished after its row was read: it was running when read.
      expect(await statusWith(path, answering([id, null])), path).toBe("running");
      // The run started after the scheduler was first asked.
      expect(await statusWith(path, answering([null, id])), path).toBe("running");
      // Nothing has it in hand, before or after: the process stopped under it.
      expect(await statusWith(path, answering([null, null])), path).toBe("unfinished");
    }

    // The run started and finished between the two times the scheduler was
    // asked: its row showed no outcome when read, and neither answer names
    // it. It is read once more, and by then says how it ended.
    for (const which of ["one", "list"] as const) {
      const runId = await insert();
      // A store that lets the run complete just after its row is first read:
      // the scheduler writes a run's outcome before it lets go of the run, so
      // by the time it answers "nothing in hand" the outcome is in the store.
      let reads = 0;
      const afterFirstRead = async <T,>(result: T): Promise<T> => {
        if (++reads === 1) {
          await db
            .updateTable("job_run")
            .set({ outcome: "succeeded", completed_at: sql`now()`, detail: "done" })
            .where("entity_id", "=", runId)
            .execute();
        }
        return result;
      };
      const watching = (builder: object): object =>
        new Proxy(builder, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              const out = value.apply(target, args);
              if (prop === "execute" || prop === "executeTakeFirst") return (out as Promise<unknown>).then(afterFirstRead);
              return out !== null && typeof out === "object" && !(out instanceof Promise) ? watching(out) : out;
            };
          },
        });
      const store = new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            const out = value.apply(target, args);
            return prop === "selectFrom" && args[0] === "job_run" ? watching(out) : out;
          };
        },
      });
      const api = new Hono().route("/api/v1", createApi({ db: store, isStaff: async () => true, jobs: { list: [], runningRun: () => null } }));
      const path = which === "one" ? `/api/v1/jobs/runs/${runId}` : "/api/v1/jobs/runs?limit=1";
      const body = (await (await api.request(path, { headers: { authorization: `Bearer ${staffKey}` } })).json()) as {
        run?: { status: string; detail: string };
        runs?: { status: string; detail: string }[];
      };
      expect(body.run ?? body.runs![0]!, which).toMatchObject({ status: "succeeded", detail: "done" });
      expect(reads, which).toBe(2);
    }
  });

  it("answers 404 for a job nobody registered and for a run that does not exist", async () => {
    const { ask, staffKey, conn } = await fixture();
    expect((await ask("/api/v1/jobs/nope", staffKey, "POST")).status).toBe(404);
    for (const id of ["999999", "0", "abc", "1e3", "99999999999999999999"]) {
      expect((await ask(`/api/v1/jobs/runs/${id}`, staffKey)).status, id).toBe(404);
    }
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM job_run`)).toEqual([[0]]);
  });

  it("is for staff keys only: a read key, or a staff key of someone who is not staff, starts and sees nothing", async () => {
    const { ask, key, conn, staffKey, idle } = await fixture();
    await ask("/api/v1/jobs/quick", staffKey, "POST");
    await idle();
    const [[runId]] = (await rows(conn, `SELECT entity_id FROM job_run`)) as [[number]];
    for (const k of [await key(STAFF_UID, "read"), await key(VOLUNTEER_UID, "staff"), await key(VOLUNTEER_UID, "read")]) {
      expect((await ask("/api/v1/jobs", k)).status).toBe(403);
      expect((await ask("/api/v1/jobs/runs", k)).status).toBe(403);
      expect((await ask(`/api/v1/jobs/runs/${runId}`, k)).status).toBe(403);
      expect((await ask("/api/v1/jobs/quick", k, "POST")).status).toBe(403);
    }
    // And nothing without a key at all.
    expect((await ask("/api/v1/jobs/quick", undefined, "POST")).status).toBe(401);
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM job_run`)).toEqual([[1]]);
  });

  it("stops working as staff the moment the person's staff rights are taken away", async () => {
    const { ask, staffKey, conn } = await fixture();
    expect((await ask("/api/v1/jobs", staffKey)).status).toBe(200);
    await conn.run(`DELETE FROM person_admin`);
    expect((await ask("/api/v1/jobs/quick", staffKey, "POST")).status).toBe(403);
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM job_run`)).toEqual([[0]]);
  });
});
