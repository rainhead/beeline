import type { Kysely } from "kysely";
import type { Database } from "../model.js";
import type { Messages } from "./messages/en.js";
import { specimenWorkbook, type Audience } from "./specimen-workbook.js";
import type { DraftPlan } from "./upload-drafts.js";
import { NOTE_COLUMN, type HeldItem, type ParsedUpload, type UploadPlan } from "./upload-plan.js";
import { writeXlsx } from "./xlsx.js";
import { annotateWorkbook } from "./xlsx-annotate.js";

/**
 * What an upload's page and its file with notes say (beeline-kgyd.7, Peter, 2026-11-18: "Karla has hundreds (at
 * least) of 2025 bees, and this page will be huge. Errors should maybe just come back as a column on the file, in a
 * download."). The page is a few counts and two actions; what is wrong with a row, and what to do about it, is a
 * note on that row of the person's own file, in a column added after its last, which an upload of the file does
 * not read.
 */

export interface VolunteerSummary {
  kind: "volunteer";
  rows: number;
  /** Rows whose identification will be saved. */
  ready: number;
  /** Rows with a note saying why they cannot be saved. */
  notSaved: number;
  /** Rows that say what Beeline already has. */
  same: number;
  /** Rows, not counted as not saved, whose grey cells were changed, which are not saved. */
  grey: number;
}

export interface StaffSummary {
  kind: "staff";
  rows: number;
  /** Rows with a difference Beeline could use. */
  differ: number;
  /** Rows with something Beeline cannot use as it stands. */
  cantUse: number;
  same: number;
  /** Rows with a difference only in columns Beeline does not read from this file. */
  grey: number;
}

export interface Noted<S> {
  /** The note for each row of the file, by its row number; "" for none. */
  notes: Map<number, string>;
  summary: S;
}

const rowsOf = (items: readonly HeldItem[]) => {
  const by = new Map<number, HeldItem[]>();
  for (const h of items) for (const row of h.everyRow) (by.get(row) ?? by.set(row, []).get(row)!).push(h);
  return by;
};

/** Why each held item cannot be used, in the note's words, once for each reason. */
function reasonsOf(m: Messages, items: readonly HeldItem[]): string {
  const n = m.uploads.notes;
  const said = new Set<string>();
  for (const h of items) said.add(h.reason === "column_missing" ? n.columnMissing(h.detail) : (n.reason[h.reason] ?? h.reason));
  return [...said].join(" ");
}

const cellsText = (m: Messages, cells: ReadonlyArray<{ column: string; was: string; fileSays: string }>) => {
  const n = m.uploads.notes;
  const said = (v: string) => (v === "" ? n.nothing : `"${v}"`);
  return cells.map((c) => n.cell(c.column, said(c.was), said(c.fileSays))).join("; ");
};

/** A volunteer's file: what will be saved, what cannot be and why, and what is the same. */
export function volunteerNotes(m: Messages, upload: ParsedUpload, drafts: DraftPlan): Noted<VolunteerSummary> {
  const n = m.uploads.notes;
  // An identification Beeline already has is not a fault: the row counts as the same, with no note.
  const held = rowsOf(drafts.plan.held.filter((h) => h.reason !== "already_said"));
  const ready = new Set(drafts.lines.map((l) => l.difference.row));
  const grey = new Set(drafts.plan.notApplied.map((c) => c.row));
  const summary: VolunteerSummary = { kind: "volunteer", rows: upload.rows.length, ready: 0, notSaved: 0, same: 0, grey: 0 };
  const notes = new Map<number, string>();
  for (const { row } of upload.rows) {
    const wrong = held.get(row);
    const parts: string[] = [];
    if (wrong !== undefined) {
      summary.notSaved++;
      parts.push(n.notSaved(reasonsOf(m, wrong)));
    } else {
      summary[ready.has(row) ? "ready" : "same"]++;
      if (grey.has(row)) {
        summary.grey++;
        parts.push(n.grey);
      }
    }
    notes.set(row, parts.join(" "));
  }
  return { notes, summary };
}

/** Staff's file, which changes nothing yet: what differs, cell by cell, and what Beeline could not use. */
export function staffNotes(m: Messages, upload: ParsedUpload, plan: UploadPlan): Noted<StaffSummary> {
  const n = m.uploads.notes;
  const held = rowsOf(plan.held);
  const differs = new Map<number, string[]>();
  const add = (row: number, text: string) => (differs.get(row) ?? differs.set(row, []).get(row)!).push(text);
  for (const d of plan.differences) add(d.row, cellsText(m, d.cells.filter((c) => c.differs)));
  for (const d of plan.sampleDifferences) for (const row of d.everyRow) add(row, cellsText(m, d.cells.filter((c) => c.differs)));
  const notRead = new Map<number, Array<{ column: string; was: string; fileSays: string }>>();
  for (const c of plan.notApplied) (notRead.get(c.row) ?? notRead.set(c.row, []).get(c.row)!).push(c);
  const summary: StaffSummary = { kind: "staff", rows: upload.rows.length, differ: 0, cantUse: 0, same: 0, grey: 0 };
  const notes = new Map<number, string>();
  for (const { row } of upload.rows) {
    const parts: string[] = [];
    const wrong = held.get(row);
    const changed = differs.get(row);
    const ignored = notRead.get(row);
    if (wrong !== undefined) parts.push(n.cantUse(reasonsOf(m, wrong)));
    if (changed !== undefined) parts.push(n.differs(changed.join("; ")));
    if (ignored !== undefined) parts.push(n.notRead(cellsText(m, ignored)));
    if (wrong !== undefined) summary.cantUse++;
    else if (changed !== undefined) summary.differ++;
    else if (ignored !== undefined) summary.grey++;
    else summary.same++;
    notes.set(row, parts.join(" "));
  }
  return { notes, summary };
}

