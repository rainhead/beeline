import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { HELD_COLUMNS, loadDispositions } from "../src/load-dispositions.js";
import { CURRENT_SEASON, createMemoryDb, currentSeasonDate, insertCleanSample, rows } from "./helpers.js";

/**
 * A staff inventory's remarks onto specimens (beeline-fud5). The remark texts
 * are the ones Andony's 2025 file uses, on fictional people and numbers; the
 * shapes are the file's: a record the inventory found wanting, a bee the old
 * system printed under two numbers, two rows on one number, a number Beeline
 * does not hold.
 */

let conn: DuckDBConnection;
let dir: string;

const LOST = "LOST SPECIMEN: No specimen in complete OR inventory and no metadata match found in other records. Metadata cannot be reconciled to physical specimen.";
const PHANTOM = "PHANTOM RECORD: Metadata for fieldNumber 25000103 duplicates fieldNumber 25000102. No specimen in complete OR inventory. Retire original fieldNumber and consolidate to matched fieldNumber.";
const PRINT = "PRINT REQUIRED: Generate label for unprinted master record.";
const PRINTED = "PRINTED: present in BC Ecdysis (BC taxonomist check, Oct 26, 2026)";
const RECONSTRUCTED = "METADATA RECONSTRUCTED on 2026-09-22 14:00:26: Specimen metadata recovered from archived occurrence records (file name: old.xlsx).";

const COLUMNS = ["fieldNumber", "dateLabelPrint", "recordedBy", "sampleId", "specimenId", "day", "month", "year", "occurrenceRemarks"];
type Row = Partial<Record<(typeof COLUMNS)[number], string>>;

const csv = (rowsIn: Row[]) =>
  [COLUMNS.join(","), ...rowsIn.map((r) => COLUMNS.map((c) => `"${(r[c] ?? "").replaceAll('"', '""')}"`).join(","))].join("\n");

async function file(name: string, rowsIn: Row[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `${csv(rowsIn)}\n`);
  return path;
}

/** Ada's sample of 14 July this season: three specimens, numbered 25000101 to 25000103. */
async function adaSample(): Promise<number> {
  const sample = await insertCleanSample(conn, { sample_number: "'2'" });
  await conn.run(
    `INSERT INTO specimen (sample_id, specimen_number, field_number)
     VALUES (${sample}, 1, '25000101'), (${sample}, 2, '25000102'), (${sample}, 3, '25000103')`,
  );
  return sample;
}

const ada = (specimen: string, more: Row = {}): Row => ({
  recordedBy: "Ada Collector",
  sampleId: "2",
  specimenId: specimen,
  day: "14",
  month: "7",
  year: String(Number(currentSeasonDate(7, 14).slice(0, 4))),
  ...more,
});

/** A print date in the fixture's own season, as the old system wrote dates: m/d/yy. */
const printed = (month: number, day: number) => `${month}/${day}/${String(CURRENT_SEASON).slice(2)}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const spelled = (month: number, day: number) => `${day} ${MONTHS[month - 1]} ${CURRENT_SEASON}`;

const load = (path: string, more: Partial<Parameters<typeof loadDispositions>[1]> = {}) =>
  loadDispositions(conn, { file: path, statedBy: "Inez Inventory", statedOn: "2026-11-03", ...more });

const stored = () =>
  rows(conn, `SELECT sp.field_number, d.disposition, d.remarks FROM specimen_disposition d JOIN specimen sp ON sp.entity_id = d.specimen_id ORDER BY 1`);

const heldRows = async (path: string) => {
  const text = await readFile(`${path}.held.csv`, "utf8");
  const [header, ...lines] = text.trim().split("\n");
  expect(header).toBe(HELD_COLUMNS.join(","));
  return lines;
};

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector')`);
  dir = await mkdtemp(join(tmpdir(), "dispositions-"));
});

