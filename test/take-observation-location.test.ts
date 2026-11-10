import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { approveRun, markPrinted, prepareRun } from "../src/print-run.js";
import { promoteObservations } from "../src/promote-observations.js";
import { refreshObservationFields } from "../src/refresh-observation-fields.js";
import { applySampleOverlay } from "../src/apply-sample-overlay.js";
import { readSampleOverlay } from "../src/sample-overlay.js";
import { parseCsv } from "../src/corrections.js";
import { duckdbReader } from "../src/person-change.js";
import { recordSampleChanges } from "../src/sample-change.js";
import { canonicalJson } from "../src/sync-inat.js";
import { loadSpatial, openDuckDb } from "../src/db.js";
import { buildTestGazetteer, createMemoryDb, currentSeasonDate, insertCleanSample, rows, scratchPaths } from "./helpers.js";

/**
 * Staff taking the observation's location for a sample Beeline printed
 * (beeline-1kb.17.1, GitHub #298). The case is the real one: sample 797063
 * was observed with its pin on a Wolf Mountain in Nevada County, California,
 * printed there, and moved by its collector to Lane County, Oregon four days
 * later. The coordinates and iNaturalist place ids are that observation's
 * (402367157); the people are made up.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const CALIFORNIA = { lat: 39.059242, lon: -121.137299 };
const OREGON = { lat: 43.620977, lon: -122.237981 };
const OBSERVATION = 402367157;

// iNaturalist's own ids: the United States, Oregon, Lane County.
const PLACES: Array<[number, string, number, number[]]> = [
  [1, "United States", 0, [97394, 1]],
  [10, "Oregon", 10, [97394, 1, 10]],
  [981, "Lane", 20, [97394, 1, 10, 981]],
];

async function person(conn: DuckDBConnection, name: string, login: string, userId: number): Promise<number> {
  const [[id]] = (await rows(conn, `INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${userId}, '${login}')`);
  return Number(id);
}

async function stageObservation(conn: DuckDBConnection, at: { lat: number; lon: number }, placeIds: number[]): Promise<void> {
  await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
  const o = {
    id: OBSERVATION,
    uuid: "uuid-wolf",
    observed_on: currentSeasonDate(9, 21),
    geojson: { type: "Point", coordinates: [at.lon, at.lat] },
    positional_accuracy: null,
    geoprivacy: null,
    taxon_geoprivacy: null,
    obscured: false,
    place_guess: "Wolf Mountain, OR, USA",
    place_ids: placeIds,
    user: { id: 1, login: "lori", name: "Lori Collector" },
    ofvs: [{ name: "sampleId", value: "5" }, { name: "numberOfSpecimens", value: "2" }],
  };
  await conn.run(
    `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
     VALUES ($1, (SELECT max(entity_id) FROM sync_run), $2, $3)`,
    [OBSERVATION, canonicalJson(o), `hash-${Math.random()}`] as never,
  );
  await refreshObservationFields(conn);
}

/**
 * The test gazetteer, with Lane County drawn as a box around Wolf Mountain.
 * Its Census GEOID, 41039, is the real one.
 */
async function gazetteerWithLane(dir: string): Promise<string> {
  const path = join(dir, "gazetteer.duckdb");
  await buildTestGazetteer(path, "build-lane");
  const instance = await openDuckDb(path);
  const g = await instance.connect();
  await loadSpatial(g);
  await g.run(`INSERT INTO region VALUES ('US-OR-41039', 'USA', 'OR', 'Lane', 'census', '41039', 'Lane County',
                 ST_MakeEnvelope(-122.6, 43.4, -121.9, 43.9))`);
  g.closeSync();
  instance.closeSync();
  return path;
}

/**
 * Lori's sample, printed in California, with the observation since moved to
 * Oregon; signed in as Sam (staff) or Lori.
 */
