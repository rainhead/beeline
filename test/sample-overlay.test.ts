import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { canonicalJson } from "../src/sync-inat.js";
import { promoteObservations } from "../src/promote-observations.js";
import { applySampleOverlay } from "../src/apply-sample-overlay.js";
import {
  parseSampleOverlay,
  readSampleOverlay,
  upsertSampleOverlay,
  type SampleOverlayRow,
} from "../src/sample-overlay.js";

/**
 * A staff locality standing over the observation's (beeline-649). The
 * fixture is test/mint-samples.test.ts's — real place ids, a place_guess off
 * the corpus — because the thing under test is what promotion does to a
 * locality it did not write, and that is only worth knowing against the
 * real follow rule.
 */

let conn: DuckDBConnection;
let overlayPath: string;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector'), ('Sam Staff')");
  await conn.run(
    `INSERT INTO inat_account (person_id, inat_user_id, login)
     SELECT entity_id, 100, 'adacollects' FROM person WHERE display_name = 'Ada Collector'`,
  );
  await conn.run(
    `INSERT INTO inat_account (person_id, inat_user_id, login)
     SELECT entity_id, 200, 'samstaff' FROM person WHERE display_name = 'Sam Staff'`,
  );
  for (const [id, name, level] of [
    [1, "United States", 0],
    [10, "Oregon", 10],
    [484, "Benton", 20],
  ] as const) {
    await conn.run(`INSERT INTO inat_place (inat_place_id, name, admin_level) VALUES (${id}, '${name}', ${level})`);
  }
  overlayPath = join(await mkdtemp(join(tmpdir(), "beeline-sample-overlay-")), "sample-overlay.csv");
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
    place_ids: [1, 10, 484],
    place_guess: "Corvallis, OR, US",
    user: { id: 100, login: "adacollects", name: "Ada Collector" },
    taxon: { id: 47604, name: "Rubus", ancestor_ids: [48460, 47126, 211194, 47604] },
    ofvs: [
      { name: "sampleId", value: "7" },
      { name: "numberOfSpecimens", value: "3" },
    ],
    ...extra,
  };
}

async function stage(o: Record<string, unknown>): Promise<void> {
  await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
  await conn.run(
    `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
     VALUES ($1, (SELECT max(entity_id) FROM sync_run), $2, $3)`,
    [Number(o.id), canonicalJson(o), `hash-${o.id}-${Math.random()}`] as never,
  );
}

const one = async (sql: string) => (await rows(conn, sql))[0];
const count = async (sql: string) => Number(((await rows(conn, sql))[0] ?? [0])[0]);

const override = (value: string, extra: Partial<SampleOverlayRow> = {}): SampleOverlayRow => ({
  sample_ref: "inat:7",
  field: "locality",
  base_value: "Corvallis",
  value,
  author: "samstaff",
  reason: "the trailhead, not the town",
  ...extra,
});

describe("the file", () => {
  test("one current row per (sample, field): a later decision replaces the earlier", async () => {
    await upsertSampleOverlay(overlayPath, [override("Bald Hill")]);
    await upsertSampleOverlay(overlayPath, [override("Fitton Green", { reason: "corrected again" })]);
    const rows = await readSampleOverlay(overlayPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sample_ref: "inat:7", value: "Fitton Green", reason: "corrected again" });
    // A place name with a comma is quoted, and reads back whole.
    await upsertSampleOverlay(overlayPath, [override("Fitton Green, upper loop")]);
    expect((await readSampleOverlay(overlayPath))[0]!.value).toBe("Fitton Green, upper loop");
    expect(await readFile(overlayPath, "utf8")).toContain('"Fitton Green, upper loop"');
  });

  test("refuses a row it cannot stand behind rather than repairing it", () => {
    const header = "sample_ref,field,base_value,value,author,reason\n";
    expect(() => parseSampleOverlay(`${header}name:Ada,locality,,Bald Hill,samstaff,\n`, "f")).toThrow(
      /not a sample reference/,
    );
    expect(() => parseSampleOverlay(`${header}inat:7,county,,Benton,samstaff,\n`, "f")).toThrow(
      /not a sample overlay field/,
    );
    expect(() => parseSampleOverlay(`${header}inat:7,locality,,"  ",samstaff,\n`, "f")).toThrow(/blank/);
    expect(() => parseSampleOverlay("wrong,header\n", "f")).toThrow(/header/);
    // A missing file is an empty overlay, never an error.
    expect(parseSampleOverlay("", "f")).toEqual([]);
  });
});

