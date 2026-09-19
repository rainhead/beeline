import { describe, expect, it } from "vitest";
import { TaxonName, isItalicRank, type TaxonNameProps } from "../src/app/views/components/taxon.js";
import { FindingDetail } from "../src/app/views/components/finding.js";

/**
 * The naming rules stated at /design/names, pinned. These are conventions
 * with real right and wrong answers, so they belong in a test rather than in
 * a reviewer's memory.
 */
const render = (props: TaxonNameProps) => String(TaxonName(props));

describe("TaxonName", () => {
  it("italicises genus and below, and nothing above it", () => {
    for (const rank of ["genus", "subgenus", "species", "subspecies"]) expect(isItalicRank(rank), rank).toBe(true);
    for (const rank of ["family", "tribe", "order", "suborder", "superfamily"])
      expect(isItalicRank(rank), rank).toBe(false);
  });

  it("treats an unknown rank as a high one, because that is the safer guess", () => {
    expect(isItalicRank("infraorder")).toBe(false);
    expect(render({ rank: "infraorder", scientificName: "Aculeata" })).not.toContain("<i>");
  });

  it("sets a binomial in italics", () => {
    expect(render({ rank: "species", scientificName: "Bombus vosnesenskii" })).toBe(
      `<span class="taxon"><i>Bombus</i> <i>vosnesenskii</i></span>`,
    );
  });

  it("parenthesises a subgenus between genus and epithet", () => {
    expect(render({ rank: "species", scientificName: "Bombus insularis", subgenus: "Psithyrus" })).toContain(
      "<i>Bombus</i> (<i>Psithyrus</i>) <i>insularis</i>",
    );
  });

  it("keeps rank abbreviations upright and after the name", () => {
    const html = render({ rank: "genus", scientificName: "Bombus", qualifier: "sp." });
    expect(html).toContain("<i>Bombus</i> sp.");
    expect(html).not.toContain("<i>sp.</i>");
  });

  it("keeps sensu stricto upright", () => {
    expect(render({ rank: "genus", scientificName: "Bombus", qualifier: "s. str." })).toContain(
      "<i>Bombus</i> s. str.",
    );
  });

  it("puts cf. and aff. before the epithet, not after the name", () => {
    expect(render({ rank: "species", scientificName: "Bombus occidentalis", qualifier: "cf." })).toContain(
      "<i>Bombus</i> cf. <i>occidentalis</i>",
    );
    expect(render({ rank: "species", scientificName: "Lasioglossum zonulum", qualifier: "aff." })).toContain(
      "<i>Lasioglossum</i> aff. <i>zonulum</i>",
    );
    // nr. is the one the legacy records actually carry (beeline-tgu).
    expect(render({ rank: "species", scientificName: "Lasioglossum tenax", qualifier: "nr." })).toContain(
      "<i>Lasioglossum</i> nr. <i>tenax</i>",
    );
  });

  it("sets authorship upright after the name", () => {
    const html = render({
      rank: "species",
      scientificName: "Bombus vosnesenskii",
      authorship: "Radoszkowski, 1862",
    });
    expect(html).toContain(`<span class="taxon-authorship">Radoszkowski, 1862</span>`);
    expect(html).not.toContain("<i>Radoszkowski");
  });

  it("gives a zoological subspecies no rank connector", () => {
    const html = render({ rank: "subspecies", scientificName: "Apis mellifera scutellata" });
    expect(html).toContain("<i>Apis</i> <i>mellifera scutellata</i>");
    expect(html).not.toContain("subsp.");
  });

  it("leaves a family upright", () => {
    expect(render({ rank: "family", scientificName: "Andrenidae" })).toBe(`<span class="taxon">Andrenidae</span>`);
  });

  it("keeps the vernacular subordinate: tooltip by default, parenthetical on request, never leading", () => {
    const tooltip = render({ rank: "species", scientificName: "Phacelia hastata", vernacular: "silverleaf phacelia" });
    expect(tooltip).toContain(`title="silverleaf phacelia"`);
    // In tooltip mode the English name is an attribute, so it never appears
    // in the rendered text at all.
    expect(tooltip.replace(/ title="[^"]*"/, "")).not.toContain("silverleaf");

    const beside = render({
      rank: "species",
      scientificName: "Phacelia hastata",
      vernacular: "silverleaf phacelia",
      vernacularDisplay: "beside",
    });
    expect(beside).toContain(`<span class="taxon-vernacular">(silverleaf phacelia)</span>`);
    expect(beside).not.toContain("title=");
    // Scientific name leads; the English name assists.
    expect(beside.indexOf("Phacelia")).toBeLessThan(beside.indexOf("silverleaf"));

    const none = render({
      rank: "species",
      scientificName: "Phacelia hastata",
      vernacular: "silverleaf phacelia",
      vernacularDisplay: "none",
    });
    expect(none).not.toContain("silverleaf");
  });
});

/**
 * The one QC rule whose detail is a name rather than prose about one
 * (beeline-dys). A finding's detail is a machine value and belongs in a
 * <code>; a scientific name is not, and setting it in one loses the italics
 * that /design/names exists to get right.
 */
describe("FindingDetail", () => {
  const detail = (props: Parameters<typeof FindingDetail>[0]) => String(FindingDetail(props));

  it("sets a taxon as a name, by rank, never as a machine value", () => {
    const human = detail({ details: null, taxonName: "Homo sapiens", taxonRank: "species" });
    expect(human).toBe(`<span class="taxon"><i>Homo</i> <i>sapiens</i></span>`);
    expect(human).not.toContain("<code>");
  });

  it("leaves a rank above genus upright, including one iNaturalist has and the store does not", () => {
    expect(detail({ details: null, taxonName: "Insecta", taxonRank: "class" })).not.toContain("<i>");
    expect(detail({ details: null, taxonName: "Life", taxonRank: "stateofmatter" })).not.toContain("<i>");
  });

  it("keeps every other rule's detail a machine value", () => {
    expect(detail({ details: "3200 m > 250 m" })).toBe("<code>3200 m &gt; 250 m</code>");
  });

  it("falls back to prose where the projection has an id and no name", () => {
    expect(detail({ details: "observation taxon 47126 is not a vascular plant", taxonName: null })).toContain("<code>");
  });

  it("renders nothing rather than an empty element when a rule reports no detail", () => {
    expect(detail({ details: null })).toBe("");
  });

  it("gives the name a clause of its own, so it is not a fragment after the instruction", () => {
    expect(detail({ details: null, taxonName: "Andrena", taxonRank: "genus", taxonLead: "It is currently identified as" })).toBe(
      `It is currently identified as <span class="taxon"><i>Andrena</i></span>.`,
    );
    // Prose is already a clause and takes no lead-in.
    expect(detail({ details: "Oregon", taxonLead: "It is currently identified as" })).toBe("<code>Oregon</code>");
  });
});
