import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import * as XLSX from "xlsx";
import type { CellType, XlsxCell, XlsxRead, XlsxRow } from "./xlsx.js";

/**
 * Reading an uploaded workbook (beeline-kgyd): SheetJS, in a worker thread.
 *
 * A hand-written zip and XML reader was tried first, and three rounds of
 * review kept finding a way for a crafted file to stall it, and it had never
 * met a file saved by Excel or Google Sheets. SheetJS has been used against
 * both for years, so the reading is its. What Beeline keeps is the adapter
 * below, which says of each cell its text and its kind, and what stands in
 * front of the library:
 *
 * - the cheap refusals, before the library sees a byte: over the size limit,
 *   not a zip (a CSV, which SheetJS would otherwise read as one), an old
 *   Office file (which is also an encrypted or labelled workbook);
 * - a worker thread, with a time limit and a memory limit, because a zip can
 *   unpack to far more than its size, and older SheetJS versions had a regex
 *   denial of service and a prototype pollution bug. The worker gets the
 *   bytes and returns plain data or a named refusal, and when it is killed
 *   for time or memory that is a refusal too;
 * - the options that bound the work: only the sheet that is read is parsed,
 *   only the first rows of it, and nothing that evaluates or formats more
 *   than the cell's own number format.
 *
 * One file, two halves, as src/label-pdf-worker.ts is: the spawner runs on
 * the main thread and the body at the bottom runs in the worker, which is
 * spawned from this same module URL.
 */

export interface ReadLimits {
  /** The file itself. */
  maxBytes: number;
  /** Rows with a cell in them, the header included. */
  maxRows: number;
  /** Cells in one row. The download has under 60 columns. */
  maxCellsPerRow: number;
  /**
   * The sheet to read, by name, or any of several names (the specimens file's
   * tab and the samples file's, which are told apart by their headings). The
   * first sheet of the workbook with one of the names; where there is none and
   * the workbook has exactly one sheet, that one; otherwise the file is
   * refused (`no_such_sheet`). Left out, the first sheet is read.
   */
  sheetName?: string | readonly string[];
  /** How long the worker may take, in milliseconds. A 20,000-row download parses in a few seconds. */
  timeMs: number;
  /** The worker's heap, in megabytes. A 20,000-row, 47-column sheet needs well under half of this. */
  memoryMb: number;
  /**
   * Read in the calling thread, with no worker, no time limit and no memory limit. For tests that are about what the
   * plan does with a workbook and not about the worker, which pay about 0.1 s for each spawn. The app never sets it.
   */
  inThread?: boolean;
}

export const DEFAULT_READ_LIMITS: ReadLimits = {
  maxBytes: 20 * 1024 * 1024,
  maxRows: 100_000,
  maxCellsPerRow: 500,
  timeMs: 30_000,
  memoryMb: 768,
};

/** The OLE2 header: an old .xls, and also what Excel makes of a workbook that is encrypted or carries a sensitivity label. */
const OLE_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** What crosses the thread boundary: plain data only. */
interface WireRow {
  row: number;
  cells: Array<[column: number, text: string, type: CellType]>;
}
type WireReply =
  | { ok: true; name: string; rows: WireRow[]; otherSheets: string[] }
  | { ok: false; refusal: Extract<XlsxRead, { ok: false }>["refusal"]; sheets?: string[] };

interface WorkerInput {
  kind: "xlsx-read";
  bytes: Uint8Array;
  limits: ReadLimits;
}

/**
 * The first sheet of a workbook asked for, or why it cannot be read. Never
 * throws: a file that is not a workbook, a limit passed, a worker killed or
 * anything the library throws is a named refusal.
 */
export async function readXlsx(bytes: Uint8Array, limits: Partial<ReadLimits> = {}): Promise<XlsxRead> {
  const all = { ...DEFAULT_READ_LIMITS, ...limits };
  if (bytes.byteLength > all.maxBytes) return { ok: false, refusal: "too_large" };
  if (bytes.byteLength >= OLE_HEADER.length && OLE_HEADER.every((b, i) => bytes[i] === b)) return { ok: false, refusal: "protected_file" };
  // A zip begins with a local file header, or is empty and begins with its end record. Anything else is not a workbook
  // this reads, and SheetJS would read a CSV as one.
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { ok: false, refusal: "not_a_zip" };
  if (all.inThread === true) return readXlsxHere(bytes, all);
  let reply: WireReply;
  try {
    reply = await inWorker({ kind: "xlsx-read", bytes, limits: all });
  } catch {
    return { ok: false, refusal: "unreadable" };
  }
  if (!reply.ok) return { ok: false, refusal: reply.refusal, ...(reply.sheets === undefined ? {} : { sheets: reply.sheets }) };
  return {
    ok: true,
    sheet: { name: reply.name, rows: reply.rows.map((r): XlsxRow => ({ row: r.row, cells: new Map(r.cells.map(([c, text, type]) => [c, { text, type } satisfies XlsxCell])) })) },
    otherSheets: reply.otherSheets,
  };
}

