import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Kysely } from "kysely";
import type { Database } from "../model.js";
import { keyRateLimiter, keyRef, resolveKey, type KeyHolder } from "./api-keys.js";
import { reportAppError } from "./error-reporting.js";
import type { Job, StartedRun } from "./jobs/framework.js";

/**
 * The API, under /api/v1/ (beeline-pnqr).
 *
 * For programs, not browsers: every request carries a personal API key as a
 * bearer header (src/app/api-keys.ts) and every answer is JSON, errors
 * included. It is mounted ahead of the session gate and never calls it, so a
 * session cookie means nothing here; and no page reads a bearer header, so a
 * key means nothing there. The CSRF check does not apply for the same
 * reason: it protects a credential a browser sends by itself, and a browser
 * never sends this one.
 *
 * A key acts as its own person and nobody else. There is no acting for
 * another person and no impersonation through a key.
 */
export type ApiEnv = {
  Variables: {
    /** Whose key the request carries. */
    key: KeyHolder;
    /**
     * Whether the request may do what staff do: the key was made as a staff
     * key and its person holds staff rights now. Asked on every request, so
     * taking the rights away stops the key at once.
     */
    staff: boolean;
  };
};

export interface ApiDeps {
  db: Kysely<Database>;
  /** Whether a person holds staff rights now (person_admin; everyone in development). */
  isStaff: (personId: number) => Promise<boolean>;
  /** How often one key may ask; the default unless a test says otherwise. */
  limiter?: ReturnType<typeof keyRateLimiter>;
  /** The job registry and the scheduler behind it; absent, the jobs endpoints list nothing and start nothing. */
  jobs?: ApiJobs;
}

/** What the jobs endpoints need of the scheduler (src/app/jobs/framework.ts). */
export interface ApiJobs {
  list: Job[];
  startRun?(name: string): Promise<StartedRun>;
  running?(): string | null;
}

/** An error, in the one shape every failure under /api/ has. */
export const apiError = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 500, error: string, message: string, extra: Record<string, unknown> = {}) =>
  c.json({ error, message, ...extra }, status);

const unauthorized = (c: Context, message: string) => {
  c.header("www-authenticate", 'Bearer realm="Beeline API"');
  return apiError(c, 401, "unauthorized", message);
};

/** The key a request carries, or null. Only the bearer form; a key in a query string would end up in logs. */
export function bearerKey(c: Context): string | null {
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(c.req.header("authorization") ?? "");
  return match === null ? null : match[1]!;
}

/**
 * Refuse a request that carries credentials to an address the old Beeline's
 * redirects would answer (src/app/old-beeline.ts): any path under /api/ that
 * is not this API's, and the old interface's pages. Without this the answer
 * would be a redirect to old.melittologist.org, and some HTTP clients resend
 * the Authorization header when a redirect stays within the same site, so one
 * mistyped path would hand the key to another server.
 */
export const refuseStrayCredentials: MiddlewareHandler = async (c, next) => {
  if (c.req.header("authorization") === undefined) return next();
  c.header("cache-control", "no-store");
  return unauthorized(c, "No API lives at this path. Beeline's API is under /api/v1/.");
};

/** Refuses a key that may not do what staff do. */
const requireStaff: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (!c.get("staff")) return apiError(c, 403, "forbidden", "This needs a staff key held by someone who is staff.");
  await next();
};

