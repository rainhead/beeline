import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AREA_RULE_VERSION, deriveAreas, describeAreas } from "../src/derive-area.js";
import { loadSpatial, openDuckDb } from "../src/db.js";
import { SETTLED_SEASON, buildTestGazetteer, createMemoryDb, insertCleanSample, rows } from "./helpers.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "beeline-area-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function storeWithPerson(): Promise<DuckDBConnection> {
  const { conn } = await createMemoryDb();
  await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Adams'), ('Bo Brown')`);
  return conn;
}

const inside = (conn: DuckDBConnection) =>
  rows(
    conn,
    `SELECT sample_id, source, source_id, kind, name FROM sample_area_current
     WHERE kind = 'wilderness' ORDER BY sample_id, source_id`,
  );
const counties = (conn: DuckDBConnection) =>
  rows(conn, `SELECT sample_id, source, source_id, name FROM sample_area_current WHERE kind = 'county' ORDER BY sample_id`);
const areas = (conn: DuckDBConnection) => rows(conn, `SELECT source_id, name FROM area ORDER BY source_id`);

// Inside the test gazetteer's Alsea Wilderness, inside its Ox Wilderness, and
// in neither (inside the refuge).
const ALSEA = { latitude: "44.50", longitude: "-123.60" };
const OX = { latitude: "44.50", longitude: "-123.75" };
const REFUGE = { latitude: "44.41", longitude: "-123.30" };

