import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { beforeEach, describe, expect, test } from "vitest";
import type { Kysely } from "kysely";
import { adoptEcdysisNames } from "../src/adopt-ecdysis.js";
import { loadEcdysisTaxonomy, rebuildEcdysisAdoptable } from "../src/load-ecdysis-taxonomy.js";
import { createKysely } from "../src/db.js";
import { BadRequest, ecdysisKey, entrySeasons, rowTaxa, saveDrafts, searchEcdysisNames, seasonRows, UnknownTaxon } from "../src/app/determine.js";
import { commitDeterminationDrafts } from "../src/commit-determinations.js";
import type { Database } from "../src/model.js";
import { createMemoryDb, CURRENT_SEASON, insertCleanSample, rows } from "./helpers.js";

/**
 * Naming a specimen with a name from Ecdysis that the tree does not hold yet
 * (beeline-4wx3): the table of names that can be adopted, the picker's
 * search of it, drafts that carry an Ecdysis id, and the overnight commit
 * adopting the name. The thesaurus is the real rows of the fetch of
 * 2026-10-24 in test/fixtures/ecdysis-taxonomy/ (see test/adopt-ecdysis.test.ts
 * for what they hold): Chrysis and Euodynerus are wasps the tree lacks;
 * Bombus and Melecta are bees; Rileya is two accepted genera at one
 * spelling; Lasioglossum (Eickwortia) is a genus spelled like a subgenus,
 * and Lasioglossum alexanderi sits under it.
 */

const ECDYSIS_TAXONOMY = new URL("./fixtures/ecdysis-taxonomy/", import.meta.url).pathname;

let instance: DuckDBInstance;
let conn: DuckDBConnection;
let db: Kysely<Database>;

const one = async (query: string): Promise<number> => Number((await rows(conn, query))[0]![0]);

async function node(rank: string, name: string, parent: string | null): Promise<void> {
  await conn.run(
    `INSERT INTO animal (rank, scientific_name, parent_id)
     SELECT '${rank}', '${name}', ${parent === null ? "NULL" : `(SELECT entity_id FROM animal WHERE scientific_name = '${parent}')`}`,
  );
}

beforeEach(async () => {
  ({ instance, conn } = await createMemoryDb());
  db = createKysely(instance);
  await node("kingdom", "Animalia", null);
  await node("phylum", "Arthropoda", "Animalia");
  await node("class", "Insecta", "Arthropoda");
  await node("order", "Hymenoptera", "Insecta");
  await node("family", "Apidae", "Hymenoptera");
  await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
});

