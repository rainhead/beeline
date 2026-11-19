import type { DuckDBConnection } from "@duckdb/node-api";
import { sql, type Kysely } from "kysely";
import { matchCollectors, matchName, readPeople, type MatchedCollector } from "../collector-match.js";
import type { Database } from "../model.js";
import { oregonToday } from "../oregon-today.js";
import { PROGRAM_SERIES, checkTrapSample, findLookalikes, highestSampleNumber, seriesNumberProblem, seriesReach, type Lookalike, type TrapSampleForm } from "../trap-sample.js";
import { ALL, EMPTY_QUERY, STAFF_READER, alpha3Of, listSamples, type Reader } from "./listings.js";
import { samplesFileRow } from "./sample-workbook.js";
import {
  MAX_INTEGER,
  SAMPLES_LAYOUT,
  UNIT_RULES,
  evaluateAs,
  foldBreaks,
  fromBeeline,
  type Evaluated,
  type HeldCell,
  type HoldReason,
  type ParsedUpload,
  type Reads,
  type SeasonSplit,
  type UnitCell,
  type UnitCells,
} from "./upload-plan.js";
import type { XlsxCell } from "./xlsx.js";

/**
 * Comparing an edited copy of the samples download with what Beeline says now
 * (beeline-kgyd.4.9). Nothing here writes: the plan says what would differ, what
 * could not be used and which rows would become new trap samples, and a later
 * slice applies it. See docs/architecture/loading-an-edited-download.md.
 *
 * The grain is the sample, one row each, where the specimens comparison
 * (src/app/upload-plan.ts) is a specimen's. What Beeline says now is what the
 * download would write for the sample now (`samplesFileRow`), read as the reader.
 * The strict reading of a cell, and the rules for the dates, the place and the
 * coordinates, are that comparison's own. A fact is listed whole or held whole,
 * in the same way: a changed group of cells is listed only if it is complete.
 * A row with no `sampleId` would become a new trap sample, and is judged by the
 * trap form's own checks (`checkTrapSample`), so that the preview and the
 * write that follows it judge a row in the same way.
 */

/** Why a row, or a group of its cells, cannot be used, beyond the reasons the specimens comparison already has. */
export const SAMPLE_REASONS = [
  // The whole row.
  "no_sample_id",
  "sample_repeated",
  "no_sample",
  "sample_number_disagrees",
  // A group of cells that is not complete.
  "trap_count_invalid",
  "specimen_count_invalid",
  "collectors_blank",
  "country_blank",
  "state_blank",
  "country_unknown",
  // Names that Beeline cannot match to one person each (src/collector-match.ts), with its sentence as the detail.
  "collector_unknown",
  // A new trap sample.
  "new_number_repeated",
  // What the trap form's own check says of a new row, as its sentence for that field; and what the guard on the
  // program's own numbers says of one (src/trap-sample.ts seriesNumberProblem), which is the same kind of sentence.
  "new_row_problem",
] as const;
export type SampleReason = (typeof SAMPLE_REASONS)[number];
export type Why = HoldReason | SampleReason;

/** The groups of cells that are listed whole or held whole. */
export const SAMPLES_UNITS = ["method_dates", "trap_count", "specimen_count", "collectors", "area", "place", "coordinates"] as const;
export type SamplesUnit = (typeof SAMPLES_UNITS)[number];

const UNIT_COLUMNS: Record<SamplesUnit, readonly string[]> = {
  method_dates: ["eventDate", "samplingProtocol"],
  trap_count: ["trapCount"],
  specimen_count: ["specimenCount"],
  collectors: ["recordedBy"],
  area: ["countryCode", "stateProvince", "county"],
  place: ["locality"],
  coordinates: ["decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters"],
};
const READS: Record<string, Reads> = {
  eventDate: "days",
  samplingProtocol: "text",
  trapCount: "number",
  specimenCount: "number",
  recordedBy: "names",
  // Compared without case, so `us` is `US`.
  countryCode: "word",
  stateProvince: "text",
  county: "text",
  locality: "text",
  decimalLatitude: "number",
  decimalLongitude: "number",
  coordinateUncertaintyInMeters: "number",
};
const COMPARED = Object.keys(READS);

