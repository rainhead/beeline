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
 * name is the value and the common name only assists, so a page shows it on
 * a line of its own beside the name, outside this component (`HostValue` in
 * record.tsx), where it can be ordered against what else is said about the
 * taxon. This component sets a scientific name and nothing else.
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
}

export function isItalicRank(rank: string): boolean {
  return ITALIC_RANKS.has(rank.trim().toLowerCase());
}

export function TaxonName(props: TaxonNameProps) {
  const { rank, scientificName, subgenus, authorship, qualifier } = props;
  const italic = isItalicRank(rank);
  const words = scientificName.trim().split(/\s+/);
  const head = words[0] ?? "";
  const tail = words.slice(1).join(" ");
  const isPrefix = qualifier !== null && qualifier !== undefined && (PREFIX_QUALIFIERS as readonly string[]).includes(qualifier);

  const Name = ({ children }: { children: string }) => (italic ? <i>{children}</i> : <>{children}</>);

  return (
    <>
      <span class="taxon">
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
      </span>
    </>
  );
}
