import { Hono } from "hono";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApi } from "../src/app/api.js";
import {
  createKey,
  hashKey,
  KEY_LIMIT,
  KEY_SCOPES,
  KEY_PREFIX,
  keyRateLimiter,
  listKeys,
  resolveKey,
  revokeKey,
  revokeKeysFor,
  revokeOrphanedKeys,
} from "../src/app/api-keys.js";
import { ACTING_COOKIE, IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { createApp } from "../src/app/server.js";
import { cookieSessionResolver } from "../src/app/session.js";
import { redact } from "../src/app/error-reporting.js";
import { OLD_BEELINE_ORIGIN } from "../src/app/old-beeline.js";
import { createMemoryDb, rows, scratchPaths } from "./helpers.js";

const unusedInat: InatClient = {
  authorizeUrl: () => "https://inat.example/authorize",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

/** Revoking as the owner does, for tests that only need a key to stop working. */
const OWNER = { login: "staff", reason: "owner" } as const;
const ORIGIN = "http://localhost:3054";
const STAFF_UID = 111;
const VOLUNTEER_UID = 222;

/**
 * Personal API keys and the gate for /api/v1 (beeline-pnqr.1).
 *
 * Two people with iNat accounts: a staff member, who is signed in, and a
 * volunteer. Run on the sandbox environment, since development makes everyone
 * staff (src/app/server.tsx isStaff).
 */
async function fixture({ admin = true, signedIn = true }: { admin?: boolean; signedIn?: boolean } = {}) {
  const { instance, conn } = await createMemoryDb();
  await conn.run(`INSERT INTO person (display_name) VALUES ('Staff Member'), ('Vera Volunteer'), ('Jane Pope')`);
  const [[jane], [staff], [volunteer]] = (await rows(conn, `SELECT entity_id FROM person ORDER BY display_name`)) as [
    [number],
    [number],
    [number],
  ];
  await conn.run(
    `INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${staff}, ${STAFF_UID}, 'staff'), (${volunteer}, ${VOLUNTEER_UID}, 'vera')`,
  );
  if (admin) await conn.run(`INSERT INTO person_admin (person_id, granted_by) VALUES (${staff}, 'peter')`);
  await conn.run(`INSERT INTO person_delegate (person_id, acts_for_id, granted_by) VALUES (${staff}, ${jane}, 'peter')`);
  const db = createKysely(instance);
  const app = createApp({
    ...(await scratchPaths()),
    db,
    config: { environment: "sandbox", origin: ORIGIN },
    inat: unusedInat,
    // Signed out, the real resolver: it is the thing that must not learn to
    // read a bearer header, so a stand-in that answers nobody would prove
    // nothing.
    resolveSession: signedIn
      ? async () => ({ personId: Number(staff), login: "staff", inatUserId: BigInt(STAFF_UID), iconUrl: null })
      : cookieSessionResolver(db, ORIGIN),
    conn,
  });
  const api = (path: string, key?: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { ...(key === undefined ? {} : { authorization: `Bearer ${key}` }), ...init.headers } });
  const post = (path: string, body: Record<string, string> = {}, cookie?: string) =>
    app.request(path, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: new URLSearchParams(body).toString(),
    });
  const make = async (uid: number, scope = "staff", lifetimeDays = 30) => {
    const made = await createKey(db, { inatUserId: uid, name: "test", scope, lifetimeDays, offered: KEY_SCOPES });
    if ("problem" in made) throw new Error(made.problem);
    return made;
  };
  return { app, db, conn, api, post, make, staff: Number(staff), volunteer: Number(volunteer) };
}

/** The key a page shows after one is made: the only place it ever appears. */
const shownKey = (html: string) => new RegExp(`${KEY_PREFIX}[A-Za-z0-9_-]{43}`).exec(html)?.[0];

