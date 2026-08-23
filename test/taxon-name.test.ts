import { describe, expect, it } from "vitest";
import { TaxonName, isItalicRank, type TaxonNameProps } from "../src/app/views/components/taxon.js";

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
