import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { canonicalJson } from "../src/sync-inat.js";
import { promoteObservations } from "../src/promote-observations.js";

let conn: DuckDBConnection;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
});

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
    obscured: false,
    user: { id: 100, login: "adacollects", name: "Ada Collector" },
    ...extra,
  };
}

/** Stage an observation as the current load, bypassing the network. */
async function stage(o: Record<string, unknown>): Promise<void> {
  await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
  await conn.run(
    `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
     VALUES ($1, (SELECT max(entity_id) FROM sync_run), $2, $3)`,
    [Number(o.id), canonicalJson(o), `hash-${o.id}`] as never,
  );
}

async function location(sampleId: number): Promise<unknown[] | undefined> {
  const [row] = await rows(
    conn,
    `SELECT source, latitude, longitude, coordinate_uncertainty_m, elevation_m
     FROM sample_location WHERE sample_id = ${sampleId}`,
  );
  return row;
}

describe("observation promotion", () => {
  test("private coordinates upgrade a legacy location to inat_trusted; moved coordinates drop the stale elevation", async () => {
    const sampleId = await insertCleanSample(
      conn,
      { inat_observation_id: "7" },
      { source: "'legacy_import'" },
    );
    await stage(
      obs(7, {
        geoprivacy: "obscured",
        private_geojson: { coordinates: [-123.01, 44.01], type: "Point" },
        positional_accuracy: 9,
        public_positional_accuracy: 26518,
        viewer_trusted_by_observer: false, // project trust: flag false, private_geojson present
      }),
    );
    const counts = await promoteObservations(conn);
    expect(counts).toMatchObject({ linkedSamples: 1, trustedLocations: 1, obscuredWithheld: 0 });
    expect(await location(sampleId)).toEqual(["inat_trusted", 44.01, -123.01, 9, null]);
    const [[geoprivacy]] = (await rows(conn, `SELECT geoprivacy FROM sample WHERE entity_id = ${sampleId}`)) as [[unknown]];
    expect(geoprivacy).toBe("obscured");
  });

  test("coordinates within the legacy 4-decimal export precision keep their derived elevation", async () => {
    // Legacy holds the iNat coordinates rounded to 4 decimals (measured on
    // the full corpus); a delta ≤ 5e-5° is the same place, so the elevation
    // derived there still applies while the coordinates gain precision.
    const sampleId = await insertCleanSample(
      conn,
      { inat_observation_id: "8" },
      { source: "'legacy_import'" },
    );
    await stage(obs(8, { private_geojson: { coordinates: [-123.26204, 44.56462], type: "Point" } }));
    await promoteObservations(conn);
    expect(await location(sampleId)).toEqual(["inat_trusted", 44.56462, -123.26204, 30, 72]);
    // The elevation keeps pointing at the coordinates it was actually read
    // at, not the sharper ones it now sits beside — the row stays honest
    // about its own provenance, and stays out of the stale set.
    expect(
      await rows(
        conn,
        `SELECT elevation_latitude FROM sample_location WHERE sample_id = ${sampleId}`,
      ),
    ).toEqual([[44.5646]]);
    expect(await rows(conn, "SELECT sample_id FROM sample_elevation_stale")).toEqual([]);
    // Observation promotion writes samples; if it ever leaves a collector
    // list headless, this is what will say so (schema/116, beeline-daa).
    expect(await rows(conn, "SELECT sample_id FROM sample_primary_collector_invalid")).toEqual([]);
  });

  test("an open observation upgrades to inat_public and clears stale flags; taxon_geoprivacy 'open' means unobscured", async () => {
    const sampleId = await insertCleanSample(
      conn,
      { inat_observation_id: "9", geoprivacy: "'obscured'" },
      { source: "'legacy_import'" },
    );
    await stage(obs(9, { taxon_geoprivacy: "open" }));
    const counts = await promoteObservations(conn);
    expect(counts).toMatchObject({ publicLocations: 1 });
    expect(await location(sampleId)).toEqual(["inat_public", 44.5646, -123.262, 30, 72]);
    const [[geo, taxonGeo]] = (await rows(
      conn,
      `SELECT geoprivacy, taxon_geoprivacy FROM sample WHERE entity_id = ${sampleId}`,
    )) as [[unknown, unknown]];
    expect([geo, taxonGeo]).toEqual([null, null]);
  });

  test("obscured without private coordinates writes no location: legacy rows stay, absent stays absent", async () => {
    const kept = await insertCleanSample(
      conn,
      { inat_observation_id: "10", sample_number: "'10'" },
      { source: "'legacy_import'" },
    );
    const bare = await insertCleanSample(
      conn,
      { inat_observation_id: "11", sample_number: "'11'" },
      null,
    );
    await stage(obs(10, { geoprivacy: "obscured", public_positional_accuracy: 26518 }));
    await stage(obs(11, { geoprivacy: "obscured", public_positional_accuracy: 26518 }));
    const counts = await promoteObservations(conn);
    expect(counts).toMatchObject({ obscuredWithheld: 2, trustedLocations: 0, publicLocations: 0 });
    expect(await location(kept)).toEqual(["legacy_import", 44.5646, -123.262, 30, 72]);
    expect(await location(bare)).toBeUndefined();
    const findings = await rows(
      conn,
      `SELECT sample_id FROM qc_finding WHERE rule_name = 'obscured_no_true_coordinates'`,
    );
    expect(findings).toEqual([[bare]]);
  });

  test("observer of a linked observation becomes the collector's iNat account; ambiguity is refused and counted", async () => {
    await conn.run("INSERT INTO person (display_name) VALUES ('Bo Splitter')");
    await insertCleanSample(conn, { inat_observation_id: "20" }, null);
    // Bo's two samples evidence observations by two different iNat users.
    const bo = "(SELECT entity_id FROM person WHERE display_name = 'Bo Splitter')";
    await insertCleanSample(
      conn,
      { inat_observation_id: "21", collector_id: bo, sample_number: "'2'" },
      null,
    );
    await insertCleanSample(
      conn,
      { inat_observation_id: "22", collector_id: bo, sample_number: "'3'" },
      null,
    );
    await stage(obs(20));
    await stage(obs(21, { user: { id: 200, login: "bo-one", name: "Bo" } }));
    await stage(obs(22, { user: { id: 201, login: "bo-two", name: "Bo" } }));
    const counts = await promoteObservations(conn);
    expect(counts).toMatchObject({ accountsLinked: 1, accountConflicts: 2 });
    const accounts = await rows(
      conn,
      `SELECT p.display_name, a.inat_user_id, a.login
       FROM inat_account a JOIN person p ON p.entity_id = a.person_id`,
    );
    expect(accounts).toEqual([["Ada Collector", 100n, "adacollects"]]);
  });

  test("a changed login refreshes the cache under the stable user id", async () => {
    await insertCleanSample(conn, { inat_observation_id: "30" }, null);
    await conn.run(
      `INSERT INTO inat_account (person_id, inat_user_id, login)
       VALUES ((SELECT min(entity_id) FROM person), 100, 'old-login')`,
    );
    await stage(obs(30));
    const counts = await promoteObservations(conn);
    expect(counts).toMatchObject({ accountsLinked: 0, accountConflicts: 0 });
    const [[login]] = (await rows(conn, "SELECT login FROM inat_account")) as [[unknown]];
    expect(login).toBe("adacollects");
  });

  test("promotion is idempotent", async () => {
    const sampleId = await insertCleanSample(
      conn,
      { inat_observation_id: "40" },
      { source: "'legacy_import'" },
    );
    await stage(obs(40, { private_geojson: { coordinates: [-123.01, 44.01], type: "Point" } }));
    const first = await promoteObservations(conn);
    const second = await promoteObservations(conn);
    expect(first).toMatchObject({ trustedLocations: 1, accountsLinked: 1 });
    expect(second).toMatchObject({ trustedLocations: 1, accountsLinked: 0, accountConflicts: 0 });
    expect(await location(sampleId)).toEqual(["inat_trusted", 44.01, -123.01, 30, null]);
    const [[locations, accounts]] = (await rows(
      conn,
      "SELECT (SELECT count(*) FROM sample_location), (SELECT count(*) FROM inat_account)",
    )) as [[unknown, unknown]];
    expect([locations, accounts]).toEqual([1n, 1n]);
  });

  test("promotion leaves no elevation describing a point the sample has moved away from", async () => {
    // The invariant, over every sample the whole suite has promoted by now:
    // whatever route a coordinate took, no row is left asserting an elevation
    // for somewhere it was never measured (beeline-x5c). This is the check
    // that survives a write path nobody remembered to teach.
    expect(await rows(conn, "SELECT sample_id FROM sample_elevation_stale")).toEqual([]);
  });
});
