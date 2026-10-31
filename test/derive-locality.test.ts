import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveLocalities, localityCandidatesAt } from "../src/derive-locality.js";
import { LOCALITY_RULE_VERSION } from "../src/locality-rule.js";
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

// The best name for each sample: what the pages call the suggestion.
const suggestions = (conn: DuckDBConnection) =>
  rows(conn, `SELECT sample_id, locality, basis FROM sample_locality_suggestion_current ORDER BY sample_id`);

// Every name offered for one sample, best first.
const candidates = (conn: DuckDBConnection, sampleId: number) =>
  rows(conn, `SELECT locality, basis FROM sample_locality_candidate_current WHERE sample_id = ${sampleId} ORDER BY rank`);

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
      `SELECT latitude, longitude, gazetteer_build FROM sample_locality_candidate WHERE sample_id = ${inRefuge} AND rank = 1`,
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

  test("a sample named by an older version of the rule is named again (beeline-75z3)", async () => {
    const path = join(dir, "b2.duckdb");
    await buildTestGazetteer(path, "build-b3");
    const conn = await storeWithPerson();
    await insertCleanSample(conn, {}, { latitude: "44.55", longitude: "-123.38" });
    await deriveLocalities(conn, path);
    expect(await deriveLocalities(conn, path)).toMatchObject({ pending: 0 });
    await conn.run(`UPDATE sample_locality_candidate SET rule_version = ${LOCALITY_RULE_VERSION - 1}`);
    expect(await deriveLocalities(conn, path)).toMatchObject({ pending: 1, named: 1 });
    expect(await rows(conn, `SELECT DISTINCT rule_version FROM sample_locality_candidate`)).toEqual([[LOCALITY_RULE_VERSION]]);
  });

  test("never names a sample for the wilderness it is inside (Peter, 2026-10-26)", async () => {
    const path = join(dir, "w.duckdb");
    await buildTestGazetteer(path, "build-w");
    const conn = await storeWithPerson();
    // One inside "Alsea Wilderness", one inside "Ox Wilderness Area": both
    // short enough to be named, were they not left out.
    await insertCleanSample(conn, {}, { latitude: "44.50", longitude: "-123.60" });
    await insertCleanSample(conn, { sample_number: "'2'" }, { latitude: "44.50", longitude: "-123.75" });
    await deriveLocalities(conn, path);
    const named = (await suggestions(conn)) as Array<[number, string, string]>;
    expect(named).toHaveLength(2);
    for (const [, locality] of named) expect(locality).not.toContain("Wilderness");
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

  test("offers the best name and up to three more, none repeated", async () => {
    const path = join(dir, "e.duckdb");
    await buildTestGazetteer(path, "build-e");
    const conn = await storeWithPerson();
    const id = await insertCleanSample(conn, {}, { latitude: "44.41", longitude: "-123.30" });
    await deriveLocalities(conn, path);
    const offered = (await candidates(conn, id)) as Array<[string, string]>;
    expect(offered[0]).toEqual(["Finley NWR", "refuge"]);
    expect(offered.length).toBeGreaterThan(1);
    expect(offered.length).toBeLessThanOrEqual(4);
    expect(new Set(offered.map(([l]) => l)).size).toBe(offered.length);
  });

  test("the name the collector already used nearby comes first, then other people's, then the gazetteer's (Peter, 2026-10-30)", async () => {
    const path = join(dir, "f.duckdb");
    await buildTestGazetteer(path, "build-f");
    const conn = await storeWithPerson();
    const ada = "(SELECT min(entity_id) FROM person)";
    const bo = "(SELECT max(entity_id) FROM person)";
    // Ada named her site, 300 m from the new sample; Bo, collecting 500 m
    // away, wrote another name twice.
    await insertCleanSample(conn, { locality: "'Wren Meadow'", collector_id: ada }, { latitude: "44.553", longitude: "-123.38" });
    await insertCleanSample(conn, { locality: "'Philomath Ridge'", sample_number: "'2'", collector_id: bo }, { latitude: "44.5545", longitude: "-123.38" });
    await insertCleanSample(conn, { locality: "'Philomath Ridge'", sample_number: "'3'", collector_id: bo }, { latitude: "44.5546", longitude: "-123.38" });
    const fresh = await insertCleanSample(conn, { sample_number: "'4'", collector_id: ada }, { latitude: "44.55", longitude: "-123.38" });
    await deriveLocalities(conn, path);
    expect(await candidates(conn, fresh)).toEqual([
      ["Wren Meadow", "used_own"],
      ["Philomath Ridge", "used"],
      ["Philomath", "town"],
      ["Alsea", "town"],
    ]);
  });

  test("a name used more than a kilometre away, or one that will not fit a label, is not offered", async () => {
    const path = join(dir, "g.duckdb");
    await buildTestGazetteer(path, "build-g");
    const conn = await storeWithPerson();
    await insertCleanSample(conn, { locality: "'Far Meadow'" }, { latitude: "44.565", longitude: "-123.38" });
    await insertCleanSample(conn, { locality: "'1200 NW Hilltop Road'", sample_number: "'2'" }, { latitude: "44.5501", longitude: "-123.38" });
    const fresh = await insertCleanSample(conn, { sample_number: "'3'" }, { latitude: "44.55", longitude: "-123.38" });
    await deriveLocalities(conn, path);
    const offered = ((await candidates(conn, fresh)) as Array<[string, string]>).map(([l]) => l);
    expect(offered).not.toContain("Far Meadow");
    expect(offered).not.toContain("1200 NW Hilltop Road");
    expect(offered[0]).toBe("Philomath");
  });

  test("a name written one letter off a place nearby is offered in the place's spelling, and counts with it (beeline-5j10)", async () => {
    const path = join(dir, "s1.duckdb");
    await buildTestGazetteer(path, "build-s1");
    const conn = await storeWithPerson();
    // Two people wrote the town's name; one of them misspelt it.
    await insertCleanSample(conn, { locality: "'Philamath'" }, { latitude: "44.5501", longitude: "-123.38" });
    await insertCleanSample(conn, { locality: "'Philomath'", sample_number: "'2'" }, { latitude: "44.5502", longitude: "-123.38" });
    const fresh = await insertCleanSample(conn, { sample_number: "'3'" }, { latitude: "44.55", longitude: "-123.38" });
    await deriveLocalities(conn, path);
    const offered = ((await candidates(conn, fresh)) as Array<[string, string]>).map(([l]) => l);
    expect(offered[0]).toBe("Philomath");
    expect(offered).not.toContain("Philamath");
    // And for a point no sample has yet, as trap entry asks.
    const at = await localityCandidatesAt(conn, path, { latitude: 44.55, longitude: -123.38 }, []);
    expect(at!.candidates.map((c) => c.locality)).not.toContain("Philamath");
  });

  test("a plural, or a space taken out, is not taken for a misspelling (beeline-5j10)", async () => {
    const path = join(dir, "s2.duckdb");
    await buildTestGazetteer(path, "build-s2");
    const conn = await storeWithPerson();
    await insertCleanSample(conn, { locality: "'Philomaths'" }, { latitude: "44.5501", longitude: "-123.38" });
    await insertCleanSample(conn, { locality: "'Philo math'", sample_number: "'2'" }, { latitude: "44.5502", longitude: "-123.38" });
    const fresh = await insertCleanSample(conn, { sample_number: "'3'" }, { latitude: "44.55", longitude: "-123.38" });
    await deriveLocalities(conn, path);
    const offered = ((await candidates(conn, fresh)) as Array<[string, string]>).map(([l]) => l);
    expect(offered).toContain("Philomaths");
    expect(offered).toContain("Philo math");
  });

  test("a name used nearby that is only the county the point is in is not offered", async () => {
    const path = join(dir, "g2.duckdb");
    await buildTestGazetteer(path, "build-g2");
    const conn = await storeWithPerson();
    // The test gazetteer's one region is Benton County.
    await insertCleanSample(conn, { locality: "'Benton Co.'" }, { latitude: "44.5501", longitude: "-123.38" });
    const fresh = await insertCleanSample(conn, { sample_number: "'2'" }, { latitude: "44.55", longitude: "-123.38" });
    await deriveLocalities(conn, path);
    const offered = ((await candidates(conn, fresh)) as Array<[string, string]>).map(([l]) => l);
    expect(offered).not.toContain("Benton Co.");
    expect(offered[0]).toBe("Philomath");
  });

  test("a campground beside the point names it, shortened to fit (beeline-4hxe)", async () => {
    const path = join(dir, "h.duckdb");
    await buildTestGazetteer(path, "build-h");
    const conn = await storeWithPerson();
    const beside = await insertCleanSample(conn, {}, { latitude: "44.331", longitude: "-123.49" });
    const nearby = await insertCleanSample(conn, { sample_number: "'2'" }, { latitude: "44.34", longitude: "-123.49" });
    await deriveLocalities(conn, path);
    expect((await candidates(conn, beside))[0]).toEqual(["Alsea Falls CG", "campground"]);
    // A kilometre off it is not the name, but it is offered.
    const offered = (await candidates(conn, nearby)) as Array<[string, string]>;
    expect(offered[0]![0]).not.toBe("Alsea Falls CG");
    expect(offered).toContainEqual(["Alsea Falls CG", "campground"]);
  });

  test("a point no sample has yet is named the same way, these people's names counting as their own", async () => {
    const path = join(dir, "i.duckdb");
    await buildTestGazetteer(path, "build-i");
    const conn = await storeWithPerson();
    await insertCleanSample(conn, { locality: "'Wren Meadow'" }, { latitude: "44.553", longitude: "-123.38" });
    const [[ada]] = (await rows(conn, `SELECT min(entity_id) FROM person`)) as [[number]];
    const [[bo]] = (await rows(conn, `SELECT max(entity_id) FROM person`)) as [[number]];
    const forAda = await localityCandidatesAt(conn, path, { latitude: 44.55, longitude: -123.38 }, [ada]);
    expect(forAda).toMatchObject({ gazetteerBuild: "build-i" });
    expect(forAda!.candidates[0]).toEqual({ locality: "Wren Meadow", basis: "used_own" });
    const forBo = await localityCandidatesAt(conn, path, { latitude: 44.55, longitude: -123.38 }, [bo]);
    expect(forBo!.candidates[0]).toEqual({ locality: "Wren Meadow", basis: "used" });
    expect(await localityCandidatesAt(conn, join(dir, "absent.duckdb"), { latitude: 44.55, longitude: -123.38 }, [ada])).toBeNull();
    // Nothing was written: the point is not a sample.
    expect(await rows(conn, `SELECT count(*) FROM sample_locality_candidate`)).toEqual([[0n]]);
  });
});
