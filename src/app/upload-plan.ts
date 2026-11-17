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
 * quotes without anyone editing the cell.
 */

/** A whole file Beeline will not read. */
export const REFUSALS = ["too_large", "not_utf8", "no_specimen_id_column", "too_many_rows", "no_rows"] as const;
export type Refusal = (typeof REFUSALS)[number];

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ROWS = 20_000;

/**
 * Why a row, or one of its cells, is not compared or not offered as a change.
 * The first four hold the whole row, in this order; the rest hold one cell, or
 * one sample's column.
 */
export const HOLD_REASONS = [
  "no_id",
  "repeated",
  "no_specimen",
  "number_disagrees",
  "number_unreadable",
  "date_unreadable",
  "determination_changed_since",
  "sample_changed_since",
  "rows_disagree",
  "column_missing",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];
const ROW_HOLDS: readonly HoldReason[] = ["no_id", "repeated", "no_specimen", "number_disagrees"];

/** What kind of change a cell is, which decides what a later slice may do with it. */
export const CHANGE_KINDS = ["determination", "method_dates", "place", "coordinates", "disposition", "not_applied"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
const SAMPLE_KINDS: readonly ChangeKind[] = ["method_dates", "place", "coordinates"];

type Normalising = "text" | "lower" | "number" | "number_or_text" | "event_date" | "date_identified";
interface ColumnRule {
  kind: ChangeKind;
  norm: Normalising;
}

/**
 * Columns the comparison does not read as differences: the keys that find the
 * row and say what it was edited against, and the field number, which is
 * checked as the row's identity instead.
 */
const NOT_COMPARED = new Set(["specimenId", "determinationId", "sampleVersion", "fieldNumber"]);

const RULES = new Map<string, ColumnRule>();
for (const column of SPECIMEN_CSV_HEADER) {
  if (NOT_COMPARED.has(column)) continue;
  RULES.set(column, { kind: "not_applied", norm: "text" });
}
const rule = (column: string, kind: ChangeKind, norm: Normalising) => RULES.set(column, { kind, norm });
rule("scientificName", "determination", "text");
rule("identificationQualifier", "determination", "lower");
rule("sex", "determination", "lower");
rule("caste", "determination", "lower");
rule("identifiedBy", "determination", "text");
rule("dateIdentified", "determination", "date_identified");
rule("samplingProtocol", "method_dates", "text");
rule("eventDate", "method_dates", "event_date");
rule("locality", "place", "text");
rule("decimalLatitude", "coordinates", "number");
rule("decimalLongitude", "coordinates", "number");
rule("coordinateUncertaintyInMeters", "coordinates", "number");
rule("disposition", "disposition", "text");
rule("occurrenceRemarks", "disposition", "text");
// Spreadsheets write 1200 as 1200.0; these are not applied, but a difference of spelling is not one.
rule("minimumElevationInMeters", "not_applied", "number_or_text");
rule("maximumElevationInMeters", "not_applied", "number_or_text");
rule("hostInatTaxonId", "not_applied", "number_or_text");

/** The columns of the download a plan can say something about, in the download's order. */
export const COMPARED_COLUMNS: readonly string[] = SPECIMEN_CSV_HEADER.filter((c) => RULES.has(c));

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
  /** Rows with at least one cell that differs, whether it is offered as a change or held. */
  withChanges: SeasonSplit;
  /** Rows not compared at all (the first four hold reasons). */
  held: SeasonSplit;
}

export interface CellChange {
  /** The row in the file, the header being row 1. */
  row: number;
  specimenId: number;
  fieldNumber: string | null;
  column: string;
  kind: ChangeKind;
  /** What Beeline says now, as the download writes it; "" for none. */
  was: string;
  /** What the file says, after taking out the spreadsheet's quote; "" for none. */
  fileSays: string;
}

export interface SampleChange {
  sampleId: number;
  sampleNumber: string;
  column: string;
  kind: ChangeKind;
  was: string;
  fileSays: string;
  /** The rows of the sample that the file holds, the header being row 1. */
  rows: number[];
  specimensInFile: number;
  specimensInSample: number;
  /** Whether any label of the sample is on paper (the printed_sample view). */
  printed: boolean;
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
  column: string | null;
  /** What the file said that could not be used, or what it said about the field number. */
  detail: string;
}

