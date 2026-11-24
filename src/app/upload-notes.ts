import type { Kysely } from "kysely";
import type { Database } from "../model.js";
import type { Messages } from "./messages/en.js";
import { samplesWorkbook } from "./sample-workbook.js";
import { type OutcomeRow } from "./samples-upload-apply.js";
import { readQueuedUnit } from "./samples-upload-change.js";
import { SAMPLES_UNITS, countRows, isHeld, type SampleRowResult, type SamplesCounts, type SamplesPlan, type SamplesUnit, type UnknownCollector } from "./samples-upload-plan.js";
import { specimenWorkbook, type Audience } from "./specimen-workbook.js";
import type { OtherProgram } from "./upload-atlases.js";
import type { DraftPlan } from "./upload-drafts.js";
import { NOTE_COLUMN, type HeldItem, type ParsedUpload, type SeasonSplit, type UploadPlan } from "./upload-plan.js";
import { writeXlsx, type XlsxWriterOptions } from "./xlsx.js";
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
  /** Programs the person does not lead whose specimens' disposition or remarks the file changes, with counts. */
  otherPrograms: OtherProgram[];
}

/** A new row that looks like an existing sample, which waits for its tick. */
export interface HeldRow {
  row: number;
  /** The number the file gives the new row. */
  sampleNumber: string;
  /** The existing sample it looks like. */
  likeId: number;
  likeNumber: string;
  /** The look-alike is an earlier row of this same file, not a sample in Beeline. */
  likeRow: number | null;
  /** "Create anyway" was ticked on the page this was made from, and is shown ticked again when the page is shown after a refusal. */
  ticked: boolean;
}

/** What applying did, counted over what it queued. */
export interface OutcomeSummary {
  /** New rows and changes queued for the job, whatever became of them. */
  total: number;
  /** Of them, still waiting for the job. */
  pending: number;
  created: number;
  /** Of the samples made, those since deleted. */
  deleted: number;
  /** New rows refused or left alone: not created. */
  notCreated: number;
  /** Changes to existing samples: how many samples had one made, how many changes were made, were already as the file says, were not applied, and were not chosen. */
  changes: { samples: SeasonSplit; applied: SeasonSplit; unchanged: SeasonSplit; notApplied: SeasonSplit; notChosen: SeasonSplit };
}

/** What applying would do to existing samples, for the page before the file is applied. */
export interface ChangesPreview {
  /** Samples with a change. */
  samples: SeasonSplit;
  /** Each kind of change that some sample has, how many samples have one, and whether it is ticked. In the order the page lists them. */
  kinds: Array<{ unit: SamplesUnit; samples: SeasonSplit; chosen: boolean }>;
  points: { moving: SeasonSplit; far: SeasonSplit; largest: number };
  /** Changes of the ticked kinds that a correction may refuse: shown, and tried all the same. */
  mayNot: SeasonSplit;
  /** Collectors changes of the ticked kind that give a sample another first collector, and the labels on paper that print an old list. */
  firstCollector: SeasonSplit;
  reprint: number;
}

/** The rows whose number is in the OBAS series, or blank, which wait for the one box "I've checked these OBAS numbers". */
export interface ObasSummary {
  rows: number;
  /** The lowest and highest numbers the file gives, if it gives any. */
  lowest: string | null;
  highest: string | null;
  /** The box was ticked, and is shown ticked again when the page is shown after a refusal. */
  checked: boolean;
  /** Rows with no number, which are given the next numbers in the series, from this one as it stands. */
  blank: number;
  from: string | null;
  to: string | null;
}

