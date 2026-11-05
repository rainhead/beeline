import { copyFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient, SignInOutcome } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { absorbPrivateStore } from "../src/app/db.js";
import { cookieSessionResolver, endSessionsFor, hashSessionId, purgeIdleSessions, sessionRef } from "../src/app/session.js";
import { createFileDb, createMemoryDb, scratchPaths } from "./helpers.js";
import { readChanges } from "../src/person-change.js";

const ORIGIN = "http://localhost:3054";

type FakeIdentity = { inatUserId: number; login: string; iconUrl?: string | null; orcid?: string | null };

const fakeInat = (identity: FakeIdentity): InatClient => ({
  authorizeUrl: (state, redirectUri) =>
    `https://inat.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  exchangeCode: async () => "access-token-123",
  identity: async () => ({ iconUrl: null, ...identity }),
});

async function testApp(
  identity: FakeIdentity,
  feedbackEmail?: string,
  reportSignIn?: (outcome: SignInOutcome, line: string) => void,
  origin = ORIGIN,
  /** A retired private store to carry across first, as the app does at boot. */
  privateStore?: { path: string; key: string | null },
) {
  const { instance, conn } = await createMemoryDb();
  await conn.run(`INSERT INTO person (entity_id, display_name) VALUES (11, 'Member Bee')`);
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (11, 501, 'memberbee')`);
  if (privateStore) await absorbPrivateStore(instance, privateStore);
  const db = createKysely(instance);
  // Never the real log: sign-in records what it learns about a person there.
  const changesPath = join(await mkdtemp(join(tmpdir(), "auth-")), "person-change.csv");
  const app = createApp({
    ...(await scratchPaths()),
    db,
    config: { environment: "development", origin, feedbackEmail },
    inat: fakeInat(identity),
    resolveSession: cookieSessionResolver(db, origin),
    personChangesPath: changesPath,
    reportSignIn,
  });
  return { app, db, changesPath };
}

/**
 * Run the OAuth dance against the app; returns the callback response. The
 * browser is faked by carrying whatever `/auth/inat` set back to the
 * callback, which is the whole mechanism behind the return-to.
 */
async function signIn(app: Awaited<ReturnType<typeof testApp>>["app"], from?: string) {
  const start = await app.request(from === undefined ? "/auth/inat" : `/auth/inat?next=${encodeURIComponent(from)}`);
  expect(start.status).toBe(302);
  const setCookies = start.headers.getSetCookie();
  const state = /beeline_oauth_state=([a-f0-9]+)/.exec(setCookies.join("; "))![1];
  // Only cookies with a value survive; a deletion arrives as an empty one.
  const jar = setCookies
    .map((c) => c.split(";")[0] ?? "")
    .filter((c) => c.split("=")[1])
    .join("; ");
  return app.request(`/auth/inat/callback?code=abc&state=${state}`, { headers: { cookie: jar } });
}

