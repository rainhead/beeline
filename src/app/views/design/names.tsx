import { TaxonName, type TaxonNameProps } from "../components/index.js";
import { DesignPage, DoDont, OpenQuestion, Specimen } from "./shell.js";

/**
 * Worked examples. Each row is a real shape the data can take, so this page
 * doubles as the component's proof: if TaxonName is wrong, it is wrong here
 * first.
 */
const EXAMPLES: ReadonlyArray<{ props: TaxonNameProps; note: string }> = [
  {
    props: { rank: "species", scientificName: "Bombus vosnesenskii" },
    note: "A determination to species. Genus and epithet both italic.",
  },
  {
    props: { rank: "species", scientificName: "Bombus vosnesenskii", authorship: "Radoszkowski, 1862" },
    note: "With authorship — part of the formal name, upright, never italic.",
  },
  {
    props: { rank: "genus", scientificName: "Bombus", qualifier: "sp." },
    note: "A determination that stopped at genus. “sp.” is an abbreviation, so it stays upright.",
  },
  {
    props: { rank: "genus", scientificName: "Andrena", qualifier: "spp." },
    note: "Several unnamed species in one genus.",
  },
  {
    props: { rank: "species", scientificName: "Bombus insularis", subgenus: "Psithyrus" },
    note: "Subgenus, parenthesised between genus and epithet, italic like the names around it.",
  },
  {
    props: { rank: "subgenus", scientificName: "Bombus", subgenus: "Psithyrus", qualifier: "sp." },
    note: "A determination at subgenus rank.",
  },
  {
    props: { rank: "genus", scientificName: "Bombus", qualifier: "s. str." },
    note: "Sensu stricto — the narrow sense of a name. Upright, like every other qualifier.",
  },
  {
    props: { rank: "species", scientificName: "Bombus occidentalis", qualifier: "cf." },
    note: "Needs confirming. “cf.” qualifies the epithet, so it sits before it, not after the name.",
  },
  {
    props: { rank: "species", scientificName: "Lasioglossum zonulum", qualifier: "aff." },
    note: "Close to that species but probably something else — same position as cf.",
  },
  {
    props: { rank: "subspecies", scientificName: "Apis mellifera scutellata" },
    note: "Zoological subspecies take no rank connector — no “subsp.”, no “var.”.",
  },
  {
    props: { rank: "family", scientificName: "Andrenidae" },
    note: "Family. Above genus, so upright.",
  },
  {
    props: { rank: "superfamily", scientificName: "Ichneumonoidea" },
    note: "Bycatch determined only to superfamily. The taxonomy admits this rank deliberately.",
  },
  {
    props: { rank: "suborder", scientificName: "Symphyta" },
    note: "Coarser still, and a complete answer rather than a failed one.",
  },
  {
    props: {
      rank: "species",
      scientificName: "Phacelia hastata",
      vernacular: "silverleaf phacelia",
      vernacularDisplay: "beside",
    },
    note: "A floral host on a volunteer-facing screen: scientific name leads, English assists.",
  },
  {
    props: { rank: "species", scientificName: "Phacelia hastata", vernacular: "silverleaf phacelia" },
    note: "The same host in a dense context — the English name moves to the tooltip. Hover it.",
  },
];

