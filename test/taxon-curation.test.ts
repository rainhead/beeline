import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { createMemoryDb, rows } from "./helpers.js";
import { loadItis } from "../src/load-itis.js";
import { decide, itisFromStore, mergeDecisions, parseBatch, type DecideContext } from "../src/taxon-decide.js";
import {
  applyTaxonCuration,
  CURATED_TAXON_CURATION,
  formatTaxonCuration,
  impliedParent,
  parseTaxonCuration,
  type TaxonCurationRow,
} from "../src/taxon-curation.js";

/**
 * The curation layer over ITIS (beeline-45v.1): a file of taxonomists'
 * decisions, replayed onto the tree, honoured by the ITIS match, and checked
 * against each release. The ITIS rows are the real ones from
 * test/fixtures/itis-taxon.csv (release of 2026-08-26): Lasioglossum zonulum
 * is outdated there for zonulus, Hoplitis truncata is two current names, and
 * no bee subgenus exists.
 */

const FILES = {
  taxonCsv: new URL("./fixtures/itis-taxon.csv", import.meta.url).pathname,
  synonymCsv: new URL("./fixtures/itis-synonym.csv", import.meta.url).pathname,
};

const row = (over: Partial<TaxonCurationRow>): TaxonCurationRow => ({
  kind: "addition",
  rank: "subgenus",
  name: "Lasioglossum (Dialictus)",
  parent_rank: "",
  parent_name: "",
  itis_tsn: "",
  itis_current_name: "",
  itis_release: "2026-08-26",
  taxonomist: "L. Best",
  decided_on: "2026-10-09",
  reference: "",
  reason: "ITIS carries no subgenera for Halictidae",
  ...over,
});

const DEPARTURE = row({
  kind: "departure",
  rank: "species",
  name: "Lasioglossum zonulum",
  itis_tsn: "759593",
  itis_current_name: "Lasioglossum zonulus",
  reference: "https://doi.org/10.0000/example",
  reason: "the program keeps the neuter ending pending Gibbs",
});

const HOMONYM = row({
  kind: "homonym",
  rank: "species",
  name: "Hoplitis truncata",
  itis_tsn: "715497",
  reason: "Cresson's: the Nearctic species",
});

describe("the curation file", () => {
  test("the checked-in file parses", async () => {
    expect(() => parseTaxonCuration("", CURATED_TAXON_CURATION)).not.toThrow();
    const text = await readFile(CURATED_TAXON_CURATION, "utf8");
    expect(Array.isArray(parseTaxonCuration(text, CURATED_TAXON_CURATION))).toBe(true);
  });

  test("round-trips through its own writer, quotes and all", () => {
    const rows = [row({}), DEPARTURE, row({ kind: "homonym", rank: "species", name: "Hoplitis truncata", itis_tsn: "715497", reason: 'Cresson, 1878 — the "western" one' })];
    expect(parseTaxonCuration(formatTaxonCuration(rows), "mem")).toEqual(rows);
  });

  test.each<[string, Partial<TaxonCurationRow>]>([
    ["names the taxonomist", { taxonomist: " " }],
    ["says why", { reason: "" }],
    ["is not a kind", { kind: "adopt" as never }],
    ["an addition has no ITIS TSN", { itis_tsn: "12" }],
    ["a departure needs the ITIS TSN", { kind: "departure", itis_current_name: "X" }],
    ["a departure says what ITIS calls the name", { kind: "departure", itis_tsn: "12" }],
    ["a homonym resolution has no ITIS current name", { kind: "homonym", itis_tsn: "12", itis_current_name: "X" }],
    ["go together", { parent_rank: "genus" }],
    ["is not a date", { decided_on: "Oct 9" }],
    ["is not a date", { itis_release: "2026-13-45" }],
  ])("refuses a row that %s", (_, over) => {
    expect(() => parseTaxonCuration(formatTaxonCuration([row(over)]), "mem")).toThrow(/line 2/);
  });

  test("refuses a name decided twice", () => {
    expect(() => parseTaxonCuration(formatTaxonCuration([row({}), row({ reason: "again" })]), "mem")).toThrow(/decided twice/);
  });

  test("a name says where it goes, where it does", () => {
    expect(impliedParent("species", "Agapostemon subtilior")).toEqual({ rank: "genus", name: "Agapostemon" });
    expect(impliedParent("subgenus", "Lasioglossum (Dialictus)")).toEqual({ rank: "genus", name: "Lasioglossum" });
    expect(impliedParent("subspecies", "Colletes consors pascoensis")).toEqual({ rank: "species", name: "Colletes consors" });
    expect(impliedParent("genus", "Brachymelecta")).toBeNull();
    expect(impliedParent("species", "Triepeolus verbesinae complex")).toBeNull();
  });
});

