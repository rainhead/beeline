import { crc32 } from "node:zlib";
import { Inflate, Zip, ZipDeflate, strToU8 } from "fflate";

/**
 * A minimal .xlsx writer and reader, with nothing of Beeline's in it
 * (beeline-kgyd).
 *
 * The writer makes a workbook of one sheet in which every cell, the header
 * included, is a text cell with the Text number format (`@`, built-in format
 * 49). A spreadsheet neither reformats such a cell nor converts what a person
 * types into it, which is what lets a program compare the cells it gets back
 * exactly. The Text format is also the default style of every column, so a
 * cell that was left out (null) is text too when somebody types into it.
 *
 * The reader reads the first sheet of a workbook as Excel, LibreOffice or
 * Google Sheets save it, and says of each cell its text and what kind of cell
 * it is, so a caller can tell a value somebody typed as text from one the
 * spreadsheet converted into a number, a date or a formula.
 *
 * Neither needs a dependency beyond fflate, which already writes the Darwin
 * Core archives: an .xlsx is a zip of a few XML parts.
 */

// --- Shared by both ---

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;

/** `0` is `A`, `25` is `Z`, `26` is `AA`. */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** The inverse of columnName: `A` is `0`. Null for anything that is not letters. */
export function columnIndex(letters: string): number | null {
  if (!/^[A-Za-z]{1,4}$/.test(letters)) return null;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// --- Writing ---

/**
 * Characters XML 1.0 cannot carry at all, and lone surrogates, which are not
 * text. A spreadsheet's own escape for them is `_xHHHH_`, which the reader
 * undoes; a literal `_x0041_` is written `_x005F_x0041_` so it comes back as
 * it was.
 */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A string as the text of an XML element: lossless for any JavaScript string. */
export function escapeText(text: string): string {
  return text
    .replace(/_(?=x[0-9A-Fa-f]{4}_)/g, "_x005F_")
    .replace(NOT_XML, (ch) => `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // A parser turns a literal carriage return into a line feed.
    .replace(/\r/g, "&#13;");
}

const attr = (text: string): string => escapeText(text).replace(/"/g, "&quot;");

/** What a cell and a sheet may hold in Excel; a file past either is refused when written, not truncated. */
export const MAX_CELL_CHARS = 32_767;
export const MAX_SHEET_ROWS = 1_048_576;

export interface XlsxWriter {
  /** The start of the file: everything before the first data row. */
  head(): Uint8Array[];
  /** More rows. A null is a cell left out; an empty string is a cell that holds nothing. */
  rows(rows: ReadonlyArray<ReadonlyArray<string | null>>): Uint8Array[];
  /** The end of the file. Nothing may be written after it. */
  tail(): Uint8Array[];
}

/**
 * A workbook written a page of rows at a time, the header in row 1. Each
 * call returns the bytes ready to send so far; together, in order, they are
 * the file.
 */
export function xlsxWriter(opts: { sheetName: string; header: readonly string[]; maxRows?: number }): XlsxWriter {
  const { sheetName, header } = opts;
  const maxRows = opts.maxRows ?? MAX_SHEET_ROWS;
  if (sheetName === "" || sheetName.length > 31 || /[[\]:*?/\\]/.test(sheetName)) throw new Error(`not a sheet name: ${sheetName}`);
  if (header.length === 0 || header.length > 16384) throw new Error("a sheet needs between 1 and 16384 columns");
  const out: Uint8Array[] = [];
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    out.push(chunk);
  });
  const take = () => out.splice(0);
  const part = (name: string, body: string) => {
    const file = new ZipDeflate(name, { level: 6 });
    zip.add(file);
    file.push(strToU8(body), true);
  };
  let sheet: ZipDeflate;
  let next = 1;

  const row = (cells: ReadonlyArray<string | null>): string => {
    // Excel's own limits: a file past them cannot be opened by the program it is meant for.
    if (next > maxRows) throw new Error(`a sheet holds at most ${maxRows} rows`);
    const r = next++;
    let xml = `<row r="${r}">`;
    cells.forEach((value, at) => {
      // A cell that was left out still carries the Text style, so a program that ignores the column's default
      // style still treats what a person types there as text.
      if (value === null) {
        xml += `<c r="${columnName(at)}${r}" s="1"/>`;
        return;
      }
      if (value.length > MAX_CELL_CHARS) throw new Error(`a cell holds at most ${MAX_CELL_CHARS} characters; row ${r}, column ${at + 1} has ${value.length}`);
      xml += `<c r="${columnName(at)}${r}" s="1" t="inlineStr"><is><t xml:space="preserve">${escapeText(value)}</t></is></c>`;
    });
    return `${xml}</row>`;
  };
  const encoder = new TextEncoder();

  return {
    head() {
      part(
        "[Content_Types].xml",
        `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
          `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
          `</Types>`,
      );
      part(
        "_rels/.rels",
        `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      );
      part(
        "xl/workbook.xml",
        `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets><sheet name="${attr(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      );
      part(
        "xl/_rels/workbook.xml.rels",
        `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
          `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
          `<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>` +
          `</Relationships>`,
      );
      // Style 1 is the Text format. Style 0 is the spreadsheet's default and is used by nothing.
      part(
        "xl/styles.xml",
        `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">` +
          `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
          `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
          `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
          `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
          `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
          `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>` +
          `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
          `</styleSheet>`,
      );
      sheet = new ZipDeflate("xl/worksheets/sheet1.xml", { level: 6 });
      zip.add(sheet);
      sheet.push(
        encoder.encode(
          `${XML_HEAD}<worksheet xmlns="${NS_MAIN}">` +
            // The Text format for every cell of every column, those with no cell included.
            `<cols><col min="1" max="${header.length}" width="16" style="1" customWidth="1"/></cols>` +
            `<sheetData>${row(header)}`,
        ),
      );
      return take();
    },
    rows(rows) {
      sheet.push(encoder.encode(rows.map(row).join("")));
      return take();
    },
    tail() {
      sheet.push(encoder.encode(`</sheetData></worksheet>`), true);
      zip.end();
      return take();
    },
  };
}

