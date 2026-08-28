import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { attachPrivateStore } from "../src/app/db.js";
import { createApp } from "../src/app/server.js";
import { cookieSessionResolver, endSessionsFor, purgeIdleSessions } from "../src/app/session.js";
import { createMemoryDb } from "./helpers.js";

const ORIGIN = "http://localhost:3054";

type FakeIdentity = { inatUserId: number; login: string; iconUrl?: string | null };

const fakeInat = (identity: FakeIdentity): InatClient => ({
  authorizeUrl: (state, redirectUri) =>
    `https://inat.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  exchangeCode: async () => "access-token-123",
  identity: async () => ({ iconUrl: null, ...identity }),
});

async function testApp(identity: FakeIdentity) {
  const { instance, conn } = await createMemoryDb();
  await attachPrivateStore(instance, { path: ":memory:", key: null });
  await conn.run(`INSERT INTO person (entity_id, display_name) VALUES (11, 'Member Bee')`);
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (11, 501, 'memberbee')`);
  const db = createKysely(instance);
  const app = createApp({
    db,
    config: { environment: "development", origin: ORIGIN },
    inat: fakeInat(identity),
    resolveSession: cookieSessionResolver(db),
  });
  return { app, db };
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

    const token = await db.selectFrom("private.inat_oauth_token").selectAll().executeTakeFirstOrThrow();
    expect(token.icon_url).toBe(icon);

    const home = await app.request("/", { headers: { cookie: `beeline_session=${session}` } });
    expect(await home.text()).toContain(`<img class="avatar" src="${icon}"`);
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

    const token = await db
      .selectFrom("private.inat_oauth_token")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(token.login).toBe("stranger");
    expect(token.access_token).toBe("access-token-123");
  });

  it("a failed token exchange is a sign-in failure, not a 500", async () => {
    const { instance } = await createMemoryDb();
    await attachPrivateStore(instance, { path: ":memory:", key: null });
    const db = createKysely(instance);
    const app = createApp({
      db,
      config: { environment: "development", origin: ORIGIN },
      inat: {
        ...fakeInat({ inatUserId: 501, login: "memberbee" }),
        exchangeCode: () => Promise.reject(new Error("iNat said 502")),
      },
      resolveSession: cookieSessionResolver(db),
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
    expect(await db.selectFrom("private.session").selectAll().execute()).toHaveLength(0);

    const home = await app.request("/", { headers: { cookie: `beeline_session=${session}` } });
    expect(home.status).toBe(401);
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

  it("a private store built before the rekey is repaired at boot", async () => {
    // The private store outlives the blow-away era, so its schema changes are
    // patched in at boot (src/app/db.ts) rather than by rebuild. Dropped
    // rather than translated: rewriting the old rows would mean trusting the
    // very ids that were the bug (beeline-ten).
    const { instance, conn } = await createMemoryDb();
    const file = join(await mkdtemp(join(tmpdir(), "beeline-private-")), "private.duckdb");
    await conn.run(`ATTACH '${file}' AS legacy_private`);
    await conn.run(`USE legacy_private`);
    await conn.run(`CREATE TABLE inat_oauth_token (
      inat_user_id BIGINT PRIMARY KEY, login TEXT NOT NULL, icon_url TEXT,
      access_token TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
      last_login_at TIMESTAMP NOT NULL DEFAULT current_timestamp)`);
    await conn.run(`CREATE TABLE session (
      id TEXT PRIMARY KEY, person_id INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
      last_seen_at TIMESTAMP NOT NULL DEFAULT current_timestamp)`);
    await conn.run(`INSERT INTO session (id, person_id) VALUES ('stale', 11)`);
    await conn.run(`INSERT INTO inat_oauth_token (inat_user_id, login, access_token)
                    VALUES (501, 'memberbee', 'tok')`);
    await conn.run(`USE memory`);
    await conn.run(`DETACH legacy_private`);
    conn.closeSync();

    const { instance: fresh } = await createMemoryDb();
    await attachPrivateStore(fresh, { path: file, key: null });
    const db = createKysely(fresh);

    // The session is gone with its key; the tokens, which were never the
    // problem, are not.
    expect(await db.selectFrom("private.session").selectAll().execute()).toEqual([]);
    expect(await db.selectFrom("private.inat_oauth_token").select("login").execute()).toEqual([
      { login: "memberbee" },
    ]);
    // And the new shape is there to sign in against.
    await db.insertInto("private.session").values({ id: "new", inat_user_id: 501 }).execute();
    expect(
      await db.selectFrom("private.session").select("inat_user_id").execute(),
    ).toEqual([{ inat_user_id: 501n }]);
  });

  it("a store left holding tokens and no session table boots and repairs itself", async () => {
    // The crash window the rekey used to open: DROP committed, CREATE not.
    // The old probe asked "is there a session table?", got no, and replayed
    // the whole private schema — including a CREATE for the token table that
    // still existed, which is an unrecoverable boot crash on the store
    // holding real OAuth tokens. Each table is now created on its own.
    const { instance, conn } = await createMemoryDb();
    const file = join(await mkdtemp(join(tmpdir(), "beeline-private-")), "private.duckdb");
    await conn.run(`ATTACH '${file}' AS half`);
    await conn.run(`USE half`);
    await conn.run(`CREATE TABLE inat_oauth_token (
      inat_user_id BIGINT PRIMARY KEY, login TEXT NOT NULL, icon_url TEXT,
      access_token TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
      last_login_at TIMESTAMP NOT NULL DEFAULT current_timestamp)`);
    await conn.run(`INSERT INTO inat_oauth_token (inat_user_id, login, access_token)
                    VALUES (501, 'memberbee', 'tok')`);
    await conn.run(`USE memory`);
    await conn.run(`DETACH half`);
    conn.closeSync();

    const { instance: fresh } = await createMemoryDb();
    await attachPrivateStore(fresh, { path: file, key: null });
    const db = createKysely(fresh);
    // The missing table is built; the surviving one is untouched.
    await db.insertInto("private.session").values({ id: "s", inat_user_id: 501 }).execute();
    expect(await db.selectFrom("private.inat_oauth_token").select("login").execute()).toEqual([
      { login: "memberbee" },
    ]);
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
    expect(await db.selectFrom("private.session").selectAll().execute()).toHaveLength(1);
    await purgeIdleSessions(db);
    expect(await db.selectFrom("private.session").selectAll().execute()).toEqual([]);
  });

  it("stale session ids resolve to nobody", async () => {
    const { app } = await testApp({ inatUserId: 501, login: "memberbee" });
    const res = await app.request("/", { headers: { cookie: "beeline_session=deadbeef" } });
    expect(res.status).toBe(401);
  });
});
