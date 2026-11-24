import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe as describeInOrder, expect, it } from "vitest";
import { en } from "../src/app/messages/en.js";
import { DETERMINATION_CASTES, DETERMINATION_QUALIFIERS, DETERMINATION_SEXES } from "../src/model.js";
import { DISPOSITIONS } from "../src/load-dispositions.js";
import {
  HOLD_REASONS,
  DRAFT_HOLDS,
  MAX_FILE_BYTES,
  MAX_ROWS,
  SPECIMENS_LAYOUT,
  UNIT_COLUMNS,
  comparePlan,
  parseUpload as parseUploadInWorker,
  planUpload as planUploadInWorker,
  type Layout,
  type HeldItem,
  type UploadPlan,
} from "../src/app/upload-plan.js";
import { readXlsxHere } from "../src/app/xlsx-reader.js";
import { CURRENT_SEASON, SETTLED_SEASON, insertCleanSample } from "./helpers.js";
import { bytesOf, edited, matrixOf, sharedUploadFixture, uploadFixture, type UploadFixture } from "./upload-fixture.js";
import { buildWorkbook, serialOf, serialOf1904, type TestCell } from "./workbook.js";

/**
 * Both read the workbook in this thread, which spares each plan the 0.1 s it takes to start a worker. The worker is
 * tested where it is the subject (test/xlsx.test.ts, test/uploads-app.test.ts) and once below, end to end.
 */
const parseUpload: typeof parseUploadInWorker = (bytes, limits, layout) => parseUploadInWorker(bytes, { inThread: true, ...limits }, layout);
const planUpload: typeof planUploadInWorker = (db, bytes, options = {}) => planUploadInWorker(db, bytes, { ...options, limits: { inThread: true, ...options.limits } });

/**
 * Today, for every comparison here that does not say otherwise: the last day of the current season's year, so that
 * the July days the fixtures use are in the past whatever day the suite runs on. The future-date rule has its own
 * tests, which name their own day.
 */
const DEFAULT_TODAY = `${CURRENT_SEASON}-12-31`;

/** Every reason a plan in this file has held something for, so the last test can say none of them is dead. */
const seen = new Set<string>();

/**
 * A layout that reads every column that belongs to a unit. No file reads a sample's dates and method, its locality or
 * coordinates today (the specimens file reads a specimen's two units), but the
 * comparison's rules for them wait for the samples upload and are tested here, by giving the comparison a parsed
 * upload that names them as read.
 */
const allRead: Layout = { ...SPECIMENS_LAYOUT, recognise: [], read: UNIT_COLUMNS, headings: [], shaded: [], refuses: [] };

/**
 * The groups run their tests at the same time: each test only reads the file's one store or has a store of its own,
 * and DuckDB does its work on threads of its own, so the file takes about as long as its slowest group's slowest test
 * and not the sum of its tests. The one test that reads what the others produced is in a group that runs in order.
 */
const describe = describeInOrder.concurrent;

