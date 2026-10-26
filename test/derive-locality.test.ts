import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveLocalities } from "../src/derive-locality.js";
import { buildTestGazetteer, createMemoryDb, insertCleanSample, rows } from "./helpers.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "beeline-gazetteer-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function storeWithPerson(): Promise<DuckDBConnection> {
  const { conn } = await createMemoryDb();
  await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Adams'), ('Bo Brown')`);
  return conn;
}

const suggestions = (conn: DuckDBConnection) =>
  rows(conn, `SELECT sample_id, locality, basis FROM sample_locality_suggestion_current ORDER BY sample_id`);

describe("deriveLocalities", () => {
  test("without a gazetteer there is nothing to do, and it says so", async () => {
    const conn = await storeWithPerson();
    await insertCleanSample(conn);
    const r = await deriveLocalities(conn, join(dir, "absent.duckdb"));
    expect(r).toMatchObject({ gazetteerBuild: null, pending: 0, named: 0 });
    expect(await suggestions(conn)).toEqual([]);
  });

  test("names each sample from its point, and records the point and the build", async () => {
    const path = join(dir, "a.duckdb");
    await buildTestGazetteer(path, "build-a");
    const conn = await storeWithPerson();
    const inRefuge = await insertCleanSample(conn, {}, { latitude: "44.41", longitude: "-123.30" });
    const nearTown = await insertCleanSample(conn, { sample_number: "'2'" }, { latitude: "44.55", longitude: "-123.38" });
    const r = await deriveLocalities(conn, path);
    expect(r).toMatchObject({ gazetteerBuild: "build-a", pending: 2, named: 2, unnamed: 0 });
    expect(await suggestions(conn)).toEqual([
      [inRefuge, "Finley NWR", "refuge"],
      [nearTown, "Philomath", "town"],
    ]);
    const [[lat, lon, build]] = (await rows(
      conn,
      `SELECT latitude, longitude, gazetteer_build FROM sample_locality_suggestion WHERE sample_id = ${inRefuge}`,
    )) as [[number, number, string]];
    expect([lat, lon, build]).toEqual([44.41, -123.3, "build-a"]);
    // The sample's own locality is never touched: this is only a suggestion.
    expect(await rows(conn, `SELECT DISTINCT locality FROM sample`)).toEqual([["Corvallis"]]);
    // A second run has nothing left to name.
    expect((await deriveLocalities(conn, path)).pending).toBe(0);
  });

  test("a moved point is not shown, and is named again; so is every sample after a new build", async () => {
    const path = join(dir, "b.duckdb");
    await buildTestGazetteer(path, "build-b1");
    const conn = await storeWithPerson();
    const id = await insertCleanSample(conn, {}, { latitude: "44.41", longitude: "-123.30" });
    await deriveLocalities(conn, path);
    await conn.run(`UPDATE sample_location SET latitude = 44.55, longitude = -123.38 WHERE sample_id = ${id}`);
    expect(await suggestions(conn)).toEqual([]);
    expect(await deriveLocalities(conn, path)).toMatchObject({ pending: 1, named: 1 });
    expect(await suggestions(conn)).toEqual([[id, "Philomath", "town"]]);
    await buildTestGazetteer(path, "build-b2");
    expect(await deriveLocalities(conn, path)).toMatchObject({ gazetteerBuild: "build-b2", pending: 1, named: 1 });
  });

  test("never names a sample for the wilderness it is inside (Peter, 2026-10-26)", async () => {
    const path = join(dir, "w.duckdb");
    await buildTestGazetteer(path, "build-w");
    const conn = await storeWithPerson();
    const id = await insertCleanSample(conn, {}, { latitude: "44.50", longitude: "-123.60" });
    await deriveLocalities(conn, path);
    const [[, locality]] = (await suggestions(conn)) as [[number, string, string]];
    expect(locality).not.toContain("Wilderness");
    expect(id).toBeGreaterThan(0);
  });

  test("named for one observer, it leaves everyone else's samples for the nightly", async () => {
    const path = join(dir, "d.duckdb");
    await buildTestGazetteer(path, "build-d");
    const conn = await storeWithPerson();
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login)
                    SELECT entity_id, 100, 'ada' FROM person WHERE display_name = 'Ada Adams'`);
    const ada = await insertCleanSample(conn, { collector_id: "(SELECT min(entity_id) FROM person)" });
    const bo = await insertCleanSample(conn, { collector_id: "(SELECT max(entity_id) FROM person)", sample_number: "'2'" });
    expect(await deriveLocalities(conn, path, { observerUserId: 100 })).toMatchObject({ pending: 1, named: 1 });
    expect((await suggestions(conn)).map(([id]) => id)).toEqual([ada]);
    expect(await deriveLocalities(conn, path)).toMatchObject({ pending: 1, named: 1 });
    expect((await suggestions(conn)).map(([id]) => id)).toEqual([ada, bo]);
  });

  test("a feature whose name volunteers wrote nearby names the samples near it", async () => {
    const path = join(dir, "c.duckdb");
    await buildTestGazetteer(path, "build-c");
    const conn = await storeWithPerson();
    // Two collectors have written the lake's name for samples beside it.
    await insertCleanSample(conn, { locality: "'Marys Peak Lake'" }, { latitude: "44.701", longitude: "-123.601" });
    await insertCleanSample(
      conn,
      { locality: "'Marys Peak Lake'", sample_number: "'2'", collector_id: "(SELECT max(entity_id) FROM person)" },
      { latitude: "44.699", longitude: "-123.599" },
    );
    // A third sample 3 km away, whose collector wrote a town.
    const away = await insertCleanSample(conn, { sample_number: "'3'" }, { latitude: "44.727", longitude: "-123.600" });
    await deriveLocalities(conn, path);
    expect((await suggestions(conn)).find(([sampleId]) => sampleId === away)).toEqual([away, "Marys Peak Lake", "feature"]);
  });
});
