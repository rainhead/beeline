import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveAreas, describeAreas } from "../src/derive-area.js";
import { openDuckDb } from "../src/db.js";
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
      gazetteerBuild: null, pending: 0, inWilderness: 0, inCounty: 0, outdated: false, countiesStamped: 0,
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
      gazetteerBuild: "build-old", pending: 0, inWilderness: 0, inCounty: 0, outdated: true, countiesStamped: 0,
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
      gazetteerBuild: "build-a", pending: 2, inWilderness: 1, inCounty: 2, outdated: false, countiesStamped: 0,
    });
    expect(await inside(conn)).toEqual([[inAlsea, "wilderness.net", "9001", "wilderness", "Alsea Wilderness"]]);
    // Both are in Benton County, by its Census GEOID.
    expect(await counties(conn)).toEqual([
      [inAlsea, "census", "41003", "Benton County"],
      [outside, "census", "41003", "Benton County"],
    ]);
    // Ox Wilderness has nobody in it, so the store does not hold it.
    expect(await areas(conn)).toEqual([["41003", "Benton County"], ["9001", "Alsea Wilderness"]]);
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
    expect(await areas(conn)).toEqual([["41003", "Benton County"], ["9002", "Ox Wilderness"]]);
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
      gazetteerBuild: "build-c2", pending: 2, inWilderness: 2, inCounty: 2, outdated: false, countiesStamped: 0,
    });
    expect(await rows(conn, `SELECT source_id, gazetteer_build FROM area ORDER BY 1`)).toEqual([
      ["41003", "build-c2"],
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
    const r = await deriveAreas(conn, path, { stampCounties: true });
    expect(r.countiesStamped).toBe(1);
    expect(describeAreas(r)).toContain("1 county(ies) written from the coordinates");
    expect(await countyOf(conn, stamped)).toBe("Benton");
    for (const id of [noObservation, settled, printed, otherState]) expect(await countyOf(conn, id)).toBe("BentonCo");
    // A second run finds nothing to change.
    expect((await deriveAreas(conn, path, { stampCounties: true })).countiesStamped).toBe(0);
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

  test("leaves every county alone unless asked, as Check iNaturalist now does", async () => {
    const path = join(dir, "nostamp.duckdb");
    await buildTestGazetteer(path, "build-nostamp");
    const conn = await storeWithPerson();
    const id = await insertCleanSample(conn, { inat_observation_id: "1001" }, ALSEA);
    expect((await deriveAreas(conn, path)).countiesStamped).toBe(0);
    expect(await countyOf(conn, id)).toBe("BentonCo");
  });
});
