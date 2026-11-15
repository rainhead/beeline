/**
 * Scientific names, set correctly by construction.
 *
 * How a taxon name is set is a function of its rank and its ancestry, not a
 * judgment call, so it is a component rather than a style rule: nothing in
 * the app should be deciding by eye what to italicise. See /design/names for
 * the rules and the worked examples.
 *
 * The data this reads is `animal` (schema/020_animal.sql): rank,
 * scientific_name, authorship, parent_id — and deliberately no vernacular
 * names. Floral hosts are iNaturalist taxa and do have one; the scientific
 * name is the value and the common name only assists, so it is an optional
 * `vernacular` prop that takes no room on the screen: it is the name's
 * tooltip (a `title`) and is read out by screen readers (/design/names,
 * "English names"). It is one way, here, so that every page and listing does
 * it alike.
 */

/**
 * Ranks at or below genus take italics; family and above are upright. The
 * list errs toward the ranks `animal` actually carries — it must admit
 * suborder and superfamily for coarse bycatch — and an unrecognised rank
 * renders upright, because an unknown rank is far more likely to be a high
 * one.
 */
const ITALIC_RANKS = new Set([
  "genus",
  "subgenus",
  "section",
  "subsection",
  "series",
  "species",
  "subspecies",
  "variety",
  "form",
  "complex",
  "hybrid",
]);

/**
 * Qualifiers are abbreviations, not names, so they are never italic — and
 * they are not interchangeable in position. `cf.` and `aff.` qualify the
 * *epithet* and sit before it (`Bombus cf. occidentalis`); the rest qualify
 * the whole name and follow it (`Bombus sp.`, `Bombus s. str.`).
 */
export const PREFIX_QUALIFIERS = ["cf.", "aff.", "nr."] as const;
export const SUFFIX_QUALIFIERS = ["sp.", "spp.", "sp. nov.", "s. str.", "s. lat."] as const;

export type TaxonQualifier = (typeof PREFIX_QUALIFIERS)[number] | (typeof SUFFIX_QUALIFIERS)[number];

export interface TaxonNameProps {
  /** `animal.rank`, free text — the switch for italics. */
  rank: string;
  /** `animal.scientific_name`: the name without subgenus or qualifier. */
  scientificName: string;
  /** Inserted parenthetically after the genus: Bombus (Psithyrus) insularis. */
  subgenus?: string | null;
  /** `animal.authorship`, set upright after the name. */
  authorship?: string | null;
  qualifier?: TaxonQualifier | null;
  /**
   * The English name, already in sentence case. It is not shown: it is the
   * `title` of the element that carries the scientific name, so it appears on
   * hover and takes no space, and it follows the name as visually hidden text
   * (", woolly sunflower"), because screen readers do not announce a `title`
   * reliably. Absent or empty, nothing is added.
   */
  vernacular?: string | null;
}

export function isItalicRank(rank: string): boolean {
  return ITALIC_RANKS.has(rank.trim().toLowerCase());
}

export function TaxonName(props: TaxonNameProps) {
  const { rank, scientificName, subgenus, authorship, qualifier, vernacular } = props;
  const italic = isItalicRank(rank);
  const words = scientificName.trim().split(/\s+/);
  const head = words[0] ?? "";
  const tail = words.slice(1).join(" ");
  const isPrefix = qualifier !== null && qualifier !== undefined && (PREFIX_QUALIFIERS as readonly string[]).includes(qualifier);

  const Name = ({ children }: { children: string }) => (italic ? <i>{children}</i> : <>{children}</>);

  return (
    <>
      <span class="taxon" title={vernacular || undefined}>
        <Name>{head}</Name>
        {subgenus ? (
          <>
            {" ("}
            <Name>{subgenus}</Name>
            {")"}
          </>
        ) : null}
        {isPrefix && qualifier ? <> {qualifier}</> : null}
        {tail !== "" ? (
          <>
            {" "}
            <Name>{tail}</Name>
          </>
        ) : null}
        {!isPrefix && qualifier ? <> {qualifier}</> : null}
        {authorship ? (
          <>
            {" "}
            <span class="taxon-authorship">{authorship}</span>
          </>
        ) : null}
        {vernacular ? <span class="visually-hidden">, {vernacular}</span> : null}
      </span>
    </>
  );
}
