import { Zip, ZipDeflate, strToU8, unzipSync } from "fflate";

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
export function xlsxWriter(opts: { sheetName: string; header: readonly string[] }): XlsxWriter {
  const { sheetName, header } = opts;
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
    const r = next++;
    let xml = `<row r="${r}">`;
    cells.forEach((value, at) => {
      if (value === null) return;
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
export function writeXlsx(opts: { sheetName: string; header: readonly string[] }, rows: ReadonlyArray<ReadonlyArray<string | null>>): Uint8Array {
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

export const XLSX_REFUSALS = ["not_a_zip", "not_a_workbook", "too_large", "too_large_unpacked", "unreadable", "too_many_rows"] as const;
export type XlsxRefusal = (typeof XLSX_REFUSALS)[number];
export type XlsxRead = { ok: true; sheet: XlsxSheet } | { ok: false; refusal: XlsxRefusal };

export interface XlsxLimits {
  /** The file itself. */
  maxBytes: number;
  /**
   * What the parts Beeline reads may add up to once unpacked. A zip can be
   * a thousand times smaller than what it holds, and a small file that
   * unpacks to gigabytes is an attack, not a spreadsheet.
   */
  maxInflatedBytes: number;
  /** Rows with a cell in them, the header included. */
  maxRows: number;
}

export const DEFAULT_LIMITS: XlsxLimits = { maxBytes: 20 * 1024 * 1024, maxInflatedBytes: 192 * 1024 * 1024, maxRows: 100_000 };

/** A thing wrong with the XML or the workbook's structure, as opposed to a limit. */
class Unreadable extends Error {}
class TooManyRows extends Error {}

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

/** Whether a custom format code shows a date or a time: a day, month, year, hour or second outside quotes and brackets. */
const showsDate = (code: string): boolean => /[ymdhs]/i.test(code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, ""));

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
function serialToText(serial: string): string {
  const n = Number(serial);
  // Serials before 61 straddle Excel's invented 29 February 1900.
  if (!Number.isFinite(n) || n < 61 || n > 2_958_465) return serial;
  const ms = Math.round((n - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return Number.isInteger(n) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

const CELL_REF = /^([A-Za-z]+)(\d+)$/;

function readSheet(xml: string, strings: string[], dateStyles: boolean[], maxRows: number): XlsxRow[] {
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

  scan(xml, {
    open(name, attrs) {
      switch (name) {
        case "row":
          rowNumber = attrs.r !== undefined && /^\d+$/.test(attrs.r) ? Number(attrs.r) : rowNumber + 1;
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
          if (inCell) formula = true;
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
          const cell = finish();
          if (cell !== null) cells.set(column, cell);
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
      const at = Number(value.trim());
      const found = Number.isInteger(at) ? strings[at] : undefined;
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
    if (dateStyles[style] === true) return { text: serialToText(number), type: "date" };
    return { text: number, type: "number" };
  }
  return rows;
}

/** Where the first sheet of a workbook is, as a path in the zip. */
function firstSheetPath(workbook: string, rels: string): { name: string; path: string } {
  let sheet: { name: string; id: string } | null = null;
  scan(workbook, {
    open(name, attrs) {
      if (name === "sheet" && sheet === null) sheet = { name: attrs.name ?? "", id: attrs.id ?? "" };
    },
    close() {},
    text() {},
  });
  if (sheet === null) throw new Unreadable("no sheet");
  const found: { name: string; id: string } = sheet;
  let target: string | null = null;
  scan(rels, {
    open(name, attrs) {
      if (name === "Relationship" && attrs.Id === found.id) target = attrs.Target ?? null;
    },
    close() {},
    text() {},
  });
  if (target === null) throw new Unreadable("the sheet has no part");
  const t: string = target;
  const parts = (t.startsWith("/") ? t.slice(1) : `xl/${t}`).split("/");
  const path: string[] = [];
  for (const p of parts) {
    if (p === "..") path.pop();
    else if (p !== "." && p !== "") path.push(p);
  }
  return { name: found.name, path: path.join("/") };
}

const WANTED = /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/;

/**
 * The first sheet of a workbook, or why it cannot be read. Never throws: a
 * file that is not a workbook, a limit passed or broken XML is a named
 * refusal.
 */
export function readXlsx(bytes: Uint8Array, limits: Partial<XlsxLimits> = {}): XlsxRead {
  const { maxBytes, maxInflatedBytes, maxRows } = { ...DEFAULT_LIMITS, ...limits };
  if (bytes.byteLength > maxBytes) return { ok: false, refusal: "too_large" };
  // A zip begins with a local file header, or is empty and begins with its end record.
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { ok: false, refusal: "not_a_zip" };
  let inflated = 0;
  let tooBig = false;
  let parts: Record<string, Uint8Array>;
  try {
    // Parts are unpacked into a buffer of the size the zip declares, so a zip
    // that lies about it is cut short, and one that declares a lot is refused here.
    parts = unzipSync(bytes, {
      filter: (file) => {
        if (!WANTED.test(file.name)) return false;
        inflated += file.originalSize;
        if (inflated > maxInflatedBytes) tooBig = true;
        return !tooBig;
      },
    });
  } catch {
    return { ok: false, refusal: "not_a_zip" };
  }
  if (tooBig) return { ok: false, refusal: "too_large_unpacked" };
  const decoder = new TextDecoder("utf-8");
  const text = (name: string): string | null => (parts[name] === undefined ? null : decoder.decode(parts[name]));
  try {
    const workbook = text("xl/workbook.xml");
    const rels = text("xl/_rels/workbook.xml.rels");
    if (workbook === null || rels === null) return { ok: false, refusal: "not_a_workbook" };
    const { name, path } = firstSheetPath(workbook, rels);
    const sheet = text(path);
    if (sheet === null) return { ok: false, refusal: "not_a_workbook" };
    const shared = text("xl/sharedStrings.xml");
    const styles = text("xl/styles.xml");
    return {
      ok: true,
      sheet: { name, rows: readSheet(sheet, shared === null ? [] : readSharedStrings(shared), styles === null ? [] : readDateStyles(styles), maxRows) },
    };
  } catch (err) {
    if (err instanceof TooManyRows) return { ok: false, refusal: "too_many_rows" };
    return { ok: false, refusal: "unreadable" };
  }
}
