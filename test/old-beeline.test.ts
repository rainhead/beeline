import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { noSession } from "../src/app/session.js";
import { OLD_BEELINE_ORIGIN, OLD_BEELINE_PAGES } from "../src/app/old-beeline.js";
import { createMemoryDb, scratchPaths } from "./helpers.js";

/**
 * beeline-83b8.12: from cutover the old Beeline runs at old.melittologist.org
 * and this app takes its address, so a volunteer's bookmark to an old page is
 * sent on rather than landing on a sign-in they were never told about.
 */
const unusedInat: InatClient = {
  authorizeUrl: () => "https://inat.example/authorize",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

async function signedOutApp() {
  const { instance } = await createMemoryDb();
  return createApp({
    ...(await scratchPaths()),
    db: createKysely(instance),
    config: { environment: "sandbox" as const, origin: "https://melittologist.org" },
    inat: unusedInat,
    resolveSession: noSession,
  });
}

describe("the old Beeline's addresses", () => {
  it("send each of the old interface's pages to the same page at its new address, query and all", async () => {
    const app = await signedOutApp();
    for (const page of OLD_BEELINE_PAGES) {
      const res = await app.request(`${page}?tab=2`);
      expect(res.status, page).toBe(302);
      expect(res.headers.get("location"), page).toBe(`${OLD_BEELINE_ORIGIN}${page}?tab=2`);
    }
  });

  it("send the old API there too, keeping the method", async () => {
    const app = await signedOutApp();
    const res = await app.request("/api/occurrences?per_page=1", { method: "POST" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${OLD_BEELINE_ORIGIN}/api/occurrences?per_page=1`);
  });

  it("leave this app's own /determinations alone, whose sign-in page says where the old Beeline went", async () => {
    const app = await signedOutApp();
    const res = await app.request("/determinations");
    // The sign-in page, which the session gate answers with 401.
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    const body = await res.text();
    expect(body).toContain(`href="${OLD_BEELINE_ORIGIN}"`);
    expect(body).toContain("old.melittologist.org");
  });

  it("never take a visitor anywhere but the old Beeline", async () => {
    const app = await signedOutApp();
    // A path that tries to smuggle in another host still names ours.
    const res = await app.request("/api//evil.example/x");
    expect(res.headers.get("location")?.startsWith(`${OLD_BEELINE_ORIGIN}/`)).toBe(true);
  });
});
