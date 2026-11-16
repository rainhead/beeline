import type { DuckDBConnection } from "@duckdb/node-api";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { compareLegacyExport, DEFAULT_RULINGS, dropComparisonTables } from "./compare-legacy-export.js";
import { openDuckDb } from "./db.js";
import { legacyExportPath, writeLegacyExport } from "./legacy-export.js";
import { readRulings, type Ruling } from "./legacy-export-rulings.js";

/**
 * What new Beeline did to old Beeline's records, in a taxonomist's words
 * (beeline-eznn): for Lincoln Best, who kept his own list of corrections to
 * the old records, never applied before cutover, so that the three-way merge
 * of the old records, new Beeline and his list starts from a ledger he can
 * read (Peter, 2026-11-15).
 *
 * The ledger is the old-versus-new comparison (src/compare-legacy-export.ts):
 * every value of the legacy-format export that differs from the old record
 * it came from, each given a kind and explained by a ruling
 * (ingest/legacy-export-rulings.csv). This module sorts those differences
 * into lines that each say one thing new Beeline did, under a few headings,
 * by their kind and the column they are in. The first line that matches
 * wins, and a test holds the lines to never overlapping and to covering every
 * kind the comparison gives; a difference no ruling explains is a line of its
 * own whatever its kind, and one no line describes falls to `other`, so
 * nothing is left off the page.
 *
 * The `legacy-changes` job runs it each night after the export and writes
 * `summary.json` and one CSV per line into `<exportsDir>/changes/`,
 * which /exports/changes reads: the comparison takes a minute and a half
 * and most of a gigabyte, far too much for a page request.
 *
 * The words live here rather than in the message catalog because the page
 * and the CSVs both say them and they must change with the mapping; admin
 * pages are English-only (Peter, 2026-08-22).
 */

/** The template's columns that name the bee, as the expert identified it. */
const IDENTIFICATION = ["family", "genus", "subgenus", "specificEpithet", "scientificName", "taxonRank", "identifiedBy"];
const SEX_CASTE = ["sex", "caste"];
/** Every column that holds a name, the expert's or the volunteer's. */
const NAMES = ["order", "family", "genus", "subgenus", "specificEpithet", "scientificName", "taxonRank", "familyVolDet", "genusVolDet", "speciesVolDet"];
const CLASSIFICATION = ["phylum", "class", "order", "family", "taxonRank", "scientificName"];
const COLLECTOR = ["recordedBy", "firstName", "lastName"];
const ACCOUNT = ["userLogin", "userId"];
const PLACE = [
  "decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters", "coordinateSource", "verbatimElevation",
  "county", "locality", "geoprivacy", "taxon_geoprivacy", "url",
];
const DAY_OF_YEAR = ["startDayofYear", "endDayofYear"];
/** Why promotion held a record back (ingest/promote-legacy.sql), as the comparison kinds a record old Beeline alone holds. */
const HELD_BACK = ["bad_date", "bad_specimen_number", "missing_sample_number", "missing_person", "duplicate_specimen", "not_exported"];

export const CATEGORIES = [
  {
    id: "identifications",
    title: "Identifications",
    intro: "Where the identification of a specimen is not old Beeline's, and why.",
  },
  {
    id: "gaps",
    title: "What new Beeline cannot hold yet",
    intro: "What old Beeline said that new Beeline does not say, because it has nowhere to keep it yet or a newer identification left it out. These are the ones for taxonomists to look at.",
  },
  {
    id: "names",
    title: "Names written in a standard form",
    intro: "The same identification, written as zoological names are written, and filled out from the name.",
  },
  {
    id: "specimens",
    title: "Specimens and their records",
    intro: "Where one of old Beeline's records is not simply one specimen in new Beeline.",
  },
  {
    id: "collectors",
    title: "Collectors",
    intro: "Who collected the specimen, written one way for each person.",
  },
  {
    id: "places",
    title: "Places and dates",
    intro: "Where and when the specimen was collected.",
  },
  {
    id: "unsorted",
    title: "Not sorted yet",
    intro: "Differences that no line above describes, or that nobody has explained yet. Each needs a look.",
  },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]["id"];

