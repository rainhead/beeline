import type { DuckDBConnection } from "@duckdb/node-api";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_DB } from "./person-change.js";

/**
 * Determinations from Ecdysis, the Symbiota deployment Washington's museum
 * (WSUC) keeps its bee records in and that other atlases use too
 * (beeline-9ut; CONTEXT.md, Ecosystem). This is the `ecdysis_import`
 * channel: expert determinations made in Ecdysis, brought back as events.
 *
 * Two shapes of input, one row model. A Symbiota Darwin Core archive, once
 * unpacked, holds `occurrences.*` and `identifications.*`: every
 * identification an occurrence has ever had, each with the moment it was
 * entered and exactly one of them flagged current — the whole history, which
 * is what an append-only determination log wants. A flat occurrence export,
 * which is what staff have downloaded until now, carries only the current
 * identification, with no id of its own; it is read as one current
 * identification per occurrence and keyed by the occurrence and its fields.
 *
 * The join is the museum's catalog number: `WSDA_2303966` is Beeline's field
 * number `2303966` under the collection's prefix. Occurrences that match no
 * specimen are counted and sampled, never invented. Names resolve against the
 * curated taxonomy by spelling; one that does not is a curation task
 * (beeline-45v.1) and is reported, never minted here. Determiners resolve
 * through the same alias file legacy promotion uses; the verbatim name is
 * kept beside whichever person it reached.
 *
 * Ordering is the point (Peter, 2026-09-26). `dateIdentified` is "s.d." on
 * two thirds of Ecdysis's identifications and a bare year on the rest, so it
 * orders nothing. Two moments do. The identification Ecdysis calls current
 * is recorded when it crosses into Beeline, like any event, so it supersedes
 * whatever stood before — the legacy import's copy of the same assertion
 * included, which is how a record gains the year Ecdysis holds for it — and
 * a later export's revision supersedes it in turn. A superseded
 * identification is recorded at the moment Ecdysis entered it, which
 * Symbiota exports as `modified`: it is history, and it lands in the past
 * where it belongs, before whatever is current, whichever export brought
 * it. A microsecond per row keeps a specimen's rows in order within one
 * load. So determination_of_record (schema/110), which orders by
 * recorded_at, lands on the current one, and a flat export loaded in
 * February and the archive's history loaded in July agree. Loading is
 * idempotent twice over: each identification's Symbiota recordID is
 * remembered, and a row that merely restates the specimen's current Ecdysis
 * record — the same node, qualifier and determiner — is not recorded again,
 * which is how a flat export and an archive of one collection can both be
 * loaded without doubling anything. The one thing this cannot survive is an
 * older export loaded after a newer one, whose since-revised "current" rows
 * would supersede the revisions; the loader refuses that unless forced.
 */

export interface LoadEcdysisOptions {
  /** An unpacked Darwin Core archive (a directory), or one flat occurrence export CSV. */
  path: string;
  /** What precedes the field number in catalogNumber — 'WSDA_' for Washington. */
  catalogPrefix: string;
  /** The determiner alias file; legacy promotion's by default. */
  determinerAliases?: string;
  /** For tests: the moment the load is recorded as. */
  now?: Date;
  /** Load an export older than one already loaded anyway. */
  force?: boolean;
}

export interface LoadEcdysisResult {
  input: "archive" | "flat";
  occurrences: number;
  /** Occurrences whose catalog number names a specimen in the store. */
  matched: number;
  unmatched: number;
  unmatchedSample: string[];
  identifications: number;
  /** Rows that assert nothing: no name, or Symbiota's 'undetermined' placeholder. */
  placeholders: number;
  alreadyLoaded: number;
  /** Rows whose name no node carries, or two do; each is a curation task. */
  unresolvedNames: Array<{ name: string; rows: number }>;
  loaded: number;
  /** The determiners seen, and whether each reached a person. */
  determiners: Array<{ name: string; rows: number; resolved: boolean }>;
}

export const DEFAULT_DETERMINER_ALIASES = new URL("../ingest/determiner-aliases.csv", import.meta.url).pathname;

const rows = async (conn: DuckDBConnection, sql: string, params: unknown[] = []) =>
  (await (await conn.run(sql, params as never)).getRows()) as unknown[][];
