import { strToU8, zipSync } from "fflate";
import { columnName } from "../src/app/xlsx.js";

/**
 * A cell as a test wants a spreadsheet to have stored it: text, nothing (null,
 * the cell is absent), or one of the kinds a spreadsheet makes of what a
 * person types.
 */
export type TestCell =
  | string
  | null
  /** A number, with the digits as the file stores them. */
  | { number: string }
  /** A number shown as a date: the spreadsheet's serial day. */
  | { date: number }
  | { formula: string; cached: string }
  | { boolean: boolean }
  | { error: string };

// The quote too: a sheet's name goes into an attribute, and a name with a quote in it would end the attribute early.
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A workbook of one sheet, written the plain way: text in text-formatted
 * cells, the other kinds as a spreadsheet stores them. Not the app's writer,
 * so a test of the app does not rest on it.
 */
export function buildWorkbook(
  rows: ReadonlyArray<ReadonlyArray<TestCell>>,
  /** `name` is the sheet's name; `others` are the names of more sheets, each with one cell, put `before` the sheet or after it. */
  options: { name?: string; others?: string[]; before?: boolean } = {},
): Uint8Array {
  const name = options.name ?? "specimens";
  const others = options.others ?? [];
  const cell = (value: TestCell, ref: string): string => {
    if (value === null) return "";
    if (typeof value === "string") return `<c r="${ref}" s="1" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
    if ("number" in value) return `<c r="${ref}"><v>${value.number}</v></c>`;
    if ("date" in value) return `<c r="${ref}" s="2"><v>${value.date}</v></c>`;
    if ("formula" in value) return `<c r="${ref}" t="str"><f>${esc(value.formula)}</f><v>${esc(value.cached)}</v></c>`;
    if ("boolean" in value) return `<c r="${ref}" t="b"><v>${value.boolean ? 1 : 0}</v></c>`;
    return `<c r="${ref}" t="e"><v>${esc(value.error)}</v></c>`;
  };
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    rows.map((r, i) => `<row r="${i + 1}">${r.map((v, at) => cell(v, `${columnName(at)}${i + 1}`)).join("")}</row>`).join("") +
    `</sheetData></worksheet>`;
  const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const own = `<sheet name="${esc(name)}" sheetId="1" r:id="rId1"/>`;
  const more = others.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 2}" r:id="rId${i + 2}"/>`).join("");
  const tabs = options.before === true ? more + own : own + more;
  const extra = Object.fromEntries(
    others.map((n, i) => [
      `xl/worksheets/sheet${i + 2}.xml`,
      strToU8(`<?xml version="1.0"?><worksheet xmlns="${main}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${esc(n)}</t></is></c></row></sheetData></worksheet>`),
    ]),
  );
  const relationships =
    `<Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/>` +
    others.map((_, i) => `<Relationship Id="rId${i + 2}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 2}.xml"/>`).join("") +
    // Without this relationship a reader never looks at the styles, and a date is a number.
    `<Relationship Id="rId99" Type="${rel}/styles" Target="styles.xml"/>`;
  return zipSync({
    ...extra,
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        [1, ...others.map((_, i) => i + 2)].map((n) => `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        `</Types>`,
    ),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="${main}" xmlns:r="${rel}"><sheets>${tabs}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`,
    ),
    // 0 General, 1 Text, 2 a date (built-in format 14).
    "xl/styles.xml": strToU8(
      `<?xml version="1.0"?><styleSheet xmlns="${main}"><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="49"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  });
}

/** The spreadsheet serial for a calendar day, as the 1900 system counts it. */
export const serialOf = (isoDay: string): number => Date.parse(`${isoDay}T00:00:00Z`) / 86_400_000 + 25569;