export interface ChangeLine {
  id: string;
  category: CategoryId;
  /** What new Beeline did, as a heading. */
  title: string;
  /** What it did and why, in a sentence or three. */
  did: string;
  /** What the line takes: each a set of the comparison's kinds, in these columns only, or every column where none are named. */
  match: readonly { kinds: readonly string[]; columns?: readonly string[] }[];
}

/**
 * Each line, in the page's order. The counts on the page are records, and
 * a record whose identification changed counts once on each line it is on.
 */
export const LINES: readonly ChangeLine[] = [
  {
    id: "newer_expert",
    category: "identifications",
    title: "An expert identification old Beeline never received",
    did: "The specimen's newest expert identification was made after old Beeline stopped receiving them, in Ecdysis or in new Beeline, where old Beeline had none or an earlier one. The name, its rank and family, and who determined it are that identification's.",
    match: [{ kinds: ["newer_determination"], columns: IDENTIFICATION }],
  },
  {
    id: "newer_expert_sex",
    category: "identifications",
    title: "Sex or caste from a newer expert identification",
    did: "New Beeline takes the sex and caste from the newest expert identification that gives one. Where that identification was made after old Beeline stopped receiving them, the sex can differ from old Beeline's, most often a specimen old Beeline called male that the expert's Ecdysis record calls female.",
    match: [{ kinds: ["newer_determination"], columns: SEX_CASTE }],
  },
  {
    id: "default_sex",
    category: "identifications",
    title: "Old Beeline's default sex left off unidentified specimens",
    did: "From 2023 old Beeline wrote male on every new record until somebody identified the specimen: it was the entry form's default, not anybody's reading of the bee. New Beeline gives a sex only where an expert identified the specimen, so these records, which no expert has identified, give none. A few of them said female rather than male; they give none either, for the same reason.",
    match: [{ kinds: ["unidentified_sex_dropped"] }],
  },
  {
    id: "volunteer",
    category: "identifications",
    title: "A volunteer identification old Beeline never received",
    did: "A volunteer's identification of the specimen, from their worksheet or made in new Beeline, where old Beeline had none or an earlier one. The expert's identification is unchanged by it.",
    match: [{ kinds: ["newer_volunteer_determination"] }],
  },
  {
    id: "subgenus_dropped",
    category: "gaps",
    title: "Subgenus no longer given after a newer identification",
    did: "A newer expert identification replaced old Beeline's, and the subgenus the old record gave is no longer written, because the newer identification did not state one and new Beeline files a species directly under its genus.",
    match: [{ kinds: ["subgenus_dropped"] }],
  },
  {
    id: "coarser",
    category: "gaps",
    title: "A newer identification names less than old Beeline's",
    did: "The newest expert identification names only a genus, or a rank above it, where old Beeline's named a species or a genus. New Beeline shows the newest; whether it should stand is for the taxonomists to say.",
    match: [{ kinds: ["coarser_determination"] }],
  },
  {
    id: "morphospecies",
    category: "gaps",
    title: "Morphospecies shown as their genus",
    did: "New Beeline cannot yet hold a morphospecies such as Melissodes sp.1, so these specimens are filed under the genus until it can.",
    match: [{ kinds: ["morphospecies"] }],
  },
  {
    id: "authorship",
    category: "names",
    title: "Author and year left off the name",
    did: "Old Beeline added the author and year to the scientific name on some records (Halictus ligatus Say, 1837); new Beeline writes the name alone.",
    match: [{ kinds: ["authorship"] }],
  },
  {
    id: "capitals",
    category: "names",
    title: "Capital letters put right in a name",
    did: "A genus is capitalised and an epithet never is: Mesillae is written mesillae, and andrena Andrena.",
    match: [{ kinds: ["case"], columns: NAMES }],
  },
  {
    id: "subgenus_column",
    category: "names",
    title: "Subgenus written apart from the genus",
    did: "Where old Beeline wrote a subgenus in the genus column, Lasioglossum (Dialictus), new Beeline writes the genus there and keeps the subgenus in its own column. An identification to a subgenus is written with its genus in the scientific name.",
    match: [{ kinds: ["subgenus_form"] }],
  },
  {
    id: "misspelt",
    category: "names",
    title: "A misspelt name corrected",
    did: "A misspelt genus or species, such as Agopostemon for Agapostemon, is written as the name that was meant.",
    match: [{ kinds: ["taxon_alias"] }],
  },
  {
    id: "epithet_column",
    category: "names",
    title: "Epithet written in its own column",
    did: "Where old Beeline wrote the epithet only inside the scientific name (Lasioglossum nr. tenax), new Beeline writes it in the epithet column too.",
    match: [{ kinds: ["filled"], columns: ["specificEpithet"] }],
  },
  {
    id: "contradicted_name",
    category: "names",
    title: "A name that contradicted the rest of its record",
    did: "One record at a time, decided by hand: a scientific name that disagreed with the record's own epithet (octodentata beside octodentatus), a subspecies ranked as a species, a fly filed under Hymenoptera, a volunteer's family that does not hold their genus.",
    match: [{ kinds: ["changed"], columns: NAMES }],
  },
  {
    id: "sex_caste_words",
    category: "names",
    title: "Sex and caste in one set of words",
    did: "Male is written male, a caste written in the sex column gives the sex too (a worker is female), and old Beeline's Queen is written gyne.",
    match: [{ kinds: ["sex_caste_vocabulary"] }],
  },
  {
    id: "classification",
    category: "names",
    title: "Higher classification filled in",
    did: "The phylum, class, order and family, the rank, and the scientific name in full, written from the identification where the old record left them blank.",
    match: [{ kinds: ["filled"], columns: CLASSIFICATION }],
  },
  {
    id: "second_print",
    category: "specimens",
    title: "Identification carried over from a second record of the same pin",
    did: "Old Beeline held two records for one pin, whose label was printed twice. New Beeline keeps one specimen, ties the other record to it, and takes the identification from whichever record had one.",
    match: [{ kinds: ["second_print"] }],
  },
  {
    id: "second_record",
    category: "specimens",
    title: "A second record of the same pin, tied to its specimen",
    did: "Old Beeline's second record of a pin whose label was printed twice. New Beeline ties it to the specimen it records rather than making it a specimen of its own, so its field number names no specimen; the note on the specimen gives it.",
    match: [{ kinds: ["tied_second_record"] }],
  },
  {
    id: "note",
    category: "specimens",
    title: "A note on the specimen",
    did: "A note old Beeline's record did not have. Most say that old Beeline recorded the specimen twice, and under which field numbers.",
    match: [{ kinds: ["filled"], columns: ["occurrenceRemarks"] }],
  },
  {
    id: "placed",
    category: "specimens",
    title: "Placed in its sample by inference, with a note",
    did: "Old Beeline's record lacked a detail, such as the day or the sample number, but led to one sample of the same collector. New Beeline placed it in that sample, so its date, point and sample number are the sample's, and a note on the specimen says what was inferred.",
    match: [{ kinds: ["repair_placed"] }],
  },
  {
    id: "held_back",
    category: "specimens",
    title: "Not carried over",
    did: "Records new Beeline did not make into specimens, because the collector, the sample number, a date it can read or the specimen number was missing, or because they repeat a record that was kept. The held-back page lists each, with its reason. Counted here by field number, and there by record: old Beeline gave some field numbers to several empty records.",
    match: [{ kinds: HELD_BACK }],
  },
  {
    id: "numbered_here",
    category: "specimens",
    title: "Numbered by new Beeline",
    did: "Specimens new Beeline has numbered and printed since cutover, which old Beeline did not have. The nightly copy puts them there for volunteers to identify.",
    match: [{ kinds: ["minted_by_beeline"] }],
  },
  {
    id: "reprinted",
    category: "specimens",
    title: "Label printed again",
    did: "The specimen's label was printed again in new Beeline, so the print date is the newest printing's.",
    match: [{ kinds: ["reprinted"] }],
  },
  {
    id: "collector_misspelt",
    category: "collectors",
    title: "A misspelt collector's name corrected",
    did: "The record misspelt the collector's name; new Beeline writes the name the collector uses on iNaturalist.",
    match: [{ kinds: ["collector_alias"] }],
  },
  {
    id: "collector_spelling",
    category: "collectors",
    title: "One spelling for each collector",
    did: "A collector whose name old Beeline spelt more than one way, in capitals, spaces or hyphens, is written the way they spelt it last.",
    match: [{ kinds: ["name_spelling"] }, { kinds: ["case"], columns: COLLECTOR }],
  },
  {
    id: "collector_pair",
    category: "collectors",
    title: "Two collectors written one way",
    did: "Where two people collected together, old Beeline wrote them in several forms: Ada and Bea, S./S., one family name for both, or the two in one order in one column and the other order in the next. New Beeline gives each collector their own name, in one order.",
    match: [{ kinds: ["collector_list_form", "collector_order_contradicted"] }],
  },
  {
    id: "collector_added",
    category: "collectors",
    title: "The sample's other collectors added",
    did: "A sample has one list of collectors, so each of its specimens names every collector its records name, where the old record named only some of them.",
    match: [{ kinds: ["collector_added"] }],
  },
  {
    id: "initials",
    category: "collectors",
    title: "Initials written as the label gives them",
    did: "The initial printed before a collector's family name: with its full stop (S. rather than S), taken from the first name rather than the family name, or as the collector's own label name gives it.",
    match: [{ kinds: ["initial_form", "initial_from_surname", "label_name", "changed", "case"], columns: ["firstNameInitial"] }],
  },
  {
    id: "collector_contradicted",
    category: "collectors",
    title: "A collector's name that contradicted the rest of its record",
    did: "One record at a time, decided by hand: a family name written in the first-name column, or a collector column naming someone other than the sample's collectors.",
    match: [{ kinds: ["changed"], columns: COLLECTOR }],
  },
  {
    id: "account",
    category: "collectors",
    title: "The collector's iNaturalist account",
    did: "New Beeline writes the iNaturalist account of the collector: where the old record had none, under its newer login where the account was renamed, in lower case as iNaturalist writes logins, and the collector's own account where the old record had somebody else's, such as a household member's.",
    match: [{ kinds: ["login_renamed", "filled", "changed", "case"], columns: ACCOUNT }],
  },
  {
    id: "staff_corrected",
    category: "places",
    title: "Corrected by staff",
    did: "A correction staff made to the old record, in new Beeline or by hand before cutover: mostly trap samples whose method and end date were put right, and a few counties and localities.",
    match: [{ kinds: ["staff_correction"] }],
  },
  {
    id: "true_point",
    category: "places",
    title: "The true point of an obscured observation",
    did: "For an obscured observation, old Beeline wrote the point iNaturalist shows the public, which is deliberately not where the bee was. New Beeline holds the true point the observer shared with the project, with its own accuracy and elevation.",
    match: [{ kinds: ["standin_replaced"] }],
  },
  {
    id: "sample_disagreement",
    category: "places",
    title: "One value for a sample whose records disagreed",
    did: "Old Beeline's records of one sample disagreed about this, and the sample holds one value.",
    match: [{ kinds: ["sample_disagreement"] }],
  },
  {
    id: "place_filled",
    category: "places",
    title: "Place and point filled in",
    did: "The point and its accuracy, the elevation, county and locality, the geoprivacy and the iNaturalist link, from the observation new Beeline linked the sample to, or worked out at its point, where the old record left them blank.",
    match: [{ kinds: ["filled"], columns: PLACE }],
  },
  {
    id: "dates",
    category: "places",
    title: "The same date, written in numbers",
    did: "Roman-numeral months written as numbers (VI as 6); a collection on one day written without the end date old Beeline gave it on the same day; and the days of the year, which old Beeline left blank beside a Roman month.",
    match: [{ kinds: ["date_form", "one_day_range"] }, { kinds: ["filled"], columns: DAY_OF_YEAR }],
  },
  {
    id: "same_value",
    category: "places",
    title: "The same value, written another way",
    did: "CAN written CA, as the template writes countries; a number without a trailing zero; and a value of nothing but spaces written blank.",
    match: [{ kinds: ["country_code", "number_form", "whitespace"] }],
  },
  {
    id: "other",
    category: "unsorted",
    title: "Something no line above describes",
    did: "A difference a ruling explains, of a kind this page does not sort yet. There should be none.",
    match: [{ kinds: [] }],
  },
  {
    id: "unexplained",
    category: "unsorted",
    title: "Not yet explained",
    did: "A difference no ruling explains yet: new Beeline may be wrong, or it may be doing something nobody has written down.",
    match: [{ kinds: [] }],
  },
];

