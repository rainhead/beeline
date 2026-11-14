import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Kysely } from "kysely";
import type { Database } from "../model.js";
import { hashKey, keyRateLimiter, keyRef, resolveKey, type KeyHolder } from "./api-keys.js";
import { BadBody, check, parseObject, referenceOf, registerCorrectionRoutes, smallBody } from "./api-corrections.js";
import { ReadQueue } from "./api-queue.js";
import { registerReadRoutes, type ReadDeps } from "./api-read.js";
import { describeApi } from "./api-description.js";
import { atlasOptions } from "./listings.js";
import { isWriteConflict } from "../write-conflict.js";
import type { CorrectionDeps } from "./sample-corrections.js";
import type { Messages } from "./messages/index.js";
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
    /**
     * What the handler answered, for the record of the request
     * (`api_key_use.outcome`): `saved`, `removed`, `unchanged`, `would_save`,
     * a refusal's name, `recorded_not_applied`, `started`. Unset where no
     * handler said.
     */
    outcome?: string;
    /** Set by the catch-all: no route answered, so there is nothing to record. */
    noRoute?: boolean;
    /** The caller's pointer to the request behind this one (`api_key_use.reference`). */
    reference?: string;
  };
};

export interface ApiDeps {
  db: Kysely<Database>;
  /** Whether a person holds staff rights now (person_admin; everyone in development). */
  isStaff: (personId: number) => Promise<boolean>;
  /**
   * How often one person may ask, all their keys together; the default unless
   * a test says otherwise.
   */
  limiter?: ReturnType<typeof keyRateLimiter>;
  /** The lower limit on reading listings, counts and records, per person (60 a minute by default). */
  readLimiter?: ReturnType<typeof keyRateLimiter>;
  /** The line the read endpoints share (two at a time, twenty waiting by default). */
  readQueue?: ReadQueue;
  /**
   * What the sample corrections need (src/app/api-corrections.ts): the
   * functions' dependencies, and the catalogue for the reasons they store
   * (`messagesFor(null)`: a key has no language of its own). Absent, they
   * answer 503.
   */
  corrections?: { deps: CorrectionDeps; messages: Messages };
  /**
   * What reading records needs (src/app/api-read.ts). Absent, the listings and
   * records answer 503; the counts and the description need only the store.
   */
  read?: ReadDeps;
  /** The job registry and the scheduler behind it; absent, the jobs endpoints list nothing and start nothing. */
  jobs?: ApiJobs;
}

/** What the jobs endpoints need of the scheduler (src/app/jobs/framework.ts). */
export interface ApiJobs {
  list: Job[];
  startRun?(name: string): Promise<StartedRun>;
  running?(): string | null;
  /** The id of the run in hand, if any (Scheduler.runningRun). */
  runningRun?(): number | null;
}

/** An error, in the one shape every failure under /api/ has. */
export const apiError = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503, error: string, message: string, extra: Record<string, unknown> = {}) =>
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
  if (!c.get("staff")) {
    c.set("outcome", "forbidden");
    return apiError(c, 403, "forbidden", "This needs a staff key held by someone who is staff.");
  }
  await next();
};

/** Whether a request reads records through the endpoints that cost the store most: the listings, counts and records. */
const isRead = (c: Context) => c.req.method === "GET" && /^(\/api\/v1)?\/(samples|specimens)(\/|$)/.test(new URL(c.req.url).pathname);

/** How long the owner of a working key is remembered, so that a key's requests are counted against its person before the store is asked. */
const OWNER_MEMORY_MS = 60_000;