/** A whole workbook in one piece, for tests and small files. */
export function writeXlsx(opts: { sheetName: string; header: readonly string[]; maxRows?: number }, rows: ReadonlyArray<ReadonlyArray<string | null>>): Uint8Array {
  const writer = xlsxWriter(opts);
  const chunks = [...writer.head(), ...writer.rows(rows), ...writer.tail()];
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return all;
}

// --- Reading ---

/** What a cell is, as the spreadsheet stored it. */
export type CellType = "text" | "number" | "date" | "boolean" | "formula" | "error";

export interface XlsxCell {
  /** The cell's text: a string as written, a number as stored, a date as `YYYY-MM-DD`, TRUE or FALSE, a formula's cached result. */
  text: string;
  type: CellType;
}

export interface XlsxRow {
  /** The row's number in the sheet, the first being 1. */
  row: number;
  /** The cells that exist, by column, the first being 0. A gap is a cell that is absent. */
  cells: Map<number, XlsxCell>;
}

export interface XlsxSheet {
  name: string;
  /** Rows that have at least one cell, in the order the sheet gives them. */
  rows: XlsxRow[];
}

export const XLSX_REFUSALS = [
  "not_a_zip",
  /** An old Office file, which is also what an encrypted or sensitivity-labelled workbook is. */
  "protected_file",
  "not_a_workbook",
  /** Several sheets, none of them the one asked for. */
  "no_such_sheet",
  "too_large",
  "too_large_unpacked",
  "unreadable",
  "too_many_rows",
  "too_wide",
] as const;
export type XlsxRefusal = (typeof XLSX_REFUSALS)[number];
export type XlsxRead =
  | {
      ok: true;
      sheet: XlsxSheet;
      /** The names of the other sheets, which were not read. */
      otherSheets: string[];
    }
  | {
      ok: false;
      refusal: XlsxRefusal;
      /** For `no_such_sheet`: the names of the sheets the workbook has. */
      sheets?: string[];
    };