const scalar = async (conn: DuckDBConnection, sql: string, params: unknown[] = []) =>
  Number((await rows(conn, sql, params))[0]?.[0] ?? 0);

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** The archive's two files, or the one flat CSV. */
function locate(path: string): { input: "archive"; occurrences: string; identifications: string } | { input: "flat"; occurrences: string } {
  if (statSync(path).isDirectory()) {
    const names = readdirSync(path);
    const find = (stem: string) => names.find((n) => /^(occurrences|identifications)\.(tab|csv|txt)$/i.test(n) && n.toLowerCase().startsWith(stem));
    const occurrences = find("occurrences");
    const identifications = find("identifications");
    if (occurrences === undefined) throw new Error(`${path}: no occurrences.{tab,csv,txt} — not an unpacked Darwin Core archive`);
    if (identifications === undefined) {
      throw new Error(`${path}: no identifications.{tab,csv,txt} — the archive was downloaded without its identification history`);
    }
    return { input: "archive", occurrences: join(path, occurrences), identifications: join(path, identifications) };
  }
  return { input: "flat", occurrences: path };
}

export async function loadEcdysis(conn: DuckDBConnection, opts: LoadEcdysisOptions): Promise<LoadEcdysisResult> {
  const files = locate(opts.path);
  const aliases = opts.determinerAliases ?? DEFAULT_DETERMINER_ALIASES;
  const now = opts.now ?? new Date();
  const prefix = opts.catalogPrefix;

  await conn.run("BEGIN TRANSACTION");
  try {
    // Everything as text: Symbiota's exports mix formats within a column
    // (a year, "s.d." and "female" in dateIdentified), and type sniffing
    // would fail the file on the first surprise.
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ecd_occurrence AS
       SELECT "id" AS occ_id, trim("catalogNumber") AS catalog_number, "recordID" AS occurrence_record_id
       FROM read_csv(${sqlString(files.occurrences)}, header = true, all_varchar = true)`,
    );
    if (files.input === "archive") {
      await conn.run(
        `CREATE OR REPLACE TEMP TABLE ecd_identification AS
         SELECT "coreid" AS occ_id, "recordID" AS record_id,
                trim("identifiedBy") AS identified_by, trim("dateIdentified") AS date_identified,
                trim("identificationQualifier") AS qualifier_text, trim("scientificName") AS scientific_name,
                "identificationIsCurrent" = '1' AS is_current,
                trim("identificationRemarks") AS remarks, "modified" AS entered_text
         FROM read_csv(${sqlString(files.identifications)}, header = true, all_varchar = true)`,
      );
    } else {
      // One current identification per occurrence, keyed by the occurrence
      // and the fields that make it: a later export whose current
      // identification differs derives a different key and so is new.
      await conn.run(
        `CREATE OR REPLACE TEMP TABLE ecd_identification AS
         SELECT "id" AS occ_id,
                concat('occ:', "recordID", ':', md5(concat_ws('|', trim("scientificName"), trim("identifiedBy"), trim("dateIdentified"), trim("identificationQualifier")))) AS record_id,
                trim("identifiedBy") AS identified_by, trim("dateIdentified") AS date_identified,
                trim("identificationQualifier") AS qualifier_text, trim("scientificName") AS scientific_name,
                true AS is_current, trim("identificationRemarks") AS remarks, "modified" AS entered_text
         FROM read_csv(${sqlString(files.occurrences)}, header = true, all_varchar = true)`,
      );
    }
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ecd_alias AS
       SELECT trim(alias) AS alias, trim(person) AS person FROM read_csv(${sqlString(aliases)}, header = true, all_varchar = true)`,
    );

    // The occurrence → specimen join, and what it leaves out.
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ecd_match AS
       SELECT o.occ_id, o.occurrence_record_id, o.catalog_number, sp.entity_id AS specimen_id
       FROM ecd_occurrence o
       LEFT JOIN specimen sp
         ON starts_with(o.catalog_number, $1)
        AND sp.field_number = substr(o.catalog_number, length($1) + 1)`,
      [prefix],
    );
    const occurrences = await scalar(conn, `SELECT count(*) FROM ecd_match`);
    const matched = await scalar(conn, `SELECT count(*) FROM ecd_match WHERE specimen_id IS NOT NULL`);
    const unmatchedSample = (
      await rows(conn, `SELECT catalog_number FROM ecd_match WHERE specimen_id IS NULL ORDER BY catalog_number LIMIT 5`)
    ).map((r) => String(r[0]));

    // Each identification, resolved as far as it goes. Placeholders — no
    // name, or Symbiota's 'undetermined' — assert nothing and are not
    // determinations. A qualifier is kept only where it is one of the three
    // the store admits AND names the epithet of the name beside it; anything
    // else it said ('zonalis group', '?') goes to the notes with the remarks,
    // since it is what the determiner wrote and nowhere else would keep it.
    // 'af.' is a spelling of 'aff.' seen 55 times in one export.
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ecd_candidate AS
       WITH ident AS (
         SELECT i.*, m.specimen_id, m.occurrence_record_id,
                lower(i.scientific_name) IN ('', 'undetermined', 'unidentified') AS placeholder,
                nullif(lower(i.identified_by), 'unknown') AS by_text,
                regexp_extract(i.qualifier_text, '^(cf|aff|af|nr)\\.?\\s+(\\S+)$', 1) AS q_word,
                regexp_extract(i.qualifier_text, '^(cf|aff|af|nr)\\.?\\s+(\\S+)$', 2) AS q_epithet,
                regexp_extract(i.scientific_name, '(\\S+)$', 1) AS last_word
         FROM ecd_identification i
         JOIN ecd_match m ON m.occ_id = i.occ_id
         WHERE m.specimen_id IS NOT NULL
       ),
       named AS (
         SELECT ident.*,
                (SELECT count(*) FROM animal a WHERE a.scientific_name = ident.scientific_name) AS nodes,
                (SELECT min(a.entity_id) FROM animal a WHERE a.scientific_name = ident.scientific_name) AS animal_id,
                CASE WHEN q_word <> '' AND lower(q_epithet) = lower(last_word)
                     THEN CASE q_word WHEN 'cf' THEN 'cf.' WHEN 'nr' THEN 'nr.' ELSE 'aff.' END END AS qualifier,
                CASE WHEN regexp_matches(date_identified, '^\\d{4}$') THEN CAST(concat(date_identified, '-01-01') AS DATE)
                     WHEN regexp_matches(date_identified, '^\\d{4}-\\d{2}$') THEN CAST(concat(date_identified, '-01') AS DATE)
                     WHEN regexp_matches(date_identified, '^\\d{4}-\\d{2}-\\d{2}$') THEN try_cast(date_identified AS DATE) END AS determined_on,
                CASE WHEN regexp_matches(date_identified, '^\\d{4}$') THEN 'year'
                     WHEN regexp_matches(date_identified, '^\\d{4}-\\d{2}$') THEN 'month' END AS precision,
                coalesce(try_strptime(entered_text, '%Y-%m-%d %H:%M:%S'), try_strptime(entered_text, '%m/%d/%Y %H:%M'),
                         try_strptime(entered_text, '%Y-%m-%d')) AS entered_at,
                (SELECT min(p.entity_id) FROM ecd_alias al JOIN person p ON p.display_name = al.person
                  WHERE al.alias = ident.identified_by) AS determiner_id
         FROM ident
       )
       SELECT *,
              EXISTS (SELECT 1 FROM ecdysis_identification e WHERE e.record_id = named.record_id) AS already,
              -- A flat export and an archive key the same identification
              -- differently, so a row is also "already" when the specimen's
              -- determination of record is this very assertion, from
              -- Ecdysis: same node, same qualifier, same determiner.
              EXISTS (SELECT 1 FROM determination_of_record r
                      WHERE r.specimen_id = named.specimen_id AND r.channel = 'ecdysis_import'
                        AND r.animal_id = named.animal_id
                        AND r.qualifier IS NOT DISTINCT FROM named.qualifier
                        AND r.determiner_name IS NOT DISTINCT FROM CASE WHEN named.by_text IS NULL OR named.by_text = '' THEN NULL ELSE named.identified_by END) AS restated,
              nullif(concat_ws('; ',
                CASE WHEN qualifier IS NULL AND qualifier_text <> '' THEN qualifier_text END,
                nullif(remarks, '')), '') AS notes
       FROM named`,
    );
    // Exports must arrive in the order they were taken: an older one loaded
    // after a newer would record its since-revised identifications as new
    // events with a later recorded_at, and they would supersede the
    // revisions. The export's newest entry timestamp against the newest
    // already recorded from Ecdysis is the check; --force is the override,
    // for a first load of history behind a flat export somebody loaded first.
    const [[newestInExport, newestLoaded]] = (await rows(
      conn,
      // To the minute: a flat export stamps entries to the minute and the
      // archive to the second, and the same moment must not read as older.
      `SELECT date_trunc('minute', max(entered_at)),
              (SELECT date_trunc('minute', max(entered_at)) FROM ecdysis_identification) FROM ecd_candidate`,
    )) as [[Date | null, Date | null]];
    if (!opts.force && newestInExport !== null && newestLoaded !== null && newestInExport < newestLoaded) {
      throw new Error(
        `${opts.path}: this export's newest identification was entered ${String(newestInExport)}, ` +
          `before the newest already loaded (${String(newestLoaded)}); load exports in the order they were taken, or pass force`,
      );
    }
    const identifications = await scalar(conn, `SELECT count(*) FROM ecd_candidate`);
    const placeholders = await scalar(conn, `SELECT count(*) FROM ecd_candidate WHERE placeholder`);
    const alreadyLoaded = await scalar(
      conn,
      `SELECT count(*) FROM ecd_candidate WHERE NOT placeholder AND (already OR restated)`,
    );
    const unresolvedNames = (
      await rows(
        conn,
        `SELECT scientific_name, count(*) FROM ecd_candidate
         WHERE NOT placeholder AND NOT already AND NOT restated AND nodes <> 1 GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 40`,
      )
    ).map((r) => ({ name: String(r[0]), rows: Number(r[1]) }));
    const determiners = (
      await rows(
        conn,
        `SELECT identified_by, count(*), bool_or(determiner_id IS NOT NULL) FROM ecd_candidate
         WHERE NOT placeholder AND by_text IS NOT NULL AND by_text <> '' GROUP BY 1 ORDER BY 2 DESC, 1`,
      )
    ).map((r) => ({ name: String(r[0]), rows: Number(r[1]), resolved: Boolean(r[2]) }));

    // The current identification is recorded now; a superseded one at the
    // moment Ecdysis entered it, or a second before now where that did not
    // parse, so it can never be the record. A microsecond per row keeps a
    // specimen's rows in order within one load.
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ecd_insert AS
       SELECT c.*,
              CASE WHEN c.is_current THEN $1::TIMESTAMPTZ
                   ELSE coalesce(c.entered_at::TIMESTAMPTZ, $1::TIMESTAMPTZ - INTERVAL 1 SECOND) END
                + INTERVAL (row_number() OVER (ORDER BY c.specimen_id, c.is_current, c.entered_at NULLS FIRST, c.record_id)) MICROSECOND AS recorded_at
       FROM ecd_candidate c
       WHERE NOT c.placeholder AND NOT c.already AND NOT c.restated AND c.nodes = 1`,
      [now.toISOString()],
    );
    await conn.run(
      `INSERT INTO determination (specimen_id, animal_id, qualifier, verbatim_identification, sex, caste,
                                  determiner_id, determiner_name, is_expert, channel, determined_on, determined_on_precision,
                                  recorded_at, notes)
       SELECT specimen_id, animal_id, qualifier, scientific_name, NULL, NULL,
              determiner_id, CASE WHEN by_text IS NULL OR by_text = '' THEN NULL ELSE identified_by END,
              true, 'ecdysis_import', determined_on, precision, recorded_at, notes
       FROM ecd_insert`,
    );
    await conn.run(
      `INSERT INTO ecdysis_identification (record_id, determination_id, occurrence_id, entered_at, loaded_at)
       SELECT i.record_id, d.entity_id, i.occurrence_record_id, i.entered_at, $1::TIMESTAMPTZ
       FROM ecd_insert i
       JOIN determination d ON d.specimen_id = i.specimen_id AND d.recorded_at = i.recorded_at AND d.channel = 'ecdysis_import'`,
      [now.toISOString()],
    );
    const loaded = await scalar(conn, `SELECT count(*) FROM ecd_insert`);
    await conn.run("COMMIT");
    return {
      input: files.input,
      occurrences,
      matched,
      unmatched: occurrences - matched,
      unmatchedSample,
      identifications,
      placeholders,
      alreadyLoaded,
      unresolvedNames,
      loaded,
      determiners,
    };
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}

// CLI: pnpm ecdysis:load <archive-dir-or-export.csv> [db] [--prefix WSDA_] [--force]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const prefixAt = args.indexOf("--prefix");
  const catalogPrefix = prefixAt >= 0 ? (args[prefixAt + 1] ?? "") : "WSDA_";
  const force = args.includes("--force");
  const positional = args.filter((a, i) => a !== "--prefix" && a !== "--force" && i !== prefixAt + 1);
  const path = positional[0];
  if (path === undefined) {
    console.error("usage: pnpm ecdysis:load <archive-dir-or-export.csv> [db] [--prefix WSDA_]");
    process.exit(2);
  }
  const { openDuckDb } = await import("./db.js");
  const instance = await openDuckDb(positional[1] ?? process.env.BEELINE_DB ?? DEFAULT_DB);
  const conn = await instance.connect();
  const result = await loadEcdysis(conn, { path, catalogPrefix, force });
  await conn.run("CHECKPOINT");
  conn.closeSync();
  console.log(JSON.stringify(result, null, 2));
}