/** The rulings' outcomes, as the page says them. */
export const OUTCOME_WORDS: Record<string, string> = {
  "reference-wrong": "Old Beeline's value was wrong",
  expected: "Not a fault in either",
  "known-gap": "New Beeline cannot hold it yet",
  "beeline-wrong": "New Beeline's value is wrong",
  unexplained: "Not yet explained",
};

/** Columns whose values are never shown on the page: the old point of an obscured observation is the public one, and the page shows no point at all. */
export const HIDDEN_VALUE_COLUMNS = new Set(["decimalLatitude", "decimalLongitude"]);

const list = (xs: readonly string[]) => xs.map((x) => `'${x.replaceAll("'", "''")}'`).join(", ");
const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** The line of a difference in `cmp_kinded`, as SQL over its kind, column and outcome. */
export const LINE_SQL = `CASE
  WHEN outcome = 'unexplained' THEN 'unexplained'
  ${LINES.flatMap((l) =>
    l.match
      .filter((m) => m.kinds.length > 0)
      .map((m) => `WHEN kind IN (${list(m.kinds)})${m.columns ? ` AND "column" IN (${list(m.columns)})` : ""} THEN '${l.id}'`),
  ).join("\n  ")}
  ELSE 'other'
END`;

export interface ChangeValue {
  column: string;
  kind: string;
  /** Null where the column's values are not shown. */
  old: string | null;
  new: string | null;
}

