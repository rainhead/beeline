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

  describe("vernacular", () => {
    // The common name is the title of the element, and follows the name as hidden text for screen readers.
    const hidden = (name: string) => `<span class="visually-hidden">, ${name}</span>`;
    /** What a person sees: the markup without the title attribute and the hidden text. */
    const visible = (html: string) => html.replace(/ title="[^"]*"/, "").replace(/<span class="visually-hidden">.*?<\/span>/g, "");

    it("adds nothing without a vernacular name, or with an empty one", () => {
      const plain = render({ rank: "species", scientificName: "Phacelia hastata" });
      expect(render({ rank: "species", scientificName: "Phacelia hastata", vernacular: null })).toBe(plain);
      expect(render({ rank: "species", scientificName: "Phacelia hastata", vernacular: "" })).toBe(plain);
      expect(plain).not.toContain("title=");
      expect(plain).not.toContain("visually-hidden");
    });

    it("is the title of the scientific name and hidden text after it, and shows nothing", () => {
      const html = render({ rank: "species", scientificName: "Phacelia hastata", vernacular: "silverleaf phacelia" });
      expect(html).toBe(`<span class="taxon" title="silverleaf phacelia"><i>Phacelia</i> <i>hastata</i>${hidden("silverleaf phacelia")}</span>`);
      expect(visible(html)).toBe(`<span class="taxon"><i>Phacelia</i> <i>hastata</i></span>`);
      expect(visible(html)).not.toContain("silverleaf");
    });

    it("sits after the authorship, which stays visible", () => {
      const html = render({
        rank: "species",
        scientificName: "Symphyotrichum chilense",
        authorship: "(Nees) G.L.Nesom",
        vernacular: "Pacific aster",
      });
      expect(html).toBe(
        `<span class="taxon" title="Pacific aster"><i>Symphyotrichum</i> <i>chilense</i> <span class="taxon-authorship">(Nees) G.L.Nesom</span>${hidden("Pacific aster")}</span>`,
      );
    });

    it("keeps the name out of the italics, and out of brackets and quotation marks, at every rank", () => {
      for (const rank of ["species", "genus", "family"]) {
        const html = render({ rank, scientificName: "Eriophyllum lanatum", vernacular: "woolly sunflower" });
        // The only <i> elements are the scientific name's own, closed before the hidden text.
        expect(html.slice(html.indexOf("visually-hidden"))).not.toContain("<i>");
        expect(visible(html)).not.toMatch(/[("'\u201c]\u00a0?woolly|woolly sunflower[)"'\u201d]/);
        expect(html).not.toContain("(woolly");
      }
    });
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
