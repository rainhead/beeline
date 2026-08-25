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
async function household({ granted }: { granted: boolean }) {
  const { instance, conn } = await createMemoryDb();
  await conn.run(`INSERT INTO person (display_name) VALUES ('Gretchen Pederson'), ('Robert Pederson')`);
  const [[gretchen], [robert]] = (await (
    await conn.run(`SELECT entity_id FROM person ORDER BY display_name`)
  ).getRows()) as [[number], [number]];
  await conn.run(
    `INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${gretchen}, 111, 'pandg')`,
  );
  await insertCleanSample(conn, { collector_id: String(gretchen), sample_number: "'G-1'" });
  await insertCleanSample(conn, { collector_id: String(robert), sample_number: "'R-1'" });
  if (granted) {
    await conn.run(
      `INSERT INTO person_delegate (person_id, acts_for_id, granted_by) VALUES (${gretchen}, ${robert}, 'peter')`,
    );
  }
  const db = createKysely(instance);
  const app = createApp({
    db,
    config: { environment: "development" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: Number(gretchen), login: "pandg", iconUrl: null }),
  });
  const get = (path: string, cookie?: string) =>
    app.request(path, cookie === undefined ? {} : { headers: { cookie } });
  return { app, get, gretchen: Number(gretchen), robert: Number(robert) };
}

describe("acting for somebody else", () => {
  it("offers the switch only to someone who holds a grant", async () => {
    const granted = await household({ granted: true });
    expect(await (await granted.get("/")).text()).toContain(en.layout.acting.startFor("Robert Pederson"));
    const ungranted = await household({ granted: false });
    expect(await (await ungranted.get("/")).text()).not.toContain(en.layout.acting.start);
  });

  it("makes `mine` mean the other person, and says so on every page", async () => {
    const { get, robert } = await household({ granted: true });
    const own = await (await get("/samples")).text();
    expect(own).toContain("G-1");
    expect(own).not.toContain("R-1");

    const acting = await (await get("/samples", `${ACTING_COOKIE}=${robert}`)).text();
    // `mine` is now Robert's — not both, which is the whole point of a
    // switch rather than a widening.
    expect(acting).toContain("R-1");
    expect(acting).not.toContain("G-1");
    expect(acting).toContain(en.layout.acting.banner("Robert Pederson"));
  });

  it("ignores a cookie naming someone this session was never granted", async () => {
    const { get, robert } = await household({ granted: false });
    const res = await get("/samples", `${ACTING_COOKIE}=${robert}`);
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
    expect(started.headers.get("set-cookie")).toContain(`${ACTING_COOKIE}=${robert}`);

    const stopped = await app.request("/acting/stop", {
      method: "POST",
      headers: { origin: "http://localhost:3054" },
    });
    expect(stopped.status).toBe(302);
    // An expiry in the past is how a cookie is cleared.
    expect(stopped.headers.get("set-cookie")).toContain(`${ACTING_COOKIE}=`);
  });
});
