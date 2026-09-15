import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDb, FIXTURE_INPUTS, rows } from "./helpers.js";
import { ITIS_RANKS } from "../src/extract-itis.js";
import { loadItis } from "../src/load-itis.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";

/**
 * Animal nodes against ITIS (beeline-45v.4).
 *
 * The ITIS rows are real: lifted from the release of 2026-08-26 with their
 * own TSNs, ranks and authors. The animal nodes are names the dev store
 * holds, one for each standing animal_itis distinguishes — Brachymelecta
 * californica because ITIS still has it only as Xeromelecta californica,
 * Hoplitis truncata because ITIS has two current names spelled that way, and
 * Lasioglossum (Dialictus) because ITIS carries no subgenera for the bee
 * families that use them.
 */

const TAXA = new URL("./fixtures/itis-taxon.csv", import.meta.url).pathname;
const SYNONYMS = new URL("./fixtures/itis-synonym.csv", import.meta.url).pathname;
const FILES = { taxonCsv: TAXA, synonymCsv: SYNONYMS };

let conn: DuckDBConnection;

async function node(rank: string, name: string): Promise<void> {
  await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('${rank}', '${name.replaceAll("'", "''")}')`);
}

const standings = () =>
  rows(conn, "SELECT scientific_name, standing, itis_tsn, current_name FROM animal_itis ORDER BY scientific_name");

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await node("genus", "Lasioglossum");
  await node("subgenus", "Lasioglossum (Dialictus)");
  await node("species", "Lasioglossum tenax");
  await node("species", "Lasioglossum zonulum");
  await node("species", "Hoplitis truncata");
  await node("species", "Brachymelecta californica");
});

describe("animal nodes against ITIS", () => {
  test("before ITIS is loaded, every node says so rather than looking absent", async () => {
    expect(await rows(conn, "SELECT DISTINCT standing FROM animal_itis")).toEqual([["not loaded"]]);
  });

  test("loading matches each node, and names what an unmatched one is", async () => {
    const result = await loadItis(conn, FILES);
    expect(result).toMatchObject({ taxa: 19, synonyms: 1, itisAsOf: "2026-08-26" });
    expect(await standings()).toEqual([
      ["Brachymelecta californica", "absent", null, null],
      // Two current ITIS names, Cresson 1878 and Wu 1992; the node carries no
      // authorship to choose between them, so it is named rather than guessed.
      ["Hoplitis truncata", "homonym", null, null],
      ["Lasioglossum", "valid", 154357n, null],
      ["Lasioglossum (Dialictus)", "absent", null, null],
      ["Lasioglossum tenax", "valid", 759441n, null],
      // Kept on its own TSN, with what ITIS calls it now beside it: following
      // the rename is the curation layer's decision (beeline-45v.1).
      ["Lasioglossum zonulum", "synonym", 759593n, "Lasioglossum zonulus"],
    ]);
    expect(await rows(conn, "SELECT entity_id FROM animal_itis_stale")).toEqual([]);
  });

  test("a later release that drops a name takes its TSN away again", async () => {
    await loadItis(conn, FILES);
    const dir = await mkdtemp(join(tmpdir(), "beeline-itis-"));
    try {
      const without = (await readFile(TAXA, "utf8"))
        .split("\n")
        .filter((line) => !line.includes("Lasioglossum tenax"))
        .join("\n");
      await writeFile(join(dir, "itis-taxon.csv"), without);
      await loadItis(conn, { taxonCsv: join(dir, "itis-taxon.csv"), synonymCsv: SYNONYMS });
      expect(await rows(conn, "SELECT standing, itis_tsn FROM animal_itis WHERE scientific_name = 'Lasioglossum tenax'"))
        .toEqual([["absent", null]]);
      expect(await rows(conn, "SELECT entity_id FROM animal_itis_stale")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an empty extract is refused, and the loaded ITIS survives it", async () => {
    await loadItis(conn, FILES);
    const dir = await mkdtemp(join(tmpdir(), "beeline-itis-"));
    try {
      await writeFile(join(dir, "itis-taxon.csv"), "tsn,rank,name,usage,author,parent_tsn,itis_as_of\n");
      await expect(loadItis(conn, { taxonCsv: join(dir, "itis-taxon.csv"), synonymCsv: SYNONYMS }))
        .rejects.toThrow(/empty/);
      expect(await rows(conn, "SELECT count(*) FROM itis_taxon")).toEqual([[19n]]);
      expect(await rows(conn, "SELECT itis_tsn FROM animal WHERE scientific_name = 'Lasioglossum tenax'"))
        .toEqual([[759441n]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ITIS numbers its ranks the way animal_rank does", async () => {
    // The extract maps ITIS rank ids to rank names with its own table, since
    // it runs with no store to read animal_rank from. This is what keeps the
    // two from drifting.
    expect(await rows(conn, "SELECT ordinal, rank FROM animal_rank ORDER BY ordinal")).toEqual(
      ITIS_RANKS.map(([id, rank]) => [id, rank]),
    );
  });
});

describe("legacy promotion and ITIS", () => {
  test("a rebuilt tree is matched against the ITIS the store already carries", async () => {
    ({ conn } = await createMemoryDb());
    await loadItis(conn, FILES);
    await loadLegacyStaging(conn, new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname);
    const counts = await promoteLegacy(conn, FIXTURE_INPUTS);
    expect(counts.animalsMatchedToItis).toBe(counts.animals);
    expect(await rows(conn, "SELECT itis_tsn FROM animal WHERE scientific_name = 'Bombus vosnesenskii'"))
      .toEqual([[714848n]]);
    expect(await rows(conn, "SELECT entity_id FROM animal_itis_stale")).toEqual([]);
  });
});