/** The plan for a file's bytes, read as though every unit's columns were read from it. */
async function plan(f: UploadFixture, bytes: Uint8Array, today = DEFAULT_TODAY): Promise<UploadPlan> {
  const parsed = await parseUpload(bytes);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal}`);
  const result = await comparePlan(f.db, { ...parsed.upload, layout: allRead }, { today });
  for (const h of result.held) seen.add(h.reason);
  return result;
}

/** The plan as the app makes it: the layout is the file's own. */
async function planAsRead(f: UploadFixture, bytes: Uint8Array, today = DEFAULT_TODAY): Promise<UploadPlan> {
  const result = await planUpload(f.db, bytes, { today });
  if (!result.ok) throw new Error(`refused: ${result.refusal}`);
  for (const h of result.plan.held) seen.add(h.reason);
  return result.plan;
}

const refusal = async (f: UploadFixture, bytes: Uint8Array) => {
  const result = await planUpload(f.db, bytes, { today: DEFAULT_TODAY });
  return result.ok ? null : result.refusal;
};

const heldOf = (p: UploadPlan, reason: string): HeldItem[] => p.held.filter((h) => h.reason === reason);
const nothingDiffers = (p: UploadPlan) => {
  expect(p.differences).toEqual([]);
  expect(p.sampleDifferences).toEqual([]);
  expect(p.notApplied).toEqual([]);
  expect(p.held).toEqual([]);
};
const differing = (c: { cells: Array<{ column: string; differs: boolean }> }) => c.cells.filter((x) => x.differs).map((x) => x.column);
/** What a plan says differs, as [unit, differing columns], specimen units first. */
const summary = (p: UploadPlan) => [
  ...p.differences.map((c) => [c.unit, ...differing(c)]),
  ...p.sampleDifferences.map((c) => [c.unit, ...differing(c)]),
];

const DAY_A = `${CURRENT_SEASON}-07-14`;

/** A cell on every row of sample UP-1, as a person editing a sample would. */
const onSample = (f: UploadFixture, set: Record<string, TestCell>) => [f.ids.a1, f.ids.a2, f.ids.a3].map((id) => ({ id, set }));

describe("refusing a whole file", () => {
  it("plans the same whether the workbook is read in a worker, as the app does, or in this thread", async () => {
    const f = await sharedUploadFixture();
    const bytes = edited(await f.download(), [{ id: f.ids.a1, set: { locality: "Elsewhere" } }]);
    const inWorker = await planUploadInWorker(f.db, bytes, { today: DEFAULT_TODAY });
    expect(inWorker.ok).toBe(true);
    expect(inWorker).toEqual(await planUpload(f.db, bytes, { today: DEFAULT_TODAY }));
  });

  it("refuses a file that cannot be read, and names why", async () => {
    const f = await sharedUploadFixture();
    expect(await refusal(f, new Uint8Array(MAX_FILE_BYTES + 1))).toBe("too_large");
    // A CSV, which is what the old upload took, and an empty file.
    expect(await refusal(f, bytesOf("specimenId,locality\n1,Corvallis\n"))).toBe("not_a_zip");
    expect(await refusal(f, bytesOf(""))).toBe("not_a_zip");
    expect(await refusal(f, buildWorkbook([["fieldNumber", "locality"], ["OBA1", "Corvallis"]]))).toBe("no_specimen_id_column");
    expect(await refusal(f, buildWorkbook([["specimenId", "locality"]]))).toBe("no_rows");
    expect(await refusal(f, buildWorkbook([]))).toBe("no_specimen_id_column");
    // A row of cells with nothing in them is not a row.
    expect(await refusal(f, buildWorkbook([["specimenId"], [" "], [null]]))).toBe("no_rows");
  });

  it("refuses a file with too many rows, and takes one at the limit", async () => {
    const f = await sharedUploadFixture();
    const rows = (n: number) => [["specimenId"], ...Array.from({ length: n }, (_, i) => [String(i + 1)])];
    expect(await refusal(f, buildWorkbook(rows(MAX_ROWS + 1)))).toBe("too_many_rows");
    expect(await refusal(f, buildWorkbook(rows(MAX_ROWS)))).toBeNull();
  });

  it("refuses a file with a column twice, and says which", async () => {
    const f = await sharedUploadFixture();
    const result = await planUpload(f.db, buildWorkbook([["specimenId", "locality", "locality"], ["1", "a", "b"]]));
    expect(result).toEqual({ ok: false, refusal: "repeated_column", detail: "locality" });
    // Spaces round a heading do not make it another column.
    expect(await refusal(f, buildWorkbook([["specimenId", " specimenId"], ["1", "1"]]))).toBe("repeated_column");
  });

  it("says when the specimenId heading is nearly right", async () => {
    const f = await sharedUploadFixture();
    expect(await planUpload(f.db, buildWorkbook([["specimen Id", "locality"], ["1", "a"]]))).toEqual({
      ok: false,
      refusal: "no_specimen_id_column",
      detail: "specimenId",
    });
  });
});

describe("a file nobody has edited", () => {
  it("compares as no differences at all", async () => {
    const f = await sharedUploadFixture();
    const unedited = await plan(f, await f.download());
    nothingDiffers(unedited);
    expect(unedited.unrecognised).toEqual([]);
    expect(unedited.counts.rows).toEqual({ active: 3, settled: 1, unplaced: 0 });
    expect(unedited.counts.unchanged).toEqual({ active: 3, settled: 1, unplaced: 0 });
    expect(unedited.counts.withDifferences).toEqual({ active: 0, settled: 0, unplaced: 0 });
    expect(unedited.counts.held).toEqual({ active: 0, settled: 0, unplaced: 0 });
  });

  it("compares as nothing when the download is made from a store with awkward values in it", async () => {
    const f = await uploadFixture();
    // Values a CSV had to guard or a spreadsheet would have rewritten.
    await f.conn.run(`UPDATE determination SET determiner_name = '=Dee, "D" Determiner' WHERE specimen_id = ${f.ids.a1}`);
    await f.conn.run(`UPDATE sample SET protocol = '-net' WHERE entity_id = ${f.ids.sampleA}`);
    await f.conn.run(`UPDATE sample SET locality = 'Corvallis' || chr(10) || 'Oregon' WHERE entity_id = ${f.ids.sampleA}`);
    await f.conn.run(`UPDATE sample_location SET latitude = 44.5646000000001, longitude = -123.45678901234567 WHERE sample_id = ${f.ids.sampleA}`);
    await f.conn.run(`UPDATE specimen SET field_number = '00012345' WHERE entity_id = ${f.ids.a1}`);
    nothingDiffers(await plan(f, await f.download()));
  });

  it("compares as nothing however the file is laid out: columns in any order, columns left out, columns added", async () => {
    const f = await sharedUploadFixture();
    const matrix = matrixOf(await f.download());
    nothingDiffers(await plan(f, buildWorkbook(matrix.map((r) => [...r].reverse()))));
    nothingDiffers(await plan(f, edited(await f.download(), [], { dropColumns: ["locality", "scientificName", "sex", "caste"] })));
    nothingDiffers(await plan(f, edited(await f.download(), [], { addColumns: { myNotes: "see me" } })));
  });

  it("is unchanged when the file's text is Beeline's, whatever the cell is: a date or a number the spreadsheet made of it", async () => {
    const f = await sharedUploadFixture();
    const { a1 } = f.ids;
    const p = await plan(
      f,
      edited(await f.download(), [
        // The same day, as a date cell and as a formula whose result is the text.
        { id: a1, set: { dateIdentified: { date: serialOf("2024-05-03") }, locality: { formula: "=\"Corvallis\"", cached: "Corvallis" }, decimalLatitude: { number: "44.5646" } } },
        ...onSample(f, {}),
      ]),
    );
    nothingDiffers(p);
  });

  it("trims what the file says, and nothing else", async () => {
    const f = await sharedUploadFixture();
    nothingDiffers(await plan(f, edited(await f.download(), onSample(f, { locality: "  Corvallis  ".trimEnd() + " ", samplingProtocol: " net " }))));
    // Case, composed and decomposed characters, and a non-breaking space are differences now.
    const p = await plan(f, edited(await f.download(), onSample(f, { locality: "corvallis" })));
    expect(summary(p)).toEqual([["place", "locality"]]);
    const q = await plan(f, edited(await f.download(), onSample(f, { locality: "Corvallis " })));
    expect(q.held).toEqual([]);
    expect(summary(q)).toEqual([]);
    const r = await plan(f, edited(await f.download(), onSample(f, { locality: "Corval lis" })));
    expect(summary(r)).toEqual([["place", "locality"]]);
  });
});

describe("finding each row's specimen", () => {
  it("holds a row whose id is not a positive whole number, with the reason", async () => {
    const f = await sharedUploadFixture();
    const { a1, a2 } = f.ids;
    const p = await plan(
      f,
      edited(await f.download(), [
        { id: a1, set: { specimenId: "" } },
        { id: a2, set: { specimenId: "abc" } },
      ]),
    );
    expect(heldOf(p, "no_id").map((h) => h.detail)).toEqual(["", "abc"]);
    expect(p.counts.held.unplaced).toBe(2);
    expect(p.counts.rows).toEqual({ active: 1, settled: 1, unplaced: 2 });
  });

  it("reads a specimenId the spreadsheet stored as a number", async () => {
    const f = await sharedUploadFixture();
    const p = await plan(f, edited(await f.download(), [{ id: f.ids.a2, set: { specimenId: { number: String(f.ids.a2) }, scientificName: "Bombus" } }]));
    expect(heldOf(p, "no_id")).toEqual([]);
    expect(p.differences.map((c) => c.specimenId)).toEqual([f.ids.a2]);
  });

  it("holds every row of a specimen that is named twice", async () => {
    const f = await sharedUploadFixture();
    const { a1, a2 } = f.ids;
    const p = await plan(f, edited(await f.download(), [{ id: a2, set: { specimenId: String(a1) } }]));
    expect(heldOf(p, "repeated").map((h) => h.row)).toEqual([2, 3]);
    // The repeated specimen is known, so its rows have a season.
    expect(p.counts.held.active).toBe(2);
  });

  it("holds a row naming a specimen that does not exist, and compares nothing in it", async () => {
    const f = await sharedUploadFixture();
    const p = await plan(f, edited(await f.download(), [{ id: f.ids.a1, set: { specimenId: "987654", locality: "Elsewhere" } }]));
    expect(heldOf(p, "no_specimen")).toHaveLength(1);
    expect(p.differences).toEqual([]);
    expect(p.sampleDifferences).toEqual([]);
  });

  it("holds a row whose field number is not the specimen's, and lets a blank cell agree with no number", async () => {
    const f = await sharedUploadFixture();
    const { a1, a3 } = f.ids;
    const download = await f.download();
    nothingDiffers(await plan(f, download));
    const p = await plan(
      f,
      edited(download, [
        { id: a1, set: { fieldNumber: "OBA10009", locality: "Elsewhere" } },
        { id: a3, set: { fieldNumber: "OBA10003" } },
      ]),
    );
    expect(heldOf(p, "number_disagrees").map((h) => [h.specimenId, h.detail])).toEqual([
      [a1, "OBA10009"],
      [a3, "OBA10003"],
    ]);
    // Held rows contribute no differences.
    expect(p.sampleDifferences).toEqual([]);
    // A file with no field number column is not held for it.
    nothingDiffers(await plan(f, edited(download, [], { dropColumns: ["fieldNumber"] })));
  });

  it("takes the field number as it is, to the character: leading zeros are part of it", async () => {
    const f = await uploadFixture();
    const { a1, a2 } = f.ids;
    await f.conn.run(`UPDATE specimen SET field_number = '00012345' WHERE entity_id = ${a1}`);
    const download = await f.download();
    nothingDiffers(await plan(f, download));
    // Trimmed, as every cell is.
    nothingDiffers(await plan(f, edited(download, [{ id: a1, set: { fieldNumber: " 00012345 " } }])));
    // The number a spreadsheet makes of it is not the field number.
    expect(heldOf(await plan(f, edited(download, [{ id: a1, set: { fieldNumber: "12345" } }])), "number_disagrees")).toHaveLength(1);
    expect(heldOf(await plan(f, edited(download, [{ id: a1, set: { fieldNumber: { number: "12345" } } }])), "number_disagrees")).toHaveLength(1);
    expect(heldOf(await plan(f, edited(download, [{ id: a2, set: { fieldNumber: "oba10002" } }])), "number_disagrees")).toHaveLength(1);
  });
});

describe("numbers", () => {
  it("compares a number column by value where the text differs, and a longitude cut to ten digits is a difference", async () => {
    const f = await uploadFixture();
    await f.conn.run(`UPDATE sample_location SET longitude = -123.45678901234567 WHERE sample_id = ${f.ids.sampleA}`);
    const download = await f.download();
    nothingDiffers(await plan(f, download));
    // What a spreadsheet does to a number it is given: ten digits. Beeline never sends that, and it is not hidden.
    const cut = await plan(f, edited(download, onSample(f, { decimalLongitude: "-123.4567890123" })));
    expect(summary(cut)).toEqual([["coordinates", "decimalLongitude"]]);
    expect(cut.sampleDifferences[0]!.cells.find((c) => c.column === "decimalLongitude")).toMatchObject({
      was: "-123.45678901234567",
      fileSays: "-123.4567890123",
      value: { kind: "number", number: -123.4567890123 },
    });
    // The same number written with other digits is the same number.
    for (const same of ["-123.456789012345670", "-123.45678901234567000"]) nothingDiffers(await plan(f, edited(download, onSample(f, { decimalLongitude: same }))));
  });

  it("accepts a cell the spreadsheet stored as a number, with an exponent only there", async () => {
    const f = await sharedUploadFixture();
    const download = await f.download();
    const numeric = await plan(f, edited(download, onSample(f, { decimalLatitude: { number: "44.6" } })));
    expect(summary(numeric)).toEqual([["coordinates", "decimalLatitude"]]);
    expect(numeric.sampleDifferences[0]!.cells[0]!.value).toEqual({ kind: "number", number: 44.6 });
    // The number Beeline says, stored as a number whose digits are not Beeline's text.
    nothingDiffers(await plan(f, edited(download, onSample(f, { decimalLatitude: { number: "4.45646E1" } }))));
    // As text it is not a plain number.
    const text = await plan(f, edited(download, onSample(f, { decimalLatitude: "4.45646E1" })));
    expect(heldOf(text, "number_unreadable")).toHaveLength(3);
    expect(text.sampleDifferences).toEqual([]);
  });

  it("holds a number column's cell that is not a plain decimal number, whole unit with it", async () => {
    const f = await sharedUploadFixture();
    const { a1, a2, a3, b1 } = f.ids;
    for (const bad of ["forty-four", "44,5", "44.5.6", "44.5 N", "1e", "--1", "0x10", "Infinity", "NaN"]) {
      const p = await plan(f, edited(await f.download(), onSample(f, { decimalLatitude: bad, decimalLongitude: "-122.5" })));
      expect(heldOf(p, "number_unreadable").map((h) => [h.unit, h.column, h.detail]), bad).toEqual([
        ["coordinates", "decimalLatitude", bad],
        ["coordinates", "decimalLatitude", bad],
        ["coordinates", "decimalLatitude", bad],
      ]);
      expect(p.sampleDifferences).toEqual([]);
    }
    // The longitude changed with it is held with it, listed as a held cell.
    const p = await plan(f, edited(await f.download(), [{ id: b1, set: { coordinateUncertaintyInMeters: "30m", decimalLongitude: "-122" } }]));
    expect(heldOf(p, "number_unreadable")[0]!.cells.map((c) => [c.column, c.fileSays])).toEqual([
      ["decimalLongitude", "-122"],
      ["coordinateUncertaintyInMeters", "30m"],
    ]);
    void a1;
    void a2;
    void a3;
  });
});

describe("dates", () => {
  it("reads a collecting date as a day or two days, strictly", async () => {
    const f = await sharedUploadFixture();
    const download = await f.download();
    const y = CURRENT_SEASON;
    const read = (value: TestCell) => plan(f, edited(download, onSample(f, { eventDate: value })));
    // A single day equals itself written as a range of one.
    nothingDiffers(await read(`${DAY_A}/${DAY_A}`));
    const range = await read(`${y}-07-14/${y}-07-16`);
    expect(summary(range)).toEqual([["method_dates", "eventDate"]]);
    expect(range.sampleDifferences[0]!.cells.find((c) => c.column === "eventDate")!.value).toEqual({ kind: "days", start: DAY_A, end: `${y}-07-16` });
    const day = await read(`${y}-07-15`);
    expect(day.sampleDifferences[0]!.cells.find((c) => c.column === "eventDate")!.value).toEqual({ kind: "days", start: `${y}-07-15`, end: `${y}-07-15` });
    // What a spreadsheet or a hand makes of a date is not read.
    for (const bad of [`7/14/${y}`, `14/7/${y}`, `14-Jul-${y.toString().slice(2)}`, `Jul-${y.toString().slice(2)}`, `${y}-7-14`, `${y}-02-30`, `${y}-13-01`, `${y}-07`, `${y}`, `${y}-07-16/${y}-07-14`, `${y}-07-14 / ${y}-07-16`, `${y}-07-14/`, `July 14`, "garbage"]) {
      const p = await read(bad);
      expect(heldOf(p, "date_unreadable").map((h) => [h.unit, h.column, h.detail]), bad).toEqual(Array(3).fill(["method_dates", "eventDate", bad]));
      expect(p.sampleDifferences, bad).toEqual([]);
    }
  });

  it("reads a date identified as a day, a month or a year, strictly", async () => {
    const f = await uploadFixture();
    const { a1, a3 } = f.ids;
    // a3 is known to the month only.
    await f.conn.run(`UPDATE determination SET determined_on_precision = 'month' WHERE specimen_id = ${a3}`);
    const download = await f.download();
    const read = async (id: number, value: TestCell) => plan(f, edited(download, [{ id, set: { dateIdentified: value } }]));
    const valueOf = (p: UploadPlan) => p.differences[0]!.cells.find((c) => c.column === "dateIdentified")!.value;
    nothingDiffers(await read(a1, "2024-05-03"));
    expect(valueOf(await read(a1, "2024-05"))).toEqual({ kind: "moment", date: "2024-05", precision: "month" });
    expect(valueOf(await read(a1, "2024"))).toEqual({ kind: "moment", date: "2024", precision: "year" });
    expect(valueOf(await read(a1, "2024-05-04"))).toEqual({ kind: "moment", date: "2024-05-04", precision: "day" });
    for (const bad of ["5/3/2024", "May-2024", "May 2024", "May-24", "2024-13", "2024-00", "2024-02-30", "2024-5-3", "24", "2024-05-03/2024-05-04", "garbage"]) {
      expect(heldOf(await read(a1, bad), "date_unreadable").map((h) => h.detail), bad).toEqual([bad]);
    }
    // a3's month, as text, is unchanged; the same month as a first of the month is a different thing.
    nothingDiffers(await read(a3, "2024-05"));
    expect(valueOf(await read(a3, "2024-05-01"))).toEqual({ kind: "moment", date: "2024-05-01", precision: "day" });
  });

  it("reads a real date cell in a date column as that day, as it reads typed text (staff paste rows from other sheets)", async () => {
    const f = await sharedUploadFixture();
    const { a1, b1 } = f.ids;
    const download = await f.download();
    const valueOf = (p: UploadPlan, column: string) => p.differences[0]!.cells.find((c) => c.column === column)!.value;
    // A date cell that is Beeline's day is unchanged, as the same day typed is.
    nothingDiffers(await plan(f, edited(download, [{ id: a1, set: { dateIdentified: { date: serialOf("2024-05-03") } } }])));
    nothingDiffers(await plan(f, edited(download, onSample(f, { eventDate: { date: serialOf(DAY_A) } }))));
    // A different day is a difference, with that day and a day's precision.
    const identified = await plan(f, edited(download, [{ id: a1, set: { dateIdentified: { date: serialOf("2025-07-01") } } }]));
    expect(summary(identified)).toEqual([["determination", "dateIdentified"]]);
    expect(valueOf(identified, "dateIdentified")).toEqual({ kind: "moment", date: "2025-07-01", precision: "day" });
    expect(heldOf(identified, "converted_to_date")).toEqual([]);
    const collected = await plan(f, edited(download, onSample(f, { eventDate: { date: serialOf(`${CURRENT_SEASON}-07-15`) } })));
    expect(collected.sampleDifferences[0]!.cells.find((c) => c.column === "eventDate")!.value).toEqual({ kind: "days", start: `${CURRENT_SEASON}-07-15`, end: `${CURRENT_SEASON}-07-15` });
    // The workbook's own date system counts the same day: the 1904 serial of a day is 1,462 less.
    const mac = await plan(f, edited(download, [{ id: b1, set: { dateIdentified: { date: serialOf1904("2025-07-01") } } }], { sheets: { date1904: true } }));
    expect(valueOf(mac, "dateIdentified")).toEqual({ kind: "moment", date: "2025-07-01", precision: "day" });
    // It is validated as typed text is: a day after today makes the identification incomplete.
    const future = await plan(f, edited(download, [{ id: a1, set: { dateIdentified: { date: serialOf(`${CURRENT_SEASON + 1}-01-02`) } } }]));
    expect(heldOf(future, "date_identified_future")).toHaveLength(1);
  });

  it("holds a date cell that carries a time of day, and a date cell in a column that is not a date column", async () => {
    const f = await sharedUploadFixture();
    const { a1 } = f.ids;
    const download = await f.download();
    // A time as well as a day: not a day.
    const time = await plan(f, edited(download, [{ id: a1, set: { dateIdentified: { date: serialOf("2025-07-01") + 0.5 } } }]));
    expect(heldOf(time, "holds_time").map((h) => [h.row, h.unit, h.column])).toEqual([[2, "determination", "dateIdentified"]]);
    expect(time.differences).toEqual([]);
    const sampleTime = await plan(f, edited(download, onSample(f, { eventDate: { date: serialOf(`${CURRENT_SEASON}-07-15`) + 0.25 } })));
    expect(heldOf(sampleTime, "holds_time").map((h) => h.column)).toEqual(["eventDate", "eventDate", "eventDate"]);
    // Not a date column: held as before, with the rest of its unit.
    const p = await plan(f, edited(download, [{ id: a1, set: { scientificName: { date: serialOf("2025-07-01") }, sex: "male" } }, ...onSample(f, { locality: { date: serialOf("2025-07-01") } })]));
    expect(heldOf(p, "converted_to_date").map((h) => [h.row, h.unit, h.column, h.detail])).toEqual([
      [2, "determination", "scientificName", "2025-07-01"],
      [2, "place", "locality", "2025-07-01"],
      [3, "place", "locality", "2025-07-01"],
      [4, "place", "locality", "2025-07-01"],
    ]);
    expect(heldOf(p, "converted_to_date")[0]!.cells.map((c) => c.column)).toEqual(["scientificName", "sex"]);
    expect(p.differences).toEqual([]);
    expect(p.sampleDifferences).toEqual([]);
  });

  it("holds nothing for an identifier Beeline does not know, nor for a name it has never seen", async () => {
    const f = await sharedUploadFixture();
    const p = await plan(f, edited(await f.download(), [{ id: f.ids.a1, set: { identifiedBy: "Nobody Anyone Knows" } }]));
    expect(p.held).toEqual([]);
    expect(summary(p)).toEqual([["determination", "identifiedBy"]]);
  });

  it("holds a cell the spreadsheet made a formula, a boolean or an error, each with its reason", async () => {
    const f = await sharedUploadFixture();
    const { a1, a2, a3 } = f.ids;
    const download = await f.download();
    const p = await plan(
      f,
      edited(download, [
        { id: a1, set: { occurrenceRemarks: { formula: "=A1&B1", cached: "joined" } } },
        { id: a2, set: { occurrenceRemarks: { boolean: true } } },
        { id: a3, set: { occurrenceRemarks: { error: "#REF!" } } },
      ]),
    );
    expect(heldOf(p, "holds_formula").map((h) => [h.specimenId, h.detail])).toEqual([[a1, "joined"]]);
    expect(heldOf(p, "converted_other").map((h) => [h.specimenId, h.detail])).toEqual([[a2, "TRUE"], [a3, "#REF!"]]);
    expect(p.differences).toEqual([]);
    // In a column that is read by its kind, a number-typed cell is read, and a date-typed one is held.
    const q = await plan(f, edited(download, [{ id: a1, set: { identifiedBy: { number: "123" } } }]));
    expect(q.differences.map((c) => [c.unit, differing(c)])).toEqual([["determination", ["identifiedBy"]]]);
  });
});

describe("the columns read ignoring case", () => {
  it("is case-blind for sex, caste, the qualifier and the expert flag, and for nothing else", async () => {
    const f = await sharedUploadFixture();
    const { a1 } = f.ids;
    const nothing = await plan(f, edited(await f.download(), [{ id: a1, set: { sex: "FEMALE", identifiedByExpert: "TRUE" } }]));
    nothingDiffers(nothing);
    nothingDiffers(await plan(f, edited(await f.download(), [{ id: a1, set: { identifiedByExpert: { boolean: true } } }])));
    const p = await plan(f, edited(await f.download(), [{ id: a1, set: { sex: "Male", scientificName: "BOMBUS VOSNESENSKII", identificationQualifier: "CF." } }]));
    expect(p.differences.map((c) => [c.unit, differing(c)])).toEqual([["determination", ["scientificName", "identificationQualifier", "sex"]]]);
    // As read: the lower-cased word.
    const cells = p.differences[0]!.cells;
    expect(cells.find((c) => c.column === "sex")!.value).toEqual({ kind: "word", word: "male" });
    expect(cells.find((c) => c.column === "identificationQualifier")!.value).toEqual({ kind: "word", word: "cf." });
    expect(cells.find((c) => c.column === "scientificName")!.value).toEqual({ kind: "text", text: "BOMBUS VOSNESENSKII" });
  });
});

describe("a unit is listed only when it is complete", () => {
  const edit = async (f: UploadFixture, set: Record<string, TestCell>, id = f.ids.a1, today?: string) =>
    plan(f, edited(await f.download(), [{ id, set }]), today);

  describe("an identification", () => {
    it("needs a name", async () => {
      const f = await sharedUploadFixture();
      const p = await edit(f, { scientificName: "" });
      expect(heldOf(p, "name_blank").map((h) => [h.row, h.unit, h.column])).toEqual([[2, "determination", "scientificName"]]);
      expect(p.differences).toEqual([]);
      // a2 has no name and no identification, and a blank is what Beeline says.
      nothingDiffers(await edit(f, { scientificName: "" }, f.ids.a2));
      // A name with another cell edited is complete.
      expect((await edit(f, { scientificName: "Andrena" })).differences).toHaveLength(1);
      // A specimen with no name, given only a sex, has no name to go with it.
      expect(heldOf(await edit(f, { sex: "male" }, f.ids.a2), "name_blank")).toHaveLength(1);
    });

    it("needs a qualifier Beeline knows, or none", async () => {
      const f = await sharedUploadFixture();
      for (const word of DETERMINATION_QUALIFIERS) expect((await edit(f, { identificationQualifier: word })).differences, word).toHaveLength(1);
      for (const bad of ["maybe", "cf", "sp.", "agg."]) {
        const p = await edit(f, { identificationQualifier: bad });
        expect(heldOf(p, "qualifier_unknown").map((h) => h.cells.map((c) => c.fileSays)), bad).toEqual([[bad]]);
        expect(p.differences).toEqual([]);
      }
    });

    it("needs a sex Beeline knows, or none", async () => {
      const f = await sharedUploadFixture();
      for (const word of DETERMINATION_SEXES) expect((await edit(f, { sex: word, caste: "" })).differences, word).toHaveLength(word === "female" ? 0 : 1);
      expect((await edit(f, { sex: "" })).differences).toHaveLength(1);
      for (const bad of ["queen", "f", "unknown"]) expect(heldOf(await edit(f, { sex: bad }), "sex_unknown"), bad).toHaveLength(1);
    });

    it("is judged on Beeline's own value for a column the file is not read for, so an edit there cannot hold it", async () => {
      const f = await sharedUploadFixture();
      const parsed = await parseUpload(edited(await f.download(), [{ id: f.ids.a1, set: { scientificName: "Bombus", sex: "queen" } }]));
      if (!parsed.ok) throw new Error(parsed.refusal);
      // A file read for the name alone: the sex it carries is not Beeline's to take from it.
      const nameOnly: Layout = { ...SPECIMENS_LAYOUT, recognise: [], read: ["scientificName"], headings: [], shaded: [], refuses: [] };
      const p = await comparePlan(f.db, { ...parsed.upload, layout: nameOnly }, { today: DEFAULT_TODAY });
      expect(p.held).toEqual([]);
      expect(p.differences.map((d) => d.cells.filter((c) => c.differs).map((c) => [c.column, c.fileSays]))).toEqual([[["scientificName", "Bombus"]]]);
      expect(p.notApplied.map((n) => [n.column, n.fileSays])).toEqual([["sex", "queen"]]);
    });

    it("needs a caste Beeline knows, or none", async () => {
      const f = await sharedUploadFixture();
      for (const bad of ["king", "queen", "w"]) expect(heldOf(await edit(f, { caste: bad }), "caste_unknown"), bad).toHaveLength(1);
      expect((await edit(f, { caste: "worker" })).differences).toHaveLength(1);
      expect((await edit(f, { caste: "gyne" })).differences).toHaveLength(1);
    });

    it("needs a caste that fits the sex: a drone is male and a male is a drone", async () => {
      const f = await sharedUploadFixture();
      // a1 is female.
      expect(heldOf(await edit(f, { caste: "drone" }), "caste_sex")).toHaveLength(1);
      expect(heldOf(await edit(f, { sex: "male", caste: "worker" }), "caste_sex")).toHaveLength(1);
      expect(heldOf(await edit(f, { sex: "male", caste: "gyne" }), "caste_sex")).toHaveLength(1);
      expect(heldOf(await edit(f, { sex: "male" }), "caste_sex"), "a male with no caste is whole").toEqual([]);
      expect((await edit(f, { sex: "male", caste: "drone" })).differences).toHaveLength(1);
      expect((await edit(f, { sex: "gynandromorph", caste: "worker" })).differences).toHaveLength(1);
      // Where the sex is not said, the CHECK is satisfied by any caste.
      expect((await edit(f, { sex: "", caste: "drone" })).differences).toHaveLength(1);
      // A caste with its sex, case aside.
      expect((await edit(f, { sex: "MALE", caste: "Drone" })).differences).toHaveLength(1);
    });

    it("needs a date identified that is not after today", async () => {
      const f = await sharedUploadFixture();
      const today = "2026-11-16";
      expect(heldOf(await edit(f, { dateIdentified: "2026-11-17" }, f.ids.a1, today), "date_identified_future")).toHaveLength(1);
      expect(heldOf(await edit(f, { dateIdentified: "2999" }, f.ids.a1, today), "date_identified_future")).toHaveLength(1);
      expect(heldOf(await edit(f, { dateIdentified: "2026-12" }, f.ids.a1, today), "date_identified_future")).toHaveLength(1);
      expect(heldOf(await edit(f, { dateIdentified: "2027" }, f.ids.a1, today), "date_identified_future")).toHaveLength(1);
      // Today, this month and this year have begun.
      for (const ok of ["2026-11-16", "2026-11", "2026", "2025-12-31"]) expect((await edit(f, { dateIdentified: ok }, f.ids.a1, today)).differences, ok).toHaveLength(1);
      // A blank date is complete.
      expect((await edit(f, { dateIdentified: "" }, f.ids.a1, today)).differences).toHaveLength(1);
    });

    it("does not check the determiner, nor that the name is in the taxonomy", async () => {
      const f = await sharedUploadFixture();
      expect((await edit(f, { identifiedBy: "Nobody Known", scientificName: "Notagenus notaspecies" })).differences.map((c) => differing(c))).toEqual([["scientificName", "identifiedBy"]]);
    });

    it("reads its words from the vocabularies the schema checks", () => {
      const schema = readFileSync(join(import.meta.dirname, "..", "schema", "040_determinations.sql"), "utf8");
      const listOf = (column: string) => {
        const m = new RegExp(`${column}\\s+TEXT CHECK \\(${column} IN \\(([^)]*)\\)`).exec(schema)!;
        return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]);
      };
      expect([...DETERMINATION_SEXES]).toEqual(listOf("sex"));
      expect([...DETERMINATION_CASTES]).toEqual(listOf("caste"));
      expect([...DETERMINATION_QUALIFIERS]).toEqual(listOf("qualifier"));
      const specimens = readFileSync(join(import.meta.dirname, "..", "schema", "030_samples_specimens.sql"), "utf8");
      const disposition = /disposition TEXT CHECK \(disposition IN \(([^)]*)\)\)/.exec(specimens)![1]!;
      expect([...DISPOSITIONS]).toEqual([...disposition.matchAll(/'([^']+)'/g)].map((x) => x[1]));
    });
  });

  describe("a disposition", () => {
    it("is a disposition Beeline knows, or none, with a remark", async () => {
      const f = await sharedUploadFixture();
      const { a2 } = f.ids;
      for (const word of DISPOSITIONS) {
        const p = await edit(f, { disposition: word, occurrenceRemarks: "Looked at" }, a2);
        expect(p.differences.map((c) => [c.unit, differing(c)]), word).toEqual([["disposition", ["disposition", "occurrenceRemarks"]]]);
      }
      expect((await edit(f, { occurrenceRemarks: "A remark and no disposition" }, a2)).differences).toHaveLength(1);
      for (const bad of ["lost", "In collection", "in  collection"]) {
        const p = await edit(f, { disposition: bad, occurrenceRemarks: "Looked at" }, a2);
        expect(heldOf(p, "disposition_unknown").map((h) => h.cells.map((c) => c.fileSays)), bad).toEqual([[bad, "Looked at"]]);
      }
    });

    it("needs a remark, because the store keeps none without one", async () => {
      const f = await uploadFixture();
      const p = await edit(f, { disposition: "missing" }, f.ids.a2);
      expect(heldOf(p, "remarks_blank").map((h) => [h.unit, h.column])).toEqual([["disposition", "occurrenceRemarks"]]);
      expect(p.differences).toEqual([]);
      // A remark taken away is a row the store cannot hold either.
      await f.conn.run(
        `INSERT INTO specimen_disposition (specimen_id, disposition, remarks, stated_by, stated_on, source) VALUES (${f.ids.a3}, 'missing', 'Lost', 'staff', DATE '${CURRENT_SEASON}-08-01', 'inventory')`,
      );
      expect(heldOf(await edit(f, { occurrenceRemarks: "" }, f.ids.a3), "remarks_blank")).toHaveLength(1);
      expect(heldOf(await edit(f, { occurrenceRemarks: "  " }, f.ids.a3), "remarks_blank")).toHaveLength(1);
    });
  });

  describe("a sample's dates and method", () => {
    it("needs a collecting date", async () => {
      const f = await sharedUploadFixture();
      const p = await plan(f, edited(await f.download(), onSample(f, { eventDate: "", samplingProtocol: "blue vane trap" })));
      expect(heldOf(p, "event_date_blank").map((h) => [h.row, h.unit, h.column])).toEqual([[2, "method_dates", "eventDate"], [3, "method_dates", "eventDate"], [4, "method_dates", "eventDate"]]);
      expect(p.sampleDifferences).toEqual([]);
      // The method alone, with the date as it was, is complete.
      expect(summary(await plan(f, edited(await f.download(), onSample(f, { samplingProtocol: "blue vane trap" }))))).toEqual([["method_dates", "samplingProtocol"]]);
    });

    it("needs a collecting date that is not after today", async () => {
      const f = await sharedUploadFixture();
      const today = "2026-11-16";
      const download = await f.download();
      const p = await plan(f, edited(download, onSample(f, { eventDate: "2026-11-17" })), today);
      expect(heldOf(p, "event_date_future")).toHaveLength(3);
      // A trap sample that is still out ends in the future.
      expect(heldOf(await plan(f, edited(download, onSample(f, { eventDate: "2026-11-10/2026-11-20" })), today), "event_date_future")).toHaveLength(3);
      for (const ok of ["2026-11-16", "2026-11-10/2026-11-16", "2020-01-01"]) {
        expect(summary(await plan(f, edited(download, onSample(f, { eventDate: ok })), today)), ok).toEqual([["method_dates", "eventDate"]]);
      }
    });
  });

  describe("a sample's coordinates", () => {
    const coordinates = async (f: UploadFixture, set: Record<string, TestCell>) => plan(f, edited(await f.download(), onSample(f, set)));
    const held = (p: UploadPlan, reason: string) => heldOf(p, reason).length;

    it("is a point, which is both numbers, or nothing at all", async () => {
      const f = await sharedUploadFixture();
      expect(held(await coordinates(f, { decimalLatitude: "" }), "coordinates_incomplete")).toBe(3);
      expect(held(await coordinates(f, { decimalLongitude: "" }), "coordinates_incomplete")).toBe(3);
      // An uncertainty needs its point.
      expect(held(await coordinates(f, { decimalLatitude: "", decimalLongitude: "" }), "coordinates_incomplete")).toBe(3);
      // Nothing at all is complete.
      const cleared = await coordinates(f, { decimalLatitude: "", decimalLongitude: "", coordinateUncertaintyInMeters: "" });
      expect(cleared.held).toEqual([]);
      expect(cleared.sampleDifferences.map((c) => [c.unit, differing(c)])).toEqual([["coordinates", ["decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters"]]]);
      expect(cleared.sampleDifferences[0]!.cells.map((c) => c.value)).toEqual([{ kind: "blank" }, { kind: "blank" }, { kind: "blank" }]);
    });

    it("keeps its latitude within -90 and 90 and its longitude within -180 and 180", async () => {
      const f = await sharedUploadFixture();
      for (const bad of ["90.0001", "-91", "180"]) expect(held(await coordinates(f, { decimalLatitude: bad }), "latitude_range"), bad).toBe(3);
      for (const bad of ["180.0001", "-181", "360"]) expect(held(await coordinates(f, { decimalLongitude: bad }), "longitude_range"), bad).toBe(3);
      for (const ok of ["90", "-90", "0"]) expect((await coordinates(f, { decimalLatitude: ok })).sampleDifferences, ok).toHaveLength(1);
      for (const ok of ["180", "-180", "0"]) expect((await coordinates(f, { decimalLongitude: ok })).sampleDifferences, ok).toHaveLength(1);
    });

    it("has an uncertainty that is a positive whole number, or none", async () => {
      const f = await sharedUploadFixture();
      for (const bad of ["0", "-5", "2.5"]) expect(held(await coordinates(f, { coordinateUncertaintyInMeters: bad }), "uncertainty_invalid"), bad).toBe(3);
      for (const ok of ["1", "30.0", "5000"]) {
        const p = await coordinates(f, { coordinateUncertaintyInMeters: ok });
        expect(p.sampleDifferences.length, ok).toBe(ok === "30.0" ? 0 : 1);
      }
      expect((await coordinates(f, { decimalLatitude: "", decimalLongitude: "", coordinateUncertaintyInMeters: "" })).sampleDifferences).toHaveLength(1);
    });
  });

  describe("a sample's locality", () => {
    it("is any text, and blank too", async () => {
      const f = await sharedUploadFixture();
      const download = await f.download();
      for (const value of ["Albany", "x", "A very long place name ".repeat(10), "=1+1", "-Corvallis"]) {
        const p = await plan(f, edited(download, onSample(f, { locality: value })));
        expect(summary(p), value).toEqual([["place", "locality"]]);
        expect(p.held).toEqual([]);
      }
      const blank = await plan(f, edited(download, onSample(f, { locality: "" })));
      expect(blank.held).toEqual([]);
      expect(blank.sampleDifferences[0]!.cells[0]).toMatchObject({ column: "locality", was: "Corvallis", fileSays: "", value: { kind: "blank" }, differs: true });
    });
  });

  it("has a note, saying what to do, for every reason a unit can be held for", () => {
    expect(new Set(HOLD_REASONS).size).toBe(HOLD_REASONS.length);
    for (const reason of HOLD_REASONS) expect(en.uploads.notes.reason[reason], reason).toBeTruthy();
    // And no words for a reason that does not exist.
    expect(Object.keys(en.uploads.notes.reason).sort()).toEqual([...HOLD_REASONS].sort());
  });
});

describe("what a plan carries for a later step", () => {
  it("names the sample and the determination of record, and the value as read, beside the text", async () => {
    const f = await uploadFixture();
    const { a1, a2, sampleA } = f.ids;
    const p = await plan(f, edited(await f.download(), [{ id: a1, set: { scientificName: "Andrena", dateIdentified: "2025-07" } }, { id: a2, set: { occurrenceRemarks: "Eaten", disposition: "missing" } }]));
    const [determination] = (await f.conn.runAndReadAll(`SELECT max(entity_id) FROM determination WHERE specimen_id = ${a1}`)).getRows() as [[bigint]];
    expect(p.differences.find((c) => c.unit === "determination")).toMatchObject({
      specimenId: a1,
      sampleId: sampleA,
      determinationId: Number(determination[0]),
    });
    expect(p.differences.find((c) => c.unit === "determination")!.cells.map((c) => c.value)).toEqual([
      { kind: "text", text: "Andrena" },
      { kind: "blank" },
      { kind: "word", word: "female" },
      { kind: "text", text: "Dee Determiner" },
      { kind: "moment", date: "2025-07", precision: "month" },
      { kind: "blank" },
    ]);
    // A specimen with no determination has none to name.
    expect(p.differences.find((c) => c.unit === "disposition")).toMatchObject({ specimenId: a2, sampleId: sampleA, determinationId: null });
    expect(p.differences.find((c) => c.unit === "disposition")!.cells.map((c) => c.value)).toEqual([{ kind: "text", text: "missing" }, { kind: "text", text: "Eaten" }]);
  });
});

describe("columns that were not read", () => {
  it("lists a heading that is not a column of the download, and says it was not read", async () => {
    const f = await sharedUploadFixture();
    const p = await plan(f, edited(await f.download(), onSample(f, { locality: "Albany" }), { addColumns: { myNotes: "see me" } }));
    expect(p.unrecognised).toEqual([{ letter: expect.stringMatching(/^[A-Z]+$/), header: "myNotes", probably: null }]);
    // What is in it is not a difference.
    expect(summary(p)).toEqual([["place", "locality"]]);
  });

  it("says which column a heading was probably meant for, when only case or spaces differ", async () => {
    const f = await sharedUploadFixture();
    const p = await plan(f, edited(await f.download(), [], { renameColumns: { scientificName: "Scientific Name", sex: "SEX", locality: "local ity", county: "Country" } }));
    expect(p.unrecognised.map((u) => [u.header, u.probably]).sort()).toEqual([
      ["Country", null],
      ["SEX", "sex"],
      ["Scientific Name", "scientificName"],
      ["local ity", "locality"],
    ]);
    // Not read: a column renamed is a column the file lacks, so nothing differs.
    nothingDiffers({ ...p, unrecognised: [] });
  });

  it("does not list a heading that is only padded with spaces, and does not list a blank one", async () => {
    const f = await sharedUploadFixture();
    const matrix = matrixOf(await f.download());
    matrix[0]![matrix[0]!.indexOf("locality")] = "  locality ";
    matrix[0]!.push("");
    const p = await plan(f, buildWorkbook(matrix.map((r, i) => (i === 0 ? r : [...r, "stray"]))));
    expect(p.unrecognised).toEqual([]);
  });
});

describe("a file edited against something Beeline no longer says", () => {
  it("holds identification differences when another determination is the record by now", async () => {
    const f = await uploadFixture();
    const { a1, a2 } = f.ids;
    const download = await f.download();
    await f.conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_name, verbatim_identification)
       SELECT ${a1}, entity_id, true, 'worksheet_import', 'Newer Determiner', 'Bombus' FROM animal WHERE scientific_name = 'Bombus'`,
    );
    const p = await plan(f, edited(download, [{ id: a1, set: { scientificName: "Andrena", locality: "Elsewhere", disposition: "missing", occurrenceRemarks: "x" } }]));
    // Every cell of the file's identification that differs is held with it, not only the one edited.
    expect(heldOf(p, "specimen_changed_since").map((h) => [h.unit, h.column, h.columns])).toEqual([
      // The newer determination says something else, so the cells the file kept from the old one differ too.
      ["determination", "scientificName", ["scientificName", "sex", "identifiedBy", "dateIdentified"]],
      // The disposition is read against the same version, so it is held too.
      ["disposition", "disposition", ["disposition", "occurrenceRemarks"]],
    ]);
    expect(p.differences).toEqual([]);
    // A file with no specimenVersion cannot say what it was edited against.
    const noKey = await plan(f, edited(download, [{ id: a1, set: { scientificName: "Andrena" } }], { dropColumns: ["specimenVersion"] }));
    expect(heldOf(noKey, "column_missing").map((h) => [h.unit, h.detail])).toEqual([["determination", "specimenVersion"]]);
    // A specimen with no determination has a version too, and an edit made against it stands.
    const first = await plan(f, edited(download, [{ id: a2, set: { scientificName: "Bombus" } }]));
    expect(first.differences.map((c) => [c.specimenId, c.cells[0]!.was, c.cells[0]!.fileSays])).toEqual([[a2, "", "Bombus"]]);
  });

  it("holds a determination that a loader updated in place, where the id did not change", async () => {
    const f = await uploadFixture();
    const { a1 } = f.ids;
    const download = await f.download();
    await f.conn.run(`UPDATE determination SET sex = 'male' WHERE specimen_id = ${a1}`);
    const p = await plan(f, edited(download, [{ id: a1, set: { scientificName: "Andrena" } }]));
    expect(heldOf(p, "specimen_changed_since").map((h) => [h.specimenId, h.unit])).toEqual([[a1, "determination"]]);
    expect(p.differences).toEqual([]);
    // Putting the cell back puts the version back.
    await f.conn.run(`UPDATE determination SET sex = 'female' WHERE specimen_id = ${a1}`);
    nothingDiffers(await plan(f, download));
  });

  it("holds a disposition that changed after the download", async () => {
    const f = await uploadFixture();
    const { a2 } = f.ids;
    const download = await f.download();
    await f.conn.run(
      `INSERT INTO specimen_disposition (specimen_id, disposition, remarks, stated_by, stated_on, source)
       VALUES (${a2}, 'missing', 'Lost in the post', 'staff', DATE '${CURRENT_SEASON}-08-01', 'inventory')`,
    );
    const p = await plan(f, edited(download, [{ id: a2, set: { occurrenceRemarks: "Found again" } }]));
    expect(heldOf(p, "specimen_changed_since").map((h) => [h.unit, h.columns])).toEqual([["disposition", ["disposition", "occurrenceRemarks"]]]);
    expect(p.differences).toEqual([]);
  });

  it("holds a sample's differences when the sample has changed since, or the file cannot say", async () => {
    const f = await uploadFixture();
    const { sampleA } = f.ids;
    const download = await f.download();
    const all = onSample(f, { locality: "Elsewhere" });
    expect((await plan(f, edited(download, all))).sampleDifferences).toHaveLength(1);

    await f.conn.run(`UPDATE sample SET protocol = 'blue vane trap' WHERE entity_id = ${sampleA}`);
    const stale = await plan(f, edited(download, all));
    expect(stale.sampleDifferences).toEqual([]);
    // The method now differs from what the file says, so its unit is held too.
    expect(heldOf(stale, "sample_changed_since").map((h) => [h.unit, h.column])).toEqual([["method_dates", "samplingProtocol"], ["place", "locality"]]);
    expect(heldOf(stale, "sample_changed_since")[1]).toMatchObject({ sampleNumber: "UP-1", detail: "Elsewhere" });

    const noKey = await plan(f, edited(download, all, { dropColumns: ["sampleVersion"] }));
    expect(heldOf(noKey, "column_missing").map((h) => [h.unit, h.detail])).toEqual([["method_dates", "sampleVersion"], ["place", "sampleVersion"]]);
    // Nothing differs, so nothing is held for want of a version.
    nothingDiffers(await plan(f, edited(await f.download(), [], { dropColumns: ["sampleVersion", "specimenVersion"] })));
  });

  it("holds a sample whose version cell is blank on a row", async () => {
    const f = await sharedUploadFixture();
    const p = await plan(f, edited(await f.download(), [{ id: f.ids.a1, set: { sampleVersion: "", locality: "Elsewhere" } }, { id: f.ids.a2, set: { locality: "Elsewhere" } }, { id: f.ids.a3, set: { locality: "Elsewhere" } }]));
    expect(heldOf(p, "sample_changed_since")).toHaveLength(1);
  });
});

