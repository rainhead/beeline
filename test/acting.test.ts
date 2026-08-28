import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { createMemoryDb, insertCleanSample } from "./helpers.js";
import { en } from "../src/app/messages/en.js";
import { ACTING_COOKIE } from "../src/app/acting.js";

const unusedInat: InatClient = {
  authorizeUrl: () => "https://inat.example/authorize",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

/**
 * Acting for somebody else (beeline-oyl).
 *
 * Gretchen holds the household's iNat login; Robert does not, and never will,
 * so his samples are only reachable through a grant. The fixture is that
 * shape: two people, one sample each, and one account.
 */
async function household({
  granted,
  chain = false,
  // Development makes everyone an admin (src/app/server.tsx isAdmin), so any
  // test about admin rights has to leave it.
  environment = "development" as "development" | "sandbox",
  robertIsAdmin = false,
}: {
  granted: boolean;
  chain?: boolean;
  environment?: "development" | "sandbox";
  robertIsAdmin?: boolean;
}) {
  const { instance, conn } = await createMemoryDb();
  await conn.run(`INSERT INTO person (display_name) VALUES ('Gretchen Pederson'), ('Robert Pederson')`);
  const [[gretchen], [robert]] = (await (
    await conn.run(`SELECT entity_id FROM person ORDER BY display_name`)
  ).getRows()) as [[number], [number]];
  await conn.run(
    `INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${gretchen}, 111, 'pandg')`,
  );
  await insertCleanSample(conn, { collector_id: String(gretchen), sample_number: "'G-1'" });
  const robertSampleId = await insertCleanSample(conn, {
    collector_id: String(robert),
    sample_number: "'R-1'",
  });
  if (granted) {
    await conn.run(
      `INSERT INTO person_delegate (person_id, acts_for_id, granted_by) VALUES (${gretchen}, ${robert}, 'peter')`,
    );
  }
  // A third person Robert may act for, to prove the grant does not chain.
  let jane = 0;
  if (chain) {
    await conn.run(`INSERT INTO person (display_name) VALUES ('Jane Pope')`);
    const [[id]] = (await (
      await conn.run(`SELECT entity_id FROM person WHERE display_name = 'Jane Pope'`)
    ).getRows()) as [[number]];
    jane = Number(id);
    await conn.run(
      `INSERT INTO person_delegate (person_id, acts_for_id, granted_by) VALUES (${robert}, ${jane}, 'peter')`,
    );
  }
  if (robertIsAdmin) {
    await conn.run(`INSERT INTO person_admin (person_id, granted_by) VALUES (${robert}, 'peter')`);
  }
  const db = createKysely(instance);
  const app = createApp({
    db,
    config: { environment, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: Number(gretchen), login: "pandg", iconUrl: null }),
  });
  const get = (path: string, cookie?: string) =>
    app.request(path, cookie === undefined ? {} : { headers: { cookie } });
  return {
    app,
    get,
    gretchen: Number(gretchen),
    robert: Number(robert),
    jane,
    robertSample: { id: robertSampleId, owner: Number(robert) },
  };
}

/**
 * The cookie names the person, not their id (beeline-ten's second home): an
 * id is a per-store draw a rebuild redraws, and this cookie is client-held so
 * no rebuild can reach it.
 */
const actingCookie = (name: string) => `${ACTING_COOKIE}=${encodeURIComponent(name)}`;
const ROBERT = "Robert Pederson";

