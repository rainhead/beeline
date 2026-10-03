import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { createMemoryDb, rows } from "./helpers.js";
import { loadItis } from "../src/load-itis.js";
import {
  chooseCandidate,
  decisionsFromTabs,
  itisFromStore,
  mergeDecisions,
  tabKind,
  type DecisionContext,
  type SheetTab,
} from "../src/fetch-taxon-decisions.js";
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

  test("the ITIS answer a decision is checked against comes from the store", async () => {
    const itis = itisFromStore(conn);
    expect(await itis("species", "Lasioglossum zonulum")).toMatchObject({ standing: "synonym", tsn: "759593", currentName: "Lasioglossum zonulus" });
    expect(await itis("species", "Hoplitis truncata")).toMatchObject({ standing: "homonym", tsn: null });
    expect((await itis("species", "Hoplitis truncata")).candidates.map((c) => c.author)).toEqual(["(Cresson, 1878)", "Wu, 1992"]);
    expect(await itis("subgenus", "Lasioglossum (Dialictus)")).toMatchObject({ standing: "absent", candidates: [] });
    expect(await itis("species", "Lasioglossum tenax")).toMatchObject({ standing: "valid", tsn: "759441" });
  });
});

describe("reading the taxonomist's sheet", () => {
  const itis: DecisionContext["itis"] = async (rank, name) => {
    if (name === "Lasioglossum zonulum") return { standing: "synonym", tsn: "759593", currentName: "Lasioglossum zonulus", candidates: [] };
    if (name === "Hoplitis truncata")
      return {
        standing: "homonym", tsn: null, currentName: null,
        candidates: [{ tsn: "715497", author: "(Cresson, 1878)", usage: "valid" }, { tsn: "756786", author: "Wu, 1992", usage: "valid" }],
      };
    if (name === "Lasioglossum tenax") return { standing: "valid", tsn: "759441", currentName: null, candidates: [] };
    return { standing: "absent", tsn: null, currentName: null, candidates: [] };
  };
  const ctx: DecisionContext = { itisRelease: "2026-08-26", decidedOn: "2026-10-09", itis };

  const ABSENT: SheetTab = {
    title: "1 Names ITIS does not have",
    rows: [
      ["Rank", "Name", "Family", "On the checklist", "Specimens", "by experts", "by volunteers", "this season", "Mostly by", "What it looks like", "Your decision", "Decided by", "Reference (DOI or link)", "Notes"],
      ["subgenus", "Lasioglossum (Dialictus)", "Halictidae", "no", "1735", "1735", "0", "0", "J.D.Engler", "Keep: ITIS has no subgenera", "Keep: ITIS lags", "L. Best", "", "Gibbs 2011 treats Dialictus as a subgenus"],
      ["species", "Agapostemon subtilior", "Halictidae", "yes", "1802", "1768", "34", "0", "L.R.Best", "", "Keep: ITIS lags", "", "", ""],
      ["species", "Lasioglossum tenax", "Halictidae", "no", "1", "1", "0", "0", "", "", "Keep: ITIS lags", "L. Best", "", ""],
      ["species", "Agopostemon texanus", "Halictidae", "no", "3", "3", "0", "0", "", "", "Misspelling (say of what in Notes)", "L. Best", "", "Agapostemon texanus"],
      ["species", "Triepeolus verbesinae complex", "Apidae", "no", "32", "32", "0", "0", "L.R.Best", "", "Not a taxon: morphospecies or species group", "L. Best", "", ""],
      ["species", "Osmia caraformis", "Megachilidae", "no", "9", "9", "0", "0", "", "", "", "", "", ""],
    ],
  };
  const RENAME: SheetTab = {
    title: "2 Names ITIS would rename",
    rows: [
      ["Rank", "Program's name", "ITIS's name", "Family", "On the checklist", "Same genus", "Specimens", "by experts", "by volunteers", "this season", "Mostly by", "What it looks like", "Your decision", "Decided by", "Reference (DOI or link)", "Notes"],
      ["species", "Lasioglossum zonulum", "Lasioglossum zonulus", "Halictidae", "yes", "yes", "217", "214", "3", "0", "J.D.Engler", "", "Keep the program's name", "L. Best", "https://doi.org/10.0000/x", ""],
      ["species", "Lasioglossum allonotum", "Lasioglossum allonotus", "Halictidae", "no", "yes", "96", "96", "0", "0", "J.D.Engler", "", "Follow ITIS", "L. Best", "", ""],
    ],
  };
  const HOMONYMS: SheetTab = {
    title: "4 Same spelling, two authors",
    rows: [
      ["Rank", "Name", "Family", "On the checklist", "Specimens", "by experts", "Mostly by", "ITIS has", "Which one does the program mean?", "Decided by", "Reference (DOI or link)", "Notes"],
      ["species", "Hoplitis truncata", "Megachilidae", "yes", "0", "0", "", "…", "Cresson's", "L. Best", "", ""],
    ],
  };

  test("tabs are told apart by their number", () => {
    expect(tabKind("1 Names ITIS does not have")).toBe("absent");
    expect(tabKind("2 Names ITIS would rename")).toBe("rename");
    expect(tabKind("6 Wasps")).toBe("wasps");
    expect(tabKind("Read me")).toBeNull();
  });

  test("a free-text choice names one candidate by TSN or by surname", () => {
    const c = [{ tsn: "715497", author: "(Cresson, 1878)", usage: "valid" }, { tsn: "756786", author: "Wu, 1992", usage: "valid" }];
    expect(chooseCandidate("Cresson's", c)).toBe("715497");
    expect(chooseCandidate("TSN 756786", c)).toBe("756786");
    expect(chooseCandidate("the Nearctic one", c)).toBeNull();
    expect(chooseCandidate("Cresson or Wu", c)).toBeNull();
  });

  test("each decision becomes a row, a held line, an alias candidate, or a note", async () => {
    const result = await decisionsFromTabs([ABSENT, RENAME, HOMONYMS], ctx);
    expect(result.rows).toEqual([
      row({ reason: "Gibbs 2011 treats Dialictus as a subgenus" }),
      row({ kind: "departure", rank: "species", name: "Lasioglossum zonulum", itis_tsn: "759593", itis_current_name: "Lasioglossum zonulus", reference: "https://doi.org/10.0000/x", reason: "Keep the program's name" }),
      row({ kind: "homonym", rank: "species", name: "Hoplitis truncata", itis_tsn: "715497", reason: "Cresson's" }),
    ]);
    expect(result.held).toEqual([
      { tab: ABSENT.title, rank: "species", name: "Agapostemon subtilior", problem: "no name in Decided by: every row credits a taxonomist" },
      { tab: ABSENT.title, rank: "species", name: "Lasioglossum tenax", problem: "ITIS now has this name (valid); nothing to add" },
    ]);
    expect(result.followed).toBe(1);
    expect(result.aliasCandidates).toEqual(["species,Agopostemon texanus,Agapostemon texanus,spelling"]);
    expect(result.notes).toEqual(["not a taxon (beeline-8g7): Triepeolus verbesinae complex (species)"]);
  });

  test("the wasps tab asks all three questions, by what its ITIS column says", async () => {
    const wasps: SheetTab = {
      title: "6 Wasps",
      rows: [
        ["Rank", "Name", "Family", "Specimens", "by experts", "Mostly by", "ITIS", "Your decision", "Decided by", "Reference (DOI or link)", "Notes"],
        ["species", "Polistes dominula", "Vespidae", "13", "13", "K.C. Lee", "No entry for this name", "Keep", "K.C. Lee", "", "ITIS still has dominulus"],
        ["species", "Lasioglossum zonulum", "Vespidae", "1", "1", "", "Calls it Lasioglossum zonulus", "Follow ITIS", "K.C. Lee", "", ""],
      ],
    };
    const result = await decisionsFromTabs([wasps], ctx);
    expect(result.rows.map((r) => [r.kind, r.name, r.taxonomist, r.reason])).toEqual([["addition", "Polistes dominula", "K.C. Lee", "ITIS still has dominulus"]]);
    expect(result.followed).toBe(1);
  });

  test("a sheet column the reader needs that is not there is an error, not a silent skip", async () => {
    const tab: SheetTab = { title: "1 x", rows: [["Rank", "Name", "Decided by", "Notes"], ["species", "A b", "x", ""]] };
    await expect(decisionsFromTabs([tab], ctx)).rejects.toThrow(/no column headed 'Reference \(DOI or link\)'/);
  });

  test("merging supersedes a decision about the same name and keeps the rest", () => {
    const merged = mergeDecisions([row({}), DEPARTURE], [row({ reason: "revised" }), HOMONYM]);
    expect(merged.map((r) => [r.name, r.reason])).toEqual([
      ["Lasioglossum (Dialictus)", "revised"],
      ["Lasioglossum zonulum", DEPARTURE.reason],
      ["Hoplitis truncata", HOMONYM.reason],
    ]);
  });
});