export interface XlsxLimits {
  /** The file itself. */
  maxBytes: number;
  /**
   * What the parts that are read may add up to once unpacked, declared and
   * actual. A zip can be a thousand times smaller than what it holds, and a
   * small file that unpacks to gigabytes is an attack, not a spreadsheet. The
   * default is what a workbook of the largest size Beeline accepts needs: the
   * download is under 60 columns and the upload takes 20,000 rows, so about
   * 1.2 million cells, which Excel writes in some 35 bytes of XML each, 40 MB
   * with room for long remarks and shared strings.
   */
  maxInflatedBytes: number;
  /** Rows with a cell in them, the header included. */
  maxRows: number;
  /** Cells in one row. The download has under 60 columns. */
  maxCellsPerRow: number;
  /** Entries in the zip. A workbook has a dozen. */
  maxEntries: number;
  /**
   * The sheet to read, by name. Where there is no sheet of that name and the
   * workbook has exactly one, that one; otherwise the file is refused
   * (`no_such_sheet`). Left out, the first sheet is read.
   */
  sheetName?: string;
}

export const DEFAULT_LIMITS: XlsxLimits = {
  maxBytes: 20 * 1024 * 1024,
  maxInflatedBytes: 64 * 1024 * 1024,
  maxRows: 100_000,
  maxCellsPerRow: 500,
  maxEntries: 2_000,
};

/** A thing wrong with the XML or the workbook's structure, as opposed to a limit. */
class Unreadable extends Error {}
class TooManyRows extends Error {}
class TooWide extends Error {}
class TooBigUnpacked extends Error {}

const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;
const unentity = (text: string): string =>
  text.includes("&")
    ? text.replace(ENTITY, (whole, body: string) => {
        if (body[0] !== "#") return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[body]!;
        const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      })
    : text;
/** A spreadsheet's `_xHHHH_` escape, undone (see escapeText). */
const unx = (text: string): string => (text.includes("_x") ? text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) : text);

interface XmlHandler {
  open(name: string, attrs: Record<string, string>): void;
  close(name: string): void;
  text(text: string): void;
}

const ATTRIBUTE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const local = (name: string): string => name.slice(name.indexOf(":") + 1);

/**
 * A small, forgiving XML reader: elements, attributes, text, CDATA, and the
 * five entities. Prefixes are dropped (`x:row` is `row`), a document type is
 * refused because the only reason to send one is to define entities, and a
 * comment or processing instruction is skipped.
 */
function scan(xml: string, on: XmlHandler): void {
  // A file cut short must not read as a shorter file: every element has to close, in order.
  const open: string[] = [];
  const closeElement = (name: string) => {
    if (open.pop() !== name) throw new Unreadable("elements do not nest");
    on.close(name);
  };
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      on.text(unentity(xml.slice(i)));
      break;
    }
    if (lt > i) on.text(unentity(xml.slice(i, lt)));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new Unreadable("comment never ends");
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw new Unreadable("CDATA never ends");
      on.text(xml.slice(lt + 9, end));
      i = end + 3;
    } else if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw new Unreadable("instruction never ends");
      i = end + 2;
    } else if (xml.startsWith("<!", lt)) {
      throw new Unreadable("a document type declaration");
    } else if (xml[lt + 1] === "/") {
      const end = xml.indexOf(">", lt + 2);
      if (end === -1) throw new Unreadable("closing tag never ends");
      closeElement(local(xml.slice(lt + 2, end).trim()));
      i = end + 1;
    } else {
      // The end of the tag is the first `>` outside a quoted attribute value.
      let end = lt + 1;
      let quote = "";
      for (; end < xml.length; end++) {
        const ch = xml[end]!;
        if (quote !== "") {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") break;
      }
      if (end >= xml.length) throw new Unreadable("tag never ends");
      let body = xml.slice(lt + 1, end);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const space = body.search(/\s/);
      const name = local(space === -1 ? body : body.slice(0, space));
      const attrs: Record<string, string> = {};
      if (space !== -1) {
        for (const m of body.slice(space).matchAll(ATTRIBUTE)) attrs[local(m[1]!)] = unentity(m[2] ?? m[3] ?? "");
      }
      open.push(name);
      on.open(name, attrs);
      if (selfClosing) closeElement(name);
      i = end + 1;
    }
  }
  if (open.length > 0) throw new Unreadable("the document ends inside an element");
}

