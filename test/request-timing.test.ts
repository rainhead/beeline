import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { csvGenerationTiming, requestTiming } from "../src/app/request-timing.js";

/**
 * Request timing: every request's duration by route pattern, and a warning
 * for a slow one. The recorder and the warning are injected; in the app they
 * are Sentry's distribution metric and the console.
 */

function app(slowMs = 50) {
  const recorded: Array<{ ms: number; attributes: Record<string, string | number> }> = [];
  const warnings: string[] = [];
  const a = new Hono<{ Variables: { session: { login: string } | undefined } }>();
  a.use(requestTiming({ slowMs, record: (ms, attributes) => recorded.push({ ms, attributes }), warn: (l) => warnings.push(l) }));
  a.onError((_err, c) => c.text("failed", 500));
  a.use(async (c, next) => {
    if (c.req.header("x-login")) c.set("session", { login: c.req.header("x-login")! });
    await next();
  });
  a.get("/fast", (c) => c.text("ok"));
  a.get("/samples/:id", async (c) => {
    await new Promise((r) => setTimeout(r, 80));
    return c.text(`sample ${c.req.param("id")}`);
  });
  a.get("/broken", () => {
    throw new Error("nope");
  });
  // Registered after the routes and matching everything: a handler that
  // answers never reaches it, so it must not be what the request is named by.
  a.use("*", async (_c, next) => {
    await next();
  });
  return { a, recorded, warnings };
}

describe("CSV generation timing", () => {
  test("records the store time by listing and outcome, and warns past the threshold", () => {
    const recorded: Array<{ ms: number; attributes: Record<string, string | number> }> = [];
    const warnings: string[] = [];
    const timing = csvGenerationTiming("specimens", { slowMs: 1000, record: (ms, attributes) => recorded.push({ ms, attributes }), warn: (l) => warnings.push(l) });
    timing(420.4, 1000, "complete");
    timing(2345.6, 394493, "cancelled");
    expect(recorded).toEqual([
      { ms: 420, attributes: { listing: "specimens", outcome: "complete" } },
      { ms: 2346, attributes: { listing: "specimens", outcome: "cancelled" } },
    ]);
    expect(warnings).toEqual(["[request] slow: specimens CSV spent 2346ms in the store for 394493 rows (cancelled)"]);
  });
});

describe("request timing", () => {
  test("records each request by its route pattern, never its path or query", async () => {
    const { a, recorded, warnings } = app();
    await a.request("/fast?secret=1");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.attributes).toEqual({ route: "/fast", method: "GET", status: 200 });
    expect(recorded[0]!.ms).toBeGreaterThanOrEqual(0);
    expect(warnings).toEqual([]);
  });

  test("a slow request is also a warning naming the route, the time and who was signed in", async () => {
    const { a, recorded, warnings } = app();
    await a.request("/samples/722396", { headers: { "x-login": "rainhead" } });
    expect(recorded[0]!.attributes).toEqual({ route: "/samples/:id", method: "GET", status: 200 });
    expect(recorded[0]!.ms).toBeGreaterThanOrEqual(80);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\[request\] slow: GET \/samples\/:id took \d+ms \(status 200, signed in as rainhead\)$/);
    expect(warnings[0]).not.toContain("722396");
  });

  test("an address nothing answers, and a handler that throws, are counted with the status they ended on", async () => {
    const { a, recorded } = app();
    await a.request("/no/such/page");
    await a.request("/broken");
    expect(recorded.map((r) => r.attributes)).toEqual([
      { route: "(not found)", method: "GET", status: 404 },
      { route: "/broken", method: "GET", status: 500 },
    ]);
  });
});
