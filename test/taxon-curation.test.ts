import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { createMemoryDb, rows } from "./helpers.js";
import { loadEcdysisTaxonomy } from "../src/load-ecdysis-taxonomy.js";
import { decide, ecdysisFromStore, mergeDecisions, parseBatch, type DecideContext } from "../src/taxon-decide.js";
import {
  applyTaxonCuration,
  CURATED_TAXON_CURATION,
  formatTaxonCuration,
  impliedParent,
  parseTaxonCuration,
  type TaxonCurationRow,
} from "../src/taxon-curation.js";

/**
 * The curation layer over Ecdysis's thesaurus (beeline-45v.1, over ITIS until
 * beeline-7gob): a file of taxonomists' decisions, replayed onto the tree,
 * honoured by the match, and checked against each fetch. The thesaurus rows
 * are the real ones in test/fixtures/ecdysis-taxonomy/ (fetched 2026-10-24):
 * Xeromelecta californica is a synonym there of Brachymelecta californica,
 * Rileya is two accepted genera, and Lasioglossum aspilurum is absent. The
 * decisions themselves are invented: nobody has made these.
 */

const ECDYSIS_TAXONOMY = new URL("./fixtures/ecdysis-taxonomy/", import.meta.url).pathname;

const row = (over: Partial<TaxonCurationRow>): TaxonCurationRow => ({
  kind: "addition",
  rank: "species",
  name: "Lasioglossum aspilurum",
  parent_rank: "",
  parent_name: "",
  ecdysis_tid: "",
  ecdysis_accepted_name: "",
  ecdysis_fetched_on: "2026-10-24",
  taxonomist: "L. Best",
  decided_on: "2026-10-24",
  reference: "",
  reason: "Ecdysis lacks it",
  ...over,
});

const DEPARTURE = row({
  kind: "departure",
  rank: "species",
  name: "Xeromelecta californica",
  ecdysis_tid: "1645055",
  ecdysis_accepted_name: "Brachymelecta californica",
  reference: "https://doi.org/10.0000/example",
  reason: "the program keeps Xeromelecta pending a review",
});

const HOMONYM = row({
  kind: "homonym",
  rank: "genus",
  name: "Rileya",
  ecdysis_tid: "1645743",
  reason: "Ashmead's: the chalcid wasp",
});

