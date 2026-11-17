import { sql, type Kysely } from "kysely";
import { DETERMINATION_CASTES, DETERMINATION_QUALIFIERS, DETERMINATION_SEXES, type Database } from "../model.js";
import { DISPOSITIONS } from "../load-dispositions.js";
import {
  ALL,
  EMPTY_QUERY,
  STAFF_READER,
  SPECIMEN_CSV_HEADER,
  hostNamesOnce,
  listSpecimens,
  sampleVersion,
  specimenCsvRow,
  specimenVersion,
  textCell,
  type SpecimenRow,
} from "./listings.js";
import { columnName, readXlsx, type CellType, type XlsxCell, type XLSX_REFUSALS } from "./xlsx.js";

/**
 * Comparing an edited copy of the specimens download with what Beeline says
 * now (beeline-kgyd). Nothing here writes: the plan says what differs and what
 * is held, and a later slice applies it. See
 * docs/architecture/loading-an-edited-download.md for the decisions.
 *
 * The file is the Excel download, every cell of it text, so the comparison is
 * exact: a cell is unchanged when its text is Beeline's text, and otherwise it
 * is read strictly by the kind of column it is in. What Beeline says now comes
 * from the download itself, the rows of `listSpecimens` through
 * `specimenCsvRow` and `textCell`, so the two cannot drift.
 *
 * A fact is held or listed whole. The units are a specimen's identification,
 * a specimen's disposition and remarks, and for a sample its dates and method,
 * its locality and its coordinates. A unit that differs is listed only if it
 * is complete (`UNIT_RULES`, the one place that says what complete is);
 * otherwise every cell of it that differs is held with the reason. Nothing
 * here checks that a name is in the taxonomy or a determiner is a known
 * person: those checks come when changes can be applied.
 */

/** A whole file Beeline will not read. */
export const REFUSALS = [
  "too_large",
  "too_large_unpacked",
  "too_many_rows",
  "not_a_zip",
  "protected_file",
  "not_a_workbook",
  "no_such_sheet",
  "too_wide",
  "unreadable",
  "no_specimen_id_column",
  "repeated_column",
  "no_rows",
] as const;
export type Refusal = (typeof REFUSALS)[number];
// The reader's refusals are all refusals here.
const _readerRefusalsAreRefusals: (typeof XLSX_REFUSALS)[number] extends Refusal ? true : never = true;
void _readerRefusalsAreRefusals;

/** The sheet of the download, and so the sheet that is read. */
export const SHEET_NAME = "specimens";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ROWS = 20_000;

/** Why a row, a cell or a unit is held. */
export const HOLD_REASONS = [
  // The whole row, in this order.
  "no_id",
  "repeated",
  "no_specimen",
  "number_disagrees",
  // A cell that cannot be read.
  "number_unreadable",
  "date_unreadable",
  "converted_to_date",
  "holds_formula",
  "converted_other",
  // A unit that is not complete (UNIT_RULES).
  "name_blank",
  "qualifier_unknown",
  "sex_unknown",
  "caste_unknown",
  "caste_sex",
  "date_identified_future",
  "disposition_unknown",
  "remarks_blank",
  "event_date_blank",
  "event_date_future",
  "coordinates_incomplete",
  "latitude_range",
  "longitude_range",
  "uncertainty_invalid",
  // What the file was edited against, and how its rows agree.
  "specimen_changed_since",
  "sample_changed_since",
  "rows_disagree",
  "column_missing",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];
const ROW_HOLDS: readonly HoldReason[] = ["no_id", "repeated", "no_specimen", "number_disagrees"];

