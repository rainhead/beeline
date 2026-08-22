import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { attachPrivateStore } from "../src/app/db.js";
import { createApp } from "../src/app/server.js";
import { cookieSessionResolver } from "../src/app/session.js";
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

/** Run the OAuth dance against the app; returns the callback response. */
async function signIn(app: Awaited<ReturnType<typeof testApp>>["app"]) {
  const start = await app.request("/auth/inat");
  expect(start.status).toBe(302);
  const stateCookie = start.headers.get("set-cookie")!;
  const state = /beeline_oauth_state=([a-f0-9]+)/.exec(stateCookie)![1];
  return app.request(`/auth/inat/callback?code=abc&state=${state}`, {
    headers: { cookie: `beeline_oauth_state=${state}` },
  });
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
    expect(await cb.text()).toContain("connected to a member record");
    expect(cb.headers.get("set-cookie") ?? "").not.toContain("beeline_session=");

    const token = await db
      .selectFrom("private.inat_oauth_token")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(token.login).toBe("stranger");
    expect(token.access_token).toBe("access-token-123");
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

  it("cross-origin writes are refused before any handler runs", async () => {
    const { app } = await testApp({ inatUserId: 501, login: "memberbee" });
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("stale session ids resolve to nobody", async () => {
    const { app } = await testApp({ inatUserId: 501, login: "memberbee" });
    const res = await app.request("/", { headers: { cookie: "beeline_session=deadbeef" } });
    expect(res.status).toBe(401);
  });
});