describe("a held unit names every cell held with it", () => {
  it("lists, for a specimen, the cells of the unit that differ and the cell that caused the hold, with what the file says", async () => {
    const f = await sharedUploadFixture();
    const p = await plan(f, edited(await f.download(), [{ id: f.ids.a1, set: { scientificName: "Bombus", sex: "male", dateIdentified: { date: serialOf("2025-07-01") + 0.5 } } }]));
    expect(p.differences).toEqual([]);
    const held = heldOf(p, "holds_time");
    expect(held).toHaveLength(1);
    expect(held[0]!.column).toBe("dateIdentified");
    expect(held[0]!.cells).toEqual([
      { column: "scientificName", was: "Bombus vosnesenskii", fileSays: "Bombus" },
      { column: "sex", was: "female", fileSays: "male" },
      { column: "dateIdentified", was: "2024-05-03", fileSays: "2025-07-01 12:00:00" },
    ]);
    expect(held[0]!.columns).toEqual(["scientificName", "sex", "dateIdentified"]);
  });

  it("lists, for an incomplete unit, the cell that makes it so even where it did not change", async () => {
    const f = await sharedUploadFixture();
    // a1 is female; a drone is male. The caste is edited and the sex is not, and both are listed.
    const p = await plan(f, edited(await f.download(), [{ id: f.ids.a1, set: { caste: "drone" } }]));
    expect(heldOf(p, "caste_sex")[0]!.cells).toEqual([{ column: "caste", was: "", fileSays: "drone" }]);
  });

  it("lists, for a sample, the cells of the unit across its rows", async () => {
    const f = await sharedUploadFixture();
    const { a2 } = f.ids;
    // The first row of the sample changes its date to a good one, and the second to one that cannot be read: the
    // cells shown are the second row's, the one that failed, not the first row's.
    const p = await plan(
      f,
      edited(await f.download(), [
        ...onSample(f, { samplingProtocol: "blue vane trap" }),
        { id: f.ids.a1, set: { eventDate: `${CURRENT_SEASON}-07-15` } },
        { id: a2, set: { eventDate: "July 14" } },
      ]),
    );
    const held = heldOf(p, "date_unreadable");
    expect(held).toHaveLength(1);
    expect(held[0]!.row).toBe(3);
    expect(held[0]!.cells).toEqual([
      { column: "eventDate", was: DAY_A, fileSays: "July 14" },
      { column: "samplingProtocol", was: "net", fileSays: "blue vane trap" },
    ]);
    expect(p.sampleDifferences).toEqual([]);
  });

  it("holds a sample's unit whole when one of its rows has an unusable cell", async () => {
    const f = await sharedUploadFixture();
    const { a1, a2, a3 } = f.ids;
    const p = await plan(
      f,
      edited(await f.download(), [...[a1, a3].map((id) => ({ id, set: { samplingProtocol: "blue vane trap" } })), { id: a2, set: { eventDate: "July 14", samplingProtocol: "blue vane trap" } }]),
    );
    expect(heldOf(p, "date_unreadable").map((h) => [h.row, h.sampleNumber])).toEqual([[3, "UP-1"]]);
    expect(p.sampleDifferences).toEqual([]);
    expect(heldOf(p, "rows_disagree")).toEqual([]);
  });
});