describe("a remark on a row whose number is a specimen", () => {
  test("is kept as written, with the disposition its kind says", async () => {
    await adaSample();
    const path = await file("inventory.csv", [
      ada("1", { fieldNumber: "25000101", occurrenceRemarks: LOST }),
      ada("2", { fieldNumber: "25000102", occurrenceRemarks: PRINTED }),
      ada("3", { fieldNumber: "25000103", occurrenceRemarks: PRINT }),
    ]);
    const result = await load(path);
    expect(result.specimens).toEqual({ written: 3, inserted: 3, updated: 0, unchanged: 0 });
    expect(await stored()).toEqual([
      ["25000101", "missing", LOST],
      ["25000102", "in collection", PRINTED],
      ["25000103", null, PRINT],
    ]);
    expect(await rows(conn, `SELECT DISTINCT stated_by, stated_on, source FROM specimen_disposition`)).toEqual([
      ["Inez Inventory", expect.anything(), "inventory.csv"],
    ]);
    expect(result.byKind.map((k) => k.kind).sort()).toEqual(["LOST SPECIMEN", "PRINT REQUIRED", "PRINTED"]);
    expect(await heldRows(path)).toEqual([]);
  });

  test("a row with no remark says nothing", async () => {
    await adaSample();
    const path = await file("inventory.csv", [ada("1", { fieldNumber: "25000101" }), ada("2", { fieldNumber: "25000102", occurrenceRemarks: PHANTOM })]);
    const result = await load(path);
    expect(result.rows).toBe(2);
    expect(result.remarked).toBe(1);
    expect(await stored()).toEqual([["25000102", "missing", PHANTOM]]);
  });

  test("a reconstruction is a remark about the record, not the pin", async () => {
    await adaSample();
    const path = await file("inventory.csv", [ada("1", { fieldNumber: "25000101", occurrenceRemarks: RECONSTRUCTED })]);
    await load(path);
    expect(await stored()).toEqual([["25000101", null, RECONSTRUCTED]]);
  });
});

describe("a lost record whose bee stands under another number", () => {
  test("becomes a surplus label on the specimen the pin carries", async () => {
    await adaSample();
    const path = await file("inventory.csv", [
      ada("1", { fieldNumber: "25000101", dateLabelPrint: printed(8, 4) }),
      // The same bee, printed again three weeks later under a number no pin carries.
      ada("1", { fieldNumber: "25001375", dateLabelPrint: printed(8, 25), occurrenceRemarks: LOST }),
    ]);
    const result = await load(path);
    expect(result.surplusLabels).toBe(1);
    expect(result.held.no_specimen).toBe(0);
    expect(await stored()).toEqual([
      [
        "25000101",
        "in collection",
        `Another label numbered 25001375 was printed for this specimen on ${spelled(8, 25)}; no pin carries it, and the number is retired.`,
      ],
    ]);
  });

  test("a print date before the bee was collected is not repeated, and a third label is a second sentence", async () => {
    await adaSample();
    const path = await file("inventory.csv", [
      ada("1", { fieldNumber: "25000101", dateLabelPrint: printed(8, 4) }),
      // The old system's placeholder date, years before the bee was caught.
      ada("1", { fieldNumber: "25001375", dateLabelPrint: "8/25/17", occurrenceRemarks: LOST }),
      ada("1", { fieldNumber: "25001376", dateLabelPrint: `4-Nov-${String(CURRENT_SEASON).slice(2)}`, occurrenceRemarks: LOST }),
    ]);
    await load(path);
    expect(await stored()).toEqual([
      [
        "25000101",
        "in collection",
        "Another label numbered 25001375 was printed for this specimen; no pin carries it, and the number is retired. " +
          `Another label numbered 25001376 was printed for this specimen on ${spelled(11, 4)}; no pin carries it, and the number is retired.`,
      ],
    ]);
  });

  test("on a specimen the inventory also called lost, both are said and the pin stays missing", async () => {
    await adaSample();
    const path = await file("inventory.csv", [
      ada("1", { fieldNumber: "25000101", dateLabelPrint: printed(8, 4), occurrenceRemarks: LOST }),
      ada("1", { fieldNumber: "25001375", dateLabelPrint: printed(8, 25), occurrenceRemarks: LOST }),
    ]);
    await load(path);
    expect(await stored()).toEqual([
      [
        "25000101",
        "missing",
        `${LOST} Another label numbered 25001375 was printed for this specimen on ${spelled(8, 25)}; no pin carries it, and the number is retired.`,
      ],
    ]);
  });
});

