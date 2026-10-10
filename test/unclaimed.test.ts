import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import { createApp } from "../src/app/server.js";
import { canonicalJson } from "../src/sync-inat.js";
import { refreshObservationFields } from "../src/refresh-observation-fields.js";
import { readOverlay } from "../src/person-overlay.js";
import { kyselyReader } from "../src/person-change.js";
import { readSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import type { InatClient } from "../src/app/auth.js";
import { attachPrivateStore } from "../src/app/db.js";
import { createMemoryDb, rows } from "./helpers.js";

/**
 * Collectors Beeline does not know (beeline-e85): observations from an
 * iNaturalist user no person is connected to, routed to a program by where
 * they fell, and the two answers staff can give — this is somebody already
 * here, or somebody new — each of which makes the records samples at once.
 *
 * Place ids and admin levels are the real ones (Oregon 10, Benton County 484,
 * United States 1), as in test/mint-samples.test.ts.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

/** A collection record from user 500, whom nobody in the store is connected to. */
function obs(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    uuid: `uuid-${id}`,
    observed_on: "2026-07-14",
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
      { name: "sampleId", value: String(id) },
      { name: "numberOfSpecimens", value: "3" },
    ],
    ...extra,
  };
}

async function stage(conn: DuckDBConnection, o: Record<string, unknown>): Promise<void> {
  await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
  await conn.run(
    `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
     VALUES ($1, (SELECT max(entity_id) FROM sync_run), $2, $3)`,
    [Number(o.id), canonicalJson(o), `hash-${o.id}`] as never,
  );
}

const idOf = async (conn: DuckDBConnection, name: string) =>
  Number(((await rows(conn, `SELECT entity_id FROM person WHERE display_name = '${name}'`))[0] ?? [0])[0]);

async function unclaimedApp(opts: { admin?: boolean } = {}) {
  const { instance, conn } = await createMemoryDb();
  await attachPrivateStore(instance, { path: ":memory:", key: null });
  for (const [id, name, level] of [
    [1, "United States", 0],
    [10, "Oregon", 10],
    [484, "Benton", 20],
  ] as const) {
    await conn.run(`INSERT INTO inat_place (inat_place_id, name, admin_level) VALUES (${id}, '${name}', ${level})`);
  }
  // Drawn from the sequence, never written by hand: `create` draws a person
  // id too, and a hand-written 1 would collide with it.
  await conn.run(`INSERT INTO person (display_name, given_name, family_name) VALUES
                  ('Staff Person', 'Staff', 'Person'),
                  ('Ada Collector', 'Ada', 'Collector'),
                  ('Bo Netter', 'Bo', 'Netter')`);
  const staff = await idOf(conn, "Staff Person");
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${staff}, 333, 'staffer')`);
  await conn.run(
    `INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${await idOf(conn, "Bo Netter")}, 222, 'bonets')`,
  );
  if (opts.admin ?? true) await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staff})`);
  await conn.run(`INSERT INTO program_lead (program_id, person_id) SELECT entity_id, ${staff} FROM program WHERE code = 'OBA'`);

  const dir = await mkdtemp(join(tmpdir(), "unclaimed-"));
  const overlayPath = join(dir, "person-overlay.csv");
  const db = createKysely(instance);
  const mintConn = await instance.connect();
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
    conn,
    mintConn,
  });
  return { app, conn, db, overlayPath, dir };
}

