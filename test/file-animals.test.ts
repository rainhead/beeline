import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { insertCleanSample, createMemoryDb, rows } from "./helpers.js";
import { describeFiling, fileAnimalsByEcdysis } from "../src/file-animals.js";
import { loadEcdysisTaxonomy, matchAndFileAnimals } from "../src/load-ecdysis-taxonomy.js";

/**
 * Filing the tree under Ecdysis's subfamilies, tribes and subtribes
 * (beeline-stoi). The thesaurus is the real fixture of 2026-10-24
 * (test/fixtures/ecdysis-taxonomy/), where Bombus sits under Bombini under
 * Apinae under Apidae, Melecta and Xeromelecta under Melectini under
 * Nomadinae, and Euodynerus directly under Vespidae. The tree is what promotion
 * leaves: genera straight under their family.
 */

const ECDYSIS_TAXONOMY = new URL("./fixtures/ecdysis-taxonomy/", import.meta.url).pathname;

let conn: DuckDBConnection;

const one = async (sql: string): Promise<number> => {
  const [[id]] = (await (await conn.run(sql)).getRows()) as [[number]];
  return Number(id);
};
const id = (name: string) => one(`SELECT entity_id FROM animal WHERE scientific_name = '${name}'`);

async function node(rank: string, name: string, parent: string | null): Promise<void> {
  await conn.run(
    `INSERT INTO animal (rank, scientific_name, parent_id) VALUES ('${rank}', '${name}', ${parent === null ? "NULL" : await id(parent)})`,
  );
}

/** Where a node sits now, by name. */
const under = (name: string) =>
  rows(conn, `SELECT p.scientific_name FROM animal_tree a LEFT JOIN animal p ON p.entity_id = a.filed_under_id WHERE a.scientific_name = '${name}'`);

const filingRows = () => rows(conn, "SELECT a.scientific_name, p.scientific_name FROM animal_filing f JOIN animal a ON a.entity_id = f.animal_id JOIN animal p ON p.entity_id = f.parent_id ORDER BY 1");

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await node("family", "Apidae", null);
  await node("family", "Vespidae", null);
  await node("genus", "Bombus", "Apidae");
  await node("genus", "Melecta", "Apidae");
  await node("genus", "Euodynerus", "Vespidae");
  await node("species", "Bombus vosnesenskii", "Bombus");
});