describe("saying what kind of change each cell is", () => {
  it("lists each unit whole, sorts every differing column into its kind, and leaves the keys out", async () => {
    const f = await sharedUploadFixture();
    const { a1, a2, a3 } = f.ids;
    const p = await plan(
      f,
      edited(await f.download(), [
        {
          id: a1,
          set: {
            scientificName: "Bombus",
            identificationQualifier: "cf.",
            sex: "male",
            caste: "drone",
            identifiedBy: "Someone Else",
            dateIdentified: "2025",
            disposition: "missing",
            occurrenceRemarks: "Eaten by a mouse",
            // Not read from a file.
            identifiedByExpert: "false",
            scientificNameAuthorship: "Smith",
            taxonRank: "genus",
            county: "Linn",
            minimumElevationInMeters: "5",
            associatedTaxa: "something else",
            recordedBy: "Nobody",
            catalogNumber: "X1",
            hostFamily: "Rosaceae",
          },
        },
        // The sample's cells are edited on every specimen of it, as a person editing a sample would.
        ...onSample(f, { samplingProtocol: "blue vane trap", eventDate: "2026-01-01/2026-01-05", locality: "Albany", decimalLongitude: "-122.5" }),
        { id: a2, set: { sampleNumber: "ignored" } },
      ]),
      "2026-11-16",
    );
    expect(p.differences.map((c) => [c.unit, c.cells.map((x) => x.column), differing(c)])).toEqual([
      [
        "determination",
        ["scientificName", "identificationQualifier", "sex", "identifiedBy", "dateIdentified", "caste"],
        ["scientificName", "identificationQualifier", "sex", "identifiedBy", "dateIdentified", "caste"],
      ],
      ["disposition", ["disposition", "occurrenceRemarks"], ["disposition", "occurrenceRemarks"]],
    ]);
    expect(p.sampleDifferences.map((c) => [c.unit, c.cells.map((x) => x.column), differing(c)])).toEqual([
      ["method_dates", ["eventDate", "samplingProtocol"], ["eventDate", "samplingProtocol"]],
      ["place", ["locality"], ["locality"]],
      ["coordinates", ["decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters"], ["decimalLongitude"]],
    ]);
    expect(p.notApplied.map((c) => c.column).sort()).toEqual(
      ["associatedTaxa", "catalogNumber", "county", "hostFamily", "identifiedByExpert", "minimumElevationInMeters", "recordedBy", "sampleNumber", "scientificNameAuthorship", "taxonRank"].sort(),
    );
    // The row's identity is never a difference.
    for (const key of ["specimenId", "specimenVersion", "sampleVersion", "fieldNumber", "determinationId"]) {
      expect([...p.differences.flatMap((c) => c.cells), ...p.sampleDifferences.flatMap((c) => c.cells), ...p.notApplied].map((c) => c.column)).not.toContain(key);
    }
    expect(p.held).toEqual([]);
    const place = p.sampleDifferences.find((c) => c.unit === "place")!.cells[0]!;
    expect([place.was, place.fileSays]).toEqual(["Corvallis", "Albany"]);
    const disposition = p.differences.find((c) => c.unit === "disposition")!;
    expect(disposition).toMatchObject({ specimenId: a1, fieldNumber: "OBA10001", row: 2 });
    expect(disposition.cells[0]).toEqual({ column: "disposition", was: "", fileSays: "missing", value: { kind: "text", text: "missing" }, differs: true });
    void a3;
  });

  it("lists a latitude with its longitude, and holds it when the file has no longitude", async () => {
    const f = await sharedUploadFixture();
    const download = await f.download();
    const edits = onSample(f, { decimalLatitude: "44.6" });
    const whole = await plan(f, edited(download, edits));
    expect(whole.sampleDifferences).toHaveLength(1);
    expect(whole.sampleDifferences[0]!.cells).toEqual([
      { column: "decimalLatitude", was: "44.5646", fileSays: "44.6", value: { kind: "number", number: 44.6 }, differs: true },
      { column: "decimalLongitude", was: "-123.262", fileSays: "-123.262", value: { kind: "number", number: -123.262 }, differs: false },
      { column: "coordinateUncertaintyInMeters", was: "30", fileSays: "30", value: { kind: "number", number: 30 }, differs: false },
    ]);
    const half = await plan(f, edited(download, edits, { dropColumns: ["decimalLongitude"] }));
    expect(half.sampleDifferences).toEqual([]);
    expect(heldOf(half, "column_missing").map((h) => [h.unit, h.detail, h.columns])).toEqual([["coordinates", "decimalLongitude", ["decimalLatitude"]]]);
  });
});

