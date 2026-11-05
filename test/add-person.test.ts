import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import { createApp } from "../src/app/server.js";
import { canonicalJson } from "../src/sync-inat.js";
import { refreshObservationFields } from "../src/refresh-observation-fields.js";
import { readOverlay } from "../src/person-overlay.js";
import type { InatClient } from "../src/app/auth.js";
import { attachPrivateStore } from "../src/app/db.js";
import { inatProfiles, parseInatAccount, type InatProfile } from "../src/app/add-person.js";
import { createMemoryDb, currentSeasonDate, rows } from "./helpers.js";

/**
 * Adding somebody by their iNaturalist account (beeline-2c3.33): staff and
 * anyone else with no collection records, who until this could only be added
 * by a row in ingest/person-overlay.csv and a deploy.
 *
 * The accounts are real ones from production's first days, where it helps to
 * see the shape: jenlarsen52 is a staff member who was turned away at sign-in
 * (an account with no profile name and no observations), kragadox one with a
 * name and years of observations. The profiles are written here, not fetched.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const PROFILES: InatProfile[] = [
  { id: 11227491, login: "jenlarsen52", name: null, iconUrl: null, observations: 0, joined: new Date("2026-11-04T17:20:00Z") },
  { id: 204323, login: "kragadox", name: "Craig Fiehler", iconUrl: null, observations: 1316, joined: new Date("2016-03-25T00:00:00Z") },
  { id: 222, login: "bonets", name: "Bo Netter", iconUrl: null, observations: 40, joined: null },
  { id: 500, login: "newbee", name: "Cy Newcomer", iconUrl: null, observations: 3, joined: null },
];

/** Looks profiles up in PROFILES, by login or id, as iNaturalist's API does; counts its calls. */
function fakeProfiles(opts: { failing?: boolean } = {}) {
  const asked: string[] = [];
  const lookUp = async (q: string) => {
    asked.push(q);
    if (opts.failing) throw new Error("iNaturalist profile lookup failed: 503");
    return PROFILES.find((p) => p.login === q || String(p.id) === q) ?? null;
  };
  return { lookUp, asked };
}

const idOf = async (conn: DuckDBConnection, name: string) =>
  Number(((await rows(conn, `SELECT entity_id FROM person WHERE display_name = '${name}'`))[0] ?? [0])[0]);

async function addApp(opts: { admin?: boolean; failing?: boolean } = {}) {
  const { instance, conn } = await createMemoryDb();
  await attachPrivateStore(instance, { path: ":memory:", key: null });
  // Drawn from the sequence, never written by hand: `create` draws a person id too.
  await conn.run(`INSERT INTO person (display_name, given_name, family_name) VALUES
                  ('Staff Person', 'Staff', 'Person'),
                  ('Bo Netter', 'Bo', 'Netter')`);
  const staff = await idOf(conn, "Staff Person");
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${staff}, 333, 'staffer')`);
  await conn.run(
    `INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${await idOf(conn, "Bo Netter")}, 222, 'bonets')`,
  );
  if (opts.admin ?? true) await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staff})`);

  const dir = await mkdtemp(join(tmpdir(), "add-person-"));
  const overlayPath = join(dir, "person-overlay.csv");
  const db = createKysely(instance);
  const profiles = fakeProfiles({ failing: opts.failing });
  const app = createApp({
    db,
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: staff, login: "staffer", iconUrl: null }),
    personOverlayPath: overlayPath,
    personChangesPath: join(dir, "person-change.csv"),
    sampleOverlayPath: join(dir, "sample-overlay.csv"),
    sampleChangesPath: join(dir, "sample-change.csv"),
    sampleStatePath: join(dir, "sample-state.csv"),
    correctionsPath: join(dir, "corrections.csv"),
    programContactsPath: join(dir, "program-contacts.csv"),
    printRunsDir: join(dir, "print-runs"),
    conn,
    inatProfiles: profiles.lookUp,
  });
  return { app, conn, db, overlayPath, asked: profiles.asked };
}

type App = Awaited<ReturnType<typeof addApp>>["app"];

