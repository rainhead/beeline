import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_CELL_CHARS, MAX_SHEET_ROWS, columnIndex, columnName, escapeText, readXlsx, writeXlsx, xlsxWriter, type XlsxCell, type XlsxRead } from "../src/app/xlsx.js";
import { buildWorkbook } from "./workbook.js";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** The first sheet of a read that must have worked. */
function sheetOf(read: XlsxRead) {
  if (!read.ok) throw new Error(`refused: ${read.refusal}`);
  return read.sheet;
}

/** A cell by its reference, `B2`. */
function at(read: XlsxRead, ref: string): XlsxCell | undefined {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  return sheetOf(read).rows.find((r) => r.row === Number(m[2]))?.cells.get(columnIndex(m[1]!)!);
}

/** A workbook from its parts, as a spreadsheet program lays them out. */
function workbook(parts: { sheet: string; shared?: string; styles?: string; sheets?: string; extra?: Record<string, string> }): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0"?><workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>${parts.sheets ?? `<sheet name="Sheet1" sheetId="1" r:id="rId1"/>`}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet xmlns="${MAIN}"><sheetData>${parts.sheet}</sheetData></worksheet>`),
    "xl/worksheets/sheet2.xml": strToU8(`<?xml version="1.0"?><worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>second sheet</t></is></c></row></sheetData></worksheet>`),
    ...(parts.shared === undefined ? {} : { "xl/sharedStrings.xml": strToU8(`<?xml version="1.0"?><sst xmlns="${MAIN}">${parts.shared}</sst>`) }),
    ...(parts.styles === undefined ? {} : { "xl/styles.xml": strToU8(`<?xml version="1.0"?><styleSheet xmlns="${MAIN}">${parts.styles}</styleSheet>`) }),
    ...Object.fromEntries(Object.entries(parts.extra ?? {}).map(([k, v]) => [k, strToU8(v)])),
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

