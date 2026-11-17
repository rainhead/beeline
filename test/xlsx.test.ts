import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_CELL_CHARS, MAX_CHOICES_CHARS, MAX_COLUMNS, MAX_SHEET_ROWS, columnIndex, columnName, escapeText, writeXlsx, xlsxWriter } from "../src/app/xlsx.js";
import type { XlsxCell, XlsxRead } from "../src/app/xlsx.js";
import { readXlsx, readXlsxHere } from "../src/app/xlsx-reader.js";
import { buildWorkbook, serialOf } from "./workbook.js";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** The sheet of a read that must have worked. */
function sheetOf(read: XlsxRead) {
  if (!read.ok) throw new Error(`refused: ${read.refusal}`);
  return read.sheet;
}

/** A cell by its reference, `B2`. */
function at(read: XlsxRead, ref: string): XlsxCell | undefined {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  return sheetOf(read).rows.find((r) => r.row === Number(m[2]))?.cells.get(columnIndex(m[1]!)!);
}

/**
 * A workbook from its parts, laid out as a spreadsheet program lays them out: the styles and the shared strings
 * are related to the workbook, which is how a reader finds them.
 */
function workbook(parts: { sheet: string; shared?: string; styles?: string; workbookPr?: string; sheets?: string }): Uint8Array {
  return zipSync({
    // A reader finds the parts by these, as well as by the relationships.
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0"?><workbook xmlns="${MAIN}" xmlns:r="${REL}">${parts.workbookPr ?? ""}<sheets>${parts.sheets ?? `<sheet name="Sheet1" sheetId="1" r:id="rId1"/>`}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>` +
        `<Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId4" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet xmlns="${MAIN}"><sheetData>${parts.sheet}</sheetData></worksheet>`),
    "xl/worksheets/sheet2.xml": strToU8(`<?xml version="1.0"?><worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>second sheet</t></is></c></row></sheetData></worksheet>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0"?><styleSheet xmlns="${MAIN}">${parts.styles ?? `<cellXfs count="1"><xf numFmtId="0"/></cellXfs>`}</styleSheet>`),
    "xl/sharedStrings.xml": strToU8(`<?xml version="1.0"?><sst xmlns="${MAIN}">${parts.shared ?? ""}</sst>`),
  });
}

describe("column letters", () => {
  it("names a column and reads the name back", () => {
    expect([0, 1, 25, 26, 27, 701, 702, 16383].map(columnName)).toEqual(["A", "B", "Z", "AA", "AB", "ZZ", "AAA", "XFD"]);
    for (const n of [0, 25, 26, 701, 702, 16383]) expect(columnIndex(columnName(n))).toBe(n);
    expect(columnIndex("a")).toBe(0);
    expect(columnIndex("A1")).toBeNull();
    expect(columnIndex("")).toBeNull();
  });
});