/** The trap form's fields and the columns of the file that say them, so that a problem the form finds is not said twice. */
const FORM_COLUMNS: Record<keyof TrapSampleForm, readonly string[]> = {
  sample_number: ["fieldNumber"],
  collectors: ["recordedBy"],
  date_start: ["eventDate"],
  date_end: ["eventDate"],
  method: ["samplingProtocol"],
  trap_count: ["trapCount"],
  specimen_count: ["specimenCount"],
  latitude: ["decimalLatitude"],
  longitude: ["decimalLongitude"],
  uncertainty: ["coordinateUncertaintyInMeters"],
  country: ["countryCode"],
  state_province: ["stateProvince"],
  county: ["county"],
  locality: ["locality"],
};

export interface SampleUnitDifference {
  unit: SamplesUnit;
  /** Every cell of the group that the file has, with which differ. At least one does. */
  cells: UnitCell[];
}

export interface SampleProblem {
  reason: Why;
  unit: SamplesUnit | null;
  /** The cell that says so. */
  column: string | null;
  /** The sentence the check gave, or what the file said that could not be used. */
  detail: string;
  /** What Beeline says and what the file says, for every cell concerned. */
  cells: HeldCell[];
}

/** What applying a new row would write, worked out and checked: kept with the row so that applying writes exactly this. */
export interface NewRowCreate {
  /** The trap form's fields, the collectors as the ids of the people they came to, so that nothing is matched again. */
  form: TrapSampleForm;
  /** The existing sample this one looks like, which holds the row back unless it is ticked. */
  lookalike: Lookalike | null;
  /** The look-alike was ticked "create anyway", so the row is not held. */
  anyway: boolean;
}

export interface SampleRowResult {
  /** The row in the file, the header being row 1. */
  row: number;
  kind: "existing" | "new";
  sampleId: number | null;
  /** The sample's number: Beeline's for an existing sample, the file's for a new row. */
  sampleNumber: string | null;
  season: keyof SeasonSplit;
  /** Differences that would be applied, complete. */
  differences: SampleUnitDifference[];
  /** Why the row, or part of it, cannot be used. */
  problems: SampleProblem[];
  /** For a new row with nothing wrong: what making it a trap sample would write. */
  create: NewRowCreate | null;
}

export interface SamplesCounts {
  /** Every data row in the file. */
  rows: SeasonSplit;
  /** New rows with nothing wrong: trap samples that could be created. */
  newReady: SeasonSplit;
  /** New rows with nothing wrong except that each looks like an existing sample, so they wait to be ticked. */
  newHeld: SeasonSplit;
  /** Rows, new or existing, with something that cannot be used. */
  cantUse: SeasonSplit;
  /** Existing samples that differ, and nothing is wrong. */
  differ: SeasonSplit;
  /** Existing samples that say what Beeline says. */
  same: SeasonSplit;
}

/** A name in `recordedBy` that matches nobody, or several people. */
export interface UnknownCollector {
  name: string;
  /** How many rows name it. */
  rows: number;
  /** The matcher's sentence. */
  problem: string;
}

export interface SamplesPlan {
  kind: "samples";
  counts: SamplesCounts;
  unrecognised: ParsedUpload["unrecognised"];
  otherSheets: string[];
  rows: SampleRowResult[];
  unknownCollectors: UnknownCollector[];
}

const emptySplit = (): SeasonSplit => ({ active: 0, settled: 0, unplaced: 0 });

/** The counts of a set of rows. Also what the page counts once some rows have an outcome of their own. */
export function countRows(rows: readonly SampleRowResult[]): SamplesCounts {
  const counts: SamplesCounts = { rows: emptySplit(), newReady: emptySplit(), newHeld: emptySplit(), cantUse: emptySplit(), differ: emptySplit(), same: emptySplit() };
  for (const r of rows) {
    counts.rows[r.season]++;
    if (r.problems.length > 0) counts.cantUse[r.season]++;
    else if (r.kind === "new") counts[r.create?.lookalike != null && !r.create.anyway ? "newHeld" : "newReady"][r.season]++;
    else if (r.differences.length > 0) counts.differ[r.season]++;
    else counts.same[r.season]++;
  }
  return counts;
}

