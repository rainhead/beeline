import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { openDuckDb } from "./db.js";
import { LEGACY_EXPORT_COLUMNS, writeLegacyExport } from "./legacy-export.js";
import { OUTCOMES, readRulings, RECORD_COLUMN, type Ruling } from "./legacy-export-rulings.js";

/**
 * How far the legacy-format export is from what the legacy system itself
 * held (beeline-6q8): its done-test, the thing to read before telling
 * anybody downstream that the file is ready, and, during the parallel run,
 * the list of differences nobody has explained yet (beeline-en7i).
 *
 * The legacy side is the store's staged pull of production Mongo
 * (`legacy_occurrence`), which Beeline also imports from — so this measures
 * what Beeline does to the legacy records, and where its own iNaturalist
 * path disagrees with the legacy system's, rather than two independent
 * systems. The report names the pull it compared against by a fingerprint
 * of its rows, so two runs can say whether they read the same one.
 *
 * Rows are matched on fieldNumber — the identity printed on the pin, and the
 * key Andony's comparison joins on — counting only numbers that occur once on
 * each side, since a number the legacy file holds twice cannot be matched
 * honestly to either row. For every matched pair, each of the 63 columns is
 * compared as text, and each difference is given a kind (a blank filled,
 * Roman numerals, a country code, …; VALUE_KINDS) and split by season as
 * every check in this repo is (CLAUDE.md): the active seasons against the
 * settled ones, on the record's own collecting date (its first day), using
 * the store's own line (`season.active_since`). A number only one side holds is a difference
 * about the whole record, kinded by why. The rulings
 * (`ingest/legacy-export-rulings.csv`) then say which differences are
 * explained; what is left is the report.
 */

/** One (exported, legacy) pair, how often it occurs, and a record it occurs on. */
export interface Example {
  exported: string;
  legacy: string;
  n: number;
  /** The lowest field number carrying this pair: a record to look at, and the key Andony's comparison joins on. */
  fieldNumber: string;
}

export interface ColumnDifference {
  column: string;
  active: number;
  settled: number;
  /** The commonest pairs, to say what kind of difference it is; empty where the column names a person or a place. */
  examples: Example[];
  /** A few records to look at, whatever the column: the lowest field numbers. */
  fieldNumbers: string[];
}

/** Differences of one kind in one column that no ruling explains. */
export interface UnexplainedGroup extends ColumnDifference {
  kind: string;
}

/**
 * Every difference of one kind under one outcome, across the columns it
 * touches — the answer to "what kinds of difference are there, how many
 * records, and what do they look like" (GitHub #107). Counted in records
 * rather than differences, since a kind that touches four columns of one
 * record (collector_list_form) is one thing wrong with that record.
 */
export interface KindGroup {
  kind: string;
  /** The outcome of the rulings that explain the group, or `unexplained`. */
  outcome: string;
  /** The columns the kind touches, most affected first. */
  columns: string[];
  active: number;
  settled: number;
  /** The commonest pairs across the columns that may be quoted, each with its column. */
  examples: (Example & { column: string })[];
  fieldNumbers: string[];
}

export interface RulingResult {
  ruling: Ruling;
  active: number;
  settled: number;
  /**
   * `explains` while it matches something; a `beeline-wrong` ruling that
   * matches nothing is `retired` — the defect is gone — and any other that
   * matches nothing is `matches-nothing`, which is also how a misspelt one
   * shows itself.
   */
  status: "explains" | "retired" | "matches-nothing";
}

export interface ExportComparison {
  exported: number;
  legacy: number;
  /** The staged pull compared against: its row count and a hash of its rows. */
  reference: { rows: number; fingerprint: string };
  matched: { active: number; settled: number };
  onlyExported: number;
  onlyLegacy: number;
  /** Numbers held more than once on either side, left out of the match. */
  duplicated: number;
  /** Every difference by column, explained or not. */
  columns: ColumnDifference[];
  /** Every difference by kind and outcome, explained or not, in records. */
  kinds: KindGroup[];
  unexplained: { active: number; settled: number; groups: UnexplainedGroup[] };
  explained: { outcome: string; active: number; settled: number }[];
  rulings: RulingResult[];
}

// Columns whose values are a person's name, login, id or a coordinate:
// counted, never quoted, so the report can be pasted anywhere.
const IDENTIFYING = new Set([
  "userId", "userLogin", "firstName", "firstNameInitial", "lastName", "recordedBy", "identifiedBy",
  "decimalLatitude", "decimalLongitude", "locality", "url", "relatedResourceID",
]);