describe("a staff locality stands over the observation's", () => {
  test("the follow rule leaves an overridden sample alone, on every pass", async () => {
    await stage(obs(7));
    await promoteObservations(conn);
    expect(await one("SELECT locality FROM sample")).toEqual(["Corvallis"]);

    await upsertSampleOverlay(overlayPath, [override("Bald Hill")]);
    expect(await applySampleOverlay(conn, await readSampleOverlay(overlayPath))).toEqual({
      applied: 1,
      unresolved: [],
    });
    expect(await one("SELECT locality FROM sample")).toEqual(["Bald Hill"]);
    expect(
      await one(`SELECT o.locality, o.observed_locality, p.display_name, o.reason
                 FROM sample_locality_override o JOIN person p ON p.entity_id = o.set_by`),
    ).toEqual(["Bald Hill", "Corvallis", "Sam Staff", "the trailhead, not the town"]);

    // The nightly: unprinted, so the follow rule would otherwise write
    // 'Corvallis' straight back. With the overlay path it re-applies; without
    // it — a scratch promotion — the exclusion alone holds the value.
    await promoteObservations(conn, { sampleOverlayPath: overlayPath });
    expect(await one("SELECT locality FROM sample")).toEqual(["Bald Hill"]);
    await promoteObservations(conn);
    expect(await one("SELECT locality FROM sample")).toEqual(["Bald Hill"]);
    expect(await count("SELECT count(*) FROM sample_locality_override_stale")).toBe(0);
    expect(await count("SELECT count(*) FROM sample_locality_override_diverged")).toBe(0);
  });

  test("a rebuilt store carries the decision forward from the file alone", async () => {
    await upsertSampleOverlay(overlayPath, [override("Bald Hill")]);
    // A fresh store: nothing minted yet, and the overlay names a sample that
    // does not exist until minting runs in the same promotion.
    await stage(obs(7));
    const counts = await promoteObservations(conn, { sampleOverlayPath: overlayPath });
    expect(counts).toMatchObject({ samplesMinted: 1, overlayApplied: 1, overlayUnresolved: [] });
    expect(await one("SELECT locality FROM sample")).toEqual(["Bald Hill"]);
  });

  test("removing the override hands the sample back to the observation at once", async () => {
    await stage(obs(7));
    await upsertSampleOverlay(overlayPath, [override("Bald Hill")]);
    await promoteObservations(conn, { sampleOverlayPath: overlayPath });
    expect(await one("SELECT locality FROM sample")).toEqual(["Bald Hill"]);

    await upsertSampleOverlay(overlayPath, [override("", { reason: "the observer fixed it upstream" })]);
    const removal = await readSampleOverlay(overlayPath);
    expect(removal).toHaveLength(1);
    expect(await applySampleOverlay(conn, removal)).toMatchObject({ applied: 1 });
    expect(await count("SELECT count(*) FROM sample_locality_override")).toBe(0);
    expect(await one("SELECT locality FROM sample")).toEqual(["Corvallis"]);
  });

  test("removing it on a printed sample keeps what the label says", async () => {
    await stage(obs(7));
    await upsertSampleOverlay(overlayPath, [override("Bald Hill")]);
    await promoteObservations(conn, { sampleOverlayPath: overlayPath });
    // An imported specimen with no run is printed (schema/155).
    await conn.run("INSERT INTO specimen (sample_id, specimen_number) SELECT entity_id, 1 FROM sample");
    await applySampleOverlay(conn, [override("")]);
    expect(await one("SELECT locality FROM sample")).toEqual(["Bald Hill"]);
  });

  test("removing it on a sample whose observation has left the store keeps what it has", async () => {
    await stage(obs(7));
    await upsertSampleOverlay(overlayPath, [override("Bald Hill")]);
    await promoteObservations(conn, { sampleOverlayPath: overlayPath });
    // The follow rule joins observation_field, so a sample whose observation
    // is gone keeps its locality; the removal has to say the same, or an
    // absent observation reads as a locality of nothing.
    await conn.run("DELETE FROM observation_field WHERE inat_id = 7");
    await applySampleOverlay(conn, [override("")]);
    expect(await count("SELECT count(*) FROM sample_locality_override")).toBe(0);
    expect(await one("SELECT locality FROM sample")).toEqual(["Bald Hill"]);
  });

  test("an observation that moves to a third value is named, and the override stands", async () => {
    await stage(obs(7));
    await upsertSampleOverlay(overlayPath, [override("Bald Hill")]);
    await promoteObservations(conn, { sampleOverlayPath: overlayPath });

    await stage(obs(7, { place_guess: "Philomath, OR, US" }));
    await promoteObservations(conn, { sampleOverlayPath: overlayPath });
    expect(await one("SELECT locality FROM sample")).toEqual(["Bald Hill"]);
    expect(
      await one("SELECT override_locality, observed_locality, observation_locality FROM sample_locality_override_diverged"),
    ).toEqual(["Bald Hill", "Corvallis", "Philomath"]);

    // Converging on the override is not a disagreement.
    await stage(obs(7, { place_guess: "Bald Hill, OR, US" }));
    await promoteObservations(conn, { sampleOverlayPath: overlayPath });
    expect(await count("SELECT count(*) FROM sample_locality_override_diverged")).toBe(0);
  });

  test("a reference naming no sample, or two, is reported and applied to nobody", async () => {
    await stage(obs(7));
    await promoteObservations(conn);
    const result = await applySampleOverlay(conn, [override("Bald Hill", { sample_ref: "inat:8" })]);
    expect(result).toEqual({
      applied: 0,
      unresolved: [{ sample_ref: "inat:8", field: "locality", reason: "no sample carries observation 8" }],
    });
    expect(await one("SELECT locality FROM sample")).toEqual(["Corvallis"]);

    // Two samples on one observation — a legacy shape the store admits.
    await insertCleanSample(conn, { inat_observation_id: "7", sample_number: "'7b'" });
    const two = await applySampleOverlay(conn, [override("Bald Hill")]);
    expect(two.unresolved[0]!.reason).toBe("2 samples carry observation 7");
    expect(await count("SELECT count(*) FROM sample_locality_override")).toBe(0);
  });

  test("an author the store cannot resolve leaves set_by empty rather than guessing", async () => {
    await stage(obs(7));
    await promoteObservations(conn);
    await applySampleOverlay(conn, [override("Bald Hill", { author: "nobody-here" })]);
    expect(await one("SELECT set_by FROM sample_locality_override")).toEqual([null]);
  });
});