describe("iNat OAuth sign-in", () => {
  it("a known member gets a session and lands on the home page", async () => {
    const { app } = await testApp({ inatUserId: 501, login: "memberbee" });
    const cb = await signIn(app);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/");
    const session = /beeline_session=([a-f0-9]+)/.exec(cb.headers.get("set-cookie") ?? "")?.[1];
    expect(session).toBeTruthy();

    const home = await app.request("/", { headers: { cookie: `beeline_session=${session}` } });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("memberbee");
  });

  it("the profile picture is cached at sign-in and rendered as the account-menu button", async () => {
    const icon = "https://static.inaturalist.org/attachments/users/icons/501/medium.jpg";
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee", iconUrl: icon });
    const cb = await signIn(app);
    const session = /beeline_session=([a-f0-9]+)/.exec(cb.headers.get("set-cookie")!)![1];

    const token = await db.selectFrom("inat_sign_in").selectAll().executeTakeFirstOrThrow();
    expect(token.icon_url).toBe(icon);

    const home = await app.request("/", { headers: { cookie: `beeline_session=${session}` } });
    expect(await home.text()).toContain(`<img class="avatar" src="${icon}"`);
  });

  it("the feedback link names the session without handing over the cookie", async () => {
    const { app } = await testApp({ inatUserId: 501, login: "memberbee" }, "staff@example.org");
    const cb = await signIn(app);
    const session = /beeline_session=([a-f0-9]+)/.exec(cb.headers.get("set-cookie")!)![1]!;

    const page = await app.request("/glossary?q=trap", {
      headers: { cookie: `beeline_session=${session}`, "user-agent": "TestBrowser/1.0" },
    });
    const href = /href="(mailto:[^"]+)"/.exec(await page.text())![1]!.replaceAll("&amp;", "&");
    expect(href.startsWith("mailto:staff@example.org?")).toBe(true);
    const body = decodeURIComponent(/body=([^&]+)/.exec(href)![1]!);
    expect(body).toContain(`Page: ${ORIGIN}/glossary?q=trap`);
    expect(body).toContain("Browser: TestBrowser/1.0");
    expect(body).toContain("Signed in as: memberbee");
    expect(body).toMatch(/Page loaded: .*P[DS]T/);
    expect(body).toContain(`Session: ${sessionRef(session)}`);
    // The cookie is the bearer credential: whoever read the email could sign in.
    expect(href).not.toContain(session);
  });

  it("there is no feedback link without an address to send it to", async () => {
    const { app } = await testApp({ inatUserId: 501, login: "memberbee" });
    const cb = await signIn(app);
    const session = /beeline_session=([a-f0-9]+)/.exec(cb.headers.get("set-cookie")!)![1];
    const page = await app.request("/glossary", { headers: { cookie: `beeline_session=${session}` } });
    expect(await page.text()).not.toContain("mailto:");
  });

  it("an unknown signer-in gets a holding page, no session — but the token is stored", async () => {
    const { app, db } = await testApp({ inatUserId: 999, login: "stranger" });
    const cb = await signIn(app);
    expect(cb.status).toBe(403);
    const holding = await cb.text();
    expect(holding).toContain("connected to a member record");
    // The holding page is pre-session too, and says which instance it is (beeline-2u8).
    expect(holding).toContain("development instance");
    expect(cb.headers.get("set-cookie") ?? "").not.toContain("beeline_session=");

    // Signing in records who was here, and NOT the access token it was given:
    // nothing ever read one back, and a non-expiring credential kept for no
    // reason is one leaked for no reason (Peter, 2026-08-28).
    const recorded = await db
      .selectFrom("inat_sign_in")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(recorded.login).toBe("stranger");
    expect(Object.keys(recorded)).not.toContain("access_token");
  });

  it("a failed token exchange is a sign-in failure, not a 500", async () => {
    const { instance } = await createMemoryDb();
      const db = createKysely(instance);
    const app = createApp({
      ...(await scratchPaths()),
      db,
      config: { environment: "development", origin: ORIGIN },
      inat: {
        ...fakeInat({ inatUserId: 501, login: "memberbee" }),
        exchangeCode: () => Promise.reject(new Error("iNat said 502")),
      },
      resolveSession: cookieSessionResolver(db, ORIGIN),
    });
    const res = await signIn(app);
    expect(res.status).toBe(400);
  });

  it("a state mismatch is refused", async () => {
    const { app } = await testApp({ inatUserId: 501, login: "memberbee" });
    const res = await app.request("/auth/inat/callback?code=abc&state=wrong", {
      headers: { cookie: "beeline_oauth_state=right" },
    });
    expect(res.status).toBe(400);
  });

  it("signing out deletes the session; the cookie is then worthless", async () => {
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee" });
    const cb = await signIn(app);
    const session = /beeline_session=([a-f0-9]+)/.exec(cb.headers.get("set-cookie")!)![1];

    const out = await app.request("/auth/logout", {
      method: "POST",
      headers: { cookie: `beeline_session=${session}`, origin: ORIGIN },
    });
    expect(out.status).toBe(302);
    expect(await db.selectFrom("session").selectAll().execute()).toHaveLength(0);

    const home = await app.request("/", { headers: { cookie: `beeline_session=${session}` } });
    expect(home.status).toBe(401);
  });

  it("the signed-out page says what Beeline is and links every member atlas (beeline-2c3.16)", async () => {
    const { app } = await testApp({ inatUserId: 501, login: "memberbee" });
    const page = await (await app.request("/")).text();
    expect(page).toContain("Beeline keeps the records of the bee specimens");
    expect(page).toContain(`<a href="https://extension.oregonstate.edu/master-melittologist">Master Melittologist</a>`);
    // All five, by the store's names, each to its own site with its mark.
    for (const [name, href] of [
      ["Oregon Bee Atlas", "https://extension.oregonstate.edu/bee-atlas"],
      ["Washington Bee Atlas", "https://agr.wa.gov/departments/insects-pests-and-weeds/insects/apiary-pollinators/pollinator-health/bee-atlas/"],
      ["British Columbia Bee Atlas", "https://www.bcnativebees.org/bc-bee-atlas"],
      ["Idaho Bee Atlas", "https://sites.google.com/view/idahobeeatlas/home"],
      ["New Mexico Bee Atlas", "https://www.inaturalist.org/projects/new-mexico-bee-atlas"],
    ] as const) {
      expect(page).toContain(`<a href="${href}">${name}</a>`);
      // The mark links there too, since the program pages are behind sign-in.
      const link = page.indexOf(`<a class="atlas-mark-link" href="${href}"><img `);
      expect(link, name).toBeGreaterThanOrEqual(0);
      expect(page.slice(link, page.indexOf("</a>", link))).toContain(`alt="${name}"`);
    }
    expect(page).not.toContain(`href="/programs/`);
  });

  it("sign-in comes back to the page that was asked for", async () => {
    const { app } = await testApp({ inatUserId: 501, login: "memberbee" });

    // The gate hangs the refused URL — query string and all — on the button.
    const gated = await app.request("/samples?scope=mine&page=3");
    expect(gated.status).toBe(401);
    expect(await gated.text()).toContain(
      `href="/auth/inat?next=${encodeURIComponent("/samples?scope=mine&page=3")}"`,
    );

    const cb = await signIn(app, "/samples?scope=mine&page=3");
    expect(cb.headers.get("location")).toBe("/samples?scope=mine&page=3");
  });

  it("a POST refused by the gate has nothing to come back to", async () => {
    const { app } = await testApp({ inatUserId: 501, login: "memberbee" });
    const gated = await app.request("/samples/1/edit", { method: "POST", headers: { origin: ORIGIN } });
    expect(gated.status).toBe(401);
    expect(await gated.text()).toContain(`href="/auth/inat"`);
  });

  it("sign-in cannot be turned into an open redirect", async () => {
    const { app } = await testApp({ inatUserId: 501, login: "memberbee" });
    for (const evil of ["https://evil.example/", "//evil.example/", "/\\evil.example/", "/auth/inat"]) {
      const cb = await signIn(app, evil);
      expect(cb.headers.get("location")).toBe("/");
    }
  });

  it("cross-origin writes are refused before any handler runs", async () => {
    const { app } = await testApp({ inatUserId: 501, login: "memberbee" });
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("a session survives the renumbering a reseed does", async () => {
    // The bug (beeline-ten): sessions held person.entity_id, and db:reseed
    // redraws every id — so a signed-in volunteer resolved to whoever
    // inherited their number and browsed as them, under a mine scope that is
    // forced for volunteers. Sessions key on the iNat user instead, which is
    // iNaturalist's number and survives any rebuild of ours.
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee" });
    const cb = await signIn(app);
    const session = /beeline_session=([a-f0-9]+)/.exec(cb.headers.get("set-cookie")!)![1];

    // What a reseed does to this store, in miniature: everybody's entity_id
    // moves, and somebody else lands on the number that was Member Bee's.
    await db.deleteFrom("inat_account").execute();
    await db.deleteFrom("person").execute();
    await db
      .insertInto("person")
      .values([
        { entity_id: 11, display_name: "Somebody Else" },
        { entity_id: 4242, display_name: "Member Bee" },
      ])
      .execute();
    await db
      .insertInto("inat_account")
      .values({ person_id: 4242, inat_user_id: 501, login: "memberbee" })
      .execute();

    const home = await app.request("/", { headers: { cookie: `beeline_session=${session}` } });
    expect(home.status).toBe(200);
    const body = await home.text();
    expect(body).toContain("memberbee");
    expect(body).not.toContain("Somebody Else");
  });

  it("unbinding the account ends its sessions", async () => {
    // The account join is the binding, so staff unbinding one on /people ends
    // the sessions it authorised — which is what that word should mean.
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee" });
    const cb = await signIn(app);
    const session = /beeline_session=([a-f0-9]+)/.exec(cb.headers.get("set-cookie")!)![1];
    expect((await app.request("/", { headers: { cookie: `beeline_session=${session}` } })).status).toBe(200);

    await db.deleteFrom("inat_account").where("inat_user_id", "=", 501n).execute();
    const after = await app.request("/", { headers: { cookie: `beeline_session=${session}` } });
    // Same as any session id that resolves to nobody.
    expect(after.status).toBe(401);
  });

  it("rebinding an account does not revive the sessions it used to authorise", async () => {
    // Resolution failing is not revocation: an unbound session's last_seen_at
    // stops sliding, so the idle cutoff never reaches it, and binding that
    // iNat user to somebody else revived every cookie ever issued for it — as
    // that person, with their rights. Unbind-then-rebind is what /people is
    // for, so this is the ordinary path (beeline-ten).
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee" });
    const cb = await signIn(app);
    const session = /beeline_session=([a-f0-9]+)/.exec(cb.headers.get("set-cookie")!)![1];

    await db.deleteFrom("inat_account").where("inat_user_id", "=", 501n).execute();
    await db.insertInto("person").values({ entity_id: 12, display_name: "Someone Else" }).execute();
    await db
      .insertInto("inat_account")
      .values({ person_id: 12, inat_user_id: 501, login: "memberbee" })
      .execute();

    // Without the revocation this is a 200 — as person 12.
    await endSessionsFor(db, 501);
    expect((await app.request("/", { headers: { cookie: `beeline_session=${session}` } })).status).toBe(401);
  });

  it("the idle purge also collects sessions whose account is gone", async () => {
    // They can never age out on their own: last_seen_at stops moving the
    // moment they stop resolving.
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee" });
    await signIn(app);
    await db.deleteFrom("inat_account").where("inat_user_id", "=", 501n).execute();
    expect(await db.selectFrom("session").selectAll().execute()).toHaveLength(1);
    await purgeIdleSessions(db);
    expect(await db.selectFrom("session").selectAll().execute()).toEqual([]);
  });

  it("stale session ids resolve to nobody", async () => {
    const { app } = await testApp({ inatUserId: 501, login: "memberbee" });
    const res = await app.request("/", { headers: { cookie: "beeline_session=deadbeef" } });
    expect(res.status).toBe(401);
  });

  it("keeps the ORCID iD the account has connected, and says in the person's history that sign-in found it", async () => {
    // ORCID's documented example iD: synthetic, nobody in Beeline.
    const { app, db, changesPath } = await testApp({ inatUserId: 501, login: "memberbee", orcid: "0000-0002-1825-0097" });
    expect((await signIn(app)).status).toBe(302);
    expect(await db.selectFrom("inat_user_orcid").select(["inat_user_id", "orcid"]).execute()).toEqual([
      { inat_user_id: 501n, orcid: "0000-0002-1825-0097" },
    ]);
    expect((await readChanges(changesPath)).map((c) => [c.person_ref, c.field, c.old_value, c.new_value, c.source])).toEqual([
      ["name:Member Bee", "inat_orcid", "", "0000-0002-1825-0097", "sign_in"],
    ]);
    // Signing in again with nothing changed writes nothing.
    await signIn(app);
    expect(await readChanges(changesPath)).toHaveLength(1);
  });

  it("forgets an ORCID iD the account has disconnected", async () => {
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee", orcid: null });
    await db.insertInto("inat_user_orcid").values({ inat_user_id: 501n, orcid: "0000-0002-1825-0097" }).execute();
    await signIn(app);
    expect(await db.selectFrom("inat_user_orcid").selectAll().execute()).toEqual([]);
  });
});

