import type { Kysely } from "kysely";
import type { Database } from "../model.js";
import type { Messages } from "./messages/en.js";
import { specimenWorkbook, type Audience } from "./specimen-workbook.js";
import type { DraftPlan } from "./upload-drafts.js";
import { NOTE_COLUMN, type HeldItem, type ParsedUpload, type UploadPlan } from "./upload-plan.js";
import { writeXlsx } from "./xlsx.js";

/**
 * What an upload's page and its file with notes say (beeline-kgyd.7, Peter, 2026-11-18: "Karla has hundreds (at
 * least) of 2025 bees, and this page will be huge. Errors should maybe just come back as a column on the file, in a
 * download."). The page is a few counts and two actions; what is wrong with a row, and what to do about it, is a
 * note on that row of the person's own file, in a column at the left that an upload of the file does not read.
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
const NOTE_WIDTH = 60;

/**
 * The person's file handed back: the same rows and cells, under the same headings, with Beeline's tabs as their
 * own download has them, and a note on every row in a column at the left. A note column already in the file (an
 * earlier file with notes, uploaded again) is replaced, not repeated. An upload of this file reads it as it read
 * the first: the note column is not read and not reported.
 */
export async function notesWorkbook(
  db: Kysely<Database>,
  m: Messages,
  upload: ParsedUpload,
  notes: ReadonlyMap<number, string>,
  audience: Audience,
): Promise<Uint8Array> {
  const keep = upload.header.map((h, at) => ({ h, at })).filter(({ h }) => h !== NOTE_COLUMN);
  const header = [NOTE_COLUMN, ...keep.map(({ h }) => h)];
  const has = (c: string) => header.includes(c);
  const book = await specimenWorkbook(db, m, undefined, audience);
  const o = book.options;
  const rows = upload.rows.map(({ row, cells }) => [notes.get(row) ?? "", ...keep.map(({ at }) => cells.get(at)?.text ?? null)]);
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