const point = (value: string, extra: Partial<SampleOverlayRow> = {}): SampleOverlayRow => ({
  sample_ref: "inat:7",
  field: "coordinates",
  base_value: "44.5646 -123.262 30 inat_public",
  value,
  author: "samstaff",
  reason: "GPS from the field notebook",
  ...extra,
});

const location = () =>
  one("SELECT latitude, longitude, coordinate_uncertainty_m, source FROM sample_location");

describe("staff coordinates stand over the observation's (beeline-942)", () => {
  test("the location upgrade leaves an overridden sample alone, on every pass", async () => {
    await stage(obs(7));
    await promoteObservations(conn);
    expect(await location()).toEqual([44.5646, -123.262, 30, "inat_public"]);

    await upsertSampleOverlay(overlayPath, [point("44.6 -123.3 15")]);
    expect(await applySampleOverlay(conn, await readSampleOverlay(overlayPath))).toEqual({ applied: 1, unresolved: [] });
    expect(await location()).toEqual([44.6, -123.3, 15, "staff_entry"]);
    expect(
      await one(`SELECT o.observed_latitude, o.observed_longitude, o.observed_uncertainty_m, o.observed_source, p.display_name, o.reason
                 FROM sample_location_override o JOIN person p ON p.entity_id = o.set_by`),
    ).toEqual([44.5646, -123.262, 30, "inat_public", "Sam Staff", "GPS from the field notebook"]);

    // The nightly used to put the observation's pair straight back.
    await promoteObservations(conn, { sampleOverlayPath: overlayPath });
    expect(await location()).toEqual([44.6, -123.3, 15, "staff_entry"]);
    await promoteObservations(conn);
    expect(await location()).toEqual([44.6, -123.3, 15, "staff_entry"]);
    expect(await count("SELECT count(*) FROM sample_location_override_stale")).toBe(0);
    expect(await count("SELECT count(*) FROM sample_location_override_diverged")).toBe(0);
  });

  test("an elevation read at the old point is stale, not cleared: the derive job re-reads it", async () => {
    await stage(obs(7));
    await promoteObservations(conn);
    await conn.run(`INSERT INTO elevation_source (description) VALUES ('test tile')`);
    await conn.run(`UPDATE sample_location SET elevation_m = 70, elevation_source_id = (SELECT min(entity_id) FROM elevation_source),
                    elevation_latitude = latitude, elevation_longitude = longitude`);
    await applySampleOverlay(conn, [point("44.6 -123.3 15")]);
    expect(await count("SELECT count(*) FROM sample_elevation_stale")).toBe(1);
    expect(await count("SELECT count(*) FROM sample_elevation_pending")).toBe(1);
  });

  test("removing it hands back what the row held before, source and all", async () => {
    await stage(obs(7));
    await promoteObservations(conn);
    await applySampleOverlay(conn, [point("44.6 -123.3 15")]);
    await applySampleOverlay(conn, [point("")]);
    expect(await count("SELECT count(*) FROM sample_location_override")).toBe(0);
    expect(await location()).toEqual([44.5646, -123.262, 30, "inat_public"]);
  });

  test("an obscured observation with no trust: the override is the only point, and removal takes it away again", async () => {
    // No candidate, no row — the case that cannot print and that only a
    // person can fix.
    await stage(obs(7, { geoprivacy: "obscured" }));
    await promoteObservations(conn);
    expect(await count("SELECT count(*) FROM sample_location")).toBe(0);
    await applySampleOverlay(conn, [point("44.6 -123.3 15", { base_value: "" })]);
    expect(await location()).toEqual([44.6, -123.3, 15, "staff_entry"]);
    expect(await one("SELECT observed_latitude, observed_source FROM sample_location_override")).toEqual([null, null]);
    await promoteObservations(conn, { sampleOverlayPath: overlayPath });
    expect(await location()).toEqual([44.6, -123.3, 15, "staff_entry"]);
    await applySampleOverlay(conn, [point("", { base_value: "" })]);
    expect(await count("SELECT count(*) FROM sample_location")).toBe(0);
  });

  test("removing it on a printed sample keeps the point the label carries", async () => {
    await stage(obs(7));
    await promoteObservations(conn);
    await applySampleOverlay(conn, [point("44.6 -123.3 15")]);
    await conn.run("INSERT INTO specimen (sample_id, specimen_number) SELECT entity_id, 1 FROM sample");
    await applySampleOverlay(conn, [point("")]);
    expect(await location()).toEqual([44.6, -123.3, 15, "staff_entry"]);
  });

  test("an observation that moves to a third point is named, and the override stands", async () => {
    await stage(obs(7));
    await upsertSampleOverlay(overlayPath, [point("44.6 -123.3 15")]);
    await promoteObservations(conn, { sampleOverlayPath: overlayPath });
    await stage(obs(7, { geojson: { coordinates: [-123.4, 44.7], type: "Point" } }));
    await promoteObservations(conn, { sampleOverlayPath: overlayPath });
    expect(await location()).toEqual([44.6, -123.3, 15, "staff_entry"]);
    expect(await one("SELECT observation_latitude, observation_longitude FROM sample_location_override_diverged")).toEqual([44.7, -123.4]);
    // Converging on the override is not a disagreement.
    await stage(obs(7, { geojson: { coordinates: [-123.3, 44.6], type: "Point" } }));
    await promoteObservations(conn, { sampleOverlayPath: overlayPath });
    expect(await count("SELECT count(*) FROM sample_location_override_diverged")).toBe(0);
  });

  test("the file refuses a point it cannot stand behind", () => {
    const header = "sample_ref,field,base_value,value,author,reason\n";
    expect(() => parseSampleOverlay(`${header}inat:7,coordinates,,91 -123.3,samstaff,\n`, "f")).toThrow(/not a latitude/);
    expect(() => parseSampleOverlay(`${header}inat:7,coordinates,,44.6,samstaff,\n`, "f")).toThrow(/latitude> <longitude/);
    expect(() => parseSampleOverlay(`${header}inat:7,coordinates,,44.6 -123.3 -5,samstaff,\n`, "f")).toThrow(/whole metres/);
    expect(parseSampleOverlay(`${header}inat:7,coordinates,,44.6 -123.3,samstaff,\n`, "f")).toHaveLength(1);
  });
});