describe("the curation file", () => {
  test("the checked-in file parses", async () => {
    expect(() => parseTaxonCuration("", CURATED_TAXON_CURATION)).not.toThrow();
    const text = await readFile(CURATED_TAXON_CURATION, "utf8");
    expect(Array.isArray(parseTaxonCuration(text, CURATED_TAXON_CURATION))).toBe(true);
  });

  test("round-trips through its own writer, quotes and all", () => {
    const rows = [row({}), DEPARTURE, row({ kind: "homonym", rank: "genus", name: "Rileya", ecdysis_tid: "1645743", reason: 'Ashmead, 1888 — the "wasp" one' })];
    expect(parseTaxonCuration(formatTaxonCuration(rows), "mem")).toEqual(rows);
  });

  test.each<[string, Partial<TaxonCurationRow>]>([
    ["names the taxonomist", { taxonomist: " " }],
    ["says why", { reason: "" }],
    ["is not a kind", { kind: "adopt" as never }],
    ["an addition has no Ecdysis id", { ecdysis_tid: "12" }],
    ["a departure needs the Ecdysis id", { kind: "departure", ecdysis_accepted_name: "X" }],
    ["a departure says what Ecdysis files the name under", { kind: "departure", ecdysis_tid: "12" }],
    ["a homonym resolution has no Ecdysis accepted name", { kind: "homonym", ecdysis_tid: "12", ecdysis_accepted_name: "X" }],
    ["go together", { parent_rank: "genus" }],
    ["is not a date", { decided_on: "Oct 9" }],
    ["is not a date", { ecdysis_fetched_on: "2026-13-45" }],
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
    await node("species", "Xeromelecta californica");
    await node("genus", "Rileya");
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
  });

  test("creates a missing node under the parent its name implies, and places nothing it cannot", async () => {
    const result = await applyTaxonCuration(conn, [
      row({}),
      row({ rank: "species", name: "Agapostemon subtilior", reason: "kept" }),
      row({ rank: "genus", name: "Brachymelecta", reason: "kept" }),
      row({ rank: "genus", name: "Protandrena", parent_rank: "family", parent_name: "Andrenidae", reason: "kept" }),
    ]);
    expect(result).toMatchObject({ applied: 1, created: 1 });
    expect(result.unplaced.map((u) => [u.name, u.problem])).toEqual([
      ["Agapostemon subtilior", "its genus 'Agapostemon' is not in the tree"],
      ["Brachymelecta", "the name does not say where it goes: give parent_rank and parent_name"],
      ["Protandrena", "its family 'Andrenidae' is not in the tree"],
    ]);
    expect(
      await rows(conn, "SELECT p.scientific_name FROM animal a JOIN animal p ON p.entity_id = a.parent_id WHERE a.scientific_name = 'Lasioglossum aspilurum'"),
    ).toEqual([["Lasioglossum"]]);
    expect(await rows(conn, "SELECT standing FROM animal_ecdysis WHERE scientific_name = 'Lasioglossum aspilurum'")).toEqual([["absent"]]);
  });

  test("a homonym resolution is what the node matches; a departure leaves Ecdysis's view of the name alone", async () => {
    expect(await rows(conn, "SELECT standing, ecdysis_tid FROM animal_ecdysis WHERE scientific_name = 'Rileya'")).toEqual([["homonym", null]]);
    const result = await applyTaxonCuration(conn, [DEPARTURE, HOMONYM]);
    expect(result).toMatchObject({ applied: 2, created: 0, unplaced: [] });
    expect(await rows(conn, "SELECT standing, ecdysis_tid FROM animal_ecdysis WHERE scientific_name = 'Rileya'")).toEqual([["accepted", 1645743n]]);
    expect(await rows(conn, "SELECT standing, ecdysis_tid, accepted_name FROM animal_ecdysis WHERE scientific_name = 'Xeromelecta californica'")).toEqual([
      ["synonym", 1645055n, "Brachymelecta californica"],
    ]);
    expect(await rows(conn, "SELECT entity_id FROM animal_ecdysis_stale")).toEqual([]);
    expect(await rows(conn, "SELECT animal_id FROM animal_curation_stale")).toEqual([]);
  });

  test("a choice Ecdysis no longer offers is not honoured, and is named", async () => {
    await applyTaxonCuration(conn, [row({ ...HOMONYM, ecdysis_tid: "999" })]);
    expect(await rows(conn, "SELECT standing, ecdysis_tid FROM animal_ecdysis WHERE scientific_name = 'Rileya'")).toEqual([["homonym", null]]);
    expect(await rows(conn, "SELECT problem FROM animal_curation_stale")).toEqual([["Ecdysis no longer carries the chosen taxon 999"]]);
  });

  test("a choice that is an accepted name for something else is not honoured, and says what it names", async () => {
    // 248008 is Lasioglossum tenax, accepted — and not Rileya.
    await applyTaxonCuration(conn, [row({ ...HOMONYM, ecdysis_tid: "248008" })]);
    expect(await rows(conn, "SELECT standing, ecdysis_tid FROM animal_ecdysis WHERE scientific_name = 'Rileya'")).toEqual([["homonym", null]]);
    expect(await rows(conn, "SELECT problem FROM animal_curation_stale")).toEqual([
      ["the chosen taxon 248008 is Lasioglossum tenax (species), not a name at this rank and spelling"],
    ]);
  });

  test("with the thesaurus not loaded there is nothing to compare, so nothing is stale", async () => {
    await conn.run("DELETE FROM ecdysis_taxon");
    await applyTaxonCuration(conn, [row({}), DEPARTURE, HOMONYM]);
    expect(await rows(conn, "SELECT animal_id FROM animal_curation_stale")).toEqual([]);
    expect(await rows(conn, "SELECT DISTINCT standing FROM animal_ecdysis")).toEqual([["not loaded"]]);
  });

  test("restates the table wholesale, so a row dropped from the file leaves the store", async () => {
    await applyTaxonCuration(conn, [DEPARTURE, HOMONYM]);
    await applyTaxonCuration(conn, [HOMONYM]);
    expect(await rows(conn, "SELECT kind FROM animal_curation")).toEqual([["homonym"]]);
  });

  test("a later fetch moving from under a decision is reported, per kind", async () => {
    await applyTaxonCuration(conn, [row({}), DEPARTURE, HOMONYM]);
    // Ecdysis gains aspilurum, accepts Xeromelecta californica again, and
    // drops the fly Rileya — all of it invented, on the fixture's real rows.
    await conn.run(`UPDATE ecdysis_taxon SET fetched_on = DATE '2026-11-30'`);
    await conn.run(`INSERT INTO ecdysis_taxon (tid, rank, name, status, accepted_tid, parent_tid, fetched_on)
                    VALUES (9000001, 'species', 'Lasioglossum aspilurum', 'accepted', 9000001, 186125, DATE '2026-11-30')`);
    await conn.run(`UPDATE ecdysis_taxon SET status = 'accepted', accepted_tid = tid WHERE tid = 1645055`);
    await conn.run(`DELETE FROM ecdysis_taxon WHERE tid = 95505`);
    expect(await rows(conn, "SELECT scientific_name, kind, fetched_on::VARCHAR, problem FROM animal_curation_stale ORDER BY scientific_name")).toEqual([
      ["Lasioglossum aspilurum", "addition", "2026-11-30", "Ecdysis now has this name as accepted (taxon 9000001)"],
      ["Rileya", "homonym", "2026-11-30", "Ecdysis now has one accepted name at this spelling: the choice is no longer needed"],
      ["Xeromelecta californica", "departure", "2026-11-30", "Ecdysis now accepts this name: the departure can be retired"],
    ]);
  });

  test("a departure Ecdysis has filed under yet another name says which", async () => {
    await applyTaxonCuration(conn, [DEPARTURE]);
    await conn.run(`UPDATE ecdysis_taxon SET name = 'Brachymelecta californicus' WHERE tid = 265407`);
    expect(await rows(conn, "SELECT problem FROM animal_curation_stale")).toEqual([
      ["Ecdysis now files it under Brachymelecta californicus, not Brachymelecta californica"],
    ]);
  });
});

