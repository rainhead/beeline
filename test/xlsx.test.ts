import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { columnIndex, columnName, escapeText, readXlsx, writeXlsx, xlsxWriter, type XlsxCell, type XlsxRead } from "../src/app/xlsx.js";

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
    expect(cells.length).toBe(5);
    for (const c of cells) {
      expect(c).toContain(`s="1"`);
      expect(c).toContain(`t="inlineStr"`);
    }
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
    // An older .xls, which is neither.
    expect(readXlsx(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toEqual({ ok: false, refusal: "not_a_zip" });
  });

  it("refuses a truncated file", () => {
    const whole = workbook({ sheet });
    expect(readXlsx(whole.subarray(0, Math.floor(whole.length / 2))).ok).toBe(false);
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

  it("refuses a small file that unpacks to far more than it should, without unpacking it", () => {
    // 6 MB of one byte compresses to a few kilobytes.
    const bomb = zipSync({
      "xl/workbook.xml": strToU8(`<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
      "xl/worksheets/sheet1.xml": new Uint8Array(6_000_000).fill(32),
    });
    expect(bomb.length).toBeLessThan(20_000);
    expect(readXlsx(bomb, { maxInflatedBytes: 1_000_000 })).toEqual({ ok: false, refusal: "too_large_unpacked" });
    // The cap is on what the parts add up to, not on one of them.
    const two = zipSync({
      "xl/workbook.xml": new Uint8Array(600_000).fill(32),
      "xl/styles.xml": new Uint8Array(600_000).fill(32),
    });
    expect(readXlsx(two, { maxInflatedBytes: 1_000_000 })).toEqual({ ok: false, refusal: "too_large_unpacked" });
    // And the default allows a real file.
    expect(readXlsx(workbook({ sheet })).ok).toBe(true);
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
 * A workbook laid out the way Excel lays one out, built by hand for this test
 * and not written by Excel, LibreOffice or Google Sheets: its shared strings
 * with rich text and a phonetic guide, a custom date format, formulas with
 * their cached values, a boolean, an error, a gap, a second sheet, and the
 * parts around them that the reader must step over.
 */
describe("a workbook in the layout Excel writes", () => {
  it("reads every cell as written", async () => {
    const read = readXlsx(new Uint8Array(await readFile(join(import.meta.dirname, "fixtures", "excel-layout.xlsx"))));
    const sheet = sheetOf(read);
    expect(sheet.name).toBe("specimens");
    const rows = sheet.rows.map((r) => [r.row, Object.fromEntries([...r.cells.entries()].map(([c, v]) => [columnName(c), `${v.type}:${v.text}`]))]);
    expect(rows).toEqual([
      [1, { A: "text:specimenId", B: "text:locality", C: "text:eventDate", D: "text:decimalLongitude", E: "text:note" }],
      [2, { A: "text:1001", B: "text:Corvallis, rich text", C: "text:2026-07-14", D: "text:-123.45678901234567", E: "text:漢字" }],
      [3, { A: "text:1002", B: "text:Albany", C: "date:2026-07-14", D: "number:-123.4567890123", E: "formula:cached" }],
      [4, { A: "boolean:TRUE", C: "error:#N/A", D: "text:00123" }],
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