const MONTH_COLUMNS = ["month", "month2"];
const DATE_COLUMNS = ["day", "year", "day2", "year2", "verbatimEventDate", ...MONTH_COLUMNS];
const NAME_COLUMNS = ["genus", "subgenus", "specificEpithet", "scientificName", "genusVolDet", "speciesVolDet"];
const COLLECTOR_COLUMNS = ["recordedBy", "firstName", "lastName", "firstNameInitial"];
const CORRECTABLE_COLUMNS = ["county", "locality", "stateProvince", "country", "samplingProtocol"];
const IDENTIFICATION_COLUMNS = ["family", "genus", "subgenus", "specificEpithet", "scientificName", "taxonRank", "identifiedBy"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");
/** A month the legacy file may spell in Roman numerals, as a number. */
const monthNumber = (x: string) =>
  `CASE upper(trim(${x})) ${ROMAN.map((r, i) => `WHEN '${r}' THEN '${i + 1}'`).join(" ")} ELSE trim(${x}) END`;
/** Roman months inside a Y-M-D date, as numbers: 2022-VI-26 → 2022-6-26. */
const deRoman = (x: string) => ROMAN.reduce((acc, r, i) => `replace(${acc}, '-${r}-', '-${i + 1}-')`, x);
/** The same for a leading month in M/D/Y: VIII/25/2024 → 8/25/2024. */
const deRomanMdy = (x: string) => ROMAN.reduce((acc, r, i) => `regexp_replace(${acc}, '^${r}/', '${i + 1}/')`, x);
/**
 * The date a record's season is judged on: its first collecting day, as the
 * store judges a sample on `date_start` (schema/102), so a trap set in
 * December and emptied in January is December's season. A record whose first
 * day does not parse falls back to its last. `t` is the alias of a table with
 * the template's date columns.
 */
export const seasonDate = (t: string) => `coalesce(
    try_cast(concat(${t}."year", '-', ${monthNumber(`${t}."month"`)}, '-', ${t}."day") AS DATE),
    try_cast(concat(${t}."year2", '-', ${monthNumber(`${t}."month2"`)}, '-', ${t}."day2") AS DATE))`;
const isoDay = (x: string, format: string) => `strftime(try_strptime(${x}, '${format}'), '%Y-%m-%d')`;
/** A date or a date range, as `start/end` in ISO; NULL when it is neither. */
const dateRange = (raw: string) => {
  const x = `trim(${deRomanMdy(`trim(${deRoman(raw)})`)})`;
  const ymd = (s: string) => isoDay(s, "%Y-%m-%d");
  const a = ymd(`split_part(${x}, '/', 1)`);
  const b = ymd(`split_part(${x}, '/', 2)`);
  const mdy = isoDay(x, "%m/%d/%Y");
  return `CASE
    WHEN regexp_full_match(${x}, '\\d{4}-\\d{1,2}-\\d{1,2}') THEN concat(${ymd(x)}, '/', ${ymd(x)})
    WHEN regexp_full_match(${x}, '\\d{4}-\\d{1,2}-\\d{1,2}/\\d{4}-\\d{1,2}-\\d{1,2}') AND ${a} IS NOT NULL AND ${b} IS NOT NULL
      THEN concat(${a}, '/', ${b})
    WHEN regexp_full_match(${x}, '\\d{1,2}/\\d{1,2}/\\d{4}') AND ${mdy} IS NOT NULL THEN concat(${mdy}, '/', ${mdy})
  END`;
};
const squash = (x: string) => `trim(regexp_replace(${x}, '\\s+', ' ', 'g'))`;
// A subgenus is one capitalised word in brackets; anything else bracketed
// (an author and year) is not one.
const withoutSubgenus = (x: string) => `trim(regexp_replace(${x}, '\\s*\\([A-Z][a-z]+\\)', '', 'g'))`;
const subgenusOf = (x: string) => `regexp_extract(${x}, '\\(([A-Z][a-z]+)\\)', 1)`;
// A collector column as its list of names, written any way the legacy entry
// form allowed: the same split as promotion's legacy_name_list.
const collectors = (x: string) =>
  `list_transform(regexp_split_to_array(trim(${x}), '\\s*(\\||/|&|\\b(?i:and)\\b)\\s*'), y -> trim(y))`;

/**
 * The kind of one difference, over columns `column`, `exported` and `legacy`
 * (never NULL: blank is ''). First match wins; the order is VALUE_KINDS'.
 */
export const DIFFERENCE_KIND_SQL = `CASE
  WHEN legacy = '' THEN 'filled'
  WHEN exported = '' THEN 'blanked'
  WHEN ${squash("exported")} = ${squash("legacy")} THEN 'whitespace'
  WHEN lower(${squash("exported")}) = lower(${squash("legacy")}) THEN 'case'
  WHEN try_cast(exported AS DOUBLE) = try_cast(legacy AS DOUBLE) THEN 'number_form'
  WHEN "column" IN (${list(MONTH_COLUMNS)})
       AND try_cast(${monthNumber("exported")} AS INTEGER) = try_cast(${monthNumber("legacy")} AS INTEGER) THEN 'date_form'
  WHEN "column" IN (${list(DATE_COLUMNS)}) AND ${dateRange("exported")} = ${dateRange("legacy")} THEN 'date_form'
  WHEN "column" = 'country' AND length(legacy) = 3 AND length(exported) = 2
       AND upper(left(legacy, 2)) = upper(exported) THEN 'country_code'
  WHEN "column" = 'firstNameInitial' AND replace(exported, '.', '') = replace(legacy, '.', '') THEN 'initial_form'
  WHEN "column" IN (${list(COLLECTOR_COLUMNS)}) AND (
         ${collectors("legacy")} = ${collectors("exported")}
      OR (len(${collectors("legacy")}) = 1 AND list_distinct(${collectors("exported")}) = ${collectors("legacy")})) THEN 'collector_list_form'
  WHEN "column" IN (${list(COLLECTOR_COLUMNS)})
       AND len(${collectors("exported")}) > len(${collectors("legacy")})
       AND list_has_all(${collectors("exported")}, ${collectors("legacy")}) THEN 'collector_added'
  WHEN "column" IN (${list(COLLECTOR_COLUMNS)})
       AND regexp_replace(lower(exported), '[^a-z0-9|]', '', 'g') = regexp_replace(lower(legacy), '[^a-z0-9|]', '', 'g') THEN 'name_spelling'
  WHEN "column" IN (${list(NAME_COLUMNS)}) AND (
         (${withoutSubgenus("exported")} = ${withoutSubgenus("legacy")} AND ${withoutSubgenus("exported")} <> '')
      OR (${subgenusOf("exported")} <> '' AND ${subgenusOf("exported")} = legacy)
      OR (${subgenusOf("legacy")} <> '' AND ${subgenusOf("legacy")} = exported)) THEN 'subgenus_form'
  WHEN "column" = 'scientificName' AND regexp_full_match(legacy, '\\S+\\s+sp\\.\\s*\\d+')
       AND regexp_full_match(exported, concat(regexp_extract(legacy, '^[A-Za-z]+', 0), '( \\([A-Z][a-z]+\\))?')) THEN 'morphospecies'
  WHEN "column" = 'scientificName' AND starts_with(legacy, concat(exported, ' '))
       AND regexp_full_match(substr(legacy, length(exported) + 2), '\\(?[A-Z].*\\d{4}\\)?') THEN 'authorship'
  ELSE 'changed'
END`;

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * Compare the export at `exportPath` against the store's staged
 * legacy_occurrence, and explain what `rulings` explain. Values that could
 * identify a person never appear in the examples for the columns that name
 * one; counts say enough there.
 */
export async function compareLegacyExport(
  conn: DuckDBConnection,
  exportPath: string,
  rulings: readonly Ruling[] = [],
): Promise<ExportComparison> {
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE cmp_export AS
    SELECT * FROM read_csv(${sqlString(exportPath)}, header = true, all_varchar = true, quote = '"', escape = '"')`);
  // Staging keeps the columns load-legacy chose (STAGING_COLUMNS), which
  // predate coordinateSource; a column it lacks is compared as blank.
  const stagedColumns = new Set(
    ((await (await conn.run(`SELECT column_name FROM duckdb_columns() WHERE table_name = 'legacy_occurrence'`)).getRows()) as [string][]).map(
      ([c]) => c,
    ),
  );
  const legacyValue = (c: string) => (stagedColumns.has(c) ? `coalesce(l."${c}", '')` : "''");
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE cmp_pairs AS
    WITH e AS (SELECT * FROM cmp_export WHERE "fieldNumber" IN (
               SELECT "fieldNumber" FROM cmp_export GROUP BY 1 HAVING count(*) = 1)),
         l AS (SELECT * FROM legacy_occurrence WHERE "fieldNumber" IN (
               SELECT "fieldNumber" FROM legacy_occurrence WHERE nullif("fieldNumber", '') IS NOT NULL
               GROUP BY 1 HAVING count(*) = 1))
    SELECT ${LEGACY_EXPORT_COLUMNS.map((c) => `coalesce(e."${c}", '') AS "e_${c}", ${legacyValue(c)} AS "l_${c}"`).join(", ")},
           ${seasonDate("e")} >= (SELECT active_since FROM season) AS active_season
    FROM e JOIN l ON l."fieldNumber" = e."fieldNumber"`);
  const one = async (sql: string) => Number(((await (await conn.run(sql)).getRows()) as [[bigint]])[0]![0]);
  const exported = await one("SELECT count(*) FROM cmp_export");
  const legacy = await one("SELECT count(*) FROM legacy_occurrence");
  const active = await one("SELECT count(*) FROM cmp_pairs WHERE active_season");
  const settled = await one("SELECT count(*) FROM cmp_pairs WHERE NOT coalesce(active_season, false)");
  const onlyExported = await one(`SELECT count(*) FROM cmp_export e WHERE NOT EXISTS
                                    (SELECT 1 FROM legacy_occurrence l WHERE l."fieldNumber" = e."fieldNumber")`);
  const onlyLegacy = await one(`SELECT count(*) FROM legacy_occurrence l WHERE nullif(l."fieldNumber", '') IS NOT NULL
                                  AND NOT EXISTS (SELECT 1 FROM cmp_export e WHERE e."fieldNumber" = l."fieldNumber")`);
  const duplicated = await one(`SELECT count(*) FROM (
      SELECT "fieldNumber" FROM cmp_export GROUP BY 1 HAVING count(*) > 1
      UNION SELECT "fieldNumber" FROM legacy_occurrence WHERE nullif("fieldNumber", '') IS NOT NULL
      GROUP BY 1 HAVING count(*) > 1)`);
  const [[fingerprint]] = (await (await conn.run(
    `SELECT coalesce(md5(string_agg(md5(CAST(l AS VARCHAR)), '' ORDER BY l._id)), '') FROM legacy_occurrence l`,
  )).getRows()) as [[string]];

  await buildDifferences(conn);
  await attribute(conn, rulings);

  const columns: ColumnDifference[] = [];
  for (const c of LEGACY_EXPORT_COLUMNS) {
    const [[o, s]] = (await (await conn.run(`
      SELECT count(*) FILTER (WHERE active_season), count(*) FILTER (WHERE NOT active_season)
      FROM cmp_attributed WHERE "column" = ${sqlString(c)}`)).getRows()) as [[bigint, bigint]];
    if (Number(o) + Number(s) === 0) continue;
    const where = `"column" = ${sqlString(c)}`;
    columns.push({ column: c, active: Number(o), settled: Number(s), examples: await examples(conn, where, c), fieldNumbers: await fieldNumbers(conn, where) });
  }
  columns.sort((a, b) => b.active + b.settled - (a.active + a.settled) || a.column.localeCompare(b.column));

  const groupRows = (await (await conn.run(`
    SELECT "column", kind, count(*) FILTER (WHERE active_season), count(*) FILTER (WHERE NOT active_season)
    FROM cmp_attributed WHERE ruling_id IS NULL GROUP BY 1, 2`)).getRows()) as [string, string, bigint, bigint][];
  const groups: UnexplainedGroup[] = [];
  for (const [column, kind, o, s] of groupRows) {
    const where = `ruling_id IS NULL AND "column" = ${sqlString(column)} AND kind = ${sqlString(kind)}`;
    groups.push({ column, kind, active: Number(o), settled: Number(s), examples: await examples(conn, where, column), fieldNumbers: await fieldNumbers(conn, where) });
  }
  groups.sort((a, b) => b.active - a.active || b.settled - a.settled || a.column.localeCompare(b.column) || a.kind.localeCompare(b.kind));

  // By kind and outcome, in records: the outcome is the ruling's, so it is
  // joined in from a table of the rulings rather than carried per difference.
  await conn.run(`CREATE OR REPLACE TEMP TABLE cmp_outcome (ruling_id INTEGER, outcome TEXT)`);
  if (rulings.length > 0) {
    await conn.run(`INSERT INTO cmp_outcome VALUES ${rulings.map((r, i) => `(${i}, ${sqlString(r.outcome)})`).join(", ")}`);
  }
  await conn.run(`
    CREATE OR REPLACE TEMP VIEW cmp_kinded AS
    SELECT a.*, coalesce(o.outcome, 'unexplained') AS outcome
    FROM cmp_attributed a LEFT JOIN cmp_outcome o ON o.ruling_id = a.ruling_id`);
  const kindRows = (await (await conn.run(`
    WITH per_column AS (SELECT kind, outcome, "column", count(*) AS n FROM cmp_kinded GROUP BY ALL)
    SELECT k.kind, k.outcome,
           count(DISTINCT k.field_number) FILTER (WHERE k.active_season), count(DISTINCT k.field_number) FILTER (WHERE NOT k.active_season),
           (SELECT string_agg(c."column", ',' ORDER BY c.n DESC, c."column") FROM per_column c WHERE c.kind = k.kind AND c.outcome = k.outcome)
    FROM cmp_kinded k GROUP BY 1, 2`)).getRows()) as [string, string, bigint, bigint, string][];
  const kinds: KindGroup[] = [];
  for (const [kind, outcome, o, s, colList] of kindRows) {
    const cols = colList.split(",");
    const where = `kind = ${sqlString(kind)} AND outcome = ${sqlString(outcome)}`;
    const quotable = cols.filter((c) => !IDENTIFYING.has(c) && c !== RECORD_COLUMN);
    const exampleRows = quotable.length === 0 ? [] : (await (await conn.run(`
      SELECT "column", exported, legacy, count(*), min(field_number) FROM cmp_kinded
      WHERE ${where} AND "column" IN (${list(quotable)})
      GROUP BY 1, 2, 3 ORDER BY 4 DESC, 1, 2, 3 LIMIT 3`)).getRows()) as [string, string, string, bigint, string][];
    kinds.push({
      kind, outcome, columns: cols, active: Number(o), settled: Number(s),
      examples: exampleRows.map(([column, exported, legacy, n, fieldNumber]) => ({ column, exported, legacy, n: Number(n), fieldNumber })),
      fieldNumbers: await fieldNumbers(conn, where, "cmp_kinded"),
    });
  }
  const outcomeOrder = (x: string) => (x === "unexplained" ? -1 : OUTCOMES.indexOf(x as (typeof OUTCOMES)[number]));
  kinds.sort((a, b) => outcomeOrder(a.outcome) - outcomeOrder(b.outcome) || b.active + b.settled - (a.active + a.settled) || a.kind.localeCompare(b.kind));

  const perRuling = new Map(
    ((await (await conn.run(`
      SELECT ruling_id, count(*) FILTER (WHERE active_season), count(*) FILTER (WHERE NOT active_season)
      FROM cmp_attributed WHERE ruling_id IS NOT NULL GROUP BY 1`)).getRows()) as [number, bigint, bigint][]).map(
      ([id, o, s]) => [Number(id), { active: Number(o), settled: Number(s) }],
    ),
  );
  const results: RulingResult[] = rulings.map((ruling, i) => {
    const n = perRuling.get(i) ?? { active: 0, settled: 0 };
    const status = n.active + n.settled > 0 ? "explains" : ruling.outcome === "beeline-wrong" ? "retired" : "matches-nothing";
    return { ruling, ...n, status };
  });
  const explained = OUTCOMES.map((outcome) => {
    const mine = results.filter((r) => r.ruling.outcome === outcome);
    return { outcome, active: mine.reduce((t, r) => t + r.active, 0), settled: mine.reduce((t, r) => t + r.settled, 0) };
  }).filter((x) => x.active + x.settled > 0);

  return {
    exported,
    legacy,
    reference: { rows: legacy, fingerprint },
    matched: { active, settled },
    onlyExported,
    onlyLegacy,
    duplicated,
    columns,
    kinds,
    unexplained: {
      active: groups.reduce((t, g) => t + g.active, 0),
      settled: groups.reduce((t, g) => t + g.settled, 0),
      groups,
    },
    explained,
    rulings: results,
  };
}