describe("writing a workbook, and what SheetJS makes of it", () => {
  const values = [
    "plain",
    "-122.45678901234567",
    "2025-07",
    "00123",
    "12345678901234567890",
    "=1+1",
    "-x",
    "+1",
    "@mention",
    "'quoted",
    " leading",
    "trailing ",
    "a&b <c> \"d\" 'e'",
    "tab\there",
    "line\nbreak",
    "x".repeat(300),
    "é 日本語 🐝",
    "_x0041_ literal",
  ];

  it("keeps every value exactly, as text, and a null is no cell", () => {
    const bytes = writeXlsx({ sheetName: "specimens", header: ["h1", "h2"] }, values.map((v) => [v, null]));
    const read = readXlsxHere(bytes);
    const sheet = sheetOf(read);
    expect(sheet.name).toBe("specimens");
    expect(sheet.rows[0]!.cells.get(0)).toEqual({ text: "h1", type: "text" });
    values.forEach((value, i) => {
      const row = sheet.rows[i + 1]!;
      expect(row.row).toBe(i + 2);
      expect(row.cells.get(0), JSON.stringify(value)).toEqual({ text: value, type: "text" });
      // A null is a cell with a style and nothing in it.
      expect(row.cells.has(1)).toBe(false);
    });
  });

  it("writes only text cells in the Text format, with that format for every column", () => {
    const parts = unzipSync(writeXlsx({ sheetName: "s", header: ["a", "b", "c"] }, [["1", null, "=2"]]));
    const sheet = new TextDecoder().decode(parts["xl/worksheets/sheet1.xml"]);
    const cells = [...sheet.matchAll(/<c [^>]*>/g)].map((m) => m[0]);
    expect(cells.length).toBe(6);
    for (const c of cells) expect(c).toContain(`s="1"`);
    // Five hold text; the sixth, the null, is an empty cell that carries the Text style of its own, so a program that ignores the column's style still types text there.
    expect(cells.filter((c) => c.includes(`t="inlineStr"`))).toHaveLength(5);
    expect(sheet).toContain(`<c r="B2" s="1"/>`);
    // No formula element anywhere: a leading = is a character.
    expect(sheet).not.toContain("<f");
    // Style 1 is the Text format, and every column has it, so a cell nobody wrote is text when somebody types in it.
    expect(new TextDecoder().decode(parts["xl/styles.xml"])).toContain(`<xf numFmtId="49"`);
    expect(sheet).toMatch(/<col min="1" max="3"[^>]*style="1"/);
  });

  it("offers a column's words as a dropdown below its heading, and keeps the cells text", () => {
    const bytes = writeXlsx({ sheetName: "s", header: ["a", "sex", "state"], choices: { sex: ["female", "male"], state: ["in collection", "R&D <1>"] } }, [
      ["1", "female", null],
    ]);
    const sheet = new TextDecoder().decode(unzipSync(bytes)["xl/worksheets/sheet1.xml"]);
    // After the rows, where the format puts it, one list for each column, from row 2 to the sheet's last row.
    expect(sheet).toMatch(/<\/sheetData><dataValidations count="2">.*<\/dataValidations><\/worksheet>$/);
    expect(sheet).toContain(`<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="B2:B${MAX_SHEET_ROWS}"><formula1>"female,male"</formula1></dataValidation>`);
    // The list is XML text like any other.
    expect(sheet).toContain(`sqref="C2:C${MAX_SHEET_ROWS}"><formula1>"in collection,R&amp;D &lt;1&gt;"</formula1>`);
    // The cells are what they were: text, in the Text format.
    const read = readXlsxHere(bytes);
    if (!read.ok) throw new Error(read.refusal);
    for (const row of read.sheet.rows) for (const cell of row.cells.values()) expect(cell.type).toBe("text");
    // No list, no element.
    expect(new TextDecoder().decode(unzipSync(writeXlsx({ sheetName: "s", header: ["a"] }, []))["xl/worksheets/sheet1.xml"])).not.toContain("dataValidation");
  });

  it("refuses choices it cannot write as a list", () => {
    const write = (choices: Record<string, string[]>) => () => writeXlsx({ sheetName: "s", header: ["a"], choices }, []);
    expect(write({ b: ["x"] })).toThrow(/does not have: b/);
    expect(write({ a: [] })).toThrow(/without commas or quotes/);
    expect(write({ a: ["one, two"] })).toThrow(/without commas or quotes/);
    expect(write({ a: ['say "x"'] })).toThrow(/without commas or quotes/);
    expect(write({ a: ["x".repeat(MAX_CHOICES_CHARS + 1)] })).toThrow(/more than 255 characters/);
    expect(write({ a: ["x".repeat(MAX_CHOICES_CHARS)] })).not.toThrow();
  });

  it("writes the same file whether it is given all at once or a page at a time", () => {
    const writer = xlsxWriter({ sheetName: "s", header: ["a", "b"] });
    const chunks = [...writer.head(), ...writer.rows([["1", "2"]]), ...writer.rows([["3", null], ["4", "5"]]), ...writer.tail()];
    const whole = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      whole.set(c, offset);
      offset += c.length;
    }
    const sheet = sheetOf(readXlsxHere(whole));
    expect(sheet.rows.map((r) => [r.row, ...[0, 1].map((i) => r.cells.get(i)?.text ?? null)])).toEqual([
      [1, "a", "b"],
      [2, "1", "2"],
      [3, "3", null],
      [4, "4", "5"],
    ]);
  });

  it("escapes what XML cannot carry, and nothing else", () => {
    expect(escapeText("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
    expect(escapeText("\u0001")).toBe("_x0001_");
    expect(escapeText("_x0041_")).toBe("_x005F_x0041_");
    expect(escapeText("plain _x text")).toBe("plain _x text");
    expect(escapeText("\r")).toBe("&#13;");
  });

  it("refuses a name that is not a sheet's", () => {
    expect(() => xlsxWriter({ sheetName: "a/b", header: ["x"] })).toThrow();
    expect(() => xlsxWriter({ sheetName: "", header: ["x"] })).toThrow();
    expect(() => xlsxWriter({ sheetName: "x".repeat(32), header: ["x"] })).toThrow();
    expect(() => xlsxWriter({ sheetName: "s", header: [] })).toThrow();
  });

  it("refuses a cell over 32,767 characters, and takes one at the limit", () => {
    expect(() => writeXlsx({ sheetName: "s", header: ["a"] }, [["x".repeat(MAX_CELL_CHARS + 1)]])).toThrow(/32767 characters/);
    // A data row is held to the same width as the header: a cell past the last column Excel has is no cell.
    expect(() => writeXlsx({ sheetName: "s", header: ["a"] }, [Array.from({ length: MAX_COLUMNS + 1 }, () => "x")])).toThrow(/16384 columns/);
    expect(() => writeXlsx({ sheetName: "s", header: ["a"] }, [Array.from({ length: MAX_COLUMNS }, () => "x")])).not.toThrow();
    expect(sheetOf(readXlsxHere(writeXlsx({ sheetName: "s", header: ["a"] }, [["x".repeat(MAX_CELL_CHARS)]]))).rows[1]!.cells.get(0)!.text).toHaveLength(MAX_CELL_CHARS);
  });

  it("refuses a sheet past its last row, and takes one that ends there", () => {
    // The limit is Excel's 1,048,576, the header counted; a smaller one is used here so the test does not write a million rows.
    expect(MAX_SHEET_ROWS).toBe(1_048_576);
    expect(() => writeXlsx({ sheetName: "s", header: ["a"], maxRows: 3 }, [["1"], ["2"], ["3"]])).toThrow(/at most 3 rows/);
    expect(sheetOf(readXlsxHere(writeXlsx({ sheetName: "s", header: ["a"], maxRows: 3 }, [["1"], ["2"]]))).rows).toHaveLength(3);
  });
});

describe("how a cell's kind is decided", () => {
  const styles =
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>` +
    `<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="49"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs>`;

  it("types text, numbers, dates, booleans, errors and formulas", () => {
    const read = readXlsxHere(
      workbook({
        styles,
        shared: `<si><t>shared text</t></si><si><r><t>rich </t></r><r><t>text</t></r></si>`,
        sheet:
          `<row r="1">` +
          `<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>inline</t></is></c>` +
          `<c r="D1"><v>44.564599999999999</v></c>` +
          `<c r="E1" s="2"><v>45852</v></c><c r="F1" s="3"><v>45852</v></c><c r="G1" s="3"><v>45852.5</v></c>` +
          `<c r="H1" t="b"><v>1</v></c><c r="I1" t="b"><v>0</v></c>` +
          `<c r="J1" t="e"><v>#DIV/0!</v></c>` +
          `<c r="K1"><f>D1*2</f><v>89.1292</v></c><c r="L1" t="str"><f>A1&amp;"x"</f><v>shared textx</v></c>` +
          `<c r="M1" s="1" t="s"><v>0</v></c>` +
          `</row>`,
      }),
    );
    expect("ABCDEFGHIJKLM".split("").map((c) => at(read, `${c}1`))).toEqual([
      { text: "shared text", type: "text" },
      { text: "rich text", type: "text" },
      { text: "inline", type: "text" },
      // The number it is, not the digits the file stores it in.
      { text: "44.5646", type: "number" },
      { text: "2025-07-14", type: "date" },
      { text: "2025-07-14", type: "date" },
      { text: "2025-07-14 12:00:00", type: "date" },
      { text: "TRUE", type: "boolean" },
      { text: "FALSE", type: "boolean" },
      { text: "#DIV/0!", type: "error" },
      // A formula is read by its cached value, and is marked.
      { text: "89.1292", type: "formula" },
      { text: "shared textx", type: "formula" },
      { text: "shared text", type: "text" },
    ]);
  });

  it("takes a date only where the number format shows one, by the library's own test", () => {
    const formats = ["0_D", "0.00_M", '0"day"', "[Red]0", "#,##0.00_);[Red](#,##0.00)", "yyyy\\-mm\\-dd", "mm/dd/yy", "[h]:mm", "d_D", "General", "@"];
    const date = new Set(["yyyy\\-mm\\-dd", "mm/dd/yy", "[h]:mm", "d_D"]);
    const codes = formats.map((f, i) => `<numFmt numFmtId="${200 + i}" formatCode="${f.replace(/"/g, "&quot;")}"/>`).join("");
    const xfs = formats.map((_, i) => `<xf numFmtId="${200 + i}"/>`).join("");
    const cells = formats.map((_, i) => `<c r="${columnName(i)}1" s="${i}"><v>45852</v></c>`).join("");
    const read = readXlsxHere(workbook({ styles: `<numFmts count="${formats.length}">${codes}</numFmts><cellXfs count="${formats.length}">${xfs}</cellXfs>`, sheet: `<row r="1">${cells}</row>` }));
    expect(formats.map((f, i) => [f, at(read, `${columnName(i)}1`)!.type])).toEqual(formats.map((f) => [f, date.has(f) ? "date" : "number"]));
  });

  it("counts dates from 1900 or from 1904, as the workbook says", () => {
    const cells = `<row r="1"><c r="A1" s="1"><v>45852</v></c><c r="B1" s="1"><v>44390</v></c><c r="C1" s="1"><v>0</v></c></row>`;
    const styles14 = `<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>`;
    const system1900 = readXlsxHere(workbook({ styles: styles14, sheet: cells }));
    expect([at(system1900, "A1")?.text, at(system1900, "B1")?.text]).toEqual(["2025-07-14", "2021-07-13"]);
    // Zero is no day in the 1900 system, so the number is shown as it is.
    expect(at(system1900, "C1")?.text).toBe("0");
    const system1904 = readXlsxHere(workbook({ styles: styles14, sheet: cells, workbookPr: `<workbookPr date1904="1"/>` }));
    // The same serial is 1462 days later, and zero is 1 January 1904.
    expect([at(system1904, "A1")?.text, at(system1904, "B1")?.text, at(system1904, "C1")?.text]).toEqual(["2029-07-15", "2025-07-14", "1904-01-01"]);
  });

  it("is told a date by the app's own test builder too", () => {
    const read = readXlsxHere(buildWorkbook([["a"], [{ date: serialOf("2025-07-14") }]]));
    expect(at(read, "A2")).toEqual({ text: "2025-07-14", type: "date" });
  });

  it("gives a formula's cached value and marks the cell, whatever the value is", () => {
    const read = readXlsxHere(workbook({ sheet: `<row r="1"><c r="A1"><f>1+1</f><v>2</v></c><c r="B1" t="b"><f>TRUE()</f><v>1</v></c><c r="C1" t="str"><f>"a"</f><v>a</v></c></row>` }));
    expect(["A1", "B1", "C1"].map((r) => at(read, r)?.type)).toEqual(["formula", "formula", "formula"]);
  });

  it("marks every cell an array formula covers, which holds only its result, and none outside it", () => {
    const read = readXlsxHere(
      workbook({
        sheet:
          `<row r="1"><c r="E1"><v>9</v></c></row>` +
          `<row r="2"><c r="E2"><f t="array" ref="E2:F3">A1:A2*2</f><v>3</v></c><c r="F2"><v>7</v></c><c r="G2"><v>1</v></c></row>` +
          `<row r="3"><c r="E3"><v>4</v></c><c r="F3"><v>5</v></c></row>` +
          `<row r="4"><c r="E4"><v>5</v></c></row>`,
      }),
    );
    expect(["E1", "E2", "F2", "G2", "E3", "F3", "E4"].map((r) => at(read, r)?.type)).toEqual(["number", "formula", "formula", "number", "formula", "formula", "number"]);
  });

  it("places a cell by its reference, so a gap is an absent cell and not a shifted one", () => {
    const read = readXlsxHere(
      workbook({
        sheet:
          `<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="C1" t="inlineStr"><is><t>c</t></is></c><c r="AA1" t="inlineStr"><is><t>aa</t></is></c></row>` +
          `<row r="4"><c r="B4" t="inlineStr"><is><t>b4</t></is></c></row>` +
          `<row r="5"/>`,
      }),
    );
    expect(sheetOf(read).rows.map((r) => [r.row, [...r.cells.keys()]])).toEqual([[1, [0, 2, 26]], [4, [1]]]);
    expect(at(read, "B1")).toBeUndefined();
  });
});

