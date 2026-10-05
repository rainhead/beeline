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
  "decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters", "coordinateSource", "relationshipOfResource", "resourceID",
  "relatedResourceID", "relationshipRemarks", "phylumPlant", "orderPlant", "familyPlant", "genusPlant",
  "speciesPlant", "taxonRankPlant", "url", "taxonomicNotes", "sex", "caste", "geoprivacy", "taxon_geoprivacy",
  "verbatimElevation", "phylum", "class", "order", "family", "genus", "subgenus", "specificEpithet",
  "scientificName", "taxonRank", "identifiedBy", "familyVolDet", "genusVolDet", "speciesVolDet", "sexVolDet", "casteVolDet",
] as const;

const scalar = async (conn: DuckDBConnection, sql: string): Promise<number> => {
  const [[v]] = (await (await conn.run(sql)).getRows()) as [[bigint | number | null]];
  return Number(v ?? 0);
};

/**
 * The staged legacy columns this store holds, or null when it holds no
 * staging (or no map from it to specimens) at all. A store loaded before a
 * column joined STAGING_COLUMNS lacks it — coordinateSource did, until
 * 2026-09-28 — and the export reads such a column as blank.
 */
async function stagedColumns(conn: DuckDBConnection): Promise<Set<string> | null> {
  const tables = await scalar(
    conn,
    `SELECT count(*) FROM duckdb_tables()
     WHERE table_name IN ('legacy_occurrence', 'legacy_specimen_number') AND NOT temporary`,
  );
  if (tables !== 2) return null;
  const rows = (await (
    await conn.run(`SELECT column_name FROM duckdb_columns() WHERE table_name = 'legacy_occurrence'`)
  ).getRows()) as [string][];
  return new Set(rows.map(([c]) => c));
}

/**
 * A value as the reference's composite_sort writes it. parseFloat reads a
 * leading number and ignores the rest, which try_cast does not, but every
 * field that sorts as a number here is digits or not a number at all.
 */
const Z16 = "'zzzzzzzzzzzzzzzz'";
const sortNumber = (col: string) =>
  `CASE WHEN try_cast(${col} AS DOUBLE) IS NULL THEN ${Z16}
        ELSE lpad(CAST(CAST(try_cast(${col} AS DOUBLE) AS BIGINT) AS VARCHAR), 16, '0') END`;
const sortText = (col: string) => `coalesce(nullif(${col}, ''), ${Z16})`;

/**
 * A person's label initials where their `label_name` is unspaced initials
 * and their own family name (`J.M.` of `J.M. Benitez Alvarez`), else NULL:
 * the SQL twin of `labelInitials` in src/label-text.ts, so the file's
 * firstNameInitial says what the person's labels say. Both sides are
 * trimmed of exactly what JavaScript's trim() removes, not only of spaces as
 * DuckDB's trim() does, or a stray tab in an overlay value would close up on
 * the label and not here (CodeRabbit on #129). That set is ECMAScript's
 * WhiteSpace and LineTerminator: RE2's \s (tab, LF, FF, CR, space) misses
 * the vertical tab, and \p{Z} (Zs, plus U+2028 and U+2029) misses U+FEFF.
 */
const JS_SPACE = "[\\s\\x{0B}\\x{FEFF}\\p{Z}]";
const jsTrim = (x: string) => `regexp_replace(${x}, '^${JS_SPACE}+|${JS_SPACE}+$', '', 'g')`;
const labelInitials = (p: string) => {
  const name = jsTrim(`${p}.label_name`);
  return `CASE
  WHEN regexp_full_match(${name}, '((?:\\p{Lu}\\.)+) (.+)')
   AND regexp_extract(${name}, '^((?:\\p{Lu}\\.)+) (.+)$', 2) = ${jsTrim(`${p}.family_name`)}
  THEN regexp_extract(${name}, '^((?:\\p{Lu}\\.)+) (.+)$', 1) END`;
};

