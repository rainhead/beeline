import type { DuckDBConnection } from "@duckdb/node-api";
import { sql, type Kysely } from "kysely";
import { matchCollectors, matchName, readPeople, type MatchedCollector } from "../collector-match.js";
import type { Database } from "../model.js";
import { oregonToday } from "../oregon-today.js";
import { en } from "./messages/en.js";
import type { Messages } from "./messages/index.js";
import { distanceMetres, effortBecomes, predictRefusals, type AreaValues, type ChangeUnit, type CollectorsPreview, type SampleFacts, type UnitChange } from "./samples-upload-change.js";
import { AUTO_NUMBER_PLACEHOLDER, checkTrapSample, findLookalikes, foldNumber, highestSeriesNumber, isProgramSeries, lookAlike, seriesNumberHeldProblem, seriesNumberHolder, seriesNumberProblem, type Lookalike, type LookalikeFacts, type TrapSampleForm } from "../trap-sample.js";
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
  /** What applying the unit would write, worked out and checked: kept with the unit so that applying writes exactly this. */
  change: UnitChange;
  /**
   * The sentence a correction would refuse it with, where that can be known without making it, judged over the kinds
   * ticked. A prediction is shown ("may not be applied") and never enforced: the change is queued all the same, and the
   * job asks the correction itself.
   */
  refusal: string | null;
  /** For a collectors change: whether the first collector changes, how many labels on paper print the old list, and what staff are warned of. */
  collectors?: CollectorsPreview;
  /** The kind of change was ticked, so applying makes it. Not part of the digest: a tick is the person's own answer. */
  chosen: boolean;
  /** For coordinates: how far the point moves, in metres; null where the file or Beeline has no point. */
  metres: number | null;
}

/** The kinds of change that are ticked when the page is first shown: every one but the coordinates, which replace iNaturalist's for good and are the ones a file not made from a fresh download gets wrong in the last digits. */
export const DEFAULT_KINDS: ReadonlySet<SamplesUnit> = new Set(SAMPLES_UNITS.filter((u) => u !== "coordinates"));

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
  /**
   * The number is in the program's series (`OBAS-`), or blank and so to be given the next in it: such a row waits for
   * a person to confirm the series' numbers (Peter, 2026-11-19), and is held unless `obasChecked`.
   */
  obas: boolean;
  /** The number was blank in the file and has been given, so the job makes the sample with exactly this number. */
  assigned: boolean;
  /** The one box "I've checked these OBAS numbers" was ticked. */
  obasChecked: boolean;
}

/** Whether a row with nothing wrong waits for a tick: it looks like an existing sample and was not ticked, or its number is in the series and the numbers were not confirmed. */
export const isHeld = (create: NewRowCreate): boolean => (create.lookalike !== null && !create.anyway) || (create.obas && !create.obasChecked);

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
  /** For an existing sample: the `sampleVersion` the file says, which applying checks the sample still has. */
  fileVersion: string | null;
}

/** What applying would do to existing samples, over the rows with nothing wrong in the way, each count split by season. */
export interface ChangesSummary {
  /** Existing samples with at least one change. */
  samples: SeasonSplit;
  /** For each kind of change, how many samples have one. */
  byUnit: Record<SamplesUnit, SeasonSplit>;
  /** Points that would move, how many by more than 100 metres, and the largest move in metres. */
  points: { moving: SeasonSplit; far: SeasonSplit; largest: number };
  /** Changes of the ticked kinds that a correction would refuse, shown as "may not be applied". */
  mayNot: SeasonSplit;
  /** Collectors changes of the ticked kind that change the first collector, and the labels on paper that print an old list. */
  firstCollector: SeasonSplit;
  reprint: number;
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
  /** New rows with nothing wrong and no number, which are given the next numbers in the series, from the first to the last of them. */
  numbering: { blank: number; from: string | null; to: string | null };
  changes: ChangesSummary;
}

const emptySplit = (): SeasonSplit => ({ active: 0, settled: 0, unplaced: 0 });

/** The counts of a set of rows. Also what the page counts once some rows have an outcome of their own. */
export function countRows(rows: readonly SampleRowResult[]): SamplesCounts {
  const counts: SamplesCounts = { rows: emptySplit(), newReady: emptySplit(), newHeld: emptySplit(), cantUse: emptySplit(), differ: emptySplit(), same: emptySplit() };
  for (const r of rows) {
    counts.rows[r.season]++;
    if (r.problems.length > 0) counts.cantUse[r.season]++;
    else if (r.kind === "new") counts[r.create !== null && isHeld(r.create) ? "newHeld" : "newReady"][r.season]++;
    else if (r.differences.length > 0) counts.differ[r.season]++;
    else counts.same[r.season]++;
  }
  return counts;
}

// --- What Beeline says now ---

