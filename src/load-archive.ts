import type { DuckDBConnection } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { adoptEcdysisNames, type AdoptedName } from "./adopt-ecdysis.js";
import { csvCell } from "./app/listings.js";
import { DEFAULT_DB } from "./person-change.js";

/**
 * One version of a Darwin Core archive a museum publishes to GBIF, onto the
 * specimens its records name (beeline-muke). The first is OSAC's "Oregon Bee
 * Atlas" dataset: the only place Oregon's expert identifications are
 * published, since OSAC's own database is private and the old Beeline stopped
 * receiving expert names at cutover.
 *
 * The directory comes from `pnpm archive:fetch` (src/fetch-archive.ts): the
 * publisher's archive unpacked, `occurrence.txt` and `eml.xml`. The dataset
 * and the version are read from eml.xml, and the dataset must be one
 * `archive_dataset` names (schema/042).
 *
 * A load does three things, in one transaction:
 *
 * 1. KEEPS WHAT THE VERSION SAYS. Every record whose statement is new, or
 *    differs from the last version loaded, becomes an `archive_statement`
 *    row; a record the version no longer holds gets a withdrawn one. Nothing
 *    already stored is changed.
 *
 * 2. READS EVERY RECORD'S NEWEST STATEMENT AFRESH (`archive_reading`): the
 *    one specimen its field number names, confirmed by the collector and the
 *    day collected as a typed number in a sheet is (src/load-determination-
 *    sheet.ts); the name, from the genus and epithet through
 *    ingest/taxon-aliases.csv; the determiner, through
 *    ingest/determiner-aliases.csv. What cannot be read is held with its
 *    reason, and listed in held.csv.
 *
 * 3. RECORDS A DETERMINATION IN EXACTLY TWO CASES, and otherwise none:
 *    - the specimen has no expert determination at all: the archive's name is
 *      recorded as one, now, and becomes the record;
 *    - the specimen's determination of record is the one an earlier load
 *      recorded from this same record, and the record now says something
 *      else: the publisher revised its own statement and nothing in Beeline
 *      has spoken since, so the revision is recorded.
 *    Where Beeline holds an expert name from anywhere else, nothing is
 *    recorded, whether the archive agrees with it or not. The archive states
 *    a bare year and no time of change, and the old Beeline's names carry no
 *    date, so nothing says which is newer; and Peter chose to hold back
 *    (2026-11-15) in the hope that the determiner will send his
 *    determinations directly. The statement is shown on the specimen's page
 *    instead (`archive_note`), and a differing one is listed in
 *    `archive_disagreement`.
 *
 * A determination is recorded as the archive states it and no further: the
 * name, the sex, the determiner and the year, which is kept as a year. The
 * archive has no caste and none is supplied.
 *
 * A name the tree lacks is adopted from Ecdysis's thesaurus only for a record
 * that would be recorded, as the sheet loader does (src/adopt-ecdysis.ts);
 * the tree is not changed for a statement that is only shown.
 *
 * Loading the same version again records nothing, but reads every statement
 * again, so a record held for a name or a determiner is recorded once the
 * alias or the name has been added. Versions load in the order they were
 * published.
 */

export const HELD_REASONS = [
  "no_number",
  "repeated_number",
  "no_specimen",
  "ambiguous_number",
  "specimen_changed",
  "number_unconfirmed",
  "collector_disagrees",
  "date_disagrees",
  "identified_unreadable",
  "identified_disagrees",
  "name_unreadable",
  "sex_unreadable",
  "determiner_unknown",
  "name_unknown",
  "family_disagrees",
] as const;
export type HeldReason = (typeof HELD_REASONS)[number];

/**
 * The reasons that put the field number itself in doubt. A record held for
 * one of these is tied to no specimen, so its statement is shown on no
 * specimen's page.
 */
const NUMBER_REASONS: readonly HeldReason[] = [
  "no_number",
  "repeated_number",
  "no_specimen",
  "ambiguous_number",
  "specimen_changed",
  "number_unconfirmed",
  "collector_disagrees",
  "date_disagrees",
];

/** The Darwin Core terms a dataset may name its specimens by (archive_dataset.specimen_term). */
export const SPECIMEN_TERMS: readonly string[] = ["fieldNumber"];

/**
 * Terms that change what an identification says, which the loader does not
 * read: a qualifier (cf.) or a third epithet would be recorded as a plain
 * species. OSAC's archive has neither column. One that gains a value in them
 * is refused until the loader reads them.
 */
const UNREAD_TERMS = ["identificationQualifier", "infraspecificEpithet"] as const;