describe("a sample's difference counted once", () => {
  it("is one difference for the sample, with how many of its specimens the file holds", async () => {
    const f = await sharedUploadFixture();
    const { a1, a2, a3, sampleA } = f.ids;
    const p = await plan(f, edited(await f.download(), [a1, a2].map((id) => ({ id, set: { locality: "Elsewhere" } })), { dropRows: [a3] }));
    expect(p.sampleDifferences).toEqual([
      {
        unit: "place",
        sampleId: sampleA,
        sampleNumber: "UP-1",
        sample: expect.objectContaining({ id: sampleA, number: "UP-1", collectors: ["V. Volunteer"] }),
        cells: [{ column: "locality", was: "Corvallis", fileSays: "Elsewhere", value: { kind: "text", text: "Elsewhere" }, differs: true }],
        rows: [2, 3],
        moreRows: 0,
        everyRow: [2, 3],
        specimensInFile: 2,
        specimensInSample: 3,
        // Specimens with no label row at all are imported ones, whose labels are on pins.
        printed: true,
      },
    ]);
    expect(p.counts.withDifferences).toEqual({ active: 2, settled: 0, unplaced: 0 });
  });

  it("says when a sample's labels have not printed", async () => {
    const f = await uploadFixture("staffer", { unprinted: true });
    const { c1, sampleC } = f.ids;
    const p = await plan(f, edited(await f.download(), [{ id: c1!, set: { locality: "Elsewhere" } }]));
    expect(p.sampleDifferences).toHaveLength(1);
    expect(p.sampleDifferences[0]).toMatchObject({ sampleId: sampleC, sampleNumber: "UP-3", printed: false, specimensInFile: 1, specimensInSample: 1 });
  });

  it("holds the difference when the rows of one sample do not say the same thing", async () => {
    const f = await sharedUploadFixture();
    const { a1, a2 } = f.ids;
    const download = await f.download();
    // One row edited and its sample-mates left alone.
    const one = await plan(f, edited(download, [{ id: a1, set: { locality: "Elsewhere" } }]));
    expect(one.sampleDifferences).toEqual([]);
    expect(heldOf(one, "rows_disagree")).toHaveLength(1);
    expect(heldOf(one, "rows_disagree")[0]).toMatchObject({ unit: "place", column: "locality", sampleNumber: "UP-1", rows: [2, 3, 4] });
    // Two rows edited to different things.
    expect(heldOf(await plan(f, edited(download, [{ id: a1, set: { locality: "X" } }, { id: a2, set: { locality: "Y" } }])), "rows_disagree")).toHaveLength(1);
    // Every row saying the same is one difference.
    const all = await plan(f, edited(download, onSample(f, { locality: "X" })));
    expect(heldOf(all, "rows_disagree")).toEqual([]);
    expect(all.sampleDifferences).toHaveLength(1);
    // Two rows that say it in different ways that read the same are one.
    const same = await plan(f, edited(download, [{ id: a1, set: { decimalLatitude: "44.6" } }, { id: a2, set: { decimalLatitude: { number: "44.6" } } }, { id: f.ids.a3, set: { decimalLatitude: "44.60" } }]));
    expect(heldOf(same, "rows_disagree")).toEqual([]);
    expect(same.sampleDifferences).toHaveLength(1);
  });

  it("splits every count by active and settled season", async () => {
    const f = await sharedUploadFixture();
    const { a1, b1 } = f.ids;
    const p = await plan(f, edited(await f.download(), [{ id: a1, set: { county: "Linn" } }, { id: b1, set: { county: "Linn" } }]));
    expect(p.counts.withDifferences).toEqual({ active: 1, settled: 1, unplaced: 0 });
    expect(p.counts.unchanged).toEqual({ active: 2, settled: 0, unplaced: 0 });
    void SETTLED_SEASON;
  });
});

