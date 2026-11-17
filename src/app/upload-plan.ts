import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
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
  type SpecimenRow,
} from "./listings.js";

/**
 * Comparing an edited copy of the specimens download with what Beeline says
 * now (beeline-kgyd). Nothing here writes: the plan says what differs and what
 * is held, and a later slice applies it. See
 * docs/architecture/loading-an-edited-download.md for the decisions.
 *
 * What "Beeline says now" is comes from the download itself: the rows of
 * `listSpecimens` through `specimenCsvRow`, so the two cannot drift. Both
 * sides are then normalised, because a spreadsheet rewrites dates, numbers and
 * encodings without anyone editing the cell.
 *
 * A fact is held or offered whole. The units are a specimen's determination,
 * a specimen's disposition, and for a sample its method and dates, its place
 * and its coordinates. If any cell of a unit is held, every differing cell of
 * the unit is held with it and none is offered, so that applying a plan takes
 * a unit and never half of one.
 */

/** A whole file Beeline will not read. */
export const REFUSALS = ["too_large", "not_utf8", "no_specimen_id_column", "repeated_column", "too_many_rows", "no_rows"] as const;
export type Refusal = (typeof REFUSALS)[number];

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ROWS = 20_000;

/**
 * Why a row, a cell or a unit is held. The first four hold the whole row, in
 * this order; the next four are about one cell; the last four hold a unit
 * because of what the file was edited against or how its rows agree.
 */
export const HOLD_REASONS = [
  "no_id",
  "repeated",
  "no_specimen",
  "number_disagrees",
  "number_unreadable",
  "date_unreadable",
  "date_ambiguous",
  "cannot_be_blank",
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
const SPECIMEN_UNITS: readonly SpecimenUnit[] = ["determination", "disposition"];
const SAMPLE_UNITS: readonly SampleUnit[] = ["method_dates", "place", "coordinates"];

type Normalising = "text" | "lower" | "number" | "number_or_text" | "event_date" | "date_identified";
interface ColumnRule {
  kind: ChangeKind;
  norm: Normalising;
  /** Beeline cannot leave it empty, so a blank cell over a value is not a change. */
  required?: boolean;
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
  RULES.set(column, { kind: "not_applied", norm: "text" });
}
const rule = (column: string, kind: ChangeKind, norm: Normalising, required = false) =>
  RULES.set(column, { kind, norm, ...(required ? { required } : {}) });
rule("scientificName", "determination", "text", true);
rule("identificationQualifier", "determination", "lower");
rule("sex", "determination", "lower");
rule("caste", "determination", "lower");
rule("identifiedBy", "determination", "text");
rule("dateIdentified", "determination", "date_identified");
rule("samplingProtocol", "method_dates", "text");
rule("eventDate", "method_dates", "event_date", true);
rule("locality", "place", "text");
rule("decimalLatitude", "coordinates", "number");
rule("decimalLongitude", "coordinates", "number");
rule("coordinateUncertaintyInMeters", "coordinates", "number");
rule("disposition", "disposition", "text");
rule("occurrenceRemarks", "disposition", "text");
// Beeline writes this as true or false; a spreadsheet writes TRUE.
rule("identifiedByExpert", "not_applied", "lower");
// Spreadsheets write 1200 as 1200.0; these are not applied, but a difference of spelling is not one.
rule("minimumElevationInMeters", "not_applied", "number_or_text");
rule("maximumElevationInMeters", "not_applied", "number_or_text");
rule("hostInatTaxonId", "not_applied", "number_or_text");

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
  /** Rows of a specimen whose every cell agrees with Beeline's. */
  unchanged: SeasonSplit;
  /** Rows with at least one cell that differs or is held, whether the unit is offered or not. */
  withChanges: SeasonSplit;
  /** Rows not compared at all (the first four hold reasons). */
  held: SeasonSplit;
}

/** One cell of a unit, as the file gives it and as Beeline has it. */
export interface UnitCell {
  column: string;
  /** What Beeline says now, as the download writes it; "" for none. */
  was: string;
  /** What the file says, with the spreadsheet's quote taken off; "" for none. */
  fileSays: string;
  differs: boolean;
}

/**
 * A specimen's determination or disposition, offered whole: every cell of the
 * unit that the file has, with which differ. At least one does.
 */
