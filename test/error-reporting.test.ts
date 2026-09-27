import * as Sentry from "@sentry/node";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import {
  initErrorReporting,
  jobCheckIns,
  monitorConfig,
  onAppError,
  redact,
  scrubEvent,
  scrubLog,
} from "../src/app/error-reporting.js";
import { runJob, type Job } from "../src/app/jobs/framework.js";
import { buildJobs } from "../src/app/jobs/registry.js";
import { createMemoryDb } from "./helpers.js";

// Synthetic values throughout: made-up names, coordinates and tokens in the
// shapes the real messages take. No volunteer's data belongs in a test file
// in a public repository.

describe("redact", () => {
  it("removes quoted values, which is where DuckDB and our own messages put them", () => {
    expect(redact('Constraint Error: Duplicate key "display_name: Ada Example" violates unique constraint')).toBe(
      'Constraint Error: Duplicate key "[redacted]" violates unique constraint',
    );
    expect(redact("BEELINE_DEV_LOGIN 'adaexample' has no inat_account")).toBe(
      "BEELINE_DEV_LOGIN '[redacted]' has no inat_account",
    );
  });

  it("removes coordinates, tokens and email addresses", () => {
    expect(redact("moved to 44.56789,-123.26123 ±20 m")).toBe("moved to [coordinate],[coordinate] ±20 m");
    expect(redact(`session ${"ab12".repeat(10)} expired`)).toBe("session [token] expired");
    expect(redact("Authorization: Bearer abc.def-ghi")).toBe("Authorization: Bearer [token]");
    expect(redact("jwt eyJhbGciOi.eyJzdWIiOjF9.c2lnbmF0dXJl rejected")).toBe("jwt [token] rejected");
    expect(redact("mail ada@example.org about it")).toBe("mail [email] about it");
  });

  it("leaves counts, durations and job names readable", () => {
    const lines = [
      "recorded 34356 sample change(s) made while the app was down",
      "[job nightly-pipeline] succeeded: 454 samples minted; elevation 262/692 filled",
      "SLA breach: step 'fetch' took 1234ms (budget 1000ms)".replace(/'fetch'/, "fetch"),
      "shutdown exceeded 110000ms; exiting without a clean close",
    ];
    for (const line of lines) expect(redact(line)).toBe(line);
  });
});

describe("scrubEvent", () => {
  it("keeps the method, the path and the login, and nothing else about the request or the person", () => {
    const event = scrubEvent({
      type: undefined,
      message: 'no sample "Ada Example 2025-07-01"',
      user: { username: "adaexample", email: "ada@example.org", ip_address: "10.0.0.1", id: "722396" },
      request: {
        method: "GET",
        url: "https://beeline.example/people/adaexample?q=Ada+Example",
        cookies: { beeline_session: "secret" },
        headers: { cookie: "beeline_session=secret", "user-agent": "test" },
        query_string: "q=Ada+Example",
        data: { lat: 44.56789 },
      },
      extra: { row: { lat: 44.56789 } },
      exception: {
        values: [
          {
            type: "Error",
            value: "bad point 44.56789,-123.26123",
            stacktrace: { frames: [{ function: "f", vars: { lat: 44.56789 } }] },
          },
        ],
      },
      breadcrumbs: [{ message: "reading 'Ada Example'", data: { lat: 44.56789 } }],
    });
    expect(event.user).toEqual({ username: "adaexample" });
    expect(event.request).toEqual({ method: "GET", url: "https://beeline.example/people/adaexample" });
    expect(event.extra).toBeUndefined();
    expect(event.message).toBe('no sample "[redacted]"');
    expect(event.exception?.values?.[0]?.value).toBe("bad point [coordinate],[coordinate]");
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars).toBeUndefined();
    expect(event.breadcrumbs?.[0]).toEqual({ message: "reading '[redacted]'", data: undefined });
  });
});

describe("scrubLog", () => {
  it("redacts the message and every string attribute", () => {
    const log = scrubLog({
      level: "warn",
      message: "admin seed: no inat_account for 'adaexample'",
      attributes: { "sentry.message.parameter.0": "44.56789", count: 3 },
    });
    expect(log.message).toBe("admin seed: no inat_account for '[redacted]'");
    expect(log.attributes).toEqual({ "sentry.message.parameter.0": "[coordinate]", count: 3 });
  });

  it("reaches strings nested in objects and arrays", () => {
    const log = scrubLog({
      level: "error",
      message: "failed:",
      attributes: { err: { message: "no sample 'Ada Example'", points: ["44.56789"], code: 7 } },
    });
    expect(log.attributes).toEqual({ err: { message: "no sample '[redacted]'", points: ["[coordinate]"], code: 7 } });
  });
});

describe("monitorConfig", () => {
  const jobs = buildJobs({
    syncProjects: [18521],
    sweepDays: 365,
    personChangesPath: "unused",
    sampleChangesPath: "unused",
    sampleStatePath: "unused",
  });
  const config = (name: string) => monitorConfig(jobs.find((j) => j.name === name)!);

  it("expects the nightly at 2am Pacific, and late only once the night window has closed", () => {
    expect(config("nightly-pipeline")).toMatchObject({
      schedule: { type: "crontab", value: "0 2 * * *" },
      timezone: "America/Los_Angeles",
      checkinMargin: 180,
    });
  });

  it("expects the sweep on Sunday mornings and the session purge every hour", () => {
    expect(config("weekly-sweep")).toMatchObject({ schedule: { type: "crontab", value: "0 3 * * 0" } });
    expect(config("session-purge")).toMatchObject({ schedule: { type: "interval", value: 60, unit: "minute" } });
  });
});

