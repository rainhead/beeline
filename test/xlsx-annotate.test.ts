import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { MAX_UNPACKED_BYTES, annotateWorkbook, canAnnotate, type ColumnToAdd } from "../src/app/xlsx-annotate.js";
import { readXlsxHere } from "../src/app/xlsx-reader.js";
import { buildWorkbook, serialOf } from "./workbook.js";

/**
 * Handing a person's own workbook back with one column added, and nothing else changed (beeline-kgyd.7, Peter,
 * 2026-11-18). Each test checks that every other part of the file comes back with the same contents, and that the
 * sheet's own cells are there as they were, byte for byte in the XML.
 */

const VALIDATION = `<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="C2:C3"><formula1>"female,male"</formula1></dataValidation></dataValidations>`;

const add = (values: Record<number, string>, extra: Partial<ColumnToAdd> = {}): ColumnToAdd => ({
  sheetName: "specimens",
  headerRow: 1,
  heading: "Beeline's note",
  values: new Map(Object.entries(values).map(([r, v]) => [Number(r), v])),
  replace: null,
  width: 60,
  ...extra,
});

/** A workbook a person might have edited: a formula, a date cell, a check on a column, a tab of their own, and a cell past the last heading. */
function theirs(): Uint8Array {
  return buildWorkbook(
    [
      ["specimenId", "scientificName", "sex"],
      ["101", { formula: 'CONCATENATE("Bom","bus")', cached: "Bombus" }, "female"],
      ["102", "Osmia", { date: serialOf("2025-07-01") }, null, "my own aside"],
    ],
    { others: ["My notes"], afterSheetData: VALIDATION },
  );
}

const sheetOf = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]!);
const cellsOf = (xml: string) => [...xml.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)].map((m) => m[0]);

/** Every part of the zip other than the sheet, with the same contents. */
function othersUnchanged(before: Uint8Array, after: Uint8Array, sheet = "xl/worksheets/sheet1.xml") {
  const a = unzipSync(before);
  const b = unzipSync(after);
  expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
  for (const name of Object.keys(a)) if (name !== sheet) expect(Buffer.compare(Buffer.from(a[name]!), Buffer.from(b[name]!)), name).toBe(0);
}