export interface SpecimenChange {
  unit: SpecimenUnit;
  /** The row in the file, the header being row 1. */
  row: number;
  specimenId: number;
  fieldNumber: string | null;
  cells: UnitCell[];
}

/** A sample's method and dates, place or coordinates, offered whole, once for the sample. */
export interface SampleChange {
  unit: SampleUnit;
  sampleId: number;
  sampleNumber: string;
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

export interface HeldItem {
  reason: HoldReason;
  /** The first row concerned, the header being row 1. */
  row: number;
  /** Every row concerned, where more than one is. */
  rows: number[];
  specimenId: number | null;
  fieldNumber: string | null;
  sampleNumber: string | null;
  /** The unit held, where a unit is. */
  unit: ChangeKind | null;
  /** The cell that caused the hold, or the first differing cell of the unit. */
  column: string | null;
  /** Every differing cell held with it. */
  columns: string[];
  /** What the file said that could not be used, or what it said about the field number. */
  detail: string;
}

export interface UploadPlan {
  counts: PlanCounts;
  /** A specimen's determination or disposition, offered whole. */
  changes: SpecimenChange[];
  /** A sample's method and dates, place or coordinates, offered whole. */
  sampleChanges: SampleChange[];
  held: HeldItem[];
  /** Differences in columns Beeline does not read from a file. */
  notApplied: CellChange[];
}

export interface ParsedUpload {
  /** Column name to its position in a row. */
  columns: Map<string, number>;
  /** Data rows with their row number in the file (the header is row 1). Blank lines are left out. */
  rows: Array<{ row: number; cells: string[] }>;
}

export type Parsed = { ok: true; upload: ParsedUpload } | { ok: false; refusal: Refusal; detail?: string };
export type PlanResult = { ok: true; plan: UploadPlan; rowCount: number } | { ok: false; refusal: Refusal; detail?: string };

// --- Reading the file ---

/** RFC 4180: quoted cells, doubled quotes inside them, `\n`, `\r\n` or a lone `\r` between records. */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false; // anything seen on this record, so a final newline adds none
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      started = true;
    } else if (ch === ",") {
      record.push(cell);
      cell = "";
      started = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
      started = false;
    } else {
      cell += ch;
      started = true;
    }
  }
  if (started || cell !== "") {
    record.push(cell);
    records.push(record);
  }
  return records;
}

/** Whether a file can be read at all, and if so its columns and rows. */
export function parseUpload(bytes: Uint8Array): Parsed {
  if (bytes.byteLength > MAX_FILE_BYTES) return { ok: false, refusal: "too_large" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, refusal: "not_utf8" };
  }
  if (text.startsWith("﻿")) text = text.slice(1);
  const records = parseCsvRecords(text);
  const header = records[0] ?? [];
  const columns = new Map<string, number>();
  for (const [i, name] of header.entries()) {
    const key = name.trim();
    if (key === "") continue;
    // Two columns of one name: which one is meant cannot be told.
    if (columns.has(key)) return { ok: false, refusal: "repeated_column", detail: key };
    columns.set(key, i);
  }
  if (!columns.has("specimenId")) return { ok: false, refusal: "no_specimen_id_column" };
  const rows: ParsedUpload["rows"] = [];
  records.forEach((cells, i) => {
    if (i === 0 || cells.every((c) => c.trim() === "")) return;
    rows.push({ row: i + 1, cells });
  });
  if (rows.length > MAX_ROWS) return { ok: false, refusal: "too_many_rows" };
  if (rows.length === 0) return { ok: false, refusal: "no_rows" };
  return { ok: true, upload: { columns, rows } };
}

// --- Normalising a cell ---

/** Undo the leading quote the download puts before a cell a spreadsheet would read as a formula (csvCell). */
export function unguard(cell: string): string {
  return /^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell;
}

/** Text as compared: composed Unicode, a non-breaking space as a space, trimmed. */
const clean = (text: string): string => text.replace(/ /g, " ").normalize("NFC").trim();

/** A file's cell as text: the spreadsheet's quote taken off, then cleaned. */
const cellText = (cell: string): string => clean(unguard(cell));