async function moved(
  signedInAs: "sam" | "lori" = "sam",
  opts: { loriHasAccount?: boolean; gazetteer?: boolean; running?: string | null } = {},
) {
  const { instance, conn } = await createMemoryDb();
  const lori =
    (opts.loriHasAccount ?? true)
      ? await person(conn, "Lori Collector", "lori", 1)
      : Number(((await rows(conn, `INSERT INTO person (display_name) VALUES ('Lori Collector') RETURNING entity_id`)) as [[number]])[0][0]);
  const sam = await person(conn, "Sam Staff", "samstaff", 2);
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${sam})`);
  for (const [id, name, level, ancestors] of PLACES) {
    await conn.run(
      `INSERT INTO inat_place (inat_place_id, name, admin_level, ancestor_place_ids) VALUES ($1, $2, $3, CAST($4 AS BIGINT[]))`,
      [id, name, level, `[${ancestors.join(",")}]`] as never,
    );
  }
  const sampleId = await insertCleanSample(
    conn,
    {
      collector_id: String(lori),
      sample_number: "'5'",
      date_start: `DATE '${currentSeasonDate(9, 21)}'`,
      date_end: `DATE '${currentSeasonDate(9, 21)}'`,
      specimen_count: "2",
      inat_observation_id: String(OBSERVATION),
      state_province: "'CA'",
      county: "'Nevada'",
      locality: "'Wolf Mountain'",
    },
    { latitude: String(CALIFORNIA.lat), longitude: String(CALIFORNIA.lon), coordinate_uncertainty_m: "NULL", elevation_m: "478" },
  );
  const run = (await prepareRun(conn, { atlasId: null, personId: sam, now: new Date() }))!.printRunId;
  await approveRun(conn, run, { personId: sam, now: new Date() });
  await markPrinted(conn, run, { personId: sam, now: new Date() });
  await stageObservation(conn, OREGON, [1, 10, 981]);

  const dir = await mkdtemp(join(tmpdir(), "beeline-take-"));
  const paths = {
    sampleOverlayPath: join(dir, "sample-overlay.csv"),
    correctionsPath: join(dir, "corrections.csv"),
    sampleChangesPath: join(dir, "sample-change.csv"),
    sampleStatePath: join(dir, "sample-state.csv"),
  };
  const people = { lori, sam };
  const app = createApp({
    ...(await scratchPaths()),
    db: createKysely(instance),
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({
      personId: people[signedInAs],
      login: signedInAs === "sam" ? "samstaff" : "lori",
      iconUrl: null,
    }),
    conn,
    mintConn: await instance.connect(),
    inatCheck: {
      projects: [],
      token: async () => "unused",
      gazetteerPath: (opts.gazetteer ?? true) ? await gazetteerWithLane(dir) : undefined,
    },
    jobs: { list: [], start: async () => false, running: () => opts.running ?? null },
    ...paths,
  });
  return { app, conn, sampleId, ...paths };
}

const post = (app: ReturnType<typeof createApp>, path: string, body: Record<string, string> = {}) =>
  app.request(path, { method: "POST", body: new URLSearchParams(body) });

const t = en.record.sample.takeObservationLocation;

describe("a sample Beeline printed whose observation has moved", () => {
  it("is in sample_location_label_diverged with where iNaturalist puts it now", async () => {
    const { conn, sampleId } = await moved();
    const found = await rows(
      conn,
      `SELECT sample_id, observation_latitude, observation_longitude, round(distance_m / 1000)
       FROM sample_location_label_diverged`,
    );
    expect(found).toEqual([[sampleId, OREGON.lat, OREGON.lon, 515]]);
  });

  it("is offered to staff on the sample page, and not to the collector", async () => {
    const staff = await moved("sam");
    const page = await (await staff.app.request(`/samples/${staff.sampleId}`)).text();
    expect(page).toContain(t.lead(OREGON.lat, OREGON.lon, "Lane County, OR", "515 km"));
    expect(page).toContain(`action="/samples/${staff.sampleId}/take-observation-location"`);

    const collector = await moved("lori");
    const own = await (await collector.app.request(`/samples/${collector.sampleId}`)).text();
    expect(own).not.toContain(t.action);
    expect((await post(collector.app, `/samples/${collector.sampleId}/take-observation-location`)).status).toBe(403);
  });

  it("takes the point with the country, state, county and atlas, and keeps them through a promotion", async () => {
    const { app, conn, sampleId, sampleOverlayPath } = await moved();
    const res = await post(app, `/samples/${sampleId}/take-observation-location`, { note: "Lori fixed the pin" });
    expect(res.status).toBe(302);

    const place = `SELECT s.country, s.state_province, s.county, p.code, round(l.latitude, 6), round(l.longitude, 6), l.source
                   FROM sample s JOIN sample_location l ON l.sample_id = s.entity_id
                   LEFT JOIN sample_atlas sa ON sa.sample_id = s.entity_id LEFT JOIN program p ON p.entity_id = sa.atlas_id
                   WHERE s.entity_id = ${sampleId}`;
    const taken = ["USA", "OR", "Lane", "OBA", OREGON.lat, OREGON.lon, "staff_entry"];
    expect((await rows(conn, place))[0]).toEqual(taken);
    expect(await rows(conn, `SELECT count(*) FROM sample_location_label_diverged`)).toEqual([[0n]]);
    // The elevation was California's; the nightly re-reads it, and until
    // then the store says it no longer describes the point.
    expect(await rows(conn, `SELECT count(*) FROM sample_elevation_stale WHERE sample_id = ${sampleId}`)).toEqual([[1n]]);

    // Only the point is a decision; the county, state and atlas follow it.
    const file = await readSampleOverlay(sampleOverlayPath);
    expect(file.map((r) => [r.field, r.base_value, r.value, r.author, r.reason])).toEqual([
      ["coordinates", `${CALIFORNIA.lat} ${CALIFORNIA.lon} - inat_public`, `${OREGON.lat} ${OREGON.lon}`, "samstaff", "Lori fixed the pin"],
    ]);

    // The page no longer offers it, and says who set the coordinates.
    const page = await (await app.request(`/samples/${sampleId}`)).text();
    expect(page).not.toContain(t.action);
    expect(page).toContain("Coordinates set in Beeline by Sam Staff.");

    // A promotion leaves it, and replaying the file onto it changes nothing.
    await promoteObservations(conn);
    expect((await rows(conn, place))[0]).toEqual(taken);
    expect((await applySampleOverlay(conn, file)).unresolved).toEqual([]);
    expect((await rows(conn, place))[0]).toEqual(taken);
  });

  it("says why, with the default reason, when staff leave no note", async () => {
    const { app, sampleId, sampleOverlayPath } = await moved();
    expect((await post(app, `/samples/${sampleId}/take-observation-location`)).status).toBe(302);
    expect((await readSampleOverlay(sampleOverlayPath)).map((r) => r.reason)).toEqual([t.reason]);
  });

  it("credits the staffer in the sample's history with the point, the county and the state together", async () => {
    const { app, conn, sampleId, sampleChangesPath, sampleStatePath } = await moved();
    // The log's first pass only takes a baseline; production's was taken long ago.
    await recordSampleChanges(duckdbReader(conn), { log: sampleChangesPath, state: sampleStatePath }, { source: "observation_promotion" });
    expect((await post(app, `/samples/${sampleId}/take-observation-location`, { note: "Lori fixed the pin" })).status).toBe(302);
    const log = parseCsv(await readFile(sampleChangesPath, "utf8"));
    const header = log[0]!;
    const col = (name: string) => header.indexOf(name);
    const changes = log
      .slice(1)
      .filter((r) => r[col("source")] === "app")
      .map((r) => [r[col("field")], r[col("old_value")], r[col("new_value")], r[col("author")], r[col("reason")]]);
    expect(changes).toEqual(
      expect.arrayContaining([
        ["state_province", "CA", "OR", "samstaff", "Lori fixed the pin"],
        ["county", "Nevada", "Lane", "samstaff", "Lori fixed the pin"],
        ["location_source", "inat_public", "staff_entry", "samstaff", "Lori fixed the pin"],
      ]),
    );
    // Nothing about the move is left for a later pass to credit to anyone else.
    expect(log.slice(1).filter((r) => r[col("source")] !== "app" && ["state_province", "county"].includes(r[col("field")]!))).toEqual([]);
  });

  it("finds the new county for a sample whose collector has no iNaturalist account", async () => {
    const { app, conn, sampleId } = await moved("sam", { loriHasAccount: false });
    const res = await post(app, `/samples/${sampleId}/take-observation-location`);
    expect(res.headers.get("location")).toBe(`/samples/${sampleId}`);
    expect(await rows(conn, `SELECT state_province, county FROM sample WHERE entity_id = ${sampleId}`)).toEqual([["OR", "Lane"]]);
  });

  it("says so on the page when the county and state could not be set from the point", async () => {
    const { app, conn, sampleId } = await moved("sam", { gazetteer: false });
    const res = await post(app, `/samples/${sampleId}/take-observation-location`);
    expect(res.headers.get("location")).toBe(`/samples/${sampleId}?place=pending`);
    expect(await rows(conn, `SELECT state_province FROM sample WHERE entity_id = ${sampleId}`)).toEqual([["CA"]]);
    const page = await (await app.request(res.headers.get("location")!)).text();
    // Up to the apostrophe, which the page escapes.
    expect(page).toContain(en.record.sample.staffCoordinates.placePending.split("'")[0]);
  });

  it("is refused while the nightly runs, and writes nothing", async () => {
    const { app, conn, sampleId, sampleOverlayPath } = await moved("sam", { running: "nightly-pipeline" });
    const res = await post(app, `/samples/${sampleId}/take-observation-location`);
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(en.record.sample.staffCoordinates.busy);
    expect(await readSampleOverlay(sampleOverlayPath)).toEqual([]);
    expect(await rows(conn, `SELECT count(*) FROM sample_location_label_diverged`)).toEqual([[1n]]);
  });

  it("moves the county and state just the same when staff type the point into the coordinates form", async () => {
    const { app, conn, sampleId } = await moved();
    const res = await post(app, `/samples/${sampleId}/coordinates`, { latitude: String(OREGON.lat), longitude: String(OREGON.lon) });
    expect(res.status).toBe(302);
    expect(await rows(conn, `SELECT state_province, county FROM sample WHERE entity_id = ${sampleId}`)).toEqual([["OR", "Lane"]]);
  });

  it("is refused once there is nothing to take, and for a sample the old Beeline printed", async () => {
    const { app, conn, sampleId } = await moved();
    expect((await post(app, `/samples/${sampleId}/take-observation-location`)).status).toBe(302);
    const again = await post(app, `/samples/${sampleId}/take-observation-location`);
    expect(again.status).toBe(409);
    expect(await again.text()).toBe(t.notMoved);

    // An imported specimen is on a pin too, but Beeline printed nothing for
    // it, so a moved observation is beeline-1kb.17's to show, not this.
    const imported = await insertCleanSample(
      conn,
      { sample_number: "'6'", inat_observation_id: "11" },
      { latitude: String(CALIFORNIA.lat), longitude: String(CALIFORNIA.lon), source: "'legacy_import'" },
    );
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${imported}, 1, '25000011')`);
    await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
    await conn.run(
      `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
       VALUES (11, (SELECT max(entity_id) FROM sync_run), $1, 'hash-11')`,
      [canonicalJson({ id: 11, uuid: "uuid-11", geojson: { type: "Point", coordinates: [OREGON.lon, OREGON.lat] }, user: { id: 1 } })] as never,
    );
    await refreshObservationFields(conn);
    expect(await rows(conn, `SELECT count(*) FROM sample_location_label_diverged WHERE sample_id = ${imported}`)).toEqual([[0n]]);
  });
});
