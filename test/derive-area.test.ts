import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveAreas, describeAreas } from "../src/derive-area.js";
import { openDuckDb } from "../src/db.js";
import { buildTestGazetteer, createMemoryDb, insertCleanSample, rows } from "./helpers.js";

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
  rows(conn, `SELECT sample_id, source, source_id, kind, name FROM sample_area_current ORDER BY sample_id, source_id`);
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
      gazetteerBuild: null, pending: 0, inside: 0, outdated: false,
    });
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM sample_area_derivation`)).toEqual([[0]]);
  });

  test("a gazetteer built before areas is left for localities, and says it needs rebuilding", async () => {
    const path = join(dir, "old.duckdb");
    await buildTestGazetteer(path, "build-old");
    const instance = await openDuckDb(path);
    const g = await instance.connect();
    await g.run(`DROP TABLE wilderness`);
    g.closeSync();
    instance.closeSync();
    const conn = await storeWithPerson();
    await insertCleanSample(conn, {}, ALSEA);
    const r = await deriveAreas(conn, path);
    expect(r).toEqual({ gazetteerBuild: "build-old", pending: 0, inside: 0, outdated: true });
    expect(describeAreas(r)).toBe("areas: the gazetteer predates them; rebuild it");
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM sample_area_derivation`)).toEqual([[0]]);
  });

  test("finds the wilderness a point lies inside, and copies in only the areas a sample lies inside", async () => {
    const path = join(dir, "a.duckdb");
    await buildTestGazetteer(path, "build-a");
    const conn = await storeWithPerson();
    const inAlsea = await insertCleanSample(conn, {}, ALSEA);
    const outside = await insertCleanSample(conn, { sample_number: "'2'" }, REFUGE);
    expect(await deriveAreas(conn, path)).toEqual({ gazetteerBuild: "build-a", pending: 2, inside: 1, outdated: false });
    expect(await inside(conn)).toEqual([[inAlsea, "wilderness.net", "9001", "wilderness", "Alsea Wilderness"]]);
    // Ox Wilderness has nobody in it, so the store does not hold it.
    expect(await areas(conn)).toEqual([["9001", "Alsea Wilderness"]]);
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

  test("a moved point is not shown, and is tested again; an area nobody is in any more goes", async () => {
    const path = join(dir, "b.duckdb");
    await buildTestGazetteer(path, "build-b");
    const conn = await storeWithPerson();
    const id = await insertCleanSample(conn, {}, ALSEA);
    await deriveAreas(conn, path);
    await conn.run(`UPDATE sample_location SET latitude = 44.50, longitude = -123.75 WHERE sample_id = ${id}`);
    expect(await inside(conn)).toEqual([]);
    expect(await deriveAreas(conn, path)).toMatchObject({ pending: 1, inside: 1 });
    expect(await inside(conn)).toEqual([[id, "wilderness.net", "9002", "wilderness", "Ox Wilderness"]]);
    expect(await areas(conn)).toEqual([["9002", "Ox Wilderness"]]);
  });

  test("a new gazetteer build tests every sample again and brings its areas up to that build", async () => {
    const path = join(dir, "c.duckdb");
    await buildTestGazetteer(path, "build-c1");
    const conn = await storeWithPerson();
    await insertCleanSample(conn, {}, ALSEA);
    await insertCleanSample(conn, { sample_number: "'2'" }, ALSEA);
    await deriveAreas(conn, path);
    await buildTestGazetteer(path, "build-c2");
    expect(await deriveAreas(conn, path, { batchSize: 1 })).toEqual({ gazetteerBuild: "build-c2", pending: 2, inside: 2, outdated: false });
    expect(await rows(conn, `SELECT source_id, gazetteer_build FROM area`)).toEqual([["9001", "build-c2"]]);
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
    expect(await deriveAreas(conn, path, { observerUserId: 100 })).toMatchObject({ pending: 1, inside: 1 });
    expect((await inside(conn)).map(([id]) => id)).toEqual([ada]);
    expect(await deriveAreas(conn, path)).toMatchObject({ pending: 1, inside: 1 });
    expect((await inside(conn)).map(([id]) => id)).toEqual([ada, bo]);
  });
});
