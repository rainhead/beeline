import { TaxonName } from "./taxon.js";

/**
 * What a QC finding says about the one record it fired on.
 *
 * A rule's instruction is the same on every row and comes from the message
 * catalog; `details` is the part that differs — which fields were empty, how
 * far over the limit, which taxon. Nearly all of it is prose about a value,
 * and prose about a value is set as a machine value, in a <code>: that is
 * what tells a volunteer the words came from the record rather than from us.
 *
 * One rule breaks that, and it is the reason this is a component rather than
 * two copies of the same JSX (beeline-dys). `non_tracheophyte_host`'s detail
 * IS a scientific name, and a scientific name set in a <code> is wrong twice
 * over — /design/type and /design/names both forbid it, and the italics that
 * distinguish Homo sapiens from Insecta are lost. So that rule reports its
 * taxon in its own columns (schema/120) and this renders it through
 * TaxonName, which knows from the rank what to italicise.
 */
export function FindingDetail({
  details,
  taxonName,
  taxonRank,
  taxonLead,
}: {
  details: string | null;
  taxonName?: string | null;
  taxonRank?: string | null;
  /**
   * `m.qc.identifiedAs`. A machine value in a <code> reads as an annotation
   * with nothing said around it; a name set as a name does not, so it takes
   * a short clause rather than dangling after the instruction's full stop.
   */
  taxonLead?: string;
}) {
  // The projection occasionally has a taxon id and no name; the rule falls
  // back to prose there, so the two are never both set and never both empty.
  if (taxonName) {
    const name = <TaxonName rank={taxonRank ?? ""} scientificName={taxonName} />;
    return taxonLead === undefined ? name : <>{taxonLead} {name}.</>;
  }
  if (details) return <code>{details}</code>;
  return <></>;
}
