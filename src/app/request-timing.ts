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
 * What it measures is the time to a Response. A listing's CSV does its real
 * work after that, a page at a time as the client reads, so that work is
 * timed where it happens: csvGenerationTiming below, `csv.generation`.
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
 * The pattern the request was answered by. After the handler has run, the
 * route index is the one that answered — not the last route that matched,
 * which can be a catch-all registered later that never ran; an address
 * nothing answers is named as such rather than as the middleware it last
 * passed through.
 */
function routeOf(c: Context): string {
  const route = routePath(c);
  if (c.res.status === 404 && (route === "*" || route === "/*")) return "(not found)";
  return route;
}

/** How a streamed CSV ended, and how long its pages spent in the store. Called once per download. */
export type CsvTiming = (storeMs: number, rows: number, outcome: "complete" | "failed" | "cancelled") => void;

/**
 * The work a listing CSV does after its response has gone: csvStream fetches
 * page after page as the client reads, so request.duration ends at the
 * header row and sees none of it. Timing the whole stream instead would charge
 * a slow connection to the server; what is measured is the time spent in the
 * store fetching pages, as `csv.generation`, with a slow line past the same
 * second.
 */
export function csvGenerationTiming(listing: string, opts: RequestTimingOptions = {}): CsvTiming {
  const slowMs = opts.slowMs ?? SLOW_REQUEST_MS;
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  const record =
    opts.record ??
    ((ms: number, attributes: Record<string, string | number>) => {
      try {
        Sentry.metrics.distribution("csv.generation", ms, { unit: "millisecond", attributes });
      } catch {
        // Best-effort, as above.
      }
    });
  return (storeMs, rows, outcome) => {
    const ms = Math.round(storeMs);
    record(ms, { listing, outcome, rows });
    if (ms > slowMs) warn(`[request] slow: ${listing} CSV spent ${ms}ms in the store for ${rows} rows (${outcome})`);
  };
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