export interface UploadPlan {
  counts: PlanCounts;
  /** Differences of one specimen's own: its determination and its disposition. */
  changes: CellChange[];
  /** Differences of a sample's, one for each sample and column. */
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

export type Parsed = { ok: true; upload: ParsedUpload } | { ok: false; refusal: Refusal };
export type PlanResult = { ok: true; plan: UploadPlan; rowCount: number } | { ok: false; refusal: Refusal };

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
  header.forEach((name, i) => {
    const key = name.trim();
    if (key !== "" && !columns.has(key)) columns.set(key, i);
  });
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

/** A cell as text: the spreadsheet's quote taken off, then trimmed. */
const cellText = (cell: string | undefined): string => unguard(cell ?? "").trim();

type Key = string | number | null;
type Normalised = { ok: true; key: Key } | { ok: false; reason: "number_unreadable" | "date_unreadable" };

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const readNumber = (text: string): number | null => (NUMBER.test(text) && Number.isFinite(Number(text)) ? Number(text) : null);

/** A real calendar day as `YYYY-MM-DD`, from `YYYY-MM-DD` or `M/D/YYYY`; null for anything else. */
function readDay(text: string): string | null {
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text))) [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** A day, or two days with a slash between: `start/end`, where one day is the same as that day twice. */
function readEventDate(text: string): string | null {
  const one = readDay(text);
  if (one !== null) return one;
  // M/D/YYYY has slashes of its own, so try each slash as the one between the days.
  for (let i = text.indexOf("/"); i !== -1; i = text.indexOf("/", i + 1)) {
    const start = readDay(text.slice(0, i).trim());
    const end = readDay(text.slice(i + 1).trim());
    if (start !== null && end !== null) return start === end ? start : `${start}/${end}`;
  }
  return null;
}

/** `YYYY`, `YYYY-MM`, `YYYY-MM-DD` or `M/D/YYYY`, which is a day. */
function readDateIdentified(text: string): string | null {
  if (/^\d{4}$/.test(text)) return text;
  const month = /^(\d{4})-(\d{2})$/.exec(text);
  if (month) return Number(month[2]) >= 1 && Number(month[2]) <= 12 ? text : null;
  return readDay(text);
}

function normalise(text: string, how: Normalising): Normalised {
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
    case "event_date": {
      const day = readEventDate(text);
      return day === null ? { ok: false, reason: "date_unreadable" } : { ok: true, key: day };
    }
    case "date_identified": {
      const day = readDateIdentified(text);
      return day === null ? { ok: false, reason: "date_unreadable" } : { ok: true, key: day };
    }
  }
}

const sameKey = (a: Key, b: Key): boolean => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-9 : a === b);

/** A value of the download's row as the CSV writer would write it, minus the formula guard. */
const textOf = (value: unknown): string =>
  value === null || value === undefined ? "" : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim();

// --- What Beeline says now ---

interface Now {
  row: SpecimenRow;
  /** The download's cells for this specimen, as text, by column name. */
  cells: Map<string, string>;
  version: string;
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
      now.set(row.specimen_id, { row, cells, version: sampleVersion(row) });
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

interface Participant {
  row: number;
  key: Key;
  fileText: string;
  nowText: string;
  differs: boolean;
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
  const cell = (cells: string[], column: string): string | null => {
    const at = columns.get(column);
    return at === undefined ? null : (cells[at] ?? "");
  };

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

  const hold = (item: Omit<HeldItem, "rows" | "sampleNumber"> & { rows?: number[]; sampleNumber?: string | null }) =>
    plan.held.push({ rows: [item.row], sampleNumber: null, ...item });

  /** Per sample, per sample-level column, what every matched row of the sample says. */
  const bySample = new Map<number, Map<string, Participant[]>>();
  const rowsOfSample = new Map<number, number[]>();
  const touchedRows: Array<{ sampleId: number; touched: boolean }> = [];

  const hasDeterminationId = columns.has("determinationId");
  const hasFieldNumber = columns.has("fieldNumber");
  const hasSampleVersion = columns.has("sampleVersion");