// --- What Beeline says now ---

interface Now {
  /** The file's cells for this sample as text, trimmed, by heading. */
  cells: Map<string, string>;
  number: string;
}

const CHUNK = 500;

async function readNow(db: Kysely<Database>, ids: number[], reader: Reader): Promise<Map<number, Now>> {
  const now = new Map<number, Now>();
  const query = { ...EMPTY_QUERY, scope: ALL };
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const page = await listSamples(db, query, 0, reader, { ids: chunk, limit: chunk.length, offset: 0, withTotal: false, withFlagWords: false, hostNames: "common" });
    for (const r of page.rows) {
      const written = samplesFileRow(r, page);
      const cells = new Map<string, string>();
      SAMPLES_LAYOUT.headings.forEach((name, j) => cells.set(name, (written[j] ?? "").trim()));
      now.set(r.sample_id, { cells, number: (r.sample_number ?? "").trim() });
    }
  }
  return now;
}

async function readSeasons(db: Kysely<Database>, ids: number[]): Promise<{ settled: Set<number>; activeSince: string }> {
  const settled = new Set<number>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const list = sql.join(ids.slice(i, i + CHUNK).map((id) => sql`${id}`));
    const found = await sql<{ sample_id: number }>`SELECT sample_id FROM settled_sample WHERE sample_id IN (${list})`.execute(db);
    for (const r of found.rows) settled.add(Number(r.sample_id));
  }
  const since = (await sql<{ active_since: Date | string }>`SELECT active_since FROM season`.execute(db)).rows[0]!.active_since;
  return { settled, activeSince: since instanceof Date ? since.toISOString().slice(0, 10) : String(since).slice(0, 10) };
}

// --- When a group of cells is complete ---

interface Incomplete {
  reason: Why;
  column: string;
}

const wholeBetween = (v: Evaluated["value"], low: number): boolean =>
  v.kind === "number" && Number.isInteger(v.number) && v.number >= low && v.number <= MAX_INTEGER;

/**
 * What each group needs to be complete: the first thing wrong, or null. The dates, place and coordinates are the
 * specimens comparison's own rules (UNIT_RULES); the rest are the store's columns and the trap form's. A new row
 * may leave the specimen count blank, which the form takes as 0 until the specimens are pinned.
 */
function incomplete(unit: SamplesUnit, cells: UnitCells, today: string, isNew: boolean): Incomplete | null {
  for (const column of UNIT_COLUMNS[unit]) {
    const problem = cells.get(column)?.problem ?? null;
    if (problem !== null) return { reason: problem, column };
  }
  const value = (column: string) => cells.get(column)!.value;
  switch (unit) {
    case "method_dates":
    case "coordinates":
    case "place":
      return UNIT_RULES[unit](cells, today);
    case "trap_count": {
      const v = value("trapCount");
      return v.kind === "blank" || wholeBetween(v, 1) ? null : { reason: "trap_count_invalid", column: "trapCount" };
    }
    case "specimen_count": {
      const v = value("specimenCount");
      return (isNew && v.kind === "blank") || wholeBetween(v, 0) ? null : { reason: "specimen_count_invalid", column: "specimenCount" };
    }
    case "collectors":
      return value("recordedBy").kind === "blank" ? { reason: "collectors_blank", column: "recordedBy" } : null;
    case "area": {
      const country = value("countryCode");
      if (country.kind === "blank") return { reason: "country_blank", column: "countryCode" };
      if (value("stateProvince").kind === "blank") return { reason: "state_blank", column: "stateProvince" };
      return storeCountry(country.kind === "word" ? country.word : "") === null ? { reason: "country_unknown", column: "countryCode" } : null;
    }
  }
}

/** The store's country for a code the file gives: alpha-2 through the download's own table, backwards; alpha-3 as it is. */
function storeCountry(code: string): string | null {
  const upper = code.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return alpha3Of(upper) ?? null;
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}

