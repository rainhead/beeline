import { beforeAll, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, rows } from "./helpers.js";
import { loadLegacyStaging } from "../src/load-legacy.js";

const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;

let conn: DuckDBConnection;
let staged: number;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  staged = await loadLegacyStaging(conn, FIXTURE);
});

test("stages every row", async () => {
  expect(staged).toBe(3);
});

test("everything arrives verbatim as strings", async () => {
  const [row] = await rows(
    conn,
    `SELECT fieldNumber, specimenId, verbatimElevation, "order" FROM legacy_occurrence WHERE _id = 'aaaa1111'`,
  );
  expect(row).toEqual(["25000001", "1", "72", "Hymenoptera"]);
  // Junk stays junk until promotion casts it and files findings.
  const [junk] = await rows(
    conn,
    `SELECT specimenId, verbatimElevation FROM legacy_occurrence WHERE _id = 'cccc3333'`,
  );
  expect(junk).toEqual(["foo", "Corvallis"]);
});

test("reloading replaces rather than appends", async () => {
  const again = await loadLegacyStaging(conn, FIXTURE);
  expect(again).toBe(3);
});