describe("which sheet is read, and what else the workbook holds", () => {
  it("reads the sheet named specimens wherever it is, and lists the tabs it did not read", async () => {
    const f = await sharedUploadFixture();
    const bytes = edited(await f.download(), onSample(f, { locality: "Albany" }), { sheets: { others: ["notes", "specimens (2)"], before: true } });
    const p = await plan(f, bytes);
    expect(p.otherSheets).toEqual(["notes", "specimens (2)"]);
    expect(summary(p)).toEqual([["place", "locality"]]);
    // A file with one sheet has no others.
    expect((await plan(f, await f.download())).otherSheets).toEqual([]);
  });

  it("compares an unedited specimens file with its tabs of Beeline's own as no difference, and lists none of them as a tab that was not read", async () => {
    const f = await sharedUploadFixture();
    const download = await f.file();
    // The file as the app wrote it, untouched: the specimens tab and Beeline's four.
    const read = readXlsxHere(download);
    expect(read.ok && read.sheet.name).toBe("specimens");
    expect(read.ok && read.otherSheets).toEqual(["names", "identifiers", "words", "about"]);
    const p = await planAsRead(f, download);
    nothingDiffers(p);
    expect(p.otherSheets).toEqual([]);
    expect(p.counts.unchanged.active + p.counts.unchanged.settled).toBe(4);
  });

  // Gnumeric's converter, where it is installed: a real spreadsheet program opening the file and saving it again,
  // which no library standing in for one is. CI has none, so the test says it was skipped there.
  const ssconvert = spawnSync("ssconvert", ["--version"]).status === 0;
  it.skipIf(!ssconvert)("compares the file as Gnumeric saves it again, untouched, as no difference (needs ssconvert)", async () => {
    const f = await sharedUploadFixture();
    const dir = await mkdtemp(join(tmpdir(), "beeline-gnumeric-"));
    await writeFile(join(dir, "from-beeline.xlsx"), await f.file());
    const converted = spawnSync("ssconvert", [join(dir, "from-beeline.xlsx"), join(dir, "from-gnumeric.xlsx")], { timeout: 60_000 });
    expect(converted.status, String(converted.stderr)).toBe(0);
    const saved = new Uint8Array(await readFile(join(dir, "from-gnumeric.xlsx")));
    // Not the bytes Beeline wrote: Gnumeric wrote its own file.
    expect(Buffer.from(saved).equals(Buffer.from(await f.file()))).toBe(false);
    const read = readXlsxHere(saved);
    expect(read.ok && read.sheet.name).toBe("specimens");
    const p = await planAsRead(f, saved);
    nothingDiffers(p);
    expect(p.otherSheets).toEqual([]);
    expect(p.unrecognised).toEqual([]);
    expect(p.counts.unchanged.active + p.counts.unchanged.settled).toBe(4);
  });

  it("changing one of Beeline's own tabs changes nothing, and a tab of the person's own is still listed", async () => {
    const f = await sharedUploadFixture();
    const p = await planAsRead(f, edited(await f.file(), [], { sheets: { others: ["names", "identifiers", "words", "about", "my notes"] } }));
    nothingDiffers(p);
    expect(p.otherSheets).toEqual(["my notes"]);
  });

  it("reads the specimens file's identification and disposition columns as units", async () => {
    const f = await sharedUploadFixture();
    const { a1, a2 } = f.ids;
    const download = await f.file();
    const p = await planAsRead(f, edited(download, [
      { id: a1, set: { scientificName: "Bombus", identifiedBy: "A Person Beeline Has Never Seen" } },
      // Pasted from another sheet: a real date cell, and a name for a specimen that had none.
      { id: a2, set: { scientificName: "Bombus vosnesenskii", dateIdentified: { date: serialOf("2025-07-01") }, disposition: "missing", occurrenceRemarks: "Lost" } },
    ]));
    expect(p.differences.map((d) => [d.specimenId, d.unit, d.cells.filter((c) => c.differs).map((c) => c.column)])).toEqual([
      [a1, "determination", ["scientificName", "identifiedBy"]],
      [a2, "determination", ["scientificName", "dateIdentified"]],
      [a2, "disposition", ["disposition", "occurrenceRemarks"]],
    ]);
    // An identifier Beeline has never seen is not a fault: nothing is held.
    expect(p.held).toEqual([]);
    // A disposition without its remark is held, as a unit.
    const blank = await planAsRead(f, edited(download, [{ id: a1, set: { disposition: "missing" } }]));
    expect(heldOf(blank, "remarks_blank")).toHaveLength(1);
  });

  it("reports an edit to a column that only helps recognise the bee as ignored, and makes no unit of it", async () => {
    const f = await sharedUploadFixture();
    const { a1 } = f.ids;
    const p = await planAsRead(f, edited(await f.file(), [{ id: a1, set: { eventDate: `${CURRENT_SEASON}-07-15`, locality: "Albany", recordedBy: "Somebody Else", fieldNumber: "OBA10001" } }]));
    expect(p.differences).toEqual([]);
    expect(p.sampleDifferences).toEqual([]);
    expect(p.held).toEqual([]);
    expect(p.notApplied.map((c) => c.column).sort()).toEqual(["eventDate", "locality", "recordedBy"]);
    expect(p.notApplied.find((c) => c.column === "eventDate")).toMatchObject({ fileSays: `${CURRENT_SEASON}-07-15` });
  });

  it("takes the sample's method, coordinates, elevation and the host's family as grey columns: a file with them, or an older one without, makes no change (beeline-okn9)", async () => {
    const f = await sharedUploadFixture();
    const { a1 } = f.ids;
    const context = ["samplingProtocol", "decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters", "minimumElevationInMeters", "maximumElevationInMeters", "hostFamily"];
    const file = await f.file();
    const head = matrixOf(file)[0]!;
    for (const c of context) expect(head, c).toContain(c);
    // Unedited, nothing differs, and none is listed as a column Beeline does not read.
    const same = await planAsRead(f, file);
    nothingDiffers(same);
    expect(same.unrecognised).toEqual([]);
    // An older file that lacks them loads the same way.
    const older = await planAsRead(f, edited(file, [], { dropColumns: context }));
    nothingDiffers(older);
    expect(older.unrecognised).toEqual([]);
    // Edited, they are no difference of any unit, and no heading is reported as unknown: only said to be ignored.
    const p = await planAsRead(f, edited(file, [{ id: a1, set: { samplingProtocol: "blue vane trap", decimalLatitude: "44.6", decimalLongitude: "-123.1", coordinateUncertaintyInMeters: "5", minimumElevationInMeters: "900", maximumElevationInMeters: "950", hostFamily: "Other family" } }]));
    expect(p.differences).toEqual([]);
    expect(p.sampleDifferences).toEqual([]);
    expect(p.held).toEqual([]);
    expect(p.unrecognised).toEqual([]);
    expect(p.notApplied.map((c) => c.column).sort()).toEqual(context.slice().sort());
  });

  it("still loads an older download with all the CSV's columns, and lists what differs in the columns it does not read", async () => {
    const f = await sharedUploadFixture();
    const { a1 } = f.ids;
    const p = await planAsRead(f, edited(await f.download(), [
      { id: a1, set: { scientificName: "Bombus", locality: "Albany", decimalLatitude: "44.6", samplingProtocol: "blue vane trap", county: "Linn" } },
    ]));
    // The identification is a difference; the rest are columns this file does not read, and no sample unit is made of them.
    expect(summary(p)).toEqual([["determination", "scientificName"]]);
    expect(p.sampleDifferences).toEqual([]);
    expect(p.held).toEqual([]);
    expect(p.notApplied.map((c) => c.column).sort()).toEqual(["county", "decimalLatitude", "locality", "samplingProtocol"]);
    nothingDiffers(await planAsRead(f, await f.download()));
  });

  it("holds a specimen's units whose specimenVersion is missing or no longer Beeline's, and needs no sampleVersion", async () => {
    const f = await sharedUploadFixture();
    const { a1 } = f.ids;
    const missing = await planAsRead(f, edited(await f.file(), [{ id: a1, set: { scientificName: "Bombus" } }], { dropColumns: ["specimenVersion"] }));
    expect(heldOf(missing, "column_missing").map((h) => [h.unit, h.detail])).toEqual([["determination", "specimenVersion"]]);
    const stale = await planAsRead(f, edited(await f.file(), [{ id: a1, set: { scientificName: "Bombus", specimenVersion: "old" } }]));
    expect(heldOf(stale, "specimen_changed_since")).toHaveLength(1);
    // The file has no sampleVersion, and nothing it reads needs one.
    expect(matrixOf(await f.file())[0]).not.toContain("sampleVersion");
    nothingDiffers(await planAsRead(f, await f.file()));
  });

  it("reaches each rule that waits for the samples upload through the comparison, given a file that names its columns as read", async () => {
    const f = await sharedUploadFixture();
    const download = await f.download();
    const sampleOnly = async (set: Record<string, TestCell>) => plan(f, edited(download, onSample(f, set)));
    expect(summary(await sampleOnly({ samplingProtocol: "blue vane trap" }))).toEqual([["method_dates", "samplingProtocol"]]);
    expect(summary(await sampleOnly({ eventDate: `${CURRENT_SEASON}-07-15` }))).toEqual([["method_dates", "eventDate"]]);
    expect(summary(await sampleOnly({ locality: "Albany" }))).toEqual([["place", "locality"]]);
    expect(summary(await sampleOnly({ decimalLatitude: "44.6", decimalLongitude: "-123.3" }))).toEqual([["coordinates", "decimalLatitude", "decimalLongitude"]]);
  });

  it("reads the only sheet whatever it is called", async () => {
    const f = await sharedUploadFixture();
    const p = await plan(f, edited(await f.download(), onSample(f, { locality: "Albany" }), { sheets: { name: "Sheet1" } }));
    expect(summary(p)).toEqual([["place", "locality"]]);
    expect(p.otherSheets).toEqual([]);
  });

  it("refuses several sheets none of which is named specimens, naming them", async () => {
    const f = await sharedUploadFixture();
    const result = await planUpload(f.db, edited(await f.download(), [], { sheets: { name: "Sheet1", others: ["Sheet2"] } }), { today: DEFAULT_TODAY });
    expect(result).toEqual({ ok: false, refusal: "no_such_sheet", detail: JSON.stringify(["Sheet1", "Sheet2"]) });
  });

  it("refuses an old Office file, which is also what an encrypted workbook is", async () => {
    const f = await sharedUploadFixture();
    expect(await refusal(f, Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]))).toBe("protected_file");
  });
});