/** The text of each `<si>` of a shared strings part: its runs joined, phonetic guides left out. */
function readSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  let current = "";
  let inItem = false;
  let inText = false;
  let phonetic = 0;
  scan(xml, {
    open(name) {
      if (name === "si") {
        inItem = true;
        current = "";
      } else if (name === "rPh") phonetic++;
      else if (name === "t" && inItem && phonetic === 0) inText = true;
    },
    close(name) {
      if (name === "si") {
        strings.push(unx(current));
        inItem = false;
      } else if (name === "rPh") phonetic--;
      else if (name === "t") inText = false;
    },
    text(text) {
      if (inText) current += text;
    },
  });
  return strings;
}

/** Built-in number formats that show a date or a time. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/**
 * Whether a custom format code shows a date or a time: a day, month, year,
 * hour or second that is not in quotes or brackets, not escaped, and not the
 * character a padding (`_D`) or fill (`*d`) token names.
 */
const showsDate = (code: string): boolean =>
  /[ymdhs]/i.test(code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "").replace(/[_*]./g, ""));

/** For each cell style (its `s`), whether a number in it is shown as a date. */
function readDateStyles(xml: string): boolean[] {
  const custom = new Map<number, string>();
  const styles: boolean[] = [];
  let inCellXfs = false;
  scan(xml, {
    open(name, attrs) {
      if (name === "numFmt") custom.set(Number(attrs.numFmtId), attrs.formatCode ?? "");
      else if (name === "cellXfs") inCellXfs = true;
      else if (name === "xf" && inCellXfs) {
        const id = Number(attrs.numFmtId ?? 0);
        styles.push(custom.has(id) ? showsDate(custom.get(id)!) : DATE_FORMATS.has(id));
      }
    },
    close(name) {
      if (name === "cellXfs") inCellXfs = false;
    },
    text() {},
  });
  return styles;
}

