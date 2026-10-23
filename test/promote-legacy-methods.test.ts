import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, FIXTURE_INPUTS, rows } from "./helpers.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";

/**
 * A net sample and a pan trap one collector gave the same number on the same
 * day, which legacy promotion used to merge into one sample — a trap carrying
 * a net's host flower and observation (sample 53567 on the sandbox, Peter,
 * 2026-10-23). Synthetic on the shared fixture: Ada's sample 1 is two netted
 * records citing observation 250000001, and here 25000003 becomes a pan trap
 * left out overnight, numbered specimen 1 as its own series would be. Bea's
 * vane trap OBAS-00657 gains a second record whose end date was left off,
 * which is one trap sample whatever its dates say.
 */
const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;

let conn: DuckDBConnection;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await loadLegacyStaging(conn, FIXTURE);
  await conn.run(`UPDATE legacy_occurrence
    SET "samplingProtocol" = 'pan traps', day2 = '15', month2 = 'VII', year2 = '2025', "specimenId" = '1'
    WHERE "fieldNumber" = '25000003'`);
  await conn.run(`INSERT INTO legacy_occurrence SELECT * REPLACE ('bea-no-end' AS _id, '25000012' AS "fieldNumber",
      '3' AS "specimenId", '' AS day2, '' AS month2, '' AS year2)
    FROM legacy_occurrence WHERE "fieldNumber" = '25000002'`);
  await promoteLegacy(conn, FIXTURE_INPUTS);
});

describe("a legacy sample number a net and a trap share", () => {
  test("is two samples, each with its own method, dates, place, observation and specimens", async () => {
    expect(await rows(conn, `
      SELECT s.kind, s.protocol, CAST(s.date_end AS TEXT), s.locality, s.inat_observation_id,
             string_agg(sp.field_number, ' ' ORDER BY sp.field_number), s.specimen_count
      FROM sample s JOIN specimen sp ON sp.sample_id = s.entity_id
      WHERE s.sample_number = '1'
      GROUP BY ALL ORDER BY s.kind`)).toEqual([
      ["net", "aerial net", "2025-07-14", "Corvallis", 250000001n, "25000001 25000009", 2],
      ["trap", "pan traps", "2025-07-15", "Philomath", null, "25000003", 1],
    ]);
  });

  test("keeps the net's specimen 1 and the trap's specimen 1 as two pins", async () => {
    expect(await rows(conn, `
      SELECT o."fieldNumber" FROM legacy_promotion_finding f JOIN legacy_occurrence o USING (_id)
      WHERE f.rule = 'duplicate_specimen'`)).toEqual([]);
  });

  test("leaves neither half disagreeing with itself about where or how", async () => {
    expect(await rows(conn, `
      SELECT f.details FROM sample_promotion_finding f JOIN sample s ON s.entity_id = f.sample_id
      WHERE s.sample_number = '1'`)).toEqual([]);
  });
});

describe("a legacy trap sample one of whose records lacks its end date", () => {
  test("stays one trap sample: the method decides a split, not the dates", async () => {
    expect(await rows(conn, `
      SELECT s.kind, string_agg(sp.field_number, ' ' ORDER BY sp.field_number)
      FROM sample s JOIN specimen sp ON sp.sample_id = s.entity_id
      WHERE s.sample_number = 'OBAS-00657'
      GROUP BY ALL`)).toEqual([["trap", "25000002 25000012"]]);
  });
});