export function createApi({ db, isStaff, limiter = keyRateLimiter(), jobs }: ApiDeps): Hono<ApiEnv> {
  const api = new Hono<ApiEnv>();

  api.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const reference = reportAppError(err, c);
    return apiError(c, 500, "failed", "Something went wrong on Beeline's side.", { reference });
  });

  api.use(async (c, next) => {
    // An answer may hold a person's records, and none is worth caching.
    c.header("cache-control", "no-store");
    const key = bearerKey(c);
    if (key === null) {
      return unauthorized(c, "Send your API key in an Authorization header: Authorization: Bearer <key>.");
    }
    // The limit is counted before the key is looked up, so a key that has
    // used up its minute costs the store nothing more: a script in a loop is
    // answered from memory. The reference is the start of the key's hash,
    // which is what the lookup would find it by.
    const ref = keyRef(key);
    const wait = limiter.take(ref);
    if (wait > 0) {
      c.header("retry-after", String(wait));
      return apiError(c, 429, "too many requests", `This key is asking too often. Wait ${wait} seconds.`);
    }
    const holder = await resolveKey(db, key);
    if (holder === null) {
      limiter.forget(ref);
      return unauthorized(c, "This API key does not work. It may have expired or been revoked.");
    }
    c.set("key", holder);
    c.set("staff", holder.scope === "staff" && (await isStaff(holder.personId)));
    await next();
  });

  // Who the key belongs to and what it may do: the first thing a program
  // asks, to check that its key works.
  api.get("/me", (c) => {
    const key = c.get("key");
    return c.json({
      person: { name: key.displayName, inat_login: key.login },
      key: { reference: key.ref, scope: key.scope, expires_at: key.expiresAt.toISOString() },
      staff: c.get("staff"),
    });
  });

  // --- Jobs (beeline-pnqr.5): what the Jobs page shows staff and its Run
  // button does, for a program. Staff keys only, as the page is staff only:
  // a run's detail is whatever the job or its error said, which can name
  // people. Starting a job takes no arguments; it is the registered job, run
  // now, exactly as the button runs it.
  api.use("/jobs/*", requireStaff);
  api.use("/jobs", requireStaff);

  const runColumns = ["entity_id", "job_name", "started_at", "completed_at", "outcome", "detail", "sla_breaches"] as const;
  type RunRow = {
    entity_id: number;
    job_name: string;
    started_at: Date;
    completed_at: Date | null;
    outcome: string | null;
    detail: string | null;
    sla_breaches: number;
  };
  /**
   * The run the scheduler has in hand, if any: the newest run of the job it
   * says is running. The scheduler names the job, not the run, and an older
   * run of the same job that the process died in must not read as running.
   */
  const liveRunId = async (): Promise<number | null> => {
    const name = jobs?.running?.() ?? null;
    if (name === null) return null;
    const row = await db
      .selectFrom("job_run")
      .select(({ fn }) => fn.max("entity_id").as("id"))
      .where("job_name", "=", name)
      .where("outcome", "is", null)
      .executeTakeFirst();
    return row?.id == null ? null : Number(row.id);
  };
  /**
   * Read runs together with which run was live while they were read. The
   * scheduler is asked on both sides of the read, because the two cannot be
   * read at one instant: asked only after, a run that finished in between
   * still shows no outcome in the rows and is no longer live, and would be
   * called unfinished though it succeeded; asked only before, a run that
   * started in between would be. A run live at either moment is running.
   */
  const withLive = async <T,>(read: () => Promise<T>): Promise<{ value: T; live: ReadonlySet<number> }> => {
    const before = await liveRunId();
    const value = await read();
    const after = await liveRunId();
    return { value, live: new Set([before, after].filter((id): id is number => id !== null)) };
  };
  /**
   * A run as the API describes it. A run with no outcome is `running` if it
   * is the one the scheduler has in hand, and `unfinished` otherwise: the
   * process stopped while it ran, and nothing will ever complete it.
   */
  const describeRun = (r: RunRow, live: ReadonlySet<number>) => ({
    id: Number(r.entity_id),
    job: r.job_name,
    status: r.outcome ?? (live.has(Number(r.entity_id)) ? "running" : "unfinished"),
    started_at: r.started_at.toISOString(),
    completed_at: r.completed_at?.toISOString() ?? null,
    detail: r.detail,
    sla_breaches: Number(r.sla_breaches),
  });

  // Every registered job, with its schedule and its latest run.
  api.get("/jobs", async (c) => {
    const { value: latest, live } = await withLive(() =>
      db
        .selectFrom("job_run")
        .select(runColumns)
        .where(({ eb, selectFrom }) =>
          eb(
            "entity_id",
            "in",
            selectFrom("job_run as latest").select(({ fn }) => fn.max("latest.entity_id").as("id")).groupBy("latest.job_name"),
          ),
        )
        .execute(),
    );
    const byJob = new Map(latest.map((r) => [r.job_name, r]));
    return c.json({
      running: jobs?.running?.() ?? null,
      jobs: (jobs?.list ?? []).map((j) => {
        const run = byJob.get(j.name);
        return { name: j.name, window: j.window, schedule: j.schedule, latest_run: run === undefined ? null : describeRun(run, live) };
      }),
    });
  });

  // Recent runs, newest first; `job` narrows to one job, `limit` to fewer.
  api.get("/jobs/runs", async (c) => {
    const limit = c.req.query("limit");
    if (limit !== undefined && !/^[1-9]\d{0,2}$/.test(limit)) {
      return apiError(c, 400, "invalid", "limit must be a whole number from 1 to 999.");
    }
    const job = c.req.query("job");
    let runs = db.selectFrom("job_run").select(runColumns);
    if (job !== undefined) runs = runs.where("job_name", "=", job);
    const { value: rows, live } = await withLive(() =>
      runs.orderBy("entity_id", "desc").limit(Math.min(Number(limit ?? 20), 200)).execute(),
    );
    return c.json({ runs: rows.map((r) => describeRun(r, live)) });
  });

  // One run, with the steps a night job recorded (job_step, schema/070).
  api.get("/jobs/runs/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2_147_483_647) return apiError(c, 404, "not found", "No such run.");
    const { value: run, live } = await withLive(() =>
      db.selectFrom("job_run").select(runColumns).where("entity_id", "=", Number(id)).executeTakeFirst(),
    );
    if (run === undefined) return apiError(c, 404, "not found", "No such run.");
    const steps = await db
      .selectFrom("job_step")
      .select(["step_number", "label", "started_at", "duration_ms", "failed"])
      .where("job_run_id", "=", Number(id))
      .orderBy("step_number")
      .execute();
    return c.json({
      run: {
        ...describeRun(run, live),
        steps: steps.map((s) => ({
          number: Number(s.step_number),
          label: s.label,
          started_at: s.started_at.toISOString(),
          duration_ms: Number(s.duration_ms),
          failed: s.failed,
        })),
      },
    });
  });

  // Start a job now. Answers as soon as the run is recorded, while the job
  // goes on, with the run to watch at GET /jobs/runs/<id>. One job runs at a
  // time, so a busy scheduler is a 409 that names what is running.
  api.post("/jobs/:name", async (c) => {
    const name = c.req.param("name");
    if (jobs?.startRun === undefined) return apiError(c, 404, "not found", `No job is called ${JSON.stringify(name)}.`);
    const started = await jobs.startRun(name);
    if (started.status === "unknown") return apiError(c, 404, "not found", `No job is called ${JSON.stringify(name)}.`);
    if (started.status === "busy") {
      return apiError(
        c,
        409,
        "busy",
        started.running === null
          ? "The scheduler is busy. Try again in a moment."
          : `The job ${started.running} is running, and one job runs at a time. Watch it at /api/v1/jobs, then try again.`,
        { running: started.running },
      );
    }
    const key = c.get("key");
    // Who started it: the run's row has no column for that yet (beeline-pnqr.7), so the log carries it.
    console.log(`[api] ${key.login} started job '${name}' as run ${started.runId} with key ${key.ref}`);
    const run = await db.selectFrom("job_run").select(runColumns).where("entity_id", "=", started.runId).executeTakeFirstOrThrow();
    c.header("location", `/api/v1/jobs/runs/${started.runId}`);
    return c.json({ run: describeRun(run, new Set([started.runId])) }, 202);
  });

  // After the key check on purpose: someone without a key learns nothing
  // about which paths exist.
  api.all("*", (c) => apiError(c, 404, "not found", "No such endpoint."));

  return api;
}