/** A spreadsheet's serial day as `YYYY-MM-DD` (with the time when there is one), or the serial as written when it is not a date. */
function serialToText(serial: string, date1904: boolean): string {
  const n = Number(serial);
  // The 1900 system counts from 30 December 1899 and has an invented 29 February 1900, so serials before 61 are
  // not days; the 1904 system counts from 1 January 1904, 1462 days later.
  if (!Number.isFinite(n) || n < (date1904 ? 0 : 61) || n > 2_958_465) return serial;
  const ms = Math.round((n - (date1904 ? 25569 - 1462 : 25569)) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return Number.isInteger(n) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

const CELL_REF = /^([A-Za-z]+)(\d+)$/;
const RANGE_REF = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/;

function readSheet(xml: string, strings: string[], dateStyles: boolean[], date1904: boolean, maxRows: number, maxCellsPerRow: number): XlsxRow[] {
  const rows: XlsxRow[] = [];
  let rowNumber = 0;
  let cells = new Map<number, XlsxCell>();
  let column = -1;
  // The cell being read.
  let inCell = false;
  let type = "";
  let style = -1;
  let value = "";
  let inline = "";
  let formula = false;
  let capture: "v" | "t" | null = null;
  let inInline = false;
  let phonetic = 0;
  // Ranges an array formula or a shared formula covers: only its first cell holds the formula, and the rest hold results.
  let ranges: Array<{ r1: number; c1: number; r2: number; c2: number }> = [];

  scan(xml, {
    open(name, attrs) {
      switch (name) {
        case "row":
          rowNumber = attrs.r !== undefined && /^\d+$/.test(attrs.r) ? Number(attrs.r) : rowNumber + 1;
          // Rows come in order, so a range that has ended can be forgotten.
          ranges = ranges.filter((range) => range.r2 >= rowNumber);
          cells = new Map();
          column = -1;
          break;
        case "c": {
          inCell = true;
          type = attrs.t ?? "n";
          style = attrs.s !== undefined ? Number(attrs.s) : 0;
          value = "";
          inline = "";
          formula = false;
          const ref = attrs.r === undefined ? null : CELL_REF.exec(attrs.r);
          const at = ref === null ? null : columnIndex(ref[1]!);
          column = at ?? column + 1;
          break;
        }
        case "v":
          if (inCell) capture = "v";
          break;
        case "f":
          if (inCell) {
            formula = true;
            const range = (attrs.t === "array" || attrs.t === "shared") && attrs.ref !== undefined ? RANGE_REF.exec(attrs.ref) : null;
            if (range !== null) {
              const [c1, c2] = [columnIndex(range[1]!), columnIndex(range[3] ?? range[1]!)];
              if (c1 !== null && c2 !== null) ranges.push({ r1: Number(range[2]), c1, r2: Number(range[4] ?? range[2]), c2 });
            }
          }
          break;
        case "is":
          if (inCell) inInline = true;
          break;
        case "rPh":
          phonetic++;
          break;
        case "t":
          if (inCell && inInline && phonetic === 0) capture = "t";
          break;
      }
    },
    close(name) {
      switch (name) {
        case "v":
        case "t":
          capture = null;
          break;
        case "is":
          inInline = false;
          break;
        case "rPh":
          phonetic--;
          break;
        case "c": {
          inCell = false;
          if (!formula && ranges.some((r) => rowNumber >= r.r1 && rowNumber <= r.r2 && column >= r.c1 && column <= r.c2)) formula = true;
          const cell = finish();
          if (cell !== null) {
            if (cells.size >= maxCellsPerRow) throw new TooWide();
            cells.set(column, cell);
          }
          break;
        }
        case "row":
          if (cells.size > 0) {
            if (rows.length >= maxRows) throw new TooManyRows();
            rows.push({ row: rowNumber, cells });
          }
          break;
      }
    },
    text(text) {
      if (capture === "v") value += text;
      else if (capture === "t") inline += text;
    },
  });

  /** The cell just read, or null for one with nothing in it (only a style). */
  function finish(): XlsxCell | null {
    const raw = type === "inlineStr" ? unx(inline) : value;
    if (type === "s") {
      // An empty cell of this type has no index, and Number("") is 0, which is the first string.
      const index = value.trim();
      if (index === "") return null;
      const found = /^\d+$/.test(index) ? strings[Number(index)] : undefined;
      if (found === undefined) throw new Unreadable("a shared string that does not exist");
      return { text: found, type: formula ? "formula" : "text" };
    }
    if (type === "inlineStr") return { text: raw, type: formula ? "formula" : "text" };
    if (type === "str") return { text: unx(raw), type: formula ? "formula" : "text" };
    if (type === "b") return { text: raw.trim() === "1" ? "TRUE" : "FALSE", type: formula ? "formula" : "boolean" };
    if (type === "e") return { text: raw.trim(), type: formula ? "formula" : "error" };
    if (type === "d") return raw.trim() === "" ? null : { text: raw.trim(), type: formula ? "formula" : "date" };
    // A number, by `n` or by saying nothing.
    const number = raw.trim();
    if (number === "") return formula ? { text: "", type: "formula" } : null;
    if (formula) return { text: number, type: "formula" };
    if (dateStyles[style] === true) return { text: serialToText(number, date1904), type: "date" };
    // The value, not the digits the file stores it in: 44.564599999999999 is the number 44.5646.
    const n = Number(number);
    return { text: Number.isFinite(n) ? String(n) : number, type: "number" };
  }
  return rows;
}

interface SheetRef {
  name: string;
  id: string;
}

/** The sheets of a workbook in the order it lists them, and whether it counts its dates from 1904. */
function readWorkbook(xml: string): { sheets: SheetRef[]; date1904: boolean } {
  const sheets: SheetRef[] = [];
  let date1904 = false;
  scan(xml, {
    open(name, attrs) {
      if (name === "sheet") sheets.push({ name: attrs.name ?? "", id: attrs.id ?? "" });
      else if (name === "workbookPr") date1904 = attrs.date1904 === "1" || attrs.date1904 === "true";
    },
    close() {},
    text() {},
  });
  if (sheets.length === 0) throw new Unreadable("no sheet");
  return { sheets, date1904 };
}

/** Where a sheet is, as a path in the zip, from the workbook's relationships. */
function sheetPath(rels: string, id: string): string {
  let target: string | null = null;
  scan(rels, {
    open(name, attrs) {
      if (name === "Relationship" && attrs.Id === id) target = attrs.Target ?? null;
    },
    close() {},
    text() {},
  });
  if (target === null) throw new Unreadable("the sheet has no part");
  const t: string = target;
  const path: string[] = [];
  for (const p of (t.startsWith("/") ? t.slice(1) : `xl/${t}`).split("/")) {
    if (p === "..") path.pop();
    else if (p !== "." && p !== "") path.push(p);
  }
  return path.join("/");
}

// --- The zip ---

/** Not a zip, or a zip too damaged to find its parts in. */
class NotAZip extends Error {}

interface Entry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  /** The CRC-32 the directory gives the part's bytes. */
  crc: number;
  /** Where the entry's data begins in the file. */
  start: number;
}

/**
 * The entries of a zip, from its central directory, without unpacking any.
 * The directory is what says how big each part is and where it is, and it is
 * read here so that nothing is inflated before the numbers have been judged.
 */
function readDirectory(bytes: Uint8Array, maxEntries: number): Map<string, Entry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end === -1) throw new NotAZip("no end of central directory");
  const count = view.getUint16(end + 10, true);
  const directoryAt = view.getUint32(end + 16, true);
  // Zip64 puts these in another record; a workbook of a size Beeline accepts needs none.
  if (count === 0xffff || directoryAt === 0xffffffff) throw new NotAZip("zip64");
  // A workbook has about a dozen entries; thousands are not a spreadsheet.
  if (count > maxEntries) throw new TooBigUnpacked();
  const entries = new Map<string, Entry>();
  let at = directoryAt;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new NotAZip("directory entry");
    const nameLength = view.getUint16(at + 28, true);
    const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (at + 46 + skip > bytes.length) throw new NotAZip("directory entry");
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const size = view.getUint32(at + 24, true);
    const compressed = view.getUint32(at + 20, true);
    const local = view.getUint32(at + 42, true);
    if (size === 0xffffffff || compressed === 0xffffffff) throw new NotAZip("zip64");
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new NotAZip("local header");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + compressed > bytes.length) throw new NotAZip("entry runs past the end of the file");
    // Two entries of one name: which is meant cannot be told.
    if (entries.has(name)) throw new NotAZip("an entry twice");
    entries.set(name, { name, method: view.getUint16(at + 10, true), compressed, size, crc: view.getUint32(at + 16, true), start });
    at += 46 + skip;
  }
  return entries;
}

