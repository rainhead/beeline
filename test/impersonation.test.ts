import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { createMemoryDb, insertCleanSample } from "./helpers.js";
import { en } from "../src/app/messages/en.js";
import { IMPERSONATING_COOKIE } from "../src/app/acting.js";

const unusedInat: InatClient = {
  authorizeUrl: () => "https://inat.example/authorize",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

/**
 * Impersonation (beeline-jjt): staff viewing Beeline as one volunteer.
 *
 * Two people, one sample each. Whether the signed-in one is an admin is the
 * fixture's one switch — run on the sandbox environment, since development
 * makes everyone an admin (src/app/server.tsx isAdmin).
 */
async function fixture({ admin, twins = false }: { admin: boolean; twins?: boolean }) {
  const { instance, conn } = await createMemoryDb();
  await conn.run(`INSERT INTO person (display_name) VALUES ('Staff Member'), ('Robert Pederson')`);
  const [[robert], [staff]] = (await (
    await conn.run(`SELECT entity_id FROM person ORDER BY display_name`)
  ).getRows()) as [[number], [number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${staff}, 111, 'staff')`);
  await insertCleanSample(conn, { collector_id: String(staff), sample_number: "'S-1'" });
  const robertSampleId = await insertCleanSample(conn, { collector_id: String(robert), sample_number: "'R-1'" });
  if (admin) await conn.run(`INSERT INTO person_admin (person_id, granted_by) VALUES (${staff}, 'peter')`);
  // A second Robert Pederson: a name two people share names neither of them.
  if (twins) await conn.run(`INSERT INTO person (display_name) VALUES ('Robert Pederson')`);
  const db = createKysely(instance);
  const app = createApp({
    db,
    config: { environment: "sandbox", origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: Number(staff), login: "staff", iconUrl: null }),
  });
  const get = (path: string, cookie?: string) =>
    app.request(path, cookie === undefined ? {} : { headers: { cookie } });
  const post = (path: string, cookie?: string, body?: Record<string, string>) =>
    app.request(path, {
      method: "POST",
      headers: {
        origin: "http://localhost:3054",
        ...(cookie === undefined ? {} : { cookie }),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body ?? {}).toString(),
    });
  return { app, get, post, staff: Number(staff), robert: Number(robert), robertSample: robertSampleId };
}

const cookie = (name: string) => `${IMPERSONATING_COOKIE}=${encodeURIComponent(name)}`;
const ROBERT = "Robert Pederson";

describe("viewing Beeline as somebody else", () => {
  it("is offered on the person's page, to admins, and turning it on sets the cookie by name", async () => {
    const { get, post, robert } = await fixture({ admin: true });
    expect(await (await get(`/people/${robert}`)).text()).toContain(en.people.viewAsButton(ROBERT));
    const res = await post(`/people/${robert}/impersonate`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain(`${IMPERSONATING_COOKIE}=${encodeURIComponent(ROBERT)}`);
  });

  it("makes `mine` mean the other person on every surface that says mine, and says so", async () => {
    const { get } = await fixture({ admin: true });
    const own = await (await get("/samples")).text();
    expect(own).toContain("S-1");
    expect(own).not.toContain("R-1");

    const viewing = await (await get("/samples", cookie(ROBERT))).text();
    expect(viewing).toContain("R-1");
    expect(viewing).not.toContain("S-1");
    expect(viewing).toContain(en.layout.impersonating.banner(ROBERT));
    // The delegation banner is a different statement, and not this one.
    expect(viewing).not.toContain(en.layout.acting.banner(ROBERT));

    const home = await (await get("/", cookie(ROBERT))).text();
    expect(home).toContain(en.layout.impersonating.banner(ROBERT));
    const csv = await (await get("/samples.csv", cookie(ROBERT))).text();
    expect(csv).toContain("R-1");
    expect(csv).not.toContain("S-1");
  });

  it("takes the admin surfaces away for the duration, so the view is the volunteer's", async () => {
    const { get } = await fixture({ admin: true });
    expect((await get("/people")).status).toBe(200);
    const home = await (await get("/", cookie(ROBERT))).text();
    expect(home).not.toContain('href="/people"');
    expect(home).not.toContain('href="/jobs"');
    expect((await get("/people", cookie(ROBERT))).status).toBe(403);
    expect((await get("/jobs", cookie(ROBERT))).status).toBe(403);
    // Scope is forced to mine: staff-only filters are gone from the listing.
    const listing = await (await get("/samples?scope=all", cookie(ROBERT))).text();
    expect(listing).toContain("R-1");
    expect(listing).not.toContain("S-1");
  });

  it("is read-only: the volunteer's edit form renders, and a save is refused", async () => {
    const { get, post, robertSample } = await fixture({ admin: true });
    expect((await get(`/samples/${robertSample}/edit`, cookie(ROBERT))).status).toBe(200);
    const res = await post(`/samples/${robertSample}/edit`, cookie(ROBERT), { locality: "Elsewhere" });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(en.errors.readOnlyImpersonating);
  });

  it("can be stopped without admin rights, since those are off while it is on", async () => {
    const { post } = await fixture({ admin: true });
    const res = await post("/impersonation/stop", cookie(ROBERT));
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${IMPERSONATING_COOKIE}=;`));
  });

  it("does nothing for a volunteer, however the cookie was obtained", async () => {
    const { get, post, robert } = await fixture({ admin: false });
    expect((await post(`/people/${robert}/impersonate`)).status).toBe(403);
    const body = await (await get("/samples", cookie(ROBERT))).text();
    expect(body).toContain("S-1");
    expect(body).not.toContain("R-1");
    expect(body).not.toContain(en.layout.impersonating.banner(ROBERT));
  });

  it("resolves a name two people share to nobody, rather than pick", async () => {
    const { get } = await fixture({ admin: true, twins: true });
    const body = await (await get("/samples", cookie(ROBERT))).text();
    expect(body).toContain("S-1");
    expect(body).not.toContain("R-1");
    expect(body).not.toContain(en.layout.impersonating.banner(ROBERT));
  });
});