describe("numbers a spreadsheet keeps to 15 digits", () => {
  it("takes a number cell as unchanged when it is Beeline's number to 15 significant digits, and a text cell not", async () => {
    const f = await uploadFixture();
    await f.conn.run(`UPDATE sample_location SET longitude = -123.27891540527344 WHERE sample_id = ${f.ids.sampleA}`);
    const download = await f.download();
    const lng = (value: TestCell) => plan(f, edited(download, onSample(f, { decimalLongitude: value })));
    // "Convert to Number" or a paste: the digits past the fifteenth are gone.
    nothingDiffers(await lng({ number: "-123.278915405273" }));
    nothingDiffers(await lng({ number: "-1.23278915405273E2" }));
    // As text it is a number somebody typed, and the digits it lacks are a change.
    expect(summary(await lng("-123.278915405273"))).toEqual([["coordinates", "decimalLongitude"]]);
    // A number that differs inside the 15 digits is a change, and so is one cut shorter.
    expect(summary(await lng({ number: "-123.278915405274" }))).toEqual([["coordinates", "decimalLongitude"]]);
    expect(summary(await lng({ number: "-123.2789154053" }))).toEqual([["coordinates", "decimalLongitude"]]);
    // Unchanged by rounding, the cell carries Beeline's own number and not the file's rounded one; the cell that changed carries the file's.
    const mixed = await plan(f, edited(download, onSample(f, { decimalLongitude: { number: "-123.278915405273" }, decimalLatitude: "44.7" })));
    const cells = mixed.sampleDifferences[0]!.cells;
    expect(cells.find((c) => c.column === "decimalLongitude")).toMatchObject({ differs: false, fileSays: "-123.278915405273", value: { kind: "number", number: -123.27891540527344 } });
    expect(cells.find((c) => c.column === "decimalLatitude")).toMatchObject({ differs: true, value: { kind: "number", number: 44.7 } });
    // A number cell is shown as the number it is: its digits in the file are 44.564599999999999.
    nothingDiffers(await plan(f, edited(download, onSample(f, { decimalLatitude: { number: "44.564599999999999" } }))));
    const moved = await plan(f, edited(download, onSample(f, { decimalLatitude: { number: "44.664599999999999" } })));
    expect(moved.sampleDifferences[0]!.cells.find((c) => c.column === "decimalLatitude")).toMatchObject({ fileSays: "44.6646", value: { kind: "number", number: 44.6646 } });
  });
});

