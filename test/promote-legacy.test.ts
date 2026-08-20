import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, rows } from "./helpers.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy, type PromotionCounts } from "../src/promote-legacy.js";

const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;

let conn: DuckDBConnection;
let counts: PromotionCounts;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await loadLegacyStaging(conn, FIXTURE);
  counts = await promoteLegacy(conn);
});

describe("legacy promotion", () => {
  test("promotes the valid rows and blocks the junk row", () => {
    expect(counts).toEqual({
      staged: 3,
      people: 2,
      samples: 2,
      specimens: 2,
      locations: 2,
      blockedRows: 1,
    });
  });

  test("the junk row's problems are named findings", async () => {
    const found = await rows(
      conn,
      `SELECT rule FROM legacy_promotion_finding WHERE _id = 'cccc3333' ORDER BY rule`,
    );
    expect(found.flat()).toEqual(["bad_elevation", "bad_specimen_number", "missing_person"]);
  });

  test("net and trap samples are distinguished by date range", async () => {
    const kinds = await rows(
      conn,
      `SELECT kind, sample_number, CAST(date_start AS VARCHAR), CAST(date_end AS VARCHAR)
       FROM sample ORDER BY kind`,
    );
    expect(kinds).toEqual([
      ["net", "1", "2025-07-14", "2025-07-14"],
      ["trap", "OBAS-00657", "2025-07-01", "2025-07-14"],
    ]);
  });

  test("people, accounts, and atlases resolve", async () => {
    const people = await rows(
      conn,
      `SELECT p.display_name, i.login, a.code
       FROM person p
       LEFT JOIN inat_account i ON i.person_id = p.entity_id
       LEFT JOIN sample s ON s.collector_id = p.entity_id
       LEFT JOIN atlas a ON a.entity_id = s.atlas_id
       ORDER BY p.display_name`,
    );
    expect(people).toEqual([
      ["Ada Collector", "adacollects", "OBA"],
      ["Bea Trapper", "trapline", "WaBA"],
    ]);
  });

  test("locations carry elevation with legacy provenance", async () => {
    const locs = await rows(
      conn,
      `SELECT l.elevation_m, l.source, e.description LIKE 'legacy verbatimElevation%'
       FROM sample_location l JOIN elevation_source e ON e.entity_id = l.elevation_source_id
       ORDER BY l.elevation_m`,
    );
    expect(locs).toEqual([
      [72, "legacy_import", true],
      [120, "legacy_import", true],
    ]);
  });

  test("specimens keep verbatim catalog numbers", async () => {
    const specimens = await rows(
      conn,
      `SELECT catalog_number, specimen_number FROM specimen ORDER BY catalog_number`,
    );
    expect(specimens).toEqual([
      ["25000001", 1],
      ["25000002", 2],
    ]);
  });

  test("model-level QC now runs over the promoted samples", async () => {
    // The trap sample's street-address locality and 300 m uncertainty block;
    // the net sample prints.
    const printable = await rows(
      conn,
      `SELECT s.kind FROM printable_sample p JOIN sample s ON s.entity_id = p.sample_id`,
    );
    expect(printable).toEqual([["net"]]);
    const flagged = await rows(
      conn,
      `SELECT DISTINCT rule_name FROM qc_finding f JOIN sample s ON s.entity_id = f.sample_id
       WHERE s.kind = 'trap' ORDER BY rule_name`,
    );
    expect(flagged.flat()).toEqual([
      "coordinate_uncertainty",
      "locality_format",
      "missing_recommended_field",
    ]);
  });

  test("promotion refuses a non-empty model", async () => {
    await expect(promoteLegacy(conn)).rejects.toThrow(/freshly built/);
  });
});
