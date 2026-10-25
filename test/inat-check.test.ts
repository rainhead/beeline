// "Check iNaturalist now" on the dashboard (beeline-yso): a volunteer's fix
// on iNaturalist read back at once. iNaturalist is faked; the place ids are
// the real ones (Oregon 10, Benton County 484, United States 1).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import { ACTING_COOKIE, IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { en } from "../src/app/messages/en.js";
import { lastSyncStart } from "../src/app/jobs/registry.js";
import { resetCheckAttempts } from "../src/app/inat-check.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { attachPrivateStore } from "../src/app/db.js";
import { promoteObservations } from "../src/promote-observations.js";
import { syncINat } from "../src/sync-inat.js";
import { createMemoryDb, rows, scratchPaths } from "./helpers.js";

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const ADA = 100;
const BO = 200;
let seasonDay: string;

/** A sample observed a month into this season, as iNaturalist serves it: Ada's by default. */
function obs(id: number, placeGuess: string, user = ADA): Record<string, unknown> {
  return {
    id,
    uuid: `uuid-${id}`,
    observed_on: seasonDay,
    geojson: { coordinates: [-123.262, 44.5646], type: "Point" },
    positional_accuracy: 30,
    public_positional_accuracy: 30,
    geoprivacy: null,
    taxon_geoprivacy: null,
    place_ids: [1, 10, 484],
    place_guess: placeGuess,
    user: { id: user, login: user === ADA ? "adacollects" : "bonets", name: user === ADA ? "Ada Collector" : "Bo Netter" },
    taxon: { id: 47604, name: "Rubus", ancestor_ids: [48460, 47126, 211194, 47604] },
    ofvs: [
      { name: "sampleId", value: "1" },
      { name: "numberOfSpecimens", value: "3" },
    ],
  };
}

/**
 * iNaturalist serving one project's observations, narrowed to the user a
 * request names as the real API narrows it; `null` is iNaturalist down.
 */
function fakeInat(served: () => Record<string, unknown>[] | null, asked: URL[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url);
    const all = served();
    if (all === null) return new Response(null, { status: 503 });
    const user = url.searchParams.get("user_id");
    const results = all.filter((o) => user === null || String((o.user as { id: number }).id) === user);
    return new Response(JSON.stringify({ total_results: results.length, results }));
  }) as typeof fetch;
}

async function checkApp(opts: { running?: string; signedIn?: "ada" | "carl" } = {}) {
  const { instance, conn } = await createMemoryDb();
  await attachPrivateStore(instance, { path: ":memory:", key: null });
  [[seasonDay]] = (await rows(conn, "SELECT CAST(active_since + 30 AS VARCHAR) FROM season")) as [[string]];
  for (const [id, name, level] of [
    [1, "United States", 0],
    [10, "Oregon", 10],
    [484, "Benton", 20],
  ] as const) {
    await conn.run(`INSERT INTO inat_place (inat_place_id, name, admin_level) VALUES (${id}, '${name}', ${level})`);
  }
  await conn.run(`INSERT INTO person (display_name, given_name, family_name) VALUES
                  ('Ada Collector', 'Ada', 'Collector'), ('Bo Netter', 'Bo', 'Netter'), ('Carl Staff', 'Carl', 'Staff')`);
  const people = (await rows(conn, "SELECT entity_id FROM person ORDER BY display_name")) as [[number], [number], [number]];
  const ada = people[0][0];
  // Carl holds no iNaturalist account. He may act for Ada, and as an admin
  // he may view Beeline as she sees it.
  const carl = people[2][0];
  await conn.run(`INSERT INTO person_delegate (person_id, acts_for_id, granted_by) VALUES (${carl}, ${ada}, 'peter')`);
  await conn.run(`INSERT INTO person_admin (person_id, granted_by) VALUES (${carl}, 'peter')`);
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${ada}, ${ADA}, 'adacollects')`);
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${people[1][0]}, ${BO}, 'bonets')`);

  const dir = await mkdtemp(join(tmpdir(), "inat-check-"));
  const asked: URL[] = [];
  let served: Record<string, unknown>[] | null = [obs(1, "OR, US"), obs(2, "Finley NWR, OR, US", BO)];
  const db = createKysely(instance);
  const app = createApp({
    ...(await scratchPaths()),
    db,
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () =>
      opts.signedIn === "carl"
        ? { personId: carl, login: "carlstaff", iconUrl: null }
        : { personId: ada, login: "adacollects", iconUrl: null },
    jobs: { list: [], start: async () => false, running: () => opts.running ?? null },
    personChangesPath: join(dir, "person-change.csv"),
    sampleOverlayPath: join(dir, "sample-overlay.csv"),
    sampleChangesPath: join(dir, "sample-change.csv"),
    sampleStatePath: join(dir, "sample-state.csv"),
    conn,
    mintConn: await instance.connect(),
    inatCheck: {
      projects: [18521, 166376],
      token: async () => "jwt",
      fetchImpl: fakeInat(() => served, asked),
      pageDelayMs: 0,
    },
  });
  // What the nightly already made of the observations: Ada's sample 1 with no
  // locality, since "OR, US" names no place, and Bo's.
  await syncINat(conn, { projectId: 18521, token: "jwt", fetchImpl: fakeInat(() => served, []), pageDelayMs: 0 });
  await promoteObservations(conn);
  const serve = (o: Record<string, unknown>[] | null) => {
    served = o;
  };
  return { app, conn, db, asked, serve };
}

