import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, FIXTURE_INPUTS, rows } from "./helpers.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy, type PromotionCounts } from "../src/promote-legacy.js";

/**
 * Names that reach the store written some other way than the node they mean
 * (beeline-45v.2).
 *
 * Seeding mints an animal for every name it sees, so a name spelled another
 * way used to be a taxon of its own, and a determination on it was filed
 * apart from every other one of that taxon. Every name string below is one
 * production staging holds; only the row scaffolding around it is the
 * fixture's:
 *   name0001  subgenus column 'Andrena (Andrena)' — 2,888 rows write the whole
 *             form there, which minted 'Andrena (Andrena (Andrena))'
 *   name0002  specificEpithet '(Lasioglossum)' — a subgenus, 72 records
 *   name0003  specificEpithet 'Mesillae' — capitalised, 93 records
 *   name0004  genusVolDet '(Peponapis)' — a subgenus with no genus
 *   name0005  genusVolDet 'Epimelissodes (Svastra)'
 *   name0006  genusVolDet 'andrena'
 *   name0007  genusVolDet 'Agopostemon'
 *   name0008  genusVolDet 'Protoxaea', speciesVolDet 'glorioso'
 * The staff taxonomy list writes 'Xenoglossa (Peponapis)' in its genus
 * column, and the alias fixture carries one synthetic line nothing matches.
 */

const FIXTURE = new URL("./fixtures/legacy-names.jsonl", import.meta.url).pathname;
const TAXONOMY = new URL("./fixtures/taxonomy-bracketed.csv", import.meta.url).pathname;
const ALIASES = new URL("./fixtures/taxon-aliases.csv", import.meta.url).pathname;

let conn: DuckDBConnection;
let counts: PromotionCounts;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await loadLegacyStaging(conn, FIXTURE);
  counts = await promoteLegacy(conn, { ...FIXTURE_INPUTS, taxonomyCsv: TAXONOMY, taxonAliases: ALIASES });
});

describe("a name written another way resolves to the node it means", () => {
  test("every row becomes a determination, and only the synthetic alias goes unused", () => {
    expect(counts.blockedRows).toBe(0);
    expect(counts.determinations).toBe(8);
    expect(counts.unresolvedDeterminations).toBe(0);
    expect(counts.unusedTaxonAliases).toBe(1);
  });

  test("each determination lands where its writer meant", async () => {
    expect(
      await rows(
        conn,
        `SELECT d.is_expert, a.rank, a.scientific_name
         FROM determination d JOIN animal a ON a.entity_id = d.animal_id
         ORDER BY d.is_expert, a.scientific_name`,
      ),
    ).toEqual([
      [false, "genus", "Agapostemon"], // Agopostemon, by alias
      [false, "genus", "Andrena"], // andrena, by case
      [false, "subgenus", "Epimelissodes (Svastra)"], // a bracket in the genus column
      [false, "species", "Protoxaea gloriosa"], // Protoxaea glorioso, by alias
      [false, "subgenus", "Xenoglossa (Peponapis)"], // (Peponapis), by alias
      [true, "species", "Andrena frigida"],
      [true, "species", "Hylaeus mesillae"], // Mesillae, by case
      [true, "subgenus", "Lasioglossum (Lasioglossum)"], // a bracket in the epithet column
    ]);
  });

  test("no node is named the way only a parsing accident would name it", async () => {
    expect(
      await rows(
        conn,
        `SELECT rank, scientific_name FROM animal
         WHERE (rank = 'genus' AND NOT regexp_full_match(scientific_name, '[A-Z][a-z]+'))
            OR (rank = 'subgenus' AND NOT regexp_full_match(scientific_name, '[A-Z][a-z]+ \\([A-Z][a-z]+\\)'))
            OR (rank IN ('species', 'subspecies') AND NOT regexp_full_match(scientific_name, '[A-Z][a-z]+( [a-z-]+)+'))
         ORDER BY 1, 2`,
      ),
    ).toEqual([]);
  });

  test("the staff list's bracketed genus column seeds a genus and a subgenus under it", async () => {
    expect(
      await rows(
        conn,
        `SELECT c.rank, c.scientific_name, p.scientific_name
         FROM animal c JOIN animal p ON p.entity_id = c.parent_id
         WHERE c.scientific_name IN ('Xenoglossa pruinosa', 'Xenoglossa (Peponapis)', 'Andrena (Andrena)')
         ORDER BY 2`,
      ),
    ).toEqual([
      ["subgenus", "Andrena (Andrena)", "Andrena"],
      ["subgenus", "Xenoglossa (Peponapis)", "Xenoglossa"],
      ["species", "Xenoglossa pruinosa", "Xenoglossa"],
    ]);
  });

  test("the alias file that ships says only things the rules can use", async () => {
    // A genus alias must name a genus, or a genus and subgenus; a species
    // alias a binomial; every line says what it rests on; no spelling twice.
    expect(
      await rows(
        conn,
        `SELECT rank, alias, name, basis FROM read_csv('ingest/taxon-aliases.csv', header = true, all_varchar = true)
         WHERE rank NOT IN ('genus', 'species')
            OR (rank = 'genus' AND NOT regexp_full_match(name, '[A-Z][a-z]+( \\([A-Z][a-z]+\\))?'))
            OR (rank = 'species' AND NOT regexp_full_match(name, '[A-Z][a-z]+ [a-z-]+'))
            OR coalesce(trim(basis), '') = ''
            OR (rank, alias) IN (SELECT rank, alias FROM read_csv('ingest/taxon-aliases.csv', header = true, all_varchar = true)
                                 GROUP BY ALL HAVING count(*) > 1)`,
      ),
    ).toEqual([]);
  });
});
