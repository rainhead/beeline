import type { DuckDBConnection } from "@duckdb/node-api";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import { adoptEcdysisNames, type AdoptedName } from "./adopt-ecdysis.js";
import { csvCell } from "./app/listings.js";
import { DEFAULT_DB } from "./person-change.js";
import { readReceived } from "./received-files.js";

/**
 * A taxonomist's or an atlas lead's own sheet of expert determinations, one
 * row per specimen, onto the specimens it names (beeline-t8zv). The first was
 * the Idaho Bee Atlas's of November 2026: every Idaho bee a qualified
 * determiner had named to at least genus, 2,140 rows, sent by Karleen Davis.
 *
 * The file comes from `pnpm received:fetch` (src/received-files.ts), whose
 * directory says which Drive file it is and when it was sent; those are the
 * provenance kept in worksheet_determination, beside the tab and row. The
 * channel is `worksheet_import` with is_expert true: DuckDB cannot add a
 * channel value to a deployed store's CHECK (ADR 0006), and a sheet is what
 * the channel already names.
 *
 * Columns are Darwin Core terms, matched by header: `fieldNumber`, `genus`
 * and `identifiedBy` are required, `family`, `specificEpithet`, `sex` and
 * `dateIdentified` are read when present (`ID Date` is read as the last, the
 * header Idaho's second sheet gave it). `recordedBy` or `lastName`, and `eventDate` or
 * `verbatimEventDate`, are there to confirm the number: a row whose collector
 * is none of its specimen's collectors, or whose date falls outside its
 * sample's, is held, because a number typed into a sheet is the likeliest
 * thing in it to be wrong.
 *
 * What is recorded is what the sheet says, and nothing is guessed:
 * - The name is the genus and the epithet, through ingest/taxon-aliases.csv
 *   for spelling, as written in `verbatim_identification`. `sp.` or `spp.` as
 *   an epithet is a determination to genus. A name the tree lacks and
 *   Ecdysis's thesaurus accepts is adopted from it (src/adopt-ecdysis.ts);
 *   any other is held, since a name is a taxonomist's decision.
 * - A family that is not the family the tree files the name under is held.
 * - The determiner goes through ingest/determiner-aliases.csv, as legacy
 *   promotion's do, and a person that file names who is not in the store yet
 *   is created, as promotion creates them. A spelling the file does not
 *   know is held: who determined a bee is a fact somebody has to state. A
 *   blank `identifiedBy` is recorded with no determiner, because the sheet's
 *   author vouches that its rows are an expert's.
 * - A specimen whose determination of record already says the same — the
 *   same name, the same determiner, and the same sex where the sheet gives
 *   one — is skipped; anything else is recorded, now, and so supersedes what
 *   was there, an earlier expert's included. The result lists those.
 * - The date of a determination is a day, or a bare year, which is kept as
 *   a year (determined_on_precision). A date the row cannot have — after
 *   today, or wholly before its sample was collected — is held. A row that
 *   is skipped because its determination already stands gives that
 *   determination its date when it has none, as the Ecdysis loader fills sex
 *   and caste: the date is a missing fact about the same event, not a new
 *   assertion. A date already there is kept, and the result lists any the
 *   sheet disagrees with (beeline-e5ao).
 *
 * Loading the same file again records nothing it recorded before.
 */

export const HELD_REASONS = [
  "no_number",
  "repeated_number",
  "no_specimen",
  "ambiguous_number",
  "collector_disagrees",
  "date_unreadable",
  "date_disagrees",
  "name_unreadable",
  "name_unknown",
  "family_disagrees",
  "identified_unreadable",
  "identified_disagrees",
  "sex_unreadable",
  "determiner_unknown",
] as const;
export type HeldReason = (typeof HELD_REASONS)[number];

export const HELD_COLUMNS = ["row", "field_number", "reason", "family", "genus", "specificEpithet", "sex", "identifiedBy", "detail"] as const;

export const DEFAULT_DETERMINER_ALIASES = new URL("../ingest/determiner-aliases.csv", import.meta.url).pathname;
export const DEFAULT_TAXON_ALIASES = new URL("../ingest/taxon-aliases.csv", import.meta.url).pathname;

