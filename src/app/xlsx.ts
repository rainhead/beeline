import { Zip, ZipDeflate, strToU8 } from "fflate";

/**
 * A minimal .xlsx writer, and the types of what the reader returns, with
 * nothing of Beeline's in it (beeline-kgyd).
 *
 * The writer makes a workbook of one streamed sheet, and any small sheets for
 * reference after it, in which every cell, the header
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

const attr = (text: string): string => escapeText(text).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");

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
 * What a column's cells may hold, written into the sheet as a data validation
 * (a list the spreadsheet offers in every cell below the heading). Either way
 * the cells stay text and a cell may be left blank.
 */
export type ColumnChoices =
  /**
   * A short list of words written into the validation itself. A cell holding
   * anything else gets a warning, which the person may dismiss: nothing is
   * refused. The caller words the warning, since the writer knows nothing of
   * what the column is for.
   */
  | { words: readonly string[]; title: string; message: string }
  /**
   * The words in a column of one of the extra sheets, from its second row to
   * the last cell of that column that holds something. With a `title` and a
   * `message`, a cell holding anything else gets that warning, which the
   * person may dismiss; without them the words are suggestions only, and
   * nothing is refused and nothing warns. A column with no words gives no
   * validation.
   *
   * This is the form to use for any list a person must be able to pick from:
   * a list written into the validation itself (`words`, above) is one quoted
   * string, which Excel splits at its commas and Gnumeric offers whole, as a
   * single choice (seen in Gnumeric 2026-11-17: caste offered
   * "gyne,worker,drone").
   */
  | { sheet: string; column: string; title?: string; message?: string };

/** A sheet written whole, beside the main one: its name, its header and every row. */
export interface ExtraSheet {
  name: string;
  header: readonly string[];
  rows: ReadonlyArray<ReadonlyArray<string | null>>;
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
  /** What each column may hold, by the column's heading. */
  choices?: Readonly<Record<string, ColumnChoices>>;
  /**
   * Sheets after the main one, given whole up front since they are small.
   * Every cell is text, as on the main sheet.
   */
  sheets?: readonly ExtraSheet[];
  /**
   * Headings of the columns to shade light grey, every cell of them, the
   * heading included: the caller's way of saying which columns are for
   * reference. Shading is a mark and not protection: a person may still sort,
   * filter and edit a shaded cell.
   */
  shadedColumns?: readonly string[];
  /** Headings to write in bold. */
  boldHeadings?: readonly string[];
  /**
   * Width, in characters, of a column by its heading; a column not named is
   * 16 wide. A spreadsheet draws a text cell's overflow across the empty cell
   * beside it, so a column too narrow for its text makes the text look like
   * the next column's content (beeline-kgyd.11). The rows are streamed, so
   * the writer cannot measure them: the caller says what fits.
   */
  widths?: Readonly<Record<string, number>>;
}

/** The most characters a list of choices may come to, commas included: the limit of a list written into the sheet itself. */
export const MAX_CHOICES_CHARS = 255;
/** The limits Excel puts on a validation's warning: its title and its message. */
export const MAX_ERROR_TITLE_CHARS = 32;
export const MAX_ERROR_MESSAGE_CHARS = 255;
/** The longest name a sheet may have. */
export const MAX_SHEET_NAME_CHARS = 31;

/** Why a name cannot be a sheet's name, or null. Excel compares names without regard to case. */
export function sheetNameProblem(name: string): string | null {
  if (name === "" || name.length > MAX_SHEET_NAME_CHARS) return `a sheet name is 1 to ${MAX_SHEET_NAME_CHARS} characters: ${name}`;
  if (/[[\]:*?/\\]/.test(name)) return `a sheet name cannot hold any of [ ] : * ? / \\ : ${name}`;
  if (name.startsWith("'") || name.endsWith("'")) return `a sheet name cannot begin or end with an apostrophe: ${name}`;
  return null;
}

/** A sheet's name as a formula writes it: in quotes when it is not a plain word or could be read as a cell reference. */
export function sheetRef(name: string): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}[0-9]+$/.test(name) && !/^[Rr]([0-9]+)?([Cc]([0-9]+)?)?$/.test(name);
  return plain ? name : `'${name.replaceAll("'", "''")}'`;
}

/** Cell styles (xl/styles.xml): 1 is the Text format, 2 the same in bold, 3 the same on grey. */
const STYLE_TEXT = 1;
const STYLE_BOLD = 2;
const STYLE_GREY = 3;
/** A plain RGB colour and not a theme colour, so that every program shows the same grey: light enough for black text. */
export const SHADE_RGB = "FFD9D9D9";

