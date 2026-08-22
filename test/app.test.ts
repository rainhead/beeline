import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { noSession } from "../src/app/session.js";
import { createMemoryDb, insertCleanSample } from "./helpers.js";

const unusedInat: InatClient = {
  authorizeUrl: () => "https://inat.example/authorize",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

async function appOnMemoryDb(sessionLogin: string | null) {
  const { instance, conn } = await createMemoryDb();
  await conn.run(`INSERT INTO person (display_name) VALUES ('Test Person')`);
  await insertCleanSample(conn);
  const db = createKysely(instance);
  const resolveSession = sessionLogin === null ? noSession : async () => ({ personId: 1, login: sessionLogin, iconUrl: null });
  return createApp({
    db,
    config: { environment: "development" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession,
  });
}

describe("app scaffold", () => {
  it("health check is public", async () => {
    const app = await appOnMemoryDb(null);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
  });

  it("tokens stylesheet is public and carries MD3 color roles", async () => {
    const app = await appOnMemoryDb(null);
    const res = await app.request("/tokens.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const css = await res.text();
    expect(css).toContain("--md-sys-color-primary:");
    expect(css).toContain("prefers-color-scheme: dark");
  });

  it("no session means no page — every data route is gated", async () => {
    const app = await appOnMemoryDb(null);
    for (const path of ["/", "/patterns", "/anything-not-registered"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(401);
      expect(await res.text()).toContain("Sign in");
    }
  });

  it("a session reaches the home page, which reads the database", async () => {
    const app = await appOnMemoryDb("testuser");
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("testuser");
  });

  it("non-production environments announce themselves", async () => {
    const app = await appOnMemoryDb("testuser");
    const body = await (await app.request("/")).text();
    expect(body).toContain("env-banner");
    expect(body).toContain("blown away");
  });

  it("the string-proofing page renders every catalog entry with visible slots", async () => {
    const app = await appOnMemoryDb("testuser");
    const res = await app.request("/patterns/messages");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("qc.summary");
    expect(body).toContain("qcInstructions.locality_format");
  });

  it("the QC-state proofing page renders every fixture state", async () => {
    const app = await appOnMemoryDb("testuser");
    const res = await app.request("/patterns/qc");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("All clear, synced");
    expect(body).toContain("never synced");
    expect(body).toContain("OBAS-00657");
    expect(body).toContain("blocks printing");
    expect(body).toContain("https://www.inaturalist.org/observations/123456789");
  });

  it("the pattern library renders with its island tag", async () => {
    const app = await appOnMemoryDb("testuser");
    const res = await app.request("/patterns");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Pattern library");
    expect(body).toContain("<demo-counter>");
  });
});