describe("recording a decision", () => {
  // The answers are the fixture's real rows, as ecdysisFromStore gives them (tested below).
  const ecdysis: DecideContext["ecdysis"] = async (rank, name) => {
    if (name === "Xeromelecta californica")
      return { standing: "synonym", tid: "1645055", acceptedName: "Brachymelecta californica", candidates: [{ tid: "1645055", author: "(Cresson, 1879)", status: "synonym" }] };
    if (name === "Rileya")
      return {
        standing: "homonym", tid: null, acceptedName: null,
        candidates: [{ tid: "95505", author: "Brauer and Bergenstamm, 1893", status: "accepted" }, { tid: "1645743", author: "Ashmead, 1888", status: "accepted" }],
      };
    if (name === "Lasioglossum tenax") return { standing: "accepted", tid: "248008", acceptedName: null, candidates: [{ tid: "248008", author: "(Sandhouse, 1924)", status: "accepted" }] };
    return { standing: "absent", tid: null, acceptedName: null, candidates: [] };
  };
  const ctx: DecideContext = { ecdysisFetchedOn: "2026-10-24", today: "2026-10-24", ecdysis };
  const said = { taxonomist: "L. Best", reason: "keep, pending Gibbs 2011 (by email, 2026-10-07)" };

  test("fills in what Ecdysis said, and nothing the reader typed", async () => {
    expect(await decide({ kind: "addition", rank: "species", name: "Lasioglossum aspilurum", ...said }, ctx)).toEqual(
      row({ reason: said.reason }),
    );
    expect(await decide({ kind: "departure", rank: "species", name: "Xeromelecta californica", ...said, reference: "10.11646/zootaxa.3073.1.1" }, ctx)).toEqual(
      row({ kind: "departure", rank: "species", name: "Xeromelecta californica", ecdysis_tid: "1645055", ecdysis_accepted_name: "Brachymelecta californica", reference: "10.11646/zootaxa.3073.1.1", reason: said.reason }),
    );
    expect(await decide({ kind: "homonym", rank: "genus", name: "Rileya", tid: "1645743", ...said, decidedOn: "2026-10-25" }, ctx)).toEqual(
      row({ kind: "homonym", rank: "genus", name: "Rileya", ecdysis_tid: "1645743", reason: said.reason, decided_on: "2026-10-25" }),
    );
    expect(await decide({ kind: "addition", rank: "genus", name: "Brachymelecta", parent: { rank: "family", name: "Apidae" }, ...said }, ctx)).toMatchObject({
      parent_rank: "family", parent_name: "Apidae",
    });
  });

  test("refuses a decision Ecdysis's thesaurus contradicts, saying what it holds", async () => {
    await expect(decide({ kind: "addition", rank: "species", name: "Lasioglossum tenax", ...said }, ctx)).rejects.toThrow(/Ecdysis has this name \(accepted: \(Sandhouse, 1924\) \[taxon 248008, accepted\]\), so it is not an addition/);
    await expect(decide({ kind: "departure", rank: "species", name: "Lasioglossum tenax", ...said }, ctx)).rejects.toThrow(/does not call this name a synonym \(accepted/);
    await expect(decide({ kind: "departure", rank: "species", name: "Lasioglossum aspilurum", ...said }, ctx)).rejects.toThrow(/\(absent\), so there is nothing to depart from/);
    await expect(decide({ kind: "homonym", rank: "species", name: "Lasioglossum tenax", tid: "248008", ...said }, ctx)).rejects.toThrow(/1 accepted name at this spelling, so there is no choice/);
    await expect(decide({ kind: "homonym", rank: "genus", name: "Rileya", ...said }, ctx)).rejects.toThrow(/say which with --tid, one of: Brauer and Bergenstamm, 1893 \[taxon 95505, accepted\] \| Ashmead, 1888 \[taxon 1645743, accepted\]/);
    await expect(decide({ kind: "homonym", rank: "genus", name: "Rileya", tid: "248008", ...said }, ctx)).rejects.toThrow(/say which with --tid/);
  });

  test("and a row the file would refuse: no reason, no taxonomist", async () => {
    await expect(decide({ kind: "addition", rank: "species", name: "Lasioglossum aspilurum", taxonomist: "L. Best", reason: " " }, ctx)).rejects.toThrow(/every row says why/);
    await expect(decide({ kind: "addition", rank: "species", name: "Lasioglossum aspilurum", taxonomist: "", reason: "x" }, ctx)).rejects.toThrow(/names the taxonomist/);
  });

  test("the Ecdysis answer a decision is checked against comes from the store, by the thesaurus alone", async () => {
    const { conn } = await createMemoryDb();
    await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
    const fromStore = ecdysisFromStore(conn);
    expect(await fromStore("species", "Xeromelecta californica")).toMatchObject({ standing: "synonym", tid: "1645055", acceptedName: "Brachymelecta californica" });
    expect(await fromStore("genus", "Rileya")).toMatchObject({ standing: "homonym", tid: null });
    expect((await fromStore("genus", "Rileya")).candidates.map((c) => c.author)).toEqual(["Brauer and Bergenstamm, 1893", "Ashmead, 1888"]);
    expect(await fromStore("species", "Lasioglossum aspilurum")).toMatchObject({ standing: "absent", candidates: [] });
    expect(await fromStore("species", "Lasioglossum tenax")).toMatchObject({ standing: "accepted", tid: "248008" });
  });

  test("a batch is one signature over many lines, and a bad line is a bad batch", () => {
    const batch = parseBatch(
      [
        "kind,rank,name,reason,reference",
        'addition,species,Lasioglossum aspilurum,"as proposed; confirmed by email 2026-10-07",',
        "departure,species,Xeromelecta californica,as proposed,10.11646/zootaxa.3073.1.1",
      ].join("\n"),
      "mem",
    );
    expect(batch).toEqual([
      { kind: "addition", rank: "species", name: "Lasioglossum aspilurum", reason: "as proposed; confirmed by email 2026-10-07", reference: undefined, tid: undefined, parent: undefined },
      { kind: "departure", rank: "species", name: "Xeromelecta californica", reason: "as proposed", reference: "10.11646/zootaxa.3073.1.1", tid: undefined, parent: undefined },
    ]);
    expect(() => parseBatch("kind,rank,name\naddition,species,X y", "mem")).toThrow(/no column 'reason'/);
    expect(() => parseBatch("kind,rank,name,reason,taxonomist\n", "mem")).toThrow(/'taxonomist' is not a column/);
    expect(() => parseBatch("kind,rank,name,reason\nadopt,species,X y,why", "mem")).toThrow(/line 2: 'adopt' is not a kind/);
  });

  test("merging supersedes a decision about the same name and keeps the rest; one batch deciding a name twice is refused", () => {
    const merged = mergeDecisions([row({}), DEPARTURE], [row({ reason: "revised" }), HOMONYM]);
    expect(merged.map((r) => [r.name, r.reason])).toEqual([
      ["Lasioglossum aspilurum", "revised"],
      ["Xeromelecta californica", DEPARTURE.reason],
      ["Rileya", HOMONYM.reason],
    ]);
    expect(() => mergeDecisions([], [row({}), row({ reason: "again" })])).toThrow(/Lasioglossum aspilurum \(species\): decided twice in one batch/);
  });

  test("a snapshot names each tab's file apart, however the titles sanitise", async () => {
    const { snapshotFileNames } = await import("../src/fetch-taxon-sheet.js");
    expect(snapshotFileNames(["Read me", "1 Names ITIS does not have", "A B", "A-B", "!!!"])).toEqual([
      "read-me.csv", "1-names-itis-does-not-have.csv", "a-b.csv", "a-b-2.csv", "tab.csv",
    ]);
  });
});