export interface ChangeExample {
  fieldNumber: string;
  /** The specimen in new Beeline, where there is one. */
  specimenId: number | null;
  values: ChangeValue[];
}

export interface LineSummary {
  line: string;
  /** Records, split by season on the record's first collecting day. */
  active: number;
  settled: number;
  /** Values: a record can differ in several columns on one line. */
  values: number;
  /** Records under each outcome, commonest first. */
  outcomes: { outcome: string; active: number; settled: number }[];
  examples: ChangeExample[];
  /** The line's CSV, every difference on it, in the same directory. */
  file: string;
  bytes: number;
}

export interface ChangesSummary {
  writtenAt: string;
  /** The first day of the active seasons, as an ISO date. */
  activeSince: string;
  reference: { rows: number; fingerprint: string };
  matched: { active: number; settled: number };
  /**
   * The folder under the summary's own that holds this night's CSVs. Each
   * night writes a new one and the summary names it, so the counts on the
   * page and the file a reader downloads are always one night's, however a
   * night fails.
   */
  generation: string;
  /** Every line that has a difference, in the page's order. */
  lines: LineSummary[];
}

export const changesDir = (exportsDir: string) => join(exportsDir, "changes");
const SUMMARY = "summary.json";
export const lineFile = (line: string) => `${line}.csv`;
/** A night's folder, named for the instant it was written: 2026-11-16T12-00-00-000Z. */
export const GENERATION = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** The summary the job last wrote, or null where none has been. */
export async function readChangesSummary(exportsDir: string): Promise<ChangesSummary | null> {
  return readSummaryIn(changesDir(exportsDir));
}

