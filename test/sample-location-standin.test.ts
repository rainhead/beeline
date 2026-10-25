// The stand-in rule at its edges (sample_location_standin, schema/106,
// beeline-b34): the 100 m line, taxon-only obscuring, a staff override, a
// rebuild, and the two cases it deliberately leaves alone or takes. Written by
// Fable's review of the change. None of the coordinates come from a real store.
import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, insertCleanSample, currentSeasonDate, rows } from "./helpers.js";
import { canonicalJson } from "../src/sync-inat.js";
import { promoteObservations } from "../src/promote-observations.js";

let conn: DuckDBConnection;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
});

// The fixture's sample sits at 44.5646, -123.262 (test/helpers.ts). One degree
// of latitude is about 111 km, so 0.00135° is ~150 m and 0.00045° is ~50 m.
const HERE = { lat: 44.5646, lon: -123.262 };
const point = (dLat: number, dLon = 0) => ({ coordinates: [HERE.lon + dLon, HERE.lat + dLat], type: "Point" });

function obs(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    uuid: `uuid-${id}`,
    observed_on: currentSeasonDate(7, 14),
    geojson: point(0),
    positional_accuracy: 30,
    public_positional_accuracy: 30,
    geoprivacy: null,
    taxon_geoprivacy: null,
    obscured: false,
    user: { id: 100, login: "adacollects", name: "Ada Collector" },
    ...extra,
  };
}

async function stage(o: Record<string, unknown>): Promise<void> {
  await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
  await conn.run(
    `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
     VALUES ($1, (SELECT max(entity_id) FROM sync_run), $2, $3)`,
    [Number(o.id), canonicalJson(o), `hash-${o.id}-${Date.now()}-${Math.random()}`] as never,
  );
}

async function location(sampleId: number): Promise<unknown[] | undefined> {
  const [row] = await rows(
    conn,
    `SELECT source, round(latitude, 5), round(longitude, 5), coordinate_uncertainty_m, elevation_m
     FROM sample_location WHERE sample_id = ${sampleId}`,
  );
  return row;
}