describe("filing the tree by Ecdysis's tribes", () => {
  test("a genus is filed under its tribe, and the tribe and subfamily are made above it", async () => {
    const result = (await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY)).filing;
    expect(await under("Bombus")).toEqual([["Bombini"]]);
    expect(await under("Bombini")).toEqual([["Apinae"]]);
    expect(await under("Apinae")).toEqual([["Apidae"]]);
    expect(await under("Melecta")).toEqual([["Melectini"]]);
    expect(await under("Melectini")).toEqual([["Nomadinae"]]);
    // Ecdysis files Euodynerus directly under the family, so nothing is made.
    expect(await under("Euodynerus")).toEqual([["Vespidae"]]);
    // A species stays under its genus.
    expect(await under("Bombus vosnesenskii")).toEqual([["Bombus"]]);
    expect(result.moved).toEqual([
      { rank: "genus", name: "Bombus", from: "Apidae", to: "Bombini" },
      { rank: "genus", name: "Melecta", from: "Apidae", to: "Melectini" },
    ]);
    expect(result.created.map((c) => c.name).sort()).toEqual(["Apinae", "Bombini", "Melectini", "Nomadinae"]);
    expect(describeFiling(result)).toContain("Melecta: Apidae to Melectini");
    // Only the moved genera have a filing row: the made nodes were created where they belong.
    expect(await filingRows()).toEqual([["Bombus", "Bombini"], ["Melecta", "Melectini"]]);
    expect(await rows(conn, "SELECT count(*) FROM animal_filing_stale")).toEqual([[0n]]);
    expect(await rows(conn, "SELECT count(*) FROM animal_ecdysis_stale")).toEqual([[0n]]);
    // Nomadinae holds Melectini; nothing is empty.
    expect(result.emptyIntermediates).toBe(0);
  });

  test("a second run changes nothing", async () => {
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    const filed = await rows(conn, "SELECT animal_id, parent_id, CAST(filed_at AS TEXT) FROM animal_filing ORDER BY 1");
    const animals = await rows(conn, "SELECT count(*) FROM animal");
    const again = await matchAndFileAnimals(conn);
    expect(again.moved).toEqual([]);
    expect(again.created).toEqual([]);
    expect(await rows(conn, "SELECT animal_id, parent_id, CAST(filed_at AS TEXT) FROM animal_filing ORDER BY 1")).toEqual(filed);
    expect(await rows(conn, "SELECT count(*) FROM animal")).toEqual(animals);
  });

  test("a genus with a determination is filed too, though its parent cannot be updated", async () => {
    await conn.run(`INSERT INTO person (display_name) VALUES ('Ada')`);
    const sample = await insertCleanSample(conn);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sample}, 1, '26000101')`);
    await conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, verbatim_identification)
       SELECT (SELECT max(entity_id) FROM specimen), ${await id("Bombus")}, false, 'in_app', 'Bombus'`,
    );
    // The reason for the design: DuckDB refuses to UPDATE a row another table refers to.
    await expect(conn.run(`UPDATE animal SET parent_id = ${await id("Apidae")} WHERE scientific_name = 'Bombus'`)).rejects.toThrow();
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    expect(await under("Bombus")).toEqual([["Bombini"]]);
    expect(await rows(conn, "SELECT count(*) FROM determination")).toEqual([[1n]]);
    expect(await rows(conn, "SELECT count(*) FROM animal_filing_stale")).toEqual([[0n]]);
  });

  test("a node already under the right tribe is reused, not made again, and one Ecdysis disagrees about is left", async () => {
    await node("subfamily", "Apinae", "Apidae");
    await node("tribe", "Bombini", "Apinae");
    // Tree says Vespidae; Ecdysis would anchor Melecta in Apidae, so the rule must not cross families.
    await conn.run(`DELETE FROM animal WHERE scientific_name = 'Melecta'`);
    await node("genus", "Melecta", "Vespidae");
    const result = (await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY)).filing;
    expect(result.created.map((c) => c.name)).toEqual([]);
    expect(await rows(conn, "SELECT count(*) FROM animal WHERE scientific_name IN ('Apinae', 'Bombini')")).toEqual([[2n]]);
    expect(await under("Bombus")).toEqual([["Bombini"]]);
    expect(await under("Melecta")).toEqual([["Vespidae"]]);
    expect(await rows(conn, "SELECT count(*) FROM animal_filing_stale")).toEqual([[0n]]);
  });

  test("a genus Ecdysis moves to another tribe of its family is followed", async () => {
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    // Ecdysis now files Bombus under Melectini, also in Apidae (under Nomadinae).
    await conn.run(`UPDATE ecdysis_taxon SET parent_tid = 150519, admitted_parent_tid = 150519, fetched_on = DATE '2026-11-30' WHERE name = 'Bombus'`);
    const result = await fileAnimalsByEcdysis(conn);
    expect(result.moved).toEqual([{ rank: "genus", name: "Bombus", from: "Bombini", to: "Melectini" }]);
    expect(await under("Bombus")).toEqual([["Melectini"]]);
    expect(await filingRows()).toContainEqual(["Bombus", "Melectini"]);
    // Bombini now holds nothing; Apinae still holds it.
    expect(result.emptyIntermediates).toBe(1);
    expect(await rows(conn, "SELECT count(*) FROM animal_filing_stale")).toEqual([[0n]]);
  });

  test("a subtribe is made between a tribe and its genus", async () => {
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    await conn.run(`INSERT INTO ecdysis_taxon (tid, rank, name, status, accepted_tid, parent_tid, admitted_parent_tid, fetched_on)
                    VALUES (900001, 'subtribe', 'Bombina', 'accepted', 900001, 139007, 139007, DATE '2026-11-30')`);
    await conn.run(`UPDATE ecdysis_taxon SET parent_tid = 900001, admitted_parent_tid = 900001 WHERE name = 'Bombus'`);
    const result = await fileAnimalsByEcdysis(conn);
    expect(result.created).toEqual([{ rank: "subtribe", name: "Bombina" }]);
    expect(await under("Bombus")).toEqual([["Bombina"]]);
    expect(await under("Bombina")).toEqual([["Bombini"]]);
  });

  test("a thesaurus with no subfamily or tribe says that the cached load is needed, and files nothing", async () => {
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    await conn.run(`DELETE FROM animal_filing`);
    await conn.run(`DELETE FROM ecdysis_taxon WHERE rank IN ('subfamily', 'tribe')`);
    const result = await fileAnimalsByEcdysis(conn);
    expect(result.needsCachedLoad).toBe(true);
    expect(describeFiling(result)).toContain("pnpm ecdysis:taxonomy --cached");
  });

  test("before any thesaurus is loaded nothing is filed and nothing is asked for", async () => {
    const result = await fileAnimalsByEcdysis(conn);
    expect(result).toEqual({ moved: [], created: [], emptyIntermediates: 0, needsCachedLoad: false });
  });
});