type Key = string | number | null;
type CellHold = "number_unreadable" | "date_unreadable" | "date_ambiguous" | "cannot_be_blank";
type Normalised = { ok: true; key: Key } | { ok: false; reason: CellHold };

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const readNumber = (text: string): number | null => (NUMBER.test(text) && Number.isFinite(Number(text)) ? Number(text) : null);

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** A real calendar day as `YYYY-MM-DD`, or null. */
function validDay(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 1000 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** What a date cell could mean. A reading that needs a guessed century is weak: it counts only where it equals what Beeline says. */
interface Readings {
  strong: Set<string>;
  weak: Set<string>;
}
const readings = (): Readings => ({ strong: new Set(), weak: new Set() });

/** A day as `YYYY-MM-DD`, or `M/D/YYYY` or `D/M/YYYY` (both readings), or either with a two-digit year (weak). */
function dayReadings(text: string): Readings {
  const out = readings();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) {
    const day = validDay(Number(match[1]), Number(match[2]), Number(match[3]));
    if (day !== null) out.strong.add(day);
    return out;
  }
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(text);
  if (match) {
    const [a, b] = [Number(match[1]), Number(match[2])];
    const years = match[3]!.length === 4 ? [Number(match[3])] : [2000 + Number(match[3]), 1900 + Number(match[3])];
    const into = match[3]!.length === 4 ? out.strong : out.weak;
    for (const y of years) {
      for (const day of [validDay(y, a, b), validDay(y, b, a)]) if (day !== null) into.add(day);
    }
  }
  return out;
}

const combine = (left: Readings, right: Readings, out: Readings, join: (a: string, b: string) => string) => {
  for (const a of left.strong) for (const b of right.strong) out.strong.add(join(a, b));
  for (const a of [...left.strong, ...left.weak]) {
    for (const b of [...right.strong, ...right.weak]) {
      if (!(left.strong.has(a) && right.strong.has(b))) out.weak.add(join(a, b));
    }
  }
};

/** A day, or two days with a slash between: `start/end`; one day is the same as that day twice. */
function eventDateReadings(text: string): Readings {
  const out = dayReadings(text);
  // M/D/YYYY has slashes of its own, so try each slash as the one between the days.
  for (let i = text.indexOf("/"); i !== -1; i = text.indexOf("/", i + 1)) {
    combine(dayReadings(text.slice(0, i).trim()), dayReadings(text.slice(i + 1).trim()), out, (a, b) => (a === b ? a : `${a}/${b}`));
  }
  return out;
}

/** `YYYY`, `YYYY-MM`, a day, or a spreadsheet's month: `Jul-2026`, `July 2026`, and `Jul-26` (weak). */
function dateIdentifiedReadings(text: string): Readings {
  const out = dayReadings(text);
  if (/^\d{4}$/.test(text)) out.strong.add(text);
  const month = /^(\d{4})-(\d{2})$/.exec(text);
  if (month && Number(month[2]) >= 1 && Number(month[2]) <= 12) out.strong.add(text);
  const named = /^([A-Za-z]+)\.?[\s-]+(\d{4}|\d{2})$/.exec(text);
  if (named) {
    const word = named[1]!.toLowerCase();
    const at = MONTH_NAMES.findIndex((name) => name === word || (word.length === 3 && name.startsWith(word)));
    if (at !== -1) {
      const mm = String(at + 1).padStart(2, "0");
      if (named[2]!.length === 4) out.strong.add(`${named[2]}-${mm}`);
      else for (const century of [2000, 1900]) out.weak.add(`${century + Number(named[2])}-${mm}`);
    }
  }
  return out;
}

/** Equal to what Beeline says under any reading, else the one reading it has, else why not. */
function resolveDate(found: Readings, nowKey: string | null): Normalised {
  if (nowKey !== null && (found.strong.has(nowKey) || found.weak.has(nowKey))) return { ok: true, key: nowKey };
  if (found.strong.size === 0) return { ok: false, reason: "date_unreadable" };
  if (found.strong.size > 1) return { ok: false, reason: "date_ambiguous" };
  return { ok: true, key: [...found.strong][0]! };
}

function normalise(text: string, how: Normalising, nowKey: Key): Normalised {
  if (text === "") return { ok: true, key: null };
  switch (how) {
    case "text":
      return { ok: true, key: text };
    case "lower":
      return { ok: true, key: text.toLowerCase() };
    case "number": {
      const n = readNumber(text);
      return n === null ? { ok: false, reason: "number_unreadable" } : { ok: true, key: n };
    }
    case "number_or_text":
      return { ok: true, key: readNumber(text) ?? text };
    case "event_date":
      return resolveDate(eventDateReadings(text), typeof nowKey === "string" ? nowKey : null);
    case "date_identified":
      return resolveDate(dateIdentifiedReadings(text), typeof nowKey === "string" ? nowKey : null);
  }
}