const post = (app: Awaited<ReturnType<typeof unclaimedApp>>["app"], path: string, body: Record<string, string>) =>
  app.request(path, {
    method: "POST",
    headers: { origin: "http://localhost:3054", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

const count = async (conn: DuckDBConnection, sql: string) => Number(((await rows(conn, sql))[0] ?? [0])[0]);

describe("unclaimed_record", () => {
  it("routes a record by the region it fell in, and to the program itself where no atlas reaches or no state is known", async () => {
    const { conn } = await unclaimedApp();
    await stage(conn, obs(1));
    await stage(conn, obs(2, { place_ids: [] }));
    await refreshObservationFields(conn);
    const routed = await rows(conn, "SELECT inat_id, program_code FROM unclaimed_record ORDER BY inat_id");
    expect(routed).toEqual([
      [1n, "OBA"],
      [2n, "MM"],
    ]);
  });
});

describe("the unknown collectors screen", () => {
  let ctx: Awaited<ReturnType<typeof unclaimedApp>>;
  beforeEach(async () => {
    ctx = await unclaimedApp();
    await stage(ctx.conn, obs(1));
    await stage(ctx.conn, obs(2, { observed_on: "2026-07-15" }));
    await refreshObservationFields(ctx.conn);
  });

  it("is admin-only, and offered only to admins", async () => {
    const volunteer = await unclaimedApp({ admin: false });
    expect((await volunteer.app.request("/unclaimed")).status).toBe(403);
    expect((await volunteer.app.request("/unclaimed/500")).status).toBe(403);
    expect((await post(volunteer.app, "/unclaimed/500/add", { display_name: "X" })).status).toBe(403);
    expect(await (await volunteer.app.request("/glossary")).text()).not.toContain(`href="/unclaimed"`);
    expect(await (await ctx.app.request("/glossary")).text()).toContain(`href="/unclaimed"`);
  });

  it("lists each observer once under the program their records fell in, naming its lead", async () => {
    const body = await (await ctx.app.request("/unclaimed")).text();
    expect(body).toContain("<h2>Oregon Bee Atlas</h2>");
    expect(body).toContain("Led by");
    expect(body).toContain(">Staff Person</a>");
    expect(body).toContain("<code>@newbee</code>");
    expect(body).toContain(`href="/unclaimed/500"`);
    expect(body).toContain("2 records from 1 person");
    expect(body).not.toMatch(/<td><\/td>/);
  });

  it("lists an observer in two programs under both, counting each program's own records", async () => {
    await ctx.conn.run("INSERT INTO inat_place (inat_place_id, name, admin_level) VALUES (46, 'Washington', 10)");
    await stage(ctx.conn, obs(3, { place_ids: [1, 46] }));
    await refreshObservationFields(ctx.conn);
    const body = await (await ctx.app.request("/unclaimed")).text();
    const section = (heading: string) => body.slice(body.indexOf(`<h2>${heading}</h2>`)).split("</table>")[0]!;
    expect(section("Oregon Bee Atlas")).toMatch(/@newbee.*?<td>2<\/td>/s);
    expect(section("Washington Bee Atlas")).toMatch(/@newbee.*?<td>1<\/td>/s);
    expect(body).toContain("3 records from 1 person");
  });

  it("says nobody is waiting when nobody is", async () => {
    const empty = await unclaimedApp();
    const body = await (await empty.app.request("/unclaimed")).text();
    expect(body).toContain("Nobody waiting");
  });

  it("suggests a person whose name is the observer's iNaturalist name, and binds nobody by itself", async () => {
    await ctx.conn.run("INSERT INTO person (display_name) VALUES ('Cy Newcomer')");
    const body = await (await ctx.app.request("/unclaimed/500")).text();
    expect(body).toContain("This is Cy Newcomer");
    expect(body).toContain("Their iNaturalist profile has this name.");
    // A suggestion is offered, never acted on: two warnings before anyone adds a second Cy.
    expect(body).toContain("Check the suggestions above first");
    expect(await count(ctx.conn, "SELECT count(*) FROM inat_account WHERE inat_user_id = 500")).toBe(0);
  });

  it("answers an observer nobody is waiting under with not found", async () => {
    expect((await ctx.app.request("/unclaimed/999")).status).toBe(404);
    expect((await ctx.app.request("/unclaimed/abc")).status).toBe(404);
  });

  describe("connecting the account to somebody already here", () => {
    it("binds it, records the decision, and makes their records samples at once", async () => {
      const res = await post(ctx.app, "/unclaimed/500/connect", { person: "Ada Collector", reason: "she changed accounts" });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("@newbee is now Ada Collector. 2 new samples.");
      const ada = await idOf(ctx.conn, "Ada Collector");
      expect(await count(ctx.conn, `SELECT count(*) FROM inat_account WHERE inat_user_id = 500 AND person_id = ${ada}`)).toBe(1);
      expect(
        await count(ctx.conn, `SELECT count(*) FROM sample_primary_collector WHERE person_id = ${ada}`),
      ).toBe(2);
      expect(await count(ctx.conn, "SELECT count(*) FROM unclaimed_record")).toBe(0);
      // In the overlay, so a rebuild makes the same samples.
      const overlay = await readOverlay(ctx.overlayPath);
      expect(overlay).toContainEqual(
        expect.objectContaining({ person_ref: "name:Ada Collector", field: "inat_user_id", value: "500 newbee" }),
      );
    });

    it("matches a record already in Beeline rather than making it again", async () => {
      // Ada's legacy sample 1 of 14 July, citing no observation: observation 1
      // is the same collecting event, and connecting the account links it.
      const ada = await idOf(ctx.conn, "Ada Collector");
      await ctx.conn.run(`INSERT INTO sample (entity_id, kind, sample_number, date_start, date_end, specimen_count)
                          VALUES (nextval('entity_id_seq'), 'net', '1', '2026-07-14', '2026-07-14', 3)`);
      const [[legacy]] = (await rows(ctx.conn, "SELECT max(entity_id) FROM sample")) as [[number]];
      await ctx.conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${legacy}, ${ada}, 1)`);

      const body = await (await post(ctx.app, "/unclaimed/500/connect", { person: "Ada Collector" })).text();
      expect(body).toContain("1 new sample, 1 matched to a sample already here.");
      expect(await count(ctx.conn, `SELECT count(*) FROM sample WHERE entity_id = ${legacy} AND inat_observation_id = 1`)).toBe(1);
      expect(await count(ctx.conn, `SELECT count(*) FROM sample_primary_collector WHERE person_id = ${ada}`)).toBe(2);
    });

    it("refuses a name nobody has, a name two people share, and somebody already connected", async () => {
      expect(await (await post(ctx.app, "/unclaimed/500/connect", { person: "Nobody Atall" })).text()).toContain(
        "nobody here is called",
      );
      await ctx.conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
      expect(await (await post(ctx.app, "/unclaimed/500/connect", { person: "Ada Collector" })).text()).toContain(
        "two people here are called",
      );
      expect(await (await post(ctx.app, "/unclaimed/500/connect", { person: "Bo Netter" })).text()).toContain(
        "Bo Netter is already connected to @bonets",
      );
      expect(await count(ctx.conn, "SELECT count(*) FROM inat_account WHERE inat_user_id = 500")).toBe(0);
      expect(await readOverlay(ctx.overlayPath)).toEqual([]);
    });
  });

  describe("adding somebody new", () => {
    it("creates them with their account and name parts, and makes their records samples", async () => {
      const body = await (
        await post(ctx.app, "/unclaimed/500/add", {
          display_name: "Cy Newcomer",
          given_name: "Cy",
          family_name: "Newcomer",
        })
      ).text();
      expect(body).toContain("@newbee is now Cy Newcomer. 2 new samples.");
      const [[given, family, uid]] = (await rows(
        ctx.conn,
        `SELECT p.given_name, p.family_name, a.inat_user_id FROM person p
         JOIN inat_account a ON a.person_id = p.entity_id WHERE p.display_name = 'Cy Newcomer'`,
      )) as [[string, string, bigint]];
      expect([given, family, uid]).toEqual(["Cy", "Newcomer", 500n]);
      expect(await count(ctx.conn, "SELECT count(*) FROM unclaimed_record")).toBe(0);
      const fields = (await readOverlay(ctx.overlayPath)).map((r) => r.field);
      expect(fields).toEqual(["create", "inat_user_id", "given_name", "family_name"]);
    });

    it("refuses a name somebody here already has, rather than letting create read it as them", async () => {
      const body = await (await post(ctx.app, "/unclaimed/500/add", { display_name: "Ada Collector" })).text();
      expect(body).toContain("somebody here is already called");
      expect(await count(ctx.conn, "SELECT count(*) FROM inat_account WHERE inat_user_id = 500")).toBe(0);
      expect(await count(ctx.conn, "SELECT count(*) FROM person WHERE display_name = 'Ada Collector'")).toBe(1);
    });

    it("refuses a blank name", async () => {
      expect(await (await post(ctx.app, "/unclaimed/500/add", { display_name: " " })).text()).toContain(
        "give them a name",
      );
    });

    it("refuses a name the old records spell for somebody already here, which create would read as them", async () => {
      // Legacy promotion keeps every spelling a person was recorded under,
      // and the overlay resolves a name through those first: adding
      // "AdaJo Collector" would have connected the account to Ada and
      // overwritten her name parts.
      const ada = await idOf(ctx.conn, "Ada Collector");
      await ctx.conn.run("CREATE TABLE legacy_person_name (name TEXT, name_key TEXT, person_id INTEGER)");
      await ctx.conn.run(`INSERT INTO legacy_person_name VALUES
                          ('Ada Collector', 'adacollector', ${ada}), ('AdaJo Collector', 'adajocollector', ${ada})`);
      const body = await (
        await post(ctx.app, "/unclaimed/500/add", { display_name: "AdaJo Collector", given_name: "AdaJo" })
      ).text();
      expect(body).toContain("somebody here is already called");
      expect(await count(ctx.conn, "SELECT count(*) FROM inat_account WHERE inat_user_id = 500")).toBe(0);
      expect(await count(ctx.conn, `SELECT count(*) FROM person WHERE entity_id = ${ada} AND given_name = 'Ada'`)).toBe(1);
      expect(await readOverlay(ctx.overlayPath)).toEqual([]);
    });
  });

  it("refuses to connect by a name the old records spell for somebody else", async () => {
    // Bo is now called "Ada Collector Jr" on screen, but the old records
    // spell that name for Ada: written as name:, the binding would reach her.
    const ada = await idOf(ctx.conn, "Ada Collector");
    const bo = await idOf(ctx.conn, "Bo Netter");
    await ctx.conn.run(`DELETE FROM inat_account WHERE person_id = ${bo}`);
    await ctx.conn.run(`UPDATE person SET display_name = 'Ada Collector Jr' WHERE entity_id = ${bo}`);
    await ctx.conn.run("CREATE TABLE legacy_person_name (name TEXT, name_key TEXT, person_id INTEGER)");
    await ctx.conn.run(`INSERT INTO legacy_person_name VALUES ('Ada Collector Jr', 'adacollectorjr', ${ada})`);
    const body = await (await post(ctx.app, "/unclaimed/500/connect", { person: "Ada Collector Jr" })).text();
    expect(body).toContain("is also how the old records name somebody else");
    expect(await count(ctx.conn, "SELECT count(*) FROM inat_account WHERE inat_user_id = 500")).toBe(0);
  });

  it("takes two decisions about one collector in turn: the second finds nobody waiting and writes nothing", async () => {
    // Either may win — each reads its form before taking its turn — but only one.
    const [connect, add] = await Promise.all([
      post(ctx.app, "/unclaimed/500/connect", { person: "Ada Collector" }),
      post(ctx.app, "/unclaimed/500/add", { display_name: "Cy Newcomer" }),
    ]);
    expect([connect.status, add.status].sort()).toEqual([200, 404]);
    const loser = connect.status === 404 ? connect : add;
    expect(await loser.text()).toContain("It may have just been connected to somebody.");
    // Only the winner's decision is on file, so a rebuild replays cleanly.
    const refs = new Set((await readOverlay(ctx.overlayPath)).map((r) => r.person_ref));
    expect(refs).toEqual(new Set([connect.status === 200 ? "name:Ada Collector" : "name:Cy Newcomer"]));
    expect(await count(ctx.conn, "SELECT count(*) FROM inat_account WHERE inat_user_id = 500")).toBe(1);
  });

  it("records the samples it made in the sample log, as the promotion that made them", async () => {
    const paths = { log: join(ctx.dir, "sample-change.csv"), state: join(ctx.dir, "sample-state.csv") };
    const reader = kyselyReader(ctx.db);
    // A store that already has a baseline: a narrowed pass would skip new samples.
    await ctx.conn.run(`INSERT INTO sample (entity_id, kind, sample_number, date_start, date_end, specimen_count)
                        VALUES (nextval('entity_id_seq'), 'net', '99', '2025-07-01', '2025-07-01', 1)`);
    await ctx.conn.run(`INSERT INTO sample_collector (sample_id, person_id, position)
                        SELECT max(entity_id), ${await idOf(ctx.conn, "Bo Netter")}, 1 FROM sample`);
    await recordSampleChanges(reader, paths, { source: "reconcile" });
    await post(ctx.app, "/unclaimed/500/connect", { person: "Ada Collector" });
    // Queued behind the app's own pass, so this returns after it.
    await recordSampleChanges(reader, paths, { source: "reconcile" });
    const made = (await readSampleChanges(paths.log)).filter((e) => e.reason === "connected @newbee to Ada Collector");
    expect(made.length).toBeGreaterThan(0);
    expect(new Set(made.map((e) => e.source))).toEqual(new Set(["observation_promotion"]));
    expect(new Set(made.map((e) => e.sample_number))).toEqual(new Set(["1", "2"]));
  });

  it("says when the samples could not be made now, and keeps the decision", async () => {
    // No connection to promote on: the binding is saved, the nightly mints.
    const { instance, conn } = await createMemoryDb();
    await attachPrivateStore(instance, { path: ":memory:", key: null });
    await conn.run("INSERT INTO person (display_name) VALUES ('Staff Person'), ('Ada Collector')");
    const staff = await idOf(conn, "Staff Person");
    await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staff})`);
    await stage(conn, obs(1, { place_ids: [] }));
    await refreshObservationFields(conn);
    const dir = await mkdtemp(join(tmpdir(), "unclaimed-"));
    const app = createApp({
      db: createKysely(instance),
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId: staff, login: "staffer", iconUrl: null }),
      personOverlayPath: join(dir, "person-overlay.csv"),
      personChangesPath: join(dir, "person-change.csv"),
      conn,
    });
    const body = await (await post(app, "/unclaimed/500/connect", { person: "Ada Collector" })).text();
    expect(body).toContain("could not be made just now");
    expect(await count(conn, "SELECT count(*) FROM inat_account WHERE inat_user_id = 500")).toBe(1);
    expect(await readFile(join(dir, "person-overlay.csv"), "utf8")).toContain("500 newbee");
  });
});