  rows.forEach(({ row, cells }, index) => {
    const id = idOf[index] ?? null;
    const known = id === null ? undefined : now.get(id);
    const sampleId = known?.row.sample_id ?? null;
    const fieldNumber = known?.row.field_number ?? null;
    counts.rows[season(sampleId)]++;

    let reason: HoldReason | null = null;
    let detail = "";
    if (id === null) {
      reason = "no_id";
      detail = cellText(cell(cells, "specimenId") ?? "");
    } else if ((timesNamed.get(id) ?? 0) > 1) {
      reason = "repeated";
      detail = String(id);
    } else if (known === undefined) {
      reason = "no_specimen";
      detail = String(id);
    } else if (hasFieldNumber && cellText(cell(cells, "fieldNumber") ?? "") !== (known.row.field_number ?? "")) {
      reason = "number_disagrees";
      detail = cellText(cell(cells, "fieldNumber") ?? "");
    }
    if (reason !== null) {
      counts.held[season(sampleId)]++;
      hold({ reason, row, specimenId: id, fieldNumber, sampleNumber: known?.row.sample_number ?? null, column: null, detail });
      return;
    }
    const specimen = known!;
    const sample = specimen.row.sample_id;
    (rowsOfSample.get(sample) ?? rowsOfSample.set(sample, []).get(sample)!).push(row);

    let touched = false;
    const determinationStale = hasDeterminationId
      ? cellText(cell(cells, "determinationId") ?? "") !== String(specimen.row.determination_id ?? "")
      : null;

    for (const column of COMPARED_COLUMNS) {
      const r = RULES.get(column)!;
      const fileCell = cell(cells, column);
      if (fileCell === null) continue; // a column the file lacks is never a difference
      const fileText = cellText(fileCell);
      const nowText = specimen.cells.get(column) ?? "";
      const file = normalise(fileText, r.norm);
      const sampleLevel = SAMPLE_KINDS.includes(r.kind);
      if (!file.ok) {
        touched = true;
        hold({ reason: file.reason, row, specimenId: id, fieldNumber, sampleNumber: specimen.row.sample_number, column, detail: fileText });
        continue;
      }
      const here = normalise(nowText, r.norm);
      const nowKey: Key = here.ok ? here.key : nowText;
      const differs = !sameKey(file.key, nowKey);
      if (sampleLevel) {
        const columnsOfSample = bySample.get(sample) ?? bySample.set(sample, new Map()).get(sample)!;
        const list = columnsOfSample.get(column) ?? columnsOfSample.set(column, []).get(column)!;
        list.push({
          row,
          key: file.key,
          fileText,
          nowText,
          differs,
          versionCell: hasSampleVersion ? cellText(cell(cells, "sampleVersion") ?? "") : null,
        });
        if (differs) touched = true;
        continue;
      }
      if (!differs) continue;
      touched = true;
      const change: CellChange = { row, specimenId: id!, fieldNumber, column, kind: r.kind, was: nowText, fileSays: fileText };
      if (r.kind === "not_applied") plan.notApplied.push(change);
      else if (r.kind === "determination" && determinationStale === null) {
        hold({ reason: "column_missing", row, specimenId: id, fieldNumber, sampleNumber: specimen.row.sample_number, column, detail: "determinationId" });
      } else if (r.kind === "determination" && determinationStale) {
        hold({
          reason: "determination_changed_since",
          row,
          specimenId: id,
          fieldNumber,
          sampleNumber: specimen.row.sample_number,
          column,
          detail: fileText,
        });
      } else plan.changes.push(change);
    }
    // A row whose sample-level cell differs counts as having changes even
    // when the sample's column is held below: the file says something else.
    touchedRows.push({ sampleId: sample, touched });
  });

  for (const { sampleId, touched } of touchedRows) counts[touched ? "withChanges" : "unchanged"][season(sampleId)]++;

  // Sample-level columns: one change for the sample, however many of its rows say it.
  const nowOfSample = new Map<number, Now>();
  for (const n of now.values()) if (!nowOfSample.has(n.row.sample_id)) nowOfSample.set(n.row.sample_id, n);
  for (const [sampleId, byColumn] of bySample) {
    const sampleNow = nowOfSample.get(sampleId)!;
    for (const column of COMPARED_COLUMNS) {
      const people = byColumn.get(column);
      if (people === undefined || !people.some((p) => p.differs)) continue;
      const r = RULES.get(column)!;
      const first = people.find((p) => p.differs)!;
      const sampleNumber = sampleNow.row.sample_number;
      const allRows = people.map((p) => p.row);
      const heldFor = (reason: HoldReason, detail: string) =>
        hold({ reason, row: first.row, rows: allRows, specimenId: null, fieldNumber: null, sampleNumber, column, detail });
      if (!people.every((p) => sameKey(p.key, first.key))) {
        heldFor("rows_disagree", [...new Set(people.map((p) => p.fileText))].map((t) => (t === "" ? "(blank)" : t)).join(" | "));
        continue;
      }
      if (!hasSampleVersion) {
        heldFor("column_missing", "sampleVersion");
        continue;
      }
      if (people.some((p) => p.versionCell !== sampleNow.version)) {
        heldFor("sample_changed_since", first.fileText);
        continue;
      }
      plan.sampleChanges.push({
        sampleId,
        sampleNumber,
        column,
        kind: r.kind,
        was: first.nowText,
        fileSays: first.fileText,
        rows: rowsOfSample.get(sampleId) ?? allRows,
        specimensInFile: (rowsOfSample.get(sampleId) ?? []).length,
        specimensInSample: facts.specimens.get(sampleId) ?? 0,
        printed: facts.printed.has(sampleId),
      });
    }
  }
  plan.held.sort((a, b) => a.row - b.row);
  plan.sampleChanges.sort((a, b) => a.rows[0]! - b.rows[0]! || COMPARED_COLUMNS.indexOf(a.column) - COMPARED_COLUMNS.indexOf(b.column));
  return plan;
}

/** Whether a hold is of the whole row, which is then not compared at all. */
export const holdsWholeRow = (reason: HoldReason): boolean => ROW_HOLDS.includes(reason);

/**
 * The name a kept file is given on disk: the last part of whatever path the
 * browser sent, with anything but letters, digits, dots, dashes and
 * underscores replaced, and no leading dot. What the uploader called the file
 * is kept apart, in `upload.file_name`.
 */
export function safeBaseName(fileName: string): string {
  const last = fileName.split(/[\\/]/).pop() ?? "";
  const safe = last.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 100);
  return safe === "" ? "upload.csv" : safe;
}
