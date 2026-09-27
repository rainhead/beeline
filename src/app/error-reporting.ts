import * as Sentry from "@sentry/node";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppConfig } from "./config.js";
import { NIGHT_END_HOUR, type Job, type JobObserver } from "./jobs/framework.js";

/**
 * Errors, logs and job check-ins, reported to Sentry (beeline-8w6.1).
 *
 * Optional by construction: with no DSN nothing is initialised, every Sentry
 * call below is a no-op, and the app behaves exactly as it did before. So
 * development, tests and a scratch app report nothing without being told.
 *
 * What leaves the machine is the other half of this file, and the rule is the
 * one `/healthz/jobs` already follows: say which thing went wrong and never
 * the record it went wrong on. An error from DuckDB quotes the offending
 * value, a stack frame's locals hold whatever row was being read, and a query
 * string holds what somebody searched for — a volunteer's name, a place. So
 * the SDK is told to collect none of the request, the user, the cookies or the
 * locals (`dataCollection`), and every message that does go — an exception's
 * text, a log line, a breadcrumb — passes through `redact` first. Identity
 * goes no further than the iNaturalist login, which is public on iNaturalist
 * already; coordinates, tokens and the session cookie never go at all.
 */

/**
 * Remove what could identify a person, a place or a credential from free
 * text, keeping its shape so the message still says what went wrong.
 *
 * - Anything quoted, because that is where DuckDB, Kysely and our own
 *   messages put the value: `Duplicate key "name: …"`, `'…' has no account`.
 * - A decimal with four or more places, which is how every coordinate in this
 *   store is written; a count or a millisecond duration never has one.
 * - A JWT, a bearer token, or a run of 32 or more hex digits: session ids,
 *   OAuth tokens and the private-store key all look like one of those.
 * - An email address.
 */
export function redact(text: string): string {
  return text
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '"[redacted]"')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "'[redacted]'")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]")
    .replace(/\b(Bearer|Token)\s+[\w.~+/=-]+/gi, "$1 [token]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[token]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/-?\b\d{1,3}\.\d{4,}\b/g, "[coordinate]");
}

const redactValue = (v: unknown): unknown => (typeof v === "string" ? redact(v) : v);

/** beforeSend: an error event, reduced to what the rule above allows. */
export function scrubEvent<E extends Sentry.ErrorEvent>(event: E): E {
  if (event.message !== undefined) event.message = redact(event.message);
  if (event.logentry?.message !== undefined) event.logentry.message = redact(event.logentry.message);
  if (event.logentry?.params !== undefined) event.logentry.params = event.logentry.params.map(redactValue);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value !== undefined) ex.value = redact(ex.value);
    for (const frame of ex.stacktrace?.frames ?? []) delete frame.vars;
  }
  // Only the login survives, and only because a request handler put it there.
  event.user = event.user?.username !== undefined ? { username: event.user.username } : undefined;
  if (event.request !== undefined) {
    const { method, url } = event.request;
    event.request = { method, url: url?.split("?")[0] };
  }
  event.extra = undefined;
  for (const crumb of event.breadcrumbs ?? []) scrubBreadcrumb(crumb);
  return event;
}

/** beforeBreadcrumb: console lines are breadcrumbs too, and carry the same risk as logs. */
export function scrubBreadcrumb<B extends Sentry.Breadcrumb>(crumb: B): B {
  if (crumb.message !== undefined) crumb.message = redact(crumb.message);
  crumb.data = undefined;
  return crumb;
}

/** beforeSendLog: a log line and its structured attributes (the console integration puts arguments there). */
export function scrubLog(log: Sentry.Log): Sentry.Log {
  const attributes =
    log.attributes === undefined
      ? undefined
      : Object.fromEntries(Object.entries(log.attributes).map(([k, v]) => [k, redactValue(v)]));
  return { ...log, message: redact(String(log.message)), attributes };
}

