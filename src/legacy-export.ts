import type { DuckDBConnection } from "@duckdb/node-api";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { methodNamesTrapSql } from "./trap-method.js";

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
 * the taxonomic notes, the print date of a label printed before Beeline. A
 * Beeline-originated specimen has none of those, and gets them from the model
 * where it holds the fact (the observation's link) and blank where it does
 * not. The plant is the exception: it is the sample's floral host as the store
 * holds it, for every specimen whether or not old Beeline held it
 * (beeline-qpys), so a host that followed its observation, or that staff set,
 * reaches the file, and its family, order and phylum are read from its lineage
 * in the taxon cache. Except where the old record is the truer one (Peter,
 * 2026-11-21): a row of a sample whose old rows name different plants, and a
 * plant the store holds at a broader rank than the old record gave, keep the
 * old record's plant (see "WHERE THE OLD RECORD'S PLANT STANDS" below). Where
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
  // The one column after the template's: the inventory's remark on the
  // specimen (specimen_disposition, beeline-fud5), which the old system's
  // own 2025 master file carries under this name and the template never
  // had. Last, so a reader of the 63 columns by position reads what it read.
  "occurrenceRemarks",
] as const;

/** iNaturalist's order of ranks, finest to broadest: a higher number is a broader rank. Hybrids are species-level. */
export const RANK_LEVEL: Record<string, number> = {
  form: 5, variety: 5, subspecies: 5, species: 10, hybrid: 10, infrahybrid: 5, complex: 11, subsection: 12, section: 13, subgenus: 15,
  genus: 20, subtribe: 24, tribe: 25, supertribe: 26, subfamily: 27, family: 30, epifamily: 32, superfamily: 33, order: 40,
  class: 50, phylum: 60,
};