describe("acting for somebody else", () => {
  it("offers the switch only to someone who holds a grant", async () => {
    const granted = await household({ granted: true });
    expect(await (await granted.get("/")).text()).toContain(en.layout.acting.startFor("Robert Pederson"));
    const ungranted = await household({ granted: false });
    expect(await (await ungranted.get("/")).text()).not.toContain(en.layout.acting.start);
  });

  it("makes `mine` mean the other person, on every surface that says mine", async () => {
    const { get, robert } = await household({ granted: true });
    const own = await (await get("/samples")).text();
    expect(own).toContain("G-1");
    expect(own).not.toContain("R-1");

    const acting = await (await get("/samples", actingCookie(ROBERT))).text();
    // `mine` is now Robert's — not both, which is the whole point of a
    // switch rather than a widening.
    expect(acting).toContain("R-1");
    expect(acting).not.toContain("G-1");
    expect(acting).toContain(en.layout.acting.banner("Robert Pederson"));

    // The QC home and the CSV are the other two "mine" surfaces, and a CSV
    // that disagreed with the page above it would be the worst of the three.
    const home = await (await get("/", actingCookie(ROBERT))).text();
    expect(home).toContain(en.layout.acting.banner("Robert Pederson"));
    const csv = await (await get("/samples.csv", actingCookie(ROBERT))).text();
    expect(csv).toContain("R-1");
    expect(csv).not.toContain("G-1");
  });

  // Reach means reach to ACT, not only to look — the edit gate follows the
  // switch in both directions.
  it("opens the other person's editable sample, and closes it again when switched off", async () => {
    const { get, robertSample } = await household({ granted: true });
    const cookie = actingCookie(ROBERT);
    expect((await get(`/samples/${robertSample.id}/edit`, cookie)).status).toBe(200);
    // Without the switch it is somebody else's sample and stays shut.
    expect((await get(`/samples/${robertSample.id}/edit`)).status).toBe(404);
  });

  it("confers no admin, even when the person acted for is an admin", async () => {
    // The sharp version: Robert holds admin, Gretchen does not. If acting
    // meant becoming, the switch would be a privilege escalation.
    const { get, robert } = await household({
      granted: true,
      environment: "sandbox",
      robertIsAdmin: true,
    });
    expect((await get("/people")).status).toBe(403);
    expect((await get("/people", actingCookie(ROBERT))).status).toBe(403);
  });

  it("does not chain: reaching Robert is not reaching whoever Robert may reach", async () => {
    const { get, robert, jane } = await household({ granted: true, chain: true });
    // Gretchen may act for Robert; Robert may act for Jane. Gretchen may not
    // reach Jane, because canActFor always derives from the SIGNED-IN person
    // and never from whoever is currently being acted for.
    const acting = await (await get("/", actingCookie(ROBERT))).text();
    expect(acting).toContain(en.layout.acting.banner("Robert Pederson"));
    expect(acting).not.toContain(en.layout.acting.startFor("Jane Pope"));
    // And naming Jane directly resolves to nothing: no grant, no switch.
    const direct = await (await get("/", actingCookie("Jane Pope"))).text();
    expect(direct).not.toContain(en.layout.acting.banner("Jane Pope"));
  });

  it("a stale cookie cannot land on a different granted person", async () => {
    // beeline-ten's second home. The cookie is client-held, so no rebuild can
    // reach it, and a rebuild redraws every entity_id — a delegate holding two
    // grants whose numbers permute would have had the old cookie silently
    // select the *other* one, on a switch that gates writes. Naming the person
    // means a stale value either still names them or names nobody.
    const { get } = await household({ granted: true });
    // The number Robert used to be, now belonging to somebody else entirely.
    const stale = `${ACTING_COOKIE}=1`;
    const body = await (await get("/samples", stale)).text();
    expect(body).toContain("G-1");
    expect(body).not.toContain("R-1");
  });

  it("ignores a cookie naming someone this session was never granted", async () => {
    const { get, robert } = await household({ granted: false });
    const res = await get("/samples", actingCookie(ROBERT));
    const body = await res.text();
    // Falls back to the signed-in person rather than erroring: this is also
    // what a revoked grant looks like from here.
    expect(body).toContain("G-1");
    expect(body).not.toContain("R-1");
    expect(body).not.toContain(en.layout.acting.banner("Robert Pederson"));
  });

  it("ignores a cookie that is not a person id at all", async () => {
    const { get } = await household({ granted: true });
    const body = await (await get("/samples", `${ACTING_COOKIE}=' OR 1=1`)).text();
    expect(body).toContain("G-1");
  });

  it("refuses to start acting for someone ungranted", async () => {
    const { app, robert } = await household({ granted: false });
    const res = await app.request("/acting", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:3054" },
      body: `person=${robert}`,
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("starts and stops, and stopping gives the signed-in person back", async () => {
    const { app, robert } = await household({ granted: true });
    const started = await app.request("/acting", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost:3054" },
      body: `person=${robert}`,
    });
    expect(started.status).toBe(302);
    expect(started.headers.get("set-cookie")).toContain(actingCookie(ROBERT));

    const stopped = await app.request("/acting/stop", {
      method: "POST",
      headers: { origin: "http://localhost:3054" },
    });
    expect(stopped.status).toBe(302);
    // Prove it actually clears rather than merely mentioning the cookie:
    // an empty value with Max-Age=0 is what deletion looks like on the wire.
    const cleared = stopped.headers.get("set-cookie") ?? "";
    expect(cleared).toMatch(new RegExp(`${ACTING_COOKIE}=;`));
    expect(cleared).toContain("Max-Age=0");
  });

  it("signing out ends the switch too", async () => {
    const { app } = await household({ granted: true });
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { origin: "http://localhost:3054" },
    });
    const cookies = res.headers.get("set-cookie") ?? "";
    expect(cookies).toContain(ACTING_COOKIE);
  });
});