/** Start reporting if a DSN is configured. True when it did. */
export function initErrorReporting(
  config: Pick<AppConfig, "sentryDsn" | "environment" | "release">,
  /** For tests: a transport that records instead of sending. */
  overrides: Partial<NonNullable<Parameters<typeof Sentry.init>[0]>> = {},
): boolean {
  if (config.sentryDsn === null) return false;
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.environment,
    release: config.release ?? undefined,
    // Nothing about the request or the person is collected automatically;
    // a request handler adds the login and the route pattern by hand.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ["user-agent"] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    integrations: [
      // The console is the app's log: boot-time reconciliation counts, job
      // progress, the warnings the runbooks tell you to read. Fly keeps only
      // a rolling window of it; Sentry keeps it searchable.
      Sentry.consoleLoggingIntegration({ levels: ["log", "warn", "error"] }),
      // Node's own default is to exit on an unhandled rejection. Sentry's
      // default is to report it and carry on, which would quietly change how
      // this process fails; keep Node's behaviour, reported.
      Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
    ],
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSendLog: scrubLog,
    ...overrides,
  });
  return true;
}

/** Send what is queued, before the process exits. Resolves quickly when nothing was initialised. */
export async function flushErrorReporting(timeoutMs = 2000): Promise<void> {
  await Sentry.close(timeoutMs);
}

/**
 * Hono's error handler, reporting what it catches. Behaves as Hono's default
 * does — an HTTPException answers with its own response, anything else is a
 * logged 500 — and adds a report carrying the route pattern (`/samples/:id`,
 * never the id) and the signed-in login, if there is one.
 */
export function onAppError(err: Error, c: Context): Response | Promise<Response> {
  if (err instanceof HTTPException) return err.getResponse();
  const session = c.get("session") as { login?: string } | undefined;
  Sentry.withScope((scope) => {
    scope.setTag("route", `${c.req.method} ${c.req.routePath}`);
    if (session?.login !== undefined) scope.setUser({ username: session.login });
    Sentry.captureException(err);
  });
  // A string, not the Error: the log integration serialises an object as
  // JSON, whose every key is quoted and so redacted into nothing.
  console.error(`${c.req.method} ${c.req.routePath} failed: ${err.stack ?? err.message}`);
  return c.text("Internal Server Error", 500);
}

const LA = "America/Los_Angeles";

/** Sentry's monitor config, which the Node package uses but does not export. */
type MonitorConfig = NonNullable<Parameters<typeof Sentry.captureCheckIn>[1]>;

/**
 * How Sentry should expect a job to check in, from the schedule the
 * framework already runs it on. A night job may start as late as the end of
 * the night window, since `isDue` keeps retrying a failed one until then; an
 * interval job is late once a whole interval has passed without it.
 */
export function monitorConfig(job: Pick<Job, "schedule" | "window">): MonitorConfig {
  const base = { failureIssueThreshold: 1, recoveryThreshold: 1 };
  const s = job.schedule;
  switch (s.kind) {
    case "everyMinutes":
      return { ...base, schedule: { type: "interval", value: s.minutes, unit: "minute" }, checkinMargin: s.minutes, maxRuntime: 30 };
    case "dailyLA":
    case "weeklyLA": {
      const day = s.kind === "weeklyLA" ? String(s.weekday) : "*";
      const margin = job.window === "night" ? Math.max(60, (NIGHT_END_HOUR - s.hour) * 60) : 60;
      return {
        ...base,
        schedule: { type: "crontab", value: `0 ${s.hour} * * ${day}` },
        timezone: LA,
        checkinMargin: margin,
        maxRuntime: 6 * 60,
      };
    }
  }
}

/** A job's runs as Sentry cron check-ins, and its failure as an error with the job named. */
export const jobCheckIns: JobObserver = (job) => {
  const monitorSlug = job.name;
  const started = performance.now();
  const checkInId = Sentry.captureCheckIn({ monitorSlug, status: "in_progress" }, monitorConfig(job));
  return (outcome, err) => {
    if (outcome === "failed" && err !== undefined) {
      Sentry.withScope((scope) => {
        scope.setTag("job", job.name);
        Sentry.captureException(err);
      });
    }
    Sentry.captureCheckIn(
      {
        checkInId,
        monitorSlug,
        status: outcome === "succeeded" ? "ok" : "error",
        duration: (performance.now() - started) / 1000,
      },
      monitorConfig(job),
    );
  };
};