describe("deriveAreas", () => {
  test("without a gazetteer there is nothing to do, and it says so", async () => {
    const conn = await storeWithPerson();
    await insertCleanSample(conn);
    expect(await deriveAreas(conn, join(dir, "absent.duckdb"))).toEqual({
      gazetteerBuild: null, pending: 0, inWilderness: 0, inCounty: 0, inEcoregion: 0, ecoregionByShore: 0, inPlace: 0, outdated: false, countiesStamped: 0,
    });
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM sample_area_derivation`)).toEqual([[0]]);
  });

  test.each([
    ["without wildernesses", `DROP TABLE wilderness`],
    ["without its regions' own ids", `ALTER TABLE region DROP COLUMN source_id`],
  ])("a gazetteer built before areas (%s) is left for localities, and says it needs rebuilding", async (_, change) => {
    const path = join(dir, `old-${Math.random().toString(36).slice(2)}.duckdb`);
    await buildTestGazetteer(path, "build-old");
    const instance = await openDuckDb(path);
    const g = await instance.connect();
    await g.run(change);
    g.closeSync();
    instance.closeSync();
    const conn = await storeWithPerson();
    await insertCleanSample(conn, {}, ALSEA);
    const r = await deriveAreas(conn, path);
    expect(r).toEqual({
      gazetteerBuild: "build-old", pending: 0, inWilderness: 0, inCounty: 0, inEcoregion: 0, ecoregionByShore: 0, inPlace: 0, outdated: true, countiesStamped: 0,
    });
    expect(describeAreas(r)).toBe("areas: the gazetteer predates them; rebuild it");
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM sample_area_derivation`)).toEqual([[0]]);
  });

  test("finds the wilderness a point lies inside, and copies in only the areas a sample lies inside", async () => {
    const path = join(dir, "a.duckdb");
    await buildTestGazetteer(path, "build-a");
    const conn = await storeWithPerson();
    const inAlsea = await insertCleanSample(conn, {}, ALSEA);
    const outside = await insertCleanSample(conn, { sample_number: "'2'" }, REFUGE);
    expect(await deriveAreas(conn, path)).toEqual({
      gazetteerBuild: "build-a", pending: 2, inWilderness: 1, inCounty: 2, inEcoregion: 2, ecoregionByShore: 0, inPlace: 1, outdated: false, countiesStamped: 0,
    });
    expect(await inside(conn)).toEqual([[inAlsea, "wilderness.net", "9001", "wilderness", "Alsea Wilderness"]]);
    // Both are in Benton County, by its Census GEOID.
    expect(await counties(conn)).toEqual([
      [inAlsea, "census", "41003", "Benton County"],
      [outside, "census", "41003", "Benton County"],
    ]);
    // Ox Wilderness has nobody in it, so the store does not hold it; the
    // test ecoregions are Coast Range (Alsea) and Willamette Valley (refuge).
    expect(await areas(conn)).toEqual([
      ["41003", "Benton County"], ["7.1.8", "Coast Range"], ["7.1.9", "Willamette Valley"], ["9001", "Alsea Wilderness"],
      ["99001", "WILLIAM L. FINLEY NATIONAL WILDLIFE REFUGE"],
    ]);
    // Both were tested, the one outside every area too, at their own points.
    expect(
      await rows(conn, `SELECT sample_id, latitude, longitude, gazetteer_build FROM sample_area_derivation ORDER BY 1`),
    ).toEqual([
      [inAlsea, 44.5, -123.6, "build-a"],
      [outside, 44.41, -123.3, "build-a"],
    ]);
    // A second run has nothing left to test.
    expect((await deriveAreas(conn, path)).pending).toBe(0);
  });

  test("a point within 100 m of a wilderness's edge is not inside it: that is GPS error (Peter, 2026-10-26)", async () => {
    const path = join(dir, "edge.duckdb");
    await buildTestGazetteer(path, "build-edge");
    const conn = await storeWithPerson();
    // Alsea Wilderness's south edge is latitude 44.48: these are about 55 m
    // and 167 m north of it, well inside it east to west.
    await insertCleanSample(conn, {}, { latitude: "44.4805", longitude: "-123.60" });
    const deeper = await insertCleanSample(conn, { sample_number: "'2'" }, { latitude: "44.4815", longitude: "-123.60" });
    expect(await deriveAreas(conn, path)).toMatchObject({ pending: 2, inWilderness: 1, inCounty: 2 });
    expect((await inside(conn)).map(([id]) => id)).toEqual([deeper]);
  });

  test("a moved point is not shown, and is tested again; an area nobody is in any more goes", async () => {
    const path = join(dir, "b.duckdb");
    await buildTestGazetteer(path, "build-b");
    const conn = await storeWithPerson();
    const id = await insertCleanSample(conn, {}, ALSEA);
    await deriveAreas(conn, path);
    await conn.run(`UPDATE sample_location SET latitude = 44.50, longitude = -123.75 WHERE sample_id = ${id}`);
    expect(await inside(conn)).toEqual([]);
    expect(await deriveAreas(conn, path)).toMatchObject({ pending: 1, inWilderness: 1 });
    expect(await inside(conn)).toEqual([[id, "wilderness.net", "9002", "wilderness", "Ox Wilderness"]]);
    expect(await areas(conn)).toEqual([["41003", "Benton County"], ["7.1.8", "Coast Range"], ["9002", "Ox Wilderness"]]);
  });

  test("a new gazetteer build tests every sample again and brings its areas up to that build", async () => {
    const path = join(dir, "c.duckdb");
    await buildTestGazetteer(path, "build-c1");
    const conn = await storeWithPerson();
    await insertCleanSample(conn, {}, ALSEA);
    await insertCleanSample(conn, { sample_number: "'2'" }, ALSEA);
    await deriveAreas(conn, path);
    await buildTestGazetteer(path, "build-c2");
    expect(await deriveAreas(conn, path, { batchSize: 1 })).toEqual({
      gazetteerBuild: "build-c2", pending: 2, inWilderness: 2, inCounty: 2, inEcoregion: 2, ecoregionByShore: 0, inPlace: 0, outdated: false, countiesStamped: 0,
    });
    expect(await rows(conn, `SELECT source_id, gazetteer_build FROM area ORDER BY 1`)).toEqual([
      ["41003", "build-c2"],
      ["7.1.8", "build-c2"],
      ["9001", "build-c2"],
    ]);
  });

  test("tested for one observer, it leaves everyone else's samples for the nightly", async () => {
    const path = join(dir, "d.duckdb");
    await buildTestGazetteer(path, "build-d");
    const conn = await storeWithPerson();
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login)
                    SELECT entity_id, 100, 'ada' FROM person WHERE display_name = 'Ada Adams'`);
    const ada = await insertCleanSample(conn, { collector_id: "(SELECT min(entity_id) FROM person)" }, ALSEA);
    const bo = await insertCleanSample(
      conn,
      { collector_id: "(SELECT max(entity_id) FROM person)", sample_number: "'2'" },
      OX,
    );
    expect(await deriveAreas(conn, path, { observerUserId: 100 })).toMatchObject({ pending: 1, inWilderness: 1 });
    expect((await inside(conn)).map(([id]) => id)).toEqual([ada]);
    expect(await deriveAreas(conn, path)).toMatchObject({ pending: 1, inWilderness: 1 });
    expect((await inside(conn)).map(([id]) => id)).toEqual([ada, bo]);
  });

  test("a point on the shore just outside every county takes the nearest within 1 km (Peter, 2026-10-27)", async () => {
    const path = join(dir, "shore.duckdb");
    await buildTestGazetteer(path, "build-shore");
    const conn = await storeWithPerson();
    // Benton's west edge is longitude -124: about 400 m and 1.6 km west of it.
    const beach = await insertCleanSample(conn, {}, { latitude: "44.50", longitude: "-124.005" });
    await insertCleanSample(conn, { sample_number: "'2'" }, { latitude: "44.50", longitude: "-124.02" });
    expect(await deriveAreas(conn, path)).toMatchObject({ pending: 2, inCounty: 1 });
    expect((await counties(conn)).map(([id]) => id)).toEqual([beach]);
  });
});

describe("ecoregions (beeline-l5so)", () => {
  const ecoregions = (conn: DuckDBConnection) =>
    rows(conn, `SELECT sample_id, source, source_id, name FROM sample_area_current WHERE kind = 'ecoregion' ORDER BY sample_id`);
  const missing = (conn: DuckDBConnection) =>
    rows(conn, `SELECT sample_id, settled FROM sample_ecoregion_missing ORDER BY sample_id`);

  test("a point reads the ecoregion it is in; one just off the shore takes the nearest; one farther reads none", async () => {
    const path = join(dir, "eco.duckdb");
    await buildTestGazetteer(path, "build-eco");
    const conn = await storeWithPerson();
    const valley = await insertCleanSample(conn, {}, REFUGE);
    const range = await insertCleanSample(conn, { sample_number: "'2'" }, ALSEA);
    // The Coast Range's west edge is longitude -124: about 400 m and 1.6 km west of it.
    const beach = await insertCleanSample(conn, { sample_number: "'3'" }, { latitude: "44.50", longitude: "-124.005" });
    const sea = await insertCleanSample(conn, { sample_number: "'4'" }, { latitude: "44.50", longitude: "-124.02" });
    expect(await deriveAreas(conn, path)).toMatchObject({ pending: 4, inEcoregion: 3, ecoregionByShore: 1 });
    expect(await ecoregions(conn)).toEqual([
      [valley, "epa-cec", "7.1.9", "Willamette Valley"],
      [range, "epa-cec", "7.1.8", "Coast Range"],
      [beach, "epa-cec", "7.1.8", "Coast Range"],
    ]);
    // The sample in the sea was tested and found none, which the view says, in the season it is from.
    expect(await missing(conn)).toEqual([[sea, false]]);
    expect(describeAreas(await deriveAreas(conn, path))).toBeNull();
  });

  test("the samples with none are told apart by season, and a sample without true coordinates is not one of them", async () => {
    const path = join(dir, "eco-missing.duckdb");
    await buildTestGazetteer(path, "build-eco-missing");
    const conn = await storeWithPerson();
    const out = { latitude: "44.50", longitude: "-124.02" };
    const active = await insertCleanSample(conn, {}, out);
    const settled = await insertCleanSample(
      conn, { sample_number: "'2'", date_start: `DATE '${SETTLED_SEASON}-07-14'`, date_end: `DATE '${SETTLED_SEASON}-07-14'` }, out);
    const unlocated = await insertCleanSample(conn, { sample_number: "'3'" }, null);
    await deriveAreas(conn, path);
    expect(await missing(conn)).toEqual([[active, false], [settled, true]]);
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM sample_area_derivation WHERE sample_id = ${unlocated}`)).toEqual([[0]]);
    expect((await ecoregions(conn)).length).toBe(0);
  });

  test("a point where two simplified outlines lap over each other gets one ecoregion, not two", async () => {
    const path = join(dir, "eco-overlap.duckdb");
    await buildTestGazetteer(path, "build-eco-overlap");
    const instance = await openDuckDb(path);
    const g = await instance.connect();
    // A neighbour whose simplified edge laps a few hundred metres over the Coast Range's.
    await g.run(`LOAD spatial; INSERT INTO ecoregion VALUES ('7.1.8b', 'Overlap Range',
      ST_GeomFromText('POLYGON((-123.605 44, -123 44, -123 45, -123.605 45, -123.605 44))'))`);
    g.closeSync();
    instance.closeSync();
    const conn = await storeWithPerson();
    const id = await insertCleanSample(conn, {}, ALSEA);
    expect(await deriveAreas(conn, path)).toMatchObject({ pending: 1, inEcoregion: 1, ecoregionByShore: 0 });
    expect(await ecoregions(conn)).toEqual([[id, "epa-cec", "7.1.8", "Coast Range"]]);
  });

  test("a gazetteer without the ecoregion table still finds wildernesses and counties, and leaves every sample in the missing view", async () => {
    const path = join(dir, "eco-old.duckdb");
    await buildTestGazetteer(path, "build-eco-old");
    const instance = await openDuckDb(path);
    const g = await instance.connect();
    await g.run(`DROP TABLE ecoregion`);
    g.closeSync();
    instance.closeSync();
    const conn = await storeWithPerson();
    const id = await insertCleanSample(conn, {}, ALSEA);
    expect(await deriveAreas(conn, path)).toMatchObject({
      outdated: false, pending: 1, inWilderness: 1, inCounty: 1, inEcoregion: 0, ecoregionByShore: 0,
    });
    expect(await inside(conn)).toEqual([[id, "wilderness.net", "9001", "wilderness", "Alsea Wilderness"]]);
    expect(await counties(conn)).toEqual([[id, "census", "41003", "Benton County"]]);
    expect(await ecoregions(conn)).toEqual([]);
    expect(await missing(conn)).toEqual([[id, false]]);
  });
});