/**
 * Activity is a fact about a person, not about a credential. It used to be
 * read from the session row, and sessions are destroyed for reasons that have
 * nothing to do with whether somebody is still turning up: an expiry purge, an
 * account rebind, and — twice on 2026-08-27 — the beeline-ten rekey, which
 * dropped the table rather than translate rows keyed on an id that had become
 * untrustworthy. Each of those quietly aged the roster's "Last seen" back to
 * the sign-in behind it (beeline-dji).
 */
describe("when somebody was last here", () => {
  const cookieFrom = (cb: Response) => `beeline_session=${/beeline_session=([a-f0-9]+)/.exec(cb.headers.get("set-cookie")!)![1]}`;
  const activity = (db: Awaited<ReturnType<typeof testApp>>["db"]) =>
    db.selectFrom("person_activity").selectAll().execute();

  it("is recorded on the request path, keyed on the iNat user", async () => {
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee" });
    const cookie = cookieFrom(await signIn(app));
    expect(await activity(db)).toHaveLength(0);

    await app.request("/", { headers: { cookie } });
    const [row] = await activity(db);
    // Never person.entity_id, which is 11 here: a db:reseed redraws those,
    // and outliving a rebuild is the point of the row (beeline-ten).
    expect(row?.inat_user_id).toBe(501n);
  });

  it("survives every session that observed it being destroyed", async () => {
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee" });
    await app.request("/", { headers: { cookie: cookieFrom(await signIn(app)) } });

    // The rekey drops the table; a rebind ends the sessions; the purge
    // collects the rest. All three leave activity alone.
    await endSessionsFor(db, 501);
    await purgeIdleSessions(db);
    expect(await db.selectFrom("session").selectAll().execute()).toHaveLength(0);
    expect(await activity(db)).toHaveLength(1);
  });

  it("is throttled to an hour, so it costs one write per person per hour", async () => {
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee" });
    const cookie = cookieFrom(await signIn(app));
    await app.request("/", { headers: { cookie } });
    const first = (await activity(db))[0]!.last_seen_at;

    // A second request inside the hour leaves the row where it is. The
    // session's own last_seen_at slides on a much shorter throttle — the
    // 30-day expiry has to be measured from close to the real last request —
    // which is one reason this is a separate table rather than a column on it.
    await app.request("/", { headers: { cookie } });
    expect((await activity(db))[0]!.last_seen_at).toEqual(first);

    // Once it is stale, the next request moves it.
    await db
      .updateTable("person_activity")
      .set({ last_seen_at: sql`now() - INTERVAL '2 hours'` })
      .execute();
    await app.request("/", { headers: { cookie } });
    expect((await activity(db))[0]!.last_seen_at).not.toEqual(first);
    expect((await activity(db))[0]!.last_seen_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  const sessionSeen = async (db: Awaited<ReturnType<typeof testApp>>["db"]) =>
    (await db.selectFrom("session").select("last_seen_at").executeTakeFirstOrThrow()).last_seen_at;

  it("the session slides once it is due, and not on every request", async () => {
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee" });
    const cookie = cookieFrom(await signIn(app));
    const signedIn = await sessionSeen(db);
    await app.request("/", { headers: { cookie } });
    expect(await sessionSeen(db)).toEqual(signedIn);

    await db.updateTable("session").set({ last_seen_at: sql`now() - INTERVAL '10 minutes'` }).execute();
    await app.request("/", { headers: { cookie } });
    expect((await sessionSeen(db)).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("requests sharing a session never fail each other", async () => {
    // Two tabs, or a page and its CSV (beeline-cla). DuckDB has no row locks:
    // the second of two overlapping updates to one row fails rather than
    // waiting, and the slide used to take the whole request down with it.
    // Both writes are made due, so every request in the burst wants them.
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee" });
    const cookie = cookieFrom(await signIn(app));
    for (let round = 0; round < 5; round++) {
      await db.updateTable("session").set({ last_seen_at: sql`now() - INTERVAL '10 minutes'` }).execute();
      await db.updateTable("person_activity").set({ last_seen_at: sql`now() - INTERVAL '2 hours'` }).execute();
      const burst = await Promise.all(Array.from({ length: 8 }, () => app.request("/", { headers: { cookie } })));
      expect(burst.map((r) => r.status)).toEqual(Array(8).fill(200));
    }
    expect((await sessionSeen(db)).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("what is kept of a session (beeline-5l84, beeline-jpau)", () => {
  const idFrom = (cb: Response) => /beeline_session=([a-f0-9]+)/.exec(cb.headers.get("set-cookie")!)![1]!;

  it("the store keeps the cookie's hash, and the hash signs nobody in", async () => {
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee" });
    const id = idFrom(await signIn(app));
    const [row] = await db.selectFrom("session").selectAll().execute();
    expect(row!.id_sha256).toBe(hashSessionId(id));
    expect(row!.id_sha256).not.toContain(id);
    // Somebody holding a copy of the table, from a backup say, has only this.
    expect((await app.request("/", { headers: { cookie: `beeline_session=${row!.id_sha256}` } })).status).toBe(401);
    expect((await app.request("/", { headers: { cookie: `beeline_session=${id}` } })).status).toBe(200);
    // And the reference a feedback email carries still finds the row.
    expect(row!.id_sha256.startsWith(sessionRef(id))).toBe(true);
  });

  it("a session ends 90 days after it began, however recently it was used", async () => {
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee" });
    const cookie = `beeline_session=${idFrom(await signIn(app))}`;
    await db.updateTable("session").set({ created_at: sql`now() - INTERVAL 89 DAY` }).execute();
    expect((await app.request("/", { headers: { cookie } })).status).toBe(200);

    await db.updateTable("session").set({ created_at: sql`now() - INTERVAL 91 DAY`, last_seen_at: sql`now()` }).execute();
    expect((await app.request("/", { headers: { cookie } })).status).toBe(401);
    await purgeIdleSessions(db);
    expect(await db.selectFrom("session").selectAll().execute()).toEqual([]);
  });
});

/**
 * On an https origin every cookie is named with the __Host- prefix, which no
 * other host may set: melittologist.org's subdomains reach servers Beeline
 * does not run (src/app/cookies.ts).
 */
describe("cookies no other host can set (beeline-73c9)", () => {
  const HTTPS = "https://beeline.example";
  const httpsApp = () => testApp({ inatUserId: 501, login: "memberbee" }, undefined, undefined, HTTPS);
  const idFrom = (cb: Response) => /__Host-beeline_session=([a-f0-9]+)/.exec(cb.headers.get("set-cookie")!)![1]!;

  it("are named __Host-, Secure, for the whole site, and give no Domain", async () => {
    const { app } = await httpsApp();
    const start = await app.request("/auth/inat");
    for (const c of start.headers.getSetCookie()) {
      expect(c).toMatch(/^__Host-beeline_oauth_/);
      expect(c).toContain("; Secure");
      expect(c).toContain("; Path=/");
      expect(c).not.toMatch(/domain=/i);
    }
    const cb = await signIn(app);
    const set = cb.headers.getSetCookie().find((c) => c.startsWith("__Host-beeline_session="))!;
    expect(set).toContain("; Secure");
    expect(set).toContain("; HttpOnly");
    expect((await app.request("/", { headers: { cookie: `__Host-beeline_session=${idFrom(cb)}` } })).status).toBe(200);
  });

  it("an OAuth state cookie without the prefix, as another host could set it, is not read", async () => {
    const { app } = await httpsApp();
    const res = await app.request("/auth/inat/callback?code=abc&state=right", {
      headers: { cookie: "beeline_oauth_state=right" },
    });
    expect(res.status).toBe(400);
  });

  it("a session cookie under its name from before still signs in, and moves to the new name", async () => {
    // Read for 30 days after the rename, so nobody was signed out by it.
    const { app } = await httpsApp();
    const id = idFrom(await signIn(app));
    const res = await app.request("/", { headers: { cookie: `beeline_session=${id}` } });
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie();
    expect(set.some((c) => c.startsWith(`__Host-beeline_session=${id};`))).toBe(true);
    expect(set.some((c) => /^beeline_session=;.*Max-Age=0/.test(c))).toBe(true);
  });
});

describe("retiring the private store (beeline-4tdh)", () => {
  /**
   * A private store in the shape production's held on 2026-11-05, written
   * the way the app used to write one. `legacy` gives the older shapes a
   * store could still be met in: the sign-in table under its first name with
   * the token column, and sessions keyed on person_id.
   */
  async function retiredStore(opts: { key?: string; legacy?: boolean } = {}) {
    const path = join(await mkdtemp(join(tmpdir(), "beeline-private-")), "private.duckdb");
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    await conn.run(`ATTACH '${path}' AS p${opts.key ? ` (ENCRYPTION_KEY '${opts.key}')` : ""}`);
    if (opts.legacy) {
      await conn.run(`CREATE TABLE p.inat_oauth_token (
        inat_user_id BIGINT PRIMARY KEY, login TEXT NOT NULL, access_token TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        last_login_at TIMESTAMP NOT NULL DEFAULT current_timestamp)`);
      await conn.run(`INSERT INTO p.inat_oauth_token (inat_user_id, login, access_token) VALUES (501, 'memberbee', 'tok')`);
      await conn.run(`CREATE TABLE p.session (
        id TEXT PRIMARY KEY, person_id INTEGER NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        last_seen_at TIMESTAMP NOT NULL DEFAULT current_timestamp)`);
      await conn.run(`INSERT INTO p.session (id, person_id) VALUES ('stale', 11)`);
    } else {
      await conn.run(`CREATE TABLE p.inat_sign_in (
        inat_user_id BIGINT PRIMARY KEY, login TEXT NOT NULL, icon_url TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        last_login_at TIMESTAMP NOT NULL DEFAULT current_timestamp)`);
      await conn.run(`INSERT INTO p.inat_sign_in (inat_user_id, login, icon_url, last_login_at) VALUES
        (501, 'memberbee', 'https://static.inaturalist.org/a.jpg', TIMESTAMP '2026-11-01 12:00:00'),
        (999, 'stranger', NULL, TIMESTAMP '2026-11-02 12:00:00')`);
      await conn.run(`CREATE TABLE p.session (
        id TEXT PRIMARY KEY, inat_user_id BIGINT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        last_seen_at TIMESTAMP NOT NULL DEFAULT current_timestamp)`);
      await conn.run(`INSERT INTO p.session (id, inat_user_id) VALUES ('${"a".repeat(64)}', 501)`);
      await conn.run(`CREATE TABLE p.person_activity (
        inat_user_id BIGINT PRIMARY KEY, last_seen_at TIMESTAMP NOT NULL DEFAULT current_timestamp)`);
      await conn.run(`INSERT INTO p.person_activity VALUES (501, TIMESTAMP '2026-11-04 12:00:00')`);
      await conn.run(`CREATE TABLE p.impersonation (
        admin_login TEXT NOT NULL, person_name TEXT NOT NULL,
        started_at TIMESTAMP NOT NULL DEFAULT current_timestamp)`);
      await conn.run(`INSERT INTO p.impersonation VALUES ('staffer', 'Member Bee', TIMESTAMP '2026-10-30 09:00:00')`);
    }
    await conn.run("DETACH p");
    conn.closeSync();
    instance.closeSync();
    return path;
  }
  const counts = async (db: Awaited<ReturnType<typeof testApp>>["db"]) => ({
    inat_sign_in: (await db.selectFrom("inat_sign_in").selectAll().execute()).length,
    session: (await db.selectFrom("session").selectAll().execute()).length,
    person_activity: (await db.selectFrom("person_activity").selectAll().execute()).length,
    impersonation: (await db.selectFrom("impersonation").selectAll().execute()).length,
  });

  it("carries every row across, and somebody signed in before is still signed in", async () => {
    const path = await retiredStore();
    const { app, db } = await testApp({ inatUserId: 501, login: "memberbee" }, undefined, undefined, ORIGIN, { path, key: null });
    expect(await counts(db)).toEqual({ inat_sign_in: 2, session: 1, person_activity: 1, impersonation: 1 });
    expect(
      await db.selectFrom("inat_sign_in").select(["login", "last_login_at"]).orderBy("login").execute(),
    ).toEqual([
      { login: "memberbee", last_login_at: new Date("2026-11-01T12:00:00Z") },
      { login: "stranger", last_login_at: new Date("2026-11-02T12:00:00Z") },
    ]);
    // The session is kept as its hash, and its cookie still works.
    const [session] = await db.selectFrom("session").select("id_sha256").execute();
    expect(session!.id_sha256).toBe(hashSessionId("a".repeat(64)));
    expect((await app.request("/", { headers: { cookie: `beeline_session=${"a".repeat(64)}` } })).status).toBe(200);
    // Renamed rather than deleted, so the next boot does not carry it again.
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.retired`)).toBe(true);
  });

  it("does nothing when there is no store to carry", async () => {
    const { instance } = await createMemoryDb();
    expect(await absorbPrivateStore(instance, { path: join(tmpdir(), "no-such-private.duckdb"), key: null })).toBeNull();
  });

  it("an encrypted store is carried with its key, and stops the boot without it", async () => {
    const path = await retiredStore({ key: "the-key" });
    const { instance } = await createMemoryDb();
    await expect(absorbPrivateStore(instance, { path, key: null })).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
    expect(await absorbPrivateStore(instance, { path, key: "the-key" })).toEqual({
      inat_sign_in: 2,
      session: 1,
      person_activity: 1,
      impersonation: 1,
    });
  });

  it("carrying it again after a crash duplicates nothing", async () => {
    // The rename is the last step; a crash before it means the next boot
    // carries the same file a second time.
    const path = await retiredStore();
    const { instance } = await createMemoryDb();
    await absorbPrivateStore(instance, { path, key: null });
    await copyFile(`${path}.retired`, path);
    expect(await absorbPrivateStore(instance, { path, key: null })).toEqual({
      inat_sign_in: 0,
      session: 0,
      person_activity: 0,
      impersonation: 0,
    });
    expect(await counts(createKysely(instance))).toEqual({ inat_sign_in: 2, session: 1, person_activity: 1, impersonation: 1 });
  });

  it("a store in an older shape gives what it can: sign-ins, and no session keyed on person_id", async () => {
    const path = await retiredStore({ legacy: true });
    const { instance } = await createMemoryDb();
    await absorbPrivateStore(instance, { path, key: null });
    const db = createKysely(instance);
    expect(await db.selectFrom("inat_sign_in").select(["login", "icon_url"]).execute()).toEqual([
      { login: "memberbee", icon_url: null },
    ]);
    expect(await db.selectFrom("session").selectAll().execute()).toEqual([]);
  });

  it("works against a file-backed main store, as production's is", async () => {
    // A file-backed store's catalog is named after its file, not `memory`,
    // which is where beeline-d34 hid from a suite of in-memory stores.
    const path = await retiredStore();
    const { instance } = await createFileDb();
    await absorbPrivateStore(instance, { path, key: null });
    expect(await counts(createKysely(instance))).toEqual({ inat_sign_in: 2, session: 1, person_activity: 1, impersonation: 1 });
    instance.closeSync();
  });
});

describe("each sign-in's outcome is reported (beeline-87rn)", () => {
  async function listening(identity: FakeIdentity = { inatUserId: 501, login: "memberbee" }) {
    const reports: Array<{ outcome: SignInOutcome; line: string }> = [];
    const { app } = await testApp(identity, undefined, (outcome, line) => reports.push({ outcome, line }));
    return { app, reports };
  }

  it("a member signing in is reported by login", async () => {
    const { app, reports } = await listening();
    expect((await signIn(app)).status).toBe(302);
    expect(reports).toEqual([{ outcome: "signed-in", line: "[sign-in] signed in: memberbee" }]);
  });

  it("someone turned away is named, so staff can connect them", async () => {
    const { app, reports } = await listening({ inatUserId: 11227491, login: "jenlarsen52" });
    expect((await signIn(app)).status).toBe(403);
    expect(reports).toEqual([
      {
        outcome: "turned-away",
        line: "[sign-in] turned away: no person holds iNaturalist account jenlarsen52 (11227491)",
      },
    ]);
  });

  it("each way a callback fails is told apart", async () => {
    const { app, reports } = await listening();
    const cookie = { headers: { cookie: "beeline_oauth_state=right" } };
    expect((await app.request("/auth/inat/callback?error=access_denied&state=right", cookie)).status).toBe(400);
    expect((await app.request("/auth/inat/callback?code=abc&state=right")).status).toBe(400);
    expect((await app.request("/auth/inat/callback?code=abc&state=wrong", cookie)).status).toBe(400);
    expect((await app.request("/auth/inat/callback?state=right", cookie)).status).toBe(400);
    expect(reports.map((r) => r.outcome)).toEqual(["declined", "no-state-cookie", "state-mismatch", "no-code"]);
    expect(reports[0]!.line).toBe("[sign-in] declined: iNaturalist returned access_denied");
  });

  it("an error the callback was handed is not written into the log unless it reads as an OAuth code", async () => {
    const { app, reports } = await listening();
    await app.request(`/auth/inat/callback?error=${encodeURIComponent("<script>alert(1)</script>")}`);
    expect(reports).toEqual([{ outcome: "declined", line: "[sign-in] declined: iNaturalist returned an unrecognised error" }]);
  });

  it("a failed exchange is reported with iNaturalist's reason, as a string", async () => {
    const { instance } = await createMemoryDb();
      const db = createKysely(instance);
    const reports: Array<{ outcome: SignInOutcome; line: string }> = [];
    const app = createApp({
      ...(await scratchPaths()),
      db,
      config: { environment: "development", origin: ORIGIN },
      inat: {
        ...fakeInat({ inatUserId: 501, login: "memberbee" }),
        exchangeCode: () => Promise.reject(new Error("code exchange failed: 502")),
      },
      resolveSession: cookieSessionResolver(db, ORIGIN),
      reportSignIn: (outcome, line) => reports.push({ outcome, line }),
    });
    expect((await signIn(app)).status).toBe(400);
    expect(reports).toEqual([
      {
        outcome: "exchange-failed",
        line: "[sign-in] failed: iNaturalist would not exchange the code, or say whose account it was: code exchange failed: 502",
      },
    ]);
  });
});
