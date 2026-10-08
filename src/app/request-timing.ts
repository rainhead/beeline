import * as Sentry from "@sentry/node";
import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";

/**
 * How long each request took, so a slow page shows up before somebody
 * complains about it. Until this, nothing measured latency in normal use: Fly's
 * health check notices a process that stops answering, and `pnpm bench:pages`
 * measures a copy of the store by hand, but a page that answers in eight
 * seconds was invisible.
 *
 * Two things, in the shape the app already reports in (src/app/usage.ts,
 * src/app/error-reporting.ts):
 *
 * - every request records `request.duration` as a Sentry distribution metric,
 *   tagged with the route pattern, the method and the status — so a route's
 *   p50 and p95 can be read, and alerted on, over time;
 * - a request slower than SLOW_REQUEST_MS also writes a warning line, which
 *   reaches Sentry's searchable log like the jobs' SLA warnings do.
 *
 * The route is the pattern (`/samples/:id`), never the path, so no record id
 * and no query string leaves the process; the warning adds the signed-in
 * login, as an error report does, so a slow page can be reproduced as the
 * person who saw it. Nothing here touches the store.
 *
 * What it measures is the time to a Response, which for a streamed body — the
 * listings' CSVs — is the time to the first chunk, not to the last byte.
 */

/** Slower than this is worth a line in the log: the interactive jobs' step budget is the same second. */
export const SLOW_REQUEST_MS = 1000;

export interface RequestTimingOptions {
  slowMs?: number;
  /** Where a duration goes; Sentry's distribution metric unless a test says otherwise. */
  record?: (ms: number, attributes: Record<string, string | number>) => void;
  /** Where a slow request is reported; the console (and so Sentry's log) unless a test says otherwise. */
  warn?: (line: string) => void;
}

const recordToSentry = (ms: number, attributes: Record<string, string | number>) => {
  try {
    Sentry.metrics.distribution("request.duration", ms, { unit: "millisecond", attributes });
  } catch {
    // Reporting is best-effort: a metric is no reason to fail a page.
  }
};

/**
 * The pattern the request was answered by. After the handler has run, the last
 * matched route is the one that answered; an address nothing answers is named
 * as such rather than as the catch-all middleware it last passed through.
 */
function routeOf(c: Context): string {
  const route = routePath(c, -1);
  if (c.res.status === 404 && (route === "*" || route === "/*")) return "(not found)";
  return route;
}

export function requestTiming(opts: RequestTimingOptions = {}): MiddlewareHandler {
  const slowMs = opts.slowMs ?? SLOW_REQUEST_MS;
  const record = opts.record ?? recordToSentry;
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  return async (c, next) => {
    const started = performance.now();
    try {
      await next();
    } finally {
      const ms = Math.round(performance.now() - started);
      const route = routeOf(c);
      const status = c.res.status;
      record(ms, { route, method: c.req.method, status });
      if (ms > slowMs) {
        const login = (c.get("session") as { login?: string } | undefined)?.login;
        warn(`[request] slow: ${c.req.method} ${route} took ${ms}ms (status ${status}${login ? `, signed in as ${login}` : ""})`);
      }
    }
  };
}