describe("which sheet is read", () => {
  const book = (rows: string[][], options?: { name?: string; others?: string[]; before?: boolean }) => buildWorkbook(rows, options);
  const rows = [["h"], ["v"]];

  it("reads the sheet named, whatever its place, and lists the others as not read", () => {
    const read = readXlsxHere(book(rows, { others: ["notes", "specimens (2)"], before: true }), { sheetName: "specimens" });
    expect(sheetOf(read).name).toBe("specimens");
    expect(at(read, "A2")?.text).toBe("v");
    expect(read.ok && read.otherSheets).toEqual(["notes", "specimens (2)"]);
  });

  it("reads the only sheet when it has another name, and says there were no others", () => {
    const read = readXlsxHere(book(rows, { name: "Sheet1" }), { sheetName: "specimens" });
    expect(sheetOf(read).name).toBe("Sheet1");
    expect(read.ok && read.otherSheets).toEqual([]);
  });

  it("refuses several sheets none of which is the one named, naming them", () => {
    expect(readXlsxHere(book(rows, { name: "a", others: ["b"] }), { sheetName: "specimens" })).toEqual({ ok: false, refusal: "no_such_sheet", sheets: ["a", "b"] });
  });

  it("reads the first sheet when none is asked for", () => {
    expect(sheetOf(readXlsxHere(book(rows, { name: "a", others: ["b"], before: true }))).name).toBe("b");
  });
});