describe("what is held", () => {
  test("a number no specimen carries and no twin explains, and a found pin under a number Beeline lacks", async () => {
    await adaSample();
    const path = await file("inventory.csv", [
      // Nothing in the store, no twin.
      { fieldNumber: "25009999", recordedBy: "Nobody Known", sampleId: "1", specimenId: "1", day: "1", month: "6", year: "2025", occurrenceRemarks: LOST },
      // The inventory found a pin numbered 25001375; Beeline holds the bee as 25000101.
      ada("1", { fieldNumber: "25000101" }),
      ada("1", { fieldNumber: "25001375" }),
      // A found row on no specimen with nothing to say is not worth listing.
      { fieldNumber: "25008888" },
      // A lost row with no number of its own names no label: held, never a
      // surplus label with a blank number on its twin.
      ada("1", { occurrenceRemarks: LOST }),
    ]);
    const result = await load(path);
    expect(result.held).toEqual({ no_specimen: 2, number_unknown: 1, ambiguous_number: 0, ambiguous_twin: 0, conflicting_remarks: 0 });
    expect(await stored()).toEqual([]);
    const held = await heldRows(path);
    expect(held).toHaveLength(3);
    expect(held[0]).toContain("25009999,LOST SPECIMEN,no_specimen,");
    expect(held[1]).toBe("3,25001375,,number_unknown,");
    expect(held[2]).toContain("5,,LOST SPECIMEN,no_specimen,");
  });

  test("two rows remarking differently on one specimen, and a number two specimens carry", async () => {
    const sample = await adaSample();
    const other = await insertCleanSample(conn, { sample_number: "'3'" });
    // The old system's reissued number: two specimens, one field number.
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${other}, 1, '25000103')`);
    const path = await file("inventory.csv", [
      ada("1", { fieldNumber: "25000101", occurrenceRemarks: LOST }),
      ada("1", { fieldNumber: "25000101", occurrenceRemarks: PRINT }),
      ada("3", { fieldNumber: "25000103", occurrenceRemarks: PHANTOM }),
    ]);
    const result = await load(path);
    expect(result.held.conflicting_remarks).toBe(2);
    expect(result.held.ambiguous_number).toBe(1);
    expect(await stored()).toEqual([]);
    expect(sample).toBeGreaterThan(0);
  });

  test("two rows saying the same thing about one specimen are one remark", async () => {
    await adaSample();
    const path = await file("inventory.csv", [
      ada("1", { fieldNumber: "25000101", occurrenceRemarks: PRINT }),
      ada("1", { fieldNumber: "25000101", occurrenceRemarks: PRINT }),
    ]);
    const result = await load(path);
    expect(result.specimens.written).toBe(1);
    expect(result.held.conflicting_remarks).toBe(0);
  });
});

describe("loading again", () => {
  test("changes nothing the store already says, and replaces what the file now says differently", async () => {
    await adaSample();
    const first = await file("inventory.csv", [
      ada("1", { fieldNumber: "25000101", occurrenceRemarks: LOST }),
      ada("2", { fieldNumber: "25000102", occurrenceRemarks: PRINT }),
    ]);
    await load(first);
    expect((await load(first)).specimens).toEqual({ written: 2, inserted: 0, updated: 0, unchanged: 2 });
    const second = await file("inventory-2.csv", [
      ada("1", { fieldNumber: "25000101", occurrenceRemarks: LOST }),
      ada("2", { fieldNumber: "25000102", occurrenceRemarks: PRINTED }),
    ]);
    const result = await load(second, { statedOn: "2026-12-01" });
    expect(result.specimens).toEqual({ written: 2, inserted: 0, updated: 1, unchanged: 1 });
    expect(await stored()).toEqual([
      ["25000101", "missing", LOST],
      ["25000102", "in collection", PRINTED],
    ]);
    expect(await rows(conn, `SELECT source FROM specimen_disposition d JOIN specimen sp ON sp.entity_id = d.specimen_id ORDER BY sp.field_number`)).toEqual([
      ["inventory.csv"],
      ["inventory-2.csv"],
    ]);
  });

  test("a dry run writes nothing and still says what it would do", async () => {
    await adaSample();
    const path = await file("inventory.csv", [ada("1", { fieldNumber: "25000101", occurrenceRemarks: LOST })]);
    const result = await load(path, { dryRun: true });
    expect(result.specimens.inserted).toBe(1);
    expect(await stored()).toEqual([]);
  });

  test("refuses a file without the remark column, and a load with no author or date", async () => {
    await adaSample();
    const bare = join(dir, "bare.csv");
    await writeFile(bare, "fieldNumber\n25000101\n");
    await expect(load(bare)).rejects.toThrow("no occurrenceRemarks column");
    const path = await file("inventory.csv", [ada("1", { fieldNumber: "25000101", occurrenceRemarks: LOST })]);
    await expect(load(path, { statedBy: " " })).rejects.toThrow("--by");
    await expect(load(path, { statedOn: "3 Nov 2026" })).rejects.toThrow("--on");
  });
});