/**
 * cmp_difference: one row per difference — a matched record's column that
 * differs, or a record only one side holds — with its kind and season.
 */
/** The legacy place columns, as promotion names them in a within_sample_disagreement finding. */
const PLACE_FINDING_FIELD: Record<string, string> = {
  country: "country",
  stateProvince: "state_province",
  county: "county",
  locality: "locality",
  samplingProtocol: "protocol",
};

/**
 * What the store knows about a difference that its two values cannot say
 * (Peter, 2026-10-04), so one ruling covers the case for good rather than a
 * list of field numbers every new pull adds to:
 *   collector_alias      the legacy collector, spelled as ingest/collector-aliases.csv
 *                        corrects it, is who Beeline wrote — and the record's name
 *                        parts differ for the same reason
 *   taxon_alias          the legacy genus or epithet is a misspelling
 *                        ingest/taxon-aliases.csv corrects to what Beeline wrote
 *   subgenus_form        (also from the values alone) a genus column holding only
 *                        '(Peponapis)', exported as the genus the tree files it under
 *   staff_correction     the legacy row as staff corrected it says what Beeline wrote
 *   collector_order_contradicted  a record whose recordedBy and name columns
 *                        list its pair in opposite orders
 *   initial_from_surname an initial the legacy record took from the family name
 *   label_name           the initials a label name gives, or the derived one beside it
 *   newer_determination  the specimen's newest expert determination came from
 *                        Ecdysis or Beeline, so the legacy system never received it
 *   one_day_range        an end the legacy record wrote on its start day, blank here
 *   standin_replaced     the legacy point was a stand-in for an obscured observation's
 *                        true point, which Beeline holds instead (beeline-b34)
 *   login_renamed        both sides carry the same iNaturalist user id
 *   sample_disagreement  promotion found the legacy rows of this specimen's sample
 *                        disagreeing about this field, and the sample keeps one value
 */