describe("writing a workbook and reading it back", () => {
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
    "  ",
    "a&b <c> \"d\" 'e'",
    "tab\there",
    "line\nbreak",
    "carriage\r\nreturn",
    "x".repeat(300),
    "é 日本語 🐝",
    "ctl\u0001\u0008\u000B\u001F",
    "lone \uD800 surrogate",
    "￾￿",
    "_x0041_ literal",
    "_x005F_x0041_ doubled",
    "]]> and <![CDATA[",
  ];

  it("keeps every value exactly, as text, and an empty string apart from null", () => {
    const bytes = writeXlsx({ sheetName: "specimens", header: ["h1", "h2", "h3"] }, [...values.map((v) => [v, null, ""]), ["", "", null]]);
    const read = readXlsx(bytes);
    const sheet = sheetOf(read);
    expect(sheet.name).toBe("specimens");
    expect(sheet.rows[0]!.cells.get(0)).toEqual({ text: "h1", type: "text" });
    values.forEach((value, i) => {
      const row = sheet.rows[i + 1]!;
      expect(row.row).toBe(i + 2);
      expect(row.cells.get(0), JSON.stringify(value)).toEqual({ text: value, type: "text" });
      // Null is a cell left out; an empty string is a cell that holds nothing.
      expect(row.cells.has(1)).toBe(false);
      expect(row.cells.get(2)).toEqual({ text: "", type: "text" });
    });
    const last = sheet.rows[values.length + 1]!;
    expect(last.cells.get(0)).toEqual({ text: "", type: "text" });
    expect(last.cells.has(2)).toBe(false);
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

  it("writes the same file whether it is given all at once or a page at a time", () => {
    const writer = xlsxWriter({ sheetName: "s", header: ["a", "b"] });
    const chunks = [...writer.head(), ...writer.rows([["1", "2"]]), ...writer.rows([["3", null], ["4", "5"]]), ...writer.tail()];
    const whole = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      whole.set(c, offset);
      offset += c.length;
    }
    const sheet = sheetOf(readXlsx(whole));
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
});

describe("reading what a spreadsheet program writes", () => {
  it("reads shared strings, with rich text joined and phonetic guides left out", () => {
    const read = readXlsx(
      workbook({
        shared:
          `<si><t>plain</t></si>` +
          `<si><r><rPr><b/></rPr><t>rich </t></r><r><t xml:space="preserve">text </t></r><r><t>runs</t></r></si>` +
          `<si><t>漢字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh><phoneticPr fontId="1"/></si>` +
          `<si><t xml:space="preserve">  padded  </t></si>` +
          `<si><t>a &amp; b &lt;c&gt; &#65;&#x42;</t></si>`,
        sheet:
          `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>`,
      }),
    );
    expect(["A1", "B1", "C1", "D1", "E1"].map((r) => at(read, r))).toEqual([
      { text: "plain", type: "text" },
      { text: "rich text runs", type: "text" },
      { text: "漢字", type: "text" },
      { text: "  padded  ", type: "text" },
      { text: "a & b <c> AB", type: "text" },
    ]);
  });

  it("reads inline strings, with runs", () => {
    const read = readXlsx(workbook({ sheet: `<row r="1"><c r="A1" t="inlineStr"><is><r><t>in</t></r><r><t>line</t></r></is></c></row>` }));
    expect(at(read, "A1")).toEqual({ text: "inline", type: "text" });
  });

  it("types numbers, dates, booleans, errors and formulas", () => {
    const read = readXlsx(
      workbook({
        styles:
          `<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="&quot;day&quot;0"/><numFmt numFmtId="166" formatCode="[Red]0.00"/></numFmts>` +
          `<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>` +
          `<cellXfs count="6"><xf numFmtId="0"/><xf numFmtId="49"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/></cellXfs>`,
        shared: `<si><t>text</t></si>`,
        sheet:
          `<row r="1">` +
          `<c r="A1" s="0"><v>44.5646</v></c>` +
          `<c r="B1" s="2"><v>45852</v></c>` +
          `<c r="C1" s="3"><v>45852.5</v></c>` +
          `<c r="D1" s="4"><v>7</v></c>` +
          `<c r="E1" s="5"><v>1.5</v></c>` +
          `<c r="F1" t="b"><v>1</v></c><c r="G1" t="b"><v>0</v></c>` +
          `<c r="H1" t="e"><v>#DIV/0!</v></c>` +
          `<c r="I1" t="str"><f>A1&amp;"x"</f><v>44.5646x</v></c>` +
          `<c r="J1"><f>A1*2</f><v>89.1292</v></c>` +
          `<c r="K1"><f t="shared" si="0"/><v>3</v></c>` +
          `<c r="L1" t="s" s="1"><v>0</v></c>` +
          `<c r="M1" t="d"><v>2025-07-14</v></c>` +
          `<c r="N1" s="1"/>` +
          `<c r="O1"><v></v></c>` +
          `</row>`,
      }),
    );
    const types = ["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H1", "I1", "J1", "K1", "L1", "M1"].map((r) => [r, at(read, r)]);
    expect(types).toEqual([
      ["A1", { text: "44.5646", type: "number" }],
      // A number in a date format: the day it is, as ISO.
      ["B1", { text: "2025-07-14", type: "date" }],
      ["C1", { text: "2025-07-14 12:00:00", type: "date" }],
      // A custom format that only quotes the word "day" is not a date.
      ["D1", { text: "7", type: "number" }],
      ["E1", { text: "1.5", type: "number" }],
      ["F1", { text: "TRUE", type: "boolean" }],
      ["G1", { text: "FALSE", type: "boolean" }],
      ["H1", { text: "#DIV/0!", type: "error" }],
      // A formula is read by its cached value, and is marked.
      ["I1", { text: "44.5646x", type: "formula" }],
      ["J1", { text: "89.1292", type: "formula" }],
      ["K1", { text: "3", type: "formula" }],
      ["L1", { text: "text", type: "text" }],
      ["M1", { text: "2025-07-14", type: "date" }],
    ]);
    // A cell with a style and nothing in it, or an empty value, is absent.
    expect(at(read, "N1")).toBeUndefined();
    expect(at(read, "O1")).toBeUndefined();
  });

  it("knows which built-in formats are dates", () => {
    const xfs = [14, 15, 22, 45, 49, 0, 1, 2, 10].map((id) => `<xf numFmtId="${id}"/>`).join("");
    const cells = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((s, i) => `<c r="${columnName(i)}1" s="${s}"><v>45852</v></c>`).join("");
    const read = readXlsx(workbook({ styles: `<cellXfs count="9">${xfs}</cellXfs>`, sheet: `<row r="1">${cells}</row>` }));
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => at(read, `${columnName(i)}1`)!.type)).toEqual([
      "date",
      "date",
      "date",
      "date",
      "number",
      "number",
      "number",
      "number",
      "number",
    ]);
  });

  it("places a cell by its reference, so a gap is an absent cell and not a shifted one", () => {
    const read = readXlsx(
      workbook({
        sheet:
          `<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="C1" t="inlineStr"><is><t>c</t></is></c><c r="AA1" t="inlineStr"><is><t>aa</t></is></c></row>` +
          `<row r="4"><c r="B4" t="inlineStr"><is><t>b4</t></is></c></row>` +
          // A row with nothing in it is not a row.
          `<row r="5"/>` +
          `<row r="6"><c r="A6" s="1"/></row>`,
      }),
    );
    const sheet = sheetOf(read);
    expect(sheet.rows.map((r) => [r.row, [...r.cells.keys()]])).toEqual([[1, [0, 2, 26]], [4, [1]]]);
    expect(at(read, "C1")?.text).toBe("c");
    expect(at(read, "B1")).toBeUndefined();
  });

  it("counts cells and rows that carry no reference", () => {
    const read = readXlsx(
      workbook({
        sheet: `<row><c t="inlineStr"><is><t>a</t></is></c><c t="inlineStr"><is><t>b</t></is></c></row><row><c t="inlineStr"><is><t>c</t></is></c></row>`,
      }),
    );
    expect(sheetOf(read).rows.map((r) => [r.row, [...r.cells.values()].map((c) => c.text)])).toEqual([[1, ["a", "b"]], [2, ["c"]]]);
  });

  it("reads the first sheet, however the file names its parts", () => {
    // A prefix on every element, the sheet by an absolute path, a comment, CDATA and a declaration.
    const bytes = zipSync({
      "xl/workbook.xml": strToU8(
        `<?xml version="1.0"?><!-- c --><x:workbook xmlns:x="${MAIN}" xmlns:r="${REL}"><x:sheets><x:sheet name="Second &amp; first" sheetId="9" r:id="rId7"/><x:sheet name="other" sheetId="2" r:id="rId8"/></x:sheets></x:workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        `<Relationships xmlns="x"><Relationship Id="rId8" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
      ),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>wrong</t></is></c></row></sheetData></worksheet>`),
      "xl/worksheets/sheet2.xml": strToU8(
        `<x:worksheet xmlns:x="${MAIN}"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t><![CDATA[a <b> & c]]></x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`,
      ),
    });
    const read = readXlsx(bytes);
    expect(sheetOf(read).name).toBe("Second & first");
    expect(at(read, "A1")).toEqual({ text: "a <b> & c", type: "text" });
  });
});

describe("refusing a file", () => {
  const sheet = `<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row>`;

  it("refuses what is not a zip, naming that", () => {
    expect(readXlsx(new TextEncoder().encode("specimenId,locality\n1,x\n"))).toEqual({ ok: false, refusal: "not_a_zip" });
    expect(readXlsx(new Uint8Array(0))).toEqual({ ok: false, refusal: "not_a_zip" });
    // A zip's first bytes and nothing after them.
    expect(readXlsx(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toEqual({ ok: false, refusal: "not_a_zip" });
    // An older .xls, or a workbook that is encrypted or carries a sensitivity label: an OLE file, which is neither.
    expect(readXlsx(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))).toEqual({ ok: false, refusal: "protected_file" });
  });

  it("refuses a file cut off in the middle", () => {
    const whole = workbook({ sheet });
    expect(readXlsx(whole.subarray(0, Math.floor(whole.length / 2))).ok).toBe(false);
  });

  it("refuses a sheet whose XML is cut short, instead of reading the rows before the cut", () => {
    // A well-formed zip, with its own sizes right, around a sheet that stops in the middle of a row.
    const cut = zipSync({
      "xl/workbook.xml": strToU8(`<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>kept?</t></is></c></row><row r="2"><c r="A2" t="inl`),
    });
    expect(readXlsx(cut)).toEqual({ ok: false, refusal: "unreadable" });
    const closed = zipSync({
      "xl/workbook.xml": strToU8(`<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>kept</t></is></c></row><row r="2">`),
    });
    expect(readXlsx(closed)).toEqual({ ok: false, refusal: "unreadable" });
  });

  it("refuses a zip that is not a workbook", () => {
    expect(readXlsx(zipSync({ "hello.txt": strToU8("hi") }))).toEqual({ ok: false, refusal: "not_a_workbook" });
    // A workbook whose sheet is not there.
    const noSheet = zipSync({
      "xl/workbook.xml": strToU8(`<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
    });
    expect(readXlsx(noSheet)).toEqual({ ok: false, refusal: "not_a_workbook" });
  });

  it("refuses a file over the size limit", () => {
    const bytes = workbook({ sheet });
    expect(readXlsx(bytes, { maxBytes: bytes.length - 1 })).toEqual({ ok: false, refusal: "too_large" });
    expect(readXlsx(bytes, { maxBytes: bytes.length }).ok).toBe(true);
  });

  it("refuses a file with more rows than the limit, and takes one at the limit", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>x</t></is></c></row>`).join("");
    expect(readXlsx(workbook({ sheet: rows(11) }), { maxRows: 10 })).toEqual({ ok: false, refusal: "too_many_rows" });
    expect(readXlsx(workbook({ sheet: rows(10) }), { maxRows: 10 }).ok).toBe(true);
  });

  const minimal = (sheetXml: Uint8Array | string) => ({
    "xl/workbook.xml": strToU8(`<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": typeof sheetXml === "string" ? strToU8(sheetXml) : sheetXml,
  });

  /** A zip with one entry's directory record changed. */
  const patchEntry = (zip: Uint8Array, name: string, patch: (view: DataView, at: number) => void): Uint8Array => {
    const out = new Uint8Array(zip);
    const view = new DataView(out.buffer);
    let end = out.length - 22;
    while (view.getUint32(end, true) !== 0x06054b50) end--;
    let at = view.getUint32(end + 16, true);
    for (let i = 0, count = view.getUint16(end + 10, true); i < count; i++) {
      const nameLength = view.getUint16(at + 28, true);
      if (new TextDecoder().decode(out.subarray(at + 46, at + 46 + nameLength)) === name) patch(view, at);
      at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }
    return out;
  };

  it("refuses a small file that declares far more than it should, before inflating anything", () => {
    // 6 MB of one byte compresses to a few kilobytes.
    const bomb = zipSync(minimal(new Uint8Array(6_000_000).fill(32)));
    expect(bomb.length).toBeLessThan(20_000);
    expect(readXlsx(bomb, { maxInflatedBytes: 1_000_000 })).toEqual({ ok: false, refusal: "too_large_unpacked" });
    // The size is judged on the zip's own word, before a byte is inflated: a small, valid sheet that declares a
    // big size is refused as too big, where inflating it would have found the sizes disagree (unreadable).
    const small = zipSync(minimal(`<worksheet><sheetData/></worksheet>`));
    expect(readXlsx(small, { maxInflatedBytes: 1_000_000 }).ok).toBe(true);
    const declaresBig = patchEntry(small, "xl/worksheets/sheet1.xml", (v, at) => v.setUint32(at + 24, 6_000_000, true));
    expect(readXlsx(declaresBig, { maxInflatedBytes: 1_000_000 })).toEqual({ ok: false, refusal: "too_large_unpacked" });
    // The cap is on what the parts add up to, not on one of them.
    const two = zipSync({ "xl/workbook.xml": new Uint8Array(600_000).fill(32), "xl/_rels/workbook.xml.rels": new Uint8Array(600_000).fill(32) });
    expect(readXlsx(two, { maxInflatedBytes: 1_000_000 })).toEqual({ ok: false, refusal: "too_large_unpacked" });
    // And the default allows a real file.
    expect(readXlsx(workbook({ sheet })).ok).toBe(true);
  });

  it("stops inflating when the output passes the cap, whatever size the zip declares", () => {
    const bomb = zipSync(minimal(new Uint8Array(6_000_000).fill(32)));
    // The directory says the sheet is ten bytes. It is six million: the inflate is cut off at the cap, not trusted.
    const lies = patchEntry(bomb, "xl/worksheets/sheet1.xml", (v, at) => v.setUint32(at + 24, 10, true));
    expect(readXlsx(lies, { maxInflatedBytes: 1_000_000 })).toEqual({ ok: false, refusal: "too_large_unpacked" });
    // Under the cap, a size that is not the size is a file that cannot be trusted.
    const small = zipSync(minimal(`<worksheet><sheetData/></worksheet>`));
    const wrong = patchEntry(small, "xl/worksheets/sheet1.xml", (v, at) => v.setUint32(at + 24, 5, true));
    expect(readXlsx(wrong)).toEqual({ ok: false, refusal: "unreadable" });
  });

  it("reads only the parts it needs: one sheet, not every sheet, and not what else the zip holds", () => {
    // Another sheet that would be refused as too big if it were read.
    const zip = zipSync({ ...minimal(`<worksheet><sheetData/></worksheet>`), "xl/worksheets/sheet2.xml": new Uint8Array(6_000_000).fill(32) });
    expect(readXlsx(zip, { maxInflatedBytes: 1_000_000 }).ok).toBe(true);
  });

  it("refuses entries that share one payload, and is not troubled by ones it never reads", () => {
    const zip = zipSync(minimal(`<worksheet><sheetData/></worksheet>`));
    let workbookAt = 0;
    patchEntry(zip, "xl/workbook.xml", (v, at) => {
      workbookAt = v.getUint32(at + 42, true);
    });
    // The sheet's entry pointing at the workbook's bytes: two parts, one payload.
    const shared = patchEntry(zip, "xl/worksheets/sheet1.xml", (v, at) => v.setUint32(at + 42, workbookAt, true));
    expect(readXlsx(shared)).toEqual({ ok: false, refusal: "unreadable" });
    // A hundred entries that all point at one payload and declare one byte, none of them a part that is read.
    const many = zipSync({ ...minimal(`<worksheet><sheetData/></worksheet>`), ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`junk/${i}`, new Uint8Array(1)])) });
    let junkAt = 0;
    patchEntry(many, "junk/0", (v, at) => {
      junkAt = v.getUint32(at + 42, true);
    });
    const aliased = new Uint8Array(many);
    for (let i = 1; i < 100; i++) {
      const next = patchEntry(aliased, `junk/${i}`, (v, at) => v.setUint32(at + 42, junkAt, true));
      aliased.set(next);
    }
    expect(readXlsx(aliased).ok).toBe(true);
  });

  it("refuses a zip with more entries than a workbook has, and one with an entry twice", () => {
    const many = zipSync({ ...minimal(`<worksheet><sheetData/></worksheet>`), ...Object.fromEntries(Array.from({ length: 2_001 }, (_, i) => [`x/${i}`, new Uint8Array(1)])) });
    expect(readXlsx(many)).toEqual({ ok: false, refusal: "too_large_unpacked" });
    expect(readXlsx(many, { maxEntries: 5_000 }).ok).toBe(true);
  });

  it("refuses a row with more cells than a download has columns", () => {
    const cells = (n: number) => Array.from({ length: n }, (_, i) => `<c r="${columnName(i)}1" t="inlineStr"><is><t>x</t></is></c>`).join("");
    expect(readXlsx(workbook({ sheet: `<row r="1">${cells(501)}</row>` }))).toEqual({ ok: false, refusal: "too_wide" });
    expect(readXlsx(workbook({ sheet: `<row r="1">${cells(500)}</row>` })).ok).toBe(true);
    expect(readXlsx(workbook({ sheet: `<row r="1">${cells(6)}</row>` }), { maxCellsPerRow: 5 })).toEqual({ ok: false, refusal: "too_wide" });
  });

  it("refuses XML it cannot read, and a document type, without throwing", () => {
    expect(readXlsx(workbook({ sheet: `<row r="1"><c r="A1" t="inlineStr"><is><t>never closes` }))).toEqual({ ok: false, refusal: "unreadable" });
    expect(readXlsx(workbook({ sheet: `<row r="1"><c r="A1" t="s"><v>5</v></c></row>`, shared: `<si><t>one</t></si>` }))).toEqual({
      ok: false,
      refusal: "unreadable",
    });
    const doctype = zipSync({
      "xl/workbook.xml": strToU8(`<!DOCTYPE x [<!ENTITY e "boom">]><workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="&e;" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData/></worksheet>`),
    });
    expect(readXlsx(doctype)).toEqual({ ok: false, refusal: "unreadable" });
  });
});

/**
 * A workbook that Beeline's writer made and openpyxl, a second program, opened and saved again after somebody
 * typed over one cell and into one empty cell (test/fixtures/make-openpyxl-resaved.py). openpyxl rewrote the
 * whole package (its own theme, document properties, styles and sheet XML) and kept the strings inline. It was NOT
 * written by Excel, LibreOffice Calc or Google Sheets, which have not been tried; shared strings are read in the
 * tests above from XML written by hand.
 */
describe("a workbook Beeline wrote and openpyxl saved again", () => {
  it("reads every cell as text, and what was typed in is there", async () => {
    const bytes = new Uint8Array(await readFile(join(import.meta.dirname, "fixtures", "openpyxl-resaved.xlsx")));
    // The package is openpyxl's, not Beeline's writer's.
    const parts = unzipSync(bytes);
    expect(Object.keys(parts)).toContain("xl/theme/theme1.xml");
    expect(new TextDecoder().decode(parts["xl/worksheets/sheet1.xml"])).toContain("<sheetPr>");
    const sheet = sheetOf(readXlsx(bytes));
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
      const read = readXlsx(new Uint8Array(await readFile(join(dir, "out", "written.xlsx"))));
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

describe("which sheet is read", () => {
  const book = (rows: string[][], options?: { name?: string; others?: string[]; before?: boolean }) => buildWorkbook(rows, options);
  const rows = [["h"], ["v"]];

  it("reads the sheet named, whatever its place, and lists the others as not read", () => {
    const read = readXlsx(book(rows, { others: ["notes", "specimens (2)"], before: true }), { sheetName: "specimens" });
    expect(sheetOf(read).name).toBe("specimens");
    expect(at(read, "A2")?.text).toBe("v");
    expect(read.ok && read.otherSheets).toEqual(["notes", "specimens (2)"]);
  });

  it("reads the only sheet when it has another name, and says there were no others", () => {
    const read = readXlsx(book(rows, { name: "Sheet1" }), { sheetName: "specimens" });
    expect(sheetOf(read).name).toBe("Sheet1");
    expect(read.ok && read.otherSheets).toEqual([]);
  });

  it("refuses several sheets none of which is the one named, naming them", () => {
    expect(readXlsx(book(rows, { name: "a", others: ["b"] }), { sheetName: "specimens" })).toEqual({ ok: false, refusal: "no_such_sheet", sheets: ["a", "b"] });
  });

  it("reads the first sheet when none is asked for", () => {
    expect(sheetOf(readXlsx(book(rows, { name: "a", others: ["b"], before: true }))).name).toBe("b");
  });
});

describe("reading the values a spreadsheet stores", () => {
  it("gives a number as the number it is, not the digits it is stored in", () => {
    const read = readXlsx(workbook({ sheet: `<row r="1"><c r="A1"><v>44.564599999999999</v></c><c r="B1"><v>4.45646E1</v></c><c r="C1"><v>-123.278915405273</v></c></row>` }));
    expect(["A1", "B1", "C1"].map((r) => at(read, r))).toEqual([
      { text: "44.5646", type: "number" },
      { text: "44.5646", type: "number" },
      { text: "-123.278915405273", type: "number" },
    ]);
  });

  it("reads an empty shared-string cell as no cell, not as the first string", () => {
    const read = readXlsx(workbook({ shared: `<si><t>first</t></si>`, sheet: `<row r="1"><c r="A1" t="s"/><c r="B1" t="s"><v></v></c><c r="C1" t="s"><v>0</v></c></row>` }));
    expect(at(read, "A1")).toBeUndefined();
    expect(at(read, "B1")).toBeUndefined();
    expect(at(read, "C1")?.text).toBe("first");
    // A string that does not exist is not the first one either.
    expect(readXlsx(workbook({ shared: `<si><t>first</t></si>`, sheet: `<row r="1"><c r="A1" t="s"><v>1</v></c></row>` }))).toEqual({ ok: false, refusal: "unreadable" });
    expect(readXlsx(workbook({ shared: `<si><t>first</t></si>`, sheet: `<row r="1"><c r="A1" t="s"><v>0x</v></c></row>` }))).toEqual({ ok: false, refusal: "unreadable" });
  });

  it("counts dates from 1900 or from 1904, as the workbook says", () => {
    const styles = `<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>`;
    const cell = `<row r="1"><c r="A1" s="1"><v>45852</v></c><c r="B1" s="1"><v>44390</v></c><c r="C1" s="1"><v>0</v></c></row>`;
    const make = (workbookPr: string) =>
      zipSync({
        "xl/workbook.xml": strToU8(`<workbook xmlns="${MAIN}" xmlns:r="${REL}">${workbookPr}<sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets></workbook>`),
        "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
        "xl/styles.xml": strToU8(`<styleSheet xmlns="${MAIN}">${styles}</styleSheet>`),
        "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${cell}</sheetData></worksheet>`),
      });
    const system1900 = readXlsx(make(`<workbookPr defaultThemeVersion="1"/>`));
    expect([at(system1900, "A1")?.text, at(system1900, "B1")?.text]).toEqual(["2025-07-14", "2021-07-13"]);
    // Zero is no day in the 1900 system.
    expect(at(system1900, "C1")?.text).toBe("0");
    for (const flag of ["1", "true"]) {
      const system1904 = readXlsx(make(`<workbookPr date1904="${flag}"/>`));
      // The same day is 1462 days fewer, and zero is 1 January 1904.
      expect([at(system1904, "A1")?.text, at(system1904, "B1")?.text, at(system1904, "C1")?.text]).toEqual(["2029-07-15", "2025-07-14", "1904-01-01"]);
    }
  });

  it("does not take padding, fill, quoted or bracketed letters of a number format for a date", () => {
    const formats = ["0_D", "0*m", "0.00_M", "0\\d", '0"day"', "[Red]0", "#,##0.00_);[Red](#,##0.00)", "yyyy*-mm", "mm/dd/yy", "[h]:mm", "d_D"];
    const expected = ["number", "number", "number", "number", "number", "number", "number", "date", "date", "date", "date"];
    const xfs = formats.map((_, i) => `<xf numFmtId="${200 + i}"/>`).join("");
    const codes = formats.map((f, i) => `<numFmt numFmtId="${200 + i}" formatCode="${f.replace(/"/g, "&quot;")}"/>`).join("");
    const cells = formats.map((_, i) => `<c r="${columnName(i)}1" s="${i}"><v>45852</v></c>`).join("");
    const read = readXlsx(workbook({ styles: `<numFmts count="${formats.length}">${codes}</numFmts><cellXfs count="${formats.length}">${xfs}</cellXfs>`, sheet: `<row r="1">${cells}</row>` }));
    expect(formats.map((f, i) => [f, at(read, `${columnName(i)}1`)!.type])).toEqual(formats.map((f, i) => [f, expected[i]]));
  });
});

describe("what the writer will not write", () => {
  it("refuses a cell over 32,767 characters, and takes one at the limit", () => {
    expect(() => writeXlsx({ sheetName: "s", header: ["a"] }, [["x".repeat(MAX_CELL_CHARS + 1)]])).toThrow(/32767 characters/);
    expect(sheetOf(readXlsx(writeXlsx({ sheetName: "s", header: ["a"] }, [["x".repeat(MAX_CELL_CHARS)]]))).rows[1]!.cells.get(0)!.text).toHaveLength(MAX_CELL_CHARS);
  });

  it("refuses a sheet past its last row, and takes one that ends there", () => {
    // The limit is Excel's 1,048,576, the header counted; a smaller one is used here so the test does not write a million rows.
    expect(MAX_SHEET_ROWS).toBe(1_048_576);
    expect(() => writeXlsx({ sheetName: "s", header: ["a"], maxRows: 3 }, [["1"], ["2"], ["3"]])).toThrow(/at most 3 rows/);
    expect(sheetOf(readXlsx(writeXlsx({ sheetName: "s", header: ["a"], maxRows: 3 }, [["1"], ["2"]]))).rows).toHaveLength(3);
  });
});
