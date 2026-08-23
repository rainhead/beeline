import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { noSession } from "../src/app/session.js";
import { createMemoryDb, insertCleanSample } from "./helpers.js";
import { DESIGN_SECTIONS } from "../src/app/views/design/shell.js";
import { en } from "../src/app/messages/en.js";

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
    // MD3 generates error and stops; warning and success are ours (/design/color).
    expect(css).toContain("--md-sys-color-warning-container:");
    expect(css).toContain("--md-sys-color-success-container:");
  });

  it("a seed query regenerates the palette, and a bad one falls back", async () => {
    const app = await appOnMemoryDb(null);
    const reseeded = await (await app.request("/tokens.css?seed=%23264653")).text();
    const fallback = await (await app.request("/tokens.css?seed=octarine")).text();
    const base = await (await app.request("/tokens.css")).text();
    expect(reseeded).toContain("seed #264653");
    expect(reseeded).not.toBe(base);
    expect(fallback).toBe(base);
  });

  it("no session means no page — every data route is gated", async () => {
    const app = await appOnMemoryDb(null);
    for (const path of ["/", "/design", "/glossary", "/anything-not-registered"]) {
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
    const res = await app.request("/design/messages");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("qc.summary");
    expect(body).toContain("qcInstructions.locality_format");
    expect(body).toContain("glossary.entries.sample.definition");
  });

  it("the QC-state proofing page renders every fixture state", async () => {
    const app = await appOnMemoryDb("testuser");
    const res = await app.request("/design/qc");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("All clear, synced");
    expect(body).toContain("never synced");
    expect(body).toContain("OBAS-00657");
    expect(body).toContain("blocks printing");
    expect(body).toContain("https://www.inaturalist.org/observations/123456789");
  });

  it("every design section is reachable, so none can be orphaned", async () => {
    const app = await appOnMemoryDb("testuser");
    for (const section of DESIGN_SECTIONS) {
      const res = await app.request(section.path);
      expect(res.status, section.path).toBe(200);
      // Each page carries the nav, so a section that renders is a section
      // you can get back out of.
      expect(await res.text(), section.path).toContain(`href="/design/color"`);
    }
  });

  it("the component library page renders its island tag", async () => {
    const app = await appOnMemoryDb("testuser");
    const body = await (await app.request("/design/components")).text();
    expect(body).toContain("<demo-counter>");
    // Set by construction, not by eye: subgenus parenthesised and italic,
    // the rank abbreviation upright (/design/names).
    expect(body).toContain("<i>Bombus</i> (<i>Psithyrus</i>)");
    expect(body).toContain("<i>Andrena</i> sp.");
  });

  it("the pattern library's old paths redirect", async () => {
    const app = await appOnMemoryDb("testuser");
    for (const [from, to] of [
      ["/patterns", "/design"],
      ["/patterns/messages", "/design/messages"],
      ["/patterns/qc", "/design/qc"],
    ]) {
      const res = await app.request(from!);
      expect(res.status, from).toBe(301);
      expect(res.headers.get("location"), from).toBe(to);
    }
  });

  it("the glossary is volunteer-facing, and every linked term resolves to an anchor", async () => {
    const app = await appOnMemoryDb("testuser");
    const glossary = await (await app.request("/glossary")).text();
    for (const slug of Object.keys(en.glossary.entries)) {
      expect(glossary, slug).toContain(`id="${slug}"`);
    }
    // Anything that links into the glossary must land somewhere real.
    const linking = await (await app.request("/design/components")).text();
    const targets = [...linking.matchAll(/href="\/glossary#([^"]+)"/g)].map((mm) => mm[1]!);
    expect(targets.length).toBeGreaterThan(0);
    for (const slug of targets) {
      expect(Object.keys(en.glossary.entries), slug).toContain(slug);
    }
  });
});
