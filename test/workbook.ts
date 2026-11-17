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

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A workbook of one sheet, written the plain way: text in text-formatted
 * cells, the other kinds as a spreadsheet stores them. Not the app's writer,
 * so a test of the app does not rest on it.
 */
export function buildWorkbook(rows: ReadonlyArray<ReadonlyArray<TestCell>>): Uint8Array {
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
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="specimens" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
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
