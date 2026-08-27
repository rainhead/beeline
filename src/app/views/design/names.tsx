import { labelName, type PersonNameParts } from "../../../person-name.js";
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
    props: { rank: "species", scientificName: "Lasioglossum tenax", qualifier: "nr." },
    note: "“Near”: the only qualifier the legacy records actually carry.",
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

/**
 * Real shapes from the legacy data (beeline-77j), so this doubles as the
 * proof for `labelName`: every case that broke a "last whitespace token"
 * rule is here.
 */
const PEOPLE: ReadonlyArray<{ person: PersonNameParts; note: string }> = [
  {
    person: { display_name: "Peter Abrahamsen", given_name: "Peter", family_name: "Abrahamsen" },
    note: "The ordinary case: one initial, then the family name.",
  },
  {
    person: { display_name: "Maarten Van Otterloo", given_name: "Maarten", family_name: "Van Otterloo" },
    note: "A particle is part of the family name and is printed whole. Splitting on whitespace would print “M. Otterloo”, which is a different person.",
  },
  {
    person: {
      display_name: "Juan Manuel Benitez Alvarez",
      given_name: "Juan Manuel",
      family_name: "Benitez Alvarez",
    },
    note: "Two given names, two family names. Only the first given name is abbreviated, and the family name never is.",
  },
  {
    person: { display_name: "Sarah Red-Laird", given_name: "Sarah", family_name: "Red-Laird" },
    note: "A hyphenated family name needs no special handling — it is one name.",
  },
  {
    person: { display_name: "Mary Jo Mosby", given_name: "Mary Jo", family_name: "Mosby" },
    note: "A compound given name loses its second half. Anyone who wants “M. J. Mosby” sets label_name.",
  },
  {
    person: { display_name: "Karen G. Barron", given_name: "Karen", family_name: "G. Barron", label_name: "K. Barron" },
    note: "The import put a middle initial in the family name. label_name overrides the derived form rather than waiting for the data to be fixed.",
  },
  {
    person: { display_name: "Michael O’Loughlin | Dan O’Loughlin" },
    note: "No parts to abbreviate against — an unparted import — so the full form prints. A long name beats a wrong one.",
  },
];

export function DesignNames() {
  return (
    <DesignPage
      current="/design/names"
      title="Names"
      lede="A taxon name is set by its rank and ancestry; a person's name is abbreviated from parts nobody should be re-splitting at print time. Both are derived, not typed."
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

      <h2>People’s names</h2>
      <p>
        A label prints the collector as <strong>P. Abrahamsen</strong>, which a display name cannot yield: “last
        whitespace token” gets Van Otterloo, Vanden Heuvel and Benitez Alvarez wrong, and those are real people in
        this data. So <code>person</code> stores the parts — <code>given_name</code> and <code>family_name</code> —
        and <code>labelName()</code> derives the printed form: the first given initial, then the family name{" "}
        <em>whole</em>. A family name is never re-split at print time.
      </p>
      <p>
        Derivation is a default, not a law. <code>label_name</code> overrides it outright, for the cases the parts get
        wrong and for people who would rather be written differently. With no family name at all — a mononym, an
        import nobody has parted — the full display name prints unchanged.
      </p>

      <Specimen>
        <dl class="reference">
          {PEOPLE.map((e) => (
            <>
              <dt style="font-family: inherit; font-size: 1rem">
                {labelName(e.person)} <span class="meta">← {e.person.display_name}</span>
              </dt>
              <dd class="meta">{e.note}</dd>
            </>
          ))}
        </dl>
      </Specimen>

      <OpenQuestion bead="beeline-77j">
        <p>
          What a label prints for a sample with <em>several</em> collectors is undecided. The legacy data has 25,949
          specimens whose collector is a pipe-separated list — “Michael O’Loughlin | Dan O’Loughlin”, active through
          2025 — and <code>sample.collector_id</code> is a single reference.
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
          <>
            Abbreviate a person's name through <code>labelName()</code>, and fix a wrong one with{" "}
            <code>label_name</code> rather than by editing the parts to be untrue.
          </>,
        ]}
        donts={[
          "Don't italicise by hand, and don't italicise a family name.",
          "Don't italicise sp., spp., cf., aff., s. str. or s. lat.",
          "Don't put cf. after the epithet, or sp. before it.",
          "Don't lead with an English name, and don't put one on a label or in an export.",
          "Don't set a scientific name in monospace, even inside a technical detail string.",
          "Don't split a family name at print time — particles and second surnames belong to it.",
        ]}
      />
    </DesignPage>
  );
}