/** Staged legacy columns the export reads, when the store holds staging at all. */
const STAGED = [
  "_id", "errorFlags", "dateLabelPrint", "catalogNumber", "occurrenceID", "userId", "userLogin", "specimenId",
  "decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters", "coordinateSource", "relationshipOfResource", "resourceID",
  "relatedResourceID", "relationshipRemarks", "phylumPlant", "orderPlant", "familyPlant", "genusPlant",
  "speciesPlant", "taxonRankPlant", "url", "taxonomicNotes", "sex", "caste", "geoprivacy", "taxon_geoprivacy",
  "verbatimElevation", "phylum", "class", "order", "family", "genus", "subgenus", "specificEpithet",
  "scientificName", "taxonRank", "identifiedBy", "familyVolDet", "genusVolDet", "speciesVolDet", "sexVolDet", "casteVolDet",
  // Not written as staged: read to tell a record whose collectors staff corrected.
  "recordedBy",
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
 * What legacyExportSql reads from this store: its staged columns, and the
 * rows the export takes a row's own place and method from — promotion's
 * corrected staging where it has run, the rows as staff left them.
 */
export async function legacyExportSources(
  conn: DuckDBConnection,
): Promise<{ staging: Set<string> | null; rowSource: string | null }> {
  const staging = await stagedColumns(conn);
  const rowSource =
    staging === null
      ? null
      : (await scalar(conn, `SELECT count(*) FROM duckdb_views() WHERE view_name = 'legacy_occurrence_corrected'`)) > 0
        ? "legacy_occurrence_corrected"
        : "legacy_occurrence";
  return { staging, rowSource };
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
/**
 * The export as two statements: `rows`, every specimen's 63 values and the
 * sort tiebreak, unordered; and `ordered(table)`, those values read back from
 * wherever `rows` was put, in the legacy file's order. They are two because
 * the sort must not share a pipeline with the joins — see writeLegacyExport.
 */
export function legacyExportSql(
  staging: Set<string> | null,
  rowSource: string | null = null,
  /** A query of specimen ids to restrict the rows to, or null for every specimen (src/legacy-copy.ts). */
  specimens: string | null = null,
): { rows: string; ordered: (table: string) => string } {
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
  // specimen, which has no staged record, gets the model's own value. Now used
  // only for the specimen's number under its sample: the plant is not one of
  // these (beeline-qpys).
  const orStaged = (col: string, model: string) => `CASE WHEN lo._id IS NOT NULL THEN lo."${col}" ELSE ${model} END`;
  const unidentified = (col: string, model: string) =>
    `CASE WHEN e.entity_id IS NULL AND lo._id IS NOT NULL THEN lo."${col}" ELSE ${model} END`;
  // The reference writes a coordinate with toFixed(4): always four places,
  // "44.5000", which a join on the text would otherwise miss.
  // Everything after the genus and an optional "(Subgenus)": the epithet can
  // be more than one word ("verbesinae complex"), so the last word is not it.
  const epithet = (name: string) => `regexp_replace(${name}, '^\\S+\\s+(\\([^)]*\\)\\s+)?', '')`;
  // Whether the old record names an expert identification: the only kind of
  // record whose own sex and caste the export carries (beeline-eznn).
  const expertNamed = `concat(trim(lo.family), trim(lo.genus), trim(lo."specificEpithet"), trim(lo."scientificName")) <> ''`;
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
  // Whether staff put someone else first on this record: its collectors were
  // corrected (src/app/sample-collectors.ts), and the sample's first collector
  // is not the person promotion read the record's own names as. Decided by
  // person, not by spelling, so a first collector renamed since, or reached
  // through a collector alias, is still the same person, and adding a
  // collector after them leaves the record's own login standing. Only a
  // store promotion left has the corrections and legacy_person_map.
  const promoted = rowSource === "legacy_occurrence_corrected";
  const collectorsCorrected = promoted
    ? `(lr._id IS NOT NULL AND lr."recordedBy" IS DISTINCT FROM lo."recordedBy"
        AND lpm.person_id IS DISTINCT FROM pc.person_id)`
    : "false";
  // The plant an old record names: the lowest rank it gives, written as old
  // Beeline wrote it (a whole name in the genus column, or an epithet alone
  // beside the genus, is the name it spells). `a` is the alias of a table with
  // the template's plant columns. The same identity the comparison's
  // rows_disagree reads, so two spellings of one plant's lineage are one plant.
  const plain = (x: string) => `lower(trim(regexp_replace(${x}, '\\s+', ' ', 'g')))`;
  const namedPlant = (a: string) => {
    const g = `trim(${a}."genusPlant")`;
    const sp = `trim(${a}."speciesPlant")`;
    return `CASE WHEN ${sp} LIKE '% %' THEN ${sp}
                 WHEN ${g} LIKE '% %' THEN ${g}
                 WHEN nullif(${sp}, '') IS NOT NULL THEN concat_ws(' ', nullif(${g}, ''), ${sp})
                 ELSE coalesce(nullif(${g}, ''), nullif(trim(${a}."familyPlant"), ''), nullif(trim(${a}."orderPlant"), ''),
                               nullif(trim(${a}."phylumPlant"), '')) END`;
  };
  const disagreeing = rowSource
    ? `,
disagreeing AS (
  SELECT lsn.sample_id,
         ${ROW_FIELDS.map((f) => `count(DISTINCT coalesce(r."${f}", '')) > 1 AS "${f}"`).join(",\n         ")},
         count(DISTINCT concat_ws('-', coalesce(r."year2", ''), coalesce(r."month2", ''), coalesce(r."day2", ''))) > 1 AS end_date,
         -- The plant each old row names by its lowest rank, a row naming none
         -- counting as one more (beeline-qpys).
         count(DISTINCT coalesce(${plain(namedPlant("r"))}, '')) > 1 AS plant
  FROM legacy_specimen_number lsn JOIN ${rowSource} r ON r._id = lsn._id
  GROUP BY lsn.sample_id
)`
    : "";
  const rowJoins = rowSource
    ? `LEFT JOIN disagreeing dg ON dg.sample_id = sp.sample_id
  LEFT JOIN sample_locality_override slo ON slo.sample_id = sp.sample_id
  LEFT JOIN sample_host_override sho ON sho.sample_id = sp.sample_id
  LEFT JOIN sample_location_override slc ON slc.sample_id = sp.sample_id
  LEFT JOIN (SELECT _id, ${[...ROW_FIELDS, ...END_FIELDS, "recordedBy", "firstName", "lastName"].map((f) => `CAST("${f}" AS VARCHAR) AS "${f}"`).join(", ")}
             FROM ${rowSource}) lr ON lr._id = lo._id${
               promoted
                 ? `
  LEFT JOIN legacy_person_map lpm ON lpm.fn IS NOT DISTINCT FROM nullif(trim(lr."firstName"), '')
                                 AND lpm.ln IS NOT DISTINCT FROM nullif(trim(lr."lastName"), '')`
                 : ""
             }`
    : "";
  // THE PLANT (beeline-qpys). It is the sample's floral host as the store
  // holds it, for every specimen, whether or not old Beeline held it, written
  // the way old Beeline wrote it so that the same plant reads the same in both
  // files (OBP-Server, shared/lib/services/PlantTaxaService.js,
  // getPlantAncestry). That function walked the observation taxon's ancestors,
  // kept the one named at each of five ranks (phylum, order, family, genus,
  // species), and then put the taxon itself at its own rank; the species column
  // took the taxon's whole name for a species, hybrid, subspecies, variety or
  // form. So a variety is "Nemophila menziesii atomaria" with no rank marker, a
  // hybrid is "Osmanthus × burkwoodii", a host at genus rank has a genus and an
  // empty species, and a host at family or tribe rank has its family, order and
  // phylum and no genus. The ranks between genus and species (section, complex,
  // subgenus, subsection) take their genus from the lineage.
  const SPECIES_RANKS = ["species", "subspecies", "variety", "form", "hybrid", "infrahybrid"];
  const hostName = `nullif(s.host_name_as_observed, '')`;
  const inRanks = (ranks: string[]) => `s.host_rank IN (${ranks.map((r) => `'${r}'`).join(", ")})`;
  const plantGenus = `CASE WHEN ${inRanks(["genus", ...SPECIES_RANKS])}
                           THEN nullif(split_part(regexp_replace(${hostName}, '^×\\s*', ''), ' ', 1), '')
                           WHEN ${inRanks(["complex", "section", "subgenus", "subsection"])} THEN pl.genus END`;
  const plantSpecies = `CASE WHEN ${inRanks(SPECIES_RANKS)} THEN ${hostName} END`;
  // The old record names the same plant as the store gives (its lowest rank is
  // the name the sample holds as its host): its family, order and phylum can
  // then stand in where the taxon cache cannot give the lineage. Never the
  // store's genus beside another plant's family.
  const samePlant = `(lo._id IS NOT NULL AND ${hostName} IS NOT NULL AND coalesce(${plain(namedPlant("lo"))}, '') = ${plain(hostName)})`;
  const lineageOrOld = (lineage: string, col: string) =>
    `CASE WHEN pl.sample_id IS NOT NULL THEN pl.${lineage} WHEN ${samePlant} THEN lo."${col}" END`;
  // WHERE THE OLD RECORD'S PLANT STANDS (Peter, 2026-11-21): a specimen's record
  // stays faithful to its old record unless the sample's data and judgment
  // improve it. Two cases are no improvement, and the six plant columns are the
  // old record's. In both, a host staff set on the sample wins, as a locality
  // staff set does, and so does a host that follows the sample's observation,
  // which is a later identification of it.
  //  1. The old rows of the sample name different plants (ownPlant), and this
  //     row's plant is not the one the sample holds: the sample holds one host,
  //     so each row keeps its own, and its own relationship to it, by the rule
  //     for method, end date and place (ownRow, 2026-10-04). A row that names
  //     the sample's plant in another form keeps the model's form of it.
  //  2. The old record names the same plant, and the store holds it less
  //     exactly (oldFiner): a tribe, section or variety as a family, genus or
  //     species (promotion takes the rank of a sample whose host is not its
  //     observation's from whichever old column was filled), or a hybrid as a
  //     species. A rank the old record writes as a dash or leaves blank says
  //     nothing finer, so the store's stands.
  const rankLevel = (x: string) =>
    `CASE ${x} ${Object.entries(RANK_LEVEL).map(([r, n]) => `WHEN '${r}' THEN ${n}`).join(" ")} END`;
  const oldRank = `lower(trim(lo."taxonRankPlant"))`;
  const staffHost = rowSource ? `sho.sample_id IS NOT NULL` : "false";
  const followsObservation = `hf.sample_id IS NOT NULL`;
  const keepsOld = `NOT ${staffHost} AND NOT ${followsObservation}`;
  const ownPlant = rowSource
    ? `(dg.plant AND lr._id IS NOT NULL AND ${hostName} IS NOT NULL AND ${keepsOld} AND NOT ${samePlant})`
    : "false";
  const oldFiner = `(${samePlant} AND ${keepsOld}
                     AND (${rankLevel("s.host_rank")} > ${rankLevel(oldRank)}
                          OR (${oldRank} IN ('hybrid', 'infrahybrid') AND s.host_rank NOT IN ('hybrid', 'infrahybrid'))))`;
  const oldsPlant = `(${ownPlant} OR ${oldFiner})`;
  const plantCol = (col: string, model: string) => `CASE WHEN ${oldsPlant} THEN lo."${col}" ELSE ${model} END`;
  const rows = `
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
-- A sample's floral host as the taxon cache gives its lineage (beeline-qpys):
-- the name at each rank old Beeline filled, read from the host's current taxon
-- and its ancestors, the taxon itself included. A host whose current taxon or
-- any ancestor the cache has not read yet, or that has no current taxon (it
-- was split, or retired with nothing after it), has no row: its lineage is
-- not known, which is not the same as having none.
plant_lineage AS (
  SELECT h.sample_id,
         max(t.name) FILTER (WHERE t.rank = 'phylum') AS phylum,
         max(t.name) FILTER (WHERE t.rank = 'order') AS order_name,
         max(t.name) FILTER (WHERE t.rank = 'family') AS family,
         max(t.name) FILTER (WHERE t.rank = 'genus') AS genus
  FROM sample_host h
  JOIN inat_taxon_ancestor a ON a.inat_taxon_id = h.current_taxon_id
  LEFT JOIN inat_taxon t ON t.inat_taxon_id = a.ancestor_id
  GROUP BY h.sample_id
  HAVING bool_and(t.inat_taxon_id IS NOT NULL)
),
-- A sample whose floral host is the very taxon its observation names, so the
-- host is the observation's and not what the import stated.
host_follows AS (
  SELECT DISTINCT s.entity_id AS sample_id
  FROM sample s JOIN observation_host f ON f.inat_id = s.inat_observation_id
  WHERE f.host_taxon_id IS NOT NULL AND f.host_taxon_id = s.host_inat_taxon_id
),
latest AS (
  SELECT d.*, row_number() OVER (PARTITION BY d.specimen_id, d.is_expert ORDER BY d.recorded_at DESC, d.entity_id DESC) AS rn
  FROM determination d
),
expert AS (SELECT * FROM latest WHERE is_expert AND rn = 1),
-- Sex and caste as the newest expert determination that states them: an
-- identification that gives a name and no sex must not erase the sex an
-- earlier determination gave (35,000 specimens on the sandbox, 2026-09-28).
-- Many Ecdysis identifications do give a sex, and then it is the newest.
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
    -- Beeline mints no occurrenceID (ADR 0008, amended 2026-10-23), so a
    -- specimen with no legacy row has none, and the legacy row's own is kept.
    ${t(`lo."occurrenceID"`)} AS "occurrenceID",
    -- The first collector's account, and the old record's own where they
    -- have none, except on a record staff put another first collector on:
    -- its own login was the old first collector's, so it says nothing of the
    -- new one (beeline-kgyd.4.5).
    ${t(`CASE WHEN ${collectorsCorrected} THEN CAST(ia.inat_user_id AS VARCHAR)
               ELSE coalesce(CAST(ia.inat_user_id AS VARCHAR), nullif(lo."userId", '')) END`)} AS "userId",
    ${t(`CASE WHEN ${collectorsCorrected} THEN ia.login ELSE coalesce(ia.login, nullif(lo."userLogin", '')) END`)} AS "userLogin",
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
    -- Where staff set the sample's point, its country, state and county went
    -- with it (src/derive-area.ts): the sample's, whatever each row said.
    ${t(ownRow('"country" AND slc.sample_id IS NULL', "country", "CASE s.country WHEN 'CAN' THEN 'CA' WHEN 'NZL' THEN 'NZ' WHEN 'MEX' THEN 'MX' ELSE s.country END"))} AS "country",
    ${t(ownRow('"stateProvince" AND slc.sample_id IS NULL', "stateProvince", "s.state_province"))} AS "stateProvince",
    ${t(ownRow('"county" AND slc.sample_id IS NULL', "county", "s.county"))} AS "county",
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
    -- A trap's plant is near the trap, never a flower its bees were seen on
    -- (beeline-vjqy): judged on the row's own method, as the file writes it,
    -- and only where the row writes a plant (the sample's floral host, for
    -- every specimen) and the old record said "visits flowers of" or nothing.
    -- Old trap records hold other things here too, most of them a number on
    -- the 2026 vane-trap records (10, 18, 6: 17,263 records on the backup of
    -- 16 November 2026), which are not this claim and stay as the old record
    -- had them. Any other value the old record gave stays, and a blank one is
    -- filled with the claim where the sample has a host, as for a specimen
    -- with no old record. Where the sample has no host, an old value of exactly
    -- "visits flowers of" or "near" claimed a plant nobody names: blank.
    -- Where the old rows of the sample name different plants, the row's own.
    ${t(`CASE WHEN ${ownPlant} THEN lo."relationshipOfResource"
               WHEN ${methodNamesTrapSql(ownRow('"samplingProtocol"', "samplingProtocol", "s.protocol"))}
               AND ${hostName} IS NOT NULL
               AND coalesce(trim(lo."relationshipOfResource"), '') IN ('', 'visits flowers of') THEN 'near'
               WHEN lo._id IS NOT NULL AND nullif(lo."relationshipOfResource", '') IS NOT NULL
                AND NOT (${hostName} IS NULL AND trim(lo."relationshipOfResource") IN ('visits flowers of', 'near'))
                 THEN lo."relationshipOfResource"
               WHEN ${hostName} IS NOT NULL THEN 'visits flowers of' END`)} AS "relationshipOfResource",
    ${t(`lo."resourceID"`)} AS "resourceID",
    ${t(`lo."relatedResourceID"`)} AS "relatedResourceID",
    ${t(`lo."relationshipRemarks"`)} AS "relationshipRemarks",
    -- The floral host as the store holds it (beeline-qpys); family, order and
    -- phylum from its lineage, or the old record's where the cache cannot give
    -- one and the old record names the same plant.
    ${t(plantCol("phylumPlant", lineageOrOld("phylum", "phylumPlant")))} AS "phylumPlant",
    ${t(plantCol("orderPlant", lineageOrOld("order_name", "orderPlant")))} AS "orderPlant",
    ${t(plantCol("familyPlant", lineageOrOld("family", "familyPlant")))} AS "familyPlant",
    ${t(plantCol("genusPlant", plantGenus))} AS "genusPlant",
    ${t(plantCol("speciesPlant", plantSpecies))} AS "speciesPlant",
    ${t(plantCol("taxonRankPlant", "s.host_rank"))} AS "taxonRankPlant",
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
    -- Sex and caste are the expert's, so the old record's are carried only
    -- where it names an expert identification (Peter, 2026-11-15,
    -- beeline-eznn). From 2023 the old Beeline wrote "male" on records nobody
    -- had identified: 24,434 of them on the store of 2026-11-15 (1,352 in
    -- 2023, 4,965 in 2024, 18,117 in 2025), and no unidentified record said
    -- female but 38 a volunteer had named. Where experts have since sexed such
    -- a bee in Ecdysis, the old "male" was female 7,150 times and male 6,917,
    -- so it was an entry default, not an identification. Until then this
    -- carried the old value for every specimen nobody had identified.
    ${t(`coalesce(st.sex, CASE WHEN ${expertNamed} THEN lo."sex" END)`)} AS "sex",
    ${t(`coalesce(st.caste, CASE WHEN ${expertNamed} THEN lo."caste" END)`)} AS "caste",
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
    -- What became of the pin, where somebody has said (beeline-fud5).
    ${t("sd.remarks")} AS "occurrenceRemarks",
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
  LEFT JOIN specimen_disposition sd ON sd.specimen_id = sp.entity_id
  LEFT JOIN plant_lineage pl ON pl.sample_id = s.entity_id
  LEFT JOIN host_follows hf ON hf.sample_id = s.entity_id
  ${staged}
  ${rowJoins}
  ${specimens === null ? "" : `WHERE sp.entity_id IN (${specimens})`}
)
SELECT * FROM rows`;
  const ordered = (table: string) => `
SELECT ${LEGACY_EXPORT_COLUMNS.map((c) => `"${c}"`).join(", ")}
FROM ${table}
-- The reference's composite_sort, byte for byte (OccurrenceRepository
-- setSortField): one string of the sort fields joined with "|", a number
-- padded to 16 digits, a blank or non-number as sixteen z's, compared as
-- bytes. Built from the columns as written, so a joint sample's
-- "Trapper | Collector" sorts where the legacy file put it.
ORDER BY concat_ws('|', ${sortNumber('"fieldNumber"')}, ${sortText('"lastName"')}, ${sortText('"firstName"')},
                        ${sortNumber('"month"')}, ${sortNumber('"day"')}, ${sortNumber('"sampleId"')}, ${sortNumber('"specimenId"')}),
         sort_tiebreak`;
  return { rows, ordered };
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
 *
 * On one thread, whoever calls it. The join against the staged legacy records
 * and the final sort are the export's memory, and DuckDB holds a share of
 * both per thread: measured on a local copy of the sandbox's 2026-10-04 corpus, it
 * needs about 830 MB on one thread and 1,150 MB on two, against the 1.5 GB
 * fly.production.toml gives DuckDB (the sandbox had the same), 1 GB until the two-thread CLI ran
 * out (beeline-1w2d; 700 MB and 830 MB before #136 carried more of the
 * legacy row). Under that budget one thread is no slower than two. threads
 * is a setting of the whole instance, so it is put back however this ends.
 *
 * The rows go into a temporary table before they are sorted, because sorting
 * them as they come out of the joins ran out of memory in a way more memory
 * did not cure: on a copy of the sandbox's store of 2026-10-07 the one
 * statement failed at 768 MB and at the sandbox's 1.5 GB and succeeded at
 * 1 GB and 1.8 GB, on DuckDB 1.5.5 and 1.5.6 alike — the sort shares its
 * pipeline with some twenty join hash tables, and at some budgets it plans
 * to keep in memory what they leave it no room for. Every nightly export
 * from 5 to 7 October failed that way. Materialized first, the joins are
 * done and released before the sort begins, and the same store exports at
 * every budget from 768 MB up, as fast, byte for byte the same.
 */
export async function writeLegacyExport(conn: DuckDBConnection, path: string): Promise<{ rows: number; staged: boolean }> {
  await mkdir(dirname(path), { recursive: true });
  const { staging, rowSource } = await legacyExportSources(conn);
  const body = `${path}.body.tmp`;
  const whole = `${path}.tmp`;
  const [[threads]] = (await (await conn.run(`SELECT current_setting('threads')`)).getRows()) as [[bigint | number]];
  await conn.run("SET threads = 1");
  const sql = legacyExportSql(staging, rowSource);
  try {
    await conn.run(`CREATE OR REPLACE TEMP TABLE legacy_export_rows AS ${sql.rows}`);
    await conn.run(
      `COPY (${sql.ordered("legacy_export_rows")}) TO '${body.replaceAll("'", "''")}'
       (FORMAT csv, HEADER true, DELIMITER ',', QUOTE '"', ESCAPE '"', NULLSTR '')`,
    );
    const out = createWriteStream(whole);
    out.write(BOM);
    await pipeline(createReadStream(body), out);
    await rename(whole, path);
  } finally {
    try {
      await conn.run(`SET threads = ${Number(threads)}`);
    } finally {
      try {
        await conn.run("DROP TABLE IF EXISTS temp.legacy_export_rows");
      } finally {
        await rm(body, { force: true });
        await rm(whole, { force: true });
      }
    }
  }
  const rows = await scalar(conn, "SELECT count(*) FROM specimen");
  return { rows, staged: staging !== null };
}