describe("the places people collect in (beeline-9jd4)", () => {
  const places = (conn: DuckDBConnection) =>
    rows(
      conn,
      `SELECT sample_id, source, source_id, kind, name FROM sample_area_current
       WHERE kind NOT IN ('wilderness', 'county', 'ecoregion') ORDER BY sample_id, kind, source_id`,
    );

  /** The test gazetteer with a park that laps over the refuge's east side, and an island. Synthetic outlines. */
  async function withParkAndIsland(path: string, buildId: string): Promise<void> {
    await buildTestGazetteer(path, buildId);
    const instance = await openDuckDb(path);
    const g = await instance.connect();
    await loadSpatial(g);
    await g.run(`INSERT INTO osm_area (osm_id, name, area_ha, is_island, geom, is_city_park) VALUES
      ('way/3', 'Muddy Creek Natural Area', 500, false, ST_MakeEnvelope(-123.28, 44.38, -123.20, 44.45), false),
      ('relation/4', 'Kiger Island', 900, true, ST_MakeEnvelope(-123.24, 44.50, -123.20, 44.54), false),
      ('way/5', NULL, 20, false, ST_MakeEnvelope(-123.24, 44.50, -123.20, 44.54), false),
      ('way/6', 'Kiger Island Park', 5, false, ST_MakeEnvelope(-123.225, 44.515, -123.215, 44.525), true),
      -- Outlines over everything here that name whoever holds the land, or
      -- carry a code, and no place. 'WA DNR' and 'PS001' are names
      -- OpenStreetMap has; the office is made up, after its
      -- 'BLM - Farmington Field Office'.
      ('relation/7', 'WA DNR', 90000, false, ST_MakeEnvelope(-124, 44, -122, 45), false),
      ('relation/8', 'BLM - Alsea Field Office', 90000, false, ST_MakeEnvelope(-124, 44, -122, 45), false),
      ('way/9', 'PS001', 90000, false, ST_MakeEnvelope(-124, 44, -122, 45), true)`);
    // OpenStreetMap's own outline of the refuge, nearly all of it inside the
    // Fish and Wildlife Service's: the agency's is the area.
    await g.run(`INSERT INTO osm_area (osm_id, name, area_ha, is_island, geom, is_city_park, agency_share) VALUES
      ('relation/10', 'William L. Finley National Wildlife Refuge', 4000, false,
       ST_MakeEnvelope(-123.36, 44.38, -123.25, 44.45), false, 0.91)`);
    g.closeSync();
    instance.closeSync();
  }

  test("a point is in every refuge, park and island whose outline it is inside, and in no federal wilderness as a park", async () => {
    const path = join(dir, "places.duckdb");
    await withParkAndIsland(path, "build-places");
    const conn = await storeWithPerson();
    const refugeOnly = await insertCleanSample(conn, {}, REFUGE);
    // Inside the refuge and the park that laps over it: both.
    const both = await insertCleanSample(conn, { sample_number: "'2'" }, { latitude: "44.41", longitude: "-123.27" });
    // On the island, in its city park, where a park nobody named lies too.
    const island = await insertCleanSample(conn, { sample_number: "'3'" }, { latitude: "44.52", longitude: "-123.22" });
    // About 80 m west of the refuge's edge: outside it, with no allowance.
    const beside = await insertCleanSample(conn, { sample_number: "'4'" }, { latitude: "44.41", longitude: "-123.351" });
    // Inside OpenStreetMap's "Alsea Wilderness": Wilderness.net's is the area, not this.
    const wild = await insertCleanSample(conn, { sample_number: "'5'" }, ALSEA);
    const result = await deriveAreas(conn, path);
    expect(result).toMatchObject({ pending: 5, inWilderness: 1, inPlace: 3 });
    expect(describeAreas(result)).toContain("3 in a refuge, park or island");
    expect(await places(conn)).toEqual([
      [refugeOnly, "usfws", "99001", "refuge", "WILLIAM L. FINLEY NATIONAL WILDLIFE REFUGE"],
      [both, "osm", "way/3", "park", "Muddy Creek Natural Area"],
      [both, "usfws", "99001", "refuge", "WILLIAM L. FINLEY NATIONAL WILDLIFE REFUGE"],
      [island, "osm", "way/6", "city_park", "Kiger Island Park"],
      [island, "osm", "relation/4", "island", "Kiger Island"],
    ]);
    expect(await places(conn)).not.toContainEqual(expect.arrayContaining([beside]));
    expect(await places(conn)).not.toContainEqual(expect.arrayContaining([wild]));
    // Only what a sample lies inside is copied in.
    expect(await rows(conn, `SELECT kind, count(*)::INTEGER FROM area GROUP BY kind ORDER BY kind`)).toEqual([
      ["city_park", 1], ["county", 1], ["ecoregion", 2], ["island", 1], ["park", 1], ["refuge", 1], ["wilderness", 1],
    ]);
  });

  test("a gazetteer built before named_area finds no refuge, park or island, and the rest as before", async () => {
    const path = join(dir, "places-old.duckdb");
    await withParkAndIsland(path, "build-places-old");
    const instance = await openDuckDb(path);
    const g = await instance.connect();
    await g.run(`DROP TABLE named_area`);
    g.closeSync();
    instance.closeSync();
    const conn = await storeWithPerson();
    const id = await insertCleanSample(conn, {}, { latitude: "44.41", longitude: "-123.27" });
    expect(await deriveAreas(conn, path)).toMatchObject({ outdated: false, pending: 1, inCounty: 1, inEcoregion: 1, inPlace: 0 });
    expect(await places(conn)).toEqual([]);
    expect(await counties(conn)).toEqual([[id, "census", "41003", "Benton County"]]);
  });

  test("the store takes every kind and source, and refuses one it does not know", async () => {
    const conn = await storeWithPerson();
    await loadSpatial(conn);
    for (const [source, kind] of [
      ["usfws", "refuge"], ["wdfw", "wildlife_area"], ["nps", "nps_unit"], ["wa-parks", "state_park"],
      ["bc-parks", "state_park"], ["osm", "city_park"], ["osm", "park"], ["osm", "island"],
    ]) {
      await conn.run(
        `INSERT INTO area VALUES ('${source}', '${kind}-1', '${kind}', 'A place', ST_MakeEnvelope(0, 0, 1, 1), 'b')`,
      );
    }
    await expect(
      conn.run(`INSERT INTO area VALUES ('osm', 'x', 'town', 'A place', ST_MakeEnvelope(0, 0, 1, 1), 'b')`),
    ).rejects.toThrow(/CHECK/);
  });
});