export interface DeterminationSheetOptions {
  /** A directory written by `pnpm received:fetch`. */
  dir: string;
  /** The tab; the workbook's first by default. */
  sheet?: string;
  determinerAliases?: string;
  taxonAliases?: string;
  /** Where the held rows go; `held.csv` in the directory by default. */
  heldPath?: string;
  dryRun?: boolean;
  now?: Date;
}

export interface DeterminationSheetResult {
  file: string;
  driveId: string;
  sheet: string;
  rows: number;
  recorded: number;
  /** Recorded over an expert determination of record that said something else. */
  supersededExpert: Array<{ fieldNumber: string; was: string; wasBy: string | null; now: string; nowBy: string | null }>;
  alreadyRecorded: number;
  alreadyLoaded: number;
  /** Determinations that already stood, given the sheet's date where they had none. */
  dated: number;
  /** Determinations that already stood with a date other than the sheet's, which is kept. */
  dateKept: Array<{ fieldNumber: string; stands: string; sheet: string }>;
  held: Record<HeldReason, number>;
  /** Held rows by season: on a sample of an active season, or of a settled one. */
  heldBySeason: { active: number; settled: number; noSpecimen: number };
  adopted: AdoptedName[];
  createdPeople: string[];
  byDeterminer: Array<{ identifiedBy: string | null; person: string | null; rows: number; recorded: number; held: number }>;
  heldPath: string;
}

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

const all = async (conn: DuckDBConnection, sql: string, params: unknown[] = []) =>
  (await (await conn.run(sql, params as never)).getRows()) as unknown[][];
const one = async (conn: DuckDBConnection, sql: string) => Number((await all(conn, sql))[0]?.[0] ?? 0);

/** The first tab's name, from the workbook itself: read_xlsx reads the first tab without saying which. */
async function firstSheet(path: string): Promise<string> {
  const files = unzipSync(new Uint8Array(await readFile(path)), { filter: (f) => f.name === "xl/workbook.xml" });
  const xml = files["xl/workbook.xml"];
  const name = xml === undefined ? undefined : /<sheet\b[^>]*\bname="([^"]*)"/.exec(strFromU8(xml))?.[1];
  if (name === undefined) throw new Error(`${path}: no sheet named in xl/workbook.xml`);
  // One pass, so &amp;lt; becomes &lt; rather than being decoded twice into <.
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return name.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => entities[e]!);
}

/**
 * A date as sheets write one, to a DATE, or NULL: an Excel day number (what
 * a date cell becomes when read as text), ISO 8601, m/d/yyyy, or the
 * collectors' Roman-numeral month, VIII/25/2024.
 */
const DATE_SQL = (col: string) => `CASE
  WHEN regexp_full_match(${col}, '\\d{5}') THEN DATE '1899-12-30' + CAST(${col} AS INTEGER)
  WHEN regexp_full_match(${col}, '\\d{4}-\\d{2}-\\d{2}') THEN try_cast(${col} AS DATE)
  WHEN regexp_full_match(${col}, '\\d{1,2}/\\d{1,2}/\\d{4}') THEN try_strptime(${col}, '%m/%d/%Y')::DATE
  -- Through try_strptime rather than make_date, which raises on a day the
  -- month lacks (IX/31) instead of answering NULL, and would abort the load.
  WHEN regexp_full_match(${col}, '[IVX]+/\\d{1,2}/\\d{4}') THEN try_strptime(concat_ws('-',
         split_part(${col}, '/', 3),
         list_position(['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'], split_part(${col}, '/', 1)),
         split_part(${col}, '/', 2)), '%Y-%m-%d')::DATE
END`;

/** A family name folded to letters, so O'Loughlin and OLoughlin are one. */
const FOLD = (col: string) => `lower(regexp_replace(${col}, '[^A-Za-z]', '', 'g'))`;