const check = (app: Awaited<ReturnType<typeof checkApp>>["app"], cookie?: string) =>
  app.request("/inaturalist/check", {
    method: "POST",
    headers: {
      origin: "http://localhost:3054",
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { cookie }),
    },
  });

const count = async (conn: DuckDBConnection, sql: string) => Number(((await rows(conn, sql))[0] ?? [0])[0]);
const missingLocality = (conn: DuckDBConnection) =>
  count(conn, "SELECT count(*) FROM qc_rule_missing_required_field WHERE details LIKE '%locality%'");

beforeEach(() => resetCheckAttempts());

describe("Check iNaturalist now", () => {
  it("reads the active seasons' observations again, so a fix made on iNaturalist clears its flag at once", async () => {
    const { app, conn, asked, serve } = await checkApp();
    expect(await missingLocality(conn)).toBe(1);
    expect(await (await app.request("/")).text()).toContain("Check iNaturalist now");

    serve([obs(1, "Finley NWR, OR, US"), obs(2, "Finley NWR, OR, US", BO)]);
    const body = await (await check(app)).text();
    // Ada's observation, once from each project's answer.
    expect(body).toContain("Beeline read 2 of your recent observations again. 1 had changed");
    expect(await missingLocality(conn)).toBe(0);
    expect(await count(conn, "SELECT count(*) FROM sample WHERE locality = 'Finley NWR'")).toBe(2);
    expect(body).toContain("Last checked");

    // One request per project, each naming that project and Ada, for the whole
    // season rather than what iNaturalist says changed.
    const [[seasonStart]] = (await rows(conn, "SELECT CAST(active_since AS VARCHAR) FROM season")) as [[string]];
    expect(
      asked.map((u) => [u.searchParams.get("project_id"), u.searchParams.get("user_id"), u.searchParams.get("d1"), u.searchParams.get("updated_since")]),
    ).toEqual([
      ["18521", String(ADA), seasonStart, null],
      ["166376", String(ADA), seasonStart, null],
    ]);
  });

  it("refuses a second check within the minute, and any check while the nightly reads iNaturalist", async () => {
    const { app, asked } = await checkApp();
    await check(app);
    const before = asked.length;
    expect(await (await check(app)).text()).toMatch(/It can check again in \d+ seconds?\./);
    expect(asked.length).toBe(before);

    resetCheckAttempts();
    const busy = await checkApp({ running: "nightly-pipeline" });
    expect(await (await check(busy.app)).text()).toContain("reading everybody&#39;s observations from iNaturalist right now");
    expect(busy.asked).toEqual([]);
  });

  it("says nothing changed when iNaturalist cannot be reached, records no run, and still counts the attempt", async () => {
    const { app, conn, asked, serve } = await checkApp();
    serve(null);
    expect(await (await check(app)).text()).toContain("couldn&#39;t reach iNaturalist just now");
    expect(await count(conn, "SELECT count(*) FROM sync_run WHERE observer_user_id IS NOT NULL")).toBe(0);
    expect(await missingLocality(conn)).toBe(1);
    const before = asked.length;
    expect(await (await check(app)).text()).toMatch(/It can check again in/);
    expect(asked.length).toBe(before);
  });
});

describe("whose observations", () => {
  it("are those of the person acted for", async () => {
    const { app, asked } = await checkApp({ signedIn: "carl" });
    // Carl, as himself, has no account to check, so no button.
    expect(await (await app.request("/")).text()).not.toContain(en.qc.check.button);
    const acting = `${ACTING_COOKIE}=${encodeURIComponent("Ada Collector")}`;
    expect(await (await app.request("/", { headers: { cookie: acting } })).text()).toContain(en.qc.check.button);
    await check(app, acting);
    expect(asked.map((u) => u.searchParams.get("user_id"))).toEqual([String(ADA), String(ADA)]);
  });

  it("are only looked at while impersonating: the button shows, and pressing it is refused", async () => {
    const { app, asked } = await checkApp({ signedIn: "carl" });
    const viewing = `${IMPERSONATING_COOKIE}=${encodeURIComponent("Ada Collector")}`;
    expect(await (await app.request("/", { headers: { cookie: viewing } })).text()).toContain(en.qc.check.button);
    const res = await check(app, viewing);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(en.errors.readOnlyImpersonating);
    expect(asked).toEqual([]);
  });
});

describe("a run that read one observer", () => {
  it("leaves the nightly's watermark alone, and proves only that observer's observations gone", async () => {
    const { app, conn, db, serve } = await checkApp();
    const watermark = await lastSyncStart(db, "18521");
    expect(watermark).not.toBeNull();

    // Ada deleted her observation; Bo's is still there, but Ada's check never
    // asked about it, so it must not read as gone.
    serve([obs(2, "Finley NWR, OR, US", BO)]);
    await check(app);
    expect(await lastSyncStart(db, "18521")).toEqual(watermark);
    expect(
      await rows(
        conn,
        `SELECT s.inat_observation_id FROM qc_rule_observation_missing_upstream q JOIN sample s ON s.entity_id = q.sample_id`,
      ),
    ).toEqual([[1n]]);
  });
});
