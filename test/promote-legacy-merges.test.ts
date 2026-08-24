import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, rows } from "./helpers.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy, type PromotionCounts } from "../src/promote-legacy.js";

/**
 * What happens when legacy rows that were separate become one sample.
 *
 * Since collectors became a list (beeline-77j), a pair's name-column spelling
 * and its recordedBy list resolve to the same person — so rows the legacy
 * system kept apart now land in one sample. Two consequences bite, and both
 * are here because a rebuild of the real 383k rows hit them: two legacy
 * specimen series numbered from 1 inside one sample, and a (firstName,
 * lastName) pair that disagrees with itself about who was listed first.
 *
 * The fixture is four rows:
 *   bbbb2222  Bea Trapper, OBAS-00657, legacy specimen 2
 *   ffff6666  the same trap sample written "Bea and Ada Trapper/Collector",
 *             also legacy specimen 2 — the O'Loughlin case (beeline-vyq)
 *   gggg7777  Cy Ambiguous, sample 9, recordedBy "Cy Ambiguous"
 *   hhhh8888  the same name columns, recordedBy "Dot Other" — the Mark
 *             Gorman / Pam Arion case
 */

const FIXTURE = new URL("./fixtures/legacy-merges.jsonl", import.meta.url).pathname;
const TAXONOMY = new URL("./fixtures/taxonomy.csv", import.meta.url).pathname;
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
    "ingest/legacy-corrections.csv",
    NO_APP_CORRECTIONS,
  );
});

describe("legacy rows that merge into one sample", () => {
  test("every staged row becomes exactly one specimen", () => {
    // The invariant promotion checks for itself: specimens + blocked = staged.
    // A pair mapped to two people used to fan out here, inventing specimens.
    expect(counts.staged).toBe(4);
    expect(counts.blockedRows).toBe(0);
    expect(counts.specimens).toBe(4);
    expect(counts.samples).toBe(2);
  });

  test("two legacy series in one sample are renumbered, not collided", async () => {
    // Both rows arrived as legacy specimen 2; (sample_id, specimen_number) is
    // unique, so the number is assigned per sample — ordered by the legacy
    // number, then _id, so a re-run assigns the same numbers.
    const specimens = await rows(
      conn,
      `SELECT s.sample_number, sp.specimen_number, sp.field_number
       FROM specimen sp JOIN sample s ON s.entity_id = sp.sample_id
       ORDER BY s.sample_number, sp.specimen_number`,
    );
    expect(specimens).toEqual([
      ["9", 1, "25000007"],
      ["9", 2, "25000008"],
      ["OBAS-00657", 1, "25000002"],
      ["OBAS-00657", 2, "25000006"],
    ]);
  });

  test("each determination follows its own row to its own specimen", async () => {
    // The map from staged row to specimen is keyed by _id, not by the legacy
    // specimen number — which stopped being a key the moment two series
    // merged. Getting this wrong silently reattributes determinations.
    const dets = await rows(
      conn,
      `SELECT sp.field_number, a.scientific_name, p.display_name
       FROM determination d
       JOIN specimen sp ON sp.entity_id = d.specimen_id
       JOIN animal a ON a.entity_id = d.animal_id
       LEFT JOIN person p ON p.entity_id = d.determiner_id
       ORDER BY sp.field_number`,
    );
    expect(dets).toEqual([
      ["25000002", "Bombus", "Bea Trapper"],
      ["25000006", "Bombus", "Bea Trapper"],
      ["25000007", "Bombus", "Cy Ambiguous"],
      ["25000008", "Bombus", "Cy Ambiguous"],
    ]);
  });

  test("a pair that disagrees about who was first resolves to one person", async () => {
    // Both of Cy's rows carry the same name columns; one recordedBy names Dot
    // instead. Two person mappings for one pair would duplicate the sample
    // and every specimen under it, so the pair's own columns break the tie.
    const collectors = await rows(
      conn,
      `SELECT s.sample_number, c.position, p.display_name
       FROM sample_collector c
       JOIN sample s ON s.entity_id = c.sample_id
       JOIN person p ON p.entity_id = c.person_id
       ORDER BY s.sample_number, c.position`,
    );
    expect(collectors).toEqual([
      ["9", 1, "Cy Ambiguous"],
      ["9", 2, "Dot Other"], // still recorded, just not the primary
      ["OBAS-00657", 1, "Bea Trapper"],
      ["OBAS-00657", 2, "Ada Collector"],
    ]);
  });

  test("name parts are taken only from a row that is about that person", async () => {
    // firstName/lastName on hhhh8888 describe Cy; Dot must not inherit them,
    // or a label prints "C. Ambiguous" for Dot Other.
    const parts = await rows(
      conn,
      `SELECT display_name, given_name, family_name FROM person ORDER BY display_name`,
    );
    expect(parts).toEqual([
      ["Ada Collector", null, null], // named only inside a joint recordedBy
      ["Bea Trapper", "Bea", "Trapper"],
      ["Cy Ambiguous", "Cy", "Ambiguous"],
      ["Dot Other", null, null],
    ]);
  });
});
