import type { DuckDBConnection } from "@duckdb/node-api";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { adoptEcdysisNames, type AdoptedName } from "./adopt-ecdysis.js";
import { BEE_FAMILIES } from "./bee-families.js";
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
 * entered and, usually, one of them flagged current — the whole history,
 * which is what an append-only determination log wants. Where none is
 * flagged, the occurrence's own determination is the current one, read as a
 * flat export's is. A flat occurrence export,
 * which is what staff have downloaded until now, carries only the current
 * identification, with no id of its own; it is read as one current
 * identification per occurrence and keyed by the occurrence and its fields.
 *
 * The join is the museum's catalog number: `WSDA_2303966` is Beeline's field
 * number `2303966` under the collection's prefix. Occurrences that match no
 * specimen are counted and sampled, never invented. Names resolve against the
 * curated taxonomy by spelling, after taking in any Ecdysis accepts. A name the
 * tree still lacks is a curation task (beeline-45v.1), never minted here,
 * and what happens to its record meanwhile depends on what it is. Bycatch
 * is recorded under the nearest name the tree does hold — the genus it
 * names, else the family, order or class its occurrence names — with what
 * Ecdysis wrote kept as the verbatim identification, because a question
 * about a wasp must not hold a record back (Peter, 2026-10-18, beeline-wqht).
 * A bee's record, or one whose name two nodes carry, waits and is reported:
 * there the exact name is the point of the determination. Determiners resolve
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
 * remembered, and an identification the store already holds under another
 * key — the same node, qualifier and determiner on the same specimen,
 * recorded from a flat export that could not know the recordID — is
 * ADOPTED, its recordID linked to the event that already exists, rather
 * than recorded again or skipped. Skipping was the first version, and it
 * skipped a superseded row for matching what happened to be current, so the
 * next load recorded it. The one thing none of this survives is an older
 * export loaded after a newer one, whose since-revised "current" rows would
 * supersede the revisions; the loader refuses that unless forced.
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
  /** Specimens whose catalog number this load recorded for the first time, or changed. */
  catalogNumbers: number;
  /** Occurrences whose field number two specimens carry, so neither was given the museum's number. */
  ambiguousCatalogNumbers: number;
  /**
   * Identifications held back because their occurrence's field number is on
   * two specimens and no catalog number recorded says which is the museum's
   * (beeline-n1sz): one expert's identification is not recorded on both.
   */
  ambiguousIdentifications: number;
  unmatched: number;
  unmatchedSample: string[];
  identifications: number;
  /** Rows that assert nothing: no name, or Symbiota's 'undetermined' placeholder. */
  placeholders: number;
  /** Rows already recorded: by recordID, or adopted as an event recorded under another key. */
  alreadyLoaded: number;
  /** Names the tree lacked and Ecdysis's thesaurus accepts, adopted into the tree with any ancestors it also lacked. */
  adopted: AdoptedName[];
  /** Rows held back: a bee name no node carries, or a name two do, and the thesaurus could not supply; each is a curation task. */
  unresolvedNames: Array<{ name: string; rows: number }>;
  /** Bycatch rows recorded under a broader name the tree holds, since their own is not there yet; each is a curation task too. */
  filedUnder: Array<{ name: string; under: string; rows: number }>;
  loaded: number;
  /** The determiners seen, and whether each reached a person. */
  determiners: Array<{ name: string; rows: number; resolved: boolean }>;
}

export const DEFAULT_DETERMINER_ALIASES = new URL("../ingest/determiner-aliases.csv", import.meta.url).pathname;

const rows = async (conn: DuckDBConnection, sql: string, params: unknown[] = []) =>
  (await (await conn.run(sql, params as never)).getRows()) as unknown[][];
const scalar = async (conn: DuckDBConnection, sql: string, params: unknown[] = []) =>
  Number((await rows(conn, sql, params))[0]?.[0] ?? 0);

/** How many names a load's reports list; a list this long may be longer still. */
export const REPORTED_NAMES = 40;

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * A column an export may not carry, as text, or NULL where it is absent: the
 * archive's occurrences hold the higher classification, and a flat export or
 * an older file need not.
 */