export function DesignNames() {
  return (
    <DesignPage
      current="/design/names"
      title="Scientific names"
      lede="How a taxon name is set is a function of its rank and its ancestry — so it is a component, not a habit."
    >
      <h2>Why this is not a style rule</h2>
      <p>
        Nothing in this application should be deciding by eye what to italicise. The curated taxonomy (
        <code>animal</code>) carries a rank, a scientific name, an optional authorship, and a parent — which is
        everything the convention needs. So the rules below are implemented once, in <code>TaxonName</code>, and every
        screen that shows a name goes through it.
      </p>

      <h2>The rules</h2>
      <ul>
        <li>
          <strong>Italic at genus and below.</strong> Genus, subgenus, species, subspecies. Family and above are
          upright. Rank is the switch, and an unrecognised rank renders upright — an unknown rank is far more likely to
          be a high one.
        </li>
        <li>
          <strong>Subgenus goes in brackets, between genus and epithet</strong>, italic like the names around it. The
          brackets are part of the convention, not an aside.
        </li>
        <li>
          <strong>Qualifiers are abbreviations, so they are never italic</strong> — and they are not interchangeable in
          position. <code>cf.</code> and <code>aff.</code> qualify the epithet and sit before it;{" "}
          <code>sp.</code>, <code>spp.</code>, <code>s. str.</code> and <code>s. lat.</code> qualify the whole name and
          follow it.
        </li>
        <li>
          <strong>Authorship follows the name, upright</strong>, in secondary colour. It is part of the formal name,
          not a citation.
        </li>
        <li>
          <strong>Zoological subspecies take no rank connector.</strong> Bees are zoological, so no{" "}
          <code>subsp.</code>; floral hosts are botanical and do take <code>subsp.</code> and <code>var.</code> when
          iNaturalist supplies them.
        </li>
        <li>
          <strong>Never monospace.</strong> A scientific name is a name, however technical the screen around it.
        </li>
      </ul>

      <h2>Worked examples</h2>
      <Specimen>
        <dl class="reference">
          {EXAMPLES.map((e) => (
            <>
              <dt style="font-family: inherit; font-size: 1rem">
                <TaxonName {...e.props} />
              </dt>
              <dd class="meta">{e.note}</dd>
            </>
          ))}
        </dl>
      </Specimen>

      <h2>English names</h2>
      <p>
        The scientific name is the value; the vernacular only assists. Plants usually have a common name and bees
        usually do not, and the same English name means different insects in different places — so what this site
        records, prints, and exports is always the scientific name.
      </p>
      <p>
        That leaves a display choice, and it goes by surface. On a dense screen the English name lives in the tooltip
        and takes no horizontal space. On a volunteer-facing screen about a floral host — where people genuinely think
        in common names — it may sit beside the scientific name in a muted parenthetical. It never leads, it never
        replaces, and it never reaches a printed label or an export.
      </p>
      <p>
        Vernacular names are set in sentence case here, not the title case iNaturalist uses: “silverleaf phacelia”, not
        “Silverleaf Phacelia”. They are common nouns.
      </p>

      <OpenQuestion bead="beeline-ucx">
        <p>
          Floral host vernacular names are not available yet. iNaturalist returns{" "}
          <code>taxon.preferred_common_name</code> and we store the whole payload, but{" "}
          <code>schema/105_views_observation.sql</code> projects only <code>taxon.name</code>. The projection lands
          when a screen first needs it.
        </p>
      </OpenQuestion>

      <OpenQuestion bead="beeline-dys">
        <p>
          The QC home currently renders a taxon name as a machine value. <code>qc_finding.details</code> is prose, and
          for <code>non_tracheophyte_host</code> that prose <em>is</em> a taxon name — so it reaches the screen inside{" "}
          <code>&lt;code&gt;</code>, italicised by nothing and monospaced for no reason. Fixing it properly means
          giving <code>details</code> enough structure for the view to route it through <code>TaxonName</code>.
        </p>
      </OpenQuestion>

      <DoDont
        dos={[
          <>
            Render every taxon name through <code>TaxonName</code>, including in tables and chips.
          </>,
          "Treat a genus-rank determination as a complete answer and set it “Bombus sp.”, not “Bombus (unknown)”.",
          "Keep authorship when the data has it — it disambiguates homonyms.",
          "Say why a name is uncertain with cf. or aff. rather than dropping to genus.",
        ]}
        donts={[
          "Don't italicise by hand, and don't italicise a family name.",
          "Don't italicise sp., spp., cf., aff., s. str. or s. lat.",
          "Don't put cf. after the epithet, or sp. before it.",
          "Don't lead with an English name, and don't put one on a label or in an export.",
          "Don't set a scientific name in monospace, even inside a technical detail string.",
        ]}
      />
    </DesignPage>
  );
}