/** What Beeline's own text for a cell comes to: it writes dates in their canonical form already. */
function nowKeyOf(text: string, how: Normalising): Key {
  if (text === "") return null;
  if (how === "lower") return text.toLowerCase();
  if (how === "number") return readNumber(text) ?? text;
  if (how === "number_or_text") return readNumber(text) ?? text;
  return text;
}

const sameKey = (a: Key, b: Key): boolean => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-9 : a === b);

/** A field number as the file may have damaged it: identical, or all digits and equal once leading zeros are dropped. */
const sameFieldNumber = (file: string, beeline: string): boolean =>
  file === beeline || (/^\d+$/.test(file) && /^\d+$/.test(beeline) && file.replace(/^0+/, "") === beeline.replace(/^0+/, ""));

/** A value of the download's row as the CSV writer would write it, minus the formula guard. */
const textOf = (value: unknown): string =>
  value === null || value === undefined ? "" : clean(value instanceof Date ? value.toISOString().slice(0, 10) : String(value));

// --- What Beeline says now ---

interface Now {
  row: SpecimenRow;
  /** The download's cells for this specimen, as text, by column name. */
  cells: Map<string, string>;
  specimenVersion: string;
  sampleVersion: string;
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
      SPECIMEN_CSV_HEADER.forEach((name, j) => cells.set(name, textOf(written[j])));
      now.set(row.specimen_id, { row, cells, specimenVersion: specimenVersion(row), sampleVersion: sampleVersion(row) });
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

/** What one cell of one row came to. */
interface CellResult {
  column: string;
  fileText: string;
  nowText: string;
  norm: Normalised;
  differs: boolean;
}

/** One matched row's cells of a sample-level unit, kept until the whole sample is known. */
interface SampleRow {
  row: number;
  specimenId: number;
  fieldNumber: string | null;
  results: Map<string, CellResult>;
  versionCell: string | null;
}

/** The plan for a file's bytes: refused, or what differs and what is held. Writes nothing. */
export async function planUpload(db: Kysely<Database>, bytes: Uint8Array): Promise<PlanResult> {
  const parsed = parseUpload(bytes);
  if (!parsed.ok) return parsed;
  const plan = await comparePlan(db, parsed.upload);
  return { ok: true, plan, rowCount: parsed.upload.rows.length };
}

export async function comparePlan(db: Kysely<Database>, upload: ParsedUpload): Promise<UploadPlan> {
  const { columns, rows } = upload;
  /** A cell of a row; null where the file has no such column or the row is too short to reach it. */
  const cell = (cells: string[], column: string): string | null => {
    const at = columns.get(column);
    return at === undefined ? null : (cells[at] ?? null);
  };
  const hasColumn = (column: string) => columns.has(column);

  // Which specimen each row names.
  const idOf = rows.map(({ cells }) => {
    const text = cellText(cell(cells, "specimenId") ?? "");
    const n = /^\d+$/.test(text) ? Number(text) : 0;
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  });
  const timesNamed = new Map<number, number>();
  for (const id of idOf) if (id !== null) timesNamed.set(id, (timesNamed.get(id) ?? 0) + 1);
  const now = await readNow(db, [...timesNamed.keys()]);
  const facts = await readSampleFacts(db, [...new Set([...now.values()].map((n) => n.row.sample_id))]);

  const counts: PlanCounts = { rows: emptySplit(), unchanged: emptySplit(), withChanges: emptySplit(), held: emptySplit() };
  const season = (sampleId: number | null): keyof SeasonSplit =>
    sampleId === null ? "unplaced" : facts.settled.has(sampleId) ? "settled" : "active";
  const plan: UploadPlan = { counts, changes: [], sampleChanges: [], held: [], notApplied: [] };

  const hold = (
    item: Pick<HeldItem, "reason" | "row" | "specimenId" | "fieldNumber" | "detail"> &
      Partial<Pick<HeldItem, "rows" | "sampleNumber" | "unit" | "column" | "columns">>,
  ) => plan.held.push({ rows: [item.row], sampleNumber: null, unit: null, column: null, columns: [], ...item });

  const bySample = new Map<number, SampleRow[]>();
  const touchedRows: Array<{ sampleId: number; touched: boolean }> = [];

  rows.forEach(({ row, cells }, index) => {
    const id = idOf[index] ?? null;
    const known = id === null ? undefined : now.get(id);
    const sampleId = known?.row.sample_id ?? null;
    const fieldNumber = known?.row.field_number ?? null;
    counts.rows[season(sampleId)]++;

    let reason: HoldReason | null = null;
    let detail = "";
    const rawNumber = cell(cells, "fieldNumber");
    const fileNumber = rawNumber === null ? null : cellText(rawNumber);
    if (id === null) {
      reason = "no_id";
      detail = cellText(cell(cells, "specimenId") ?? "");
    } else if ((timesNamed.get(id) ?? 0) > 1) {
      reason = "repeated";
      detail = String(id);
    } else if (known === undefined) {
      reason = "no_specimen";
      detail = String(id);
    } else if (fileNumber !== null && !sameFieldNumber(fileNumber, known.row.field_number ?? "")) {
      reason = "number_disagrees";
      detail = fileNumber;
    }
    if (reason !== null) {
      counts.held[season(sampleId)]++;
      hold({ reason, row, specimenId: id, fieldNumber, sampleNumber: known?.row.sample_number ?? null, detail });
      return;
    }
    const specimen = known!;
    const specimenId = id!;
    const sample = specimen.row.sample_id;
    const sampleNumber = specimen.row.sample_number;

    // Every compared column the file has, for this row.
    const results = new Map<string, CellResult>();
    for (const column of COMPARED_COLUMNS) {
      const raw = cell(cells, column);
      if (raw === null) continue; // a column the file lacks, or a short row that stops before it, is never a difference
      const r = RULES.get(column)!;
      const fileText = cellText(raw);
      const nowText = specimen.cells.get(column) ?? "";
      const nowKey = nowKeyOf(nowText, r.norm);
      const norm: Normalised =
        r.required && fileText === "" && nowText !== "" ? { ok: false, reason: "cannot_be_blank" } : normalise(fileText, r.norm, nowKey);
      results.set(column, { column, fileText, nowText, norm, differs: norm.ok && !sameKey(norm.key, nowKey) });
    }

    let touched = false;
    for (const result of results.values()) {
      if (!result.norm.ok || result.differs) touched = true;
    }

    for (const [column, result] of results) {
      if (RULES.get(column)!.kind === "not_applied" && result.differs) {
        plan.notApplied.push({ row, specimenId, fieldNumber, column, was: result.nowText, fileSays: result.fileText });
      }
    }

    // A specimen's own units: offered whole or held whole.
    for (const unit of SPECIMEN_UNITS) {
      const present = columnsOfUnit(unit).filter((c) => results.has(c));
      const differing = present.filter((c) => results.get(c)!.differs);
      let held = false;
      for (const column of present) {
        const r = results.get(column)!;
        if (!r.norm.ok) {
          held = true;
          hold({ reason: r.norm.reason, row, specimenId, fieldNumber, sampleNumber, unit, column, columns: [column], detail: r.fileText });
        }
      }
      if (held || differing.length === 0) continue;
      let why: HoldReason | null = null;
      let detail = "";
      if (!hasColumn("specimenVersion")) {
        why = "column_missing";
        detail = "specimenVersion";
      } else if (cellText(cell(cells, "specimenVersion") ?? "") !== specimen.specimenVersion) {
        why = "specimen_changed_since";
        detail = cellText(cell(cells, "specimenVersion") ?? "");
      }
      if (why !== null) {
        hold({ reason: why, row, specimenId, fieldNumber, sampleNumber, unit, column: differing[0]!, columns: differing, detail });
        continue;
      }
      plan.changes.push({
        unit,
        row,
        specimenId,
        fieldNumber,
        cells: present.map((c) => ({ column: c, was: results.get(c)!.nowText, fileSays: results.get(c)!.fileText, differs: results.get(c)!.differs })),
      });
    }

    (bySample.get(sample) ?? bySample.set(sample, []).get(sample)!).push({
      row,
      specimenId,
      fieldNumber,
      results,
      versionCell: hasColumn("sampleVersion") ? cellText(cell(cells, "sampleVersion") ?? "") : null,
    });
    touchedRows.push({ sampleId: sample, touched });
  });

  for (const { sampleId, touched } of touchedRows) counts[touched ? "withChanges" : "unchanged"][season(sampleId)]++;

  // A sample's units: one change for the sample, however many of its rows say it.
  const nowOfSample = new Map<number, Now>();
  for (const n of now.values()) if (!nowOfSample.has(n.row.sample_id)) nowOfSample.set(n.row.sample_id, n);
  for (const [sampleId, sampleRows] of bySample) {
    const sampleNow = nowOfSample.get(sampleId)!;
    const sampleNumber = sampleNow.row.sample_number;
    const allRows = sampleRows.map((r) => r.row);
    for (const unit of SAMPLE_UNITS) {
      const present = columnsOfUnit(unit).filter((c) => hasColumn(c));
      if (present.length === 0) continue;
      const held = (
        reason: HoldReason,
        rowsConcerned: SampleRow[],
        column: string,
        columnsHeld: string[],
        detail: string,
      ) =>
        hold({
          reason,
          row: rowsConcerned[0]!.row,
          rows: rowsConcerned.map((r) => r.row),
          specimenId: null,
          fieldNumber: null,
          sampleNumber,
          unit,
          column,
          columns: columnsHeld,
          detail,
        });
      // A cell that cannot be read holds the unit for the whole sample, so the
      // sample-mates' values are not offered either.
      let bad = false;
      for (const sr of sampleRows) {
        for (const column of present) {
          const r = sr.results.get(column);
          if (r !== undefined && !r.norm.ok) {
            bad = true;
            hold({
              reason: r.norm.reason,
              row: sr.row,
              specimenId: sr.specimenId,
              fieldNumber: sr.fieldNumber,
              sampleNumber,
              unit,
              column,
              columns: [column],
              detail: r.fileText,
            });
          }
        }
      }
      if (bad) continue;
      const differing = present.filter((c) => sampleRows.some((sr) => sr.results.get(c)?.differs));
      if (differing.length === 0) continue;
      const first = sampleRows.find((sr) => sr.results.get(differing[0]!)?.differs) ?? sampleRows[0]!;

      // Coordinates travel as a pair: a latitude without its longitude is not a point.
      if (unit === "coordinates" && (!hasColumn("decimalLatitude") || !hasColumn("decimalLongitude"))) {
        held("column_missing", sampleRows, differing[0]!, differing, hasColumn("decimalLatitude") ? "decimalLongitude" : "decimalLatitude");
        continue;
      }
      const disagreeing = differing.find((c) => {
        const keys = sampleRows.filter((sr) => sr.results.has(c)).map((sr) => (sr.results.get(c)!.norm as { ok: true; key: Key }).key);
        return !keys.every((k) => sameKey(k, keys[0]!));
      });
      if (disagreeing !== undefined) {
        const said = [...new Set(sampleRows.filter((sr) => sr.results.has(disagreeing)).map((sr) => sr.results.get(disagreeing)!.fileText))].map((t) => (t === "" ? "(blank)" : t));
        held("rows_disagree", sampleRows, disagreeing, differing, said.join(" | "));
        continue;
      }
      if (!hasColumn("sampleVersion")) {
        held("column_missing", sampleRows, differing[0]!, differing, "sampleVersion");
        continue;
      }
      if (sampleRows.some((sr) => sr.versionCell !== sampleNow.sampleVersion)) {
        held("sample_changed_since", sampleRows, differing[0]!, differing, first.results.get(differing[0]!)?.fileText ?? "");
        continue;
      }
      plan.sampleChanges.push({
        unit,
        sampleId,
        sampleNumber,
        cells: present.map((c) => {
          const r = (first.results.get(c) ?? sampleRows.find((sr) => sr.results.has(c))?.results.get(c))!;
          return { column: c, was: r.nowText, fileSays: r.fileText, differs: differing.includes(c) };
        }),
        rows: allRows,
        specimensInFile: sampleRows.length,
        specimensInSample: facts.specimens.get(sampleId) ?? 0,
        printed: facts.printed.has(sampleId),
      });
    }
  }
  plan.held.sort((a, b) => a.row - b.row);
  plan.sampleChanges.sort((a, b) => a.rows[0]! - b.rows[0]! || SAMPLE_UNITS.indexOf(a.unit) - SAMPLE_UNITS.indexOf(b.unit));
  return plan;
}

/** Whether a hold is of the whole row, which is then not compared at all. */
export const holdsWholeRow = (reason: HoldReason): boolean => ROW_HOLDS.includes(reason);