export interface SamplesSummary {
  kind: "samples";
  rows: number;
  /** Over the rows that have no outcome of their own: once a file is applied, its rows are counted in `outcomes`. */
  counts: SamplesCounts;
  /** Names in the file that match nobody, or several people, each once. */
  unknownCollectors: UnknownCollector[];
  /** New rows that wait to be ticked, before the file is applied. */
  held: HeldRow[];
  /** What applying did, once it was applied. */
  outcomes: OutcomeSummary | null;
  /** Rows to be made, with nothing wrong, whose number is in the OBAS series or blank. Null once the file is applied. */
  obas: ObasSummary | null;
  /** Changes to existing samples, before the file is applied. */
  changes: ChangesPreview | null;
  /** New rows to be made that are in an active season and have specimens, whose labels can be printed as soon as they are made. */
  labelsReady: number;
  /** Programs the person does not lead whose records applying would change, with counts: applying asks once to confirm. Empty once the file is applied. */
  otherPrograms: OtherProgram[];
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
  const summary: StaffSummary = { kind: "staff", rows: upload.rows.length, differ: 0, cantUse: 0, same: 0, grey: 0, otherPrograms: plan.otherPrograms ?? [] };
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

/**
 * The samples file, which changes nothing yet: what differs, cell by cell, which rows would become new trap samples,
 * and what Beeline could not use, each as a note on its row. A row that has both a difference and something it cannot
 * use says both. `redact` is for a reader who is not staff, who is not told which sample a held row looks like.
 */
export function samplesNotes(m: Messages, upload: ParsedUpload, plan: SamplesPlan, outcomes: readonly OutcomeRow[] = [], redact = false): Noted<SamplesSummary> {
  const n = m.uploads.notes;
  const byRow = new Map<number, SampleRowResult>(plan.rows.map((r) => [r.row, r]));
  const reasons = (r: SampleRowResult): string => {
    const said = new Set<string>();
    for (const p of r.problems) {
      said.add(
        p.reason === "column_missing"
          ? n.columnMissing(p.detail)
          : p.reason === "collector_unknown" || p.reason === "new_row_problem"
            ? p.detail
            : (n.sampleReason[p.reason] ?? n.reason[p.reason] ?? p.reason),
      );
    }
    return [...said].join(" ");
  };
  const label = (unit: string) => m.uploads.page.changeKinds[unit] ?? unit;
  const notes = new Map<number, string>();
  // What applying did to a row says what became of it, and replaces what the comparison would say of the row now: a
  // sample made from a new row makes the row read as a number Beeline already has, and a sample changed by its row
  // reads as different from the file's version.
  const done = new Map<number, OutcomeRow[]>();
  for (const o of outcomes) (done.get(o.row_number) ?? done.set(o.row_number, []).get(o.row_number)!).push(o);
  /** What applying did to one change of an existing sample's row. */
  const changeNote = (o: OutcomeRow): string => {
    switch (o.outcome) {
      case "applied": {
        // A payload that cannot be read must not break the download of the notes: the change's label stands in for its cells.
        const queued = readQueuedUnit(o.payload);
        const said = (v: string) => (v === "" ? n.nothing : `"${v}"`);
        const cells = "unreadable" in queued ? [] : queued.cells.filter((c) => c.differs !== false).map((c) => n.appliedCell(c.column, said(c.was), said(c.fileSays)));
        return n.unitApplied(cells.length > 0 ? cells.join("; ") : label(o.unit), o.detail ?? "");
      }
      case "unchanged":
        return n.unitUnchanged(label(o.unit));
      case "pending":
        return o.detail === null ? n.waiting : `${n.waiting} ${o.detail}`;
      default: {
        // Somebody who is not staff is not shown what Beeline holds now (a location may be withheld from them): only that it changed.
        const changedSince = redact && o.outcome === "refused" && (o.detail ?? "").startsWith(m.uploads.changes.changedSinceStart);
        return n.unitNotApplied(label(o.unit), changedSince ? m.uploads.changes.changedSinceBare : (o.detail ?? ""));
      }
    }
  };
  for (const { row } of upload.rows) {
    const here = done.get(row);
    const o = here?.find((x) => x.unit === "row");
    if (o !== undefined) {
      notes.set(row, o.outcome === "pending" ? n.waiting : o.outcome === "created" ? (o.deleted ? n.createdDeleted(o.sample_number ?? "") : n.created(o.sample_number ?? "")) : n.notCreated(redact && o.outcome === "skipped" ? (o.detail ?? "").replace(/It looks like sample [^:]+:/, "It looks like a sample Beeline already has:") : (o.detail ?? "")));
      continue;
    }
    const r = byRow.get(row);
    if (here !== undefined) {
      // An existing sample's row: each change as it ended, and what the comparison finds wrong with the cells that were not queued.
      const parts = here.map(changeNote);
      const decided = new Set(here.map((x) => x.unit));
      if (r !== undefined) {
        const rest = r.problems.filter((p) => p.reason !== "sample_changed_since" && (p.unit === null || !decided.has(p.unit)));
        if (rest.length > 0) parts.push(n.cantUse(reasons({ ...r, problems: rest })));
      }
      notes.set(row, parts.join(" "));
      continue;
    }
    if (r === undefined) continue;
    const parts: string[] = [];
    if (r.kind === "new") {
      parts.push(
        r.problems.length > 0
          ? n.newTrapCantUse(reasons(r))
          : r.create === null || !isHeld(r.create)
            ? n.newTrap
            : [
                r.create.lookalike !== null && !r.create.anyway
                  ? r.create.lookalike.fileRow !== undefined
                    ? n.newTrapHeldInFile(r.create.lookalike.fileRow, r.create.lookalike.sampleNumber)
                    : n.newTrapHeld(redact ? "" : r.create.lookalike.sampleNumber)
                  : null,
                r.create.obas && !r.create.obasChecked ? n.newTrapObasHeld : null,
              ]
                .filter((x) => x !== null)
                .join(" "),
      );
    } else {
      if (r.problems.length > 0) parts.push(n.cantUse(reasons(r)));
      const changed = r.differences.map((d) => cellsText(m, d.cells.filter((c) => c.differs)));
      if (changed.length > 0) parts.push(n.differs(changed.join("; ")));
      for (const d of r.differences) {
        if (d.metres !== null && d.metres > 0) parts.push(n.moves(n.distance(d.metres)));
        if (d.collectors !== undefined && d.collectors.warnings.length > 0) parts.push(n.collectorsWarning(d.collectors.warnings.join(" ")));
        if (d.refusal !== null) parts.push(n.mayNot(label(d.unit), d.refusal));
      }
    }
    notes.set(row, parts.join(" "));
  }
  const open = plan.rows.filter((r) => !done.has(r.row));
  const held: HeldRow[] =
    outcomes.length > 0
      ? []
      : open.flatMap((r) =>
          r.problems.length === 0 && r.create?.lookalike != null
            ? [{ row: r.row, sampleNumber: r.create.form.sample_number, likeId: r.create.lookalike.sampleId, likeNumber: r.create.lookalike.sampleNumber, likeRow: r.create.lookalike.fileRow ?? null, ticked: r.create.anyway }]
            : [],
        );
  // The series' numbers waiting for confirmation, over the rows that are still to be made.
  const toMake = open.filter((r) => r.problems.length === 0 && r.create !== null);
  const seriesRows = toMake.filter((r) => r.create!.obas);
  const given = seriesRows.filter((r) => !r.create!.assigned).map((r) => r.create!.form.sample_number).sort();
  const obas: ObasSummary | null =
    done.size > 0 || seriesRows.length === 0
      ? null
      : { rows: seriesRows.length, checked: seriesRows.every((r) => r.create!.obasChecked), lowest: given[0] ?? null, highest: given.at(-1) ?? null, blank: plan.numbering.blank, from: plan.numbering.from, to: plan.numbering.to };
  const labelsReady = done.size > 0 ? 0 : toMake.filter((r) => r.season === "active" && Number(r.create!.form.specimen_count) > 0).length;
  const total = (x: SeasonSplit) => x.active + x.settled + x.unplaced;
  const changes: ChangesPreview | null =
    done.size > 0 || total(plan.changes.samples) === 0
      ? null
      : {
          samples: plan.changes.samples,
          kinds: SAMPLES_UNITS.filter((u) => total(plan.changes.byUnit[u]) > 0).map((unit) => ({
            unit,
            samples: plan.changes.byUnit[unit],
            chosen: plan.rows.some((r) => r.differences.some((d) => d.unit === unit && d.chosen)),
          })),
          points: plan.changes.points,
          mayNot: plan.changes.mayNot,
          firstCollector: plan.changes.firstCollector,
          reprint: plan.changes.reprint,
        };
  return {
    notes,
    summary: { kind: "samples", rows: upload.rows.length, counts: done.size === 0 ? plan.counts : countRows(open), unknownCollectors: plan.unknownCollectors, held, outcomes: summaryOfOutcomes(m, outcomes), obas, labelsReady, changes, otherPrograms: done.size > 0 ? [] : (plan.otherPrograms ?? []) },
  };
}

/** What applying did, counted from the outcome rows; null before the file is applied. */
function summaryOfOutcomes(m: Messages, outcomes: readonly OutcomeRow[]): OutcomeSummary | null {
  if (outcomes.length === 0) return null;
  const rows = outcomes.filter((o) => o.unit === "row");
  const units = outcomes.filter((o) => o.unit !== "row");
  const count = (list: readonly OutcomeRow[], outcome: OutcomeRow["outcome"]) => list.filter((o) => o.outcome === outcome).length;
  const isNotChosen = (o: OutcomeRow) => o.outcome === "skipped" && o.detail === m.uploads.changes.notChosen;
  const split = (list: readonly OutcomeRow[]): SeasonSplit => {
    const by: SeasonSplit = { active: 0, settled: 0, unplaced: 0 };
    for (const o of list) by[o.season]++;
    return by;
  };
  const onePerRow = (list: readonly OutcomeRow[]) => [...new Map(list.map((o) => [o.row_number, o])).values()];
  return {
    // What was queued for the job: the claim keeps a payload for it, and for nothing it settled itself.
    total: outcomes.filter((o) => o.queued).length,
    pending: count(outcomes, "pending"),
    created: count(rows, "created"),
    deleted: outcomes.filter((o) => o.deleted).length,
    notCreated: count(rows, "refused") + count(rows, "skipped"),
    changes: {
      // Each split by the season of the sample the change is to.
      samples: split(onePerRow(units.filter((o) => o.outcome === "applied"))),
      applied: split(units.filter((o) => o.outcome === "applied")),
      unchanged: split(units.filter((o) => o.outcome === "unchanged")),
      notApplied: split(units.filter((o) => (o.outcome === "refused" || o.outcome === "skipped") && !isNotChosen(o))),
      notChosen: split(units.filter(isNotChosen)),
    },
  };
}

/**
 * The samples file's page once it is applied: what was done to each row, read from the outcome rows without working the
 * comparison out again. The notes for each row come from the full plan, only for the file with notes.
 */
export function samplesClaimedSummary(m: Messages, upload: ParsedUpload, outcomes: readonly OutcomeRow[]): SamplesSummary {
  const split = () => ({ active: 0, settled: 0, unplaced: 0 });
  return {
    kind: "samples",
    rows: upload.rows.length,
    counts: { rows: split(), newReady: split(), newHeld: split(), cantUse: split(), differ: split(), same: split() },
    unknownCollectors: [],
    held: [],
    outcomes: summaryOfOutcomes(m, outcomes),
    obas: null,
    labelsReady: 0,
    changes: null,
    otherPrograms: [],
  };
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
  audience: Audience | "samples",
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
  audience: Audience | "samples",
): Promise<Uint8Array> {
  const keep = upload.header.map((h, at) => ({ h, at })).filter(({ h }) => h !== NOTE_COLUMN);
  const header = [...keep.map(({ h }) => h), NOTE_COLUMN];
  const has = (c: string) => header.includes(c);
  const book = audience === "samples" ? await samplesWorkbook(db, m) : await specimenWorkbook(db, m, undefined, audience);
  const o: Partial<XlsxWriterOptions> = book.options;
  const rows = upload.rows.map(({ row, cells }) => [...keep.map(({ at }) => cells.get(at)?.text ?? null), notes.get(row) ?? ""]);
  return writeXlsx(
    {
      sheetName: audience === "samples" ? "samples" : "specimens",
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