/** How much more may be unpacked, shared by every part read from one file. */
interface Budget {
  left: number;
}

/** A part's bytes. The output is counted as it appears, and the moment it passes the budget nothing more is inflated. */
function unpack(bytes: Uint8Array, entry: Entry, budget: Budget): Uint8Array {
  // A size that is too big on its face is refused before anything is inflated.
  if (entry.size > budget.left) throw new TooBigUnpacked();
  const data = bytes.subarray(entry.start, entry.start + entry.compressed);
  if (entry.method === 0) {
    if (entry.compressed !== entry.size) throw new Unreadable("a stored part whose sizes disagree");
    budget.left -= entry.size;
    // What the directory says the bytes sum to: a part altered in transit with its sizes unchanged is not the part.
    if (crc32(data) !== entry.crc) throw new Unreadable("a part whose bytes are not the bytes the zip checksums");
    return data;
  }
  if (entry.method !== 8) throw new Unreadable("a compression method that is not deflate");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflate = new Inflate((chunk) => {
    total += chunk.length;
    budget.left -= chunk.length;
    if (budget.left < 0) throw new TooBigUnpacked();
    chunks.push(chunk);
  });
  // A few kilobytes of input at a time, since deflate expands at most a thousandfold: the output never gets far past the budget before it is noticed.
  const SLICE = 4096;
  try {
    if (data.length === 0) inflate.push(data, true);
    for (let at = 0; at < data.length; at += SLICE) inflate.push(data.subarray(at, at + SLICE), at + SLICE >= data.length);
  } catch (err) {
    if (err instanceof TooBigUnpacked) throw err;
    throw new Unreadable("a part that does not inflate");
  }
  // What the zip says the part is, and what it was, are one number.
  if (total !== entry.size) throw new Unreadable("a part whose size is not the size the zip declares");
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  if (crc32(out) !== entry.crc) throw new Unreadable("a part whose bytes are not the bytes the zip checksums");
  return out;
}