/** What kind of change a cell is, which decides what a later slice may do with it. */
export const CHANGE_KINDS = ["determination", "method_dates", "place", "coordinates", "disposition", "not_applied"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export type SpecimenUnit = "determination" | "disposition";
export type SampleUnit = "method_dates" | "place" | "coordinates";
type Unit = SpecimenUnit | SampleUnit;
const SPECIMEN_UNITS: readonly SpecimenUnit[] = ["determination", "disposition"];
const SAMPLE_UNITS: readonly SampleUnit[] = ["method_dates", "place", "coordinates"];

/** How a column's cell is read when its text is not Beeline's text. */
type Reads =
  | "text" // any text: it differs
  | "word" // text compared ignoring case, read as the lower-case word
  | "number" // a plain decimal number
  | "days" // YYYY-MM-DD, or YYYY-MM-DD/YYYY-MM-DD
  | "moment"; // YYYY-MM-DD, YYYY-MM or YYYY

interface ColumnRule {
  kind: ChangeKind;
  reads: Reads;
}

/**
 * Columns the comparison does not read as differences: the keys that find the
 * row and say what it was edited against, and the field number, which is
 * checked as the row's identity instead.
 */
const NOT_COMPARED = new Set(["specimenId", "specimenVersion", "sampleVersion", "fieldNumber"]);

const RULES = new Map<string, ColumnRule>();
for (const column of SPECIMEN_CSV_HEADER) {
  if (NOT_COMPARED.has(column)) continue;
  RULES.set(column, { kind: "not_applied", reads: "text" });
}
const rule = (column: string, kind: ChangeKind, reads: Reads) => RULES.set(column, { kind, reads });
rule("scientificName", "determination", "text");
rule("identificationQualifier", "determination", "word");
rule("sex", "determination", "word");
rule("caste", "determination", "word");
rule("identifiedBy", "determination", "text");
rule("dateIdentified", "determination", "moment");
rule("samplingProtocol", "method_dates", "text");
rule("eventDate", "method_dates", "days");
rule("locality", "place", "text");
rule("decimalLatitude", "coordinates", "number");
rule("decimalLongitude", "coordinates", "number");
rule("coordinateUncertaintyInMeters", "coordinates", "number");
rule("disposition", "disposition", "text");
rule("occurrenceRemarks", "disposition", "text");
// Beeline writes this as true or false; a spreadsheet may write TRUE. Never applied.
rule("identifiedByExpert", "not_applied", "word");

/** The columns of the download a plan can say something about, in the download's order. */
export const COMPARED_COLUMNS: readonly string[] = SPECIMEN_CSV_HEADER.filter((c) => RULES.has(c));
const columnsOfUnit = (unit: ChangeKind): string[] => COMPARED_COLUMNS.filter((c) => RULES.get(c)!.kind === unit);

export interface SeasonSplit {
  active: number;
  settled: number;
  /** Rows that name no specimen Beeline has, so no sample and no season. */
  unplaced: number;
}

export interface PlanCounts {
  /** Every data row in the file. */
  rows: SeasonSplit;
  /** Rows of a specimen whose every compared cell agrees with Beeline's. */
  unchanged: SeasonSplit;
  /** Rows with at least one cell that differs or is held, whether its unit is held or not. */
  withDifferences: SeasonSplit;
  /** Rows not compared at all (the first four hold reasons). */
  held: SeasonSplit;
}

/** What a cell says, as read by the kind of column it is in. A later step reads this, not the text. */
export type CellValue =
  | { kind: "blank" }
  | { kind: "text"; text: string }
  /** Lower-cased: sex, caste, a qualifier. */
  | { kind: "word"; word: string }
  | { kind: "number"; number: number }
  /** A day is `start` equal to `end`. */
  | { kind: "days"; start: string; end: string }
  /** `date` is as written: `2025`, `2025-07` or `2025-07-14`. */
  | { kind: "moment"; date: string; precision: "year" | "month" | "day" };

/** One cell of a unit, as the file gives it and as Beeline has it. */
export interface UnitCell {
  column: string;
  /** What Beeline says now, as the download writes it; "" for none. */
  was: string;
  /** What the file says, trimmed; "" for none. */
  fileSays: string;
  /** The file's cell as read. */
  value: CellValue;
  differs: boolean;
}

/**
 * A specimen's identification or disposition that differs from Beeline's,
 * complete: every cell of the unit that the file has, with which differ. At
 * least one does.
 */
export interface SpecimenDifference {
  unit: SpecimenUnit;
  /** The row in the file, the header being row 1. */
  row: number;
  specimenId: number;
  sampleId: number;
  /** The determination the row was read from, the one of record when the file was downloaded; null for a specimen with none. */
  determinationId: number | null;
  fieldNumber: string | null;
  cells: UnitCell[];
}

/** A sample's dates and method, locality or coordinates that differ, complete, once for the sample. */
export interface SampleDifference {
  unit: SampleUnit;
  sampleId: number;
  sampleNumber: string;
  sample: SampleLabel;
  cells: UnitCell[];
  /** The rows of the sample that the file holds, the header being row 1. */
  rows: number[];
  specimensInFile: number;
  specimensInSample: number;
  /** Whether any label of the sample is on paper (the printed_sample view). */
  printed: boolean;
}

/** A difference in a column Beeline never reads from a file. */
export interface CellChange {
  row: number;
  specimenId: number;
  fieldNumber: string | null;
  column: string;
  was: string;
  fileSays: string;
}

/** A sample as the listings name it: its number, who collected it and when. */
export interface SampleLabel {
  id: number;
  number: string;
  /** Everyone who collected it, in the label form the listings use. */
  collectors: string[];
  dateStart: Date;
  dateEnd: Date;
}

export interface HeldCell {
  /** Set where rows of a sample say different things: the rows that say this. */
  rows?: number[];
  column: string;
  was: string;
  fileSays: string;
}

export interface HeldItem {
  reason: HoldReason;
  /** The first row concerned, the header being row 1. */
  row: number;
  /** Every row concerned, where more than one is. */
  rows: number[];
  specimenId: number | null;
  fieldNumber: string | null;
  sampleNumber: string | null;
  sample: SampleLabel | null;
  /** The unit held, where a unit is. */
  unit: ChangeKind | null;
  /** The cell that caused the hold, or the first differing cell of the unit. */
  column: string | null;
  /** Every cell held with it. */
  columns: string[];
  /** The same cells, with what Beeline says and what the file says for each. */
  cells: HeldCell[];
  /** What the file said that could not be used, or what it said about the field number. */
  detail: string;
}

/** A column of the file that is not a column of the download, so was not read. */
export interface UnrecognisedColumn {
  /** The column's letter in the spreadsheet. */
  letter: string;
  header: string;
  /** The download column it matches except for case or spaces, which is probably what was meant. */
  probably: string | null;
}

export interface UploadPlan {
  counts: PlanCounts;
  /** Columns of the file that were not read. */
  unrecognised: UnrecognisedColumn[];
  /** Sheets of the workbook that were not read. */
  otherSheets: string[];
  /** A specimen's identification or disposition that differs and is complete. */
  differences: SpecimenDifference[];
  /** A sample's dates and method, locality or coordinates that differ and are complete. */
  sampleDifferences: SampleDifference[];
  held: HeldItem[];
  /** Differences in columns Beeline does not read from a file. */
  notApplied: CellChange[];
}

export interface ParsedUpload {
  /** Column name to its position in a row. */
  columns: Map<string, number>;
  unrecognised: UnrecognisedColumn[];
  /** The names of the workbook's other sheets, which were not read. */
  otherSheets: string[];
  /** Data rows with their row number in the sheet (the header is the first). Rows with nothing in them are left out. */
  rows: Array<{ row: number; cells: Map<number, XlsxCell> }>;
}

export type Parsed = { ok: true; upload: ParsedUpload } | { ok: false; refusal: Refusal; detail?: string };
export type PlanResult = { ok: true; plan: UploadPlan; rowCount: number } | { ok: false; refusal: Refusal; detail?: string };

// --- Reading the file ---

const squashed = (header: string) => header.replace(/\s+/g, "").toLowerCase();

/** Whether a file can be read at all, and if so its columns and rows. */
export function parseUpload(bytes: Uint8Array): Parsed {
  // The sheet the download names, which is the one the person edits; a workbook with only one sheet is read whatever it is called.
  const read = readXlsx(bytes, { maxBytes: MAX_FILE_BYTES, maxRows: MAX_ROWS + 1, sheetName: SHEET_NAME });
  if (!read.ok) return { ok: false, refusal: read.refusal, ...(read.sheets === undefined ? {} : { detail: JSON.stringify(read.sheets) }) };
  const [head, ...body] = read.sheet.rows;
  const known = new Set<string>(SPECIMEN_CSV_HEADER);
  const columns = new Map<string, number>();
  const unrecognised: UnrecognisedColumn[] = [];
  if (head !== undefined) {
    for (const [at, cell] of [...head.cells.entries()].sort((a, b) => a[0] - b[0])) {
      const header = cell.text.trim();
      if (header === "") continue;
      if (known.has(header)) {
        // Two columns of one name: which one is meant cannot be told.
        if (columns.has(header)) return { ok: false, refusal: "repeated_column", detail: header };
        columns.set(header, at);
      } else {
        const probably = SPECIMEN_CSV_HEADER.find((name) => squashed(name) === squashed(header)) ?? null;
        unrecognised.push({ letter: columnName(at), header, probably });
      }
    }
  }
  if (!columns.has("specimenId")) {
    return { ok: false, refusal: "no_specimen_id_column", ...(unrecognised.find((u) => u.probably === "specimenId") ? { detail: "specimenId" } : {}) };
  }
  const rows = body.filter((r) => [...r.cells.values()].some((c) => c.text.trim() !== ""));
  if (rows.length > MAX_ROWS) return { ok: false, refusal: "too_many_rows" };
  if (rows.length === 0) return { ok: false, refusal: "no_rows" };
  return { ok: true, upload: { columns, unrecognised, otherSheets: read.otherSheets, rows } };
}

// --- Reading a cell ---

type CellProblem = "number_unreadable" | "date_unreadable" | "converted_to_date" | "holds_formula" | "converted_other";

/** A cell as the strict reading found it: what it says, or why it cannot be used. */
interface Evaluated {
  column: string;
  /** Beeline's text for the cell, trimmed. */
  nowText: string;
  /** The file's text, trimmed. */
  fileText: string;
  value: CellValue;
  differs: boolean;
  problem: CellProblem | null;
}

const BLANK: CellValue = { kind: "blank" };

/** A line break inside a cell, however the spreadsheet saved it, as a line feed. */
const foldBreaks = (text: string): string => text.replace(/\r\n?/g, "\n");

/** Excel keeps a number to 15 significant digits, so a longer one a person converts or pastes comes back rounded. */
const roundedTo15 = (text: string): number | null => {
  const n = Number(text);
  return PLAIN_NUMBER.test(text) && Number.isFinite(n) ? Number(n.toPrecision(15)) : null;
};

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const NUMBER_WITH_EXPONENT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A real calendar day as `YYYY-MM-DD`, or null. */
function validDay(text: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1000 || date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return text;
}

/** What a cell of this text says, or the problem if it says nothing the column can use. `type` allows an exponent only on a number. */
function readText(reads: Reads, text: string, type: CellType): CellValue | CellProblem {
  if (text === "") return BLANK;
  switch (reads) {
    case "text":
      return { kind: "text", text };
    case "word":
      return { kind: "word", word: text.toLowerCase() };
    case "number": {
      if (!(type === "number" ? NUMBER_WITH_EXPONENT : PLAIN_NUMBER).test(text)) return "number_unreadable";
      const number = Number(text);
      return Number.isFinite(number) ? { kind: "number", number } : "number_unreadable";
    }
    case "days": {
      const m = /^(\d{4}-\d{2}-\d{2})(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(text);
      if (m === null) return "date_unreadable";
      const start = validDay(m[1]!);
      const end = m[2] === undefined ? start : validDay(m[2]);
      return start === null || end === null || end < start ? "date_unreadable" : { kind: "days", start, end };
    }
    case "moment": {
      if (/^\d{4}$/.test(text)) return { kind: "moment", date: text, precision: "year" };
      const month = /^(\d{4})-(\d{2})$/.exec(text);
      if (month !== null) return Number(month[2]) >= 1 && Number(month[2]) <= 12 ? { kind: "moment", date: text, precision: "month" } : "date_unreadable";
      return validDay(text) === null ? "date_unreadable" : { kind: "moment", date: text, precision: "day" };
    }
  }
}

const isProblem = (read: CellValue | CellProblem): read is CellProblem => typeof read === "string";

const sameValue = (a: CellValue, b: CellValue): boolean => {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "blank":
      return true;
    case "text":
      return a.text === (b as typeof a).text;
    case "word":
      return a.word === (b as typeof a).word;
    case "number":
      return a.number === (b as typeof a).number;
    case "days":
      return a.start === (b as typeof a).start && a.end === (b as typeof a).end;
    case "moment":
      return a.date === (b as typeof a).date;
  }
};

const PROBLEM_OF_TYPE: Partial<Record<CellType, CellProblem>> = {
  date: "converted_to_date",
  formula: "holds_formula",
  boolean: "converted_other",
  error: "converted_other",
};

/**
 * One cell of a row against what Beeline says. Exact first: the file's text,
 * trimmed, is Beeline's text, whatever the cell's type. Otherwise the cell is
 * read strictly by the column's kind, and one the spreadsheet converted (to a
 * date, a formula, a boolean or an error) or that is not in the form the
 * column takes is a problem, not a value.
 */
function evaluate(column: string, cell: XlsxCell | undefined, nowText: string): Evaluated {
  const { reads, kind } = RULES.get(column)!;
  const fileText = foldBreaks(cell?.text ?? "").trim();
  const type: CellType = cell?.type ?? "text";
  const was = foldBreaks(nowText).trim();
  const lenient = (): CellValue => {
    const read = readText(reads, fileText, "text");
    return isProblem(read) ? { kind: "text", text: fileText } : read;
  };
  if (fileText === was) return { column, nowText: was, fileText, value: lenient(), differs: false, problem: null };
  // A number the spreadsheet stored, which it keeps to 15 digits: it is Beeline's number where that is Beeline's number to 15 digits.
  // A text cell is not rounded, so a person who types fewer digits is still seen to have changed them.
  if (type === "number" && reads === "number" && roundedTo15(was) === Number(fileText) && roundedTo15(was) !== null) {
    return { column, nowText: was, fileText, value: lenient(), differs: false, problem: null };
  }
  // A column Beeline never reads from a file has no unit to hold: a difference is listed, whatever the cell is.
  if (kind === "not_applied") {
    const read = readText(reads, fileText, "text");
    const value = isProblem(read) ? ({ kind: "text", text: fileText } as const) : read;
    const nowRead = readText(reads, was, "text");
    return { column, nowText: was, fileText, value, differs: isProblem(nowRead) || !sameValue(value, nowRead), problem: null };
  }
  const convertedTo = PROBLEM_OF_TYPE[type];
  if (convertedTo !== undefined) {
    return { column, nowText: was, fileText, value: { kind: "text", text: fileText }, differs: true, problem: convertedTo };
  }
  const read = readText(reads, fileText, type);
  if (isProblem(read)) return { column, nowText: was, fileText, value: { kind: "text", text: fileText }, differs: true, problem: read };
  const nowRead = readText(reads, was, "text");
  return { column, nowText: was, fileText, value: read, differs: isProblem(nowRead) || !sameValue(read, nowRead), problem: null };
}

/** A cell the file does not have, as Beeline's own: what a unit is completed with when the file leaves its column out. */
function fromBeeline(column: string, nowText: string): Evaluated {
  const was = foldBreaks(nowText).trim();
  const read = readText(RULES.get(column)!.reads, was, "text");
  return { column, nowText: was, fileText: was, value: isProblem(read) ? { kind: "text", text: was } : read, differs: false, problem: null };
}

// --- When a unit is complete ---

/** Why a unit is not complete, and the cell that says so. */
interface Incomplete {
  reason: HoldReason;
  column: string;
}

/** A day, `YYYY-MM-DD`, as Oregon reads today. */
export const oregonToday = (now: Date = new Date()): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);

