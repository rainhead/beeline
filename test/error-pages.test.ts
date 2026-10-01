import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import type { AppConfig } from "../src/app/config.js";
import { en } from "../src/app/messages/en.js";
import { staticErrorPage } from "../src/app/views/error-page.js";
import { createMemoryDb } from "./helpers.js";

/**
 * The pages a request gets when it fails or finds nothing (beeline-0kj).
 * What matters: the chrome survives, so a volunteer has a way on and a way
 * to tell staff; a failure carries a reference staff can look up; and
 * nothing a database error says — which quotes record values — reaches a
 * page anywhere but development.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const ORIGIN = "http://localhost:3054";
const apos = (s: string) => s.replaceAll("'", "&#39;");

async function errorApp({
  environment = "sandbox",
  signedIn = true,
  gateFails = false,
}: { environment?: AppConfig["environment"]; signedIn?: boolean; gateFails?: boolean } = {}) {
  const { instance, conn } = await createMemoryDb();
  const [[ada]] = (await (await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Adams') RETURNING entity_id`)).getRows()) as [[number]];
  const app = createApp({
    db: createKysely(instance),
    config: { environment, origin: ORIGIN, feedbackEmail: "staff@example.org" },
    inat: unusedInat,
    resolveSession: async () => {
      // The session store unreadable: a failure before anyone is signed in.
      if (gateFails) throw new Error('IO Error: could not read "private.duckdb"');
      return signedIn ? { personId: ada, login: "ada", iconUrl: null } : null;
    },
  });
  // A failure the way DuckDB words one: the value it choked on, quoted.
  app.get("/boom", () => {
    throw new Error('Binder Error: Referenced column "determined_on_precision" not found; value "44.567891"');
  });
  return app;
}

describe("a page that is not there", () => {
  it("is the ordinary page, header and feedback included, saying so in plain words", async () => {
    const app = await errorApp();
    const res = await app.request("/no/such/page");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain(apos(en.errorPage.notFound.heading));
    expect(body).toContain('href="/samples"');
    expect(body).toContain("mailto:staff@example.org");
    expect(body).toContain(en.errorPage.home);
  });

  it("is still the sign-in page for somebody signed out, so an address cannot be probed", async () => {
    const app = await errorApp({ signedIn: false });
    const res = await app.request("/no/such/page");
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(apos(en.errorPage.notFound.heading));
  });

  it("offers a way back only to a page of this site", async () => {
    const app = await errorApp();
    const from = await (await app.request("/no/such/page", { headers: { referer: `${ORIGIN}/samples?page=2` } })).text();
    expect(from).toContain('href="/samples?page=2"');
    const away = await (await app.request("/no/such/page", { headers: { referer: "https://elsewhere.example/x" } })).text();
    expect(away).not.toContain(en.errorPage.back);
    // This origin, but a path that as an href is protocol-relative and leaves.
    for (const sneaky of [`${ORIGIN}//evil.example/x`, `${ORIGIN}/\\evil.example/x`]) {
      const body = await (await app.request("/no/such/page", { headers: { referer: sneaky } })).text();
      expect(body, sneaky).not.toContain(en.errorPage.back);
    }
  });

  it("answers a caller that asked for JSON with JSON", async () => {
    const app = await errorApp();
    const res = await app.request("/no/such/thing.json");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("a request that failed", () => {
  it("says so without saying what, and carries a reference into the feedback email", async () => {
    const app = await errorApp();
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain(apos(en.errorPage.failed.body));
    const reference = /Reference: ([0-9a-f]{8})/.exec(body)?.[1];
    expect(reference).toBeDefined();
    const mailto = /href="(mailto:[^"]*)"/.exec(body)?.[1];
    expect(decodeURIComponent(mailto!.replaceAll("&amp;", "&"))).toContain(`Error reference: ${reference}`);
    expect(body).not.toContain("Binder Error");
    expect(body).not.toContain("44.567891");
  });

  it("shows the error, and the stale-store hint, in development only", async () => {
    const app = await errorApp({ environment: "development" });
    const body = await (await app.request("/boom")).text();
    expect(body).toContain("Binder Error");
    expect(body).toContain(en.errorPage.dev.staleStore);
  });

  it("is still a page, on the sign-in shell, when it fails before anyone is signed in", async () => {
    const app = await errorApp({ gateFails: true });
    const res = await app.request("/samples");
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain(apos(en.errorPage.failed.body));
    expect(body).toMatch(/Reference: [0-9a-f]{8}/);
    expect(body).not.toContain("private.duckdb");
    expect(body).not.toContain('href="/samples"'); // no session, so no app chrome
  });

  it("answers a caller that asked for JSON with JSON", async () => {
    const app = await errorApp();
    const res = await app.request("/boom", { headers: { accept: "application/json" } });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "failed", reference: expect.stringMatching(/^[0-9a-f]{8}$/) });
  });
});

describe("the page of last resort", () => {
  it("needs nothing that can break, and escapes what it is given", () => {
    const page = staticErrorPage(en, "failed", "ab12cd34");
    expect(page).toContain("<h1>Something went wrong</h1>");
    expect(page).toContain("Reference: ab12cd34");
    expect(page).not.toContain("<link");
    expect(page).toContain("wasn&#39;t anything you did");
  });
});
