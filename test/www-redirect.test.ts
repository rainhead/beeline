import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { noSession } from "../src/app/session.js";
import { createMemoryDb, scratchPaths } from "./helpers.js";

/**
 * beeline-83b8.14: www.melittologist.org points at this app too, but the CSRF
 * check and the OAuth redirect both name the one origin, so a form submitted
 * from www was refused. Requests to the www name are sent to the origin.
 */
const unusedInat: InatClient = {
  authorizeUrl: () => "https://inat.example/authorize",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

async function productionApp() {
  const { instance } = await createMemoryDb();
  return createApp({
    ...(await scratchPaths()),
    db: createKysely(instance),
    config: { environment: "production" as const, origin: "https://melittologist.org" },
    inat: unusedInat,
    resolveSession: noSession,
  });
}

describe("the www name", () => {
  it("is sent to the same page on the origin, query and all", async () => {
    const app = await productionApp();
    const res = await app.request("/samples?scope=mine", { headers: { host: "www.melittologist.org" } });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://melittologist.org/samples?scope=mine");
    // Registered after the security headers, so the redirect carries them.
    expect(res.headers.get("content-security-policy")).not.toBeNull();
  });

  it("is matched whatever its case", async () => {
    const app = await productionApp();
    const res = await app.request("/samples", { headers: { host: "WWW.Melittologist.org" } });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://melittologist.org/samples");
  });

  it("sends a form submitted there on rather than refusing it as cross-origin", async () => {
    const app = await productionApp();
    const res = await app.request("/samples", {
      method: "POST",
      headers: { host: "www.melittologist.org", origin: "https://www.melittologist.org" },
    });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://melittologist.org/samples");
  });

  it("never takes a visitor to another host", async () => {
    const app = await productionApp();
    const res = await app.request("//evil.example/x", { headers: { host: "www.melittologist.org" } });
    expect(res.headers.get("location")?.startsWith("https://melittologist.org/")).toBe(true);
  });
});

describe("the names that answer as themselves", () => {
  for (const host of ["melittologist.org", "beeline-production.fly.dev"]) {
    it(`${host} is not redirected`, async () => {
      const app = await productionApp();
      const res = await app.request("/samples?scope=mine", { headers: { host } });
      // The sign-in page, which the session gate answers with 401.
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
    });
  }

  it("a request with no Host header is not redirected", async () => {
    const app = await productionApp();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
  });

  it("the health check on the .fly.dev name still answers", async () => {
    const app = await productionApp();
    const res = await app.request("/healthz", { headers: { host: "beeline-production.fly.dev" } });
    expect(res.status).toBe(200);
  });
});
