import type { DuckDBConnection } from "@duckdb/node-api";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * Every specimen as the legacy system's occurrences file (beeline-6q8,
 * GitHub #107): the same 63 columns in the same order, the same CSV
 * conventions, the same row order, so the reporting already built on that
 * file — Andony's R comparison, the taxonomists' Ecdysis uploads — keeps
 * working through cutover and after it.
 *
 * The format is the reference implementation's, read from its code rather
 * than from a sample file: the columns are `Object.keys(template)` in
 * OBP-Server's shared/lib/utils/constants.ts, written by csv-stringify with
 * `{ header: true, bom: true }` (FileManager.writeCSVFromDatabase) — a UTF-8
 * BOM, a header row, "\n" between records, a field quoted only when it must
 * be, and an absent value written as nothing at all. Rows follow the
 * reference's composite_sort: field number, collector's last and first name,
 * month, day, sample number, specimen number.
 *
 * WHERE EACH VALUE COMES FROM. The rule is that anything Beeline can change
 * comes from the model — who collected it, when and where, the coordinates,
 * the determinations, the printing — so the file reflects a staff edit, a
 * locality override or an Ecdysis determination rather than the import it
 * started from. What Beeline does not model at all is carried from the staged
 * legacy record for an imported specimen, because those values were frozen
 * the day they were imported and nothing in Beeline could have made them
 * wrong since: the legacy error flags, the catalog number and resource links,
 * the plant's higher taxonomy, the taxonomic notes, the print date of a label
 * printed before Beeline. A Beeline-originated specimen has none of those,
 * and gets them from the model where it holds the fact (the host plant's
 * name and rank, the observation's link) and blank where it does not. Where
 * the model's value is a parse of the staged text and nothing has changed it
 * — a coordinate still sourced from the import — the staged text is written,
 * since "47.5270" and 47.527 are the same fact and only one of them is what
 * the legacy file said. How close all this comes is measured, not asserted:
 * `pnpm legacy:compare-export` counts the differences per column, by season.
 */

/** The legacy occurrences template's keys, in order (OBP-Server constants.occurrences.template). */
export const LEGACY_EXPORT_COLUMNS = [
  "errorFlags", "dateLabelPrint", "fieldNumber", "catalogNumber", "occurrenceID", "userId", "userLogin",
  "firstName", "firstNameInitial", "lastName", "recordedBy", "sampleId", "specimenId", "day", "month", "year",
  "verbatimEventDate", "day2", "month2", "year2", "startDayofYear", "endDayofYear", "country", "stateProvince",
  "county", "locality", "verbatimElevation", "decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters",
  "coordinateSource", "samplingProtocol", "relationshipOfResource", "resourceID", "relatedResourceID",
  "relationshipRemarks", "phylumPlant", "orderPlant", "familyPlant", "genusPlant", "speciesPlant", "taxonRankPlant",
  "url", "phylum", "class", "order", "family", "genus", "subgenus", "specificEpithet", "taxonomicNotes",
  "scientificName", "sex", "caste", "taxonRank", "identifiedBy", "familyVolDet", "genusVolDet", "speciesVolDet",
  "sexVolDet", "casteVolDet", "geoprivacy", "taxon_geoprivacy",
] as const;

/** Staged legacy columns the export reads, when the store holds staging at all. */
const STAGED = [
  "_id", "errorFlags", "dateLabelPrint", "catalogNumber", "occurrenceID", "userId", "userLogin", "specimenId",
  "decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters", "relationshipOfResource", "resourceID",
  "relatedResourceID", "relationshipRemarks", "phylumPlant", "orderPlant", "familyPlant", "genusPlant",
  "speciesPlant", "taxonRankPlant", "url", "taxonomicNotes", "sex", "caste", "geoprivacy", "taxon_geoprivacy",
] as const;

const scalar = async (conn: DuckDBConnection, sql: string): Promise<number> => {
  const [[v]] = (await (await conn.run(sql)).getRows()) as [[bigint | number | null]];
  return Number(v ?? 0);
};

/** Whether this store holds the staged legacy records and the map from them to specimens. */
async function hasStaging(conn: DuckDBConnection): Promise<boolean> {
  return (
    (await scalar(
      conn,
      `SELECT count(*) FROM duckdb_tables()
       WHERE table_name IN ('legacy_occurrence', 'legacy_specimen_number') AND NOT temporary`,
    )) === 2
  );
}

/** The query behind the file: one row per specimen, every column TEXT, blanks as NULL. Exported for its test. */
export function legacyExportSql(staging: boolean): string {
  // Without staging (a store built from iNaturalist alone) every staged
  // column is simply NULL: the same query, with the join replaced by nothing.
  const staged = staging
    ? `LEFT JOIN legacy_specimen_number lsn
         ON lsn.sample_id = sp.sample_id AND lsn.specimen_number = sp.specimen_number
       LEFT JOIN legacy_occurrence lo ON lo._id = lsn._id`
    : `LEFT JOIN (SELECT ${STAGED.map((c) => `CAST(NULL AS VARCHAR) AS "${c}"`).join(", ")}) lo ON false`;
  const rank = (r: string) => `max(CASE WHEN a.rank = '${r}' THEN a.scientific_name END)`;
  const t = (expr: string) => `nullif(CAST(${expr} AS VARCHAR), '')`;
  // An imported specimen carries its staged value exactly — a blank included,
  // since a blank is what the legacy file said; only a Beeline-originated
  // specimen, which has no staged record, gets the model's own value.
  const orStaged = (col: string, model: string) => `CASE WHEN lo._id IS NOT NULL THEN lo."${col}" ELSE ${model} END`;
  // Everything after the genus and an optional "(Subgenus)": the epithet can
  // be more than one word ("verbesinae complex"), so the last word is not it.
  const epithet = (name: string) => `regexp_replace(${name}, '^\\S+\\s+(\\([^)]*\\)\\s+)?', '')`;
  const coord = (col: string, model: string) =>
    `CASE WHEN loc.source = 'legacy_import' AND nullif(lo."${col}", '') IS NOT NULL THEN lo."${col}"
          ELSE CAST(round(CAST(${model} AS DOUBLE), 4) AS VARCHAR) END`;
  return `
WITH RECURSIVE up(node_id, anc_id) AS (
  SELECT entity_id, entity_id FROM animal
  UNION ALL
  SELECT up.node_id, a.parent_id FROM up JOIN animal a ON a.entity_id = up.anc_id WHERE a.parent_id IS NOT NULL
),
lineage AS (
  SELECT up.node_id,
         ${rank("phylum")} AS phylum, ${rank("class")} AS class_name, ${rank("order")} AS order_name,
         ${rank("family")} AS family, ${rank("genus")} AS genus, ${rank("subgenus")} AS subgenus,
         ${rank("species")} AS species
  FROM up JOIN animal a ON a.entity_id = up.anc_id
  GROUP BY up.node_id
),
latest AS (
  SELECT d.*, row_number() OVER (PARTITION BY d.specimen_id, d.is_expert ORDER BY d.recorded_at DESC, d.entity_id DESC) AS rn
  FROM determination d
),
expert AS (SELECT * FROM latest WHERE is_expert AND rn = 1),
volunteer AS (SELECT * FROM latest WHERE NOT is_expert AND rn = 1),
printed AS (
  SELECT pl.specimen_id, max(r.printed_at) AS printed_at
  FROM printed_label pl JOIN print_run r ON r.entity_id = pl.print_run_id
  WHERE r.printed_at IS NOT NULL AND r.canceled_at IS NULL
  GROUP BY pl.specimen_id
),
-- Several collectors are written the way the legacy register wrote a shared
-- household login: every part joined with " | ", in list order, the same
-- join recordedBy uses ("A. | B.", not "A. and B.", which is the older form).
collectors AS (
  SELECT sc.sample_id,
         count(*) AS n,
         string_agg(p.display_name, ' | ' ORDER BY sc.position) AS recorded_by,
         string_agg(coalesce(p.given_name, ''), ' | ' ORDER BY sc.position) AS given_names,
         string_agg(coalesce(p.family_name, ''), ' | ' ORDER BY sc.position) AS family_names,
         string_agg(CASE WHEN nullif(p.given_name, '') IS NOT NULL THEN concat(left(p.given_name, 1), '.') ELSE '' END,
                    ' | ' ORDER BY sc.position) AS initials
  FROM sample_collector sc JOIN person p ON p.entity_id = sc.person_id
  GROUP BY sc.sample_id
),
rows AS (
  SELECT
    ${t(`lo."errorFlags"`)} AS "errorFlags",
    ${t(`CASE WHEN pr.printed_at IS NOT NULL
               THEN strftime(timezone('America/Los_Angeles', pr.printed_at), '%-d-%b-%y')
               ELSE lo."dateLabelPrint" END`)} AS "dateLabelPrint",
    ${t("sp.field_number")} AS "fieldNumber",
    ${t(`lo."catalogNumber"`)} AS "catalogNumber",
    ${t(orStaged("occurrenceID", "sp.occurrence_id"))} AS "occurrenceID",
    ${t(`coalesce(CAST(ia.inat_user_id AS VARCHAR), nullif(lo."userId", ''))`)} AS "userId",
    ${t(`coalesce(ia.login, nullif(lo."userLogin", ''))`)} AS "userLogin",
    ${t("CASE WHEN c.n > 1 THEN c.given_names ELSE p.given_name END")} AS "firstName",
    ${t(`CASE WHEN c.n > 1 THEN c.initials
               WHEN nullif(p.given_name, '') IS NOT NULL THEN concat(left(p.given_name, 1), '.') END`)} AS "firstNameInitial",
    ${t("CASE WHEN c.n > 1 THEN c.family_names ELSE p.family_name END")} AS "lastName",
    ${t("c.recorded_by")} AS "recordedBy",
    ${t("s.sample_number")} AS "sampleId",
    ${t(orStaged("specimenId", "CAST(sp.specimen_number AS VARCHAR)"))} AS "specimenId",
    ${t("day(s.date_start)")} AS "day",
    ${t("month(s.date_start)")} AS "month",
    ${t("year(s.date_start)")} AS "year",
    ${t(`CASE WHEN s.date_end > s.date_start
               THEN concat(strftime(s.date_start, '%Y-%-m-%-d'), '/', strftime(s.date_end, '%Y-%-m-%-d'))
               ELSE strftime(s.date_start, '%-m/%-d/%Y') END`)} AS "verbatimEventDate",
    ${t("CASE WHEN s.date_end > s.date_start THEN day(s.date_end) END")} AS "day2",
    ${t("CASE WHEN s.date_end > s.date_start THEN month(s.date_end) END")} AS "month2",
    ${t("CASE WHEN s.date_end > s.date_start THEN year(s.date_end) END")} AS "year2",
    ${t("CASE WHEN s.date_end > s.date_start THEN dayofyear(s.date_start) END")} AS "startDayofYear",
    ${t("CASE WHEN s.date_end > s.date_start THEN dayofyear(s.date_end) END")} AS "endDayofYear",
    -- The legacy file's country is the short name its places file gives a
    -- country — USA, but CA and NZ — where Beeline keeps ISO alpha-3 codes.
    ${t("CASE s.country WHEN 'CAN' THEN 'CA' WHEN 'NZL' THEN 'NZ' WHEN 'MEX' THEN 'MX' ELSE s.country END")} AS "country",
    ${t("s.state_province")} AS "stateProvince",
    ${t("s.county")} AS "county",
    ${t("s.locality")} AS "locality",
    ${t("loc.elevation_m")} AS "verbatimElevation",
    ${t(coord("decimalLatitude", "loc.latitude"))} AS "decimalLatitude",
    ${t(coord("decimalLongitude", "loc.longitude"))} AS "decimalLongitude",
    ${t(`CASE WHEN loc.source = 'legacy_import' AND nullif(lo."coordinateUncertaintyInMeters", '') IS NOT NULL
               THEN lo."coordinateUncertaintyInMeters" ELSE CAST(loc.coordinate_uncertainty_m AS VARCHAR) END`)} AS "coordinateUncertaintyInMeters",
    ${t(`CASE loc.source WHEN 'inat_trusted' THEN 'private' WHEN 'inat_public' THEN 'public' END`)} AS "coordinateSource",
    ${t("s.protocol")} AS "samplingProtocol",
    ${t(orStaged("relationshipOfResource", `CASE WHEN nullif(s.host_name_as_observed, '') IS NOT NULL THEN 'visits flowers of' END`))} AS "relationshipOfResource",
    ${t(orStaged("resourceID", "sp.occurrence_id"))} AS "resourceID",
    ${t(`lo."relatedResourceID"`)} AS "relatedResourceID",
    ${t(`lo."relationshipRemarks"`)} AS "relationshipRemarks",
    ${t(`lo."phylumPlant"`)} AS "phylumPlant",
    ${t(`lo."orderPlant"`)} AS "orderPlant",
    ${t(`lo."familyPlant"`)} AS "familyPlant",
    ${t(orStaged("genusPlant", `CASE WHEN s.host_rank IN ('genus', 'species', 'subspecies', 'variety', 'form')
                                      THEN split_part(s.host_name_as_observed, ' ', 1) END`))} AS "genusPlant",
    ${t(orStaged("speciesPlant", `CASE WHEN s.host_rank IN ('species', 'subspecies', 'variety', 'form')
                                        THEN s.host_name_as_observed END`))} AS "speciesPlant",
    ${t(orStaged("taxonRankPlant", "s.host_rank"))} AS "taxonRankPlant",
    -- An imported record's own link wins: a sample made from several
    -- observations keeps one of them, and the legacy row kept its specimen's.
    -- The model's link fills only a blank.
    ${t(`coalesce(nullif(lo."url", ''),
                  CASE WHEN s.inat_observation_id IS NOT NULL
                       THEN concat('https://www.inaturalist.org/observations/', s.inat_observation_id) END)`)} AS "url",
    ${t("el.phylum")} AS "phylum",
    ${t("el.class_name")} AS "class",
    ${t("el.order_name")} AS "order",
    ${t("el.family")} AS "family",
    ${t("el.genus")} AS "genus",
    ${t("el.subgenus")} AS "subgenus",
    ${t(`CASE WHEN el.species IS NOT NULL THEN ${epithet("el.species")} END`)} AS "specificEpithet",
    ${t(`lo."taxonomicNotes"`)} AS "taxonomicNotes",
    -- The legacy file writes an open-nomenclature qualifier inside the name:
    -- "Lasioglossum nr. tenax", which is also how the determiner wrote it.
    ${t(`CASE WHEN e.qualifier IS NOT NULL AND el.species IS NOT NULL
               THEN concat(el.genus, ' ', e.qualifier, ' ', ${epithet("el.species")})
               ELSE ea.scientific_name END`)} AS "scientificName",
    -- Beeline keeps sex and caste on a determination, so a specimen the legacy
    -- system sexed but nobody has identified has nowhere to hold them: 24,217
    -- such rows in the 2026-09-27 corpus. Those carry the staged value.
    ${t(`CASE WHEN e.entity_id IS NOT NULL THEN e.sex ELSE lo."sex" END`)} AS "sex",
    ${t(`CASE WHEN e.entity_id IS NOT NULL THEN e.caste ELSE lo."caste" END`)} AS "caste",
    ${t("CASE WHEN ea.rank IS NOT NULL THEN concat(upper(left(ea.rank, 1)), substr(ea.rank, 2)) END")} AS "taxonRank",
    ${t("coalesce(nullif(e.determiner_name, ''), dp.display_name)")} AS "identifiedBy",
    ${t("vl.family")} AS "familyVolDet",
    ${t("vl.genus")} AS "genusVolDet",
    ${t(`CASE WHEN vl.species IS NOT NULL THEN ${epithet("vl.species")} END`)} AS "speciesVolDet",
    ${t("v.sex")} AS "sexVolDet",
    ${t("v.caste")} AS "casteVolDet",
    -- iNaturalist's, and the model holds them only for a linked sample; an
    -- imported sample it never linked keeps what the legacy record said.
    ${t(`coalesce(s.geoprivacy, nullif(lo."geoprivacy", ''))`)} AS "geoprivacy",
    ${t(`coalesce(s.taxon_geoprivacy, nullif(lo."taxon_geoprivacy", ''))`)} AS "taxon_geoprivacy",
    -- The reference's composite_sort, as its parts.
    try_cast(sp.field_number AS BIGINT) AS sort_field_number,
    sp.field_number AS sort_field_text,
    nullif(p.family_name, '') AS sort_last,
    nullif(p.given_name, '') AS sort_first,
    month(s.date_start) AS sort_month,
    day(s.date_start) AS sort_day,
    try_cast(s.sample_number AS BIGINT) AS sort_sample,
    s.sample_number AS sort_sample_text,
    sp.specimen_number AS sort_specimen
  FROM specimen sp
  JOIN sample s ON s.entity_id = sp.sample_id
  LEFT JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
  LEFT JOIN person p ON p.entity_id = pc.person_id
  LEFT JOIN inat_account ia ON ia.person_id = pc.person_id
  LEFT JOIN collectors c ON c.sample_id = s.entity_id
  LEFT JOIN sample_location loc ON loc.sample_id = s.entity_id
  LEFT JOIN expert e ON e.specimen_id = sp.entity_id
  LEFT JOIN animal ea ON ea.entity_id = e.animal_id
  LEFT JOIN lineage el ON el.node_id = e.animal_id
  LEFT JOIN person dp ON dp.entity_id = e.determiner_id
  LEFT JOIN volunteer v ON v.specimen_id = sp.entity_id
  LEFT JOIN lineage vl ON vl.node_id = v.animal_id
  LEFT JOIN printed pr ON pr.specimen_id = sp.entity_id
  ${staged}
)
SELECT ${LEGACY_EXPORT_COLUMNS.map((c) => `"${c}"`).join(", ")}
FROM rows
ORDER BY sort_field_number NULLS LAST, sort_field_text NULLS LAST, sort_last NULLS LAST, sort_first NULLS LAST,
         sort_month, sort_day, sort_sample NULLS LAST, sort_sample_text, sort_specimen`;
}

/** Where the app keeps the current export, inside its exports directory. */
export const legacyExportPath = (exportsDir: string) => `${exportsDir.replace(/\/$/, "")}/occurrences.csv`;

/** UTF-8 byte order mark, which csv-stringify's `bom: true` puts first. */
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Write the export to `path`, atomically: DuckDB writes the CSV itself (the
 * whole corpus is ~160 MB, which the app has no business holding as strings),
 * then the BOM is put in front of it in a second file that replaces `path`
 * only once complete, so a reader never sees half an export.
 */
export async function writeLegacyExport(conn: DuckDBConnection, path: string): Promise<{ rows: number; staged: boolean }> {
  await mkdir(dirname(path), { recursive: true });
  const staging = await hasStaging(conn);
  const body = `${path}.body.tmp`;
  const whole = `${path}.tmp`;
  try {
    await conn.run(
      `COPY (${legacyExportSql(staging)}) TO '${body.replaceAll("'", "''")}'
       (FORMAT csv, HEADER true, DELIMITER ',', QUOTE '"', ESCAPE '"', NULLSTR '')`,
    );
    const out = createWriteStream(whole);
    out.write(BOM);
    await pipeline(createReadStream(body), out);
    await rename(whole, path);
  } finally {
    await rm(body, { force: true });
    await rm(whole, { force: true });
  }
  const rows = await scalar(conn, "SELECT count(*) FROM specimen");
  return { rows, staged: staging };
}
