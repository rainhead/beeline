import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, FIXTURE_INPUTS, rows } from "./helpers.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";

/**
 * The legacy shape beeline-0199 is about: records from two observations that
 * legacy promotion used to merge into one sample. Synthetic on the shared
 * fixture — Ada's sample 1 has records 25000001 and 25000009 citing
 * observation 250000001 and 25000003 citing none; here 25000003 is given an
 * observation of its own, as the sandbox's merged samples have (Fanny Bay
 * and Lundbom Grassland under one number), and the junk row a taxon page,
 * which names no observation.
 */
const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;

let conn: DuckDBConnection;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await loadLegacyStaging(conn, FIXTURE);
  await conn.run(`UPDATE legacy_occurrence SET url = 'https://www.inaturalist.org/observations/250000003' WHERE "fieldNumber" = '25000003'`);
  await conn.run(`UPDATE legacy_occurrence SET url = 'https://www.inaturalist.org/taxa/47604' WHERE "fieldNumber" = '25000002'`);
  await promoteLegacy(conn, FIXTURE_INPUTS);
});

describe("a legacy sample several observations claim", () => {
  test("is split, one sample per observation, each with its own specimens", async () => {
    // Peter, 2026-10-04 (beeline-0199): one observation is one sample.
    expect(await rows(conn, `
      SELECT s.sample_number, s.inat_observation_id, string_agg(sp.field_number, ' ' ORDER BY sp.field_number), s.specimen_count
      FROM sample s JOIN specimen sp ON sp.sample_id = s.entity_id
      WHERE s.sample_number = '1'
      GROUP BY s.entity_id, s.sample_number, s.inat_observation_id, s.specimen_count ORDER BY 2`)).toEqual([
      ["1", 250000001n, "25000001 25000009", 2],
      ["1", 250000003n, "25000003", 1],
    ]);
  });

  test("records the one observation each came from, and none for a taxon page", async () => {
    expect(await rows(conn, `
      SELECT s.inat_observation_id, o.inat_observation_id FROM sample_legacy_observation o
      JOIN sample s ON s.entity_id = o.sample_id ORDER BY 1`)).toEqual([
      [250000001n, 250000001n],
      [250000003n, 250000003n],
    ]);
  });

  test("its pins carry the number for good, so it is named and flagged nowhere", async () => {
    expect(await rows(conn, `
      SELECT f.rule_name FROM qc_finding f JOIN sample s ON s.entity_id = f.sample_id
      WHERE s.sample_number = '1' AND f.rule_name = 'duplicate_sample_number'`)).toEqual([]);
    expect(await rows(conn, `
      SELECT c.details FROM sample_number_conflict c JOIN sample s ON s.entity_id = c.sample_id
      WHERE s.sample_number = '1'`)).toEqual([
      [expect.stringContaining("sample number 1 used 2 times")],
      [expect.stringContaining("sample number 1 used 2 times")],
    ]);
  });
});