export async function loadDeterminationSheet(conn: DuckDBConnection, opts: DeterminationSheetOptions): Promise<DeterminationSheetResult> {
  const received = await readReceived(opts.dir);
  if (extname(received.path).toLowerCase() !== ".xlsx") throw new Error(`${received.path}: not a .xlsx`);
  const sheet = opts.sheet ?? (await firstSheet(received.path));
  const heldPath = opts.heldPath ?? join(opts.dir, "held.csv");
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  await conn.run("INSTALL excel; LOAD excel");
  const source = `read_xlsx(${sqlString(received.path)}, sheet = ${sqlString(sheet)}, header = true, all_varchar = true, stop_at_empty = false)`;
  const present = new Set((await all(conn, `DESCRIBE SELECT * FROM ${source}`)).map((r) => String(r[0])));
  for (const required of ["fieldNumber", "genus", "identifiedBy"]) {
    if (!present.has(required)) throw new Error(`${received.name}, tab ${sheet}: no ${required} column`);
  }
  const col = (...names: string[]) => {
    const name = names.find((n) => present.has(n));
    return name === undefined ? "CAST(NULL AS VARCHAR)" : `nullif(trim("${name}"), '')`;
  };

  await conn.run("BEGIN TRANSACTION");
  try {
    // Every row with anything in it, numbered as the sheet numbers it: the
    // header is row 1.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ds_row AS
      SELECT CAST(ordinality + 1 AS INTEGER) AS row_number,
             ${col("fieldNumber")} AS field_number, ${col("family")} AS family, ${col("genus")} AS genus,
             ${col("specificEpithet")} AS epithet, ${col("sex")} AS sex_text, ${col("identifiedBy")} AS identified_by,
             ${col("recordedBy", "lastName")} AS collector, ${col("eventDate", "verbatimEventDate")} AS date_text,
             ${col("dateIdentified", "ID Date")} AS identified_text
      FROM ${source} WITH ORDINALITY
      WHERE coalesce(${col("fieldNumber")}, ${col("genus")}, ${col("specificEpithet")}, ${col("identifiedBy")}) IS NOT NULL`);

    await conn.run(`CREATE OR REPLACE TEMP TABLE ds_taxon_alias AS
      SELECT trim(rank) AS rank, trim(alias) AS alias, trim(name) AS name
      FROM read_csv(${sqlString(opts.taxonAliases ?? DEFAULT_TAXON_ALIASES)}, header = true, all_varchar = true)`);
    await conn.run(`CREATE OR REPLACE TEMP TABLE ds_determiner_alias AS
      SELECT trim(alias) AS alias, trim(person) AS person
      FROM read_csv(${sqlString(opts.determinerAliases ?? DEFAULT_DETERMINER_ALIASES)}, header = true, all_varchar = true)`);

    // What each row asserts, and what confirms its number.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ds_parsed AS
      WITH r AS (
        SELECT *,
               CASE WHEN lower(epithet) IN ('sp', 'sp.', 'spp', 'spp.') THEN NULL ELSE epithet END AS species_epithet
        FROM ds_row
      ), g AS (
        SELECT r.*, coalesce(ga.name, r.genus) AS genus_name
        FROM r LEFT JOIN ds_taxon_alias ga ON ga.rank = 'genus' AND ga.alias = r.genus
      )
      SELECT g.*,
             concat_ws(' ', genus, epithet) AS verbatim,
             regexp_full_match(coalesce(genus, ''), '[A-Z][a-z]+')
               AND (species_epithet IS NULL OR regexp_full_match(species_epithet, '[a-z]+(-[a-z]+)?')) AS name_readable,
             CASE WHEN species_epithet IS NULL THEN 'genus' ELSE 'species' END AS rank,
             CASE WHEN species_epithet IS NULL THEN genus_name
                  ELSE coalesce(sa.name, concat(genus_name, ' ', species_epithet)) END AS name,
             CASE lower(sex_text) WHEN 'female' THEN 'female' WHEN 'male' THEN 'male' WHEN 'gynandromorph' THEN 'gynandromorph' END AS sex,
             ${DATE_SQL("date_text")} AS event_date,
             CASE WHEN regexp_full_match(identified_text, '\\d{4}') THEN make_date(CAST(identified_text AS INTEGER), 1, 1)
                  ELSE ${DATE_SQL("identified_text")} END AS identified_on,
             CASE WHEN regexp_full_match(identified_text, '\\d{4}') THEN 'year' END AS identified_precision,
             -- The last day the date can mean: a year's is its 31 December.
             CASE WHEN regexp_full_match(identified_text, '\\d{4}') THEN make_date(CAST(identified_text AS INTEGER), 12, 31)
                  ELSE ${DATE_SQL("identified_text")} END AS identified_by_end,
             (SELECT count(*) FROM ds_row x WHERE x.field_number = g.field_number) AS times_in_sheet
      FROM g
      LEFT JOIN ds_taxon_alias sa ON sa.rank = 'species' AND sa.alias = concat(g.genus, ' ', g.species_epithet)`);

    // The specimen each number names, when exactly one does, and what its sample says.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ds_matched AS
      SELECT p.*,
             (SELECT count(*) FROM specimen s WHERE s.field_number = p.field_number) AS specimens,
             (SELECT min(s.entity_id) FROM specimen s WHERE s.field_number = p.field_number) AS specimen_id
      FROM ds_parsed p`);
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ds_sample AS
      SELECT m.row_number, sa.entity_id AS sample_id, sa.date_start, sa.date_end,
             sa.entity_id IN (SELECT sample_id FROM settled_sample) AS settled,
             EXISTS (SELECT 1 FROM sample_collector sc JOIN person pe ON pe.entity_id = sc.person_id
                     WHERE sc.sample_id = sa.entity_id
                       AND (${FOLD("pe.family_name")} = ${FOLD("m.collector")} OR ${FOLD("pe.display_name")} = ${FOLD("m.collector")})) AS collector_matches
      FROM ds_matched m JOIN specimen sp ON sp.entity_id = m.specimen_id JOIN sample sa ON sa.entity_id = sp.sample_id
      WHERE m.specimens = 1`);

    // Holding, in order: the first reason a row cannot be placed is its reason.
    // The name comes after the number, since adopting a name for a row that
    // would be held anyway would change the tree for nothing.
    const holdBeforeName = `
      CASE
        WHEN m.field_number IS NULL THEN 'no_number'
        WHEN m.times_in_sheet > 1 THEN 'repeated_number'
        WHEN m.specimens = 0 THEN 'no_specimen'
        WHEN m.specimens > 1 THEN 'ambiguous_number'
        WHEN m.collector IS NOT NULL AND NOT s.collector_matches THEN 'collector_disagrees'
        WHEN m.date_text IS NOT NULL AND m.event_date IS NULL THEN 'date_unreadable'
        WHEN m.event_date IS NOT NULL AND NOT (m.event_date BETWEEN s.date_start AND s.date_end) THEN 'date_disagrees'
        WHEN m.identified_text IS NOT NULL AND m.identified_on IS NULL THEN 'identified_unreadable'
        WHEN m.identified_on > DATE ${sqlString(today)} OR m.identified_by_end < s.date_start THEN 'identified_disagrees'
        WHEN NOT m.name_readable THEN 'name_unreadable'
        WHEN m.sex_text IS NOT NULL AND m.sex IS NULL THEN 'sex_unreadable'
        WHEN m.identified_by IS NOT NULL AND m.identified_by NOT IN (SELECT alias FROM ds_determiner_alias) THEN 'determiner_unknown'
      END`;
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ds_outcome AS
      SELECT m.*, s.settled, ${holdBeforeName} AS outcome, CAST(NULL AS INTEGER) AS animal_id, CAST(NULL AS VARCHAR) AS detail
      FROM ds_matched m LEFT JOIN ds_sample s USING (row_number)`);

    const unplaced = (
      await all(
        conn,
        `SELECT DISTINCT o.name FROM ds_outcome o
         WHERE o.outcome IS NULL AND NOT EXISTS (SELECT 1 FROM animal a WHERE a.rank = o.rank AND a.scientific_name = o.name)`,
      )
    ).map((r) => String(r[0]));
    const adopted = await adoptEcdysisNames(conn, unplaced);

    await conn.run(`
      UPDATE ds_outcome o SET animal_id = (SELECT min(a.entity_id) FROM animal a WHERE a.rank = o.rank AND a.scientific_name = o.name)
      WHERE o.outcome IS NULL`);
    await conn.run(`UPDATE ds_outcome SET outcome = 'name_unknown', detail = name WHERE outcome IS NULL AND animal_id IS NULL`);
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ds_family AS
      WITH RECURSIVE up(node_id, anc_id) AS (
        SELECT DISTINCT animal_id, animal_id FROM ds_outcome WHERE animal_id IS NOT NULL
        UNION ALL
        SELECT up.node_id, a.parent_id FROM up JOIN animal a ON a.entity_id = up.anc_id WHERE a.parent_id IS NOT NULL
      )
      SELECT up.node_id, a.scientific_name AS family FROM up JOIN animal a ON a.entity_id = up.anc_id WHERE a.rank = 'family'`);
    await conn.run(`
      UPDATE ds_outcome o SET outcome = 'family_disagrees',
             detail = concat('filed under ', coalesce((SELECT f.family FROM ds_family f WHERE f.node_id = o.animal_id), 'no family'))
      WHERE o.outcome IS NULL AND o.family IS NOT NULL
        AND o.family IS DISTINCT FROM (SELECT f.family FROM ds_family f WHERE f.node_id = o.animal_id)`);

    // The determiners the rows to record name, created where the alias file
    // names a person the store does not hold — as legacy promotion does.
    const toCreate = (
      await all(
        conn,
        `SELECT DISTINCT a.person FROM ds_outcome o JOIN ds_determiner_alias a ON a.alias = o.identified_by
         WHERE o.outcome IS NULL AND NOT EXISTS (SELECT 1 FROM person p WHERE p.display_name = a.person)
         ORDER BY 1`,
      )
    ).map((r) => String(r[0]));
    for (const name of toCreate) {
      const parts = name.split(" ");
      const [given, family] = parts.length === 2 ? parts : [null, null];
      await conn.run(`INSERT INTO person (display_name, given_name, family_name) VALUES ($1, $2, $3)`, [name, given, family] as never);
    }
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ds_candidate AS
      SELECT o.*, (SELECT min(p.entity_id) FROM ds_determiner_alias a JOIN person p ON p.display_name = a.person
                   WHERE a.alias = o.identified_by) AS determiner_id
      FROM ds_outcome o`);

    // Recorded before, from this file; or already what the specimen says.
    await conn.run(`
      UPDATE ds_candidate c SET outcome = 'already_loaded'
      WHERE c.outcome IS NULL AND EXISTS (
        SELECT 1 FROM worksheet_determination w JOIN determination d ON d.entity_id = w.determination_id
        WHERE w.file_id = ${sqlString(received.id)} AND w.sheet = ${sqlString(sheet)} AND w.row_number = c.row_number
          AND d.specimen_id = c.specimen_id)`);
    await conn.run(`
      UPDATE ds_candidate c SET outcome = 'already_recorded'
      WHERE c.outcome IS NULL AND EXISTS (
        SELECT 1 FROM determination_of_record d
        WHERE d.specimen_id = c.specimen_id AND d.is_expert AND d.animal_id = c.animal_id AND d.qualifier IS NULL
          AND (c.sex IS NULL OR d.sex IS NOT DISTINCT FROM c.sex)
          AND (d.determiner_id IS NOT DISTINCT FROM c.determiner_id))`);
    await conn.run(`UPDATE ds_candidate SET outcome = 'recorded' WHERE outcome IS NULL`);

    const supersededExpert = (
      await all(
        conn,
        `SELECT c.field_number, wa.scientific_name, d.determiner_name, c.verbatim, c.identified_by
         FROM ds_candidate c
         JOIN determination_of_record d ON d.specimen_id = c.specimen_id AND d.is_expert
         JOIN animal wa ON wa.entity_id = d.animal_id
         WHERE c.outcome = 'recorded' ORDER BY c.row_number`,
      )
    ).map(([fieldNumber, was, wasBy, nowName, nowBy]) => ({
      fieldNumber: String(fieldNumber),
      was: String(was),
      wasBy: wasBy === null ? null : String(wasBy),
      now: String(nowName),
      nowBy: nowBy === null ? null : String(nowBy),
    }));

    // Each determination gets its id here, so its provenance row can name it.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ds_insert AS
      SELECT nextval('entity_id_seq') AS determination_id, c.*
      FROM (SELECT * FROM ds_candidate WHERE outcome = 'recorded' ORDER BY row_number) c`);
    await conn.run(
      `INSERT INTO determination (entity_id, specimen_id, animal_id, verbatim_identification, sex, determiner_id, determiner_name,
                                  is_expert, channel, determined_on, determined_on_precision, recorded_at)
       SELECT determination_id, specimen_id, animal_id, verbatim, sex, determiner_id, identified_by,
              true, 'worksheet_import', identified_on, identified_precision, $1::TIMESTAMPTZ
       FROM ds_insert`,
      [now.toISOString()] as never,
    );
    await conn.run(
      `INSERT INTO worksheet_determination (determination_id, file_id, file_name, file_modified_at, sheet, row_number, loaded_at)
       SELECT determination_id, $1, $2, $3::TIMESTAMPTZ, $4, row_number, $5::TIMESTAMPTZ FROM ds_insert`,
      [received.id, received.name, received.modifiedTime, sheet, now.toISOString()] as never,
    );

    // A row skipped because its determination stands: that determination,
    // and the date it has, to be given the sheet's where it has none.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ds_dated AS
      SELECT c.row_number, c.field_number, c.identified_on, c.identified_precision, c.identified_text,
             d.entity_id AS determination_id, d.determined_on AS stands_on, d.determined_on_precision AS stands_precision
      FROM ds_candidate c
      LEFT JOIN determination_of_record r ON c.outcome = 'already_recorded' AND r.specimen_id = c.specimen_id
      LEFT JOIN (
        SELECT w.row_number, wd.specimen_id, min(w.determination_id) AS determination_id
        FROM worksheet_determination w JOIN determination wd ON wd.entity_id = w.determination_id
        WHERE w.file_id = ${sqlString(received.id)} AND w.sheet = ${sqlString(sheet)}
        GROUP BY ALL
      ) l ON c.outcome = 'already_loaded' AND l.row_number = c.row_number AND l.specimen_id = c.specimen_id
      JOIN determination d ON d.entity_id = coalesce(r.entity_id, l.determination_id)
      WHERE c.identified_on IS NOT NULL`);
    const dated = await one(conn, "SELECT count(*) FROM ds_dated WHERE stands_on IS NULL");
    const dateKept = (
      await all(
        conn,
        `SELECT field_number,
                CASE WHEN stands_precision = 'year' THEN CAST(year(stands_on) AS VARCHAR) ELSE CAST(stands_on AS VARCHAR) END,
                identified_text
         FROM ds_dated
         WHERE stands_on IS NOT NULL
           AND (stands_on, stands_precision) IS DISTINCT FROM (identified_on, identified_precision)
         ORDER BY row_number`,
      )
    ).map(([fieldNumber, stands, sheetSays]) => ({ fieldNumber: String(fieldNumber), stands: String(stands), sheet: String(sheetSays) }));
    await conn.run(`
      UPDATE determination SET determined_on = x.identified_on, determined_on_precision = x.identified_precision
      FROM ds_dated x
      WHERE determination.entity_id = x.determination_id AND determination.determined_on IS NULL`);

    const held = Object.fromEntries(HELD_REASONS.map((r) => [r, 0])) as Record<HeldReason, number>;
    for (const [reason, n] of await all(conn, `SELECT outcome, count(*) FROM ds_candidate GROUP BY outcome`)) {
      if ((HELD_REASONS as readonly string[]).includes(String(reason))) held[reason as HeldReason] = Number(n);
    }
    const isHeld = `outcome IN (${HELD_REASONS.map(sqlString).join(", ")})`;
    const heldRows = await all(
      conn,
      `SELECT row_number, field_number, outcome, family, genus, epithet, sex_text, identified_by,
              coalesce(detail, CASE outcome
                WHEN 'collector_disagrees' THEN concat('the sheet says ', collector)
                WHEN 'date_disagrees' THEN concat('the sheet says ', CAST(event_date AS VARCHAR))
                WHEN 'date_unreadable' THEN date_text
                WHEN 'identified_unreadable' THEN identified_text
                WHEN 'identified_disagrees' THEN concat('determined ', identified_text,
                  CASE WHEN identified_on > DATE ${sqlString(today)} THEN ', after today'
                       ELSE concat(', before the sample was collected on ', CAST((SELECT s.date_start FROM ds_sample s WHERE s.row_number = ds_candidate.row_number) AS VARCHAR)) END) END)
       FROM ds_candidate WHERE ${isHeld} ORDER BY row_number`,
    );
    const byDeterminer = (
      await all(
        conn,
        `SELECT c.identified_by, p.display_name, count(*), count(*) FILTER (WHERE outcome = 'recorded'), count(*) FILTER (WHERE ${isHeld})
         FROM ds_candidate c LEFT JOIN person p ON p.entity_id = c.determiner_id
         GROUP BY ALL ORDER BY 3 DESC, 1`,
      )
    ).map(([identifiedBy, person, n, rec, h]) => ({
      identifiedBy: identifiedBy === null ? null : String(identifiedBy),
      person: person === null ? null : String(person),
      rows: Number(n),
      recorded: Number(rec),
      held: Number(h),
    }));

    const result: DeterminationSheetResult = {
      file: received.name,
      driveId: received.id,
      sheet,
      rows: await one(conn, "SELECT count(*) FROM ds_candidate"),
      recorded: await one(conn, "SELECT count(*) FROM ds_candidate WHERE outcome = 'recorded'"),
      supersededExpert,
      alreadyRecorded: await one(conn, "SELECT count(*) FROM ds_candidate WHERE outcome = 'already_recorded'"),
      alreadyLoaded: await one(conn, "SELECT count(*) FROM ds_candidate WHERE outcome = 'already_loaded'"),
      dated,
      dateKept,
      held,
      heldBySeason: {
        active: await one(conn, `SELECT count(*) FROM ds_candidate WHERE ${isHeld} AND settled = false`),
        settled: await one(conn, `SELECT count(*) FROM ds_candidate WHERE ${isHeld} AND settled = true`),
        noSpecimen: await one(conn, `SELECT count(*) FROM ds_candidate WHERE ${isHeld} AND settled IS NULL`),
      },
      adopted,
      createdPeople: toCreate,
      byDeterminer,
      heldPath,
    };
    await conn.run(opts.dryRun ? "ROLLBACK" : "COMMIT");
    const heldCsv = [
      HELD_COLUMNS.join(","),
      ...heldRows.map((r) => [Number(r[0]), ...r.slice(1)].map(csvCell).join(",")),
    ].join("\n");
    await writeFile(heldPath, `${heldCsv}\n`);
    return result;
  } catch (err) {
    await conn.run("ROLLBACK").catch(() => {});
    throw err;
  }
}

// CLI: pnpm determinations:load <received-dir> [db] [--sheet <name>] [--held <path>] [--dry-run]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const valued = ["--sheet", "--held"];
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1] ?? ""));
  const dir = positional[0];
  if (dir === undefined) {
    console.error("usage: pnpm determinations:load <received-dir> [db] [--sheet <name>] [--held <path>] [--dry-run]");
    process.exit(2);
  }
  const { openDuckDb } = await import("./db.js");
  const instance = await openDuckDb(positional[1] ?? process.env.BEELINE_DB ?? DEFAULT_DB);
  const conn = await instance.connect();
  try {
    const result = await loadDeterminationSheet(conn, {
      dir,
      sheet: option("--sheet"),
      heldPath: option("--held"),
      dryRun: args.includes("--dry-run"),
    });
    await conn.run("CHECKPOINT");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    conn.closeSync();
  }
}