/** The OLE2 header: an old .xls, and also what Excel makes of a workbook that is encrypted or carries a sensitivity label. */
const OLE_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * The sheet of a workbook asked for (see XlsxLimits.sheetName), or why it
 * cannot be read. Never throws: a file that is not a workbook, a limit passed
 * or broken XML is a named refusal. Only the parts that are read are
 * unpacked: the workbook, its relationships, its styles and shared strings,
 * and the one sheet, each once, and no two of them may share bytes of the
 * file.
 */
export function readXlsx(bytes: Uint8Array, limits: Partial<XlsxLimits> = {}): XlsxRead {
  const { maxBytes, maxInflatedBytes, maxRows, maxCellsPerRow, maxEntries, sheetName } = { ...DEFAULT_LIMITS, ...limits };
  if (bytes.byteLength > maxBytes) return { ok: false, refusal: "too_large" };
  if (bytes.byteLength >= OLE_HEADER.length && OLE_HEADER.every((b, i) => bytes[i] === b)) return { ok: false, refusal: "protected_file" };
  // A zip begins with a local file header, or is empty and begins with its end record.
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { ok: false, refusal: "not_a_zip" };
  const decoder = new TextDecoder("utf-8");
  try {
    const entries = readDirectory(bytes, maxEntries);
    const budget: Budget = { left: maxInflatedBytes };
    const used: Entry[] = [];
    const part = (name: string): string | null => {
      const entry = entries.get(name);
      if (entry === undefined) return null;
      // Entries that share bytes of the file would let one payload be unpacked as many parts.
      if (used.some((u) => entry.start < u.start + u.compressed && u.start < entry.start + entry.compressed && entry.compressed > 0 && u.compressed > 0) || used.includes(entry)) {
        throw new Unreadable("parts that overlap");
      }
      used.push(entry);
      return decoder.decode(unpack(bytes, entry, budget));
    };
    const workbook = part("xl/workbook.xml");
    const rels = part("xl/_rels/workbook.xml.rels");
    if (workbook === null || rels === null) return { ok: false, refusal: "not_a_workbook" };
    const { sheets, date1904 } = readWorkbook(workbook);
    const chosen = sheetName === undefined ? sheets[0] : (sheets.find((s) => s.name === sheetName) ?? (sheets.length === 1 ? sheets[0] : undefined));
    if (chosen === undefined) return { ok: false, refusal: "no_such_sheet", sheets: sheets.map((s) => s.name) };
    const sheet = part(sheetPath(rels, chosen.id));
    if (sheet === null) return { ok: false, refusal: "not_a_workbook" };
    const shared = part("xl/sharedStrings.xml");
    const styles = part("xl/styles.xml");
    return {
      ok: true,
      sheet: {
        name: chosen.name,
        rows: readSheet(sheet, shared === null ? [] : readSharedStrings(shared), styles === null ? [] : readDateStyles(styles), date1904, maxRows, maxCellsPerRow),
      },
      otherSheets: sheets.filter((s) => s !== chosen).map((s) => s.name),
    };
  } catch (err) {
    if (err instanceof TooManyRows) return { ok: false, refusal: "too_many_rows" };
    if (err instanceof TooWide) return { ok: false, refusal: "too_wide" };
    if (err instanceof TooBigUnpacked) return { ok: false, refusal: "too_large_unpacked" };
    if (err instanceof NotAZip) return { ok: false, refusal: "not_a_zip" };
    return { ok: false, refusal: "unreadable" };
  }
}