const heldCells = (cells: UnitCells, columns: string[]): HeldCell[] =>
  columns.map((c) => ({ column: c, was: cells.get(c)!.nowText, fileSays: cells.get(c)!.fileText }));

// --- The comparison ---

export interface SamplesPlanOptions {
  today?: string;
  /** Who the file is read as: staff, who see every location, unless said. */
  reader?: Reader;
  /** The rows of the file whose look-alike was ticked "create anyway". */
  createAnyway?: ReadonlySet<number>;
}

/**
 * The plan for a parsed samples file. `conn` is the connection the trap form and staff's collector correction match
 * names on: nothing is written on it.
 */
export async function planSamples(db: Kysely<Database>, conn: DuckDBConnection, upload: ParsedUpload, options: SamplesPlanOptions = {}): Promise<SamplesPlan> {
  const today = options.today ?? oregonToday();
  const { columns, rows } = upload;
  const blankCell: XlsxCell = { text: "", type: "text" };
  const cell = (cells: Map<number, XlsxCell>, column: string): XlsxCell => {
    const at = columns.get(column);
    return at === undefined ? blankCell : (cells.get(at) ?? blankCell);
  };
  const text = (cells: Map<number, XlsxCell>, column: string): string => foldBreaks(cell(cells, column).text).trim();

  // Which sample each row names. A blank cell is a new row; anything else must be a whole number.
  const idOf = rows.map(({ cells }): { given: string; id: number | null } => {
    const given = text(cells, "sampleId");
    const n = /^\d+$/.test(given) ? Number(given) : 0;
    return { given, id: Number.isSafeInteger(n) && n > 0 ? n : null };
  });
  const timesNamed = new Map<number, number>();
  for (const { id } of idOf) if (id !== null) timesNamed.set(id, (timesNamed.get(id) ?? 0) + 1);
  const now = await readNow(db, [...timesNamed.keys()], options.reader ?? STAFF_READER);
  const { settled, activeSince } = await readSeasons(db, [...now.keys()]);
  const people = await readPeople(conn);

  const results: SampleRowResult[] = [];

  // What each name in a list of collectors comes to, once for the file; and the names that come to nobody, with their rows.
  const named = new Map<string, MatchedCollector | string>();
  const unknown = new Map<string, { rows: Set<number>; problem: string }>();
  const nameResult = async (name: string) => {
    if (!named.has(name)) named.set(name, await matchName(conn, name, people, true));
    return named.get(name)!;
  };
  const noteNames = async (items: string[], row: number) => {
    for (const name of items) {
      const found = await nameResult(name);
      if (typeof found !== "string") continue;
      const kept = unknown.get(name) ?? unknown.set(name, { rows: new Set(), problem: `${found}.` }).get(name)!;
      kept.rows.add(row);
    }
  };

  /** Every compared column the file has, evaluated against what Beeline says; and with Beeline's own for the rest. */
  const evaluateRow = (cells: Map<number, XlsxCell>, nowCells: Map<string, string> | null) => {
    const results = new Map<string, Evaluated>();
    const full = new Map<string, Evaluated>();
    for (const column of COMPARED) {
      const nowText = nowCells?.get(column) ?? "";
      if (columns.has(column)) {
        const r = evaluateAs(READS[column]!, column, cell(cells, column), nowText, true);
        results.set(column, r);
        full.set(column, r);
      } else full.set(column, fromBeeline(column, nowText, READS[column]));
    }
    return { results, full };
  };

  const newNumbers = new Map<string, number[]>();
  /** The highest number in the program's series, read once and only if a new row is in it. */
  let series: { highest: number } | null = null;

  for (const [index, { row, cells }] of rows.entries()) {
    const { given, id } = idOf[index]!;
    const isNew = given === "";
    const known = id === null ? undefined : now.get(id);
    const fileNumber = text(cells, "fieldNumber");
    const result: SampleRowResult = {
      row,
      kind: isNew ? "new" : "existing",
      sampleId: known === undefined ? null : id,
      sampleNumber: known === undefined ? (isNew ? fileNumber : null) : known.number,
      season: "unplaced",
      differences: [],
      problems: [],
      create: null,
    };
    results.push(result);
    const wholeRow = (reason: SampleReason, detail: string) => result.problems.push({ reason, unit: null, column: null, detail, cells: [] });

    if (isNew) {
      const { results: cellResults, full } = evaluateRow(cells, null);
      const flagged = new Set<string>();
      for (const unit of SAMPLES_UNITS) {
        const wrong = incomplete(unit, full, today, true);
        if (wrong === null) continue;
        for (const c of UNIT_COLUMNS[unit]) if (cellResults.get(c)?.problem != null) flagged.add(c);
        flagged.add(wrong.column);
        result.problems.push({ reason: wrong.reason, unit, column: wrong.column, detail: full.get(wrong.column)!.fileText, cells: heldCells(full, [wrong.column]) });
      }
      // A new sample's number is permanent, so it is read as strictly as any other cell: a formula, or a cell the
      // spreadsheet turned into a date, is not a number somebody typed, whatever text it shows.
      const numberCell = evaluateAs("text", "fieldNumber", cell(cells, "fieldNumber"), "", true);
      if (numberCell.problem !== null) {
        flagged.add("fieldNumber");
        result.problems.push({ reason: numberCell.problem, unit: null, column: "fieldNumber", detail: numberCell.fileText, cells: heldCells(new Map([["fieldNumber", numberCell]]), ["fieldNumber"]) });
      }
      const when = full.get("eventDate")!.value;
      if (when.kind === "days") result.season = when.start < activeSince ? "settled" : "active";
      const list = full.get("recordedBy")!.value;
      const names = list.kind === "list" ? list.items : [];
      await noteNames(names, row);
      const country = full.get("countryCode")!;
      const form: TrapSampleForm = {
        sample_number: fileNumber,
        collectors: names,
        date_start: when.kind === "days" ? when.start : full.get("eventDate")!.fileText,
        date_end: when.kind === "days" ? when.end : "",
        method: full.get("samplingProtocol")!.fileText,
        trap_count: full.get("trapCount")!.fileText,
        specimen_count: full.get("specimenCount")!.fileText,
        latitude: full.get("decimalLatitude")!.fileText,
        longitude: full.get("decimalLongitude")!.fileText,
        uncertainty: full.get("coordinateUncertaintyInMeters")!.fileText,
        country: storeCountry(country.fileText) ?? country.fileText,
        state_province: full.get("stateProvince")!.fileText,
        county: full.get("county")!.fileText,
        locality: full.get("locality")!.fileText,
      };
      const checked = await checkTrapSample(conn, form, null, { staff: true, people });
      if ("problems" in checked) {
        for (const [field, sentence] of Object.entries(checked.problems) as Array<[keyof TrapSampleForm, string]>) {
          if (FORM_COLUMNS[field].some((c) => flagged.has(c))) continue;
          result.problems.push({ reason: "new_row_problem", unit: null, column: FORM_COLUMNS[field][0]!, detail: sentence, cells: [] });
        }
      } else {
        // The program's own numbers are guarded: a number far above the series would move the next one offered for good.
        const sample = checked.sample;
        if (series === null && sample.sample_number.startsWith(PROGRAM_SERIES)) {
          // The file's own new numbers extend the reach, so a run of consecutive numbers is taken whole.
          const newNumbers = rows.filter(({ cells: c }) => text(c, "sampleId") === "").map(({ cells: c }) => text(c, "fieldNumber"));
          series = { highest: seriesReach(await highestSampleNumber(conn), newNumbers) };
        }
        const wrong = series === null ? null : seriesNumberProblem(sample.sample_number, series.highest);
        if (wrong !== null) {
          result.problems.push({ reason: "new_row_problem", unit: null, column: "fieldNumber", detail: wrong, cells: [] });
        } else if (result.problems.length === 0) {
          // What applying would write, with the collectors as the ids they came to.
          const [first] = sample.collector_ids;
          const [lookalike] = await findLookalikes(conn, {
            firstCollectorId: first!,
            dateStart: sample.date_start,
            dateEnd: sample.date_end,
            latitude: sample.latitude,
            longitude: sample.longitude,
          });
          result.create = { form: { ...form, collectors: sample.collector_ids.map(String) }, lookalike: lookalike ?? null, anyway: options.createAnyway?.has(row) ?? false };
        }
      }
      if (fileNumber !== "") (newNumbers.get(fileNumber) ?? newNumbers.set(fileNumber, []).get(fileNumber)!).push(index);
      continue;
    }

    // An existing sample.
    result.season = known === undefined ? "unplaced" : settled.has(id!) ? "settled" : "active";
    if (id === null) wholeRow("no_sample_id", given);
    else if ((timesNamed.get(id) ?? 0) > 1) wholeRow("sample_repeated", String(id));
    else if (known === undefined) wholeRow("no_sample", String(id));
    // The number is checked as it is, and never a change: a spreadsheet that kept the cell as text has not changed it.
    else if (columns.has("fieldNumber") && fileNumber !== known.number) wholeRow("sample_number_disagrees", fileNumber);
    if (result.problems.length > 0) continue;

    const { results: cellResults, full } = evaluateRow(cells, known!.cells);
    const touched = (c: string) => cellResults.get(c)!.differs || cellResults.get(c)!.problem !== null;
    for (const unit of SAMPLES_UNITS) {
      const own = UNIT_COLUMNS[unit].filter((c) => columns.has(c));
      const touchedCells = own.filter(touched);
      if (touchedCells.length === 0) continue;
      const hold = (reason: Why, column: string, detail: string, extra: string[] = []) => {
        const held = [...new Set([...touchedCells, ...extra])];
        result.problems.push({ reason, unit, column, detail, cells: heldCells(full, held) });
      };
      // Coordinates travel as a pair, so a file without one of the two columns cannot say a point.
      const missing = unit === "coordinates" ? ["decimalLatitude", "decimalLongitude"].filter((c) => !columns.has(c)) : [];
      if (missing.length > 0) {
        hold("column_missing", touchedCells[0]!, missing.join(", "));
        continue;
      }
      const list = full.get("recordedBy")!.value;
      if (unit === "collectors" && list.kind === "list") await noteNames(list.items, row);
      const wrong = incomplete(unit, full, today, false);
      if (wrong !== null) {
        hold(wrong.reason, wrong.column, full.get(wrong.column)!.fileText, [wrong.column]);
        continue;
      }
      if (unit === "collectors" && list.kind === "list") {
        // The rule the trap form and staff's collector correction name people by, so that this predicts what a write will do.
        const matched = await matchCollectors(conn, list.items, { staff: true, people });
        if ("problem" in matched) {
          hold("collector_unknown", "recordedBy", matched.problem);
          continue;
        }
      }
      if (!columns.has("sampleVersion")) {
        hold("column_missing", touchedCells[0]!, "sampleVersion");
        continue;
      }
      if (text(cells, "sampleVersion") !== known!.cells.get("sampleVersion")) {
        hold("sample_changed_since", touchedCells[0]!, cellResults.get(touchedCells[0]!)!.fileText);
        continue;
      }
      result.differences.push({
        unit,
        cells: own.map((c) => ({ column: c, was: cellResults.get(c)!.nowText, fileSays: cellResults.get(c)!.fileText, value: cellResults.get(c)!.value, differs: cellResults.get(c)!.differs })),
      });
    }
  }

  // Two new rows with one number would make two trap samples that cannot both exist.
  for (const [number, at] of newNumbers) {
    if (at.length < 2) continue;
    for (const i of at) {
      results[i]!.problems.push({ reason: "new_number_repeated", unit: null, column: "fieldNumber", detail: number, cells: [] });
      results[i]!.create = null;
    }
  }

  const counts = countRows(results);
  const unknownCollectors = [...unknown]
    .map(([name, { rows: at, problem }]) => ({ name, rows: at.size, problem }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: "samples", counts, unrecognised: upload.unrecognised, otherSheets: upload.otherSheets, rows: results, unknownCollectors };
}