describe("the names Ecdysis offers for adoption", () => {
  test("hold accepted names at the ranks a specimen is named at, with their family and order", async () => {
    const adoptable = await rows(conn, "SELECT name, rank, family, insect_order FROM ecdysis_adoptable ORDER BY name_key");
    expect(adoptable).toContainEqual(["Chrysis", "genus", "Chrysididae", "Hymenoptera"]);
    expect(adoptable).toContainEqual(["Euodynerus", "genus", "Vespidae", "Hymenoptera"]);
    expect(adoptable).toContainEqual(["Chrysididae", "family", "Chrysididae", "Hymenoptera"]);
    expect(adoptable).toContainEqual(["Apocrita", "suborder", null, "Hymenoptera"]);
    expect(adoptable).toContainEqual(["Hymenoptera", "order", null, "Hymenoptera"]);
    const names = adoptable.map((r) => r[0]);
    // Two accepted genera at one spelling: which one is meant is a taxonomist's choice.
    expect(names).not.toContain("Rileya");
    // A genus spelled like a subgenus, and a species that cannot be walked past it.
    expect(names).not.toContain("Lasioglossum (Eickwortia)");
    expect(names).not.toContain("Lasioglossum alexanderi");
    // A subgenus, a subspecies and a synonym.
    expect(names).not.toContain("Lasioglossum (Dialictus)");
    expect(names).not.toContain("Melecta pacifica fulvida");
    expect(names).not.toContain("Xeromelecta");
    // Scaffolding nobody names a pinned insect by.
    expect(names).not.toContain("Insecta");
  });

  test("are exactly the names adoption accepts, so a name the picker offers is never refused overnight", async () => {
    const offered = (await rows(conn, "SELECT name FROM ecdysis_adoptable WHERE name NOT IN (SELECT scientific_name FROM animal) ORDER BY name")).map(
      (r) => String(r[0]),
    );
    expect(offered.length).toBeGreaterThan(10);
    const adopted = (await adoptEcdysisNames(conn, offered)).map((a) => a.name).sort();
    expect(adopted).toEqual(offered);
  });

  test("leave out what is filed under a name another shares at its rank, but not under one shared at another rank", async () => {
    // Synthetic rows beside the real ones: a species under one of the two
    // Rileya genera, and a genus spelled like the suborder Apocrita, as
    // Ecdysis spells the beetle suborder Polyphaga like a genus.
    await conn.run(`INSERT INTO ecdysis_taxon (tid, rank, name, status, accepted_tid, admitted_parent_tid, fetched_on) VALUES
      (9000001, 'species', 'Rileya alba', 'accepted', 9000001, 95505, DATE '2026-10-24'),
      (9000002, 'genus', 'Apocrita', 'accepted', 9000002, 96610, DATE '2026-10-24')`);
    await rebuildEcdysisAdoptable(conn);
    const names = (await rows(conn, "SELECT name FROM ecdysis_adoptable")).map((r) => r[0]);
    expect(names).not.toContain("Rileya alba");
    // Apocrita is now a spelling two accepted names share, so adoption refuses
    // it, but what is filed under the suborder is still offered.
    expect(names).not.toContain("Apocrita");
    expect(names).toContain("Chrysis");
  });

  test("are rebuilt whenever the thesaurus is loaded", async () => {
    await conn.run("DELETE FROM ecdysis_adoptable");
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    expect(await one("SELECT count(*) FROM ecdysis_adoptable WHERE name = 'Chrysis'")).toBe(1);
  });
});

describe("searching Ecdysis's names", () => {
  const names = async (q: string) => (await searchEcdysisNames(db, q)).map((n) => n.name);

  test("finds the names the tree lacks that start with what is typed, shortest first, with family and order", async () => {
    expect(await searchEcdysisNames(db, "euo")).toEqual([{ tid: 287425, rank: "genus", name: "Euodynerus", family: "Vespidae", order: "Hymenoptera" }]);
    expect(await names("chry")).toEqual(["Chrysis", "Chrysididae", "Chrysidoidea"]);
  });

  test("leaves out bees, names the tree already holds, and queries too short to be worth asking", async () => {
    expect(await names("bomb")).toEqual([]);
    expect(await names("melecta")).toEqual([]);
    expect(await names("hymeno")).toEqual([]);
    expect(await names("ch")).toEqual([]);
  });

  test("leaves out a genus filed straight under Apoidea, which could be a bee", async () => {
    // Synthetic: no such genus is in the fetch of 2026-11-15, but nothing in
    // Ecdysis stops one being entered without a family.
    await conn.run(`INSERT INTO ecdysis_taxon (tid, rank, name, status, accepted_tid, admitted_parent_tid, fetched_on)
                    VALUES (9000003, 'genus', 'Nofamilia', 'accepted', 9000003, 83534, DATE '2026-10-24')`);
    await rebuildEcdysisAdoptable(conn);
    expect(await rows(conn, "SELECT family, superfamily FROM ecdysis_adoptable WHERE name = 'Nofamilia'")).toEqual([[null, "Apoidea"]]);
    expect(await names("nofam")).toEqual([]);
  });

  test("matches later words against later words of the name, in order", async () => {
    await conn.run("DELETE FROM animal WHERE scientific_name = 'Apidae'");
    // With Apidae gone from the tree a bee is still a bee: the family says so.
    expect(await names("bombus vos")).toEqual([]);
    expect(await names("chrysis z")).toEqual([]);
  });
});