describe("making and revoking a key on /keys", () => {
  it("shows a new key once, keeps only its hash, and the key then works", async () => {
    const { post, app, api, conn } = await fixture();
    const made = await post("/keys", { name: " laptop script ", scope: "staff", lifetime: "30" });
    expect(made.status).toBe(200);
    expect(made.headers.get("cache-control")).toBe("no-store");
    const key = shownKey(await made.text());
    expect(key).toBeDefined();

    const stored = await rows(conn, `SELECT key_sha256, name, scope, expires_at > current_timestamp + INTERVAL 29 DAY, expires_at <= current_timestamp + INTERVAL 30 DAY FROM api_key`);
    expect(stored).toEqual([[hashKey(key!), "laptop script", "staff", true, true]]);
    // Nothing in the store holds the key itself.
    expect(JSON.stringify(await rows(conn, `SELECT key_sha256, name, scope FROM api_key`))).not.toContain(key);

    // The list names it by its reference, and never shows the key again.
    const list = await (await app.request("/keys")).text();
    expect(list).toContain(hashKey(key!).slice(0, 12));
    expect(shownKey(list)).toBeUndefined();

    const me = await api("/api/v1/me", key);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      person: { name: "Staff Member", inat_login: "staff" },
      key: { reference: hashKey(key!).slice(0, 12), scope: "staff" },
      staff: true,
    });
  });

  it("refuses a name, a scope or a lifetime that is not offered, and makes nothing", async () => {
    const { post, conn } = await fixture();
    for (const body of [
      { name: "", scope: "staff", lifetime: "30" },
      { name: "x".repeat(81), scope: "staff", lifetime: "30" },
      { name: "k", scope: "everything", lifetime: "30" },
      // Not offered until something accepts it, so no key gains the power later.
      { name: "k", scope: "edit", lifetime: "30" },
      { name: "k", scope: "staff", lifetime: "365" },
      { name: "k", scope: "staff", lifetime: "0x1e" },
      { name: "k", scope: "staff", lifetime: "30; DROP TABLE api_key" },
    ]) {
      expect((await post("/keys", body)).status).toBe(400);
    }
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM api_key`)).toEqual([[0]]);
  });

  it("revokes a person's own key, and nobody else's", async () => {
    const { post, api, make, db } = await fixture();
    const mine = await make(STAFF_UID);
    const theirs = await make(VOLUNTEER_UID, "read");
    // A reference from somebody else's list revokes nothing.
    expect((await post(`/keys/${theirs.ref}/revoke`)).status).toBe(302);
    expect(await resolveKey(db, theirs.key)).not.toBeNull();
    expect((await post(`/keys/${mine.ref}/revoke`)).status).toBe(302);
    expect((await api("/api/v1/me", mine.key)).status).toBe(401);
    // Still listed, as revoked, so its use can be traced.
    expect((await listKeys(db, STAFF_UID))[0]!.revokedAt).not.toBeNull();
  });

  it("makes no key when the person's account was changed while the form was arriving", async () => {
    const { app, conn, db, staff } = await fixture();
    // The body arrives slowly; meanwhile staff give this person a different account.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await held;
        controller.enqueue(new TextEncoder().encode("name=late&scope=read&lifetime=30"));
        controller.close();
      },
    });
    const pending = app.request("/keys", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body,
      // @ts-expect-error Node needs this to send a streamed body; the DOM type lacks it.
      duplex: "half",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await conn.run(`UPDATE inat_account SET inat_user_id = 999, login = 'someoneelse' WHERE person_id = ${staff}`);
    release();
    expect((await pending).status).toBe(403);
    expect(await listKeys(db, 999)).toEqual([]);
    expect(await listKeys(db, STAFF_UID)).toEqual([]);
  });

  it("lets one person have only so many working keys", async () => {
    const { post, make, db } = await fixture();
    const made = [];
    for (let i = 0; i < KEY_LIMIT; i++) made.push(await make(STAFF_UID));
    expect((await post("/keys", { name: "one more", scope: "read", lifetime: "30" })).status).toBe(400);
    // A revoked key no longer counts.
    await revokeKey(db, STAFF_UID, made[0]!.ref, OWNER);
    expect((await post("/keys", { name: "one more", scope: "read", lifetime: "30" })).status).toBe(200);
  });

  it("does nothing while viewing Beeline as someone else", async () => {
    const { app, post, make, db } = await fixture();
    const mine = await make(STAFF_UID);
    const as = `${IMPERSONATING_COOKIE}=${encodeURIComponent("Vera Volunteer")}`;
    expect((await app.request("/keys", { headers: { cookie: as } })).status).toBe(403);
    expect((await post("/keys", { name: "k", scope: "read", lifetime: "30" }, as)).status).toBe(403);
    expect((await post(`/keys/${mine.ref}/revoke`, {}, as)).status).toBe(403);
    expect((await listKeys(db, STAFF_UID)).length).toBe(1);
    expect((await listKeys(db, VOLUNTEER_UID)).length).toBe(0);
    expect(await resolveKey(db, mine.key)).not.toBeNull();
  });

  it("makes and revokes nothing while acting for someone else", async () => {
    const { post, make, db, conn } = await fixture();
    const mine = await make(STAFF_UID);
    const acting = `${ACTING_COOKIE}=${encodeURIComponent("Jane Pope")}`;
    expect((await post("/keys", { name: "k", scope: "staff", lifetime: "30" }, acting)).status).toBe(403);
    expect((await post(`/keys/${mine.ref}/revoke`, {}, acting)).status).toBe(403);
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM api_key`)).toEqual([[1]]);
    expect(await resolveKey(db, mine.key)).not.toBeNull();
  });
});

