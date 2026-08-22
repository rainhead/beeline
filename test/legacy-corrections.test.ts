import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, rows } from "./helpers.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy, type PromotionCounts } from "../src/promote-legacy.js";

const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;
const TAXONOMY = new URL("./fixtures/taxonomy.csv", import.meta.url).pathname;
const CORRECTIONS = new URL("./fixtures/legacy-corrections.csv", import.meta.url).pathname;
const APP_CORRECTIONS = new URL("./fixtures/app-corrections.csv", import.meta.url).pathname;
const NO_APP_CORRECTIONS = new URL("./fixtures/empty-corrections.csv", import.meta.url).pathname;

let conn: DuckDBConnection;
let counts: PromotionCounts;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await loadLegacyStaging(conn, FIXTURE);
  counts = await promoteLegacy(
    conn,
    TAXONOMY,
    "ingest/determiner-aliases.csv",
    "ingest/determiner-register.csv",
    CORRECTIONS,
    NO_APP_CORRECTIONS,
  );
});

describe("legacy correction overlay (ADR 0004, frozen upstream)", () => {
  test("corrections unblock the junk row; it promotes with the corrected identity", async () => {
    expect(counts).toMatchObject({
      staged: 4,
      samples: 3,
      specimens: 4,
      blockedRows: 0, // cccc3333's missing person + bad specimenId corrected away
      correctionsApplied: 4, // 3 on cccc3333 + the conflicted latitude on bbbb2222
      correctionsRetired: 1,
      correctionConflicts: 1,
    });
    const promoted = await rows(
      conn,
      `SELECT p.display_name, s.sample_number, sp.specimen_number
       FROM sample s
       JOIN person p ON p.entity_id = s.collector_id
       JOIN specimen sp ON sp.sample_id = s.entity_id
       WHERE s.sample_number = '142'`,
    );
    expect(promoted).toEqual([["Gretchen Pederson", "142", 3]]);
  });

  test("upstream converging to the corrected value retires the correction (no-op, no finding)", async () => {
    const [[sampleNumber]] = (await rows(
      conn,
      `SELECT s.sample_number FROM sample s
       JOIN person p ON p.entity_id = s.collector_id WHERE p.display_name = 'Ada Collector'`,
    )) as [[unknown]];
    expect(sampleNumber).toBe("1"); // unchanged: staged already equals new_value
    const findings = await rows(
      conn,
      `SELECT rule FROM legacy_promotion_finding WHERE _id = 'aaaa1111' AND rule LIKE 'correction%'`,
    );
    expect(findings).toEqual([]);
  });

  test("both sides moved: the correction stands and a conflict finding opens", async () => {
    const [[latitude]] = (await rows(
      conn,
      `SELECT loc.latitude FROM sample_location loc
       JOIN sample s ON s.entity_id = loc.sample_id
       WHERE s.sample_number = 'OBAS-00657'`,
    )) as [[unknown]];
    expect(latitude).toBe(46.1111); // the correction, not staged 46.0646 or base 46.9999
    const [finding] = await rows(
      conn,
      `SELECT details FROM legacy_promotion_finding WHERE _id = 'bbbb2222' AND rule = 'correction_conflict'`,
    );
    expect(String(finding?.[0])).toContain("46.0646");
  });

  test("a correction whose record vanished upstream is reported, not applied", async () => {
    const findings = await rows(
      conn,
      `SELECT rule FROM legacy_promotion_finding WHERE _id = 'zzzz9999'`,
    );
    expect(findings).toEqual([["correction_orphaned"]]);
  });
});

describe("app-written corrections take precedence over the git CSV", () => {
  test("for the same (_id, field), the app row wins and the git row is dropped", async () => {
    const { conn: appConn } = await createMemoryDb();
    await loadLegacyStaging(appConn, FIXTURE);
    await promoteLegacy(
      appConn,
      TAXONOMY,
      "ingest/determiner-aliases.csv",
      "ingest/determiner-register.csv",
      CORRECTIONS,
      APP_CORRECTIONS, // corrects bbbb2222 decimalLatitude too, anchored on the true staged value
    );
    const [[latitude]] = (await rows(
      appConn,
      `SELECT loc.latitude FROM sample_location loc
       JOIN sample s ON s.entity_id = loc.sample_id
       WHERE s.sample_number = 'OBAS-00657'`,
    )) as [[unknown]];
    expect(latitude).toBe(46.2222); // the app correction, not git's 46.1111
    // The git row never enters the merge, so its conflict finding is gone too.
    const findings = await rows(
      appConn,
      `SELECT rule FROM legacy_promotion_finding WHERE _id = 'bbbb2222' AND rule LIKE 'correction%'`,
    );
    expect(findings).toEqual([]);
  });
});