async function readSummaryIn(dir: string): Promise<ChangesSummary | null> {
  try {
    return JSON.parse(await readFile(join(dir, SUMMARY), "utf8")) as ChangesSummary;
  } catch {
    return null;
  }
}

const EXAMPLES_PER_LINE = 3;
const VALUES_PER_EXAMPLE = 8;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Compare the export at `exportPath` with old Beeline's records, sort every
 * difference into its line, and write the summary and the CSVs
 * into `dir`, one file per line in a folder of the night's own. On one thread, as the export is, for its memory: measured on
 * the production backup of 15 November 2026 it completed with DuckDB held to
 * 768 MB, spilling. Every temporary table it made is gone when it returns,
 * since the app's shared connection runs it.
 */
export async function writeChanges(
  conn: DuckDBConnection,
  exportPath: string,
  rulings: readonly Ruling[],
  dir: string,
): Promise<ChangesSummary> {
  await mkdir(dir, { recursive: true });
  const [[threads]] = (await (await conn.run(`SELECT current_setting('threads')`)).getRows()) as [[bigint | number]];
  await conn.run("SET threads = 1");
  try {
    const comparison = await compareLegacyExport(conn, exportPath, rulings);
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE chg_line AS
      SELECT k.*, ${LINE_SQL} AS line FROM cmp_kinded k`);
    await conn.run(`CREATE OR REPLACE TEMP TABLE chg_meta (line TEXT, category TEXT, title TEXT)`);
    await conn.run(`INSERT INTO chg_meta VALUES ${LINES.map((l) => `(${sqlString(l.id)}, ${sqlString(l.category)}, ${sqlString(l.title)})`).join(", ")}`);
    await conn.run(`CREATE OR REPLACE TEMP TABLE chg_outcome (outcome TEXT, words TEXT)`);
    await conn.run(`INSERT INTO chg_outcome VALUES ${Object.entries(OUTCOME_WORDS).map(([o, w]) => `(${sqlString(o)}, ${sqlString(w)})`).join(", ")}`);
    await conn.run(`CREATE OR REPLACE TEMP TABLE chg_reason (ruling_id INTEGER, reason TEXT)`);
    if (rulings.length > 0) {
      await conn.run(`INSERT INTO chg_reason VALUES ${rulings.map((r, i) => `(${i}, ${sqlString(r.reason)})`).join(", ")}`);
    }

    const counts = new Map(
      ((await (await conn.run(`
        SELECT line, count(DISTINCT field_number) FILTER (WHERE active_season),
               count(DISTINCT field_number) FILTER (WHERE NOT active_season), count(*)
        FROM chg_line GROUP BY line`)).getRows()) as [string, bigint, bigint, bigint][]).map(([line, a, s, v]) => [
        line,
        { active: Number(a), settled: Number(s), values: Number(v) },
      ]),
    );
    const outcomes = (await (await conn.run(`
      SELECT line, outcome, count(DISTINCT field_number) FILTER (WHERE active_season),
             count(DISTINCT field_number) FILTER (WHERE NOT active_season)
      FROM chg_line GROUP BY 1, 2 ORDER BY 1, 3 + 4 DESC, 2`)).getRows()) as [string, string, bigint, bigint][];
    // A few records each, one for each of the commonest changes the line
    // makes, so the examples show its range rather than one change three
    // times, and then the lowest field numbers where it makes fewer kinds of
    // change than that (a record not carried over is one change, however
    // many there are); each with every value the line changed on it.
    const examples = (await (await conn.run(`
      WITH pairs AS (SELECT line, "column", kind, legacy, exported, count(*) AS n, min(field_number) AS fn
                     FROM chg_line GROUP BY ALL),
           candidate AS (SELECT line, fn, n AS score, 0 AS tier FROM pairs
                         UNION ALL
                         SELECT line, field_number, 0, 1 FROM (
                           SELECT line, field_number, row_number() OVER (PARTITION BY line ORDER BY field_number) AS k
                           FROM (SELECT DISTINCT line, field_number FROM chg_line)) WHERE k <= ${EXAMPLES_PER_LINE}),
           best AS (SELECT line, fn, min(tier) AS tier, max(score) AS score FROM candidate GROUP BY ALL),
           pick AS (SELECT line, fn, row_number() OVER (PARTITION BY line ORDER BY tier, score DESC, fn) AS r FROM best
                    QUALIFY r <= ${EXAMPLES_PER_LINE}),
           vals AS (SELECT p.line, p.fn, p.r, c."column", c.kind, c.legacy, c.exported,
                           row_number() OVER (PARTITION BY p.line, p.fn ORDER BY c."column") AS v
                    FROM pick p JOIN chg_line c ON c.line = p.line AND c.field_number = p.fn)
      -- The specimen, or for a second record the specimen it is tied to.
      SELECT v.line, v.fn,
             coalesce((SELECT min(sp.entity_id) FROM specimen sp WHERE sp.field_number = v.fn),
                      (SELECT min(r.specimen_id) FROM legacy_duplicate_record r JOIN legacy_occurrence o ON o._id = r._id
                       WHERE o."fieldNumber" = v.fn)),
             v."column", v.kind, v.legacy, v.exported
      FROM vals v WHERE v.v <= ${VALUES_PER_EXAMPLE}
      ORDER BY v.line, v.r, v."column"`)).getRows()) as [string, string, number | bigint | null, string, string, string, string][];

    const previous = (await readSummaryIn(dir))?.generation ?? null;
    const generation = new Date().toISOString().replace(/[:.]/g, "-");
    await mkdir(join(dir, generation), { recursive: true });
    const lines: LineSummary[] = [];
    for (const l of LINES) {
      const path = join(dir, generation, lineFile(l.id));
      const n = counts.get(l.id);
      if (n === undefined) continue;
      const mine: ChangeExample[] = [];
      for (const [line, fieldNumber, specimenId, column, kind, legacy, exported] of examples) {
        if (line !== l.id) continue;
        let ex = mine.at(-1);
        if (ex?.fieldNumber !== fieldNumber) {
          ex = { fieldNumber, specimenId: specimenId === null ? null : Number(specimenId), values: [] };
          mine.push(ex);
        }
        const hidden = HIDDEN_VALUE_COLUMNS.has(column);
        ex.values.push({ column, kind, old: hidden ? null : legacy, new: hidden ? null : exported });
      }
      await writeLineCsv(conn, l.id, path);
      lines.push({
        line: l.id,
        ...n,
        outcomes: outcomes
          .filter(([line]) => line === l.id)
          .map(([, outcome, active, settled]) => ({ outcome, active: Number(active), settled: Number(settled) })),
        examples: mine,
        file: lineFile(l.id),
        bytes: (await stat(path)).size,
      });
    }

    const [[activeSince]] = (await (await conn.run(`SELECT strftime(active_since, '%Y-%m-%d') FROM season`)).getRows()) as [[string]];
    const summary: ChangesSummary = {
      writtenAt: new Date().toISOString(),
      activeSince,
      reference: comparison.reference,
      matched: comparison.matched,
      generation,
      lines,
    };
    // Last, so a page never reads a summary naming files not yet written.
    await writeFile(join(dir, `${SUMMARY}.tmp`), JSON.stringify(summary, null, 2));
    await rename(join(dir, `${SUMMARY}.tmp`), join(dir, SUMMARY));
    // Every older night's folder but the one the last summary named, which a
    // reader who loaded the page just before may still be downloading from.
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      // Only a folder named as this writes one, so --out pointed at a folder
      // with anything else in it never loses the rest.
      if (entry.isDirectory() && GENERATION.test(entry.name) && entry.name !== generation && entry.name !== previous) {
        await rm(join(dir, entry.name), { recursive: true, force: true });
      }
    }
    return summary;
  } finally {
    try {
      await conn.run(`SET threads = ${Number(threads)}`);
    } finally {
      await dropComparisonTables(conn);
    }
  }
}

/**
 * Every difference on one line, one row each: the record, its season, the
 * column, old Beeline's value and new Beeline's, what new Beeline did, the
 * outcome, and the ruling's own reason. With a byte order mark, so a
 * spreadsheet reads the names in it as UTF-8; replaced only once complete.
 */
async function writeLineCsv(conn: DuckDBConnection, line: string, path: string): Promise<void> {
  const body = `${path}.body.tmp`;
  const whole = `${path}.tmp`;
  try {
    await conn.run(`
      COPY (
        SELECT c.field_number, CASE WHEN c.active_season THEN 'active' ELSE 'settled' END AS season,
               c."column", c.legacy AS old_beeline, c.exported AS new_beeline,
               m.title AS what_new_beeline_did, coalesce(o.words, c.outcome) AS outcome, coalesce(r.reason, '') AS why
        FROM chg_line c
        JOIN chg_meta m ON m.line = c.line
        LEFT JOIN chg_outcome o ON o.outcome = c.outcome
        LEFT JOIN chg_reason r ON r.ruling_id = c.ruling_id
        WHERE c.line = ${sqlString(line)}
        ORDER BY c.field_number, c."column"
      ) TO ${sqlString(body)} (HEADER, DELIMITER ',', QUOTE '"', ESCAPE '"')`);
    const out = createWriteStream(whole);
    out.write(BOM);
    await pipeline(createReadStream(body), out);
    await rename(whole, path);
  } finally {
    await rm(body, { force: true });
    await rm(whole, { force: true });
  }
}

/** Describe a summary for the job's run detail. */
export function describeChanges(s: ChangesSummary): string {
  // Active seasons first, then settled, as every count here is reported.
  const records = (id: string) => {
    const l = s.lines.find((x) => x.line === id);
    return l === undefined ? "0 / 0" : `${l.active} / ${l.settled}`;
  };
  const values = s.lines.reduce((t, l) => t + l.values, 0);
  return `${values} differing values on ${s.lines.length} lines; records (active / settled) not yet explained ${records("unexplained")}, unsorted ${records("other")}`;
}

// CLI: pnpm legacy:changes [db] [export.csv] [--out dir]
// With no export path, writes a fresh export to data/exports/ first.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--out");
  let out = changesDir("data/exports");
  if (i !== -1) {
    const v = args[i + 1];
    if (v === undefined) throw new Error("--out needs a directory");
    out = v;
    args.splice(i, 2);
  }
  const dbPath = args[0] ?? process.env.BEELINE_DB ?? "beeline.duckdb";
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  let exportPath = args[1];
  if (exportPath === undefined) {
    // Under data/, which git ignores: the file names every collector.
    exportPath = legacyExportPath("data/exports");
    await writeLegacyExport(conn, exportPath);
  }
  const summary = await writeChanges(conn, exportPath, await readRulings(DEFAULT_RULINGS), out);
  conn.closeSync();
  console.log(describeChanges(summary));
  for (const l of summary.lines) {
    console.log(`  ${l.line.padEnd(24)} ${String(l.active).padStart(7)} / ${String(l.settled).padStart(7)}  e.g. ${l.examples.map((e) => e.fieldNumber).join(", ")}`);
  }
  console.error(`written to ${out}`);
}
