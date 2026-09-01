import { DuckDBConnection } from "@duckdb/node-api";
import { openDuckDb } from "./db.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/**
 * Staging columns: the production occurrence fields, verbatim, everything a
 * string — exactly as Mongo holds them. Promotion into the model (and typed
 * casting, with findings for rows that fail it) happens in SQL over this
 * table. Omitted deliberately: `scratch`, `composite_sort`, `date` — the
 * legacy system's own derived bookkeeping, reconstructible from other fields.
 */
const STAGING_COLUMNS = [
  "_id", "errorFlags", "dateLabelPrint", "fieldNumber", "catalogNumber",
  "occurrenceID", "userId", "userLogin", "firstName", "firstNameInitial",
  "lastName", "recordedBy", "sampleId", "specimenId", "day", "month", "year",
  "verbatimEventDate", "day2", "month2", "year2", "startDayofYear",
  "endDayofYear", "country", "stateProvince", "county", "locality",
  "verbatimElevation", "decimalLatitude", "decimalLongitude",
  "coordinateUncertaintyInMeters", "samplingProtocol",
  "relationshipOfResource", "resourceID", "relatedResourceID",
  "relationshipRemarks", "phylumPlant", "orderPlant", "familyPlant",
  "genusPlant", "speciesPlant", "taxonRankPlant", "url", "phylum", "class",
  "order", "family", "genus", "subgenus", "specificEpithet",
  "taxonomicNotes", "scientificName", "sex", "caste", "taxonRank",
  "identifiedBy", "familyVolDet", "genusVolDet", "speciesVolDet",
  "sexVolDet", "casteVolDet", "geoprivacy", "taxon_geoprivacy",
] as const;

/** (Re)load the legacy_occurrence staging table from a JSONL export. */
export async function loadLegacyStaging(conn: DuckDBConnection, jsonlPath: string): Promise<number> {
  const columns = STAGING_COLUMNS.map((c) => `'${c}': 'VARCHAR'`).join(", ");
  await conn.run(`DROP TABLE IF EXISTS legacy_occurrence`);
  await conn.run(`
    CREATE TABLE legacy_occurrence AS
    SELECT * FROM read_ndjson('${jsonlPath.replaceAll("'", "''")}', columns = {${columns}})
  `);
  const result = await conn.run(`SELECT count(*) FROM legacy_occurrence`);
  const [[count]] = (await result.getRows()) as [[bigint]];
  return Number(count);
}

// CLI: pnpm legacy:load [db] [jsonl] — fails loudly if the staged count does
// not match the fetch metadata (a partial file must never look like success).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? "beeline.duckdb";
  const jsonlPath = process.argv[3] ?? "data/legacy/occurrences.jsonl.gz";
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  const staged = await loadLegacyStaging(conn, jsonlPath);
  conn.closeSync();

  const metadataPath = jsonlPath.replace(/occurrences\.jsonl(\.gz)?$/, "metadata.json");
  const expected = JSON.parse(await readFile(metadataPath, "utf8")).count as number;
  if (staged !== expected) {
    console.error(`staged ${staged} rows but metadata.json says ${expected} were fetched`);
    process.exit(1);
  }
  console.log(`staged ${staged} rows into ${dbPath}`);
}