describe("line breaks inside a cell", () => {
  it("compares a line break the same whichever way the spreadsheet saved it, on both sides", async () => {
    const f = await uploadFixture();
    const { a2, a3 } = f.ids;
    await f.conn.run(
      `INSERT INTO specimen_disposition (specimen_id, disposition, remarks, stated_by, stated_on, source)
       VALUES (${a2}, 'missing', 'line one' || chr(10) || 'line two', 'staff', DATE '2025-08-01', 'inventory'),
              (${a3}, 'missing', 'first' || chr(13) || chr(10) || 'second', 'staff', DATE '2025-08-01', 'inventory')`,
    );
    const download = await f.download();
    nothingDiffers(await plan(f, edited(download, [{ id: a2, set: { occurrenceRemarks: "line one\r\nline two" } }, { id: a3, set: { occurrenceRemarks: "first\nsecond" } }])));
    nothingDiffers(await plan(f, edited(download, [{ id: a2, set: { occurrenceRemarks: "line one\rline two" } }, { id: a3, set: { occurrenceRemarks: "first\rsecond" } }])));
    const changed = await plan(f, edited(download, [{ id: a2, set: { occurrenceRemarks: "line one\r\nline three" } }]));
    expect(changed.differences.map((c) => [c.specimenId, differing(c)])).toEqual([[a2, ["occurrenceRemarks"]]]);
  });
});

describe("the versions name the specimen and the sample", () => {
  const versions = (download: Uint8Array) => {
    const matrix = matrixOf(download);
    const head = matrix[0]!;
    return matrix.slice(1).map((r) => ({ id: r[head.indexOf("specimenId")]!, specimen: r[head.indexOf("specimenVersion")]!, sample: r[head.indexOf("sampleVersion")]! }));
  };

  it("gives two specimens with nothing determined or remarked different versions, and two samples that say the same things", async () => {
    const f = await uploadFixture();
    const [[twin]] = (await f.conn.runAndReadAll(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${f.ids.sampleA}, 4) RETURNING entity_id`)).getRows() as [[number]];
    // A sample that says exactly what UP-1 says.
    const sampleD = await insertCleanSample(f.conn, { collector_id: String(f.volunteer), sample_number: "'UP-9'", specimen_count: "1", locality: "'Corvallis'" });
    const [[other]] = (await f.conn.runAndReadAll(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${sampleD}, 1) RETURNING entity_id`)).getRows() as [[number]];
    const v = versions(await f.download());
    const of = (id: number) => v.find((x) => x.id === String(id))!;
    expect(of(f.ids.a2).specimen).not.toBe(of(Number(twin)).specimen);
    expect(of(Number(twin)).specimen).not.toBe(of(Number(other)).specimen);
    expect(of(f.ids.a1).sample).not.toBe(of(Number(other)).sample);
    // The same sample's rows still share one.
    expect(of(f.ids.a1).sample).toBe(of(f.ids.a2).sample);
  });

  it("holds a row whose specimenId was replaced by another specimen's, as fill-drag or a sort of one column does", async () => {
    const f = await uploadFixture();
    const { a2 } = f.ids;
    const [[twin]] = (await f.conn.runAndReadAll(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${f.ids.sampleA}, 4) RETURNING entity_id`)).getRows() as [[number]];
    const download = await f.download();
    // a2's row, with the twin's id in it, and a new name; the field number column is not in the file to give it away.
    const p = await plan(f, edited(download, [{ id: a2, set: { specimenId: String(twin), scientificName: "Bombus" } }], { dropColumns: ["fieldNumber"], dropRows: [Number(twin)] }));
    expect(p.differences).toEqual([]);
    expect(heldOf(p, "specimen_changed_since").map((h) => [h.specimenId, h.unit])).toEqual([[Number(twin), "determination"]]);
    // Without the swap, the same edit stands.
    expect((await plan(f, edited(download, [{ id: a2, set: { scientificName: "Bombus" } }], { dropColumns: ["fieldNumber"] }))).differences).toHaveLength(1);
  });
});

describe("a held sample shows the row that failed", () => {
  it("shows the bad row's own cell when it is not the first row that changed", async () => {
    const f = await sharedUploadFixture();
    const { a1, a2, a3 } = f.ids;
    const p = await plan(f, edited(await f.download(), [{ id: a1, set: { decimalLatitude: "44.6" } }, { id: a2, set: { decimalLatitude: "north" } }, { id: a3, set: { decimalLatitude: "44.6" } }]));
    const held = heldOf(p, "number_unreadable");
    expect(held.map((h) => [h.row, h.detail])).toEqual([[3, "north"]]);
    expect(held[0]!.cells.find((c) => c.column === "decimalLatitude")).toEqual({ column: "decimalLatitude", was: "44.5646", fileSays: "north" });
  });

  it("shows what each row says when the rows of a sample disagree", async () => {
    const f = await sharedUploadFixture();
    const { a1, a2, a3 } = f.ids;
    const p = await plan(f, edited(await f.download(), [{ id: a1, set: { locality: "X" } }, { id: a2, set: { locality: "Y" } }, { id: a3, set: { locality: "X" } }]));
    const held = heldOf(p, "rows_disagree");
    expect(held).toHaveLength(1);
    expect(held[0]!.cells).toEqual([
      { column: "locality", was: "Corvallis", fileSays: "X", rows: [2, 4], moreRows: 0 },
      { column: "locality", was: "Corvallis", fileSays: "Y", rows: [3], moreRows: 0 },
    ]);
  });
});

describe("a row for a specimen Beeline does not have", () => {
  it("is held with no specimen to link to, and its id in the detail", async () => {
    const f = await sharedUploadFixture();
    const p = await plan(f, edited(await f.download(), [{ id: f.ids.a1, set: { specimenId: "987654" } }]));
    expect(heldOf(p, "no_specimen").map((h) => [h.specimenId, h.detail])).toEqual([[null, "987654"]]);
  });
});

describeInOrder("the reasons", () => {
  it("every reason a plan can hold for was produced by a test in this file", () => {
    // A partial run (one test by name) has not produced them all.
    if (seen.size < 10) return;
    // The drafts' own reasons are produced by test/volunteer-uploads.test.ts, which plans as a volunteer.
    expect([...HOLD_REASONS].filter((r) => !seen.has(r) && !DRAFT_HOLDS.includes(r))).toEqual([]);
  });
});

describe("coordinates: the bounds of the store's column, and Beeline's own small numbers", () => {
  it("holds an uncertainty past what a 32-bit INTEGER column holds", async () => {
    const f = await sharedUploadFixture();
    const download = await f.download();
    const unc = (value: TestCell) => plan(f, edited(download, onSample(f, { coordinateUncertaintyInMeters: value })));
    expect(summary(await unc("2147483647"))).toEqual([["coordinates", "coordinateUncertaintyInMeters"]]);
    const over = await unc("2147483648");
    expect(heldOf(over, "uncertainty_invalid")).toHaveLength(3);
    expect(over.sampleDifferences).toEqual([]);
    expect(heldOf(await unc("99999999999"), "uncertainty_invalid")).toHaveLength(3);
  });

  it("reads Beeline's own number 1e-7 as a number, so a point there is a number and not a text", async () => {
    const f = await uploadFixture();
    await f.conn.run(`UPDATE sample_location SET latitude = 0.0000001 WHERE sample_id = ${f.ids.sampleA}`);
    const download = await f.download();
    expect(matrixOf(download)[1]![matrixOf(download)[0]!.indexOf("decimalLatitude")]).toBe("1e-7");
    nothingDiffers(await plan(f, download));
    // The same number as a person or a spreadsheet writes it.
    nothingDiffers(await plan(f, edited(download, onSample(f, { decimalLatitude: "0.0000001" }))));
    nothingDiffers(await plan(f, edited(download, onSample(f, { decimalLatitude: { number: "1E-07" } }))));
    // A difference carries Beeline's own cells as numbers.
    const p = await plan(f, edited(download, onSample(f, { decimalLongitude: "-122" })));
    const cells = p.sampleDifferences[0]!.cells;
    expect(cells.find((c) => c.column === "decimalLatitude")).toMatchObject({ was: "1e-7", differs: false, value: { kind: "number", number: 1e-7 } });
    expect(cells.find((c) => c.column === "decimalLongitude")).toMatchObject({ differs: true, value: { kind: "number", number: -122 } });
    // And moving it is seen.
    expect(summary(await plan(f, edited(download, onSample(f, { decimalLatitude: "0.0000002" }))))).toEqual([["coordinates", "decimalLatitude"]]);
  });
});

describe("a sample of many rows names a few of them", () => {
  it("names the first ROWS_NAMED rows of a group and counts the rest", async () => {
    const f = await uploadFixture();
    await f.conn.run(`INSERT INTO specimen (sample_id, specimen_number) SELECT ${f.ids.sampleA}, 100 + i FROM range(0, 1500) t(i)`);
    const download = await f.download();
    // One row of the sample's 1,503 edited and the rest left alone: they disagree.
    const p = await plan(f, edited(download, [{ id: f.ids.a1, set: { locality: "Elsewhere" } }]));
    const held = heldOf(p, "rows_disagree");
    expect(held).toHaveLength(1);
    expect(held[0]!.rows).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(held[0]!.moreRows).toBe(1503 - 10);
    expect(held[0]!.cells.map((c) => [c.fileSays, c.rows!.length, c.moreRows])).toEqual([
      ["Elsewhere", 1, 0],
      ["Corvallis", 10, 1492],
    ]);
  });
});