type UnitCells = ReadonlyMap<string, Evaluated>;
const blank = (cells: UnitCells, column: string): boolean => cells.get(column)!.value.kind === "blank";
const wordOf = (cells: UnitCells, column: string): string | null => {
  const v = cells.get(column)!.value;
  return v.kind === "word" ? v.word : v.kind === "text" ? v.text : null;
};
const textOf = (cells: UnitCells, column: string): string => {
  const v = cells.get(column)!.value;
  return v.kind === "text" ? v.text : v.kind === "word" ? v.word : "";
};

/**
 * What each unit needs to be complete, and the only place that says so. Each
 * returns the first thing that is wrong, or null. What the store can hold is
 * the rule where the schema has a CHECK: schema/040 for an identification,
 * schema/030 for a disposition and for coordinates. A name being in the
 * taxonomy, or a determiner being a known person, is not checked: that comes
 * when changes can be applied.
 */
const UNIT_RULES: Record<Unit, (cells: UnitCells, today: string) => Incomplete | null> = {
  determination(cells, today) {
    if (blank(cells, "scientificName")) return { reason: "name_blank", column: "scientificName" };
    const qualifier = wordOf(cells, "identificationQualifier");
    if (qualifier !== null && !(DETERMINATION_QUALIFIERS as readonly string[]).includes(qualifier)) return { reason: "qualifier_unknown", column: "identificationQualifier" };
    const sex = wordOf(cells, "sex");
    if (sex !== null && !(DETERMINATION_SEXES as readonly string[]).includes(sex)) return { reason: "sex_unknown", column: "sex" };
    const caste = wordOf(cells, "caste");
    if (caste !== null && !(DETERMINATION_CASTES as readonly string[]).includes(caste)) return { reason: "caste_unknown", column: "caste" };
    // The CHECK on determination: a drone is male and a male is a drone, where both are said.
    if (caste !== null && sex !== null && (caste === "drone") !== (sex === "male")) return { reason: "caste_sex", column: "caste" };
    const when = cells.get("dateIdentified")!.value;
    if (when.kind === "moment") {
      // The first day of the period said: a year or month that has begun is not in the future.
      const first = when.precision === "year" ? `${when.date}-01-01` : when.precision === "month" ? `${when.date}-01` : when.date;
      if (first > today) return { reason: "date_identified_future", column: "dateIdentified" };
    }
    return null;
  },
  disposition(cells) {
    const disposition = textOf(cells, "disposition");
    if (disposition !== "" && !(DISPOSITIONS as readonly string[]).includes(disposition)) return { reason: "disposition_unknown", column: "disposition" };
    // specimen_disposition.remarks is NOT NULL and not empty: a row without a remark cannot be stored.
    if (blank(cells, "occurrenceRemarks")) return { reason: "remarks_blank", column: "occurrenceRemarks" };
    return null;
  },
  method_dates(cells, today) {
    const days = cells.get("eventDate")!.value;
    if (days.kind === "blank") return { reason: "event_date_blank", column: "eventDate" };
    if (days.kind === "days" && days.end > today) return { reason: "event_date_future", column: "eventDate" };
    return null;
  },
  coordinates(cells) {
    const [latitude, longitude, uncertainty] = ["decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters"].map((c) => cells.get(c)!.value);
    const none = (v: CellValue) => v.kind === "blank";
    // A point is both its numbers, or nothing at all, and an uncertainty is the uncertainty of a point.
    if (none(latitude!) !== none(longitude!) || (none(latitude!) && !none(uncertainty!))) {
      return { reason: "coordinates_incomplete", column: none(latitude!) ? "decimalLatitude" : "decimalLongitude" };
    }
    if (latitude!.kind === "number" && Math.abs(latitude!.number) > 90) return { reason: "latitude_range", column: "decimalLatitude" };
    if (longitude!.kind === "number" && Math.abs(longitude!.number) > 180) return { reason: "longitude_range", column: "decimalLongitude" };
    // The CHECK: positive, and the column is an INTEGER.
    if (uncertainty!.kind === "number" && !(Number.isInteger(uncertainty!.number) && uncertainty!.number > 0)) {
      return { reason: "uncertainty_invalid", column: "coordinateUncertaintyInMeters" };
    }
    return null;
  },
  // Any text, blank included: a blank locality makes the sample follow iNaturalist's again (setPlace in sample-corrections.ts).
  place: () => null,
};

