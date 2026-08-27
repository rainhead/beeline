// Smoke test for the intended app toolchain: Kysely + kysely-duckdb on
// @duckdb/node-api (roadmap phase 1: prove it while switching is cheap).
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Kysely } from "kysely";
import { createMemoryDb } from "./helpers.js";
import { createKysely } from "../src/db.js";
import type { Database } from "../src/model.js";

let db: Kysely<Database>;
let sampleId: number;

beforeAll(async () => {
  const { instance, conn } = await createMemoryDb();
  conn.closeSync(); // schema applied; hand the instance to Kysely
  db = createKysely(instance);
});

afterAll(async () => {
  await db.destroy();
});

test("insert returning generated ids", async () => {
  const person = await db
    .insertInto("person")
    .values({ display_name: "Ada Collector" })
    .returning("entity_id")
    .executeTakeFirstOrThrow();

  const sample = await db
    .insertInto("sample")
    .values({
      kind: "net",
      collector_id: person.entity_id,
      sample_number: "1",
      date_start: "2026-07-14",
      date_end: "2026-07-14",
      specimen_count: 2,
      country: "USA",
      state_province: "OR",
      county: "BentonCo",
      locality: "Corvallis",
      protocol: "net",
    })
    .returning("entity_id")
    .executeTakeFirstOrThrow();
  expect(sample.entity_id).toBeGreaterThan(person.entity_id); // one global entity sequence
  sampleId = sample.entity_id;

  const dem = await db
    .insertInto("elevation_source")
    .values({ description: "SRTM 1-arc-second", file_name: "N44_W124_1arc_v3.tif", file_hash: "deadbeef" })
    .returning("entity_id")
    .executeTakeFirstOrThrow();

  await db
    .insertInto("sample_location")
    .values({
      sample_id: sample.entity_id,
      latitude: 44.5646,
      longitude: -123.262,
      coordinate_uncertainty_m: 30,
      elevation_m: 72,
      elevation_source_id: dem.entity_id,
      elevation_latitude: 44.5646,
      elevation_longitude: -123.262,
      source: "inat_public",
    })
    .execute();
});

test("typed joins over tables", async () => {
  const row = await db
    .selectFrom("sample")
    .innerJoin("person", "person.entity_id", "sample.collector_id")
    .select(["sample.sample_number", "person.display_name", "sample.locality"])
    .executeTakeFirstOrThrow();
  expect(row).toEqual({ sample_number: "1", display_name: "Ada Collector", locality: "Corvallis" });
});

test("views are queryable through Kysely", async () => {
  const printable = await db.selectFrom("printable_sample").selectAll().execute();
  expect(printable).toEqual([{ sample_id: sampleId }]);

  const findings = await db.selectFrom("qc_finding").selectAll().execute();
  expect(findings).toEqual([]);
});