/** A person's page, as staff see it, with the keys section cut out. */
const keysSection = (html: string) => /<h2>API keys<\/h2>[\s\S]*?<\/table>/.exec(html)?.[0];

describe("a person who is not staff, on /keys", () => {
  it("sees their keys and revokes one, and cannot make one", async () => {
    const { app, post, make, db, conn } = await fixture({ admin: false });
    const one = await make(STAFF_UID, "read");
    const two = await make(STAFF_UID, "read");
    const page = await app.request("/keys");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(one.ref);
    expect(html).toContain(two.ref);
    expect(html).not.toContain('action="/keys"');
    expect(html).toContain("Making keys is not open to you yet");
    expect(shownKey(html)).toBeUndefined();

    expect((await post("/keys", { name: "k", scope: "read", lifetime: "30" })).status).toBe(403);
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM api_key`)).toEqual([[2]]);

    const res = await post(`/keys/${one.ref}/revoke`);
    expect(res.status).toBeLessThan(400);
    expect(await resolveKey(db, one.key)).toBeNull();
    expect(await resolveKey(db, two.key)).not.toBeNull();
    const after = await (await app.request("/keys")).text();
    expect(after).toContain("Revoked");
  });

  it("is linked to /keys from the account menu when staff, or when they have a key, and not otherwise", async () => {
    const link = 'href="/keys"';
    const staff = await fixture();
    expect(await (await staff.app.request("/")).text()).toContain(link);

    const none = await fixture({ admin: false });
    expect(await (await none.app.request("/")).text()).not.toContain(link);
    await none.make(STAFF_UID, "read");
    expect(await (await none.app.request("/")).text()).toContain(link);
    // Still there once the key is revoked: the page then says it is revoked.
    // Not while viewing Beeline as someone else, where /keys refuses.
    const as = `${IMPERSONATING_COOKIE}=${encodeURIComponent("Vera Volunteer")}`;
    expect(await (await staff.app.request("/", { headers: { cookie: as } })).text()).not.toContain(link);
  });
});

describe("staff and another person's keys", () => {
  it("shows them on the person's page without the key, and revoking one stops it and says who and why", async () => {
    const { app, api, post, make, db, volunteer } = await fixture();
    const a = await make(VOLUNTEER_UID, "read");
    const b = await make(VOLUNTEER_UID, "read");
    const html = await (await app.request(`/people/${volunteer}`)).text();
    const section = keysSection(html)!;
    expect(section).toContain(a.ref);
    expect(section).toContain(b.ref);
    expect(section).toContain(`/people/vera/keys/${a.ref}/revoke`);
    expect(html).not.toContain(a.key);
    expect(shownKey(html)).toBeUndefined();
    expect((await api("/api/v1/me", a.key)).status).toBe(200);

    const res = await post(`/people/${volunteer}/keys/${a.ref}/revoke`);
    expect(res.status).toBeLessThan(400);
    expect((await api("/api/v1/me", a.key)).status).toBe(401);
    expect((await api("/api/v1/me", b.key)).status).toBe(200);
    const row = (await listKeys(db, VOLUNTEER_UID)).find((k) => k.ref === a.ref)!;
    expect([row.revokedBy, row.revokedReason]).toEqual(["staff", "staff"]);

    const after = keysSection(await (await app.request(`/people/${volunteer}`)).text())!;
    expect(after).toContain("Revoked");
    expect(after).toContain("by staff");
    expect(after).not.toContain(`/people/vera/keys/${a.ref}/revoke`);
    expect(after).toContain(`/people/vera/keys/${b.ref}/revoke`);
  });

  it("show no section for a person with no keys", async () => {
    const { app, volunteer } = await fixture();
    expect(keysSection(await (await app.request(`/people/${volunteer}`)).text())).toBeUndefined();
  });

  it("do not revoke a key that belongs to a different person than the page's", async () => {
    const { post, make, db, volunteer, staff } = await fixture();
    const staffKey = await make(STAFF_UID, "read");
    const res = await post(`/people/${volunteer}/keys/${staffKey.ref}/revoke`);
    expect(res.status).toBeLessThan(400);
    expect(await resolveKey(db, staffKey.key)).not.toBeNull();
    expect((await listKeys(db, STAFF_UID))[0]!.revokedBy).toBeNull();
    // And the other way round: the page of the key's own owner does it.
    expect((await post(`/people/${staff}/keys/${staffKey.ref}/revoke`)).status).toBeLessThan(400);
    expect(await resolveKey(db, staffKey.key)).toBeNull();
  });

  it("cannot be revoked by a volunteer, or by staff while viewing Beeline as someone", async () => {
    const volunteerSide = await fixture({ admin: false });
    const key = await volunteerSide.make(VOLUNTEER_UID, "read");
    expect((await volunteerSide.post(`/people/${volunteerSide.volunteer}/keys/${key.ref}/revoke`)).status).toBe(403);
    expect(await resolveKey(volunteerSide.db, key.key)).not.toBeNull();

    const { post, make, db, volunteer } = await fixture();
    const theirs = await make(VOLUNTEER_UID, "read");
    const as = `${IMPERSONATING_COOKIE}=${encodeURIComponent("Vera Volunteer")}`;
    expect((await post(`/people/${volunteer}/keys/${theirs.ref}/revoke`, {}, as)).status).toBe(403);
    expect(await resolveKey(db, theirs.key)).not.toBeNull();
  });

  it("has no button for a key already revoked or expired, and a second revoke changes nothing", async () => {
    const { app, post, make, conn, db, volunteer } = await fixture();
    const done = await make(VOLUNTEER_UID, "read");
    const old = await make(VOLUNTEER_UID, "read");
    await conn.run(`UPDATE api_key SET expires_at = current_timestamp - INTERVAL 1 MINUTE WHERE key_sha256 = '${hashKey(old.key)}'`);
    await post(`/people/${volunteer}/keys/${done.ref}/revoke`);
    const first = (await listKeys(db, VOLUNTEER_UID)).find((k) => k.ref === done.ref)!;
    const section = keysSection(await (await app.request(`/people/${volunteer}`)).text())!;
    expect(section).not.toContain(`/keys/${done.ref}/revoke`);
    expect(section).not.toContain(`/keys/${old.ref}/revoke`);
    // Revoked a second time, by the owner: nothing is overwritten.
    expect(await revokeKey(db, VOLUNTEER_UID, done.ref, { login: "vera", reason: "owner" })).toBe(false);
    await post(`/people/${volunteer}/keys/${done.ref}/revoke`);
    await post(`/people/${volunteer}/keys/${old.ref}/revoke`);
    const again = await listKeys(db, VOLUNTEER_UID);
    expect(again.find((k) => k.ref === done.ref)).toEqual(first);
    expect(again.find((k) => k.ref === old.ref)!.revokedBy).toBeNull();
  });
});

describe("who revoked a key, and why", () => {
  const record = async (db: Awaited<ReturnType<typeof fixture>>["db"], uid: number) => {
    const [k] = await listKeys(db, uid);
    return [k!.revokedBy, k!.revokedReason];
  };

  it("is the owner, on /keys", async () => {
    const { post, make, db } = await fixture();
    const key = await make(STAFF_UID);
    await post(`/keys/${key.ref}/revoke`);
    expect(await record(db, STAFF_UID)).toEqual(["staff", "owner"]);
  });

  it("is the staff member who revoked it, on the person's page", async () => {
    const { post, make, db, volunteer } = await fixture();
    const key = await make(VOLUNTEER_UID, "read");
    await post(`/people/${volunteer}/keys/${key.ref}/revoke`);
    expect(await record(db, VOLUNTEER_UID)).toEqual(["staff", "staff"]);
  });

  it("is the staff member who unlinked the account, as an account change", async () => {
    const { post, make, db, volunteer } = await fixture();
    await make(VOLUNTEER_UID, "read");
    await post(`/people/${volunteer}/account`, { inat_user_id: "", reason: "wrong person" });
    expect(await record(db, VOLUNTEER_UID)).toEqual(["staff", "account_changed"]);
  });

  it("is nobody, when the nightly step finds the account gone", async () => {
    const { make, db, conn } = await fixture();
    await make(VOLUNTEER_UID, "read");
    await conn.run(`DELETE FROM inat_account WHERE inat_user_id = ${VOLUNTEER_UID}`);
    await revokeOrphanedKeys(db);
    expect(await record(db, VOLUNTEER_UID)).toEqual([null, "account_gone"]);
  });

  it("is told on /keys in words, and only when it was not the owner", async () => {
    const { app, make, db } = await fixture({ admin: false });
    const owner = await make(STAFF_UID, "read");
    const changed = await make(STAFF_UID, "read");
    const gone = await make(STAFF_UID, "read");
    const byStaff = await make(STAFF_UID, "read");
    await revokeKey(db, STAFF_UID, owner.ref, { login: "staff", reason: "owner" });
    await revokeKey(db, STAFF_UID, byStaff.ref, { login: "samstaff", reason: "staff" });
    await db.updateTable("api_key").set({ revoked_at: sql`current_timestamp`, revoked_by: "samstaff", revoked_reason: "account_changed" }).where("key_sha256", "=", hashKey(changed.key)).execute();
    await db.updateTable("api_key").set({ revoked_at: sql`current_timestamp`, revoked_reason: "account_gone" }).where("key_sha256", "=", hashKey(gone.key)).execute();
    const html = await (await app.request("/keys")).text();
    expect(html).toContain("by samstaff<");
    expect(html).toContain("by samstaff: the iNaturalist account changed");
    expect(html).toContain("the iNaturalist account is no longer linked to anyone");
    expect(html).toMatch(/Revoked [A-Z][a-z]{2} \d+, \d{4}<\/span>/);
  });
});

describe("the gate for /api/v1", () => {
  it("answers 401 in JSON without a key, whatever cookie or session the request has", async () => {
    // The fixture's resolver signs every request in, as a session cookie would.
    const { api } = await fixture();
    const res = await api("/api/v1/me", undefined, { headers: { cookie: "__Host-beeline_session=anything" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("refuses a key that is unknown, expired or revoked, or whose account is unlinked", async () => {
    const { api, make, conn, db } = await fixture();
    expect((await api("/api/v1/me", `${KEY_PREFIX}${"a".repeat(43)}`)).status).toBe(401);
    expect((await api("/api/v1/me", "not-a-beeline-key")).status).toBe(401);

    const expired = await make(STAFF_UID);
    await conn.run(`UPDATE api_key SET expires_at = current_timestamp - INTERVAL 1 MINUTE WHERE key_sha256 = '${hashKey(expired.key)}'`);
    expect((await api("/api/v1/me", expired.key)).status).toBe(401);

    const revoked = await make(STAFF_UID);
    expect(await revokeKey(db, STAFF_UID, revoked.ref, OWNER)).toBe(true);
    expect((await api("/api/v1/me", revoked.key)).status).toBe(401);

    const unlinked = await make(VOLUNTEER_UID, "read");
    expect((await api("/api/v1/me", unlinked.key)).status).toBe(200);
    await conn.run(`DELETE FROM inat_account WHERE inat_user_id = ${VOLUNTEER_UID}`);
    expect((await api("/api/v1/me", unlinked.key)).status).toBe(401);
  });

  it("gives staff powers only to a staff key whose person is staff now", async () => {
    const { api, make, conn, staff } = await fixture();
    const staffKey = await make(STAFF_UID, "staff");
    const readKey = await make(STAFF_UID, "read");
    const volunteerStaffKey = await make(VOLUNTEER_UID, "staff");
    expect((await (await api("/api/v1/me", staffKey.key)).json()).staff).toBe(true);
    // A read key of a staff member is not a staff key.
    expect((await (await api("/api/v1/me", readKey.key)).json()).staff).toBe(false);
    // A staff key of someone who is not staff is not one either.
    expect((await (await api("/api/v1/me", volunteerStaffKey.key)).json()).staff).toBe(false);
    // Taking the rights away stops the key acting as staff at once.
    await conn.run(`DELETE FROM person_admin WHERE person_id = ${staff}`);
    expect((await (await api("/api/v1/me", staffKey.key)).json()).staff).toBe(false);
  });

  it("answers an unknown endpoint 404 in JSON to a key, and 401 without one", async () => {
    const { api, make } = await fixture();
    const { key } = await make(STAFF_UID);
    const res = await api("/api/v1/nothing-here", key);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not found");
    expect((await api("/api/v1/nothing-here")).status).toBe(401);
  });

  it("refuses credentials sent to any other path under /api/, and does not redirect them to the old Beeline", async () => {
    const { api, make } = await fixture();
    const { key } = await make(STAFF_UID);
    for (const path of ["/api/me", "/api/v2/me", "/api/tasks", "/api", "/tasks", "/admin", "/dashboard", "/datasets", "/scripts"]) {
      const res = await api(path, key, { redirect: "manual" });
      expect(res.status, path).toBe(401);
      expect(res.headers.get("location"), path).toBeNull();
    }
    // Without credentials the old Beeline's redirect still answers.
    const old = await api("/api/tasks", undefined, { redirect: "manual" });
    expect(old.status).toBe(307);
    expect(old.headers.get("location")).toBe(`${OLD_BEELINE_ORIGIN}/api/tasks`);
    const page = await api("/tasks", undefined, { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(`${OLD_BEELINE_ORIGIN}/tasks`);
  });

  it("records when a key was last used", async () => {
    const { api, make, db } = await fixture();
    const { key } = await make(STAFF_UID);
    expect((await listKeys(db, STAFF_UID))[0]!.lastUsedAt).toBeNull();
    await api("/api/v1/me", key);
    expect((await listKeys(db, STAFF_UID))[0]!.lastUsedAt).not.toBeNull();
  });

  it("slows a key that asks too often, and only that key", async () => {
    const { db, make } = await fixture();
    const app = new Hono().route("/api/v1", createApi({ db, isStaff: async () => true, limiter: keyRateLimiter({ limit: 2 }) }));
    const a = await make(STAFF_UID);
    const b = await make(VOLUNTEER_UID, "read");
    const ask = (key: string) => app.request("/api/v1/me", { headers: { authorization: `Bearer ${key}` } });
    expect((await ask(a.key)).status).toBe(200);
    expect((await ask(a.key)).status).toBe(200);
    const third = await ask(a.key);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await ask(b.key)).status).toBe(200);
  });

  it("answers a key over its limit without asking the store", async () => {
    const { db, make } = await fixture();
    const a = await make(STAFF_UID);
    let lookups = 0;
    // A store that counts what is asked of it: every query the API makes goes through here.
    const counting = new Proxy(db, {
      get(target, prop) {
        if (prop === "selectFrom" || prop === "updateTable") lookups += 1;
        // Bound to the real store: Kysely's methods read private fields a proxy does not have.
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const app = new Hono().route("/api/v1", createApi({ db: counting, isStaff: async () => true, limiter: keyRateLimiter({ limit: 1 }) }));
    const ask = () => app.request("/api/v1/me", { headers: { authorization: `Bearer ${a.key}` } });
    expect((await ask()).status).toBe(200);
    const before = lookups;
    expect(before).toBeGreaterThan(0);
    expect((await ask()).status).toBe(429);
    expect(lookups).toBe(before);
  });

  it("does not keep count of keys that do not work", async () => {
    const limiter = keyRateLimiter({ limit: 1 });
    const { db } = await fixture();
    const app = new Hono().route("/api/v1", createApi({ db, isStaff: async () => true, limiter }));
    const bad = `${KEY_PREFIX}${"z".repeat(43)}`;
    // Refused as unknown each time, never as too frequent: nothing is remembered about it.
    for (let i = 0; i < 3; i++) {
      expect((await app.request("/api/v1/me", { headers: { authorization: `Bearer ${bad}` } })).status).toBe(401);
    }
  });
});

describe("a key is not a way onto the pages", () => {
  it("is ignored by every page: a request with a working key and no session is not signed in", async () => {
    const { app, make } = await fixture({ signedIn: false });
    const { key } = await make(STAFF_UID);
    for (const path of ["/", "/samples", "/specimens", "/people", "/keys", "/jobs", "/samples.csv"]) {
      const res = await app.request(path, { headers: { authorization: `Bearer ${key}` } });
      expect(res.status, path).toBe(401);
    }
    const write = await app.request("/keys", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "name=k&scope=staff&lifetime=30",
    });
    expect(write.status).toBe(401);
  });
});

describe("saving an account that does not change", () => {
  it("leaves the account's keys working when staff save the same account, or correct only its login", async () => {
    const { post, make, db, volunteer } = await fixture();
    const theirs = await make(VOLUNTEER_UID, "read");
    for (const login of ["vera", "vera_renamed"]) {
      const res = await post(`/people/${volunteer}/account`, { inat_user_id: String(VOLUNTEER_UID), login, reason: "checked" });
      expect(res.status).toBeLessThan(400);
      expect(await resolveKey(db, theirs.key)).not.toBeNull();
    }
    // A different account is a change: the old account's keys go.
    await post(`/people/${volunteer}/account`, { inat_user_id: "4242", login: "newvera", reason: "new account" });
    expect(await resolveKey(db, theirs.key)).toBeNull();
    expect((await listKeys(db, VOLUNTEER_UID))[0]!.revokedAt).not.toBeNull();
  });
});

describe("a key in a log line", () => {
  it("is redacted, with or without Bearer before it", () => {
    const key = `${KEY_PREFIX}${"Ab3_-".repeat(8)}xyz`;
    expect(redact(`lookup failed for ${key} today`)).toBe("lookup failed for [token] today");
    expect(redact(`Authorization: Bearer ${key}`)).not.toContain(key);
  });
});

describe("keys of an account that stops meaning what it meant", () => {
  it("are revoked when staff unlink the account on /people, before it can be linked to anyone else", async () => {
    const { post, make, db, volunteer } = await fixture();
    const theirs = await make(VOLUNTEER_UID, "read");
    const mine = await make(STAFF_UID);
    const res = await post(`/people/${volunteer}/account`, { inat_user_id: "", reason: "wrong person" });
    expect(res.status).toBeLessThan(400);
    expect((await listKeys(db, VOLUNTEER_UID))[0]!.revokedAt).not.toBeNull();
    expect(await resolveKey(db, theirs.key)).toBeNull();
    expect(await resolveKey(db, mine.key)).not.toBeNull();
  });


  it("are all revoked when the account is unlinked, so linking it to someone else does not revive them", async () => {
    const { db, make, conn, staff } = await fixture();
    const a = await make(VOLUNTEER_UID, "read");
    const b = await make(VOLUNTEER_UID, "read");
    const other = await make(STAFF_UID);
    await revokeKeysFor(db, VOLUNTEER_UID, "staff");
    // The account is then linked to another person: the old keys stay dead.
    await conn.run(`DELETE FROM inat_account WHERE inat_user_id = ${STAFF_UID}`);
    await conn.run(`UPDATE inat_account SET person_id = ${staff} WHERE inat_user_id = ${VOLUNTEER_UID}`);
    expect(await resolveKey(db, a.key)).toBeNull();
    expect(await resolveKey(db, b.key)).toBeNull();
    // Another account's keys are untouched (this one's account was removed above, so ask the table).
    expect((await listKeys(db, STAFF_UID)).find((k) => k.ref === other.ref)!.revokedAt).toBeNull();
  });

  it("are revoked by the nightly step when the account is gone some other way", async () => {
    const { db, make, conn } = await fixture();
    const gone = await make(VOLUNTEER_UID, "read");
    const kept = await make(STAFF_UID);
    await conn.run(`DELETE FROM inat_account WHERE inat_user_id = ${VOLUNTEER_UID}`);
    await revokeOrphanedKeys(db);
    expect((await listKeys(db, VOLUNTEER_UID))[0]!.revokedAt).not.toBeNull();
    expect(await resolveKey(db, kept.key)).not.toBeNull();
    // Linking the account again does not bring the key back.
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) SELECT entity_id, ${VOLUNTEER_UID}, 'vera' FROM person WHERE display_name = 'Vera Volunteer'`);
    expect(await resolveKey(db, gone.key)).toBeNull();
  });
});