export function createApi({
  db,
  isStaff,
  limiter = keyRateLimiter(),
  readLimiter = keyRateLimiter({ limit: 60 }),
  readQueue = new ReadQueue(),
  jobs,
  corrections,
  read,
}: ApiDeps): Hono<ApiEnv> {
  const api = new Hono<ApiEnv>();
  /** key reference → who owns it, for as long as that is remembered. */
  const owners = new Map<string, { owner: string; until: number }>();

  api.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const reference = reportAppError(err, c);
    return apiError(c, 500, "failed", "Something went wrong on Beeline's side.", { reference });
  });

  // Which key made each request that is not a read, and what came of it,
  // written once the request has been answered (beeline-pnqr.6). First, so
  // that it sees the answer whoever gave it. A request with no working key has
  // no key to name, and one that no route answered has nothing to say, so
  // neither is recorded. Losing this write never fails the request, since the
  // answer is already decided, but it is logged, a write conflict included: a
  // missing row is a gap in the trace from a change to a key.
  api.use(async (c, next) => {
    await next();
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.get("key") === undefined || c.get("noRoute") === true) return;
    try {
      const subject = c.req.param("id") ?? c.req.param("name");
      await db
        .insertInto("api_key_use")
        .values({
          key_sha256: hashKey(bearerKey(c)!),
          method: c.req.method,
          route: c.req.routePath,
          subject: subject === undefined ? null : subject.slice(0, 200),
          outcome: c.get("outcome") ?? null,
          reference: c.get("reference") ?? null,
          status: c.res.status,
        })
        .execute();
    } catch (err) {
      const why = isWriteConflict(err) ? "a write conflict" : (err as Error).message;
      console.warn(`[api] could not record the use of key ${c.get("key").ref}: ${why}`);
    }
  });

  api.use(async (c, next) => {
    // An answer may hold a person's records, and none is worth caching.
    c.header("cache-control", "no-store");
    const key = bearerKey(c);
    if (key === null) {
      return unauthorized(c, "Send your API key in an Authorization header: Authorization: Bearer <key>.");
    }
    // The limit is counted before the key is looked up, so a key over its
    // limit costs the store nothing more: a script in a loop is answered from
    // memory. It is counted against the key's person, so that ten keys share
    // one budget. Who owns a key is known only after a lookup, so the owner of
    // each working key is remembered in memory for a minute after it, and
    // requests in that time are counted against the owner without asking the
    // store. A key not remembered is counted against its own reference, which
    // is the start of its hash, until its first lookup succeeds.
    const ref = keyRef(key);
    const now = Date.now();
    if (owners.size > 1000) for (const [k, o] of owners) if (o.until <= now) owners.delete(k);
    const remembered = owners.get(ref);
    const known = remembered !== undefined && remembered.until > now ? remembered.owner : null;
    const budget = known === null ? ref : `person:${known}`;
    const wait = limiter.take(budget);
    if (wait > 0) {
      c.header("retry-after", String(wait));
      return apiError(c, 429, "too many requests", `This key is asking too often. Wait ${wait} seconds.`);
    }
    if (isRead(c)) {
      const readWait = readLimiter.take(budget);
      if (readWait > 0) {
        c.header("retry-after", String(readWait));
        return apiError(c, 429, "too many requests", `Reading records is limited to 60 requests a minute for each person, all their keys together. Wait ${readWait} seconds.`);
      }
    }
    const holder = await resolveKey(db, key);
    if (holder === null) {
      owners.delete(ref);
      if (known === null) {
        limiter.forget(ref);
        readLimiter.forget(ref);
      }
      return unauthorized(c, "This API key does not work. It may have expired or been revoked.");
    }
    owners.set(ref, { owner: String(holder.inatUserId), until: now + OWNER_MEMORY_MS });
    // A key not remembered has so far been counted against its own reference.
    // Now that its owner is known the request is counted against the owner too,
    // so that a person's budget is exactly the limit, however many keys they
    // have just started. At most one lookup per key a minute is spent on a
    // request this refuses.
    if (known === null) {
      const personBudget = `person:${holder.inatUserId}`;
      const late = limiter.take(personBudget);
      const lateRead = isRead(c) ? readLimiter.take(personBudget) : 0;
      if (late > 0 || lateRead > 0) {
        c.header("retry-after", String(Math.max(late, lateRead)));
        return apiError(c, 429, "too many requests", `This key is asking too often. Wait ${Math.max(late, lateRead)} seconds.`);
      }
    }
    c.set("key", holder);
    c.set("staff", holder.scope === "staff" && (await isStaff(holder.personId)));
    await next();
  });

  // The read endpoints share one short line, whoever asks. A turn is given
  // back on every path, an error and a client that went away included.
  api.use(async (c, next) => {
    if (!isRead(c)) return next();
    const release = await readQueue.acquire(c.req.raw.signal);
    if (release === null) {
      c.header("retry-after", "2");
      return apiError(c, 429, "too many requests", "Beeline is answering as many readers as it can at once. Try again in a couple of seconds.");
    }
    try {
      await next();
    } finally {
      release();
    }
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

  // What the API is, for a program or an assistant to read before it asks
  // anything (beeline-pnqr.2). Behind the same key check as everything else.
  api.get("/", async (c) => {
    const origin = read?.origin ?? new URL(c.req.url).origin;
    return c.json(describeApi(origin, (await atlasOptions(db)).map((a) => a.code)));
  });

  // Reading samples and specimens as the pages show them (beeline-pnqr.2),
  // in their own file.
  registerReadRoutes(api, db, read);

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
   * Read runs and settle which of them are live. A row and the scheduler
   * cannot be read at one instant, so the scheduler is asked for the run it
   * has in hand on both sides of the read, and a run with no outcome that
   * neither answer names is read once more. That last read decides it: the
   * scheduler lets go of a run only after its outcome is written
   * (Scheduler.runningRun), so a run that was merely finishing shows its
   * outcome by then, and one that still shows none has no process behind it.
   */
  const settled = async <T,>(
    read: () => Promise<T>,
    rowsOf: (value: T) => RunRow[],
  ): Promise<{ value: T; describe: (r: RunRow) => ReturnType<typeof describeRun> }> => {
    const live = new Set<number>();
    const note = () => {
      const id = jobs?.runningRun?.() ?? null;
      if (id !== null) live.add(id);
    };
    note();
    const value = await read();
    note();
    const unsure = rowsOf(value).filter((r) => r.outcome === null && !live.has(Number(r.entity_id)));
    const again =
      unsure.length === 0
        ? []
        : await db
            .selectFrom("job_run")
            .select(runColumns)
            .where("entity_id", "in", unsure.map((r) => Number(r.entity_id)))
            .execute();
    const latest = new Map(again.map((r) => [Number(r.entity_id), r]));
    return { value, describe: (r) => describeRun(latest.get(Number(r.entity_id)) ?? r, live) };
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
    const { value: latest, describe } = await settled(
      () =>
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
      (rows) => rows,
    );
    const byJob = new Map(latest.map((r) => [r.job_name, r]));
    return c.json({
      running: jobs?.running?.() ?? null,
      jobs: (jobs?.list ?? []).map((j) => {
        const run = byJob.get(j.name);
        return { name: j.name, window: j.window, schedule: j.schedule, latest_run: run === undefined ? null : describe(run) };
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
    const { value: rows, describe } = await settled(
      () => runs.orderBy("entity_id", "desc").limit(Math.min(Number(limit ?? 20), 200)).execute(),
      (found) => found,
    );
    return c.json({ runs: rows.map(describe) });
  });

  // One run, with the steps a night job recorded (job_step, schema/070).
  api.get("/jobs/runs/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2_147_483_647) return apiError(c, 404, "not found", "No such run.");
    const { value: run, describe } = await settled(
      () => db.selectFrom("job_run").select(runColumns).where("entity_id", "=", Number(id)).executeTakeFirst(),
      (found) => (found === undefined ? [] : [found]),
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
        ...describe(run),
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
  api.post("/jobs/:name", smallBody, async (c) => {
    const name = c.req.param("name");
    // An optional body, `{ "reference": "..." }`: a pointer to the request
    // behind the start, kept in the record of the key's use. No body, or an
    // empty one, is as it always was; anything else in it is refused.
    try {
      const text = await c.req.text();
      if (text.trim() !== "") c.set("reference", referenceOf(check(parseObject(text), { reference: "string" })));
    } catch (err) {
      if (!(err instanceof BadBody)) throw err;
      c.set("outcome", "invalid_request");
      return apiError(c, 400, "invalid_request", err.message);
    }
    if (jobs?.startRun === undefined) {
      c.set("outcome", "not_found");
      return apiError(c, 404, "not found", `No job is called ${JSON.stringify(name)}.`);
    }
    const started = await jobs.startRun(name);
    if (started.status === "unknown") {
      c.set("outcome", "not_found");
      return apiError(c, 404, "not found", `No job is called ${JSON.stringify(name)}.`);
    }
    if (started.status === "busy") {
      c.set("outcome", "busy");
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
    c.set("outcome", "started");
    c.header("location", `/api/v1/jobs/runs/${started.runId}`);
    return c.json({ run: describeRun(run, new Set([started.runId])) }, 202);
  });

  // The sample corrections (beeline-pnqr.6), in their own file.
  registerCorrectionRoutes(api, corrections);

  // After the key check on purpose: someone without a key learns nothing
  // about which paths exist.
  api.all("*", (c) => {
    c.set("noRoute", true);
    return apiError(c, 404, "not found", "No such endpoint.");
  });

  return api;
}
