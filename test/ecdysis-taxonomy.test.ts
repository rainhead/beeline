import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDb, FIXTURE_INPUTS, rows } from "./helpers.js";
import { loadEcdysisTaxonomy } from "../src/load-ecdysis-taxonomy.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";

/**
 * Animal nodes against Ecdysis's thesaurus (beeline-7gob).
 *
 * The thesaurus rows are real: 60 rows of the fetch of 2026-10-24
 * (test/fixtures/ecdysis-taxonomy/), with their own ids, ranks and authors and
 * every name above them, tribes and subfamilies included. The animal nodes are
 * names the dev store holds, one for each standing animal_ecdysis
 * distinguishes — Xeromelecta californica because Ecdysis files it under
 * Brachymelecta californica, Rileya because Ecdysis has two accepted genera
 * spelled that way (a chalcid wasp and a fly), and Lasioglossum aspilurum
 * because Ecdysis does not have it.
 */

const ECDYSIS_TAXONOMY = new URL("./fixtures/ecdysis-taxonomy/", import.meta.url).pathname;

let conn: DuckDBConnection;

async function node(rank: string, name: string): Promise<void> {
  await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('${rank}', '${name.replaceAll("'", "''")}')`);
}

const standings = () =>
  rows(conn, "SELECT scientific_name, standing, ecdysis_tid, accepted_name FROM animal_ecdysis ORDER BY scientific_name");

/** A copy of the fixture with its CSV rewritten, for a fetch that differs from it. */
async function variant(edit: (csv: string) => string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "beeline-ecdysis-taxonomy-"));
  await writeFile(join(dir, "ecdysis-taxa.csv"), edit(await readFile(join(ECDYSIS_TAXONOMY, "ecdysis-taxa.csv"), "utf8")));
  await copyFile(join(ECDYSIS_TAXONOMY, "manifest.json"), join(dir, "manifest.json"));
  return dir;
}

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await node("genus", "Lasioglossum");
  await node("subgenus", "Lasioglossum (Dialictus)");
  await node("species", "Lasioglossum tenax");
  await node("species", "Lasioglossum aspilurum");
  await node("species", "Xeromelecta californica");
  await node("genus", "Rileya");
});

describe("animal nodes against Ecdysis's thesaurus", () => {
  test("before the thesaurus is loaded, every node says so rather than looking absent", async () => {
    expect(await rows(conn, "SELECT DISTINCT standing FROM animal_ecdysis")).toEqual([["not loaded"]]);
  });

  test("loading matches each node, and names what an unmatched one is", async () => {
    const result = await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    // 15 of the 60 are a subphylum, subclasses, infraclasses, subfamilies and
    // tribes, which the store does not admit.
    expect(result).toMatchObject({ taxa: 45, synonyms: 2, notAdmitted: 15, synonymsWithoutAcceptedName: 0, fetchedOn: "2026-10-24" });
    expect(await standings()).toEqual([
      ["Lasioglossum", "accepted", 186125n, null],
      ["Lasioglossum (Dialictus)", "accepted", 487834n, null],
      ["Lasioglossum aspilurum", "absent", null, null],
      ["Lasioglossum tenax", "accepted", 248008n, null],
      // Two accepted genera, Ashmead 1888 and Brauer and Bergenstamm 1893; the
      // node carries no authorship to choose between them, so it is named
      // rather than guessed.
      ["Rileya", "homonym", null, null],
      // Kept on its own id, with the name Ecdysis files it under beside it:
      // following the rename is the curation layer's decision (beeline-45v.1).
      ["Xeromelecta californica", "synonym", 1645055n, "Brachymelecta californica"],
    ]);
    expect(await rows(conn, "SELECT entity_id FROM animal_ecdysis_stale")).toEqual([]);
  });

  test("an accepted name's admitted parent skips what the store does not admit, and a subgenus", async () => {
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    const parent = (name: string) =>
      rows(conn, `SELECT p.name FROM ecdysis_taxon t LEFT JOIN ecdysis_taxon p ON p.tid = t.admitted_parent_tid WHERE t.name = '${name}'`);
    expect(await parent("Insecta")).toEqual([["Arthropoda"]]); // past the subphylum Hexapoda
    expect(await parent("Hymenoptera")).toEqual([["Insecta"]]); // past Pterygota and Neoptera
    expect(await parent("Apoidea")).toEqual([["Apocrita"]]); // past the infraorder Aculeata
    expect(await parent("Bombus")).toEqual([["Apidae"]]); // past Bombini and Apinae
    // Ecdysis files the species under Lasioglossum (Dialictus); the tree files
    // every species under its genus.
    expect(await parent("Lasioglossum tenax")).toEqual([["Lasioglossum"]]);
    expect(await parent("Lasioglossum (Dialictus)")).toEqual([["Lasioglossum"]]);
    expect(await parent("Animalia")).toEqual([[null]]);
    // Filed in Ecdysis under Xeromelecta, a synonym: the walk goes on from the
    // name Ecdysis accepts instead, rather than reaching a name it rejects.
    expect(await parent("Xeromelecta larreae")).toEqual([["Brachymelecta"]]);
    // Filed under Lasioglossum (Eickwortia), which Ecdysis holds at genus rank
    // directly under Halictidae: no ancestor, rather than the family.
    expect(await parent("Lasioglossum alexanderi")).toEqual([[null]]);
    expect(await parent("Xeromelecta californica")).toEqual([[null]]); // a synonym has none
  });

  test("a later fetch that drops a name takes its id away again", async () => {
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    const dir = await variant((csv) => csv.split("\n").filter((line) => !line.includes("Lasioglossum tenax")).join("\n"));
    try {
      await loadEcdysisTaxonomy(conn, dir);
      expect(await rows(conn, "SELECT standing, ecdysis_tid FROM animal_ecdysis WHERE scientific_name = 'Lasioglossum tenax'"))
        .toEqual([["absent", null]]);
      expect(await rows(conn, "SELECT entity_id FROM animal_ecdysis_stale")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a fetch with no name at an admitted rank is refused, and the loaded thesaurus survives it", async () => {
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    const dir = await variant((csv) => `${csv.split("\n")[0]}\n`);
    try {
      await expect(loadEcdysisTaxonomy(conn, dir)).rejects.toThrow(/no name at a rank the store admits/);
      expect(await rows(conn, "SELECT count(*) FROM ecdysis_taxon")).toEqual([[45n]]);
      expect(await rows(conn, "SELECT ecdysis_tid FROM animal WHERE scientific_name = 'Lasioglossum tenax'")).toEqual([[248008n]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a fetch that does not say when it was made is refused", async () => {
    const dir = await variant((csv) => csv);
    try {
      await writeFile(join(dir, "manifest.json"), "{}\n");
      await expect(loadEcdysisTaxonomy(conn, dir)).rejects.toThrow(/does not say when the fetch was made/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("legacy promotion and the thesaurus", () => {
  test("a rebuilt tree is matched against the thesaurus the store already carries", async () => {
    ({ conn } = await createMemoryDb());
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    await loadLegacyStaging(conn, new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname);
    const counts = await promoteLegacy(conn, FIXTURE_INPUTS);
    expect(counts.animalsMatchedToEcdysis).toBe(counts.animals);
    expect(await rows(conn, "SELECT ecdysis_tid FROM animal WHERE scientific_name = 'Bombus vosnesenskii'")).toEqual([[237038n]]);
    expect(await rows(conn, "SELECT entity_id FROM animal_ecdysis_stale")).toEqual([]);
  });
});
