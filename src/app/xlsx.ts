import { Zip, ZipDeflate, strToU8 } from "fflate";

/**
 * A minimal .xlsx writer, and the types of what the reader returns, with
 * nothing of Beeline's in it (beeline-kgyd).
 *
 * The writer makes a workbook of one sheet in which every cell, the header
 * included, is a text cell with the Text number format (`@`, built-in format
 * 49). A spreadsheet neither reformats such a cell nor converts what a person
 * types into it, which is what lets a program compare the cells it gets back
 * exactly. The Text format is also the default style of every column, so a
 * cell that was left out (null) is text too when somebody types into it.
 *
 * The upload is read by SheetJS in a worker (src/app/xlsx-reader.ts), which
 * says of each cell its text and what kind of cell it is, so a caller can
 * tell a value somebody typed as text from one the spreadsheet converted
 * into a number, a date or a formula. The writer needs no dependency beyond
 * fflate, which already writes the Darwin Core archives: an .xlsx is a zip
 * of a few XML parts.
 */

// --- Shared by the writer and what reads its files ---

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
export const MAX_COLUMNS = 16_384;

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
export interface XlsxWriterOptions {
  sheetName: string;
  header: readonly string[];
  maxRows?: number;
  /**
   * The words a column's cells may hold, by the column's heading: the
   * spreadsheet then offers them as a dropdown in every cell below the
   * heading and refuses anything else typed there. A cell may still be left
   * blank. The cells stay text.
   */
  choices?: Readonly<Record<string, readonly string[]>>;
}

/** The most characters a list of choices may come to, commas included: the limit of a list written into the sheet itself. */
export const MAX_CHOICES_CHARS = 255;

/** The dropdowns, as the sheet's data validations; nothing when no column has choices. */
function choicesXml(header: readonly string[], choices: Readonly<Record<string, readonly string[]>>): string {
  const lists = Object.entries(choices).map(([column, words]) => {
    const at = header.indexOf(column);
    if (at < 0) throw new Error(`choices for a column the sheet does not have: ${column}`);
    // The list is written as one quoted, comma-separated string, so a word cannot hold either character.
    if (words.length === 0 || words.some((w) => w === "" || /[",]/.test(w))) throw new Error(`choices for ${column} must be words without commas or quotes`);
    const list = words.join(",");
    if (list.length > MAX_CHOICES_CHARS) throw new Error(`choices for ${column} come to more than ${MAX_CHOICES_CHARS} characters`);
    const letters = columnName(at);
    return (
      `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${letters}2:${letters}${MAX_SHEET_ROWS}">` +
      `<formula1>${escapeText(`"${list}"`)}</formula1></dataValidation>`
    );
  });
  return lists.length === 0 ? "" : `<dataValidations count="${lists.length}">${lists.join("")}</dataValidations>`;
}

export function xlsxWriter(opts: XlsxWriterOptions): XlsxWriter {
  const { sheetName, header } = opts;
  const maxRows = opts.maxRows ?? MAX_SHEET_ROWS;
  if (sheetName === "" || sheetName.length > 31 || /[[\]:*?/\\]/.test(sheetName)) throw new Error(`not a sheet name: ${sheetName}`);
  if (header.length === 0 || header.length > MAX_COLUMNS) throw new Error(`a sheet needs between 1 and ${MAX_COLUMNS} columns`);
  // Worked out before anything is written, so a bad list fails the download at its start and not at its end.
  const dropdowns = choicesXml(header, opts.choices ?? {});
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
    if (cells.length > MAX_COLUMNS) throw new Error(`a sheet holds at most ${MAX_COLUMNS} columns; row ${next} has ${cells.length}`);
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
      sheet.push(encoder.encode(`</sheetData>${dropdowns}</worksheet>`), true);
      zip.end();
      return take();
    },
  };
}

/** A whole workbook in one piece, for tests and small files. */
export function writeXlsx(opts: XlsxWriterOptions, rows: ReadonlyArray<ReadonlyArray<string | null>>): Uint8Array {
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

// --- What the reader returns (src/app/xlsx-reader.ts) ---

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
  /** The worker ran out of memory: the file is far bigger once it is opened than it looks. */
  "too_large_unpacked",
  /** The worker did not finish in time. */
  "took_too_long",
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
