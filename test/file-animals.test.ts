import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { insertCleanSample, createMemoryDb, rows } from "./helpers.js";
import { adoptEcdysisNames } from "../src/adopt-ecdysis.js";
import { describeFiling, fileAnimalsByEcdysis, NO_FILING } from "../src/file-animals.js";
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

const roots = () => rows(conn, "SELECT scientific_name FROM animal_tree WHERE filed_under_id IS NULL ORDER BY 1");

const filingRows = () => rows(conn, "SELECT a.scientific_name, p.scientific_name FROM animal_filing f JOIN animal a ON a.entity_id = f.animal_id JOIN animal p ON p.entity_id = f.parent_id ORDER BY 1");

/** A second run of the filing changes neither the filing rows nor the tree. */
async function expectNoChange(): Promise<void> {
  const filed = await rows(conn, "SELECT animal_id, parent_id, CAST(filed_at AS TEXT) FROM animal_filing ORDER BY 1");
  const animals = await rows(conn, "SELECT count(*) FROM animal");
  const again = await fileAnimalsByEcdysis(conn);
  expect(again.moved).toEqual([]);
  expect(again.created).toEqual([]);
  expect(await rows(conn, "SELECT animal_id, parent_id, CAST(filed_at AS TEXT) FROM animal_filing ORDER BY 1")).toEqual(filed);
  expect(await rows(conn, "SELECT count(*) FROM animal")).toEqual(animals);
}

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await node("kingdom", "Animalia", null);
  await node("family", "Apidae", "Animalia");
  await node("family", "Vespidae", "Animalia");
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
    // Nothing was made a root: Animalia is the only node with no parent.
    expect(await roots()).toEqual([["Animalia"]]);
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
    expect(result).toEqual(NO_FILING);
  });

  test("a genus Ecdysis moves up to its family loses its filing row, and a second run changes nothing", async () => {
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    expect(await filingRows()).toContainEqual(["Bombus", "Bombini"]);
    await conn.run(`UPDATE ecdysis_taxon SET parent_tid = 86587, admitted_parent_tid = 86587 WHERE name = 'Bombus'`);
    const result = await fileAnimalsByEcdysis(conn);
    expect(result.moved).toEqual([{ rank: "genus", name: "Bombus", from: "Bombini", to: "Apidae" }]);
    expect(await under("Bombus")).toEqual([["Apidae"]]);
    expect(await rows(conn, "SELECT count(*) FROM animal_filing f JOIN animal a ON a.entity_id = f.animal_id WHERE a.scientific_name = 'Bombus'")).toEqual([[0n]]);
    await expectNoChange();
  });

  test("a tribe that becomes a synonym stops being filed under, and its genera return to where they were made", async () => {
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    await conn.run(`UPDATE ecdysis_taxon SET status = 'synonym', accepted_tid = 154255, admitted_parent_tid = NULL WHERE name = 'Melectini'`);
    const result = await fileAnimalsByEcdysis(conn);
    // Melecta's chain no longer reaches Apidae, so the rule lets go of it; its creation parent is the family.
    expect(await under("Melecta")).toEqual([["Apidae"]]);
    expect(result.moved).toContainEqual({ rank: "genus", name: "Melecta", from: "Melectini", to: "Apidae" });
    // The tribe itself stays under its subfamily, in the same family.
    expect(await under("Melectini")).toEqual([["Nomadinae"]]);
    expect(await roots()).toEqual([["Animalia"]]);
    expect(await rows(conn, "SELECT count(*) FROM animal_filing_stale")).toEqual([[0n]]);
    expect(result.unreached).toBeGreaterThan(0);
    await expectNoChange();
  });

  test("a tribe that moves between subfamilies of its family is followed, with its genera", async () => {
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    await conn.run(`UPDATE ecdysis_taxon SET parent_tid = 104093, admitted_parent_tid = 104093 WHERE name = 'Melectini'`);
    const result = await fileAnimalsByEcdysis(conn);
    expect(result.moved).toEqual([{ rank: "tribe", name: "Melectini", from: "Nomadinae", to: "Apinae" }]);
    expect(await under("Melectini")).toEqual([["Apinae"]]);
    expect(await under("Melecta")).toEqual([["Melectini"]]);
    // Nomadinae now holds nothing.
    expect(result.emptyIntermediates).toBe(1);
    await expectNoChange();
  });

  /** Ecdysis moves the subfamily Apinae under Vespidae, which the tree still holds under Apidae. */
  const apinaeLeavesApidae = async () => {
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    await conn.run(`UPDATE ecdysis_taxon SET parent_tid = 96610, admitted_parent_tid = 96610 WHERE name = 'Apinae'`);
  };

  test("a genus is never filed under a node that sits in another family, however Ecdysis files it", async () => {
    await apinaeLeavesApidae();
    // Euodynerus sits under Vespidae in the tree, and Ecdysis now files it under Apinae, under Vespidae.
    await conn.run(`UPDATE ecdysis_taxon SET parent_tid = 104093, admitted_parent_tid = 104093 WHERE name = 'Euodynerus'`);
    const result = await fileAnimalsByEcdysis(conn);
    expect(await under("Euodynerus")).toEqual([["Vespidae"]]);
    // Apinae itself is not moved: its anchor in the tree is not on its chain, so the rule does not reach it.
    expect(await under("Apinae")).toEqual([["Apidae"]]);
    expect(result.unplaced).toContainEqual({ rank: "subfamily", name: "Apinae" });
    // The disagreement is visible, not silent.
    expect(await rows(conn, "SELECT a.scientific_name FROM animal_filing_stale s JOIN animal a ON a.entity_id = s.entity_id")).toEqual([["Euodynerus"]]);
    expect(describeFiling(result)).toContain("could not be placed in the right family: Apinae");
    await expectNoChange();
  });

  test("a missing intermediate is not made under a parent in another family", async () => {
    await apinaeLeavesApidae();
    await conn.run(`INSERT INTO ecdysis_taxon (tid, rank, name, status, accepted_tid, parent_tid, admitted_parent_tid, fetched_on)
                    VALUES (900002, 'tribe', 'Xtribe', 'accepted', 900002, 104093, 104093, DATE '2026-11-30')`);
    await conn.run(`UPDATE ecdysis_taxon SET parent_tid = 900002, admitted_parent_tid = 900002 WHERE name = 'Euodynerus'`);
    const result = await fileAnimalsByEcdysis(conn);
    expect(await rows(conn, "SELECT count(*) FROM animal WHERE scientific_name = 'Xtribe'")).toEqual([[0n]]);
    expect(result.unplaced).toContainEqual({ rank: "tribe", name: "Xtribe" });
    expect(await under("Euodynerus")).toEqual([["Vespidae"]]);
    expect(await roots()).toEqual([["Animalia"]]);
  });

  test("adoption hangs a genus under a tribe in its own family, and not under one in another", async () => {
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    await conn.run(`INSERT INTO ecdysis_taxon (tid, rank, name, status, accepted_tid, parent_tid, admitted_parent_tid, fetched_on)
                    VALUES (900004, 'genus', 'Yygenus', 'accepted', 900004, 139007, 139007, DATE '2026-11-30')`);
    expect((await adoptEcdysisNames(conn, ["Yygenus"])).map((a) => a.name)).toEqual(["Yygenus"]);
    expect(await under("Yygenus")).toEqual([["Bombini"]]);
  });

  test("adoption does not hang a genus under a tribe that sits in another family", async () => {
    await apinaeLeavesApidae();
    await conn.run(`INSERT INTO ecdysis_taxon (tid, rank, name, status, accepted_tid, parent_tid, admitted_parent_tid, fetched_on)
                    VALUES (900003, 'genus', 'Zzgenus', 'accepted', 900003, 139007, 139007, DATE '2026-11-30')`);
    // Bombini is in the tree under Apinae under Apidae; Ecdysis now has that chain ending in Vespidae.
    await adoptEcdysisNames(conn, ["Zzgenus"]);
    expect(await rows(conn, "SELECT count(*) FROM animal WHERE scientific_name = 'Zzgenus'")).toEqual([[0n]]);
    expect(await roots()).toEqual([["Animalia"]]);
  });
});
