import { describe, expect, it } from "vitest";
import { mergeNames, searchTaxa, type PickerTaxon } from "../src/app/islands/determine/taxon-search.js";

/**
 * The order the name picker lists names in (beeline-u9u2). The names are real
 * ones from the tree; `per` and `dia` are the two queries a volunteer reported
 * on 2026-11-17.
 */

let next = 1;
const taxon = (name: string, rank: string, bee = true, family: string | null = null): PickerTaxon => ({
  id: next++,
  rank,
  name,
  family,
  order: null,
  bee,
  castes: false,
});

const taxa: PickerTaxon[] = [
  taxon("Perdita zonalis", "species"),
  taxon("Lasioglossum", "genus"),
  taxon("Lasioglossum (Dialictus)", "subgenus"),
  taxon("Perdita albonotata", "species"),
  taxon("Diadasia enavata", "species"),
  taxon("Perdita", "genus"),
  taxon("Diadasia", "genus"),
  taxon("Diadasia diminuta", "species"),
  taxon("Bombus vosnesenskii", "species"),
  taxon("Bombyliidae", "family", false),
  taxon("Bombus", "genus"),
  taxon("Andrena (Melandrena)", "subgenus"),
  taxon("Andrena", "genus"),
];

const names = (query: string, bycatch = false, limit?: number) =>
  searchTaxa(taxa, query, bycatch, limit).map((t) => t.name);

describe("searchTaxa", () => {
  it("lists a genus, then the names under it alphabetically", () => {
    expect(names("per")).toEqual(["Perdita", "Perdita albonotata", "Perdita zonalis"]);
  });

  it("lists names whose genus starts with the letters before names matched on a later word", () => {
    expect(names("dia")).toEqual(["Diadasia", "Diadasia diminuta", "Diadasia enavata", "Lasioglossum (Dialictus)"]);
  });

  it("still finds a subgenus or an epithet typed alone", () => {
    expect(names("melan")).toEqual(["Andrena (Melandrena)"]);
    expect(names("zon")).toEqual(["Perdita zonalis"]);
  });

  it("puts the name typed exactly first", () => {
    expect(names("lasioglossum dialictus")).toEqual(["Lasioglossum (Dialictus)"]);
    expect(names("Perdita zonalis")).toEqual(["Perdita zonalis"]);
    expect(names("Perdita")[0]).toBe("Perdita");
  });

  it("matches words in order, from their starts", () => {
    expect(names("b vos")).toEqual(["Bombus vosnesenskii"]);
    expect(names("vos bom")).toEqual([]);
  });

  it("leaves out bycatch unless asked, and lists bees before it at the same length", () => {
    expect(names("bom")).toEqual(["Bombus", "Bombus vosnesenskii"]);
    expect(names("bom", true)).toEqual(["Bombus", "Bombyliidae", "Bombus vosnesenskii"]);
  });

  it("stops at the limit, and answers nothing for an empty box", () => {
    expect(names("per", false, 2)).toEqual(["Perdita", "Perdita albonotata"]);
    expect(names("  ")).toEqual([]);
  });
});

describe("mergeNames", () => {
  it("adds Ecdysis's names after the tree's, leaving out those the tree holds", () => {
    const tree = searchTaxa(taxa, "bom", true);
    const merged = mergeNames(tree, [
      { tid: 7, rank: "family", name: "Bombyliidae", family: null, order: "Diptera" },
      { tid: 8, rank: "genus", name: "Bombylius", family: "Bombyliidae", order: "Diptera" },
    ]);
    expect(merged.map((t) => t.name)).toEqual(["Bombus", "Bombyliidae", "Bombus vosnesenskii", "Bombylius"]);
    expect(merged.at(-1)).toMatchObject({ id: -8, ecdysisTid: 8, bee: false });
  });
});