function inWorker(input: WorkerInput): Promise<WireReply> {
  return new Promise<WireReply>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: input,
      execArgv: workerExecArgv(),
      resourceLimits: { maxOldGenerationSizeMb: input.limits.memoryMb, maxYoungGenerationSizeMb: Math.min(64, input.limits.memoryMb) },
    });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => done(() => resolve({ ok: false, refusal: "took_too_long" })), input.limits.timeMs);
    worker.on("message", (reply: WireReply) => done(() => resolve(reply)));
    worker.on("error", (err: Error & { code?: string }) =>
      done(() => (err.code === "ERR_WORKER_OUT_OF_MEMORY" ? resolve({ ok: false, refusal: "too_large_unpacked" }) : reject(err))),
    );
    // Only a failure: the success path has already settled on its message.
    worker.on("exit", (code) => done(() => reject(new Error(`xlsx worker exited with code ${code}`))));
  });
}

/** As src/label-pdf-worker.ts: the worker needs tsx to read TypeScript, which the app's own `node --import tsx` already has. */
function workerExecArgv(): string[] {
  const loaded = process.execArgv.some((arg) => arg === "tsx" || arg.includes("tsx/"));
  return loaded ? process.execArgv : [...process.execArgv, "--import", "tsx"];
}

// --- The adapter: SheetJS's cells as Beeline's ---

/** Excel's error codes, as the file format fixes them. */
const ERROR_WORDS: Record<number, string> = { 0: "#NULL!", 7: "#DIV/0!", 15: "#VALUE!", 23: "#REF!", 29: "#NAME?", 36: "#NUM!", 42: "#N/A", 43: "#GETTING_DATA" };

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** A serial as `YYYY-MM-DD` (with the time when there is one), by the workbook's own date system, or the number as written when it is no day. */
function dateText(serial: number, date1904: boolean): string {
  // Before the first of January 1900 (or 1904) is not a day; the library's own conversion does the rest, including the 1900 leap-year error.
  if (!(serial >= 1 || (date1904 && serial >= 0)) || serial > 2_958_465) return String(serial);
  const d = XLSX.SSF.parse_date_code(serial, { date1904 });
  if (d === null || d === undefined) return String(serial);
  const day = `${pad(d.y, 4)}-${pad(d.m)}-${pad(d.d)}`;
  return d.H === 0 && d.M === 0 && Math.floor(d.S) === 0 ? day : `${day} ${pad(d.H)}:${pad(d.M)}:${pad(Math.floor(d.S))}`;
}

/** One SheetJS cell as text and a kind; null for a cell that holds nothing (a stub). */
function adaptCell(cell: XLSX.CellObject, date1904: boolean): XlsxCell | null {
  const formula = cell.f !== undefined;
  const as = (text: string, type: CellType): XlsxCell => ({ text, type: formula ? "formula" : type });
  switch (cell.t) {
    case "s":
      return as(String(cell.v ?? ""), "text");
    case "b":
      return as(cell.v ? "TRUE" : "FALSE", "boolean");
    case "e":
      // The library keeps an error as its code (the words, `w`, are only made when text is asked for, which costs a format for every cell).
      return as(typeof cell.v === "number" ? (ERROR_WORDS[cell.v] ?? "#ERROR") : "#ERROR", "error");
    case "n": {
      if (typeof cell.v !== "number") return null;
      if (typeof cell.z === "string" && XLSX.SSF.is_date(cell.z)) return as(dateText(cell.v, date1904), "date");
      return as(String(cell.v), "number");
    }
    case "d":
      return as(cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : String(cell.v), "date");
    default:
      return null;
  }
}

/** A refusal the adapter raises on purpose. */
class Refused extends Error {
  constructor(
    readonly refusal: Extract<XlsxRead, { ok: false }>["refusal"],
    readonly sheets?: string[],
  ) {
    super(refusal);
  }
}

