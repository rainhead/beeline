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
 * The fixture is eight rows:
 *   bbbb2222  Bea Trapper, OBAS-00657, legacy specimen 2
 *   ffff6666  the same trap sample written "Bea and Ada Trapper/Collector",
 *             also legacy specimen 2 — the O'Loughlin case (beeline-vyq)
 *   gggg7777  Cy Ambiguous, sample 9, recordedBy "Cy Ambiguous"
 *   hhhh8888  the same name columns, recordedBy "Dot Other" — the Mark
 *             Gorman / Pam Arion case
 *   iiii9999  Cy again, sample 10, recordedBy "Cy Ambiguous": the sample Dot
 *             was never named on (beeline-eyk)
 *   jjjj0000  Eve Roberts, sample 11, recordedBy "Eve ROberts"
 *   kkkk1111  the same sample, spelled "Eve Roberts"
 *   llll2222  Eve again, sample 12 — so the majority spelling has a majority
 *   mmmm3333  Eve a third time, sample 13, spelled "Evie Roberts": too far
 *             for the fold, so collector-aliases.csv carries it
 *
 * Cy's and Dot's rows file under one login, which is the shared-account shape
 * the duplicate detector must surface without merging anything.
 */

const FIXTURE = new URL("./fixtures/legacy-merges.jsonl", import.meta.url).pathname;
const TAXONOMY = new URL("./fixtures/taxonomy.csv", import.meta.url).pathname;
const NO_APP_CORRECTIONS = new URL("./fixtures/empty-corrections.csv", import.meta.url).pathname;
const ALIASES = new URL("./fixtures/collector-aliases.csv", import.meta.url).pathname;

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
    "ingest/person-overlay.csv",
    "data/person-overlay.csv",
    ALIASES,
  );
});

describe("legacy rows that merge into one sample", () => {
  test("every staged row becomes exactly one specimen", () => {
    // The invariant promotion checks for itself: specimens + blocked = staged.
    // A pair mapped to two people used to fan out here, inventing specimens.
    expect(counts.staged).toBe(9);
    expect(counts.blockedRows).toBe(0);
    expect(counts.specimens).toBe(9);
    expect(counts.samples).toBe(6);
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
      ["10", 1, "25000009"],
      ["11", 1, "25000010"],
      ["11", 2, "25000011"],
      ["12", 1, "25000012"],
      ["13", 1, "25000013"],
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
      ["10", 1, "Cy Ambiguous"], // Dot was named on sample 9, and only there
      ["11", 1, "Eve Roberts"],
      ["12", 1, "Eve Roberts"],
      ["13", 1, "Eve Roberts"],
      ["9", 1, "Cy Ambiguous"],
      ["9", 2, "Dot Other"], // still recorded, just not the primary
      ["OBAS-00657", 1, "Bea Trapper"],
      ["OBAS-00657", 2, "Ada Collector"],
    ]);
  });

  test("a name recorded on one row does not spread to the pair's other samples", async () => {
    // The bug this fixture's sample 10 exists for: collectors used to be
    // rolled up per (firstName, lastName) pair, so Dot — named on one row of
    // sample 9 — landed on every sample Cy's pair ever produced. In the real
    // dump one 'Pam Arion' row among 7,569 made her a co-collector on 1,675
    // of Mark Gorman's samples, each of which then printed a pair.
    const samples = await rows(
      conn,
      `SELECT s.sample_number FROM sample_collector c
       JOIN sample s ON s.entity_id = c.sample_id
       JOIN person p ON p.entity_id = c.person_id
       WHERE p.display_name = 'Dot Other' ORDER BY s.sample_number`,
    );
    expect(samples).toEqual([["9"]]);
  });

  test("two spellings of one name are one person, spelled the way most rows spell it", async () => {
    // 'Eve ROberts' and 'Eve Roberts' fold to the same identity key, so they
    // are one person and sample 11 has one collector, not two. The display
    // name is the majority spelling — ingest/person-overlay.csv overrides it
    // when the majority is the typo.
    const people = await rows(
      conn,
      `SELECT display_name, given_name, family_name FROM person
       WHERE lower(display_name) LIKE 'eve %'`,
    );
    expect(people).toEqual([["Eve Roberts", "Eve", "Roberts"]]);
  });

  test("a spelling the fold cannot reach is merged by collector-aliases.csv", async () => {
    // 'Evie Roberts' differs from 'Eve Roberts' by a letter, which is where
    // the fold stops and curation starts — the same shape as 'Emily Hoskins'
    // and 'Barrett Barrett' in the real dump.
    const evie = await rows(conn, `SELECT count(*) FROM person WHERE display_name = 'Evie Roberts'`);
    expect(evie).toEqual([[0n]]);
    // A line naming a spelling nothing carries is a CSV typo, and says so
    // rather than doing nothing quietly.
    expect(counts.unusedCollectorAliases).toBe(1);
  });

  test("two person records under one login are surfaced, not merged", async () => {
    // The detector the alias CSV is curated from: a login lands on a record
    // because somebody typed it in, so two names under one login are either
    // one human spelled twice or a shared account. Cy and Dot are the second
    // kind — a worklist entry, and nothing promotion may decide by itself.
    expect(counts.collectorDuplicateLogins).toBe(1);
    const candidates = await rows(
      conn,
      `SELECT login, display_name FROM legacy_collector_duplicate_candidate
       ORDER BY display_name`,
    );
    expect(candidates).toEqual([
      ["cyamb", "Cy Ambiguous"],
      ["cyamb", "Dot Other"],
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
      ["Eve Roberts", "Eve", "Roberts"],
    ]);
  });
});
