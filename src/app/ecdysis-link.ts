/**
 * Where a record Ecdysis reported can be read in Ecdysis itself. Symbiota's
 * individual-record page finds a record by `guid`, matching it against the
 * occurrenceID or the recordID, and what Beeline keeps as
 * `specimen_catalog_number.occurrence_id` is the recordID the record was read
 * under (beeline-8dx9.11). Every page that links to Ecdysis builds the address
 * here.
 */
export function ecdysisRecordUrl(recordId: string | null): string | null {
  if (recordId === null || recordId === "") return null;
  return `https://ecdysis.org/collections/individual/index.php?guid=${encodeURIComponent(recordId)}`;
}