export interface Now {
  /** The file's cells for this sample as text, trimmed, by heading. */
  cells: Map<string, string>;
  number: string;
  /** What the corrections' rules ask of the sample. */
  facts: SampleFacts;
}

const CHUNK = 500;

/** What Beeline says of each sample now, as the download would write it for this reader. Also read by the job, to see that a sample is still as the file's version says. */
export async function readNow(db: Kysely<Database>, ids: number[], reader: Reader): Promise<Map<number, Now>> {
  const now = new Map<number, Now>();
  const query = { ...EMPTY_QUERY, scope: ALL };
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const page = await listSamples(db, query, 0, reader, { ids: chunk, limit: chunk.length, offset: 0, withTotal: false, withFlagWords: false, hostNames: "common" });
    for (const r of page.rows) {
      const written = samplesFileRow(r, page);
      const cells = new Map<string, string>();
      SAMPLES_LAYOUT.headings.forEach((name, j) => cells.set(name, (written[j] ?? "").trim()));
      now.set(r.sample_id, {
        cells,
        number: (r.sample_number ?? "").trim(),
        facts: {
          id: r.sample_id,
          number: (r.sample_number ?? "").trim(),
          kind: r.kind === "trap" ? "trap" : "net",
          protocol: (r.protocol ?? "").trim(),
          hasObservation: r.inat_observation_id !== null,
          entered: r.entered,
          effort: r.sampling_effort,
        },
      });
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

/** How far the point the file says is from Beeline's, in metres; null where either has none. */
function pointMoves(full: Map<string, Evaluated>): number | null {
  const lat = full.get("decimalLatitude")!;
  const lon = full.get("decimalLongitude")!;
  if ([lat.nowText, lat.fileText, lon.nowText, lon.fileText].includes("")) return null;
  const was = { latitude: Number(lat.nowText), longitude: Number(lon.nowText) };
  const says = { latitude: Number(lat.fileText), longitude: Number(lon.fileText) };
  return [...Object.values(was), ...Object.values(says)].every(Number.isFinite) ? distanceMetres(was, says) : null;
}

/**
 * What applying a unit would write: the file's values, as the correction takes them. Null where the file cannot say it
 * (a date cell that is not days). The collectors are the people their names came to.
 */
function changeFor(unit: SamplesUnit, full: Map<string, Evaluated>, cells: Map<string, Evaluated>, collectorIds: number[], kind: "net" | "trap"): UnitChange | null {
  const text = (c: string) => full.get(c)!.fileText;
  switch (unit) {
    case "method_dates": {
      const days = full.get("eventDate")!.value;
      if (days.kind !== "days") return null;
      const [nowStart, nowEnd] = full.get("eventDate")!.nowText.split("/");
      const was = full.get("samplingProtocol")!.nowText;
      return {
        unit,
        protocol: text("samplingProtocol"),
        start: days.start,
        end: days.end,
        single: days.start === days.end,
        protocolDiffers: cells.get("samplingProtocol")?.differs === true,
        startDiffers: days.start !== (nowStart ?? ""),
        wasProtocol: was,
        // What the method page's form shows: the end day of a trap sample, blank for a net sample.
        bases: { protocol: was, start: nowStart ?? "", end: kind === "trap" ? (nowEnd ?? nowStart ?? "") : "" },
        effortBecomes: null,
      };
    }
    case "trap_count":
      return { unit, count: text("trapCount") };
    case "specimen_count":
      return { unit, count: text("specimenCount") };
    case "collectors":
      return { unit, ids: collectorIds };
    case "coordinates":
      return { unit, latitude: text("decimalLatitude"), longitude: text("decimalLongitude"), uncertainty: text("coordinateUncertaintyInMeters"), remove: text("decimalLatitude") === "" && text("decimalLongitude") === "" };
    case "area": {
      const file: AreaValues = { country: storeCountry(text("countryCode")) ?? text("countryCode"), state_province: text("stateProvince"), county: text("county") };
      const values: Partial<AreaValues> = {};
      if (cells.get("countryCode")?.differs) values.country = file.country;
      if (cells.get("stateProvince")?.differs) values.state_province = file.state_province;
      if (cells.get("county")?.differs) values.county = file.county;
      return { unit, values, file };
    }
    case "place":
      return { unit, locality: text("locality") };
  }
}

// --- The comparison ---

export interface SamplesPlanOptions {
  today?: string;
  /** Who the file is read as: staff, who see every location, unless said. */
  reader?: Reader;
  /** The rows of the file whose look-alike was ticked "create anyway". */
  createAnyway?: ReadonlySet<number>;
  /** The box "I've checked these OBAS numbers" was ticked. */
  obasChecked?: boolean;
  /** The kinds of change to existing samples that were ticked; `DEFAULT_KINDS` when the page is first shown. */
  kinds?: ReadonlySet<SamplesUnit>;
  /** The catalogue the sentences of predicted refusals come from. */
  messages?: Messages;
}

/**
 * The plan for a parsed samples file. `conn` is the connection the trap form and staff's collector correction match
 * names on: nothing is written on it.
 */
export async function planSamples(db: Kysely<Database>, conn: DuckDBConnection, upload: ParsedUpload, options: SamplesPlanOptions = {}): Promise<SamplesPlan> {
  const today = options.today ?? oregonToday();
  const messages = options.messages ?? en;
  const kinds = options.kinds ?? DEFAULT_KINDS;
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
  /** What each new row's look-alikes are judged by, for the comparison of the file's rows with each other once it is known which will be made. */
  const factsOf = new Map<SampleRowResult, LookalikeFacts>();

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
      fileVersion: isNew ? null : text(cells, "sampleVersion"),
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
      // The program's own numbers have a shape (written exactly, in any spelling that folds to it), and a series number that any other sample has, of any kind, cannot be used again.
      if (numberCell.problem === null && fileNumber !== "") {
        const shape = seriesNumberProblem(fileNumber);
        const holder = shape === null ? await seriesNumberHolder(conn, fileNumber) : null;
        const wrong = shape ?? (holder === null ? null : seriesNumberHeldProblem(fileNumber, holder));
        if (wrong !== null) {
          flagged.add("fieldNumber");
          result.problems.push({ reason: "new_row_problem", unit: null, column: "fieldNumber", detail: wrong, cells: [] });
        }
      }
      const when = full.get("eventDate")!.value;
      if (when.kind === "days") result.season = when.start < activeSince ? "settled" : "active";
      const list = full.get("recordedBy")!.value;
      const names = list.kind === "list" ? list.items : [];
      await noteNames(names, row);
      const country = full.get("countryCode")!;
      const form: TrapSampleForm = {
        // A blank number is given the next in the series when the sample is made; the form is checked with a stand-in.
        sample_number: fileNumber === "" ? AUTO_NUMBER_PLACEHOLDER : fileNumber,
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
      } else if (result.problems.length === 0) {
        // What applying would write, with the collectors as the ids they came to. The number's guard is applied
        // after every row is read, since it needs to know which rows will be made.
        const sample = checked.sample;
        const [first] = sample.collector_ids;
        const facts: LookalikeFacts = { firstCollectorId: first!, dateStart: sample.date_start, dateEnd: sample.date_end, latitude: sample.latitude, longitude: sample.longitude };
        const [found] = await findLookalikes(conn, facts);
        // Someone who is not staff may not see where every sample is: they are told the row is held, and not which sample.
        const lookalike: Lookalike | null = found !== undefined && options.reader !== undefined && !options.reader.staff ? { sampleId: 0, sampleNumber: "" } : (found ?? null);
        factsOf.set(result, facts);
        // A tick counts only for a row that looks like something, so a stale or made-up one cannot switch off a later check.
        result.create = {
          form: { ...form, sample_number: fileNumber, collectors: sample.collector_ids.map(String) },
          lookalike,
          anyway: lookalike !== null && (options.createAnyway?.has(row) ?? false),
          obas: fileNumber === "" || isProgramSeries(fileNumber),
          assigned: false,
          obasChecked: options.obasChecked ?? false,
        };
      }
      // Spellings of the program's own number are one number.
      const key = isProgramSeries(fileNumber) ? foldNumber(fileNumber) : fileNumber;
      if (fileNumber !== "") (newNumbers.get(key) ?? newNumbers.set(key, []).get(key)!).push(index);
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
    /** The units whose change can be queued, before the corrections' refusals are predicted for the row as a whole. */
    const queued: Array<Pick<SampleUnitDifference, "unit" | "cells" | "change" | "metres">> = [];
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
      let collectorIds: number[] = [];
      if (unit === "collectors" && list.kind === "list") {
        // The rule the trap form and staff's collector correction name people by, so that this predicts what a write will do.
        const matched = await matchCollectors(conn, list.items, { staff: true, people });
        if ("problem" in matched) {
          hold("collector_unknown", "recordedBy", matched.problem);
          continue;
        }
        collectorIds = matched.collectors.map((c) => c.person_id);
      }
      if (!columns.has("sampleVersion")) {
        hold("column_missing", touchedCells[0]!, "sampleVersion");
        continue;
      }
      if (text(cells, "sampleVersion") !== known!.cells.get("sampleVersion")) {
        hold("sample_changed_since", touchedCells[0]!, cellResults.get(touchedCells[0]!)!.fileText);
        continue;
      }
      const change = changeFor(unit, full, cellResults, collectorIds, known!.facts.kind);
      if (change === null) {
        hold("column_missing", touchedCells[0]!, UNIT_COLUMNS[unit].join(", "));
        continue;
      }
      queued.push({
        unit,
        cells: own.map((c) => ({ column: c, was: cellResults.get(c)!.nowText, fileSays: cellResults.get(c)!.fileText, value: cellResults.get(c)!.value, differs: cellResults.get(c)!.differs })),
        change,
        metres: unit === "coordinates" ? pointMoves(full) : null,
      });
    }
    // What each correction would say to the row's changes, in the order they are applied, over the kinds ticked.
    if (queued.length > 0) {
      for (const q of queued) if (q.change.unit === "method_dates") q.change.effortBecomes = await effortBecomes(db, known!.facts, q.change);
      const predicted = await predictRefusals({ db, conn, messages }, known!.facts, queued.map((q) => q.change), (u) => kinds.has(u));
      for (const q of queued) {
        const p = predicted.get(q.unit as ChangeUnit);
        result.differences.push({ ...q, refusal: p?.refusal ?? null, collectors: p?.collectors, chosen: kinds.has(q.unit) });
      }
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

  // A row with no number is given the next in the series now, so that the digest and the queued payload carry exactly the
  // numbers the page shows: the next numbers after the highest, leaving out the file's own and any a sample has.
  const blanks = results.filter((r) => r.create !== null && r.create.form.sample_number === "");
  const numbering: SamplesPlan["numbering"] = { blank: 0, from: null, to: null };
  if (blanks.length > 0) {
    const explicit = new Set(results.filter((r) => r.kind === "new" && r.sampleNumber !== null && r.sampleNumber !== "" && isProgramSeries(r.sampleNumber)).map((r) => foldNumber(r.sampleNumber!)));
    let next = (await highestSeriesNumber(conn)) + 1;
    for (const r of blanks) {
      let given: string | null = null;
      while (next <= 99_999) {
        const candidate = `OBAS-${String(next).padStart(5, "0")}`;
        next++;
        if (!explicit.has(foldNumber(candidate)) && (await seriesNumberHolder(conn, candidate)) === null) {
          given = candidate;
          break;
        }
      }
      if (given === null) {
        r.problems.push({ reason: "new_row_problem", unit: null, column: "fieldNumber", detail: "There is no number left in the series past OBAS-99999 to give this row.", cells: [] });
        r.create = null;
        continue;
      }
      r.create!.form.sample_number = given;
      r.create!.assigned = true;
      numbering.blank++;
      numbering.from ??= given;
      numbering.to = given;
    }
  }

  // Rows of the file against each other, in file order, only those that will be made: validity, repeated numbers and
  // numbering are settled above. A row that shares the first collector, overlapping days and a point with an earlier one
  // waits for the same tick as a look-alike in the store.
  const made: Array<{ r: SampleRowResult; facts: LookalikeFacts }> = [];
  for (const r of results) {
    const facts = factsOf.get(r);
    if (r.create === null || facts === undefined) continue;
    if (r.create.lookalike === null) {
      const twin = made.find((e) => lookAlike(e.facts, facts));
      if (twin !== undefined) {
        r.create.lookalike = { sampleId: 0, sampleNumber: twin.r.create!.form.sample_number, fileRow: twin.r.row };
        r.create.anyway = options.createAnyway?.has(r.row) ?? false;
      }
    }
    made.push({ r, facts });
  }

  const counts = countRows(results);
  const unknownCollectors = [...unknown]
    .map(([name, { rows: at, problem }]) => ({ name, rows: at.size, problem }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const split = () => emptySplit();
  const changes: ChangesSummary = {
    samples: split(),
    byUnit: Object.fromEntries(SAMPLES_UNITS.map((u) => [u, split()])) as Record<SamplesUnit, SeasonSplit>,
    points: { moving: split(), far: split(), largest: 0 },
    mayNot: split(),
    firstCollector: split(),
    reprint: 0,
  };
  for (const r of results) {
    if (r.differences.length > 0) changes.samples[r.season]++;
    for (const d of r.differences) {
      changes.byUnit[d.unit][r.season]++;
      // How far a point would move is said whether or not coordinates are ticked: it is what staff tick them by.
      if (d.metres !== null && d.metres > 0) {
        changes.points.moving[r.season]++;
        if (d.metres > 100) changes.points.far[r.season]++;
        changes.points.largest = Math.max(changes.points.largest, d.metres);
      }
      if (!d.chosen) continue;
      if (d.refusal !== null) changes.mayNot[r.season]++;
      if (d.collectors?.firstChanged) changes.firstCollector[r.season]++;
      changes.reprint += d.collectors?.reprint ?? 0;
    }
  }
  return { kind: "samples", counts, unrecognised: upload.unrecognised, otherSheets: upload.otherSheets, rows: results, unknownCollectors, numbering, changes };
}
