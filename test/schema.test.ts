import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, rows } from "./helpers.js";

let conn: DuckDBConnection;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector'), ('Bea Printer')");
});

describe("schema application", () => {
  test("the global entity sequence assigns ids across tables", async () => {
    const [[a], [b]] = (await rows(conn, "SELECT entity_id FROM person ORDER BY entity_id")) as [[number], [number]];
    expect(b).toBe(a + 1);
    // The next entity, whatever its table, continues the same sequence.
    const [[c]] = (await rows(
      conn,
      "INSERT INTO atlas (code, name) VALUES ('XX', 'Test Atlas') RETURNING entity_id",
    )) as [[number]];
    expect(c).toBe(b + 1);
  });

  test("the six member atlases are seeded", async () => {
    const codes = await rows(conn, "SELECT code FROM atlas WHERE code <> 'XX' ORDER BY code");
    expect(codes.flat()).toEqual(["BC", "ID", "NM", "OBA", "OK", "WaBA"]);
  });

  test("enum-ish CHECK constraints reject unknown values", async () => {
    await expect(
      conn.run(`INSERT INTO sample (kind, collector_id, sample_number, date_start, date_end)
                VALUES ('bucket', (SELECT min(entity_id) FROM person), '1', DATE '2026-07-01', DATE '2026-07-01')`),
    ).rejects.toThrow(/CHECK/i);
  });

  test("date range must not run backwards", async () => {
    await expect(
      conn.run(`INSERT INTO sample (kind, collector_id, sample_number, date_start, date_end)
                VALUES ('trap', (SELECT min(entity_id) FROM person), 'OBAS-00001', DATE '2026-07-14', DATE '2026-07-01')`),
    ).rejects.toThrow(/CHECK/i);
  });

  test("negative specimen counts are rejected at the boundary", async () => {
    await expect(
      conn.run(`INSERT INTO sample (kind, collector_id, sample_number, date_start, date_end, specimen_count)
                VALUES ('net', (SELECT min(entity_id) FROM person), '1', DATE '2026-07-01', DATE '2026-07-01', -5)`),
    ).rejects.toThrow(/CHECK/i);
  });

  test("an elevation never arrives without provenance", async () => {
    await conn.run(`INSERT INTO sample (kind, collector_id, sample_number, date_start, date_end)
                    VALUES ('net', (SELECT min(entity_id) FROM person), '9', DATE '2026-07-01', DATE '2026-07-01')`);
    await expect(
      conn.run(`INSERT INTO sample_location (sample_id, latitude, longitude, elevation_m, source)
                SELECT max(entity_id), 44.5, -123.2, 72, 'inat_public' FROM sample`),
    ).rejects.toThrow(/CHECK/i);
  });

  test("verbatim catalog numbers admit historical duplicates", async () => {
    // The historical duplicate 25051768 must be storable on two specimen rows.
    await conn.run(`INSERT INTO sample (kind, collector_id, sample_number, date_start, date_end, specimen_count)
                    VALUES ('net', (SELECT min(entity_id) FROM person), '1', DATE '2025-08-17', DATE '2025-08-17', 2)`);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, catalog_number)
                    SELECT max(entity_id), 1, '25051768' FROM sample`);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, catalog_number)
                    SELECT max(entity_id), 2, '25051768' FROM sample`);
    const [[n]] = (await rows(conn, "SELECT count(*) FROM specimen WHERE catalog_number = '25051768'")) as [[bigint]];
    expect(Number(n)).toBe(2);
  });

  test("table and column comments are queryable in the database", async () => {
    const [[comment]] = (await rows(
      conn,
      "SELECT comment FROM duckdb_tables() WHERE table_name = 'animal'",
    )) as [[string]];
    expect(comment).toContain("curated taxonomy");
  });

  test("qc_rule metadata is seeded", async () => {
    const [[n]] = (await rows(conn, "SELECT count(*) FROM qc_rule")) as [[bigint]];
    expect(Number(n)).toBe(7);
  });
});