/** The unit's first unusable cell, else the first thing its rule finds wrong. */
function incomplete(unit: Unit, cells: UnitCells, today: string): Incomplete | null {
  for (const column of columnsOfUnit(unit)) {
    const problem = cells.get(column)!.problem;
    if (problem !== null) return { reason: problem, column };
  }
  return UNIT_RULES[unit](cells, today);
}

// --- What Beeline says now ---

interface Now {
  row: SpecimenRow;
  /** The download's cells for this specimen, as text, trimmed, by column name. */
  cells: Map<string, string>;
  specimenVersion: string;
  sampleVersion: string;
  sample: SampleLabel;
}

const CHUNK = 500;

async function readNow(db: Kysely<Database>, ids: number[]): Promise<Map<number, Now>> {
  const now = new Map<number, Now>();
  const hostNames = hostNamesOnce(db);
  const query = { ...EMPTY_QUERY, scope: ALL };
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const page = await listSpecimens(db, query, 0, STAFF_READER, {
      ids: chunk,
      limit: chunk.length,
      offset: 0,
      withTotal: false,
      hostNames: await hostNames(),
    });
    for (const row of page.rows) {
      const written = specimenCsvRow(row, page);
      const cells = new Map<string, string>();
      SPECIMEN_CSV_HEADER.forEach((name, j) => cells.set(name, (textCell(written[j]) ?? "").trim()));
      now.set(row.specimen_id, {
        row,
        cells,
        specimenVersion: specimenVersion(row),
        sampleVersion: sampleVersion(row),
        sample: {
          id: row.sample_id,
          number: row.sample_number,
          collectors: (page.collectors.get(row.sample_id) ?? []).map((c) => c.label),
          dateStart: row.date_start,
          dateEnd: row.date_end,
        },
      });
    }
  }
  return now;
}