describe("stamping a sample's county from its coordinates (beeline-313x, Peter, 2026-10-27)", () => {
  const countyOf = async (conn: DuckDBConnection, id: number) =>
    ((await rows(conn, `SELECT county FROM sample WHERE entity_id = ${id}`)) as string[][])[0]![0];

  test("writes the point's county on an active sample still to print, and on nothing else", async () => {
    const path = join(dir, "stamp.duckdb");
    await buildTestGazetteer(path, "build-stamp");
    const conn = await storeWithPerson();
    // Every sample is in Benton County by its point and carries the fixture's
    // "BentonCo", which the stamp replaces with the Census's name.
    const stamped = await insertCleanSample(conn, { inat_observation_id: "1001" }, ALSEA);
    const noObservation = await insertCleanSample(conn, { sample_number: "'2'" }, ALSEA);
    const settled = await insertCleanSample(
      conn,
      {
        inat_observation_id: "1003", sample_number: "'3'",
        date_start: `DATE '${SETTLED_SEASON}-07-14'`, date_end: `DATE '${SETTLED_SEASON}-07-14'`,
      },
      ALSEA,
    );
    const printed = await insertCleanSample(conn, { inat_observation_id: "1004", sample_number: "'4'" }, ALSEA);
    // An imported specimen, with no Beeline label row, is a label on paper (schema/101).
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${printed}, 1)`);
    const otherState = await insertCleanSample(
      conn,
      { inat_observation_id: "1005", sample_number: "'5'", state_province: "'WA'" },
      ALSEA,
    );
    // Frozen into a run that has not printed: the run already holds its
    // label text, so the record keeps the county the labels will carry.
    const frozen = await insertCleanSample(conn, { inat_observation_id: "1006", sample_number: "'6'" }, ALSEA);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${frozen}, 1)`);
    await conn.run(`INSERT INTO print_run (prepared_by) SELECT min(entity_id) FROM person`);
    await conn.run(
      `INSERT INTO printed_label (print_run_id, specimen_id, sheet, cell, location_text, coordinates_text, date_text,
                                  collector_text, method_text, number_text, latitude, longitude, date_start, date_end)
       SELECT (SELECT max(entity_id) FROM print_run), sp.entity_id, 1, 0, 'USA:OR:BentonCo', '44.5 -123.6', 'd',
              'c', 'net', 'n', 44.5, -123.6, s.date_start, s.date_end
       FROM specimen sp JOIN sample s ON s.entity_id = sp.sample_id WHERE sp.sample_id = ${frozen}`,
    );
    // Entered in Beeline (beeline-3vs.2): no observation, but Beeline is its only record.
    const entered = await insertCleanSample(conn, { sample_number: "'7'", kind: "'trap'" }, ALSEA);
    await conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${entered})`);
    const r = await deriveAreas(conn, path, { stampCounties: true });
    expect(r.countiesStamped).toBe(3);
    expect(describeAreas(r)).toContain("3 county(ies) written from the coordinates");
    expect(await countyOf(conn, stamped)).toBe("Benton");
    expect(await countyOf(conn, entered)).toBe("Benton");
    // A sample still to print whose point lies inside an Oregon county is in
    // Oregon, whatever it said (beeline-1kb.17.1). Before, it was skipped as
    // wrong in a way no county could fix.
    expect(await rows(conn, `SELECT state_province, county FROM sample WHERE entity_id = ${otherState}`)).toEqual([["OR", "Benton"]]);
    for (const id of [noObservation, settled, printed, frozen]) {
      expect(await countyOf(conn, id)).toBe("BentonCo");
    }
    // A second run finds nothing to change.
    expect((await deriveAreas(conn, path, { stampCounties: true })).countiesStamped).toBe(0);
  });

  test("writes the county of a settled sample staff released for printing, and not of one they did not", async () => {
    const path = join(dir, "released.duckdb");
    await buildTestGazetteer(path, "build-released");
    const conn = await storeWithPerson();
    const settledDates = { date_start: `DATE '${SETTLED_SEASON}-07-14'`, date_end: `DATE '${SETTLED_SEASON}-07-14'` };
    const unreleased = await insertCleanSample(conn, { inat_observation_id: "1103", sample_number: "'3'", ...settledDates }, ALSEA);
    const released = await insertCleanSample(conn, { inat_observation_id: "1104", sample_number: "'4'", ...settledDates }, ALSEA);
    const enteredAndReleased = await insertCleanSample(conn, { sample_number: "'5'", kind: "'trap'", ...settledDates }, ALSEA);
    // A released sample from the old records has neither an observation nor an entry, so its place is the record's.
    const oldRecord = await insertCleanSample(conn, { sample_number: "'6'", ...settledDates }, ALSEA);
    await conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${enteredAndReleased})`);
    await release(conn, released, enteredAndReleased, oldRecord);
    // A released sample with a label on paper keeps what the label says.
    const printed = await insertCleanSample(conn, { inat_observation_id: "1107", sample_number: "'7'", ...settledDates }, ALSEA);
    await release(conn, printed);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${printed}, 1)`);
    const r = await deriveAreas(conn, path, { stampCounties: true });
    expect(r.countiesStamped).toBe(2);
    expect(await countyOf(conn, released)).toBe("Benton");
    expect(await countyOf(conn, enteredAndReleased)).toBe("Benton");
    for (const id of [unreleased, oldRecord, printed]) expect(await countyOf(conn, id)).toBe("BentonCo");
  });

  const release = (conn: DuckDBConnection, ...ids: number[]) =>
    conn.run(`INSERT INTO sample_print_release_event (sample_id, action) VALUES ${ids.map((id) => `(${id}, 'release')`).join(", ")}`);
  const pending = async (conn: DuckDBConnection) =>
    (await rows(conn, `SELECT sample_id FROM pending_print_sample ORDER BY sample_id`)).map(([id]) => id);

  test("a released settled sample that follows its point is not pending until the stamp has looked at it", async () => {
    const path = join(dir, "awaiting.duckdb");
    await buildTestGazetteer(path, "build-awaiting");
    const conn = await storeWithPerson();
    const settledDates = { date_start: `DATE '${SETTLED_SEASON}-07-14'`, date_end: `DATE '${SETTLED_SEASON}-07-14'` };
    const entered = await insertCleanSample(conn, { sample_number: "'1'", kind: "'trap'", ...settledDates, county: "'Malheur'" }, ALSEA);
    await conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${entered})`);
    const linked = await insertCleanSample(conn, { sample_number: "'2'", inat_observation_id: "2201", ...settledDates }, ALSEA);
    // From the old records: no observation, not entered. It does not follow its point, so there is nothing to wait for.
    const oldRecord = await insertCleanSample(conn, { sample_number: "'3'", ...settledDates }, ALSEA);
    await release(conn, entered, linked, oldRecord);
    expect(await pending(conn)).toEqual([oldRecord]);
    expect(await rows(conn, `SELECT sample_id FROM sample_awaiting_place ORDER BY sample_id`)).toEqual([[entered], [linked]]);

    // The areas are found and the stamp runs: the place is the point's, and they are pending.
    await deriveAreas(conn, path, { stampCounties: true });
    expect(await countyOf(conn, entered)).toBe("Benton");
    expect(await pending(conn)).toEqual([entered, linked, oldRecord]);
    expect(await rows(conn, `SELECT count(*) FROM sample_awaiting_place`)).toEqual([[0n]]);

    // A point moved afterwards is not the point the stamp looked at.
    await conn.run(`UPDATE sample_location SET latitude = 44.51 WHERE sample_id = ${entered}`);
    expect(await pending(conn)).toEqual([linked, oldRecord]);
    // A release written after the stamp waits for the next one, whatever the stamp found before.
    await conn.run(`UPDATE sample_location SET latitude = 44.50 WHERE sample_id = ${entered}`);
    await conn.run(`INSERT INTO sample_print_release_event (sample_id, action) VALUES (${entered}, 'withdraw')`);
    await conn.run(`INSERT INTO sample_print_release_event (sample_id, action) VALUES (${entered}, 'release')`);
    expect(await pending(conn)).toEqual([linked, oldRecord]);
    await deriveAreas(conn, path, { stampCounties: true });
    expect(await pending(conn)).toEqual([entered, linked, oldRecord]);
  });

  test("never writes a county the gazetteer does not name over one the sample has", async () => {
    const path = join(dir, "nameless.duckdb");
    await buildTestGazetteer(path, "build-nameless");
    const instance = await openDuckDb(path);
    const g = await instance.connect();
    await g.run(`UPDATE region SET county = NULL`);
    g.closeSync();
    instance.closeSync();
    const conn = await storeWithPerson();
    const id = await insertCleanSample(conn, { inat_observation_id: "1001" }, ALSEA);
    expect((await deriveAreas(conn, path, { stampCounties: true })).countiesStamped).toBe(0);
    expect(await countyOf(conn, id)).toBe("BentonCo");
  });

  test("a point staff set carries its county, state and atlas, printed or settled, but not into an unprinted run", async () => {
    // beeline-1kb.17.1, GitHub #298: a printed sample whose point staff moved
    // across a state line kept the old state and county, and nothing could
    // change them. Each sample here starts in Washington and has a staff
    // point in Benton County, Oregon.
    const path = join(dir, "staff-point.duckdb");
    await buildTestGazetteer(path, "build-staff-point");
    const conn = await storeWithPerson();
    const wa = { state_province: "'WA'", county: "'Klickitat'" };
    const staffPoint = async (id: number) => {
      await conn.run(
        `INSERT INTO sample_location_override (sample_id, latitude, longitude) VALUES (${id}, ${ALSEA.latitude}, ${ALSEA.longitude})`,
      );
      await conn.run(`UPDATE sample_location SET source = 'staff_entry' WHERE sample_id = ${id}`);
    };
    const printed = await insertCleanSample(conn, { inat_observation_id: "2001", sample_number: "'1'", ...wa, atlas_id: "(SELECT entity_id FROM program WHERE code = 'WaBA')" }, ALSEA);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${printed}, 1)`);
    await staffPoint(printed);
    const settled = await insertCleanSample(
      conn,
      { inat_observation_id: "2002", sample_number: "'2'", ...wa, date_start: `DATE '${SETTLED_SEASON}-07-14'`, date_end: `DATE '${SETTLED_SEASON}-07-14'` },
      ALSEA,
    );
    await staffPoint(settled);
    // A person put this one in Washington's atlas; the state follows the point, the atlas stays.
    const placed = await insertCleanSample(conn, { inat_observation_id: "2003", sample_number: "'3'", ...wa }, ALSEA);
    await conn.run(`INSERT INTO sample_atlas (sample_id, atlas_id, assigned_by) SELECT ${placed}, (SELECT entity_id FROM program WHERE code = 'WaBA'), min(entity_id) FROM person`);
    await staffPoint(placed);
    // The same, with no staff point: a printed sample keeps what its labels say.
    const untouched = await insertCleanSample(conn, { inat_observation_id: "2004", sample_number: "'4'", ...wa }, ALSEA);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${untouched}, 1)`);
    // Frozen into a run that has not printed: its labels were composed at the freeze.
    const frozen = await insertCleanSample(conn, { inat_observation_id: "2005", sample_number: "'5'", ...wa }, ALSEA);
    await staffPoint(frozen);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${frozen}, 1)`);
    await conn.run(`INSERT INTO print_run (prepared_by) SELECT min(entity_id) FROM person`);
    await conn.run(
      `INSERT INTO printed_label (print_run_id, specimen_id, sheet, cell, location_text, coordinates_text, date_text,
                                  collector_text, method_text, number_text, latitude, longitude, date_start, date_end)
       SELECT (SELECT max(entity_id) FROM print_run), sp.entity_id, 1, 0, 'USA:WA:KlickitatCo', '44.5 -123.6', 'd',
              'c', 'net', 'n', 44.5, -123.6, s.date_start, s.date_end
       FROM specimen sp JOIN sample s ON s.entity_id = sp.sample_id WHERE sp.sample_id = ${frozen}`,
    );
    const place = async (id: number) =>
      (await rows(
        conn,
        `SELECT s.country, s.state_province, s.county, p.code FROM sample s
         LEFT JOIN sample_atlas sa ON sa.sample_id = s.entity_id
         LEFT JOIN program p ON p.entity_id = sa.atlas_id WHERE s.entity_id = ${id}`,
      ))[0];

    // Asked for one sample, only that one moves.
    expect((await deriveAreas(conn, path, { stampSampleIds: [printed] })).countiesStamped).toBe(1);
    expect(await place(printed)).toEqual(["USA", "OR", "Benton", "OBA"]);
    expect(await place(settled)).toEqual(["USA", "WA", "Klickitat", null]);

    expect((await deriveAreas(conn, path, { stampCounties: true })).countiesStamped).toBe(2);
    expect(await place(settled)).toEqual(["USA", "OR", "Benton", "OBA"]);
    expect(await place(placed)).toEqual(["USA", "OR", "Benton", "WaBA"]);
    expect(await place(untouched)).toEqual(["USA", "WA", "Klickitat", null]);
    expect(await place(frozen)).toEqual(["USA", "WA", "Klickitat", null]);
    expect((await deriveAreas(conn, path, { stampCounties: true })).countiesStamped).toBe(0);
  });

  test("a sample still to print follows its point's state too, so a staff point taken away takes its state with it", async () => {
    // Fable's review of beeline-1kb.17.1: staff set a point in another state
    // on a sample still to print, the stamp moved its state, staff removed
    // the point, and the state stayed behind for good, because the stamp
    // used to require the sample's state to be the point's already.
    const path = join(dir, "follows.duckdb");
    await buildTestGazetteer(path, "build-follows");
    const conn = await storeWithPerson();
    const id = await insertCleanSample(conn, { inat_observation_id: "3001", state_province: "'WA'", county: "'Klickitat'" }, ALSEA);
    expect((await deriveAreas(conn, path, { stampCounties: true })).countiesStamped).toBe(1);
    expect(await rows(conn, `SELECT state_province, county FROM sample WHERE entity_id = ${id}`)).toEqual([["OR", "Benton"]]);
  });

  test("a county found by the shore allowance never changes the state", async () => {
    // 45.005 is about 550 m north of the test county's edge, inside the 1 km
    // allowance: the point takes Benton without lying in it. Near a land
    // border that is the neighbour's county, so the state must not follow.
    const path = join(dir, "shore.duckdb");
    await buildTestGazetteer(path, "build-shore");
    const conn = await storeWithPerson();
    const shore = { latitude: "45.005", longitude: "-123.60" };
    const other = await insertCleanSample(conn, { inat_observation_id: "4001", state_province: "'WA'", county: "'Klickitat'" }, shore);
    await conn.run(`INSERT INTO sample_location_override (sample_id, latitude, longitude) VALUES (${other}, 45.005, -123.60)`);
    await conn.run(`UPDATE sample_location SET source = 'staff_entry' WHERE sample_id = ${other}`);
    const same = await insertCleanSample(conn, { inat_observation_id: "4002", sample_number: "'2'" }, shore);
    const r = await deriveAreas(conn, path, { stampSampleIds: [other, same] });
    expect(r.countiesStamped).toBe(1);
    expect(await rows(conn, `SELECT entity_id, state_province, county FROM sample ORDER BY 1`)).toEqual([
      [other, "WA", "Klickitat"],
      [same, "OR", "Benton"],
    ]);
    // Neither lies inside a county, so neither is settled: the page says so.
    expect(r.unsettled).toEqual([other, same]);
  });

  test("leaves every county alone unless asked, as Check iNaturalist now does", async () => {
    const path = join(dir, "nostamp.duckdb");
    await buildTestGazetteer(path, "build-nostamp");
    const conn = await storeWithPerson();
    const id = await insertCleanSample(conn, { inat_observation_id: "1001" }, ALSEA);
    expect((await deriveAreas(conn, path)).countiesStamped).toBe(0);
    expect(await countyOf(conn, id)).toBe("BentonCo");
  });
});

describe("what the point says the state and country are (beeline-rax1)", () => {
  const place = (conn: DuckDBConnection) =>
    rows(conn, `SELECT sample_id, country, state_province, county_inside, rule_version FROM sample_area_derivation ORDER BY 1`);
  const disagreements = (conn: DuckDBConnection) =>
    rows(
      conn,
      `SELECT sample_id, country, state_province, point_country, point_state_province, county_inside, printed, settled
       FROM sample_place_disagreement ORDER BY 1`,
    );

  test("is recorded with the areas: inside the county, by the shore, or in none", async () => {
    const path = join(dir, "place.duckdb");
    await buildTestGazetteer(path, "build-place");
    const conn = await storeWithPerson();
    const inside = await insertCleanSample(conn, {}, ALSEA);
    // About 550 m north of the county's edge: the nearest county, not inside it.
    const shore = await insertCleanSample(conn, { sample_number: "'2'" }, { latitude: "45.005", longitude: "-123.60" });
    const nowhere = await insertCleanSample(conn, { sample_number: "'3'" }, { latitude: "46.50", longitude: "-123.60" });
    await deriveAreas(conn, path);
    expect(await place(conn)).toEqual([
      [inside, "USA", "OR", true, AREA_RULE_VERSION],
      [shore, "USA", "OR", false, AREA_RULE_VERSION],
      [nowhere, null, null, null, AREA_RULE_VERSION],
    ]);
  });

  test("a sample the stamp leaves alone says so when its state is not its point's, split by season", async () => {
    const path = join(dir, "disagree.duckdb");
    await buildTestGazetteer(path, "build-disagree");
    const conn = await storeWithPerson();
    // Printed in Washington, with its point in Oregon: its labels say WA.
    const printed = await insertCleanSample(conn, { inat_observation_id: "5001", state_province: "'WA'" }, ALSEA);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${printed}, 1)`);
    const settled = await insertCleanSample(
      conn,
      {
        inat_observation_id: "5002", sample_number: "'2'", state_province: "'ID'",
        date_start: `DATE '${SETTLED_SEASON}-07-14'`, date_end: `DATE '${SETTLED_SEASON}-07-14'`,
      },
      ALSEA,
    );
    // On the shore just outside the county: the stamp keeps WA, and the view
    // says the point is only near an Oregon county.
    const shore = await insertCleanSample(
      conn,
      { inat_observation_id: "5003", sample_number: "'3'", state_province: "'WA'" },
      { latitude: "45.005", longitude: "-123.60" },
    );
    // Still to print: the stamp makes it Oregon, so it is not in the view.
    const follows = await insertCleanSample(conn, { inat_observation_id: "5004", sample_number: "'4'", state_province: "'WA'" }, ALSEA);
    const agrees = await insertCleanSample(conn, { inat_observation_id: "5005", sample_number: "'5'" }, ALSEA);
    // Printed in Washington about 55 m inside the county's northern edge:
    // within GPS error of the line, so not a disagreement.
    const nearEdge = await insertCleanSample(
      conn,
      { inat_observation_id: "5006", sample_number: "'6'", state_province: "'WA'" },
      { latitude: "44.9995", longitude: "-123.60" },
    );
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${nearEdge}, 1)`);
    await deriveAreas(conn, path, { stampCounties: true });
    expect(await disagreements(conn)).toEqual([
      [printed, "USA", "WA", "USA", "OR", true, true, false],
      [settled, "USA", "ID", "USA", "OR", true, false, true],
      [shore, "USA", "WA", "USA", "OR", false, false, false],
    ]);
    expect(await rows(conn, `SELECT state_province FROM sample WHERE entity_id IN (${follows}, ${agrees})`)).toEqual([["OR"], ["OR"]]);
    expect(await rows(conn, `SELECT sample_id, county_inside_100m FROM sample_area_derivation WHERE sample_id IN (${printed}, ${nearEdge}) ORDER BY 1`))
      .toEqual([[printed, true], [nearEdge, false]]);
    // A point that moves takes its sample out until it is tested again.
    await conn.run(`UPDATE sample_location SET latitude = 44.6 WHERE sample_id = ${printed}`);
    expect((await disagreements(conn)).map((r) => r[0])).not.toContain(printed);
  });

  test("a derivation from an earlier version of the step is tested again", async () => {
    const path = join(dir, "version.duckdb");
    await buildTestGazetteer(path, "build-version");
    const conn = await storeWithPerson();
    const id = await insertCleanSample(conn, {}, ALSEA);
    await deriveAreas(conn, path);
    // As migration 0101 leaves every row: version 0, with no place.
    await conn.run(`UPDATE sample_area_derivation SET rule_version = 0, country = NULL, state_province = NULL, county_inside = NULL`);
    expect((await deriveAreas(conn, path)).pending).toBe(1);
    expect(await place(conn)).toEqual([[id, "USA", "OR", true, AREA_RULE_VERSION]]);
    expect((await deriveAreas(conn, path)).pending).toBe(0);
  });

  test("a point exactly on a county's edge is not inside it, so it does not move the state", async () => {
    // ST_Contains gives a point on the line to no county; the shore allowance
    // then finds it at no distance. The stamp used to test "inside" with
    // ST_Intersects, which says yes, and would have moved this sample to OR.
    const path = join(dir, "edge.duckdb");
    await buildTestGazetteer(path, "build-edge");
    const conn = await storeWithPerson();
    const id = await insertCleanSample(
      conn,
      { inat_observation_id: "6001", state_province: "'WA'", county: "'Klickitat'" },
      { latitude: "45.0", longitude: "-123.60" },
    );
    await deriveAreas(conn, path, { stampCounties: true });
    expect(await place(conn)).toEqual([[id, "USA", "OR", false, AREA_RULE_VERSION]]);
    expect(await rows(conn, `SELECT state_province, county FROM sample WHERE entity_id = ${id}`)).toEqual([["WA", "Klickitat"]]);
  });
});

describe("the county stamp's memory (beeline-6cur)", () => {
  test("many samples in a county with a large outline are stamped within a small memory limit", async () => {
    // Production failed here every night from 11 to 14 November 2026: the
    // stamp put a copy of the county's outline on every sample's row, and
    // 70,654 samples against outlines of up to 1 MB needed more than 1.5 GB.
    // Here 300 samples, a 1 MB outline and 150 MB do the same.
    const path = join(dir, "large-outline.duckdb");
    await buildTestGazetteer(path, "build-large");
    const instance = await openDuckDb(path);
    const g = await instance.connect();
    await loadSpatial(g);
    // Benton's square, drawn with 15,000 points a side.
    await g.run(`
      UPDATE region SET geom = (
        SELECT ST_MakePolygon(ST_MakeLine(list(ST_Point(x, y) ORDER BY n)))
        FROM (
          SELECT i AS n, -124 + 2 * i / 15000.0 AS x, 44.0 AS y FROM range(15000) t(i)
          UNION ALL SELECT 15000 + i, -122.0, 44 + i / 15000.0 FROM range(15000) t(i)
          UNION ALL SELECT 30000 + i, -122 - 2 * i / 15000.0, 45.0 FROM range(15000) t(i)
          UNION ALL SELECT 45000 + i, -124.0, 45 - i / 15000.0 FROM range(15001) t(i)
        ))`);
    const [[bytes]] = (await (await g.run(`SELECT octet_length(ST_AsWKB(geom)) FROM region`)).getRows()) as [[bigint]];
    expect(Number(bytes)).toBeGreaterThan(900_000);
    g.closeSync();
    instance.closeSync();

    const conn = await storeWithPerson();
    for (let i = 0; i < 300; i++) {
      await insertCleanSample(conn, { sample_number: `'${i + 1}'`, inat_observation_id: String(2000 + i) }, ALSEA);
    }
    // The areas are found first, with memory to spare, so that the limit
    // below is on the stamp alone, as on a night with nothing new to test.
    expect(await deriveAreas(conn, path)).toMatchObject({ inCounty: 300, countiesStamped: 0 });
    // An in-memory store spills to .tmp in the working directory, which is
    // the repository; this keeps what it spills in the test's own folder.
    await conn.run(`SET temp_directory = '${join(dir, "spill")}'`);
    await conn.run("SET memory_limit = '150MB'");
    const r = await deriveAreas(conn, path, { stampCounties: true });
    expect(r).toMatchObject({ pending: 0, countiesStamped: 300 });
    expect(await rows(conn, `SELECT DISTINCT county FROM sample`)).toEqual([["Benton"]]);
  });
});