/**
 * The adapter, in this thread: SheetJS reads the sheet asked for and what
 * comes back is cells as text and kind. This is what the worker runs, and
 * what tests of the adapter's decisions run without a worker.
 */
export function readXlsxHere(bytes: Uint8Array, limits: Partial<ReadLimits> = {}): XlsxRead {
  const { maxRows, maxCellsPerRow, sheetName } = { ...DEFAULT_READ_LIMITS, ...limits };
  try {
    // The names first, which is cheap; then only the sheet that is read.
    const names = XLSX.read(bytes, { type: "array", bookSheets: true }).SheetNames ?? [];
    if (names.length === 0) throw new Refused("not_a_workbook");
    const wanted = sheetName === undefined ? null : typeof sheetName === "string" ? [sheetName] : sheetName;
    const chosen = wanted === null ? names[0] : (names.find((n) => wanted.includes(n)) ?? (names.length === 1 ? names[0] : undefined));
    if (chosen === undefined) throw new Refused("no_such_sheet", names);
    const book = XLSX.read(bytes, {
      type: "array",
      // The cell's number format, to tell a date from a number, and its formula; never a date made into an object.
      cellNF: true,
      cellFormula: true,
      cellDates: false,
      // Nothing else: no styles, no macros, no formatted text, no HTML.
      cellStyles: false,
      cellHTML: false,
      cellText: false,
      bookVBA: false,
      dense: true,
      sheets: chosen,
      // Just above the limit, so that a sheet with more rows is seen to have them and stops being read.
      sheetRows: maxRows + 1,
    });
    const sheet = book.Sheets[chosen];
    if (sheet === undefined) throw new Refused("not_a_workbook");
    const date1904 = book.Workbook?.WBProps?.date1904 === true;
    const data = (sheet as XLSX.WorkSheet & { "!data"?: Array<Array<XLSX.CellObject | undefined> | undefined> })["!data"] ?? [];
    // A sheet that goes on past the rows that were read had more rows than are allowed.
    const full = sheet["!fullref"];
    if (full !== undefined && XLSX.utils.decode_range(full).e.r + 1 > maxRows + 1) throw new Refused("too_many_rows");
    const rows: XlsxRow[] = [];
    // An array formula covers a range, and the library gives the formula (and the range, as `F`) to its first cell only:
    // the others hold results, which would read as numbers somebody typed.
    const covered: XLSX.Range[] = [];
    for (let r = 0; r < data.length; r++) {
      const line = data[r];
      if (line === undefined) continue;
      const cells = new Map<number, XlsxCell>();
      for (let c = 0; c < line.length; c++) {
        const cell = line[c];
        if (cell === undefined) continue;
        if (cell.F !== undefined) covered.push(XLSX.utils.decode_range(cell.F));
        const adapted = adaptCell(cell, date1904);
        if (adapted !== null && adapted.type !== "formula" && covered.some((g) => r >= g.s.r && r <= g.e.r && c >= g.s.c && c <= g.e.c)) adapted.type = "formula";
        if (adapted === null) continue;
        if (cells.size >= maxCellsPerRow) throw new Refused("too_wide");
        cells.set(c, adapted);
      }
      if (cells.size === 0) continue;
      if (rows.length >= maxRows) throw new Refused("too_many_rows");
      rows.push({ row: r + 1, cells });
    }
    return { ok: true, sheet: { name: chosen, rows }, otherSheets: names.filter((n) => n !== chosen) };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, refusal: err.refusal, ...(err.sheets === undefined ? {} : { sheets: err.sheets }) };
    return { ok: false, refusal: "unreadable" };
  }
}

// --- The worker's half ---

if (!isMainThread && parentPort !== null && (workerData as WorkerInput | null)?.kind === "xlsx-read") {
  const { bytes, limits } = workerData as WorkerInput;
  const read = readXlsxHere(bytes, limits);
  const reply: WireReply = read.ok
    ? {
        ok: true,
        name: read.sheet.name,
        rows: read.sheet.rows.map((r) => ({ row: r.row, cells: [...r.cells].map(([c, cell]) => [c, cell.text, cell.type] as [number, string, CellType]) })),
        otherSheets: read.otherSheets,
      }
    : { ok: false, refusal: read.refusal, ...(read.sheets === undefined ? {} : { sheets: read.sheets }) };
  parentPort.postMessage(reply);
}
