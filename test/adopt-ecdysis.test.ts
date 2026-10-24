import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, test } from "vitest";
import { adoptEcdysisNames } from "../src/adopt-ecdysis.js";
import { loadEcdysisTaxonomy } from "../src/load-ecdysis-taxonomy.js";
import { createMemoryDb, rows } from "./helpers.js";

/**
 * Adopting the names Ecdysis accepts into the tree (beeline-45v.1.1, from
 * Ecdysis since beeline-7gob). The fixture's rows are real rows of the fetch
 * of 2026-10-24 (test/fixtures/ecdysis-taxonomy/): the chain from Chrysis up
 * to Hymenoptera, which passes through a superfamily and a suborder the tree
 * does not hold and an infraorder (Aculeata) the store does not admit;
 * Melecta pacifica, below a tribe and a subfamily; Lasioglossum tenax, which
 * Ecdysis files under a subgenus; a subspecies; and the Rileya homonym.
 */

const ECDYSIS_TAXONOMY = new URL("./fixtures/ecdysis-taxonomy/", import.meta.url).pathname;

let conn: DuckDBConnection;

async function node(rank: string, name: string, parent: string | null): Promise<void> {
  await conn.run(
    `INSERT INTO animal (rank, scientific_name, parent_id)
     SELECT '${rank}', '${name}', ${parent === null ? "NULL" : `(SELECT entity_id FROM animal WHERE scientific_name = '${parent}')`}`,
  );
}

const lineage = (name: string) =>
  rows(
    conn,
    `WITH RECURSIVE up AS (
       SELECT entity_id, parent_id, rank, scientific_name, ecdysis_tid, 0 AS d FROM animal WHERE scientific_name = '${name}'
       UNION ALL SELECT a.entity_id, a.parent_id, a.rank, a.scientific_name, a.ecdysis_tid, up.d + 1 FROM up JOIN animal a ON a.entity_id = up.parent_id)
     SELECT rank, scientific_name, CAST(ecdysis_tid AS INTEGER) FROM up ORDER BY d`,
  );

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await node("kingdom", "Animalia", null);
  await node("phylum", "Arthropoda", "Animalia");
  await node("class", "Insecta", "Arthropoda");
  await node("order", "Hymenoptera", "Insecta");
  await node("family", "Apidae", "Hymenoptera");
  await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
});