describe("replaying decisions onto a store", () => {
  let conn: DuckDBConnection;
  const node = (rank: string, name: string) =>
    conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('${rank}', '${name}')`);

  beforeEach(async () => {
    ({ conn } = await createMemoryDb());
    await node("genus", "Lasioglossum");
    await node("species", "Lasioglossum zonulum");
    await node("species", "Hoplitis truncata");
    await loadItis(conn, FILES);
  });

  test("creates a missing node under the parent its name implies, and places nothing it cannot", async () => {
    const result = await applyTaxonCuration(conn, [
      row({}),
      row({ rank: "species", name: "Agapostemon subtilior", reason: "ITIS lags" }),
      row({ rank: "genus", name: "Brachymelecta", reason: "ITIS has only Xeromelecta" }),
      row({ rank: "genus", name: "Protandrena", parent_rank: "family", parent_name: "Andrenidae", reason: "not in ITIS at all" }),
    ]);
    expect(result).toMatchObject({ applied: 1, created: 1 });
    expect(result.unplaced.map((u) => [u.name, u.problem])).toEqual([
      ["Agapostemon subtilior", "its genus 'Agapostemon' is not in the tree"],
      ["Brachymelecta", "the name does not say where it goes: give parent_rank and parent_name"],
      ["Protandrena", "its family 'Andrenidae' is not in the tree"],
    ]);
    expect(
      await rows(conn, "SELECT p.scientific_name FROM animal a JOIN animal p ON p.entity_id = a.parent_id WHERE a.scientific_name = 'Lasioglossum (Dialictus)'"),
    ).toEqual([["Lasioglossum"]]);
    expect(await rows(conn, "SELECT standing FROM animal_itis WHERE scientific_name = 'Lasioglossum (Dialictus)'")).toEqual([["absent"]]);
  });

  test("a homonym resolution is what the node matches; a departure leaves ITIS's view of the name alone", async () => {
    expect(await rows(conn, "SELECT standing, itis_tsn FROM animal_itis WHERE scientific_name = 'Hoplitis truncata'")).toEqual([["homonym", null]]);
    const result = await applyTaxonCuration(conn, [DEPARTURE, HOMONYM]);
    expect(result).toMatchObject({ applied: 2, created: 0, unplaced: [] });
    expect(await rows(conn, "SELECT standing, itis_tsn FROM animal_itis WHERE scientific_name = 'Hoplitis truncata'")).toEqual([["valid", 715497n]]);
    expect(await rows(conn, "SELECT standing, itis_tsn, current_name FROM animal_itis WHERE scientific_name = 'Lasioglossum zonulum'")).toEqual([
      ["synonym", 759593n, "Lasioglossum zonulus"],
    ]);
    expect(await rows(conn, "SELECT entity_id FROM animal_itis_stale")).toEqual([]);
    expect(await rows(conn, "SELECT animal_id FROM animal_curation_stale")).toEqual([]);
  });

  test("a choice ITIS no longer offers is not honoured, and is named", async () => {
    await applyTaxonCuration(conn, [row({ ...HOMONYM, itis_tsn: "999" })]);
    expect(await rows(conn, "SELECT standing, itis_tsn FROM animal_itis WHERE scientific_name = 'Hoplitis truncata'")).toEqual([["homonym", null]]);
    expect(await rows(conn, "SELECT problem FROM animal_curation_stale")).toEqual([["ITIS no longer carries the chosen TSN 999"]]);
  });

  test("a choice that is a current name for something else is not honoured, and says what it names", async () => {
    // 759441 is Lasioglossum tenax, current — and not Hoplitis truncata.
    await applyTaxonCuration(conn, [row({ ...HOMONYM, itis_tsn: "759441" })]);
    expect(await rows(conn, "SELECT standing, itis_tsn FROM animal_itis WHERE scientific_name = 'Hoplitis truncata'")).toEqual([["homonym", null]]);
    expect(await rows(conn, "SELECT problem FROM animal_curation_stale")).toEqual([
      ["the chosen TSN 759441 is Lasioglossum tenax (species), not a name at this rank and spelling"],
    ]);
  });

  test("with ITIS not loaded there is nothing to compare, so nothing is stale", async () => {
    await conn.run("DELETE FROM itis_synonym; DELETE FROM itis_taxon");
    await applyTaxonCuration(conn, [row({}), DEPARTURE, HOMONYM]);
    expect(await rows(conn, "SELECT animal_id FROM animal_curation_stale")).toEqual([]);
    expect(await rows(conn, "SELECT DISTINCT standing FROM animal_itis")).toEqual([["not loaded"]]);
  });

  test("restates the table wholesale, so a row dropped from the file leaves the store", async () => {
    await applyTaxonCuration(conn, [DEPARTURE, HOMONYM]);
    await applyTaxonCuration(conn, [HOMONYM]);
    expect(await rows(conn, "SELECT kind FROM animal_curation")).toEqual([["homonym"]]);
  });

  test("a later release moving from under a decision is reported, per kind", async () => {
    await applyTaxonCuration(conn, [row({}), DEPARTURE, HOMONYM]);
    // ITIS gains the subgenus, accepts zonulum again, and drops Wu's truncata.
    await conn.run(`INSERT INTO itis_taxon VALUES (9000001, 'subgenus', 'Lasioglossum (Dialictus)', 'valid', 'Robertson, 1902', 154357, DATE '2026-11-30')`);
    await conn.run(`UPDATE itis_taxon SET usage = 'valid', itis_as_of = DATE '2026-11-30' WHERE tsn = 759593`);
    await conn.run(`DELETE FROM itis_taxon WHERE tsn = 756786`);
    expect(await rows(conn, "SELECT scientific_name, kind, itis_as_of::VARCHAR, problem FROM animal_curation_stale ORDER BY scientific_name")).toEqual([
      ["Hoplitis truncata", "homonym", "2026-11-30", "ITIS now has one current name at this spelling: the choice is no longer needed"],
      ["Lasioglossum (Dialictus)", "addition", "2026-11-30", "ITIS now has this name as current (TSN 9000001)"],
      ["Lasioglossum zonulum", "departure", "2026-11-30", "ITIS now accepts this name: the departure can be retired"],
    ]);
  });

  test("a departure ITIS has renamed again says what it calls it now", async () => {
    await applyTaxonCuration(conn, [DEPARTURE]);
    await conn.run(`UPDATE itis_taxon SET name = 'Lasioglossum zonulatum' WHERE tsn = 1252729`);
    expect(await rows(conn, "SELECT problem FROM animal_curation_stale")).toEqual([
      ["ITIS now calls it Lasioglossum zonulatum, not Lasioglossum zonulus"],
    ]);
  });
});

describe("recording a decision", () => {
  const itis: DecideContext["itis"] = async (rank, name) => {
    if (name === "Lasioglossum zonulum") return { standing: "synonym", tsn: "759593", currentName: "Lasioglossum zonulus", candidates: [{ tsn: "759593", author: "(Smith, 1848)", usage: "invalid" }] };
    if (name === "Hoplitis truncata")
      return {
        standing: "homonym", tsn: null, currentName: null,
        candidates: [{ tsn: "715497", author: "(Cresson, 1878)", usage: "valid" }, { tsn: "756786", author: "Wu, 1992", usage: "valid" }],
      };
    if (name === "Lasioglossum tenax") return { standing: "valid", tsn: "759441", currentName: null, candidates: [{ tsn: "759441", author: "(Sandhouse, 1924)", usage: "valid" }] };
    return { standing: "absent", tsn: null, currentName: null, candidates: [] };
  };
  const ctx: DecideContext = { itisRelease: "2026-08-26", today: "2026-10-09", itis };
  const said = { taxonomist: "L. Best", reason: "keep, pending Gibbs 2011 (by email, 2026-10-07)" };

  test("fills in what ITIS said, and nothing the reader typed", async () => {
    expect(await decide({ kind: "addition", rank: "subgenus", name: "Lasioglossum (Dialictus)", ...said }, ctx)).toEqual(
      row({ reason: said.reason }),
    );
    expect(await decide({ kind: "departure", rank: "species", name: "Lasioglossum zonulum", ...said, reference: "10.11646/zootaxa.3073.1.1" }, ctx)).toEqual(
      row({ kind: "departure", rank: "species", name: "Lasioglossum zonulum", itis_tsn: "759593", itis_current_name: "Lasioglossum zonulus", reference: "10.11646/zootaxa.3073.1.1", reason: said.reason }),
    );
    expect(await decide({ kind: "homonym", rank: "species", name: "Hoplitis truncata", tsn: "715497", ...said, decidedOn: "2026-10-12" }, ctx)).toEqual(
      row({ kind: "homonym", rank: "species", name: "Hoplitis truncata", itis_tsn: "715497", reason: said.reason, decided_on: "2026-10-12" }),
    );
    expect(await decide({ kind: "addition", rank: "genus", name: "Brachymelecta", parent: { rank: "family", name: "Apidae" }, ...said }, ctx)).toMatchObject({
      parent_rank: "family", parent_name: "Apidae",
    });
  });

  test("refuses a decision the ITIS tables contradict, saying what they hold", async () => {
    await expect(decide({ kind: "addition", rank: "species", name: "Lasioglossum tenax", ...said }, ctx)).rejects.toThrow(/ITIS has this name \(valid: \(Sandhouse, 1924\) \[TSN 759441, valid\]\), so it is not an addition/);
    await expect(decide({ kind: "departure", rank: "species", name: "Lasioglossum tenax", ...said }, ctx)).rejects.toThrow(/does not call this name outdated \(valid/);
    await expect(decide({ kind: "departure", rank: "subgenus", name: "Lasioglossum (Dialictus)", ...said }, ctx)).rejects.toThrow(/\(absent\), so there is nothing to depart from/);
    await expect(decide({ kind: "homonym", rank: "species", name: "Lasioglossum tenax", tsn: "759441", ...said }, ctx)).rejects.toThrow(/1 current name at this spelling, so there is no choice/);
    await expect(decide({ kind: "homonym", rank: "species", name: "Hoplitis truncata", ...said }, ctx)).rejects.toThrow(/say which with --tsn, one of: \(Cresson, 1878\) \[TSN 715497, valid\] \| Wu, 1992 \[TSN 756786, valid\]/);
    await expect(decide({ kind: "homonym", rank: "species", name: "Hoplitis truncata", tsn: "759441", ...said }, ctx)).rejects.toThrow(/say which with --tsn/);
  });

  test("and a row the file would refuse: no reason, no taxonomist", async () => {
    await expect(decide({ kind: "addition", rank: "subgenus", name: "Lasioglossum (Dialictus)", taxonomist: "L. Best", reason: " " }, ctx)).rejects.toThrow(/every row says why/);
    await expect(decide({ kind: "addition", rank: "subgenus", name: "Lasioglossum (Dialictus)", taxonomist: "", reason: "x" }, ctx)).rejects.toThrow(/names the taxonomist/);
  });

  test("the ITIS answer a decision is checked against comes from the store, by the tables alone", async () => {
    const { conn } = await createMemoryDb();
    await loadItis(conn, FILES);
    const fromStore = itisFromStore(conn);
    expect(await fromStore("species", "Lasioglossum zonulum")).toMatchObject({ standing: "synonym", tsn: "759593", currentName: "Lasioglossum zonulus" });
    expect(await fromStore("species", "Hoplitis truncata")).toMatchObject({ standing: "homonym", tsn: null });
    expect((await fromStore("species", "Hoplitis truncata")).candidates.map((c) => c.author)).toEqual(["(Cresson, 1878)", "Wu, 1992"]);
    expect(await fromStore("subgenus", "Lasioglossum (Dialictus)")).toMatchObject({ standing: "absent", candidates: [] });
    expect(await fromStore("species", "Lasioglossum tenax")).toMatchObject({ standing: "valid", tsn: "759441" });
  });

  test("a batch is one signature over many lines, and a bad line is a bad batch", () => {
    const batch = parseBatch(
      [
        "kind,rank,name,reason,reference",
        'addition,subgenus,Lasioglossum (Dialictus),"as proposed; confirmed by email 2026-10-07",',
        "departure,species,Lasioglossum zonulum,as proposed,10.11646/zootaxa.3073.1.1",
      ].join("\n"),
      "mem",
    );
    expect(batch).toEqual([
      { kind: "addition", rank: "subgenus", name: "Lasioglossum (Dialictus)", reason: "as proposed; confirmed by email 2026-10-07", reference: undefined, tsn: undefined, parent: undefined },
      { kind: "departure", rank: "species", name: "Lasioglossum zonulum", reason: "as proposed", reference: "10.11646/zootaxa.3073.1.1", tsn: undefined, parent: undefined },
    ]);
    expect(() => parseBatch("kind,rank,name\naddition,species,X y", "mem")).toThrow(/no column 'reason'/);
    expect(() => parseBatch("kind,rank,name,reason,taxonomist\n", "mem")).toThrow(/'taxonomist' is not a column/);
    expect(() => parseBatch("kind,rank,name,reason\nadopt,species,X y,why", "mem")).toThrow(/line 2: 'adopt' is not a kind/);
  });

  test("merging supersedes a decision about the same name and keeps the rest; one batch deciding a name twice is refused", () => {
    const merged = mergeDecisions([row({}), DEPARTURE], [row({ reason: "revised" }), HOMONYM]);
    expect(merged.map((r) => [r.name, r.reason])).toEqual([
      ["Lasioglossum (Dialictus)", "revised"],
      ["Lasioglossum zonulum", DEPARTURE.reason],
      ["Hoplitis truncata", HOMONYM.reason],
    ]);
    expect(() => mergeDecisions([], [row({}), row({ reason: "again" })])).toThrow(/Lasioglossum \(Dialictus\) \(subgenus\): decided twice in one batch/);
  });

  test("a snapshot names each tab's file apart, however the titles sanitise", async () => {
    const { snapshotFileNames } = await import("../src/fetch-taxon-sheet.js");
    expect(snapshotFileNames(["Read me", "1 Names ITIS does not have", "A B", "A-B", "!!!"])).toEqual([
      "read-me.csv", "1-names-itis-does-not-have.csv", "a-b.csv", "a-b-2.csv", "tab.csv",
    ]);
  });
});