describe("runJob's observer", () => {
  const job = (run: Job["run"]): Job => ({
    name: "observed",
    schedule: { kind: "everyMinutes", minutes: 1 },
    window: "interactive",
    run,
  });
  const deps = async () => {
    const { instance, conn } = await createMemoryDb();
    return { db: createKysely(instance), conn };
  };

  it("hears each run end exactly once, with the error when it failed", async () => {
    const heard: Array<[string, unknown]> = [];
    const observe = () => (outcome: string, err?: unknown) => void heard.push([outcome, err]);
    const d = await deps();
    await runJob({ ...d, observe }, job(async () => "fine"));
    const boom = new Error("upstream said 503");
    await runJob(
      { ...d, observe },
      job(async () => {
        throw boom;
      }),
    );
    expect(heard).toEqual([
      ["succeeded", undefined],
      ["failed", boom],
    ]);
  });

  it("still runs and records the job when the observer throws", async () => {
    const d = await deps();
    const throwsAtStart = () => {
      throw new Error("observer broke");
    };
    const throwsAtEnd = () => () => {
      throw new Error("observer broke");
    };
    await runJob({ ...d, observe: throwsAtStart }, job(async () => "first"));
    await runJob({ ...d, observe: throwsAtEnd }, job(async () => "second"));
    const runs = await d.db.selectFrom("job_run").select(["outcome", "detail"]).orderBy("entity_id").execute();
    expect(runs).toEqual([
      { outcome: "succeeded", detail: "first" },
      { outcome: "succeeded", detail: "second" },
    ]);
  });
});

describe("with Sentry initialised", () => {
  // A transport that records envelopes instead of sending them: what a test
  // can see here is exactly what would leave the machine.
  const sent: unknown[] = [];
  const start = () =>
    initErrorReporting(
      { sentryDsn: "https://public@example.invalid/1", environment: "sandbox", release: "test" },
      {
        transport: () => ({
          send: async (envelope: unknown) => {
            sent.push(envelope);
            return {};
          },
          flush: async () => true,
        }),
      },
    );
  const items = () =>
    sent.flatMap((envelope) => (envelope as [unknown, Array<[{ type: string }, unknown]>])[1]);
  const ofType = (type: string) => items().filter(([header]) => header.type === type).map(([, body]) => body);

  afterEach(async () => {
    await Sentry.close(100);
    sent.length = 0;
  });

  it("is off without a DSN, and the app's handler still answers a thrown route with a 500", async () => {
    expect(initErrorReporting({ sentryDsn: null, environment: "development", release: null })).toBe(false);
    const app = new Hono();
    app.onError(onAppError);
    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    app.get("/teapot", () => {
      throw new HTTPException(418, { message: "short and stout" });
    });
    const boom = await app.request("/boom");
    expect(boom.status).toBe(500);
    expect(await boom.text()).toBe("Internal Server Error");
    expect((await app.request("/teapot")).status).toBe(418);
  });

  it("reports a failed request with its route pattern and login, and no cookie or coordinate", async () => {
    expect(start()).toBe(true);
    const app = new Hono<{ Variables: { session: { login: string } } }>();
    app.onError(onAppError);
    app.use(async (c, next) => {
      c.set("session", { login: "adaexample" });
      await next();
    });
    app.get("/samples/:id", () => {
      throw new Error('Conversion Error: could not read "44.56789" as a date');
    });
    const res = await app.request("/samples/123?q=Ada", { headers: { cookie: "beeline_session=secret" } });
    expect(res.status).toBe(500);
    await Sentry.flush(1000);

    const [event] = ofType("event") as Sentry.ErrorEvent[];
    expect(event).toBeDefined();
    expect(event!.environment).toBe("sandbox");
    expect(event!.release).toBe("test");
    expect(event!.tags).toMatchObject({ route: "GET /samples/:id" });
    expect(event!.user).toEqual({ username: "adaexample" });
    expect(event!.exception?.values?.[0]?.value).toBe('Conversion Error: could not read "[redacted]" as a date');
    // Source lines around each frame are sent too, and this test's own source
    // contains the very strings it checks for; code is public, data is not.
    const source = new Set(["pre_context", "context_line", "post_context"]);
    const wire = JSON.stringify(sent, (key, value) => (source.has(key) ? undefined : value));
    expect(wire).not.toContain("secret");
    expect(wire).not.toContain("44.56789");
  });

  it("checks a job in and out, and reports its failure with the job named", async () => {
    start();
    const { instance, conn } = await createMemoryDb();
    await runJob(
      { db: createKysely(instance), conn, observe: jobCheckIns },
      {
        name: "nightly-pipeline",
        schedule: { kind: "dailyLA", hour: 2 },
        window: "night",
        run: async () => {
          throw new Error("upstream said 503");
        },
      },
    );
    await Sentry.flush(1000);

    const checkIns = ofType("check_in") as Array<{ monitor_slug: string; status: string }>;
    expect(checkIns.map((c) => [c.monitor_slug, c.status])).toEqual([
      ["nightly-pipeline", "in_progress"],
      ["nightly-pipeline", "error"],
    ]);
    const [event] = ofType("event") as Sentry.ErrorEvent[];
    expect(event!.tags).toMatchObject({ job: "nightly-pipeline" });
  });
});