interface SampleFacts {
  specimens: Map<number, number>;
  settled: Set<number>;
  printed: Set<number>;
}

async function readSampleFacts(db: Kysely<Database>, sampleIds: number[]): Promise<SampleFacts> {
  const facts: SampleFacts = { specimens: new Map(), settled: new Set(), printed: new Set() };
  for (let i = 0; i < sampleIds.length; i += CHUNK) {
    const list = sql.join(sampleIds.slice(i, i + CHUNK).map((id) => sql`${id}`));
    const counts = await sql<{ sample_id: number; n: bigint }>`
      SELECT sample_id, count(*) AS n FROM specimen WHERE sample_id IN (${list}) GROUP BY sample_id`.execute(db);
    for (const r of counts.rows) facts.specimens.set(Number(r.sample_id), Number(r.n));
    const settled = await sql<{ sample_id: number }>`SELECT sample_id FROM settled_sample WHERE sample_id IN (${list})`.execute(db);
    for (const r of settled.rows) facts.settled.add(Number(r.sample_id));
    const printed = await sql<{ sample_id: number }>`SELECT sample_id FROM printed_sample WHERE sample_id IN (${list})`.execute(db);
    for (const r of printed.rows) facts.printed.add(Number(r.sample_id));
  }
  return facts;
}