async function kindFromStore(conn: DuckDBConnection): Promise<void> {
  const fold = (x: string) => `regexp_replace(lower(${x}), '[^a-z0-9]', '', 'g')`;
  if ((await one(conn, `SELECT count(*) FROM duckdb_tables() WHERE table_name = 'legacy_collector_alias'`)) > 0) {
    await conn.run(`
      UPDATE cmp_value_difference d SET kind = 'collector_alias'
      FROM (
        SELECT p.field_number, string_agg(coalesce(a.person, p.part), ' | ' ORDER BY p.idx) AS corrected
        FROM (SELECT field_number, unnest(string_split(legacy, ' | ')) AS part, generate_subscripts(string_split(legacy, ' | '), 1) AS idx
              FROM cmp_value_difference WHERE "column" = 'recordedBy') p
        LEFT JOIN legacy_collector_alias a ON ${fold("a.alias")} = ${fold("p.part")}
        GROUP BY p.field_number
      ) m
      WHERE d.field_number = m.field_number AND d."column" = 'recordedBy' AND m.corrected = d.exported`);
    // A record's name parts differ for the alias's reason only where they
    // spell the very name the alias corrects — 'Brendon' and 'McGarry' of
    // 'Brendon McGarry' — and its initials follow from those first names.
    // A part that is wrong some other way stays what it is (CodeRabbit on #130).
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE cmp_name_parts AS
      SELECT field_number,
             ${fold("string_agg(concat(f, l), '' ORDER BY i)")} = ${fold("any_value(recorded_by)")} AS spelled,
             string_agg(concat(upper(left(f, 1)), '.'), ' | ' ORDER BY i) = any_value(initials) AS initials_follow
      FROM (
        SELECT p."e_fieldNumber" AS field_number, p."l_recordedBy" AS recorded_by, p."l_firstNameInitial" AS initials,
               unnest(string_split(p."l_firstName", ' | ')) AS f, unnest(string_split(p."l_lastName", ' | ')) AS l,
               generate_subscripts(string_split(p."l_firstName", ' | '), 1) AS i
        FROM cmp_pairs p
        WHERE p."e_fieldNumber" IN (SELECT field_number FROM cmp_value_difference WHERE "column" = 'recordedBy' AND kind = 'collector_alias'))
      GROUP BY field_number`);
    await conn.run(`
      UPDATE cmp_value_difference d SET kind = 'collector_alias'
      FROM cmp_name_parts n
      WHERE n.field_number = d.field_number AND n.spelled
        AND (d."column" IN ('firstName', 'lastName') OR (d."column" = 'firstNameInitial' AND n.initials_follow))`);
  }
  // A genus spelled as an alias's written form and exported as its name; an
  // epithet the same, read with the record's genus beside it, since a species
  // alias names both (ingest/parse-names.sql).
  if ((await one(conn, `SELECT count(*) FROM duckdb_tables() WHERE table_name = 'legacy_taxon_alias'`)) > 0) {
    await conn.run(`
      UPDATE cmp_value_difference d SET kind = 'taxon_alias'
      WHERE d.kind = 'changed' AND d."column" IN ('genus', 'genusVolDet')
        AND EXISTS (SELECT 1 FROM legacy_taxon_alias a
                    WHERE a.rank = 'genus' AND a.alias = trim(d.legacy) AND a.name = d.exported)`);
    await conn.run(`
      UPDATE cmp_value_difference d SET kind = 'taxon_alias'
      FROM cmp_pairs p, legacy_taxon_alias a
      WHERE d.kind = 'changed' AND d."column" IN ('specificEpithet', 'speciesVolDet')
        AND p."e_fieldNumber" = d.field_number AND a.rank = 'species'
        AND a.alias = concat_ws(' ', trim(CASE d."column" WHEN 'specificEpithet' THEN p."l_genus" ELSE p."l_genusVolDet" END), trim(d.legacy))
        AND a.name = concat_ws(' ', CASE d."column" WHEN 'specificEpithet' THEN p."e_genus" ELSE p."e_genusVolDet" END, d.exported)`);
  }
  // A genus column holding only a bracketed subgenus, '(Peponapis)', which
  // promotion files under the genus the tree holds it in: the same form as
  // 'Xenoglossa (Peponapis)', missing the half the values alone would show.
  await conn.run(`
    UPDATE cmp_value_difference d SET kind = 'subgenus_form'
    WHERE d.kind = 'changed' AND d."column" IN ('genus', 'genusVolDet')
      AND regexp_full_match(trim(d.legacy), '\\([A-Z][a-z]+\\)')
      AND EXISTS (SELECT 1 FROM animal a
                  WHERE a.rank = 'subgenus' AND a.scientific_name = concat(d.exported, ' ', trim(d.legacy)))`);
  // An end the legacy record wrote on the day it started, which Beeline,
  // writing an end only for a range, leaves blank with its day of the year.
  await conn.run(`
    UPDATE cmp_value_difference d SET kind = 'one_day_range'
    WHERE d.kind = 'blanked' AND d."column" IN ('day2', 'month2', 'year2', 'startDayofYear', 'endDayofYear')
      AND EXISTS (SELECT 1 FROM cmp_pairs p
                  WHERE p."e_fieldNumber" = d.field_number AND p."l_year2" = p."l_year"
                    AND p."l_month2" = p."l_month" AND p."l_day2" = p."l_day")`);
  // A staff correction (ADR 0004): the legacy row as corrected says what
  // Beeline wrote, and the row as staged does not.
  if ((await one(conn, `SELECT count(*) FROM duckdb_views() WHERE view_name = 'legacy_occurrence_corrected'`)) > 0) {
    await conn.run(`
      UPDATE cmp_value_difference d SET kind = 'staff_correction'
      WHERE d."column" IN (${list(CORRECTABLE_COLUMNS)})
        AND EXISTS (
          SELECT 1 FROM legacy_occurrence o JOIN legacy_occurrence_corrected c ON c._id = o._id
          WHERE o."fieldNumber" = d.field_number
            AND (${CORRECTABLE_COLUMNS.map((c) => `(d."column" = ${sqlString(c)} AND c."${c}" = d.exported AND c."${c}" IS DISTINCT FROM o."${c}")`).join("\n              OR ")}))`);
  }
  // A legacy record that contradicts itself about its pair's order: its name
  // columns list them in the order Beeline wrote and its recordedBy in the
  // other ("B | A" beside "A | B"), so no order matches it.
  await conn.run(`
    UPDATE cmp_value_difference d SET kind = 'collector_order_contradicted'
    WHERE d.kind = 'changed' AND d."column" = 'recordedBy'
      AND list_sort(${collectors("d.exported")}) = list_sort(${collectors("d.legacy")})
      AND EXISTS (SELECT 1 FROM cmp_pairs p
                  WHERE p."e_fieldNumber" = d.field_number AND len(${collectors('p."e_firstName"')}) > 1
                    AND ${collectors('p."l_firstName"')} = ${collectors('p."e_firstName"')}
                    -- and the family names agree, written once for both where they share it
                    AND (${collectors('p."l_lastName"')} = ${collectors('p."e_lastName"')}
                         OR (len(${collectors('p."l_lastName"')}) = 1
                             AND list_distinct(${collectors('p."e_lastName"')}) = ${collectors('p."l_lastName"')})))`);
  // An initial the legacy record took from the family name: T. for an A.
  await conn.run(`
    UPDATE cmp_value_difference d SET kind = 'initial_from_surname'
    WHERE d.kind = 'changed' AND d."column" = 'firstNameInitial'
      AND EXISTS (SELECT 1 FROM cmp_pairs p
                  WHERE p."e_fieldNumber" = d.field_number
                    AND p."l_firstNameInitial" = concat(upper(left(trim(p."l_lastName"), 1)), '.')
                    AND p."l_firstNameInitial" <> concat(upper(left(trim(p."l_firstName"), 1)), '.')
                    AND d.exported = concat(upper(left(trim(p."e_firstName"), 1)), '.'))`);
  // The initials a person's label name gives (J.M. of a label name in that
  // form), or the derived one beside a label name printed as written (AC).
  await conn.run(`
    UPDATE cmp_value_difference d SET kind = 'label_name'
    WHERE d.kind IN ('changed', 'collector_alias') AND d."column" = 'firstNameInitial'
      AND EXISTS (SELECT 1 FROM specimen sp
                  JOIN sample_primary_collector pc ON pc.sample_id = sp.sample_id
                  JOIN person p ON p.entity_id = pc.person_id
                  WHERE sp.field_number = d.field_number AND nullif(trim(p.label_name), '') IS NOT NULL
                    AND (
                      -- The initials the label name gives: J.M. of 'J.M. Family'.
                      (nullif(regexp_extract(trim(p.label_name), '^((?:\\p{Lu}\\.)+) ', 1), '') = d.exported)
                      -- Or a label name printed as written, whose initials the legacy
                      -- record kept whole (AC of 'AC Family') beside the derived one.
                      OR (d.exported = concat(upper(left(trim(p.given_name), 1)), '.')
                          AND d.legacy = split_part(trim(p.label_name), ' ', 1))))`);
  // An identification the legacy system never received: the specimen's
  // newest expert determination came from Ecdysis or was made in Beeline.
  await conn.run(`
    UPDATE cmp_value_difference d SET kind = 'newer_determination'
    WHERE d."column" IN (${list(IDENTIFICATION_COLUMNS)})
      AND EXISTS (
        SELECT 1 FROM specimen sp
        JOIN (SELECT specimen_id, arg_max(channel, (recorded_at, entity_id)) AS channel
              FROM determination WHERE is_expert GROUP BY specimen_id) e ON e.specimen_id = sp.entity_id
        WHERE sp.field_number = d.field_number AND e.channel <> 'legacy_import')`);
  // A stand-in point the legacy record printed, which promotion replaced with
  // the observation's true point (sample_location_standin, beeline-b34): the
  // point, its uncertainty and source, and the elevation read at the
  // stand-in, which is blank until derived again at the true point and
  // different after. A row's point counts as a stand-in where it is 100 m or
  // more from the sample's, as the view's own test is; the elevation goes for
  // every row of a sample that had one, since a corrected sample's rows that
  // already held the true point lost the elevation with the rest.
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE cmp_standin_row AS
    SELECT p."e_fieldNumber" AS field_number, s.entity_id AS sample_id
    FROM cmp_pairs p
    JOIN specimen sp ON sp.field_number = p."e_fieldNumber"
    JOIN sample s ON s.entity_id = sp.sample_id
    JOIN sample_location l ON l.sample_id = s.entity_id
    JOIN observation_field f ON f.inat_id = s.inat_observation_id
    WHERE l.source = 'inat_trusted'
      AND (nullif(f.geoprivacy, 'open') IS NOT NULL OR nullif(f.taxon_geoprivacy, 'open') IS NOT NULL)
      AND 111195 * sqrt(power(try_cast(p."l_decimalLatitude" AS DOUBLE) - l.latitude, 2)
          + power((try_cast(p."l_decimalLongitude" AS DOUBLE) - l.longitude) * cos(radians(l.latitude)), 2)) >= 100`);
  await conn.run(`
    UPDATE cmp_value_difference d SET kind = 'standin_replaced'
    WHERE (d."column" IN ('decimalLatitude', 'decimalLongitude', 'coordinateUncertaintyInMeters', 'coordinateSource')
           AND d.field_number IN (SELECT field_number FROM cmp_standin_row))
       OR (d."column" = 'verbatimElevation'
           AND EXISTS (SELECT 1 FROM specimen sp JOIN cmp_standin_row r ON r.sample_id = sp.sample_id
                       WHERE sp.field_number = d.field_number))`);
  await conn.run(`
    UPDATE cmp_value_difference d SET kind = 'login_renamed'
    WHERE d."column" = 'userLogin' AND d.kind = 'changed'
      AND EXISTS (SELECT 1 FROM cmp_pairs p
                  WHERE p."e_fieldNumber" = d.field_number AND p."e_userId" <> '' AND p."e_userId" = p."l_userId")`);
  // Only where Beeline wrote one of the values the merged rows disagreed
  // between: a value from anywhere else, a staff correction say, is not the
  // merge's doing (CodeRabbit on #130). promote-legacy.sql writes the finding
  // as '<field>: <value> | <value>', values sorted and blanks left out.
  const field = `CASE d."column" ${Object.entries(PLACE_FINDING_FIELD)
    .map(([c, f]) => `WHEN ${sqlString(c)} THEN ${sqlString(f)}`)
    .join(" ")} END`;
  await conn.run(`
    UPDATE cmp_value_difference d SET kind = 'sample_disagreement'
    WHERE d.kind IN ('changed', 'filled', 'blanked')
      AND d."column" IN (${Object.keys(PLACE_FINDING_FIELD).map(sqlString).join(", ")})
      AND EXISTS (
        SELECT 1 FROM specimen sp JOIN sample_promotion_finding f ON f.sample_id = sp.sample_id
        WHERE sp.field_number = d.field_number AND f.rule_name = 'within_sample_disagreement'
          AND starts_with(f.details, concat(${field}, ': '))
          AND list_contains(string_split(substr(f.details, length(${field}) + 3), ' | '), d.exported))`);
}