/** An imported, printed sample at the fixture point, linked to observation `obsId`. */
async function printedLegacySample(obsId: number, number = "1"): Promise<number> {
  const id = await insertCleanSample(
    conn,
    { inat_observation_id: String(obsId), sample_number: `'${number}'` },
    { source: "'legacy_import'" },
  );
  await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${id}, 1, '2500000${obsId}')`);
  return id;
}

describe("sample_location_standin at its edges", () => {
  test("the 100 m line: an imported point 150 m from the true one is taken, 50 m away is kept", async () => {
    // Intended. 150 m cannot be told from a stand-in and Arthur's rule takes
    // it; 50 m is within the old system's rounding and a moved pin, and stays.
    const far = await printedLegacySample(7, "1");
    const near = await printedLegacySample(8, "2");
    const hidden = { geoprivacy: "obscured", positional_accuracy: 9 };
    await stage(obs(7, { ...hidden, private_geojson: point(0.00135) }));
    await stage(obs(8, { ...hidden, private_geojson: point(0.00045) }));
    const counts = await promoteObservations(conn);
    expect(counts.standinsCorrected).toBe(1);
    expect(await location(far)).toEqual(["inat_trusted", 44.56595, -123.262, 9, null]);
    expect(await location(near)).toEqual(["legacy_import", 44.5646, -123.262, 30, 72]);
  });

  test("an observation hidden only by its taxon is corrected like one the observer hid", async () => {
    // Intended: taxon_geoprivacy counts as obscured, and most of the real
    // stand-ins are taxon-obscured records.
    const id = await printedLegacySample(7);
    await stage(obs(7, { taxon_geoprivacy: "obscured", positional_accuracy: 9, private_geojson: point(0.1) }));
    expect((await promoteObservations(conn)).standinsCorrected).toBe(1);
    expect((await location(id))?.[0]).toBe("inat_trusted");
  });

  test("a stand-in on an observation that has since been opened is kept, and nothing names it", async () => {
    // The old system printed a stand-in while the observation was obscured;
    // the observer (or a lifted taxon rule) has since opened it, so iNaturalist
    // now publishes the true point openly. The rule requires "obscured now",
    // so the 10 km stand-in stays, with source legacy_import. schema/106
    // accepts this to protect a moved pin on an open observation; how many
    // such samples there are, and what to do about them, is beeline-k8ul's
    // follow-up.
    const id = await printedLegacySample(7);
    await stage(obs(7, { geojson: point(0.1), positional_accuracy: 9 }));
    expect((await promoteObservations(conn)).standinsCorrected).toBe(0);
    expect(await location(id)).toEqual(["legacy_import", 44.5646, -123.262, 30, 72]);
    expect(await rows(conn, "SELECT sample_id FROM sample_location_standin")).toEqual([]);
  });

  test("a staff coordinate override on a stand-in is neither counted nor overwritten; removing it lets the next pass correct", async () => {
    // CodeRabbit's declined finding, checked: an override's sample_location
    // row carries source staff_entry (src/apply-sample-overlay.ts writes both
    // in one go), so it is never in the view and standinsCorrected is 0.
    const id = await printedLegacySample(7);
    await stage(obs(7, { geoprivacy: "obscured", positional_accuracy: 9, private_geojson: point(0.1) }));
    // What applySampleOverlay writes for a staff point: the override row with
    // the stand-in as its merge base, and the location row as staff_entry.
    await conn.run(
      `INSERT INTO sample_location_override (sample_id, latitude, longitude, coordinate_uncertainty_m,
         observed_latitude, observed_longitude, observed_uncertainty_m, observed_source, set_by, reason)
       VALUES (${id}, 44.6, -123.3, 5, 44.5646, -123.262, 30, 'legacy_import', NULL, 'review')`,
    );
    await conn.run(
      `UPDATE sample_location SET latitude = 44.6, longitude = -123.3, coordinate_uncertainty_m = 5, source = 'staff_entry'
       WHERE sample_id = ${id}`,
    );
    expect((await promoteObservations(conn)).standinsCorrected).toBe(0);
    expect(await location(id)).toEqual(["staff_entry", 44.6, -123.3, 5, null]);
    expect(await rows(conn, "SELECT sample_id FROM sample_location_override_stale")).toEqual([]);

    // Removal, as the applier does it: the override goes and the merge base
    // comes back — the stand-in, as legacy_import. The next pass corrects it.
    await conn.run(`DELETE FROM sample_location_override WHERE sample_id = ${id}`);
    await conn.run(
      `UPDATE sample_location SET latitude = 44.5646, longitude = -123.262, coordinate_uncertainty_m = 30, source = 'legacy_import'
       WHERE sample_id = ${id}`,
    );
    expect((await promoteObservations(conn)).standinsCorrected).toBe(1);
    expect(await location(id)).toEqual(["inat_trusted", 44.6646, -123.262, 9, null]);
  });

  test("a rebuild converges: the stand-in re-imported over a corrected sample is corrected again, and a third pass does nothing", async () => {
    // Legacy promotion on a rebuilt or reseeded store inserts the stand-in
    // afresh with its legacy elevation; observation promotion must reach the
    // same end state every time, and the view must be empty after it.
    const id = await printedLegacySample(7);
    await stage(obs(7, { geoprivacy: "obscured", positional_accuracy: 9, private_geojson: point(0.1) }));
    expect((await promoteObservations(conn)).standinsCorrected).toBe(1);
    const corrected = await location(id);
    // What legacy promotion writes (ingest/promote-legacy.sql, Locations).
    await conn.run(
      `UPDATE sample_location SET latitude = 44.5646, longitude = -123.262, coordinate_uncertainty_m = 30,
         source = 'legacy_import', elevation_m = 72, elevation_source_id = (SELECT min(entity_id) FROM elevation_source),
         elevation_latitude = 44.5646, elevation_longitude = -123.262
       WHERE sample_id = ${id}`,
    );
    expect((await promoteObservations(conn)).standinsCorrected).toBe(1);
    expect(await location(id)).toEqual(corrected);
    expect((await promoteObservations(conn)).standinsCorrected).toBe(0);
    expect(await rows(conn, "SELECT sample_id FROM sample_location_standin")).toEqual([]);
    expect(await rows(conn, "SELECT sample_id FROM sample_elevation_stale")).toEqual([]);
  });

  test("a true imported point that the observer later moves 150 m on an obscured observation is replaced too", async () => {
    // Accepted by schema/106 ("cannot be told from a stand-in"), pinned here
    // so the asymmetry with the open-observation case above is visible: on an
    // open observation the label wins; on an obscured one the observation does.
    const id = await printedLegacySample(7);
    await stage(obs(7, { geoprivacy: "obscured", positional_accuracy: 9, private_geojson: point(0) }));
    expect((await promoteObservations(conn)).standinsCorrected).toBe(0);
    await stage(obs(7, { geoprivacy: "obscured", positional_accuracy: 9, private_geojson: point(0.00135) }));
    expect((await promoteObservations(conn)).standinsCorrected).toBe(1);
    expect((await location(id))?.[0]).toBe("inat_trusted");
  });
});