async function optionalColumn(conn: DuckDBConnection, file: string, column: string): Promise<string> {
  const names = new Set(
    (await rows(conn, `DESCRIBE SELECT * FROM read_csv(${sqlString(file)}, header = true, all_varchar = true)`)).map((r) => String(r[0])),
  );
  return names.has(column) ? `trim("${column}")` : "CAST(NULL AS VARCHAR)";
}

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
    const occurrenceColumn = (column: string) => optionalColumn(conn, files.occurrences, column);
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ecd_occurrence AS
       SELECT "id" AS occ_id, trim("catalogNumber") AS catalog_number, "recordID" AS occurrence_record_id,
              ${await occurrenceColumn("family")} AS family, ${await occurrenceColumn("order")} AS order_name,
              ${await occurrenceColumn("class")} AS class_name
       FROM read_csv(${sqlString(files.occurrences)}, header = true, all_varchar = true)`,
    );
    // An occurrence row read as its current identification, keyed by the
    // occurrence and the fields that make it: a later export whose current
    // identification differs derives a different key and so is new. It is
    // all a flat export has, and what an archive falls back on below.
    const occurrenceAsCurrent = `
         SELECT "id" AS occ_id,
                concat('occ:', "recordID", ':', md5(concat_ws('|', trim("scientificName"), trim("identifiedBy"), trim("dateIdentified"), trim("identificationQualifier")))) AS record_id,
                trim("identifiedBy") AS identified_by, trim("dateIdentified") AS date_identified,
                trim("identificationQualifier") AS qualifier_text, trim("scientificName") AS scientific_name,
                true AS is_current, trim("identificationRemarks") AS remarks, "modified" AS entered_text,
                ${await occurrenceColumn("genus")} AS genus_text
         FROM read_csv(${sqlString(files.occurrences)}, header = true, all_varchar = true)`;
    if (files.input === "archive") {
      await conn.run(
        `CREATE OR REPLACE TEMP TABLE ecd_identification AS
         SELECT "coreid" AS occ_id, "recordID" AS record_id,
                trim("identifiedBy") AS identified_by, trim("dateIdentified") AS date_identified,
                trim("identificationQualifier") AS qualifier_text, trim("scientificName") AS scientific_name,
                "identificationIsCurrent" = '1' AS is_current,
                trim("identificationRemarks") AS remarks, "modified" AS entered_text,
                ${await optionalColumn(conn, files.identifications, "genus")} AS genus_text
         FROM read_csv(${sqlString(files.identifications)}, header = true, all_varchar = true)`,
      );
      // Symbiota keeps an occurrence's current determination on the
      // occurrence itself; the history's flag usually agrees, but not always.
      // 484 occurrences in Washington's 2026-09-24 archive flag nothing
      // current — typically a placeholder, then a name and a nameless row
      // entered together — while the occurrence names its determination, and
      // in a third of them the newest history row is not what it names. Read
      // from the flags alone, all of it was history and the legacy copy stayed
      // the record (beeline-9ut.6). There the occurrence row is the current
      // identification, keyed as a flat export would key it.
      await conn.run(
        `INSERT INTO ecd_identification
         SELECT * FROM (${occurrenceAsCurrent}) o
         WHERE NOT EXISTS (SELECT 1 FROM ecd_identification i WHERE i.occ_id = o.occ_id AND i.is_current)`,
      );
    } else {
      await conn.run(`CREATE OR REPLACE TEMP TABLE ecd_identification AS ${occurrenceAsCurrent}`);
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

    // The museum's number for each matched specimen, as Ecdysis writes it:
    // the catalog number is the museum's, so Beeline keeps what Ecdysis says
    // rather than deriving it from the field number (gh-98). An occurrence
    // already recorded is recognised by its Ecdysis id, so a number the
    // museum changes is followed even when it no longer spells the field
    // number; the field number is how an occurrence is first recognised. An
    // occurrence whose field number two specimens carry is a duplicate
    // (beeline-1kb.14) and gives neither of them a number, since at most one
    // of them is the museum's specimen, and the count says how many waited.
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ecd_catalog AS
       WITH known AS (
         SELECT c.specimen_id, o.catalog_number, o.occurrence_record_id
         FROM ecd_occurrence o JOIN specimen_catalog_number c ON c.occurrence_id = o.occurrence_record_id
         -- An occurrence that comes back with no number has not been renumbered;
         -- it keeps the one recorded.
         WHERE nullif(o.catalog_number, '') IS NOT NULL
       ),
       first_seen AS (
         SELECT m.specimen_id, m.catalog_number, m.occurrence_record_id
         FROM ecd_match m
         WHERE m.specimen_id IS NOT NULL
           AND m.occ_id IN (SELECT occ_id FROM ecd_match WHERE specimen_id IS NOT NULL GROUP BY occ_id HAVING count(*) = 1)
           AND NOT EXISTS (SELECT 1 FROM known k WHERE k.specimen_id = m.specimen_id
                                                   OR k.occurrence_record_id = m.occurrence_record_id)
       )
       SELECT * FROM known UNION ALL SELECT * FROM first_seen
       QUALIFY row_number() OVER (PARTITION BY specimen_id ORDER BY catalog_number) = 1`,
    );
    const ambiguousCatalogNumbers = await scalar(
      conn,
      `SELECT count(DISTINCT occ_id) FROM ecd_match WHERE specimen_id IS NOT NULL
       AND occ_id IN (SELECT occ_id FROM ecd_match WHERE specimen_id IS NOT NULL GROUP BY occ_id HAVING count(*) > 1)
       AND occurrence_record_id NOT IN (SELECT occurrence_record_id FROM ecd_catalog WHERE occurrence_record_id IS NOT NULL)`,
    );
    // Counted before writing, so the count is what changed rather than what was seen.
    const catalogNumbers = await scalar(
      conn,
      `SELECT count(*) FROM ecd_catalog e
       LEFT JOIN specimen_catalog_number c ON c.specimen_id = e.specimen_id
       WHERE c.catalog_number IS DISTINCT FROM e.catalog_number`,
    );
    await conn.run(
      `INSERT INTO specimen_catalog_number (specimen_id, catalog_number, occurrence_id, loaded_at)
       SELECT specimen_id, catalog_number, occurrence_record_id, $1::TIMESTAMPTZ FROM ecd_catalog
       ON CONFLICT (specimen_id) DO UPDATE SET catalog_number = excluded.catalog_number,
         occurrence_id = excluded.occurrence_id, loaded_at = excluded.loaded_at`,
      [now.toISOString()],
    );

    // The one specimen each matched occurrence's identifications are about:
    // the one its catalog number is recorded against, by an earlier load or
    // just above, else the only specimen carrying its field number. An
    // occurrence whose field number two specimens carry, with no catalog
    // number to say which is the museum's, gets none, and its
    // identifications wait as its catalog number does (beeline-n1sz). Joining
    // every match instead recorded one identification on both specimens,
    // which its Symbiota id refused, and rolled the whole load back.
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ecd_specimen AS
       SELECT m.occ_id,
              coalesce(any_value(c.specimen_id),
                       CASE WHEN count(DISTINCT m.specimen_id) = 1 THEN any_value(m.specimen_id) END) AS specimen_id
       FROM ecd_match m
       LEFT JOIN specimen_catalog_number c ON c.occurrence_id = m.occurrence_record_id
       WHERE m.specimen_id IS NOT NULL
       GROUP BY m.occ_id`,
    );
    const ambiguousIdentifications = await scalar(
      conn,
      `SELECT count(*) FROM ecd_identification i JOIN ecd_specimen s ON s.occ_id = i.occ_id WHERE s.specimen_id IS NULL`,
    );

    // A name the tree does not spell, but that Ecdysis's thesaurus accepts,
    // comes in from it before anything resolves (beeline-45v.1.1); what is left is
    // reported below as before, for a taxonomist.
    const unplaced = (
      await rows(
        conn,
        `SELECT DISTINCT i.scientific_name FROM ecd_identification i JOIN ecd_specimen m ON m.occ_id = i.occ_id
         WHERE m.specimen_id IS NOT NULL AND coalesce(i.scientific_name, '') <> ''
           AND NOT EXISTS (SELECT 1 FROM animal a WHERE a.scientific_name = i.scientific_name)`,
      )
    ).map((r) => String(r[0]));
    const adoptedNames = await adoptEcdysisNames(conn, unplaced);

    // Each identification, resolved as far as it goes. Placeholders — no
    // name, or Symbiota's 'undetermined' — assert nothing and are not
    // determinations. A qualifier is kept only where it is one of the three
    // the store admits AND names the epithet of the name beside it; anything
    // else it said ('zonalis group', '?') goes to the notes with the remarks,
    // since it is what the determiner wrote and nowhere else would keep it.
    // 'af.' is a spelling of 'aff.' seen 55 times in one export.
    //
    // A name no node spells falls back, for bycatch only, to the nearest name
    // the tree holds: the genus the identification names, else — for the
    // current identification alone — the family, order or class of its
    // occurrence, the first that exactly one node carries. The occurrence's
    // classification is its current identification's, so a superseded row
    // that names a genus the tree lacks says nothing the occurrence can be
    // trusted to classify, and waits. Falling back takes evidence that the
    // record is not a bee's: a non-bee family above the node reached, or, for
    // the current identification, on the occurrence — a family the tree or
    // Ecdysis's thesaurus knows, so that 'unknown' in the column says nothing. A bee family on either
    // side, or no family anywhere, and the record waits for its name, as
    // before. A qualifier says something about a species epithet, so a record
    // filed above species keeps it in the notes instead.
    const bees = BEE_FAMILIES.map(sqlString).join(", ");
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ecd_ancestry AS
       WITH RECURSIVE up(node_id, anc_id) AS (
         SELECT entity_id, entity_id FROM animal
         UNION ALL
         SELECT up.node_id, a.parent_id FROM up JOIN animal a ON a.entity_id = up.anc_id WHERE a.parent_id IS NOT NULL
       ) SELECT * FROM up`,
    );
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ecd_candidate AS
       WITH ident AS (
         SELECT i.*, m.specimen_id, o.occurrence_record_id,
                o.family AS occ_family, o.order_name AS occ_order, o.class_name AS occ_class,
                lower(i.scientific_name) IN ('', 'undetermined', 'unidentified') AS placeholder,
                nullif(lower(i.identified_by), 'unknown') AS by_text,
                regexp_extract(i.qualifier_text, '^(cf|aff|af|nr)\\.?\\s+(\\S+)$', 1) AS q_word,
                regexp_extract(i.qualifier_text, '^(cf|aff|af|nr)\\.?\\s+(\\S+)$', 2) AS q_epithet,
                regexp_extract(i.scientific_name, '(\\S+)$', 1) AS last_word
         FROM ecd_identification i
         JOIN ecd_specimen m ON m.occ_id = i.occ_id
         JOIN ecd_occurrence o ON o.occ_id = i.occ_id
         WHERE m.specimen_id IS NOT NULL
       ),
       named AS (
         SELECT ident.*,
                (SELECT count(*) FROM animal a WHERE a.scientific_name = ident.scientific_name) AS nodes,
                (SELECT min(a.entity_id) FROM animal a WHERE a.scientific_name = ident.scientific_name) AS exact_id,
                CASE WHEN q_word <> '' AND lower(q_epithet) = lower(last_word)
                     THEN CASE q_word WHEN 'cf' THEN 'cf.' WHEN 'nr' THEN 'nr.' ELSE 'aff.' END END AS exact_qualifier,
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
       ),
       filed AS (
         SELECT named.*,
                CASE WHEN nodes = 0 THEN coalesce(
                  (SELECT CASE WHEN count(*) = 1 THEN min(a.entity_id) END FROM animal a
                    WHERE a.rank = 'genus'
                      AND a.scientific_name = coalesce(nullif(named.genus_text, ''), split_part(named.scientific_name, ' ', 1))),
                  CASE WHEN named.is_current THEN coalesce(
                    (SELECT CASE WHEN count(*) = 1 THEN min(a.entity_id) END FROM animal a WHERE a.rank = 'family' AND a.scientific_name = named.occ_family),
                    (SELECT CASE WHEN count(*) = 1 THEN min(a.entity_id) END FROM animal a WHERE a.rank = 'order' AND a.scientific_name = named.occ_order),
                    (SELECT CASE WHEN count(*) = 1 THEN min(a.entity_id) END FROM animal a WHERE a.rank = 'class' AND a.scientific_name = named.occ_class)) END)
                END AS filed_id
         FROM named
       ),
       judged AS (
         SELECT filed.*,
                (SELECT min(f.scientific_name) FROM ecd_ancestry u JOIN animal f ON f.entity_id = u.anc_id
                  WHERE u.node_id = filed.filed_id AND f.rank = 'family') AS filed_family
         FROM filed
       ),
       placed AS (
         SELECT judged.*,
                CASE WHEN nodes = 1 THEN exact_id
                     WHEN filed_id IS NOT NULL
                      AND coalesce(filed_family, '') NOT IN (${bees})
                      AND coalesce(occ_family, '') NOT IN (${bees})
                      AND (filed_family IS NOT NULL
                           OR (is_current AND (EXISTS (SELECT 1 FROM animal f WHERE f.rank = 'family' AND f.scientific_name = occ_family)
                                               OR EXISTS (SELECT 1 FROM ecdysis_taxon t WHERE t.rank = 'family' AND t.name = occ_family))))
                     THEN filed_id END AS animal_id,
                CASE WHEN nodes = 1 THEN exact_qualifier END AS qualifier
         FROM judged
       ),
       resolved AS (
         SELECT placed.*,
                nullif(concat_ws('; ',
                  CASE WHEN qualifier IS NULL AND qualifier_text <> '' THEN qualifier_text END,
                  nullif(remarks, '')), '') AS notes
         FROM placed
       )
       SELECT *,
              EXISTS (SELECT 1 FROM ecdysis_identification e WHERE e.record_id = resolved.record_id) AS already,
              -- The same identification under another key. A flat export
              -- and an archive key one identification differently, so an
              -- event on this specimen with this node, qualifier and
              -- determiner that no Symbiota recordID has claimed yet is this
              -- identification, seen before its id was: the row adopts it.
              -- An event a recordID already claims is a different
              -- identification that happens to say the same thing — Ecdysis
              -- does re-enter one — and is left alone. A flat row, being
              -- current by definition, may also adopt the specimen's
              -- current Ecdysis record whatever claims it, since one
              -- current identification cannot be two events. The name as
              -- written is part of what it says, since two names filed under
              -- one broader node are not one identification, and so, for such
              -- a record, are the notes its qualifier moved to.
              (SELECT min(d.entity_id) FROM determination d
                WHERE d.specimen_id = resolved.specimen_id AND d.channel = 'ecdysis_import'
                  AND d.animal_id = resolved.animal_id
                  AND d.qualifier IS NOT DISTINCT FROM resolved.qualifier
                  AND d.verbatim_identification IS NOT DISTINCT FROM resolved.scientific_name
                  AND (resolved.nodes = 1 OR d.notes IS NOT DISTINCT FROM resolved.notes)
                  AND d.determiner_name IS NOT DISTINCT FROM CASE WHEN resolved.by_text IS NULL OR resolved.by_text = '' THEN NULL ELSE resolved.identified_by END
                  AND (NOT EXISTS (SELECT 1 FROM ecdysis_identification e WHERE e.determination_id = d.entity_id AND e.record_id NOT LIKE 'occ:%')
                       OR ($1 AND EXISTS (SELECT 1 FROM determination_of_record r WHERE r.entity_id = d.entity_id)))) AS adopt_id
       FROM resolved`,
      [files.input === "flat"],
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
      `SELECT count(*) FROM ecd_candidate WHERE NOT placeholder AND (already OR adopt_id IS NOT NULL)`,
    );
    const unresolvedNames = (
      await rows(
        conn,
        `SELECT scientific_name, count(*) FROM ecd_candidate
         WHERE NOT placeholder AND NOT already AND adopt_id IS NULL AND animal_id IS NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${REPORTED_NAMES}`,
      )
    ).map((r) => ({ name: String(r[0]), rows: Number(r[1]) }));
    const filedUnder = (
      await rows(
        conn,
        `SELECT c.scientific_name, a.scientific_name, count(*) FROM ecd_candidate c JOIN animal a ON a.entity_id = c.animal_id
         WHERE NOT c.placeholder AND NOT c.already AND c.adopt_id IS NULL AND c.nodes = 0 GROUP BY 1, 2 ORDER BY 3 DESC, 1 LIMIT ${REPORTED_NAMES}`,
      )
    ).map((r) => ({ name: String(r[0]), under: String(r[1]), rows: Number(r[2]) }));
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
       WHERE NOT c.placeholder AND NOT c.already AND c.adopt_id IS NULL AND c.animal_id IS NOT NULL`,
      [now.toISOString()],
    );
    // Adoptions: the recordID is linked to the event that already stands.
    await conn.run(
      `INSERT INTO ecdysis_identification (record_id, determination_id, occurrence_id, entered_at, loaded_at)
       SELECT c.record_id, c.adopt_id, c.occurrence_record_id, c.entered_at, $1::TIMESTAMPTZ
       FROM ecd_candidate c
       WHERE NOT c.placeholder AND NOT c.already AND c.adopt_id IS NOT NULL
       QUALIFY row_number() OVER (PARTITION BY c.record_id ORDER BY c.record_id) = 1`,
      [now.toISOString()],
    );
    // The rows this load inserts are the ones above the sequence's current
    // high-water mark, which is how the provenance rows below find them:
    // recorded_at is not an identity, since a later load can give another
    // superseded row the same entry time and offset (CodeRabbit on PR #101).
    const before = await scalar(conn, `SELECT coalesce(max(entity_id), 0) FROM determination`);
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
       JOIN determination d ON d.specimen_id = i.specimen_id AND d.recorded_at = i.recorded_at
                            AND d.channel = 'ecdysis_import' AND d.entity_id > $2`,
      [now.toISOString(), before],
    );
    const loaded = await scalar(conn, `SELECT count(*) FROM ecd_insert`);
    await conn.run("COMMIT");
    return {
      input: files.input,
      occurrences,
      matched,
      catalogNumbers,
      ambiguousCatalogNumbers,
      ambiguousIdentifications,
      unmatched: occurrences - matched,
      unmatchedSample,
      identifications,
      placeholders,
      alreadyLoaded,
      adopted: adoptedNames,
      unresolvedNames,
      filedUnder,
      loaded,
      determiners,
    };
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}

/** The CLI's arguments: path, db, --prefix and --force in any order. */
export function parseArgs(args: readonly string[]): { path: string | undefined; db: string | undefined; catalogPrefix: string; force: boolean } {
  const prefixAt = args.indexOf("--prefix");
  const catalogPrefix = prefixAt >= 0 ? (args[prefixAt + 1] ?? "") : "WSDA_";
  const force = args.includes("--force");
  // The prefix's value is skipped only when --prefix is present: with it
  // absent, prefixAt + 1 is 0, which is the path (CodeRabbit on PR #101).
  const positional = args.filter((a, i) => a !== "--prefix" && a !== "--force" && (prefixAt < 0 || i !== prefixAt + 1));
  return { path: positional[0], db: positional[1], catalogPrefix, force };
}

// CLI: pnpm ecdysis:load <archive-dir-or-export.csv> [db] [--prefix WSDA_] [--force]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { path, db, catalogPrefix, force } = parseArgs(process.argv.slice(2));
  if (path === undefined) {
    console.error("usage: pnpm ecdysis:load <archive-dir-or-export.csv> [db] [--prefix WSDA_] [--force]");
    process.exit(2);
  }
  const { openDuckDb } = await import("./db.js");
  const instance = await openDuckDb(db ?? process.env.BEELINE_DB ?? DEFAULT_DB);
  const conn = await instance.connect();
  const result = await loadEcdysis(conn, { path, catalogPrefix, force });
  await conn.run("CHECKPOINT");
  conn.closeSync();
  console.log(JSON.stringify(result, null, 2));
}