describe("adopting Ecdysis names", () => {
  test("a name Ecdysis accepts comes in with the ancestors the tree lacks, each with its id", async () => {
    const adopted = await adoptEcdysisNames(conn, ["Chrysis"]);
    expect(adopted).toEqual([{ name: "Chrysis", rank: "genus", tid: 106248, ancestors: ["Chrysididae", "Chrysidoidea", "Apocrita"] }]);
    expect(await lineage("Chrysis")).toEqual([
      ["genus", "Chrysis", 106248],
      ["family", "Chrysididae", 87753],
      ["superfamily", "Chrysidoidea", 83737],
      ["suborder", "Apocrita", 82762],
      ["order", "Hymenoptera", 82681],
      ["class", "Insecta", 6],
      ["phylum", "Arthropoda", 2],
      ["kingdom", "Animalia", 1],
    ]);
    expect(await rows(conn, "SELECT authorship FROM animal WHERE scientific_name = 'Chrysis'")).toEqual([["Linnaeus, 1761"]]);
    expect(await rows(conn, "SELECT count(*) FROM animal_ecdysis_stale")).toEqual([[0n]]);
  });

  test("two names sharing ancestors create each ancestor once; adopting again creates nothing", async () => {
    const adopted = await adoptEcdysisNames(conn, ["Chrysis", "Chrysididae", "Melecta pacifica"]);
    expect(adopted.map((a) => a.name)).toEqual(["Chrysididae", "Chrysis", "Melecta pacifica"]);
    // Past the tribe Melectini and the subfamily Nomadinae, which the store does not admit.
    expect(await lineage("Melecta pacifica")).toEqual([
      ["species", "Melecta pacifica", 251489],
      ["genus", "Melecta", 189579],
      ["family", "Apidae", 86587],
      ["order", "Hymenoptera", 82681],
      ["class", "Insecta", 6],
      ["phylum", "Arthropoda", 2],
      ["kingdom", "Animalia", 1],
    ]);
    const before = await rows(conn, "SELECT count(*) FROM animal");
    expect(await adoptEcdysisNames(conn, ["Chrysis", "Chrysididae", "Melecta pacifica"])).toEqual([]);
    expect(await rows(conn, "SELECT count(*) FROM animal")).toEqual(before);
  });

  test("a species Ecdysis files under a subgenus is filed under its genus, as the tree's own species are", async () => {
    const adopted = await adoptEcdysisNames(conn, ["Lasioglossum tenax"]);
    expect(adopted).toEqual([
      { name: "Lasioglossum tenax", rank: "species", tid: 248008, ancestors: ["Lasioglossum", "Halictidae", "Apoidea", "Apocrita"] },
    ]);
    expect(await rows(conn, "SELECT count(*) FROM animal WHERE rank = 'subgenus'")).toEqual([[0n]]);
  });

  test("a species Ecdysis files under a synonym comes in under the name Ecdysis accepts", async () => {
    // Xeromelecta larreae sits under Xeromelecta, which Ecdysis files under
    // Brachymelecta: adopting it must not mint a node for Xeromelecta.
    const adopted = await adoptEcdysisNames(conn, ["Xeromelecta larreae"]);
    expect(adopted).toEqual([{ name: "Xeromelecta larreae", rank: "species", tid: 1646716, ancestors: ["Brachymelecta"] }]);
    expect(await rows(conn, "SELECT count(*) FROM animal WHERE scientific_name = 'Xeromelecta'")).toEqual([[0n]]);
  });

  test("a genus Ecdysis spells like a subgenus, and what is filed below it, are left for a person", async () => {
    // Lasioglossum (Eickwortia) is a genus in Ecdysis, directly under
    // Halictidae; the tree's subgenera are leaves under their genus.
    expect(await adoptEcdysisNames(conn, ["Lasioglossum (Eickwortia)", "Lasioglossum alexanderi"])).toEqual([]);
    expect(await rows(conn, "SELECT count(*) FROM animal")).toEqual([[5n]]);
  });

  test("a homonym, a subspecies and a name Ecdysis lacks are left for a taxonomist", async () => {
    // Rileya: two accepted genera at one spelling. Subspecies: whether the
    // program records them is undecided (beeline-45v.1.2). Lasioglossum
    // aspilurum is not in Ecdysis at all.
    expect(await adoptEcdysisNames(conn, ["Rileya", "Melecta pacifica fulvida", "Lasioglossum aspilurum"])).toEqual([]);
    expect(await rows(conn, "SELECT count(*) FROM animal")).toEqual([[5n]]);
  });

  test("a name holding anything but ASCII is not adopted", async () => {
    // A real Diptera name as Ecdysis stores it, double-encoded (taxon 102413,
    // 'Acanthiophilus köhleri'), placed here under Hymenoptera for the test:
    // the Code admits no diacritics, so this is damaged text, not a name.
    await conn.run(`INSERT INTO ecdysis_taxon (tid, rank, name, status, accepted_tid, admitted_parent_tid, fetched_on)
                    VALUES (102413, 'species', 'Acanthiophilus kÃÂ¶hleri', 'accepted', 102413, 82681, DATE '2026-10-24')`);
    expect(await adoptEcdysisNames(conn, ["Acanthiophilus kÃÂ¶hleri"])).toEqual([]);
  });

  test("a name the tree already spells, at any rank, is not adopted again", async () => {
    await node("superfamily", "Chrysidoidea", "Hymenoptera");
    expect(await adoptEcdysisNames(conn, ["Chrysidoidea"])).toEqual([]);
    // And a name below it hangs from that node rather than a second one.
    expect(await adoptEcdysisNames(conn, ["Chrysididae"])).toEqual([{ name: "Chrysididae", rank: "family", tid: 87753, ancestors: [] }]);
    expect(await rows(conn, "SELECT count(*) FROM animal WHERE scientific_name = 'Chrysidoidea'")).toEqual([[1n]]);
  });
});