// --- The comparison ---

const emptySplit = (): SeasonSplit => ({ active: 0, settled: 0, unplaced: 0 });

/** One matched row's cells, kept until the whole sample is known. */
interface MatchedRow {
  row: number;
  specimenId: number;
  fieldNumber: string | null;
  /** The cells of the columns the file has. */
  results: Map<string, Evaluated>;
  /** Those, and Beeline's own for the columns the file leaves out: what a unit is complete or not with. */
  full: Map<string, Evaluated>;
  versionCell: string | null;
}

/** The plan for a file's bytes: refused, or what differs and what is held. Writes nothing. */
export async function planUpload(db: Kysely<Database>, bytes: Uint8Array, options: { today?: string } = {}): Promise<PlanResult> {
  const parsed = parseUpload(bytes);
  if (!parsed.ok) return parsed;
  const plan = await comparePlan(db, parsed.upload, options);
  return { ok: true, plan, rowCount: parsed.upload.rows.length };
}

const heldCells = (cells: UnitCells, columns: string[]): HeldCell[] =>
  columns.map((c) => ({ column: c, was: cells.get(c)!.nowText, fileSays: cells.get(c)!.fileText }));

export async function comparePlan(db: Kysely<Database>, upload: ParsedUpload, options: { today?: string } = {}): Promise<UploadPlan> {
  const today = options.today ?? oregonToday();
  const { columns, rows } = upload;
  const blankCell: XlsxCell = { text: "", type: "text" };
  /** A cell of a row: a cell that is absent is blank. */
  const cell = (cells: Map<number, XlsxCell>, column: string): XlsxCell => {
    const at = columns.get(column);
    return at === undefined ? blankCell : (cells.get(at) ?? blankCell);
  };
  const text = (cells: Map<number, XlsxCell>, column: string): string => cell(cells, column).text.trim();

  // Which specimen each row names.
  const idOf = rows.map(({ cells }) => {
    const t = text(cells, "specimenId");
    const n = /^\d+$/.test(t) ? Number(t) : 0;
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  });
  const timesNamed = new Map<number, number>();
  for (const id of idOf) if (id !== null) timesNamed.set(id, (timesNamed.get(id) ?? 0) + 1);
  const now = await readNow(db, [...timesNamed.keys()]);
  const facts = await readSampleFacts(db, [...new Set([...now.values()].map((n) => n.row.sample_id))]);

  const counts: PlanCounts = { rows: emptySplit(), unchanged: emptySplit(), withDifferences: emptySplit(), held: emptySplit() };
  const season = (sampleId: number | null): keyof SeasonSplit =>
    sampleId === null ? "unplaced" : facts.settled.has(sampleId) ? "settled" : "active";
  const plan: UploadPlan = { counts, unrecognised: upload.unrecognised, otherSheets: upload.otherSheets, differences: [], sampleDifferences: [], held: [], notApplied: [] };

  const hold = (
    item: Pick<HeldItem, "reason" | "row" | "specimenId" | "fieldNumber" | "detail"> &
      Partial<Pick<HeldItem, "rows" | "sampleNumber" | "sample" | "unit" | "column" | "columns" | "cells">>,
  ) => plan.held.push({ rows: [item.row], sampleNumber: null, sample: null, unit: null, column: null, columns: [], cells: [], ...item });

  const bySample = new Map<number, MatchedRow[]>();
  const touchedRows: Array<{ sampleId: number; touched: boolean }> = [];
  const present = (unit: ChangeKind): string[] => columnsOfUnit(unit).filter((c) => columns.has(c));

  rows.forEach(({ row, cells }, index) => {
    const id = idOf[index] ?? null;
    const known = id === null ? undefined : now.get(id);
    const sampleId = known?.row.sample_id ?? null;
    const fieldNumber = known?.row.field_number ?? null;
    counts.rows[season(sampleId)]++;

    let reason: HoldReason | null = null;
    let detail = "";
    // The field number is checked as it is: a spreadsheet that kept the cell as text has not changed it.
    const fileNumber = columns.has("fieldNumber") ? text(cells, "fieldNumber") : null;
    if (id === null) {
      reason = "no_id";
      detail = text(cells, "specimenId");
    } else if ((timesNamed.get(id) ?? 0) > 1) {
      reason = "repeated";
      detail = String(id);
    } else if (known === undefined) {
      reason = "no_specimen";
      detail = String(id);
    } else if (fileNumber !== null && fileNumber !== (known.row.field_number ?? "").trim()) {
      reason = "number_disagrees";
      detail = fileNumber;
    }
    if (reason !== null) {
      counts.held[season(sampleId)]++;
      // A specimen Beeline does not have has no page to link to; the id is in the detail.
      hold({ reason, row, specimenId: known === undefined ? null : id, fieldNumber, sampleNumber: known?.row.sample_number ?? null, sample: known?.sample ?? null, detail });
      return;
    }
    const specimen = known!;
    const specimenId = id!;
    const sample = specimen.row.sample_id;

    // Every compared column the file has, for this row; Beeline's own for the rest.
    const results = new Map<string, Evaluated>();
    const full = new Map<string, Evaluated>();
    for (const column of COMPARED_COLUMNS) {
      const nowText = specimen.cells.get(column) ?? "";
      if (columns.has(column)) {
        const r = evaluate(column, cell(cells, column), nowText);
        results.set(column, r);
        full.set(column, r);
      } else full.set(column, fromBeeline(column, nowText));
    }
    const touched = [...results.values()].some((r) => r.differs || r.problem !== null);

    for (const [column, result] of results) {
      if (RULES.get(column)!.kind === "not_applied" && result.differs) {
        plan.notApplied.push({ row, specimenId, fieldNumber, column, was: result.nowText, fileSays: result.fileText });
      }
    }

    // A specimen's own units: listed whole or held whole.
    for (const unit of SPECIMEN_UNITS) {
      const own = present(unit);
      const touchedCells = own.filter((c) => results.get(c)!.differs || results.get(c)!.problem !== null);
      if (touchedCells.length === 0) continue;
      const wrong = incomplete(unit, full, today);
      let why: { reason: HoldReason; column: string; detail: string } | null =
        wrong === null ? null : { reason: wrong.reason, column: wrong.column, detail: full.get(wrong.column)!.fileText };
      if (why === null) {
        // The row's own cell says what it was edited against.
        if (!columns.has("specimenVersion")) why = { reason: "column_missing", column: touchedCells[0]!, detail: "specimenVersion" };
        else if (text(cells, "specimenVersion") !== specimen.specimenVersion) {
          why = { reason: "specimen_changed_since", column: touchedCells[0]!, detail: text(cells, "specimenVersion") };
        }
      }
      if (why !== null) {
        const held = [...new Set([...touchedCells, ...(wrong === null ? [] : [wrong.column])])];
        hold({
          reason: why.reason,
          row,
          specimenId,
          fieldNumber,
          sampleNumber: specimen.row.sample_number,
          sample: specimen.sample,
          unit,
          column: why.column,
          columns: held,
          cells: heldCells(full, held),
          detail: why.detail,
        });
        continue;
      }
      plan.differences.push({
        unit,
        row,
        specimenId,
        sampleId: sample,
        determinationId: specimen.row.determination_id ?? null,
        fieldNumber,
        cells: own.map((c) => ({ column: c, was: results.get(c)!.nowText, fileSays: results.get(c)!.fileText, value: results.get(c)!.value, differs: results.get(c)!.differs })),
      });
    }

    (bySample.get(sample) ?? bySample.set(sample, []).get(sample)!).push({
      row,
      specimenId,
      fieldNumber,
      results,
      full,
      versionCell: columns.has("sampleVersion") ? text(cells, "sampleVersion") : null,
    });
    touchedRows.push({ sampleId: sample, touched });
  });

  for (const { sampleId, touched } of touchedRows) counts[touched ? "withDifferences" : "unchanged"][season(sampleId)]++;

  // A sample's units: one difference for the sample, however many of its rows say it.
  const nowOfSample = new Map<number, Now>();
  for (const n of now.values()) if (!nowOfSample.has(n.row.sample_id)) nowOfSample.set(n.row.sample_id, n);
  for (const [sampleId, sampleRows] of bySample) {
    const sampleNow = nowOfSample.get(sampleId)!;
    const sampleNumber = sampleNow.row.sample_number;
    for (const unit of SAMPLE_UNITS) {
      const own = present(unit);
      const touchedBy = (c: string) => sampleRows.filter((sr) => sr.results.get(c)!.differs || sr.results.get(c)!.problem !== null);
      const touchedCells = own.filter((c) => touchedBy(c).length > 0);
      if (touchedCells.length === 0) continue;
      const first = touchedBy(touchedCells[0]!)[0]!;
      /** `shownFrom` is the row whose cells are shown: the one that failed, and by default the first that says something. */
      const heldAs = (reason: HoldReason, rowsConcerned: MatchedRow[], column: string, detail: string, extra: string[] = [], shownFrom: MatchedRow = first, override?: HeldCell[]) => {
        const columnsHeld = [...new Set([...touchedCells, ...extra])];
        hold({
          reason,
          row: rowsConcerned[0]!.row,
          rows: rowsConcerned.map((r) => r.row),
          specimenId: rowsConcerned.length === 1 && reason !== "rows_disagree" ? rowsConcerned[0]!.specimenId : null,
          fieldNumber: rowsConcerned.length === 1 && reason !== "rows_disagree" ? rowsConcerned[0]!.fieldNumber : null,
          sampleNumber,
          sample: sampleNow.sample,
          unit,
          column,
          columns: columnsHeld,
          cells: override ?? heldCells(shownFrom.full, columnsHeld),
          detail,
        });
      };
      // Coordinates travel as a pair, so a file without one of the two columns cannot say a point.
      const missing = unit === "coordinates" ? ["decimalLatitude", "decimalLongitude"].filter((c) => !columns.has(c)) : [];
      if (missing.length > 0) {
        heldAs("column_missing", sampleRows, touchedCells[0]!, missing.join(", "));
        continue;
      }
      // A cell that cannot be used, or a unit that is not complete, holds it for the whole sample.
      let bad = false;
      for (const sr of sampleRows) {
        const wrong = incomplete(unit, sr.full, today);
        if (wrong !== null) {
          bad = true;
          heldAs(wrong.reason, [sr], wrong.column, sr.full.get(wrong.column)!.fileText, [wrong.column], sr);
        }
      }
      if (bad) continue;
      const differing = touchedCells.filter((c) => touchedBy(c).some((sr) => sr.results.get(c)!.differs));
      const disagreeing = differing.find((c) => !sampleRows.every((sr) => sameValue(sr.results.get(c)!.value, sampleRows[0]!.results.get(c)!.value)));
      if (disagreeing !== undefined) {
        const said = [...new Set(sampleRows.map((sr) => sr.results.get(disagreeing)!.fileText))].map((t) => (t === "" ? "(blank)" : t));
        // What each row says, so the person can see which rows differ: one entry for each thing said, with its rows.
        const byText = new Map<string, number[]>();
        for (const sr of sampleRows) {
          const t = sr.results.get(disagreeing)!.fileText;
          byText.set(t, [...(byText.get(t) ?? []), sr.row]);
        }
        const each: HeldCell[] = [...byText].map(([fileSays, rowsSaying]) => ({
          column: disagreeing,
          was: sampleRows[0]!.results.get(disagreeing)!.nowText,
          fileSays,
          rows: rowsSaying,
        }));
        heldAs("rows_disagree", sampleRows, disagreeing, said.join(" | "), [], first, each);
        continue;
      }
      if (!columns.has("sampleVersion")) {
        heldAs("column_missing", sampleRows, touchedCells[0]!, "sampleVersion");
        continue;
      }
      if (sampleRows.some((sr) => sr.versionCell !== sampleNow.sampleVersion)) {
        heldAs("sample_changed_since", sampleRows, touchedCells[0]!, first.results.get(touchedCells[0]!)!.fileText);
        continue;
      }
      plan.sampleDifferences.push({
        unit,
        sampleId,
        sampleNumber,
        sample: sampleNow.sample,
        cells: own.map((c) => {
          const r = first.results.get(c)!;
          return { column: c, was: r.nowText, fileSays: r.fileText, value: r.value, differs: differing.includes(c) };
        }),
        rows: sampleRows.map((r) => r.row),
        specimensInFile: sampleRows.length,
        specimensInSample: facts.specimens.get(sampleId) ?? 0,
        printed: facts.printed.has(sampleId),
      });
    }
  }
  plan.held.sort((a, b) => a.row - b.row);
  plan.sampleDifferences.sort((a, b) => a.rows[0]! - b.rows[0]! || SAMPLE_UNITS.indexOf(a.unit) - SAMPLE_UNITS.indexOf(b.unit));
  return plan;
}

/** Whether a hold is of the whole row, which is then not compared at all. */
export const holdsWholeRow = (reason: HoldReason): boolean => ROW_HOLDS.includes(reason);