/** Whether one dotted version number comes after another: 1.10 after 1.9. */
export function versionAfter(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < Math.max(x!.length, y!.length); i++) {
    const d = (x![i] ?? 0) - (y![i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export const HELD_COLUMNS = ["occurrence_id", "field_number", "reason", "scientific_name", "identified_by", "date_identified", "detail"] as const;

export const DEFAULT_DETERMINER_ALIASES = new URL("../ingest/determiner-aliases.csv", import.meta.url).pathname;
export const DEFAULT_TAXON_ALIASES = new URL("../ingest/taxon-aliases.csv", import.meta.url).pathname;

export interface ArchiveLoadOptions {
  /** An unpacked archive: `occurrence.txt` and `eml.xml`. */
  dir: string;
  determinerAliases?: string;
  taxonAliases?: string;
  /** Where the held records go; `held.csv` in the directory by default. */
  heldPath?: string;
  dryRun?: boolean;
  now?: Date;
}

/** A count split as every check is: samples of an active season, and of a settled one. */
export interface BySeason {
  active: number;
  settled: number;
}

export interface ArchiveLoadResult {
  datasetKey: string;
  publisher: string;
  version: string;
  publishedOn: string;
  /** False when this version had been loaded before, and only the reading was done again. */
  newVersion: boolean;
  records: number;
  /** Statements this load stored: records new to the dataset, and records whose statement changed. */
  statements: { added: number; changed: number; withdrawn: number };
  /** Records read as naming one specimen. */
  matched: number;
  /** Determinations recorded where the specimen had no expert determination. */
  backfilled: BySeason;
  /** Determinations recorded over an earlier load's determination of the same record. */
  revised: Array<{ fieldNumber: string; was: string; now: string }>;
  /** Specimens whose expert determination of record gives the name the archive gives. */
  agrees: BySeason;
  /** Specimens whose expert determination of record gives another name (archive_disagreement). */
  disagrees: BySeason;
  held: Record<HeldReason, number>;
  adopted: AdoptedName[];
  createdPeople: string[];
  /**
   * Specimens whose determination of record an earlier load recorded from
   * this dataset, which no record of it now names readably: the record was
   * withdrawn, or is now held. Their pages still show the earlier name as
   * the publisher's and say nothing newer, so these are for a person.
   */
  unsupported: string[];
  heldPath: string;
}

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

const all = async (conn: DuckDBConnection, sql: string, params: unknown[] = []) =>
  (await (await conn.run(sql, params as never)).getRows()) as unknown[][];
const one = async (conn: DuckDBConnection, sql: string) => Number((await all(conn, sql))[0]?.[0] ?? 0);

/** A name folded to letters, so O'Loughlin and OLoughlin are one. */
const FOLD = (col: string) => `lower(regexp_replace(${col}, '[^A-Za-z]', '', 'g'))`;

/** The columns of a statement that the archive states, in the table's order. */
const STATED = [
  "field_number",
  "catalog_number",
  "recorded_by",
  "event_date",
  "scientific_name",
  "family",
  "genus",
  "subgenus",
  "specific_epithet",
  "taxon_rank",
  "identified_by",
  "date_identified",
  "sex",
] as const;

/**
 * The dataset, version and publication date an archive's eml.xml states. An
 * IPT writes the dataset's GBIF key and the version into `packageId`
 * ("1fa69ff3-…/v1.9") and the date into `pubDate`.
 */
export function readEml(xml: string): { datasetKey: string; version: string; publishedOn: string } {
  const id = /packageId="([0-9a-f-]{36})\/v([0-9]+(?:\.[0-9]+)*)"/.exec(xml);
  if (id === null) throw new Error("eml.xml: no packageId of the form <GBIF dataset key>/v<version>");
  const published = /<pubDate>\s*(\d{4}-\d{2}-\d{2})\s*<\/pubDate>/.exec(xml);
  if (published === null) throw new Error("eml.xml: no pubDate that is a day");
  return { datasetKey: id[1]!, version: id[2]!, publishedOn: published[1]! };
}

export async function loadArchive(conn: DuckDBConnection, opts: ArchiveLoadOptions): Promise<ArchiveLoadResult> {
  const { datasetKey, version, publishedOn } = readEml(await readFile(join(opts.dir, "eml.xml"), "utf8"));
  const occurrencePath = join(opts.dir, "occurrence.txt");
  const sha256 = createHash("sha256").update(await readFile(occurrencePath)).digest("hex");
  const heldPath = opts.heldPath ?? join(opts.dir, "held.csv");
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  const dataset = (await all(conn, `SELECT publisher, specimen_term FROM archive_dataset WHERE dataset_key = $1`, [datasetKey]))[0];
  if (dataset === undefined) {
    throw new Error(`dataset ${datasetKey} is not in archive_dataset: say first which of its columns names the specimen (schema/042)`);
  }
  const publisher = String(dataset[0]);
  const specimenTerm = String(dataset[1]);
  if (!SPECIMEN_TERMS.includes(specimenTerm)) {
    throw new Error(`dataset ${datasetKey} names its specimens by ${specimenTerm}, which the loader cannot read`);
  }

  // A Darwin Core archive's core file as an IPT writes it: tab-separated, no
  // quoting, one header line of term names.
  const source = `read_csv(${sqlString(occurrencePath)}, delim = '\t', quote = '', escape = '', header = true, all_varchar = true)`;
  const present = new Set((await all(conn, `DESCRIBE SELECT * FROM ${source}`)).map((r) => String(r[0])));
  for (const required of ["occurrenceID", specimenTerm, "scientificName", "genus", "identifiedBy", "dateIdentified"]) {
    if (!present.has(required)) throw new Error(`${occurrencePath}: no ${required} column`);
  }
  const col = (name: string) => (present.has(name) ? `nullif(trim("${name}"), '')` : "CAST(NULL AS VARCHAR)");
  for (const term of UNREAD_TERMS) {
    if (present.has(term) && (await one(conn, `SELECT count(*) FROM ${source} WHERE ${col(term)} IS NOT NULL`)) > 0) {
      throw new Error(`${occurrencePath}: ${term} has values, which the loader does not read yet: recording these records would drop it`);
    }
  }

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ar_row AS
      SELECT ${col("occurrenceID")} AS occurrence_id, ${col(specimenTerm)} AS field_number, ${col("catalogNumber")} AS catalog_number,
             ${col("recordedBy")} AS recorded_by,
             try_cast(concat_ws('-', ${col("year")}, ${col("month")}, ${col("day")}) AS DATE) AS event_date,
             ${col("scientificName")} AS scientific_name, ${col("family")} AS family, ${col("genus")} AS genus,
             ${col("subgenus")} AS subgenus, ${col("specificEpithet")} AS specific_epithet, ${col("taxonRank")} AS taxon_rank,
             ${col("identifiedBy")} AS identified_by, ${col("dateIdentified")} AS date_identified, ${col("sex")} AS sex
      FROM ${source}`);
    const records = await one(conn, "SELECT count(*) FROM ar_row");
    // The file is read once, into ar_row, and everything after reads that.
    // If it changed between the hash and the read (a fetch rewriting it),
    // the statements would be stored under a hash that is not theirs.
    if (createHash("sha256").update(await readFile(occurrencePath)).digest("hex") !== sha256) {
      throw new Error(`${occurrencePath} changed while it was being read; load it again`);
    }
    if ((await one(conn, "SELECT count(*) FROM ar_row WHERE occurrence_id IS NULL")) > 0) {
      throw new Error(`${occurrencePath}: a record with no occurrenceID`);
    }
    if ((await one(conn, "SELECT count(*) - count(DISTINCT occurrence_id) FROM ar_row")) > 0) {
      throw new Error(`${occurrencePath}: an occurrenceID on more than one record`);
    }

    // The version: new, or one loaded before, whose file must be the same file.
    const loaded = (await all(conn, `SELECT sha256 FROM archive_version WHERE dataset_key = $1 AND version = $2`, [datasetKey, version]))[0];
    const newVersion = loaded === undefined;
    if (!newVersion && String(loaded[0]) !== sha256) {
      throw new Error(`version ${version} of ${datasetKey} was loaded from another file (sha256 ${String(loaded[0])}, this one ${sha256})`);
    }
    const statements = { added: 0, changed: 0, withdrawn: 0 };
    if (newVersion) {
      // Versions load in the order they were published: by date, and by
      // number too, since a publisher can issue two on one day (OSAC's 1.8
      // and 1.9) and an older one loaded second would be read as the newer.
      for (const [v, on] of await all(conn, `SELECT version, CAST(published_on AS VARCHAR) FROM archive_version WHERE dataset_key = $1`, [datasetKey])) {
        if (String(on) > publishedOn || !versionAfter(version, String(v))) {
          throw new Error(
            `version ${version} (published ${publishedOn}) does not come after version ${String(v)} (${String(on)}), which is already loaded: versions load in the order they were published`,
          );
        }
      }
      // What each record said last, before this version is added.
      await conn.run(
        `CREATE OR REPLACE TEMP TABLE ar_before AS SELECT * FROM archive_statement_current WHERE dataset_key = $1`,
        [datasetKey] as never,
      );
      await conn.run(
        `INSERT INTO archive_version (dataset_key, version, sequence, published_on, sha256, records, loaded_at)
         SELECT $1, $2, coalesce((SELECT max(sequence) FROM archive_version WHERE dataset_key = $1), 0) + 1,
                $3::DATE, $4, $5, $6::TIMESTAMPTZ`,
        [datasetKey, version, publishedOn, sha256, records, now.toISOString()] as never,
      );
      const differs = `(b.occurrence_id IS NULL OR b.withdrawn OR (${STATED.map((c) => `r.${c}`).join(", ")}) IS DISTINCT FROM (${STATED.map((c) => `b.${c}`).join(", ")}))`;
      await conn.run(`
        CREATE OR REPLACE TEMP TABLE ar_new AS
        SELECT r.*, b.occurrence_id IS NULL AS first_seen
        FROM ar_row r LEFT JOIN ar_before b ON b.occurrence_id = r.occurrence_id
        WHERE ${differs}`);
      await conn.run(
        `INSERT INTO archive_statement (dataset_key, occurrence_id, version, withdrawn, ${STATED.join(", ")})
         SELECT $1, occurrence_id, $2, false, ${STATED.join(", ")} FROM ar_new`,
        [datasetKey, version] as never,
      );
      await conn.run(
        `INSERT INTO archive_statement (dataset_key, occurrence_id, version, withdrawn)
         SELECT $1, b.occurrence_id, $2, true FROM ar_before b
         WHERE NOT b.withdrawn AND NOT EXISTS (SELECT 1 FROM ar_row r WHERE r.occurrence_id = b.occurrence_id)`,
        [datasetKey, version] as never,
      );
      statements.added = await one(conn, "SELECT count(*) FROM ar_new WHERE first_seen");
      statements.changed = await one(conn, "SELECT count(*) FROM ar_new WHERE NOT first_seen");
      statements.withdrawn = await one(
        conn,
        `SELECT count(*) FROM ar_before b WHERE NOT b.withdrawn AND NOT EXISTS (SELECT 1 FROM ar_row r WHERE r.occurrence_id = b.occurrence_id)`,
      );
    }

    await conn.run(`CREATE OR REPLACE TEMP TABLE ar_taxon_alias AS
      SELECT trim(rank) AS rank, trim(alias) AS alias, trim(name) AS name
      FROM read_csv(${sqlString(opts.taxonAliases ?? DEFAULT_TAXON_ALIASES)}, header = true, all_varchar = true)`);
    await conn.run(`CREATE OR REPLACE TEMP TABLE ar_determiner_alias AS
      SELECT trim(alias) AS alias, trim(person) AS person
      FROM read_csv(${sqlString(opts.determinerAliases ?? DEFAULT_DETERMINER_ALIASES)}, header = true, all_varchar = true)`);

    // Every record's newest statement, read afresh: this version's, and
    // those of records an earlier version held that this one does not change.
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ar_current AS
       SELECT * FROM archive_statement_current WHERE dataset_key = $1 AND NOT withdrawn`,
      [datasetKey] as never,
    );
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ar_parsed AS
      WITH r AS (
        SELECT *,
               CASE WHEN lower(specific_epithet) IN ('sp', 'sp.', 'spp', 'spp.') THEN NULL ELSE specific_epithet END AS species_epithet
        FROM ar_current
      ), g AS (
        SELECT r.*, coalesce(ga.name, r.genus) AS genus_name
        FROM r LEFT JOIN ar_taxon_alias ga ON ga.rank = 'genus' AND ga.alias = r.genus
      )
      SELECT g.*,
             -- Readable only where the genus and the epithet are the whole
             -- of what the record says. The name as published must be a
             -- genus, an epithet where the record gives one, and then
             -- nothing or an authorship (which starts with a bracket or a
             -- capital): any other word between or after them is something
             -- the parted columns drop, a qualifier (cf., aff., nr.), a
             -- subgenus, a third epithet, a question mark. Its shape is
             -- compared, not its spelling: OSAC's scientificName misspells a
             -- few names its own columns spell rightly (Ashmediella). And
             -- the rank the record states must be the rank the columns
             -- make, so a subgenus is not recorded as its genus.
             regexp_full_match(coalesce(genus, ''), '[A-Z][a-z]+')
               AND (species_epithet IS NULL OR regexp_full_match(species_epithet, '[a-z]+(-[a-z]+)?'))
               -- A genus's author is never in brackets, so a bracket after a
               -- lone genus is a subgenus; and nothing follows "sp.".
               AND regexp_full_match(coalesce(scientific_name, ''),
                     CASE WHEN specific_epithet IS NULL THEN '[A-Z][a-z]+( [A-Z][^?(]*)?'
                          WHEN species_epithet IS NULL THEN '[A-Z][a-z]+ spp?\\.?'
                          ELSE '[A-Z][a-z]+ [a-z]+(-[a-z]+)?( [(A-Z][^?]*)?' END)
               -- OSAC states the subgenus in a column of its own. On a record
               -- with no epithet that is an identification to subgenus
               -- (Lasioglossum, subgenus Dialictus: 818 records), which the
               -- tree cannot hold and the genus alone does not say. Under a
               -- species it is only where the species is filed.
               AND NOT (species_epithet IS NULL AND subgenus IS NOT NULL)
               AND NOT regexp_matches(coalesce(scientific_name, ''), '(^|\\s)(cf|aff|nr)\\.?(\\s|$)')
               AND (taxon_rank IS NULL
                    OR lower(taxon_rank) = CASE WHEN species_epithet IS NULL THEN 'genus' ELSE 'species' END) AS name_readable,
             CASE WHEN species_epithet IS NULL THEN 'genus' ELSE 'species' END AS rank,
             CASE WHEN species_epithet IS NULL THEN genus_name
                  ELSE coalesce(sa.name, concat(genus_name, ' ', species_epithet)) END AS name,
             CASE lower(sex) WHEN 'female' THEN 'female' WHEN 'male' THEN 'male' WHEN 'gynandromorph' THEN 'gynandromorph' END AS sex_read,
             CASE WHEN regexp_full_match(date_identified, '\\d{4}') THEN make_date(CAST(date_identified AS INTEGER), 1, 1) END AS determined_on,
             -- The last day the year can mean.
             CASE WHEN regexp_full_match(date_identified, '\\d{4}') THEN make_date(CAST(date_identified AS INTEGER), 12, 31) END AS determined_by_end,
             (SELECT count(*) FROM ar_current x WHERE x.field_number = g.field_number) AS times_in_dataset,
             (SELECT count(*) FROM specimen s WHERE s.field_number = g.field_number) AS specimens,
             (SELECT min(s.entity_id) FROM specimen s WHERE s.field_number = g.field_number) AS specimen_id
      FROM g
      LEFT JOIN ar_taxon_alias sa ON sa.rank = 'species' AND sa.alias = concat(g.genus, ' ', g.species_epithet)`);

    // What the specimen's sample says, to confirm the number: any of the
    // record's collectors, by whole name or by family name, and the day.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ar_sample AS
      SELECT p.occurrence_id, sa.entity_id AS sample_id, sa.date_start, sa.date_end,
             sa.entity_id IN (SELECT sample_id FROM settled_sample) AS settled,
             EXISTS (SELECT 1
                     FROM sample_collector sc JOIN person pe ON pe.entity_id = sc.person_id,
                          -- OSAC joins collectors with a pipe on some records and a semicolon on others.
                          unnest(string_split_regex(p.recorded_by, '[|;]')) AS part(collector)
                     WHERE sc.sample_id = sa.entity_id
                       AND (${FOLD("pe.display_name")} = ${FOLD("part.collector")}
                            -- The family name, where the given names do not
                            -- contradict each other. Either side may give
                            -- none, or only an initial (J. Smith), and then
                            -- the first letter decides. Where both give a
                            -- name in full, they must begin with the same
                            -- three letters, which takes the short forms the
                            -- archive writes (Steve for Steven, Kathy for
                            -- Kathleen, Sara for Sarah) and not another
                            -- member of the household: John Smith does not
                            -- confirm a number on Jane Smith's specimen, and
                            -- Bob for Robert is held for a person.
                            OR (${FOLD("pe.family_name")} <> ''
                                AND ${FOLD("pe.family_name")} = ${FOLD("regexp_extract(trim(part.collector), '([^ ]+)$', 1)")}
                                AND (nullif(trim(pe.given_name), '') IS NULL
                                     OR NOT contains(trim(part.collector), ' ')
                                     OR CASE WHEN length(${FOLD("split_part(trim(pe.given_name), ' ', 1)")}) > 1
                                              AND length(${FOLD("split_part(trim(part.collector), ' ', 1)")}) > 1
                                             THEN left(${FOLD("split_part(trim(pe.given_name), ' ', 1)")}, 3) = left(${FOLD("split_part(trim(part.collector), ' ', 1)")}, 3)
                                             ELSE lower(left(trim(pe.given_name), 1)) = lower(left(trim(part.collector), 1)) END)))) AS collector_matches,
             (SELECT string_agg(pe.display_name, ' | ' ORDER BY sc.position)
              FROM sample_collector sc JOIN person pe ON pe.entity_id = sc.person_id WHERE sc.sample_id = sa.entity_id) AS collectors
      FROM ar_parsed p JOIN specimen sp ON sp.entity_id = p.specimen_id JOIN sample sa ON sa.entity_id = sp.sample_id
      WHERE p.specimens = 1`);

    // The specimens whose determination of record is one an earlier load
    // recorded from this dataset: the only expert names a load may revise.
    // By the specimen and not by the record, so that a record the publisher
    // re-issues under another occurrenceID (as cataloguing a specimen might)
    // still revises the publisher's own earlier name.
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ar_recorded AS
       SELECT d.specimen_id, d.entity_id AS determination_id, d.animal_id, d.sex, d.determiner_name, d.determined_on
       FROM archive_determination ad JOIN determination_of_record d ON d.entity_id = ad.determination_id
       WHERE ad.dataset_key = $1`,
      [datasetKey] as never,
    );
    // And every specimen an earlier load recorded each record on.
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ar_recorded_on AS
       SELECT DISTINCT ad.occurrence_id, d.specimen_id
       FROM archive_determination ad JOIN determination d ON d.entity_id = ad.determination_id
       WHERE ad.dataset_key = $1`,
      [datasetKey] as never,
    );

    // Holding, in order: the first reason a record cannot be read is its
    // reason. The name comes last, since adopting a name for a record that
    // would be held anyway would change the tree for nothing.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ar_outcome AS
      SELECT p.*, s.settled, s.collectors, s.date_start, s.date_end,
             (SELECT min(a.person) FROM ar_determiner_alias a WHERE a.alias = p.identified_by) AS determiner_person,
             CASE
               WHEN p.field_number IS NULL THEN 'no_number'
               WHEN p.times_in_dataset > 1 THEN 'repeated_number'
               WHEN p.specimens = 0 THEN 'no_specimen'
               WHEN p.specimens > 1 THEN 'ambiguous_number'
               WHEN EXISTS (SELECT 1 FROM ar_recorded_on x WHERE x.occurrence_id = p.occurrence_id AND x.specimen_id <> p.specimen_id) THEN 'specimen_changed'
               -- A number nothing confirms is not taken on its own word.
               WHEN p.recorded_by IS NULL OR p.event_date IS NULL THEN 'number_unconfirmed'
               WHEN NOT s.collector_matches THEN 'collector_disagrees'
               WHEN NOT (p.event_date BETWEEN s.date_start AND s.date_end) THEN 'date_disagrees'
               WHEN p.date_identified IS NOT NULL AND p.determined_on IS NULL THEN 'identified_unreadable'
               WHEN p.determined_on > DATE ${sqlString(today)} OR p.determined_by_end < s.date_start THEN 'identified_disagrees'
               WHEN NOT p.name_readable THEN 'name_unreadable'
               WHEN p.sex IS NOT NULL AND p.sex_read IS NULL THEN 'sex_unreadable'
               -- A blank determiner is held too: a sheet's author vouches for
               -- its rows, and a published record that names nobody has no one to.
               WHEN p.identified_by IS NULL OR p.identified_by NOT IN (SELECT alias FROM ar_determiner_alias) THEN 'determiner_unknown'
             END AS outcome,
             CAST(NULL AS INTEGER) AS animal_id, CAST(NULL AS VARCHAR) AS detail
      FROM ar_parsed p LEFT JOIN ar_sample s USING (occurrence_id)`);

    // The records a determination could come of: a specimen no expert has
    // named, or one whose record is this record's own earlier determination.
    await conn.run(`
      ALTER TABLE ar_outcome ADD COLUMN may_record BOOLEAN`);
    await conn.run(`
      UPDATE ar_outcome o SET may_record = o.outcome IS NULL AND (
        NOT EXISTS (SELECT 1 FROM determination d WHERE d.specimen_id = o.specimen_id AND d.is_expert)
        OR EXISTS (SELECT 1 FROM ar_recorded x WHERE x.specimen_id = o.specimen_id))`);

    const unplaced = (
      await all(
        conn,
        `SELECT DISTINCT o.name FROM ar_outcome o
         WHERE o.may_record AND NOT EXISTS (SELECT 1 FROM animal a WHERE a.rank = o.rank AND a.scientific_name = o.name)`,
      )
    ).map((r) => String(r[0]));
    const adopted = await adoptEcdysisNames(conn, unplaced);

    // Every readable name is placed, a held record's too, so that a record
    // held for its determiner or its year still says whether its name is
    // the one Beeline has.
    await conn.run(`
      UPDATE ar_outcome o SET animal_id = (SELECT min(a.entity_id) FROM animal a WHERE a.rank = o.rank AND a.scientific_name = o.name)
      WHERE o.name_readable`);
    await conn.run(`UPDATE ar_outcome SET outcome = 'name_unknown', detail = name WHERE outcome IS NULL AND animal_id IS NULL`);
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ar_family AS
      WITH RECURSIVE up(node_id, anc_id) AS (
        SELECT DISTINCT animal_id, animal_id FROM ar_outcome WHERE animal_id IS NOT NULL
        UNION ALL
        SELECT up.node_id, a.parent_id FROM up JOIN animal a ON a.entity_id = up.anc_id WHERE a.parent_id IS NOT NULL
      )
      SELECT up.node_id, a.scientific_name AS family FROM up JOIN animal a ON a.entity_id = up.anc_id WHERE a.rank = 'family'`);
    await conn.run(`
      UPDATE ar_outcome o SET outcome = 'family_disagrees',
             detail = concat('filed under ', coalesce((SELECT f.family FROM ar_family f WHERE f.node_id = o.animal_id), 'no family'))
      WHERE o.outcome IS NULL AND o.family IS NOT NULL
        AND o.family IS DISTINCT FROM (SELECT f.family FROM ar_family f WHERE f.node_id = o.animal_id)`);
    await conn.run(`
      UPDATE ar_outcome SET detail = CASE outcome
        WHEN 'collector_disagrees' THEN concat('the sample''s collectors are ', collectors)
        WHEN 'date_disagrees' THEN concat('the sample was collected ', CAST(date_start AS VARCHAR),
               CASE WHEN date_end <> date_start THEN concat(' to ', CAST(date_end AS VARCHAR)) ELSE '' END,
               ', the archive says ', CAST(event_date AS VARCHAR))
        WHEN 'identified_disagrees' THEN CASE WHEN determined_on > DATE ${sqlString(today)} THEN 'after today'
               ELSE concat('before the sample was collected on ', CAST(date_start AS VARCHAR)) END
        WHEN 'specimen_changed' THEN 'an earlier load recorded this record on another specimen'
        WHEN 'number_unconfirmed' THEN 'the record gives no collector or no day collected'
        WHEN 'sex_unreadable' THEN sex
        WHEN 'name_unreadable' THEN CASE WHEN species_epithet IS NULL AND subgenus IS NOT NULL
               THEN concat('identified to the subgenus ', subgenus, ', which the tree does not hold') END
        WHEN 'determiner_unknown' THEN coalesce(identified_by, 'the record names nobody')
        ELSE detail END
      WHERE outcome IS NOT NULL`);

    // What is to be recorded: a first expert name, or a revision of this
    // record's own, which is one only where what it says has changed.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ar_candidate AS
      SELECT o.*,
             CASE
               WHEN o.outcome IS NOT NULL OR NOT o.may_record THEN NULL
               WHEN x.determination_id IS NULL THEN 'backfilled'
               WHEN (x.animal_id, x.sex, x.determiner_name, x.determined_on)
                    IS DISTINCT FROM (o.animal_id, o.sex_read, o.identified_by, o.determined_on) THEN 'revised'
             END AS recording,
             x.animal_id AS was_animal_id
      FROM ar_outcome o LEFT JOIN ar_recorded x ON x.specimen_id = o.specimen_id`);

    // The determiners the determinations name, created where the alias file
    // names a person the store does not hold, as the sheet loader does.
    const toCreate = (
      await all(
        conn,
        `SELECT DISTINCT c.determiner_person FROM ar_candidate c
         WHERE c.recording IS NOT NULL AND c.determiner_person IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM person p WHERE p.display_name = c.determiner_person)
         ORDER BY 1`,
      )
    ).map((r) => String(r[0]));
    for (const name of toCreate) {
      const parts = name.split(" ");
      const [given, family] = parts.length === 2 ? parts : [null, null];
      await conn.run(`INSERT INTO person (display_name, given_name, family_name) VALUES ($1, $2, $3)`, [name, given, family] as never);
    }

    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ar_insert AS
      SELECT nextval('entity_id_seq') AS determination_id, c.*,
             (SELECT min(p.entity_id) FROM person p WHERE p.display_name = c.determiner_person) AS determiner_id
      FROM (SELECT * FROM ar_candidate WHERE recording IS NOT NULL ORDER BY occurrence_id) c`);
    await conn.run(
      `INSERT INTO determination (entity_id, specimen_id, animal_id, verbatim_identification, sex, determiner_id, determiner_name,
                                  is_expert, channel, determined_on, determined_on_precision, recorded_at)
       SELECT determination_id, specimen_id, animal_id, scientific_name, sex_read, determiner_id, identified_by,
              true, 'worksheet_import', determined_on, CASE WHEN determined_on IS NOT NULL THEN 'year' END, $1::TIMESTAMPTZ
       FROM ar_insert`,
      [now.toISOString()] as never,
    );
    await conn.run(
      `INSERT INTO archive_determination (determination_id, dataset_key, occurrence_id, version, loaded_at)
       SELECT determination_id, $1, occurrence_id, version, $2::TIMESTAMPTZ FROM ar_insert`,
      [datasetKey, now.toISOString()] as never,
    );

    // The reading, restated for the whole dataset. A record held because its
    // number is in doubt is tied to no specimen.
    const numberReasons = NUMBER_REASONS.map(sqlString).join(", ");
    await conn.run(`DELETE FROM archive_reading WHERE dataset_key = $1`, [datasetKey] as never);
    await conn.run(
      `INSERT INTO archive_reading (dataset_key, occurrence_id, version, specimen_id, animal_id, determiner_id, sex, determined_on, held, detail)
       SELECT $1, c.occurrence_id, c.version,
              CASE WHEN c.outcome IN (${numberReasons}) THEN NULL ELSE c.specimen_id END,
              c.animal_id,
              (SELECT min(p.entity_id) FROM person p WHERE p.display_name = c.determiner_person),
              c.sex_read, c.determined_on, c.outcome, c.detail
       FROM ar_candidate c`,
      [datasetKey] as never,
    );

    const held = Object.fromEntries(HELD_REASONS.map((r) => [r, 0])) as Record<HeldReason, number>;
    for (const [reason, n] of await all(conn, `SELECT outcome, count(*) FROM ar_candidate WHERE outcome IS NOT NULL GROUP BY outcome`)) {
      held[String(reason) as HeldReason] = Number(n);
    }
    const heldRows = await all(
      conn,
      `SELECT occurrence_id, field_number, outcome, scientific_name, identified_by, date_identified, detail
       FROM ar_candidate WHERE outcome IS NOT NULL ORDER BY outcome, occurrence_id`,
    );
    const bySeason = async (sql: string): Promise<BySeason> => {
      const counts: BySeason = { active: 0, settled: 0 };
      for (const [settled, n] of await all(conn, sql)) counts[settled === true ? "settled" : "active"] = Number(n);
      return counts;
    };
    const revised = (
      await all(
        conn,
        `SELECT c.field_number, was.scientific_name, c.scientific_name
         FROM ar_candidate c JOIN animal was ON was.entity_id = c.was_animal_id
         WHERE c.recording = 'revised' ORDER BY c.field_number`,
      )
    ).map(([fieldNumber, was, nowName]) => ({ fieldNumber: String(fieldNumber), was: String(was), now: String(nowName) }));

    const result: ArchiveLoadResult = {
      datasetKey,
      publisher,
      version,
      publishedOn,
      newVersion,
      records,
      statements,
      matched: await one(conn, `SELECT count(*) FROM archive_reading WHERE dataset_key = ${sqlString(datasetKey)} AND specimen_id IS NOT NULL`),
      backfilled: await bySeason(`SELECT settled, count(*) FROM ar_candidate WHERE recording = 'backfilled' GROUP BY settled`),
      revised,
      agrees: await bySeason(
        `SELECT sp.sample_id IN (SELECT sample_id FROM settled_sample), count(*)
         FROM archive_note n JOIN specimen sp ON sp.entity_id = n.specimen_id
         WHERE n.dataset_key = ${sqlString(datasetKey)} AND n.agrees AND NOT n.is_record GROUP BY 1`,
      ),
      disagrees: await bySeason(
        `SELECT settled, count(*) FROM archive_disagreement WHERE dataset_key = ${sqlString(datasetKey)} GROUP BY settled`,
      ),
      held,
      adopted,
      createdPeople: toCreate,
      unsupported: (
        await all(
          conn,
          `SELECT sp.field_number FROM ar_recorded x JOIN specimen sp ON sp.entity_id = x.specimen_id
           WHERE NOT EXISTS (SELECT 1 FROM ar_candidate c WHERE c.specimen_id = x.specimen_id AND c.outcome IS NULL)
           ORDER BY 1`,
        )
      ).map((r) => String(r[0])),
      heldPath,
    };
    // Written before the commit, so a report that cannot be written fails
    // the load rather than following a load that succeeded.
    const heldCsv = [HELD_COLUMNS.join(","), ...heldRows.map((r) => r.map(csvCell).join(","))].join("\n");
    await writeFile(heldPath, `${heldCsv}\n`);
    await conn.run(opts.dryRun ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (err) {
    await conn.run("ROLLBACK").catch(() => {});
    throw err;
  }
}

// CLI: pnpm archive:load <archive-dir> [db] [--held <path>] [--dry-run]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const valued = ["--held"];
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1] ?? ""));
  const dir = positional[0];
  if (dir === undefined) {
    console.error("usage: pnpm archive:load <archive-dir> [db] [--held <path>] [--dry-run]");
    process.exit(2);
  }
  const { openDuckDb } = await import("./db.js");
  const instance = await openDuckDb(positional[1] ?? process.env.BEELINE_DB ?? DEFAULT_DB);
  const conn = await instance.connect();
  try {
    const result = await loadArchive(conn, { dir, heldPath: option("--held"), dryRun: args.includes("--dry-run") });
    await conn.run("CHECKPOINT");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    conn.closeSync();
  }
}