async function buildDifferences(conn: DuckDBConnection): Promise<void> {
  const perColumn = LEGACY_EXPORT_COLUMNS.map(
    (c) => `SELECT "e_fieldNumber" AS field_number, ${sqlString(c)} AS "column", "e_${c}" AS exported, "l_${c}" AS legacy,
                   coalesce(active_season, false) AS active_season
            FROM cmp_pairs WHERE "e_${c}" <> "l_${c}"`,
  ).join("\nUNION ALL\n");
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE cmp_value_difference AS
    SELECT field_number, "column", exported, legacy, active_season, ${DIFFERENCE_KIND_SQL} AS kind
    FROM (${perColumn})`);
  await kindFromStore(conn);

  // Why a staged record has no exported counterpart: the blocking finding
  // that kept it from promotion, where the store has promoted at all.
  const promoted = await one(conn, `SELECT count(*) FROM duckdb_views() WHERE view_name = 'legacy_promotion_finding'`);
  const activeSince = `(SELECT active_since FROM season)`;
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE cmp_only_legacy AS
    SELECT l._id, l."fieldNumber" AS field_number, coalesce(${seasonDate("l")} >= ${activeSince}, false) AS active_season
    FROM legacy_occurrence l
    WHERE nullif(l."fieldNumber", '') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM cmp_export e WHERE e."fieldNumber" = l."fieldNumber")`);
  const why = promoted > 0
    ? `coalesce((SELECT min(f.rule) FROM legacy_promotion_finding f
                 WHERE f._id = o._id AND f.severity = 'blocking'), 'not_exported')`
    : `'not_exported'`;
  const minted = await one(conn, `SELECT count(*) FROM duckdb_tables() WHERE table_name = 'minted_field_number'`);
  const mintedKind = minted > 0
    ? `CASE WHEN EXISTS (SELECT 1 FROM minted_field_number m WHERE m.field_number = e."fieldNumber")
            THEN 'minted_by_beeline' ELSE 'not_in_legacy' END`
    : `'not_in_legacy'`;
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE cmp_difference AS
    SELECT row_number() OVER (ORDER BY field_number, "column") AS difference_id, * FROM (
      SELECT field_number, "column", exported, legacy, active_season, kind FROM cmp_value_difference
      UNION ALL
      SELECT o.field_number, '${RECORD_COLUMN}', '', 'present', o.active_season, ${why}
      FROM cmp_only_legacy o
      UNION ALL
      SELECT e."fieldNumber", '${RECORD_COLUMN}', 'present', '',
             coalesce(${seasonDate("e")} >= ${activeSince}, false),
             ${mintedKind}
      FROM cmp_export e
      WHERE nullif(e."fieldNumber", '') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM legacy_occurrence l WHERE l."fieldNumber" = e."fieldNumber"))`);
}

/**
 * cmp_attributed: each difference with the ruling that explains it, or NULL.
 * The most specific matching ruling wins — a field number over a whole
 * column, a kind over every kind — and since a ruling's (field number,
 * column, kind) is unique, at most one ruling is that specific.
 */
async function attribute(conn: DuckDBConnection, rulings: readonly Ruling[]): Promise<void> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE cmp_ruling (ruling_id INTEGER, field_number TEXT, "column" TEXT, kind TEXT)`);
  if (rulings.length > 0) {
    await conn.run(`INSERT INTO cmp_ruling VALUES ${rulings
      .map((r, i) => `(${i}, ${sqlString(r.field_number)}, ${sqlString(r.column)}, ${sqlString(r.kind)})`)
      .join(", ")}`);
  }
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE cmp_attributed AS
    SELECT * EXCLUDE (pick) FROM (
      SELECT d.*, r.ruling_id,
             row_number() OVER (PARTITION BY d.difference_id
                                ORDER BY (r.field_number <> '') DESC, (r.kind <> '') DESC) AS pick
      FROM cmp_difference d
      LEFT JOIN cmp_ruling r
        ON r."column" = d."column"
       AND (r.kind = '' OR r.kind = d.kind)
       AND (r.field_number = '' OR r.field_number = d.field_number))
    WHERE pick = 1`);
}

async function one(conn: DuckDBConnection, sql: string): Promise<number> {
  return Number(((await (await conn.run(sql)).getRows()) as [[bigint]])[0]![0]);
}

/** The commonest (exported, legacy) pairs among differences `where` selects, unless the column names a person or a place. */
async function examples(conn: DuckDBConnection, where: string, column: string): Promise<Example[]> {
  if (IDENTIFYING.has(column)) return [];
  const rows = (await (await conn.run(`
    SELECT exported, legacy, count(*), min(field_number) FROM cmp_attributed WHERE ${where}
    GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2 LIMIT 3`)).getRows()) as [string, string, bigint, string][];
  return rows.map(([exported, legacy, n, fieldNumber]) => ({ exported, legacy, n: Number(n), fieldNumber }));
}

/** The lowest three field numbers among differences `where` selects: records to look at where no value may be quoted. */
async function fieldNumbers(conn: DuckDBConnection, where: string, from = "cmp_attributed"): Promise<string[]> {
  const rows = (await (await conn.run(`
    SELECT DISTINCT field_number FROM ${from} WHERE ${where} ORDER BY 1 LIMIT 3`)).getRows()) as [string][];
  return rows.map(([n]) => n);
}

/**
 * Every difference, one row each, with the ruling that explains it where
 * one does: the file to audit the comparison from. It names people and
 * places, so it belongs under data/, which git ignores.
 */
export async function writeDifferences(conn: DuckDBConnection, rulings: readonly Ruling[], path: string): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  await conn.run(`CREATE OR REPLACE TEMP TABLE cmp_ruling_text (ruling_id INTEGER, outcome TEXT, reason TEXT, source TEXT)`);
  if (rulings.length > 0) {
    await conn.run(`INSERT INTO cmp_ruling_text VALUES ${rulings
      .map((r, i) => `(${i}, ${sqlString(r.outcome)}, ${sqlString(r.reason)}, ${sqlString(r.source)})`)
      .join(", ")}`);
  }
  await conn.run(`
    COPY (
      SELECT a.field_number, a."column", a.kind,
             CASE WHEN a.active_season THEN 'active' ELSE 'settled' END AS season,
             a.exported, a.legacy,
             coalesce(t.outcome, '') AS outcome, coalesce(t.reason, '') AS reason, coalesce(t.source, '') AS source
      FROM cmp_attributed a LEFT JOIN cmp_ruling_text t ON t.ruling_id = a.ruling_id
      ORDER BY a.field_number, a."column"
    ) TO ${sqlString(path)} (HEADER, DELIMITER ',')`);
  return one(conn, "SELECT count(*) FROM cmp_attributed");
}

export const DEFAULT_RULINGS = "ingest/legacy-export-rulings.csv";
export const DEFAULT_DIFFERENCES = "data/exports/legacy-export-differences.csv";

// CLI: pnpm legacy:compare-export [db] [export.csv] [--rulings path] [--differences path]
// With no export path, writes a fresh export to data/exports/ first.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    if (i === -1) return fallback;
    const v = args[i + 1];
    if (v === undefined) throw new Error(`${name} needs a path`);
    args.splice(i, 2);
    return v;
  };
  const rulingsPath = flag("--rulings", DEFAULT_RULINGS);
  const differencesPath = flag("--differences", DEFAULT_DIFFERENCES);
  const dbPath = args[0] ?? process.env.BEELINE_DB ?? "beeline.duckdb";
  const rulings = await readRulings(rulingsPath);
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  let exportPath = args[1];
  if (exportPath === undefined) {
    // Inside data/, which git ignores: the file is every collector's name and
    // true coordinates, and the repository is public (Fable's review of #110).
    exportPath = "data/exports/compare-legacy-export.csv";
    const { rows } = await writeLegacyExport(conn, exportPath);
    console.error(`wrote ${rows} rows to ${exportPath}`);
  }
  const r = await compareLegacyExport(conn, exportPath, rulings);
  const written = await writeDifferences(conn, rulings, differencesPath);
  conn.closeSync();
  const pair = (o: number, s: number) => `${String(o).padStart(7)} / ${String(s).padStart(7)}`;
  // Examples as exported ← legacy, each with a record it occurs on; where no
  // value may be quoted, a few records to look at instead.
  const eg = (d: { examples: Example[]; fieldNumbers: string[] }) =>
    d.examples.length > 0
      ? d.examples.map((e) => `'${e.exported}' ← '${e.legacy}' ×${e.n} (e.g. ${e.fieldNumber})`).join("; ")
      : `e.g. ${d.fieldNumbers.join(", ")}`;
  const egKind = (k: KindGroup) =>
    k.examples.length > 0
      ? k.examples.map((e) => `${e.column}: '${e.exported}' ← '${e.legacy}' ×${e.n} (e.g. ${e.fieldNumber})`).join("; ")
      : `e.g. ${k.fieldNumbers.join(", ")}`;
  const cols = (k: KindGroup) => (k.columns.length > 4 ? `${k.columns.slice(0, 4).join(", ")} +${k.columns.length - 4} more` : k.columns.join(", "));

  console.log(`legacy staging compared against: ${r.reference.rows} rows, fingerprint ${r.reference.fingerprint}`);
  console.log(`exported ${r.exported} rows; matched on fieldNumber: ${r.matched.active} active, ${r.matched.settled} settled`);
  console.log(`only in the export: ${r.onlyExported}; only in legacy: ${r.onlyLegacy}; numbers held twice, left out: ${r.duplicated}`);

  console.log(`\nunexplained (active / settled): ${pair(r.unexplained.active, r.unexplained.settled)}`);
  for (const g of r.unexplained.groups) {
    console.log(`  ${g.column.padEnd(30)} ${g.kind.padEnd(20)} ${pair(g.active, g.settled)}  ${eg(g)}`);
  }

  console.log("\nevery kind of difference, in records (active / settled), the columns it touches, and examples as column: exported ← legacy:");
  for (const k of r.kinds) {
    console.log(`  ${k.kind.padEnd(30)} ${k.outcome.padEnd(16)} ${pair(k.active, k.settled)}  ${cols(k)}`);
    console.log(`  ${"".padEnd(30)} ${"".padEnd(16)} ${"".padEnd(17)}  ${egKind(k)}`);
  }

  const bugs = r.rulings.filter((x) => x.ruling.outcome === "beeline-wrong" && x.status === "explains");
  if (bugs.length > 0) {
    console.log("\nknown Beeline defects, still present (active / settled):");
    for (const b of bugs) console.log(`  ${describe(b.ruling).padEnd(52)} ${pair(b.active, b.settled)}  ${b.ruling.source}`);
  }
  const idle = r.rulings.filter((x) => x.status !== "explains");
  if (idle.length > 0) {
    console.log("\nrulings that match nothing now:");
    for (const x of idle) console.log(`  ${describe(x.ruling).padEnd(52)} ${x.status === "retired" ? "retired: the defect is gone" : "matches nothing"}`);
  }
  console.log("\nexplained, by outcome (active / settled):");
  for (const x of r.explained) console.log(`  ${x.outcome.padEnd(30)} ${pair(x.active, x.settled)}`);

  console.log("\nevery difference by column, explained or not (active / settled), commonest pairs as exported ← legacy:");
  for (const c of r.columns) console.log(`  ${c.column.padEnd(30)} ${pair(c.active, c.settled)}  ${eg(c)}`);
  console.error(`\n${written} differences, with the rulings that explain them, written to ${differencesPath}`);
}

function describe(r: Ruling): string {
  return [r.column, r.kind || "any kind", r.field_number ? `#${r.field_number}` : ""].filter(Boolean).join(" ");
}