describe("a draft that names a taxon from Ecdysis", () => {
  let ada: number;
  let specimen: number;

  beforeEach(async () => {
    ada = await one(`INSERT INTO person (display_name) VALUES ('Ada Adams') RETURNING entity_id`);
    const sample = await insertCleanSample(conn, { collector_id: String(ada), sample_number: "'1'" });
    specimen = await one(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sample}, 1, '26000101') RETURNING entity_id`);
  });

  const write = (tid: number | null, animalId: number | null = null) =>
    saveDrafts(db, ada, ada, [{ specimenId: specimen, animalId, ecdysisTid: tid, sex: "female", caste: null }]);

  test("is saved with the Ecdysis id, adds nothing to the tree, and is named on the page", async () => {
    const [row] = await write(287425);
    expect(row!.draft).toMatchObject({ animalId: null, ecdysisTid: 287425, sex: "female" });
    expect(await one("SELECT count(*) FROM animal WHERE scientific_name = 'Euodynerus'")).toBe(0);
    expect(await rowTaxa(db, [row!])).toEqual({ [ecdysisKey(287425)]: { name: "Euodynerus", rank: "genus", castes: false } });
    // Named, as far as what is left to do goes: the season and the front page's note count it done.
    expect(await entrySeasons(db, ada, ada)).toEqual([{ season: CURRENT_SEASON, specimens: 1, unnamed: 0 }]);
  });

  test("is refused for a bee, a name the search would not offer, or with a node of the tree as well", async () => {
    await expect(write(173433)).rejects.toBeInstanceOf(UnknownTaxon);
    await expect(write(95505)).rejects.toBeInstanceOf(UnknownTaxon);
    await expect(write(999999999)).rejects.toBeInstanceOf(UnknownTaxon);
    const apidae = await one("SELECT entity_id FROM animal WHERE scientific_name = 'Apidae'");
    await expect(write(287425, apidae)).rejects.toBeInstanceOf(BadRequest);
  });

  test("names the node instead once the tree holds the name", async () => {
    await adoptEcdysisNames(conn, ["Euodynerus"]);
    const node = await one("SELECT entity_id FROM animal WHERE scientific_name = 'Euodynerus'");
    const [row] = await write(287425);
    expect(row!.draft).toMatchObject({ animalId: node, ecdysisTid: null });
  });

  test("is adopted into the tree overnight and recorded against the new node", async () => {
    await write(287425);
    const result = await commitDeterminationDrafts(conn);
    expect(result).toMatchObject({ committed: 1, waiting: 0, adopted: ["Euodynerus"], unadoptable: 0 });
    expect(
      await rows(
        conn,
        `SELECT a.scientific_name, p.scientific_name, d.verbatim_identification, d.channel
         FROM determination d JOIN animal a ON a.entity_id = d.animal_id JOIN animal p ON p.entity_id = a.parent_id`,
      ),
    ).toEqual([["Euodynerus", "Vespidae", "Euodynerus", "in_app"]]);
    expect(await one("SELECT count(*) FROM determination_draft")).toBe(0);
  });

  test("changed to another name before the night adds nothing to the tree", async () => {
    await write(287425);
    const apidae = await one("SELECT entity_id FROM animal WHERE scientific_name = 'Apidae'");
    await write(null, apidae);
    const result = await commitDeterminationDrafts(conn);
    expect(result.adopted).toEqual([]);
    expect(await one("SELECT count(*) FROM animal WHERE scientific_name IN ('Euodynerus', 'Vespidae')")).toBe(0);
  });

  test("waits, and is counted, when a later fetch no longer offers its name", async () => {
    await write(287425);
    await conn.run("DELETE FROM ecdysis_adoptable WHERE tid = 287425");
    const result = await commitDeterminationDrafts(conn);
    expect(result).toMatchObject({ committed: 0, waiting: 1, adopted: [], unadoptable: 1 });
    const [row] = await seasonRows(db, ada, ada, CURRENT_SEASON);
    expect(row!.draft).toMatchObject({ ecdysisTid: 287425 });
  });
});