describe("adding the note column to a person's own workbook", () => {
  it("adds one column after the last one used, and leaves every other cell, the check, the other tab and every other part as they were", () => {
    const before = theirs();
    const result = annotateWorkbook(before, add({ 2: "Not saved: because.", 3: "" }));
    if (!result.ok) throw new Error(result.why);
    othersUnchanged(before, result.bytes);
    const was = sheetOf(before);
    const now = sheetOf(result.bytes);
    // Every cell of theirs is still there, as it was written.
    for (const cell of cellsOf(was)) expect(now).toContain(cell);
    expect(now).toContain(VALIDATION);
    // The column after the cell past the last heading (E), so nothing of theirs is overwritten or moved.
    expect(now).toContain(`<c r="F1" t="inlineStr"><is><t xml:space="preserve">Beeline's note</t></is></c>`);
    expect(now).toContain(`<c r="F2" t="inlineStr"><is><t xml:space="preserve">Not saved: because.</t></is></c>`);
    expect(now).not.toContain(`r="F3"`);
    expect(now).toContain(`<col min="6" max="6" width="60" customWidth="1"/>`);
    // A spreadsheet reads it as theirs: the formula still a formula, the date still a date, the tab still there.
    const read = readXlsxHere(result.bytes);
    if (!read.ok) throw new Error(read.refusal);
    expect(read.otherSheets).toEqual(["My notes"]);
    const row2 = read.sheet.rows.find((r) => r.row === 2)!;
    const row3 = read.sheet.rows.find((r) => r.row === 3)!;
    expect(row2.cells.get(1)).toEqual({ text: "Bombus", type: "formula" });
    expect(row3.cells.get(2)).toEqual({ text: "2025-07-01", type: "date" });
    expect(row3.cells.get(4)?.text).toBe("my own aside");
    expect(row2.cells.get(5)?.text).toBe("Not saved: because.");
    const book = XLSX.read(result.bytes, { type: "array" });
    expect(book.Sheets.specimens!["!ref"]).toBe("A1:F3");
  });

  it("writes into a note column already there rather than adding a second", () => {
    const first = annotateWorkbook(theirs(), add({ 2: "first", 3: "also first" }));
    if (!first.ok) throw new Error(first.why);
    const second = annotateWorkbook(first.bytes, add({ 3: "second" }, { replace: 5 }));
    if (!second.ok) throw new Error(second.why);
    const now = sheetOf(second.bytes);
    expect(now.match(/Beeline's note/g)).toHaveLength(1);
    expect(now).not.toContain("first");
    expect(now).toContain(`<c r="F3" t="inlineStr"><is><t xml:space="preserve">second</t></is></c>`);
    expect(now.match(/<col min="6"/g)).toHaveLength(1);
  });

  it("escapes what a note says", () => {
    const result = annotateWorkbook(theirs(), add({ 2: `was "<b>" & more` }));
    if (!result.ok) throw new Error(result.why);
    const read = readXlsxHere(result.bytes);
    if (!read.ok) throw new Error(read.refusal);
    expect(read.sheet.rows.find((r) => r.row === 2)!.cells.get(5)?.text).toBe(`was "<b>" & more`);
  });

  it("patches the file openpyxl saved, keeping every other part", async () => {
    const before = new Uint8Array(await readFile(join(import.meta.dirname, "fixtures", "openpyxl-resaved.xlsx")));
    expect(canAnnotate(before, "specimens")).toEqual({ ok: true });
    const result = annotateWorkbook(before, add({ 2: "a note" }));
    if (!result.ok) throw new Error(result.why);
    othersUnchanged(before, result.bytes);
    const a = readXlsxHere(before);
    const b = readXlsxHere(result.bytes);
    if (!a.ok || !b.ok) throw new Error("not readable");
    const width = Math.max(...a.sheet.rows.flatMap((r) => [...r.cells.keys()]));
    for (const [i, row] of a.sheet.rows.entries()) {
      for (const [at, cell] of row.cells) expect(b.sheet.rows[i]!.cells.get(at)).toEqual(cell);
    }
    expect(b.sheet.rows.find((r) => r.row === 2)!.cells.get(width + 1)?.text).toBe("a note");
  });

  it("will not patch a sheet with a table, or one whose cells do not say where they are, and says why", () => {
    const table = buildWorkbook([["specimenId"], ["1"]], { afterSheetData: `<tableParts count="1"><tablePart r:id="rId5"/></tableParts>` });
    expect(canAnnotate(table, "specimens")).toEqual({ ok: false, why: "the sheet has a table, whose range could take in a new column" });
    expect(annotateWorkbook(table, add({ 2: "x" })).ok).toBe(false);
    const files = unzipSync(buildWorkbook([["specimenId"], ["1"]]));
    const unplaced = strFromU8(files["xl/worksheets/sheet1.xml"]!).replace(/ r="A2"/, "");
    expect(canAnnotate(rezip(files, unplaced), "specimens").ok).toBe(false);
    expect(canAnnotate(new Uint8Array([1, 2, 3]), "specimens")).toEqual({ ok: false, why: "the file cannot be unzipped, or unpacks to too much" });
    // A zip that says a part unpacks to more than the limit is not unpacked at all.
    const bomb = buildWorkbook([["specimenId"], ["1"]]);
    const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
    for (let at = 0; at + 46 <= bomb.byteLength; at++) if (view.getUint32(at, true) === 0x02014b50) view.setUint32(at + 24, MAX_UNPACKED_BYTES + 1, true);
    expect(canAnnotate(bomb, "specimens")).toEqual({ ok: false, why: "the file cannot be unzipped, or unpacks to too much" });
    expect(canAnnotate(theirs(), "Sheet1").ok).toBe(false);
  });
});

const rezip = (files: Record<string, Uint8Array>, sheet: string): Uint8Array => zipSync({ ...files, "xl/worksheets/sheet1.xml": strToU8(sheet) });
