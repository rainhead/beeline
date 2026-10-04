import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, FIXTURE_INPUTS, rows } from "./helpers.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";

/**
 * The legacy shape beeline-0199 is about: records from two observations
 * merged into one sample by legacy promotion. Synthetic on the shared
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
  test("promotion records each observation its records came from, and none for a taxon page", async () => {
    expect(await rows(conn, `
      SELECT s.sample_number, o.inat_observation_id FROM sample_legacy_observation o
      JOIN sample s ON s.entity_id = o.sample_id ORDER BY 1, 2`)).toEqual([
      ["1", 250000001n],
      ["1", 250000003n],
    ]);
  });

  test("it is printed, so it is for staff and not the volunteer", async () => {
    expect(await rows(conn, `
      SELECT f.rule_name, f.details FROM qc_finding f JOIN sample s ON s.entity_id = f.sample_id
      WHERE s.sample_number = '1' AND f.rule_name LIKE '%sample_number%'`)).toEqual([
      ["shared_sample_number_printed", "sample number 1 is on 2 observations: 250000001, 250000003"],
    ]);
  });
});