/** Copy as the page escapes it. */
const html = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const post = (app: App, body: Record<string, string>) =>
  app.request("/people/new", {
    method: "POST",
    headers: { origin: "http://localhost:3054", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

/** A sign-in that was turned away, as src/app/auth.tsx records one. */
const turnedAwayAt = (conn: DuckDBConnection, uid: number, login: string, at: string) =>
  conn.run(
    `INSERT INTO private.inat_sign_in (inat_user_id, login, created_at, last_login_at) VALUES (${uid}, '${login}', TIMESTAMP '${at}', TIMESTAMP '${at}')`,
  );

describe("reading the account staff typed", () => {
  it("takes a login, an @login, or a profile link, by login or by id", () => {
    expect(parseInatAccount("jenlarsen52")).toBe("jenlarsen52");
    expect(parseInatAccount("  @KragAdox ")).toBe("kragadox");
    expect(parseInatAccount("https://www.inaturalist.org/people/kragadox")).toBe("kragadox");
    expect(parseInatAccount("inaturalist.org/people/204323?tab=observations")).toBe("204323");
    expect(parseInatAccount("https://www.inaturalist.org/users/11227491")).toBe("11227491");
  });

  it("refuses anything else, rather than asking iNaturalist about it", () => {
    for (const typed of ["", "Jen Larsen", "https://example.org/people/kragadox", "../users/me", "a/b"]) {
      expect(parseInatAccount(typed)).toBeNull();
    }
  });
});

describe("looking a profile up on iNaturalist", () => {
  const answering = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("reads the profile's id, login, name and counts", async () => {
    const lookUp = inatProfiles(
      answering(200, {
        results: [
          { id: 204323, login: "kragadox", name: " Craig Fiehler ", observations_count: 1316, created_at: "2016-03-25T10:00:00-07:00" },
        ],
      }),
    );
    expect(await lookUp("kragadox")).toEqual({
      id: 204323,
      login: "kragadox",
      name: "Craig Fiehler",
      iconUrl: null,
      observations: 1316,
      joined: new Date("2016-03-25T17:00:00Z"),
    });
  });

  it("calls a blank name no name, and an unknown account nobody", async () => {
    expect((await inatProfiles(answering(200, { results: [{ id: 1, login: "x", name: "" }] }))("x"))?.name).toBeNull();
    expect(await inatProfiles(answering(404, { error: "Not found" }))("nobody")).toBeNull();
  });

  it("throws on any other failure, so the page can say iNaturalist didn't answer", async () => {
    await expect(inatProfiles(answering(503, {}))("x")).rejects.toThrow(/503/);
  });
});

describe("/people/new", () => {
  it("is admin-only, and People links to it", async () => {
    const volunteer = await addApp({ admin: false });
    expect((await volunteer.app.request("/people/new")).status).toBe(403);
    expect((await post(volunteer.app, { inat_user_id: "11227491", display_name: "Jen Larsen" })).status).toBe(403);
    const staff = await addApp();
    expect(await (await staff.app.request("/people")).text()).toContain(`href="/people/new"`);
  });

  it("lists the people turned away at sign-in, newest first, and not those somebody now holds", async () => {
    const { app, conn } = await addApp();
    await turnedAwayAt(conn, 204323, "kragadox", "2026-11-04 21:02:53");
    await turnedAwayAt(conn, 11227491, "jenlarsen52", "2026-11-04 17:26:17");
    // Turned away once, and connected since.
    await turnedAwayAt(conn, 222, "bonets", "2026-11-04 12:00:00");
    const body = await (await app.request("/people/new")).text();
    expect(body).toContain("Turned away at sign-in");
    expect(body.indexOf("@kragadox")).toBeLessThan(body.indexOf("@jenlarsen52"));
    expect(body).toContain(`href="/people/new?account=jenlarsen52"`);
    expect(body).not.toContain("@bonets");
  });

  it("looks the account up and offers the form, filled from the profile", async () => {
    const { app, conn } = await addApp();
    await turnedAwayAt(conn, 204323, "kragadox", "2026-11-04 21:02:53");
    const body = await (await app.request("/people/new?account=https://www.inaturalist.org/people/kragadox")).text();
    expect(body).toContain("Named Craig Fiehler on iNaturalist");
    expect(body).toContain("1,316 observations");
    expect(body).toContain("Tried to sign in to Beeline");
    expect(body).toMatch(/name="display_name"[^>]*value="Craig Fiehler"/);
    expect(body).toMatch(/name="given_name"[^>]*value="Craig"/);
    expect(body).toMatch(/name="family_name"[^>]*value="Fiehler"/);
    expect(body).toContain(`name="inat_user_id" value="204323"`);
  });

  it("says what is wrong with an account it cannot look up, keeping what was typed", async () => {
    const { app, asked } = await addApp();
    const junk = await (await app.request("/people/new?account=Jen%20Larsen")).text();
    expect(junk).toContain(html(`"Jen Larsen" isn't an iNaturalist login or a link to a profile.`));
    expect(junk).toMatch(/name="account"[^>]*value="Jen Larsen"/);
    // Not worth asking iNaturalist about.
    expect(asked).toEqual([]);
    expect(await (await app.request("/people/new?account=nobody")).text()).toContain("iNaturalist has no account called nobody");
    const down = await addApp({ failing: true });
    expect(await (await down.app.request("/people/new?account=kragadox")).text()).toContain(html("iNaturalist didn't answer just now"));
  });

  it("adds them as staff, with their account and name parts, and they can sign in", async () => {
    const { app, conn, overlayPath, asked } = await addApp();
    await turnedAwayAt(conn, 11227491, "jenlarsen52", "2026-11-04 17:26:17");
    const res = await post(app, {
      inat_user_id: "11227491",
      display_name: "Jen Larsen",
      given_name: "Jen",
      family_name: "Larsen",
      staff: "1",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/people/jenlarsen52");
    // Read from iNaturalist again, by id, rather than trusted from the form.
    expect(asked).toEqual(["11227491"]);
    const id = await idOf(conn, "Jen Larsen");
    expect(await rows(conn, `SELECT given_name, family_name FROM person WHERE entity_id = ${id}`)).toEqual([["Jen", "Larsen"]]);
    // What lets a person in at sign-in is an account bound to them.
    expect(await rows(conn, `SELECT inat_user_id, login FROM inat_account WHERE person_id = ${id}`)).toEqual([
      [11227491n, "jenlarsen52"],
    ]);
    expect(await rows(conn, `SELECT count(*) FROM person_admin WHERE person_id = ${id}`)).toEqual([[1n]]);
    // In the overlay, so a rebuild keeps them.
    const written = (await readOverlay(overlayPath)).map((r) => [r.person_ref, r.field, r.value, r.author]);
    expect(written).toEqual(
      expect.arrayContaining([
        ["name:Jen Larsen", "create", "yes", "staffer"],
        ["name:Jen Larsen", "inat_user_id", "11227491 jenlarsen52", "staffer"],
        ["name:Jen Larsen", "admin", "yes", "staffer"],
      ]),
    );
    // No longer turned away.
    expect(await (await app.request("/people/new")).text()).not.toContain("@jenlarsen52");
  });

  it("adds somebody who is not staff without admin", async () => {
    const { app, conn, overlayPath } = await addApp();
    expect((await post(app, { inat_user_id: "204323", display_name: "Craig Fiehler" })).status).toBe(302);
    const id = await idOf(conn, "Craig Fiehler");
    expect(await rows(conn, `SELECT count(*) FROM person_admin WHERE person_id = ${id}`)).toEqual([[0n]]);
    expect((await readOverlay(overlayPath)).map((r) => r.field)).not.toContain("admin");
  });

  it("refuses a blank name, and a name somebody here already has", async () => {
    const { app, conn, overlayPath } = await addApp();
    expect(await (await post(app, { inat_user_id: "204323", display_name: " " })).text()).toContain("Not saved: give them a name");
    const taken = await (await post(app, { inat_user_id: "204323", display_name: "Bo Netter" })).text();
    expect(taken).toContain(html(`somebody here is already called "Bo Netter"`));
    // Still offering the form, filled from iNaturalist.
    expect(taken).toContain(`name="inat_user_id" value="204323"`);
    expect(await readOverlay(overlayPath)).toEqual([]);
    expect(await rows(conn, "SELECT count(*) FROM inat_account WHERE inat_user_id = 204323")).toEqual([[0n]]);
  });

  it("says who holds an account already, and adds nobody for it", async () => {
    const { app, overlayPath } = await addApp();
    const body = await (await app.request("/people/new?account=bonets")).text();
    expect(body).toContain("This account is already connected to Bo Netter.");
    expect(body).not.toContain(`name="inat_user_id"`);
    const res = await post(app, { inat_user_id: "222", display_name: "Somebody Else" });
    expect(await res.text()).toContain("This account is already connected to Bo Netter.");
    expect(await readOverlay(overlayPath)).toEqual([]);
  });

  it("sends an account with collection records waiting to Unknown collectors, which also makes them samples", async () => {
    const { app, conn, overlayPath } = await addApp();
    for (const [id, name, level] of [
      [1, "United States", 0],
      [10, "Oregon", 10],
      [484, "Benton", 20],
    ] as const) {
      await conn.run(`INSERT INTO inat_place (inat_place_id, name, admin_level) VALUES (${id}, '${name}', ${level})`);
    }
    // A collection record from @newbee, staged as a sync stages one (as in test/unclaimed.test.ts).
    const observation = {
      id: 1,
      uuid: "uuid-1",
      observed_on: currentSeasonDate(7, 14),
      geojson: { coordinates: [-123.262, 44.5646], type: "Point" },
      positional_accuracy: 30,
      public_positional_accuracy: 30,
      geoprivacy: null,
      taxon_geoprivacy: null,
      place_ids: [1, 10, 484],
      place_guess: "Corvallis, OR, US",
      user: { id: 500, login: "newbee", name: "Cy Newcomer" },
      taxon: { id: 47604, name: "Rubus", ancestor_ids: [48460, 47126, 211194, 47604] },
      ofvs: [
        { name: "sampleId", value: "1" },
        { name: "numberOfSpecimens", value: "3" },
      ],
    };
    await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
    await conn.run(
      `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
       VALUES (1, (SELECT max(entity_id) FROM sync_run), $1, 'hash-1')`,
      [canonicalJson(observation)] as never,
    );
    await refreshObservationFields(conn);
    const body = await (await app.request("/people/new?account=newbee")).text();
    expect(body).toContain("1 collection record waiting on Unknown collectors");
    expect(body).toContain(`href="/unclaimed/500"`);
    expect(body).not.toContain(`name="inat_user_id"`);
    await post(app, { inat_user_id: "500", display_name: "Cy Newcomer" });
    expect(await readOverlay(overlayPath)).toEqual([]);
  });
});