describe("refusing a file", () => {
  const sheet = `<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row>`;

  it("refuses what is not a zip before the library sees it: a CSV above all, which it would read as a sheet", async () => {
    expect(await readXlsx(new TextEncoder().encode("specimenId,locality\n1,x\n"))).toEqual({ ok: false, refusal: "not_a_zip" });
    expect(await readXlsx(new Uint8Array(0))).toEqual({ ok: false, refusal: "not_a_zip" });
  });

  it("refuses an OLE file, which is an old .xls and also an encrypted or labelled workbook", async () => {
    expect(await readXlsx(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))).toEqual({ ok: false, refusal: "protected_file" });
  });

  it("refuses a file over the size limit", async () => {
    const bytes = workbook({ sheet });
    expect(await readXlsx(bytes, { maxBytes: bytes.length - 1 })).toEqual({ ok: false, refusal: "too_large" });
    expect((await readXlsx(bytes, { maxBytes: bytes.length })).ok).toBe(true);
  });

  it("refuses a zip that is not a workbook, and a file cut off, as unreadable and never as an exception", async () => {
    const notBook = readXlsxHere(zipSync({ "hello.txt": strToU8("hi") }));
    expect(notBook.ok).toBe(false);
    const whole = workbook({ sheet });
    expect((await readXlsx(whole.subarray(0, Math.floor(whole.length / 2)))).ok).toBe(false);
    // The start of a zip and nothing after it.
    expect(await readXlsx(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toMatchObject({ ok: false });
  });

  it("refuses more rows than the limit, and takes one at the limit", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>x</t></is></c></row>`).join("");
    expect(readXlsxHere(workbook({ sheet: rows(11) }), { maxRows: 10 })).toEqual({ ok: false, refusal: "too_many_rows" });
    expect(readXlsxHere(workbook({ sheet: rows(10) }), { maxRows: 10 }).ok).toBe(true);
    // Rows with nothing in them between are rows that count against the limit all the same, since they are read.
    expect(readXlsxHere(workbook({ sheet: rows(11) }), { maxRows: 5 })).toEqual({ ok: false, refusal: "too_many_rows" });
  });

  it("refuses a row with more cells than a download has columns", () => {
    const cells = (n: number) => Array.from({ length: n }, (_, i) => `<c r="${columnName(i)}1" t="inlineStr"><is><t>x</t></is></c>`).join("");
    expect(readXlsxHere(workbook({ sheet: `<row r="1">${cells(501)}</row>` }))).toEqual({ ok: false, refusal: "too_wide" });
    expect(readXlsxHere(workbook({ sheet: `<row r="1">${cells(500)}</row>` })).ok).toBe(true);
    expect(readXlsxHere(workbook({ sheet: `<row r="1">${cells(6)}</row>` }), { maxCellsPerRow: 5 })).toEqual({ ok: false, refusal: "too_wide" });
  });
});

describe("the worker the upload is read in", () => {
  it("reads the same as the adapter does in this thread", async () => {
    const bytes = buildWorkbook([["a", "b"], ["x", { number: "44.5646" }], [{ date: serialOf("2025-07-14") }, { formula: "=1", cached: "1" }]], { others: ["notes"] });
    const here = readXlsxHere(bytes, { sheetName: "specimens" });
    const there = await readXlsx(bytes, { sheetName: "specimens" });
    expect(there).toEqual(here);
    expect(there.ok && there.otherSheets).toEqual(["notes"]);
  });

  it("reads two workbooks at once", async () => {
    const one = buildWorkbook([["one"], ["1"]]);
    const two = buildWorkbook([["two"], ["2"]]);
    const [a, b] = await Promise.all([readXlsx(one), readXlsx(two), readXlsx(one), readXlsx(two)]);
    expect([at(a!, "A2")?.text, at(b!, "A2")?.text]).toEqual(["1", "2"]);
  });

  it("refuses a workbook that needs more memory than the worker has, and carries on afterwards", async () => {
    // 50,000 rows of 400-character cells: 20 MB of XML that compresses to a few kilobytes, which a 24 MB heap cannot hold.
    const text = "x".repeat(400);
    const rows = Array.from({ length: 50_000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${text}</t></is></c></row>`).join("");
    const bomb = zipSync({
      ...unzipSync(buildWorkbook([["a"]])),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="${MAIN}"><sheetData>${rows}</sheetData></worksheet>`),
    });
    expect(bomb.length).toBeLessThan(500_000);
    expect(await readXlsx(bomb, { memoryMb: 24, timeMs: 60_000 })).toEqual({ ok: false, refusal: "too_large_unpacked" });
    // The same file is read with the heap the app gives it, so it was the limit that refused it, and the process is still answering.
    expect((await readXlsx(bomb, { timeMs: 60_000 })).ok).toBe(true);
  }, 90_000);

  it("refuses a workbook that takes longer than the limit, and carries on afterwards", async () => {
    const bytes = buildWorkbook([["a"], ["b"]]);
    expect(await readXlsx(bytes, { timeMs: 1 })).toEqual({ ok: false, refusal: "took_too_long" });
    expect((await readXlsx(bytes)).ok).toBe(true);
  });
});

/**
 * A workbook that Beeline's writer made and openpyxl, a second program, opened and saved again after somebody
 * typed over one cell and into one empty cell (test/fixtures/make-openpyxl-resaved.py). openpyxl rewrote the
 * whole package (its own theme, document properties, styles and sheet XML) and kept the strings inline. It was NOT
 * written by Excel, LibreOffice Calc or Google Sheets, which have not been tried.
 */
describe("a workbook Beeline wrote and openpyxl saved again", () => {
  it("reads every cell as text, and what was typed in is there", async () => {
    const bytes = new Uint8Array(await readFile(join(import.meta.dirname, "fixtures", "openpyxl-resaved.xlsx")));
    // The package is openpyxl's, not Beeline's writer's.
    const parts = unzipSync(bytes);
    expect(Object.keys(parts)).toContain("xl/theme/theme1.xml");
    expect(new TextDecoder().decode(parts["xl/worksheets/sheet1.xml"])).toContain("<sheetPr>");
    const sheet = sheetOf(await readXlsx(bytes, { sheetName: "specimens" }));
    expect(sheet.name).toBe("specimens");
    const rows = sheet.rows.map((r) => [r.row, [...r.cells.entries()].map(([c, v]) => `${columnName(c)}:${v.type}:${v.text}`)]);
    expect(rows).toEqual([
      [1, ["A:text:specimenId", "B:text:locality", "C:text:eventDate", "D:text:decimalLongitude", "E:text:note"]],
      // The cell that began with = is still a string: openpyxl kept it as one.
      [2, ["A:text:1001", "B:text:Corvallis", "C:text:2026-07-14", "D:text:-123.45678901234567", "E:text:=1+1"]],
      // Typed over, and typed into an empty cell.
      [3, ["A:text:1002", "B:text:Philomath", "C:text:2026-07-14", "D:text:-123.45678901234567", "E:text:a note"]],
    ]);
  });
});

/** Whether a spreadsheet program that can open an .xlsx is installed: LibreOffice's Calc, not only its Writer. */
const calc = (() => {
  const found = ["/usr/bin/soffice", "/usr/local/bin/soffice", "/opt/libreoffice/program/soffice"].find((p) => existsSync(p));
  if (found === undefined) return null;
  const program = dirname(realpathSync(found));
  return existsSync(join(program, "libsclo.so")) || existsSync(join(program, "libsclo.dylib")) ? found : null;
})();

describe("a round trip through a spreadsheet program", () => {
  const rows: Array<Array<string | null>> = [
    ["-122.45678901234567", "2025-07", "00123", "12345678901234567890", "7/4/2025"],
    ["=1+1", "Jul-26", "TRUE", "1e5", "0x10"],
    [" lead", "trail ", "é日本", "x".repeat(300), "2025-07-14/2025-07-16"],
    ["-x", "'q", "a&b <c>", null, "1/2"],
  ];

  it(
    "keeps every cell's text, and keeps it text",
    async (ctx) => {
      // CI has no spreadsheet program, and a machine with only LibreOffice's Writer cannot open an .xlsx.
      if (calc === null) ctx.skip("no spreadsheet program that opens an .xlsx (LibreOffice Calc) is installed");
      const dir = await mkdtemp(join(tmpdir(), "xlsx-"));
      const written = join(dir, "written.xlsx");
      await writeFile(written, writeXlsx({ sheetName: "specimens", header: ["a", "b", "c", "d", "e"] }, rows));
      // Its own profile, so it does not meet a program that is already open.
      execFileSync(calc!, [`-env:UserInstallation=file://${join(dir, "profile")}`, "--headless", "--convert-to", "xlsx", "--outdir", join(dir, "out"), written], {
        timeout: 120_000,
        stdio: "ignore",
      });
      const read = readXlsxHere(new Uint8Array(await readFile(join(dir, "out", "written.xlsx"))));
      const sheet = sheetOf(read);
      expect(sheet.rows[0]!.cells.get(0)).toEqual({ text: "a", type: "text" });
      rows.forEach((row, i) => {
        row.forEach((value, c) => {
          const cell = sheet.rows[i + 1]!.cells.get(c);
          if (value === null) expect(cell).toBeUndefined();
          else expect(cell, `row ${i + 2} column ${c + 1}: ${JSON.stringify(value)}`).toEqual({ text: value, type: "text" });
        });
      });
    },
    150_000,
  );
});
