import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { adoptItisNames } from "../src/adopt-itis.js";
import { loadItis } from "../src/load-itis.js";
import { createMemoryDb, rows } from "./helpers.js";

/**
 * Adopting the names ITIS accepts into the tree (beeline-45v.1.1). The
 * fixture's rows are real ITIS rows from the 2026-09-21 release: the chain
 * from Chrysis up to Hymenoptera, which passes through a superfamily and a
 * suborder the tree does not hold and whose ITIS parents (an infraorder, a
 * section) are ranks the extract drops; a subspecies; and the Hoplitis
 * truncata homonym.
 */

const DIR = new URL("./fixtures/itis-adopt/", import.meta.url).pathname;
const FILES = { taxonCsv: `${DIR}itis-taxon.csv`, synonymCsv: `${DIR}itis-synonym.csv` };

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
       SELECT entity_id, parent_id, rank, scientific_name, itis_tsn, 0 AS d FROM animal WHERE scientific_name = '${name}'
       UNION ALL SELECT a.entity_id, a.parent_id, a.rank, a.scientific_name, a.itis_tsn, up.d + 1 FROM up JOIN animal a ON a.entity_id = up.parent_id)
     SELECT rank, scientific_name, CAST(itis_tsn AS INTEGER) FROM up ORDER BY d`,
  );

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await node("kingdom", "Animalia", null);
  await node("phylum", "Arthropoda", "Animalia");
  await node("class", "Insecta", "Arthropoda");
  await node("order", "Hymenoptera", "Insecta");
  await node("family", "Apidae", "Hymenoptera");
  await loadItis(conn, FILES);
});

describe("adopting ITIS names", () => {
  test("a name ITIS accepts comes in with the ancestors the tree lacks, each with its TSN", async () => {
    const adopted = await adoptItisNames(conn, ["Chrysis"]);
    expect(adopted).toEqual([{ name: "Chrysis", rank: "genus", tsn: 154153, ancestors: ["Chrysididae", "Chrysidoidea", "Apocrita"] }]);
    expect(await lineage("Chrysis")).toEqual([
      ["genus", "Chrysis", 154153],
      ["family", "Chrysididae", 154152],
      ["superfamily", "Chrysidoidea", 709265],
      ["suborder", "Apocrita", 152864],
      ["order", "Hymenoptera", 152741],
      ["class", "Insecta", 99208],
      ["phylum", "Arthropoda", 82696],
      ["kingdom", "Animalia", 202423],
    ]);
    expect(await rows(conn, "SELECT authorship FROM animal WHERE scientific_name = 'Chrysis'")).toEqual([["Linnaeus, 1761"]]);
    expect(await rows(conn, "SELECT count(*) FROM animal_itis_stale")).toEqual([[0n]]);
  });

  test("two names sharing ancestors create each ancestor once; adopting again creates nothing", async () => {
    const adopted = await adoptItisNames(conn, ["Chrysis", "Chrysididae", "Melecta pacifica"]);
    expect(adopted.map((a) => a.name)).toEqual(["Chrysididae", "Chrysis", "Melecta pacifica"]);
    expect(await lineage("Melecta pacifica")).toEqual([
      ["species", "Melecta pacifica", 699284],
      ["genus", "Melecta", 154386],
      ["family", "Apidae", 154394],
      ["order", "Hymenoptera", 152741],
      ["class", "Insecta", 99208],
      ["phylum", "Arthropoda", 82696],
      ["kingdom", "Animalia", 202423],
    ]);
    const before = await rows(conn, "SELECT count(*) FROM animal");
    expect(await adoptItisNames(conn, ["Chrysis", "Chrysididae", "Melecta pacifica"])).toEqual([]);
    expect(await rows(conn, "SELECT count(*) FROM animal")).toEqual(before);
  });

  test("a homonym, a subspecies and a name ITIS lacks are left for a taxonomist", async () => {
    // Hoplitis truncata: two current ITIS names at one spelling. Subspecies:
    // whether the program records them is undecided (beeline-45v.1.2).
    expect(await adoptItisNames(conn, ["Hoplitis truncata", "Melecta pacifica fulvida", "Ancistrocerus"])).toEqual([]);
    expect(await rows(conn, "SELECT count(*) FROM animal")).toEqual([[5n]]);
  });

  test("a name the tree already spells, at any rank, is not adopted again", async () => {
    await node("superfamily", "Chrysidoidea", "Hymenoptera");
    expect(await adoptItisNames(conn, ["Chrysidoidea"])).toEqual([]);
    // And a name below it hangs from that node rather than a second one.
    expect(await adoptItisNames(conn, ["Chrysididae"])).toEqual([{ name: "Chrysididae", rank: "family", tsn: 154152, ancestors: [] }]);
    expect(await rows(conn, "SELECT count(*) FROM animal WHERE scientific_name = 'Chrysidoidea'")).toEqual([[1n]]);
  });

  test("an extract made before admitted_parent_tsn still loads, and adopts nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "itis-old-"));
    const lines = (await readFile(FILES.taxonCsv, "utf8")).trimEnd().split("\n");
    // Drop the last column: the extract's shape before the column existed.
    await writeFile(join(dir, "itis-taxon.csv"), lines.map((l) => l.slice(0, l.lastIndexOf(","))).join("\n") + "\n");
    await loadItis(conn, { taxonCsv: join(dir, "itis-taxon.csv"), synonymCsv: FILES.synonymCsv });
    expect(await rows(conn, "SELECT count(*), count(admitted_parent_tsn) FROM itis_taxon")).toEqual([[15n, 0n]]);
    expect(await adoptItisNames(conn, ["Chrysis"])).toEqual([]);
  });
});