/** The query behind the file: one row per specimen, every column TEXT, blanks as NULL. Exported for its test. */
export function legacyExportSql(staging: Set<string> | null, rowSource: string | null = null): string {
  // Without staging (a store built from iNaturalist alone) every staged
  // column is simply NULL: the same query, with the join replaced by nothing.
  // With it, a column the store's staging predates is NULL the same way.
  const column = (c: string) =>
    staging?.has(c) ? `CAST("${c}" AS VARCHAR) AS "${c}"` : `CAST(NULL AS VARCHAR) AS "${c}"`;
  const staged = staging
    ? `LEFT JOIN legacy_specimen_number lsn
         ON lsn.sample_id = sp.sample_id AND lsn.specimen_number = sp.specimen_number
       LEFT JOIN (SELECT ${STAGED.map(column).join(", ")} FROM legacy_occurrence) lo ON lo._id = lsn._id`
    : `LEFT JOIN (SELECT ${STAGED.map(column).join(", ")}) lo ON false`;
  const rank = (r: string) => `max(CASE WHEN a.rank = '${r}' THEN a.scientific_name END)`;
  const t = (expr: string) => `nullif(CAST(${expr} AS VARCHAR), '')`;
  // An imported specimen carries its staged value exactly — a blank included,
  // since a blank is what the legacy file said; only a Beeline-originated
  // specimen, which has no staged record, gets the model's own value.
  const orStaged = (col: string, model: string) => `CASE WHEN lo._id IS NOT NULL THEN lo."${col}" ELSE ${model} END`;
  const unidentified = (col: string, model: string) =>
    `CASE WHEN e.entity_id IS NULL AND lo._id IS NOT NULL THEN lo."${col}" ELSE ${model} END`;
  // The reference writes a coordinate with toFixed(4): always four places,
  // "44.5000", which a join on the text would otherwise miss.
  // Everything after the genus and an optional "(Subgenus)": the epithet can
  // be more than one word ("verbesinae complex"), so the last word is not it.
  const epithet = (name: string) => `regexp_replace(${name}, '^\\S+\\s+(\\([^)]*\\)\\s+)?', '')`;
  // A row whose own point is written — an imported point Beeline has not
  // replaced — describes that point in full: its elevation and uncertainty
  // are the legacy row's too, as the legacy file had them. The sample keeps
  // one location, and where a sample merges legacy rows taken at different
  // points (106 samples in the 2026 season on the sandbox, one 304 km
  // across), the sample's elevation beside a row's own coordinates was the
  // elevation of somewhere else: 1,182 m written beside a point whose own
  // record says 918 m (beeline-en7i). The model's value fills a blank only
  // where it was read at this row's point, within sample_elevation_stale's
  // tolerance; anywhere else it says nothing, since nothing is known.
  const rowPoint = `(loc.source = 'legacy_import' AND nullif(lo."decimalLatitude", '') IS NOT NULL
                     AND nullif(lo."decimalLongitude", '') IS NOT NULL)`;
  const atRowPoint = (lat: string, lon: string) =>
    `(abs(try_cast(lo."decimalLatitude" AS DOUBLE) - ${lat}) <= 5e-5 AND abs(try_cast(lo."decimalLongitude" AS DOUBLE) - ${lon}) <= 5e-5)`;
  const ofRowPoint = (col: string, model: string, lat: string, lon: string) =>
    `CASE WHEN NOT ${rowPoint} THEN CAST(${model} AS VARCHAR)
          WHEN nullif(lo."${col}", '') IS NOT NULL THEN lo."${col}"
          WHEN ${atRowPoint(lat, lon)} THEN CAST(${model} AS VARCHAR) END`;
  // Both coordinates come from the same place, the row or the model, never
  // one of each: a row holding only a latitude takes the model's pair, and
  // with it the model's elevation and uncertainty (CodeRabbit on #130; no
  // such row on the sandbox, 2026-10-04).
  const coord = (col: string, model: string) =>
    `CASE WHEN ${rowPoint} THEN lo."${col}" ELSE printf('%.4f', CAST(${model} AS DOUBLE)) END`;
  // The same rule for how and when a specimen was caught, and where by name:
  // a sample holds one method, one end date and one place, so where the
  // legacy rows promotion merged into it disagree, each row carries its own
  // (Peter, 2026-10-04). One collector numbered specimens 1–5 under sample 1
  // on 25 April 2019: 1 and 2 netted that day, 3–5 from pan traps emptied the
  // next, and the sample's trap and end date were written on the netted
  // ones. Read from the corrected rows, so a staff edit, which corrects every
  // row of its sample, leaves them agreeing and the model's value written.
  const ROW_FIELDS = ["samplingProtocol", "locality", "county", "stateProvince", "country"];
  const END_FIELDS = ["verbatimEventDate", "day2", "month2", "year2", "startDayofYear", "endDayofYear"];
  const ownRow = (flag: string, col: string, model: string) =>
    rowSource ? `CASE WHEN dg.${flag} AND lr._id IS NOT NULL THEN lr."${col}" ELSE ${model} END` : model;
  const disagreeing = rowSource
    ? `,
disagreeing AS (
  SELECT lsn.sample_id,
         ${ROW_FIELDS.map((f) => `count(DISTINCT coalesce(r."${f}", '')) > 1 AS "${f}"`).join(",\n         ")},
         count(DISTINCT concat_ws('-', coalesce(r."year2", ''), coalesce(r."month2", ''), coalesce(r."day2", ''))) > 1 AS end_date
  FROM legacy_specimen_number lsn JOIN ${rowSource} r ON r._id = lsn._id
  GROUP BY lsn.sample_id
)`
    : "";
  const rowJoins = rowSource
    ? `LEFT JOIN disagreeing dg ON dg.sample_id = sp.sample_id
  LEFT JOIN sample_locality_override slo ON slo.sample_id = sp.sample_id
  LEFT JOIN (SELECT _id, ${[...ROW_FIELDS, ...END_FIELDS].map((f) => `CAST("${f}" AS VARCHAR) AS "${f}"`).join(", ")}
             FROM ${rowSource}) lr ON lr._id = lo._id`
    : "";
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
-- Sex and caste as the newest expert determination that states them: an
-- Ecdysis identification records a name and no sex, and becoming the record
-- must not erase the sex an earlier determination gave (35,000 specimens on
-- the sandbox, 2026-09-28).
stated AS (
  SELECT specimen_id,
         arg_max(sex, (recorded_at, entity_id)) FILTER (WHERE nullif(sex, '') IS NOT NULL) AS sex,
         arg_max(caste, (recorded_at, entity_id)) FILTER (WHERE nullif(caste, '') IS NOT NULL) AS caste
  FROM determination WHERE is_expert
  GROUP BY specimen_id
),
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
         string_agg(coalesce(${labelInitials("p")},
                             CASE WHEN nullif(p.given_name, '') IS NOT NULL THEN concat(left(p.given_name, 1), '.') ELSE '' END),
                    ' | ' ORDER BY sc.position) AS initials
  FROM sample_collector sc JOIN person p ON p.entity_id = sc.person_id
  GROUP BY sc.sample_id
)${disagreeing},
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
               WHEN ${labelInitials("p")} IS NOT NULL THEN ${labelInitials("p")}
               WHEN nullif(p.given_name, '') IS NOT NULL THEN concat(left(p.given_name, 1), '.') END`)} AS "firstNameInitial",
    ${t("CASE WHEN c.n > 1 THEN c.family_names ELSE p.family_name END")} AS "lastName",
    ${t("c.recorded_by")} AS "recordedBy",
    ${t("s.sample_number")} AS "sampleId",
    ${t(orStaged("specimenId", "CAST(sp.specimen_number AS VARCHAR)"))} AS "specimenId",
    ${t("day(s.date_start)")} AS "day",
    ${t("month(s.date_start)")} AS "month",
    ${t("year(s.date_start)")} AS "year",
    ${t(ownRow("end_date", "verbatimEventDate", `CASE WHEN s.date_end > s.date_start
               THEN concat(strftime(s.date_start, '%Y-%-m-%-d'), '/', strftime(s.date_end, '%Y-%-m-%-d'))
               ELSE strftime(s.date_start, '%-m/%-d/%Y') END`))} AS "verbatimEventDate",
    ${t(ownRow("end_date", "day2", "CASE WHEN s.date_end > s.date_start THEN CAST(day(s.date_end) AS VARCHAR) END"))} AS "day2",
    ${t(ownRow("end_date", "month2", "CASE WHEN s.date_end > s.date_start THEN CAST(month(s.date_end) AS VARCHAR) END"))} AS "month2",
    ${t(ownRow("end_date", "year2", "CASE WHEN s.date_end > s.date_start THEN CAST(year(s.date_end) AS VARCHAR) END"))} AS "year2",
    ${t(ownRow("end_date", "startDayofYear", "CASE WHEN s.date_end > s.date_start THEN CAST(dayofyear(s.date_start) AS VARCHAR) END"))} AS "startDayofYear",
    ${t(ownRow("end_date", "endDayofYear", "CASE WHEN s.date_end > s.date_start THEN CAST(dayofyear(s.date_end) AS VARCHAR) END"))} AS "endDayofYear",
    -- The legacy file's country is the short name its places file gives a
    -- country — USA, but CA and NZ — where Beeline keeps ISO alpha-3 codes.
    ${t(ownRow('"country"', "country", "CASE s.country WHEN 'CAN' THEN 'CA' WHEN 'NZL' THEN 'NZ' WHEN 'MEX' THEN 'MX' ELSE s.country END"))} AS "country",
    ${t(ownRow('"stateProvince"', "stateProvince", "s.state_province"))} AS "stateProvince",
    ${t(ownRow('"county"', "county", "s.county"))} AS "county",
    -- A locality staff set on the sample is the sample's, whatever its rows said.
    ${t(ownRow('"locality" AND slo.sample_id IS NULL', "locality", "s.locality"))} AS "locality",
    ${t(ofRowPoint("verbatimElevation", "loc.elevation_m", "loc.elevation_latitude", "loc.elevation_longitude"))} AS "verbatimElevation",
    ${t(coord("decimalLatitude", "loc.latitude"))} AS "decimalLatitude",
    ${t(coord("decimalLongitude", "loc.longitude"))} AS "decimalLongitude",
    ${t(ofRowPoint("coordinateUncertaintyInMeters", "loc.coordinate_uncertainty_m", "loc.latitude", "loc.longitude"))} AS "coordinateUncertaintyInMeters",
    -- Like the coordinates it describes: an imported point Beeline has not
    -- replaced keeps what the legacy row said about it; a point Beeline took
    -- from iNaturalist says which projection it came from.
    ${t(`CASE WHEN loc.source = 'legacy_import' AND lo._id IS NOT NULL THEN lo."coordinateSource"
               WHEN loc.source = 'inat_trusted' THEN 'private'
               WHEN loc.source = 'inat_public' THEN 'public' END`)} AS "coordinateSource",
    ${t(ownRow('"samplingProtocol"', "samplingProtocol", "s.protocol"))} AS "samplingProtocol",
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
    -- An expert identification where Beeline holds one; where it holds none,
    -- what the legacy row said, as it said it: a determiner with no name
    -- (L.R.Best on 88 records), or a name the tree could not place, has no
    -- determination to live on, as with the volunteer columns below.
    ${t(unidentified("phylum", "el.phylum"))} AS "phylum",
    ${t(unidentified("class", "el.class_name"))} AS "class",
    ${t(unidentified("order", "el.order_name"))} AS "order",
    ${t(unidentified("family", "el.family"))} AS "family",
    ${t(unidentified("genus", "el.genus"))} AS "genus",
    -- The tree files a species under its genus, so a subgenus the legacy
    -- determination stated (Lasioglossum kincaidii in Hemihalictus) is held
    -- nowhere in the model; while that determination is still the record the
    -- column is the legacy row's, as written (Peter, 2026-10-04), and a later
    -- determination writes the model's.
    ${t(`CASE WHEN (e.channel = 'legacy_import' OR e.entity_id IS NULL) AND lo._id IS NOT NULL THEN lo."subgenus" ELSE el.subgenus END`)} AS "subgenus",
    ${t(unidentified("specificEpithet", `CASE WHEN el.species IS NOT NULL THEN ${epithet("el.species")} END`))} AS "specificEpithet",
    ${t(`lo."taxonomicNotes"`)} AS "taxonomicNotes",
    -- The legacy file writes an open-nomenclature qualifier inside the name:
    -- "Lasioglossum nr. tenax", which is also how the determiner wrote it.
    ${t(unidentified("scientificName", `CASE WHEN e.qualifier IS NOT NULL AND el.species IS NOT NULL
               THEN concat(el.genus, ' ', e.qualifier, ' ', ${epithet("el.species")})
               ELSE ea.scientific_name END`))} AS "scientificName",
    -- Beeline keeps sex and caste on a determination, so a specimen the legacy
    -- system sexed but nobody has identified has nowhere to hold them: 24,217
    -- such rows in the 2026-09-27 corpus. Those carry the staged value.
    ${t(`coalesce(st.sex, lo."sex")`)} AS "sex",
    ${t(`coalesce(st.caste, lo."caste")`)} AS "caste",
    ${t(unidentified("taxonRank", "CASE WHEN ea.rank IS NOT NULL THEN concat(upper(left(ea.rank, 1)), substr(ea.rank, 2)) END"))} AS "taxonRank",
    ${t(unidentified("identifiedBy", "coalesce(nullif(e.determiner_name, ''), dp.display_name)"))} AS "identifiedBy",
    -- A volunteer's identification, where Beeline holds one; where it holds
    -- none, what the legacy row said, as it said it: a sex with no name, or
    -- a name the tree could not place, has no determination to live on.
    ${t(`CASE WHEN v.entity_id IS NULL AND lo._id IS NOT NULL THEN lo."familyVolDet" ELSE vl.family END`)} AS "familyVolDet",
    ${t(`CASE WHEN v.entity_id IS NULL AND lo._id IS NOT NULL THEN lo."genusVolDet" ELSE vl.genus END`)} AS "genusVolDet",
    ${t(`CASE WHEN v.entity_id IS NULL AND lo._id IS NOT NULL THEN lo."speciesVolDet"
               WHEN vl.species IS NOT NULL THEN ${epithet("vl.species")} END`)} AS "speciesVolDet",
    ${t(`CASE WHEN v.entity_id IS NULL AND lo._id IS NOT NULL THEN lo."sexVolDet" ELSE v.sex END`)} AS "sexVolDet",
    ${t(`CASE WHEN v.entity_id IS NULL AND lo._id IS NOT NULL THEN lo."casteVolDet" ELSE v.caste END`)} AS "casteVolDet",
    -- iNaturalist's, and the model holds them only for a linked sample; an
    -- imported sample it never linked keeps what the legacy record said.
    ${t(`coalesce(s.geoprivacy, nullif(lo."geoprivacy", ''))`)} AS "geoprivacy",
    ${t(`coalesce(s.taxon_geoprivacy, nullif(lo."taxon_geoprivacy", ''))`)} AS "taxon_geoprivacy",
    -- (the composite sort is computed from these columns below)
    sp.entity_id AS sort_tiebreak
  FROM specimen sp
  JOIN sample s ON s.entity_id = sp.sample_id
  LEFT JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
  LEFT JOIN person p ON p.entity_id = pc.person_id
  LEFT JOIN inat_account ia ON ia.person_id = pc.person_id
  LEFT JOIN collectors c ON c.sample_id = s.entity_id
  LEFT JOIN sample_location loc ON loc.sample_id = s.entity_id
  LEFT JOIN expert e ON e.specimen_id = sp.entity_id
  LEFT JOIN stated st ON st.specimen_id = sp.entity_id
  LEFT JOIN animal ea ON ea.entity_id = e.animal_id
  LEFT JOIN lineage el ON el.node_id = e.animal_id
  LEFT JOIN person dp ON dp.entity_id = e.determiner_id
  LEFT JOIN volunteer v ON v.specimen_id = sp.entity_id
  LEFT JOIN lineage vl ON vl.node_id = v.animal_id
  LEFT JOIN printed pr ON pr.specimen_id = sp.entity_id
  ${staged}
  ${rowJoins}
)
SELECT ${LEGACY_EXPORT_COLUMNS.map((c) => `"${c}"`).join(", ")}
FROM rows
-- The reference's composite_sort, byte for byte (OccurrenceRepository
-- setSortField): one string of the sort fields joined with "|", a number
-- padded to 16 digits, a blank or non-number as sixteen z's, compared as
-- bytes. Built from the columns as written, so a joint sample's
-- "Trapper | Collector" sorts where the legacy file put it.
ORDER BY concat_ws('|', ${sortNumber('"fieldNumber"')}, ${sortText('"lastName"')}, ${sortText('"firstName"')},
                        ${sortNumber('"month"')}, ${sortNumber('"day"')}, ${sortNumber('"sampleId"')}, ${sortNumber('"specimenId"')}),
         sort_tiebreak`;
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
  const staging = await stagedColumns(conn);
  // Promotion's corrected staging, where it has run: the rows as staff left them.
  const rowSource =
    staging === null
      ? null
      : (await scalar(conn, `SELECT count(*) FROM duckdb_views() WHERE view_name = 'legacy_occurrence_corrected'`)) > 0
        ? "legacy_occurrence_corrected"
        : "legacy_occurrence";
  const body = `${path}.body.tmp`;
  const whole = `${path}.tmp`;
  try {
    await conn.run(
      `COPY (${legacyExportSql(staging, rowSource)}) TO '${body.replaceAll("'", "''")}'
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
  return { rows, staged: staging !== null };
}