/** The data validations, as the sheet's XML; nothing when no column has choices. */
function choicesXml(header: readonly string[], choices: Readonly<Record<string, ColumnChoices>>, sheets: readonly ExtraSheet[]): string {
  const lists = Object.entries(choices).flatMap(([column, choice]) => {
    const at = header.indexOf(column);
    if (at < 0) throw new Error(`choices for a column the sheet does not have: ${column}`);
    const letters = columnName(at);
    const sqref = `${letters}2:${letters}${MAX_SHEET_ROWS}`;
    if ("words" in choice) {
      const { words, title, message } = choice;
      // The list is written as one quoted, comma-separated string, so a word cannot hold either character.
      if (words.length === 0 || words.some((w) => w === "" || /[",]/.test(w))) throw new Error(`choices for ${column} must be words without commas or quotes`);
      const list = words.join(",");
      if (list.length > MAX_CHOICES_CHARS) throw new Error(`choices for ${column} come to more than ${MAX_CHOICES_CHARS} characters`);
      if (title === "" || title.length > MAX_ERROR_TITLE_CHARS) throw new Error(`the warning's title for ${column} is 1 to ${MAX_ERROR_TITLE_CHARS} characters`);
      if (message === "" || message.length > MAX_ERROR_MESSAGE_CHARS) throw new Error(`the warning's message for ${column} is 1 to ${MAX_ERROR_MESSAGE_CHARS} characters`);
      return [
        `<dataValidation type="list" errorStyle="warning" allowBlank="1" showErrorMessage="1" errorTitle="${attr(title)}" error="${attr(message)}" sqref="${sqref}">` +
          `<formula1>${escapeText(`"${list}"`)}</formula1></dataValidation>`,
      ];
    }
    const source = sheets.find((s) => s.name === choice.sheet);
    if (source === undefined) throw new Error(`choices for ${column} come from a sheet that is not there: ${choice.sheet}`);
    const from = source.header.indexOf(choice.column);
    if (from < 0) throw new Error(`choices for ${column} come from a column that ${choice.sheet} does not have: ${choice.column}`);
    // The list ends at the column's own last word, since the sheet's columns may be of different lengths and a
    // list that ran on into empty cells would offer a blank.
    const filled = source.rows.findLastIndex((r) => (r[from] ?? "") !== "");
    // Nothing to offer, so no validation.
    if (filled < 0) return [];
    const letter = columnName(from);
    const range = `${sheetRef(source.name)}!$${letter}$2:$${letter}$${filled + 2}`;
    const { title, message } = choice;
    if (title === undefined && message === undefined) {
      return [`<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${sqref}"><formula1>${escapeText(range)}</formula1></dataValidation>`];
    }
    if (title === undefined || title === "" || title.length > MAX_ERROR_TITLE_CHARS) throw new Error(`the warning's title for ${column} is 1 to ${MAX_ERROR_TITLE_CHARS} characters`);
    if (message === undefined || message === "" || message.length > MAX_ERROR_MESSAGE_CHARS) throw new Error(`the warning's message for ${column} is 1 to ${MAX_ERROR_MESSAGE_CHARS} characters`);
    return [
      `<dataValidation type="list" errorStyle="warning" allowBlank="1" showErrorMessage="1" errorTitle="${attr(title)}" error="${attr(message)}" sqref="${sqref}">` +
        `<formula1>${escapeText(range)}</formula1></dataValidation>`,
    ];
  });
  return lists.length === 0 ? "" : `<dataValidations count="${lists.length}">${lists.join("")}</dataValidations>`;
}

export function xlsxWriter(opts: XlsxWriterOptions): XlsxWriter {
  const { sheetName, header } = opts;
  const maxRows = opts.maxRows ?? MAX_SHEET_ROWS;
  const extra = opts.sheets ?? [];
  const problem = sheetNameProblem(sheetName);
  if (problem !== null) throw new Error(problem);
  const seen = new Set([sheetName.toLowerCase()]);
  for (const sheet of extra) {
    const bad = sheetNameProblem(sheet.name);
    if (bad !== null) throw new Error(bad);
    if (seen.has(sheet.name.toLowerCase())) throw new Error(`two sheets are named ${sheet.name}`);
    seen.add(sheet.name.toLowerCase());
    if (sheet.header.length === 0 || sheet.header.length > MAX_COLUMNS) throw new Error(`a sheet needs between 1 and ${MAX_COLUMNS} columns`);
  }
  if (header.length === 0 || header.length > MAX_COLUMNS) throw new Error(`a sheet needs between 1 and ${MAX_COLUMNS} columns`);
  const shaded = new Set(opts.shadedColumns ?? []);
  const bold = new Set(opts.boldHeadings ?? []);
  for (const heading of Object.keys(opts.widths ?? {})) if (!header.includes(heading)) throw new Error(`a width for a column the sheet does not have: ${heading}`);
  for (const heading of [...shaded, ...bold]) if (!header.includes(heading)) throw new Error(`styling for a column the sheet does not have: ${heading}`);
  // Own entries only: a heading such as "constructor" must not find a width on Object.prototype.
  const widthOf = (heading: string) => (opts.widths !== undefined && Object.hasOwn(opts.widths, heading) ? opts.widths[heading]! : 16);
  // The style of each column's cells and of its heading.
  const bodyStyles = header.map((h) => (shaded.has(h) ? STYLE_GREY : STYLE_TEXT));
  const headStyles = header.map((h, at) => (bold.has(h) ? STYLE_BOLD : bodyStyles[at]!));
  // Worked out before anything is written, so a bad list fails the download at its start and not at its end.
  const dropdowns = choicesXml(header, opts.choices ?? {}, extra);
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

  /** One row's XML. `styles` is the style of each column's cell. */
  const rowXml = (r: number, cells: ReadonlyArray<string | null>, styles: readonly number[]): string => {
    if (cells.length > MAX_COLUMNS) throw new Error(`a sheet holds at most ${MAX_COLUMNS} columns; row ${r} has ${cells.length}`);
    let xml = `<row r="${r}">`;
    cells.forEach((value, at) => {
      // A cell that was left out still carries its column's style, so a program that ignores the column's default
      // style still treats what a person types there as text.
      const s = styles[at] ?? STYLE_TEXT;
      if (value === null) {
        xml += `<c r="${columnName(at)}${r}" s="${s}"/>`;
        return;
      }
      if (value.length > MAX_CELL_CHARS) throw new Error(`a cell holds at most ${MAX_CELL_CHARS} characters; row ${r}, column ${at + 1} has ${value.length}`);
      xml += `<c r="${columnName(at)}${r}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${escapeText(value)}</t></is></c>`;
    });
    return `${xml}</row>`;
  };
  const row = (cells: ReadonlyArray<string | null>, styles: readonly number[]): string => {
    // Excel's own limits: a file past them cannot be opened by the program it is meant for.
    if (next > maxRows) throw new Error(`a sheet holds at most ${maxRows} rows`);
    return rowXml(next++, cells, styles);
  };
  const encoder = new TextEncoder();
  const sheetXml = (width: number, rows: string, validations: string, style: number) =>
    `${XML_HEAD}<worksheet xmlns="${NS_MAIN}">` +
    // The Text format for every cell of every column, those with no cell included.
    `<cols><col min="1" max="${width}" width="16" style="${style}" customWidth="1"/></cols>` +
    `<sheetData>${rows}</sheetData>${validations}</worksheet>`;
  // Sheet 1 is the main one; the extra sheets follow it.
  const sheetPart = (i: number) => `xl/worksheets/sheet${i}.xml`;

  return {
    head() {
      part(
        "[Content_Types].xml",
        `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          Array.from({ length: extra.length + 1 }, (_, k) => k + 1)
            .map((k) => `<Override PartName="/${sheetPart(k)}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
            .join("") +
          `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
          `</Types>`,
      );
      part(
        "_rels/.rels",
        `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      );
      const names = [sheetName, ...extra.map((s) => s.name)];
      part(
        "xl/workbook.xml",
        `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
          names.map((n, i) => `<sheet name="${attr(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
          `</sheets></workbook>`,
      );
      part(
        "xl/_rels/workbook.xml.rels",
        `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
          names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
          `<Relationship Id="rId${names.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
          `</Relationships>`,
      );
      // Style 1 is the Text format, 2 the Text format in bold, 3 the Text format on grey. Style 0 is the spreadsheet's default and is used by nothing.
      part(
        "xl/styles.xml",
        `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">` +
          `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
          `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
          `<fill><patternFill patternType="solid"><fgColor rgb="${SHADE_RGB}"/><bgColor indexed="64"/></patternFill></fill></fills>` +
          `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
          `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
          `<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
          `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
          `<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>` +
          `<xf numFmtId="49" fontId="0" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/></cellXfs>` +
          `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
          `</styleSheet>`,
      );
      sheet = new ZipDeflate(sheetPart(1), { level: 6 });
      zip.add(sheet);
      // The column style is the Text format; a shaded column's cells carry their own grey, and no column is shaded as a whole.
      sheet.push(
        encoder.encode(
          `${XML_HEAD}<worksheet xmlns="${NS_MAIN}">` +
            `<cols>${header
              .map((_, at) => `<col min="${at + 1}" max="${at + 1}" width="${widthOf(header[at]!)}" style="${bodyStyles[at]}" customWidth="1"/>`)
              .join("")}</cols>` +
            `<sheetData>${row(header, headStyles)}`,
        ),
      );
      return take();
    },
    rows(rows) {
      sheet.push(encoder.encode(rows.map((cells) => row(cells, bodyStyles)).join("")));
      return take();
    },
    tail() {
      sheet.push(encoder.encode(`</sheetData>${dropdowns}</worksheet>`), true);
      extra.forEach((s, i) => {
        if (s.rows.length + 1 > MAX_SHEET_ROWS) throw new Error(`a sheet holds at most ${MAX_SHEET_ROWS} rows`);
        const plain = s.header.map(() => STYLE_TEXT);
        const rows = [s.header, ...s.rows].map((cells, at) => rowXml(at + 1, cells, plain)).join("");
        part(sheetPart(i + 2), sheetXml(s.header.length, rows, "", STYLE_TEXT));
      });
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