/** How wide the note column is drawn, in characters. */
export const NOTE_WIDTH = 60;

/**
 * The person's own file with the note column added after its last column (src/app/xlsx-annotate.ts), or, where
 * that file cannot be patched safely, a copy Beeline makes (`notesCopy`). A note column already in the file (an
 * earlier file with notes, uploaded again) is written into, not repeated. The patched file is read again before it
 * is handed back, and must give every row the cells it gave before; otherwise the copy is handed back instead.
 */
export async function notesFile(
  db: Kysely<Database>,
  m: Messages,
  original: Uint8Array,
  upload: ParsedUpload,
  notes: ReadonlyMap<number, string>,
  audience: Audience,
  reread: (bytes: Uint8Array) => Promise<ParsedUpload | null>,
): Promise<{ bytes: Uint8Array; copy: boolean }> {
  const existing = upload.header.indexOf(NOTE_COLUMN);
  const patched = annotateWorkbook(original, {
    sheetName: upload.sheetName,
    headerRow: upload.headerRow,
    heading: NOTE_COLUMN,
    values: notes,
    replace: existing === -1 ? null : existing,
    width: NOTE_WIDTH,
  });
  if (patched.ok) {
    const again = await reread(patched.bytes);
    if (again !== null && sameCells(upload, again)) return { bytes: patched.bytes, copy: false };
  }
  return { bytes: await notesCopy(db, m, upload, notes, audience), copy: true };
}

/** Whether two readings of a file give every row the same cells, the note column aside. */
function sameCells(a: ParsedUpload, b: ParsedUpload): boolean {
  if (a.rows.length !== b.rows.length) return false;
  const skip = (u: ParsedUpload) => new Set(u.header.flatMap((h, at) => (h === NOTE_COLUMN ? [at] : [])));
  const [sa, sb] = [skip(a), skip(b)];
  return a.rows.every((row, i) => {
    const other = b.rows[i]!;
    if (other.row !== row.row) return false;
    const cells = (r: typeof row, s: Set<number>) => JSON.stringify([...r.cells].filter(([at]) => !s.has(at)).map(([at, c]) => [at, c.text, c.type]).sort((x, y) => (x[0] as number) - (y[0] as number)));
    return cells(row, sa) === cells(other, sb);
  });
}

/**
 * A copy of the person's file, for one that cannot be patched: the same rows and cells, under the same headings,
 * with Beeline's tabs as their own download has them, and the note column after the last. It is not their file:
 * their own tabs, formatting and checks are not in it, and the page says so.
 */
export async function notesCopy(
  db: Kysely<Database>,
  m: Messages,
  upload: ParsedUpload,
  notes: ReadonlyMap<number, string>,
  audience: Audience,
): Promise<Uint8Array> {
  const keep = upload.header.map((h, at) => ({ h, at })).filter(({ h }) => h !== NOTE_COLUMN);
  const header = [...keep.map(({ h }) => h), NOTE_COLUMN];
  const has = (c: string) => header.includes(c);
  const book = await specimenWorkbook(db, m, undefined, audience);
  const o = book.options;
  const rows = upload.rows.map(({ row, cells }) => [...keep.map(({ at }) => cells.get(at)?.text ?? null), notes.get(row) ?? ""]);
  return writeXlsx(
    {
      sheetName: "specimens",
      header,
      sheets: o.sheets,
      choices: Object.fromEntries(Object.entries(o.choices ?? {}).filter(([c]) => has(c))),
      shadedColumns: [NOTE_COLUMN, ...(o.shadedColumns ?? []).filter(has)],
      boldHeadings: [NOTE_COLUMN, ...(o.boldHeadings ?? []).filter(has)],
      widths: { [NOTE_COLUMN]: NOTE_WIDTH, ...Object.fromEntries(Object.entries(o.widths ?? {}).filter(([c]) => has(c))) },
      wrappedColumns: [NOTE_COLUMN, ...(o.wrappedColumns ?? []).filter(has)],
    },
    rows.map((r) => r.map((v) => (v === "" ? null : v))),
  );
}
