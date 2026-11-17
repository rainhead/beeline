import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_ROWS,
  parseCsvRecords,
  planUpload,
  type HeldItem,
  type UploadPlan,
} from "../src/app/upload-plan.js";
import { csvLine } from "../src/app/listings.js";
import { CURRENT_SEASON, SETTLED_SEASON } from "./helpers.js";
import { bytesOf, edited, readRecords, uploadFixture, type UploadFixture } from "./upload-fixture.js";

/** The plan for a file's text; a refusal fails the test. */
async function plan(f: UploadFixture, text: string): Promise<UploadPlan> {
  const result = await planUpload(f.db, bytesOf(text));
  if (!result.ok) throw new Error(`refused: ${result.refusal}`);
  return result.plan;
}

const refusal = async (f: UploadFixture, bytes: Uint8Array) => {
  const result = await planUpload(f.db, bytes);
  return result.ok ? null : result.refusal;
};

const heldOf = (p: UploadPlan, reason: string): HeldItem[] => p.held.filter((h) => h.reason === reason);
const nothingDiffers = (p: UploadPlan) => {
  expect(p.changes).toEqual([]);
  expect(p.sampleChanges).toEqual([]);
  expect(p.notApplied).toEqual([]);
  expect(p.held).toEqual([]);
};
const differing = (c: { cells: Array<{ column: string; differs: boolean }> }) => c.cells.filter((x) => x.differs).map((x) => x.column);

const DAY_A = `${CURRENT_SEASON}-07-14`;

/** Every data row of a download passed through `change`, written as a spreadsheet would. */
const rewritten = (download: string, change: (row: Record<string, string>) => Record<string, string>, ending = "\n") => {
  const [head, ...body] = readRecords(download);
  return [head!, ...body.map((r) => {
    const named = Object.fromEntries(head!.map((h, i) => [h, r[i]!]));
    const out = change(named);
    return head!.map((h) => out[h]!);
  })]
    .map((r) => csvLine(r).replace("\n", ending))
    .join("");
};
const mdy = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8))}/${iso.slice(0, 4)}` : iso);

describe("reading an uploaded file", () => {
  it("reads RFC 4180: quoted cells, doubled quotes, a newline inside quotes, any line ending", () => {
    expect(parseCsvRecords('a,b,c\n1,"x,y","say ""hi"""\r\n2,"two\nlines",\r\n')).toEqual([
      ["a", "b", "c"],
      ["1", "x,y", 'say "hi"'],
      ["2", "two\nlines", ""],
    ]);
    // No final newline, and a blank last cell.
    expect(parseCsvRecords("a,b\n1,")).toEqual([["a", "b"], ["1", ""]]);
    // A lone carriage return, as old Mac spreadsheets write.
    expect(parseCsvRecords("a,b\r1,2\r3,4\r")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });
});

describe("refusing a whole file", () => {
  it("refuses a file that cannot be read, and names why", async () => {
    const f = await uploadFixture();
    expect(await refusal(f, new Uint8Array(MAX_FILE_BYTES + 1))).toBe("too_large");
    expect(await refusal(f, Uint8Array.from([0x73, 0x70, 0xff, 0xfe, 0x0a]))).toBe("not_utf8");
    expect(await refusal(f, bytesOf("fieldNumber,locality\nOBA1,Corvallis\n"))).toBe("no_specimen_id_column");
    expect(await refusal(f, bytesOf("specimenId,locality\n"))).toBe("no_rows");
    expect(await refusal(f, bytesOf(""))).toBe("no_specimen_id_column");
    expect(await refusal(f, bytesOf(`specimenId\n${"1\n".repeat(MAX_ROWS + 1)}`))).toBe("too_many_rows");
    // The limit itself is a file.
    expect(await refusal(f, bytesOf(`specimenId\n${"1\n".repeat(MAX_ROWS)}`))).toBeNull();
  });

  it("refuses a file with a column twice, and says which", async () => {
    const f = await uploadFixture();
    const result = await planUpload(f.db, bytesOf("specimenId,locality,locality\n1,a,b\n"));
    expect(result).toEqual({ ok: false, refusal: "repeated_column", detail: "locality" });
    // Spaces round a name do not make it another column.
    expect(await refusal(f, bytesOf("specimenId, specimenId\n1,1\n"))).toBe("repeated_column");
  });
});

describe("a file nobody has edited", () => {
  it("compares as no differences at all, however a spreadsheet wrote it", async () => {
    const f = await uploadFixture();
    const download = await f.download();
    const unedited = await plan(f, download);
    nothingDiffers(unedited);
    expect(unedited.counts.rows).toEqual({ active: 3, settled: 1, unplaced: 0 });
    expect(unedited.counts.unchanged).toEqual({ active: 3, settled: 1, unplaced: 0 });
    expect(unedited.counts.withChanges).toEqual({ active: 0, settled: 0, unplaced: 0 });
    expect(unedited.counts.held).toEqual({ active: 0, settled: 0, unplaced: 0 });

    // Rewritten with carriage returns and a byte order mark, as Excel does, or with lone ones.
    nothingDiffers(await plan(f, edited(download, [], { lineEnding: "\r\n" })));
    nothingDiffers(await plan(f, edited(download).replaceAll("\n", "\r")));
    // Columns the file leaves out are never a difference, nor are ones it adds.
    nothingDiffers(await plan(f, edited(download, [], { dropColumns: ["locality", "scientificName", "sex", "caste"] })));
    nothingDiffers(await plan(f, readRecords(download).map((r, i) => csvLine([...r, i === 0 ? "myNotes" : "see me"])).join("")));
  });

  it("finds columns by name in any order", async () => {
    const f = await uploadFixture();
    const records = readRecords(await f.download());
    nothingDiffers(await plan(f, records.map((r) => csvLine([...r].reverse())).join("")));
  });

  it("is not a difference when a spreadsheet rewrites every row: TRUE for true, M/D/YYYY for dates, composed or decomposed names", async () => {
    const f = await uploadFixture();
    await f.conn.run(`UPDATE determination SET determiner_name = 'José Determiner' WHERE specimen_id = ${f.ids.a1}`);
    const download = await f.download();
    expect(download).toContain("true");
    const text = rewritten(download, (r) => ({
      ...r,
      identifiedByExpert: r.identifiedByExpert!.toUpperCase(),
      eventDate: mdy(r.eventDate!),
      dateIdentified: mdy(r.dateIdentified!),
      // Decomposed, and with a non-breaking space where the name has a plain one.
      identifiedBy: r.identifiedBy!.normalize("NFD").replace(" ", " "),
      locality: ` ${r.locality!} `,
    }));
    expect(text).not.toBe(download);
    nothingDiffers(await plan(f, text));
  });
});

describe("a cell the file does not reach", () => {
  it("is a column that row lacks, not a blank", async () => {
    const f = await uploadFixture();
    const records = readRecords(await f.download()).map((r) => [...r].reverse());
    const head = records[0]!;
    expect(head[0]).toBe("sampleVersion");
    // The row of a1 stops after its keys: it has no locality, name or anything else to disagree about.
    const text = records.map((r, i) => csvLine(i === 2 ? r.slice(0, head.indexOf("specimenId") + 1) : r)).join("");
    const p = await plan(f, text);
    nothingDiffers(p);
    expect(p.counts.unchanged.active).toBe(3);
  });
});

describe("a short row, and a file that is not whole", () => {
  it("builds a unit from the columns its rows reach, not the ones the header has", async () => {
    const f = await uploadFixture();
    const { a1, a2, a3 } = f.ids;
    const records = readRecords(await f.download());
    const head = records[0]!;
    const at = (name: string) => head.indexOf(name);
    const rowOf = (id: number) => records.find((r, i) => i > 0 && r[at("specimenId")] === String(id))!;
    // Exactly this header, its rows stopping after the edited eventDate: no row has a samplingProtocol cell.
    const sample = ["specimenId,sampleVersion,eventDate,samplingProtocol", ...[a1, a2, a3].map((id) => `${id},${rowOf(id)[at("sampleVersion")]},2026-01-01`)].join("\n") + "\n";
    const p = await plan(f, sample);
    expect(p.held).toEqual([]);
    expect(p.sampleChanges.map((c) => [c.unit, c.cells.map((x) => x.column)])).toEqual([["method_dates", ["eventDate"]]]);
    // The same for a specimen's own unit.
    const own = `specimenId,specimenVersion,scientificName,dateIdentified\n${a2},${rowOf(a2)[at("specimenVersion")]},Bombus\n`;
    const q = await plan(f, own);
    expect(q.held).toEqual([]);
    expect(q.changes.map((c) => [c.unit, c.cells.map((x) => x.column)])).toEqual([["determination", ["scientificName"]]]);
  });

  it("refuses a file whose quotation mark never closes, rather than reading the rows after it as one cell", async () => {
    const f = await uploadFixture();
    expect(await refusal(f, bytesOf('specimenId,occurrenceRemarks\n1,"a remark that never ends\n2,fine\n3,fine\n'))).toBe("malformed");
    // A quote that does close, with a newline in it, is a cell.
    expect(await refusal(f, bytesOf('specimenId,occurrenceRemarks\n1,"two\nlines"\n'))).toBeNull();
  });
});

describe("finding each row's specimen", () => {
  it("holds a row whose id is not a positive whole number, with the reason", async () => {
    const f = await uploadFixture();
    const { a1, a2 } = f.ids;
    const text = edited(await f.download(), [
      { id: a1, set: { specimenId: "" } },
      { id: a2, set: { specimenId: "abc" } },
    ]);
    const p = await plan(f, text);
    expect(heldOf(p, "no_id").map((h) => h.detail)).toEqual(["", "abc"]);
    expect(p.counts.held.unplaced).toBe(2);
    expect(p.counts.rows).toEqual({ active: 1, settled: 1, unplaced: 2 });
  });

  it("holds every row of a specimen that is named twice", async () => {
    const f = await uploadFixture();
    const { a1, a2 } = f.ids;
    const text = edited(await f.download(), [{ id: a2, set: { specimenId: String(a1) } }]);
    const p = await plan(f, text);
    expect(heldOf(p, "repeated").map((h) => h.row)).toEqual([2, 3]);
    // The repeated specimen is known, so its rows have a season.
    expect(p.counts.held.active).toBe(2);
  });

  it("holds a row naming a specimen that does not exist, and compares nothing in it", async () => {
    const f = await uploadFixture();
    const p = await plan(f, edited(await f.download(), [{ id: f.ids.a1, set: { specimenId: "987654", locality: "Elsewhere" } }]));
    expect(heldOf(p, "no_specimen")).toHaveLength(1);
    expect(p.changes).toEqual([]);
    expect(p.sampleChanges).toEqual([]);
  });

  it("holds a row whose field number is not the specimen's, and lets a blank cell agree with no number", async () => {
    const f = await uploadFixture();
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
    expect(p.sampleChanges).toEqual([]);
    // A file with no field number column is not held for it.
    nothingDiffers(await plan(f, edited(download, [], { dropColumns: ["fieldNumber"] })));
  });

  it("takes a field number whose leading zeros a spreadsheet dropped for the same number", async () => {
    const f = await uploadFixture();
    const { a1, a2 } = f.ids;
    await f.conn.run(`UPDATE specimen SET field_number = '00012345' WHERE entity_id = ${a1}`);
    const download = await f.download();
    nothingDiffers(await plan(f, edited(download, [{ id: a1, set: { fieldNumber: "12345" } }])));
    const wrong = await plan(f, edited(download, [{ id: a1, set: { fieldNumber: "12346" } }]));
    expect(heldOf(wrong, "number_disagrees")).toHaveLength(1);
    // Only when both are all digits: a letter is part of the number.
    const letters = await plan(f, edited(download, [{ id: a2, set: { fieldNumber: "OBA0002" } }]));
    expect(heldOf(letters, "number_disagrees")).toHaveLength(1);
  });
});

describe("normalising both sides before comparing", () => {
  it("takes a spreadsheet's rewriting of a cell for no change", async () => {
    const f = await uploadFixture();
    const { a1, a2 } = f.ids;
    // A determiner whose name starts like a formula is written with a quote in front.
    await f.conn.run(`UPDATE determination SET determiner_name = '-Dee Determiner' WHERE specimen_id = ${a1}`);
    const download = await f.download();
    expect(download).toContain("'-Dee Determiner");
    const text = edited(download, [
      {
        id: a1,
        set: {
          eventDate: mdy(DAY_A),
          decimalLatitude: "44.564600",
          decimalLongitude: "'-123.2620",
          coordinateUncertaintyInMeters: "30.0",
          locality: "  Corvallis  ",
          sex: "FEMALE",
          dateIdentified: "5/3/2024",
          samplingProtocol: "net ",
        },
      },
      // A single day written as a range of one.
      { id: a2, set: { eventDate: `${DAY_A}/${DAY_A}` } },
    ]);
    nothingDiffers(await plan(f, text));
  });

  it("is case-blind for sex, identification qualifier, caste and the expert flag, and for nothing else", async () => {
    const f = await uploadFixture();
    const p = await plan(
      f,
      edited(await f.download(), [{ id: f.ids.a1, set: { sex: "Female", scientificName: "BOMBUS VOSNESENSKII", identifiedByExpert: "TRUE" } }]),
    );
    expect(p.changes.map((c) => [c.unit, differing(c)])).toEqual([["determination", ["scientificName"]]]);
    expect(p.notApplied).toEqual([]);
  });

  it("compares a number within 1e-9, and not beyond", async () => {
    const f = await uploadFixture();
    const { a1, a2, a3 } = f.ids;
    const download = await f.download();
    const all = (value: string) => [a1, a2, a3].map((id) => ({ id, set: { decimalLatitude: value } }));
    nothingDiffers(await plan(f, edited(download, all("44.5646000000001"))));
    const moved = await plan(f, edited(download, all("44.564600002")));
    expect(moved.sampleChanges.map((c) => [c.unit, differing(c)])).toEqual([["coordinates", ["decimalLatitude"]]]);
  });

  it("holds a cell that is not a number or not a date, and the rest of its unit with it", async () => {
    const f = await uploadFixture();
    const { a1, a2, a3, b1 } = f.ids;
    const p = await plan(
      f,
      edited(await f.download(), [
        { id: a1, set: { decimalLatitude: "forty-four", eventDate: "July 14", dateIdentified: "garbage", scientificName: "Bombus", sex: "male" } },
        ...[a1, a2, a3].map((id) => ({ id, set: { locality: "Elsewhere" } })),
        { id: b1, set: { coordinateUncertaintyInMeters: "30m", decimalLongitude: "-122" } },
      ]),
    );
    expect(heldOf(p, "number_unreadable").map((h) => [h.unit, h.column, h.detail])).toEqual([
      ["coordinates", "decimalLatitude", "forty-four"],
      ["coordinates", "coordinateUncertaintyInMeters", "30m"],
    ]);
    expect(heldOf(p, "date_unreadable").map((h) => [h.unit, h.column, h.detail])).toEqual([
      ["determination", "dateIdentified", "garbage"],
      ["method_dates", "eventDate", "July 14"],
    ]);
    // The new name and sex are held with the date, whole: no determination is offered.
    expect(p.changes).toEqual([]);
    // Nothing of the sample's coordinates is offered either, though b1's longitude was edited too.
    expect(p.sampleChanges.map((c) => c.unit)).toEqual(["place"]);
    expect(p.counts.withChanges).toEqual({ active: 3, settled: 1, unplaced: 0 });
  });

  it("holds a sample's unit whole when one of its rows has an unreadable cell", async () => {
    const f = await uploadFixture();
    const { a1, a2, a3 } = f.ids;
    const p = await plan(
      f,
      edited(await f.download(), [
        ...[a1, a3].map((id) => ({ id, set: { samplingProtocol: "blue vane trap" } })),
        { id: a2, set: { eventDate: "July 14", samplingProtocol: "blue vane trap" } },
      ]),
    );
    expect(heldOf(p, "date_unreadable").map((h) => [h.row, h.sampleNumber])).toEqual([[3, "UP-1"]]);
    expect(p.sampleChanges).toEqual([]);
    expect(heldOf(p, "rows_disagree")).toEqual([]);
  });

  it("reads a date identified as a year, a month or a day, and month forms a spreadsheet writes", async () => {
    const f = await uploadFixture();
    const { a1, a3 } = f.ids;
    // a3 is known to the month only.
    await f.conn.run(`UPDATE determination SET determined_on_precision = 'month' WHERE specimen_id = ${a3}`);
    const download = await f.download();
    const read = async (id: number, value: string) => plan(f, edited(download, [{ id, set: { dateIdentified: value } }]));
    // a1: the day 2024-05-03.
    expect((await read(a1, "2024-05-03")).changes).toEqual([]);
    expect((await read(a1, "5/3/2024")).changes).toEqual([]);
    expect((await read(a1, "2024-05")).changes.map((c) => c.cells.find((x) => x.differs)!.fileSays)).toEqual(["2024-05"]);
    expect((await read(a1, "2024")).changes.map((c) => c.cells.find((x) => x.differs)!.fileSays)).toEqual(["2024"]);
    expect(heldOf(await read(a1, "2/30/2024"), "date_unreadable")).toHaveLength(1);
    expect(heldOf(await read(a1, "2024-13"), "date_unreadable")).toHaveLength(1);
    // a3: the month 2024-05, which a spreadsheet writes in several ways.
    for (const form of ["2024-05", "May-2024", "May 2024", "May-24", "may 2024"]) {
      expect(nothingDiffers(await read(a3, form)), form).toBeUndefined();
    }
    // A two-digit year counts only where it is what Beeline says.
    expect(heldOf(await read(a3, "May-25"), "date_unreadable")).toHaveLength(1);
    // A named month Beeline does not say is a change, read as that month.
    expect((await read(a3, "June 2024")).changes.map((c) => c.cells.find((x) => x.differs)!.fileSays)).toEqual(["June 2024"]);
  });

  it("reads a slash date either way round, and holds one that could be either and is neither", async () => {
    const f = await uploadFixture();
    const { b1 } = f.ids;
    const y = SETTLED_SEASON;
    const download = await f.download();
    const read = (value: string) => plan(f, edited(download, [{ id: b1, set: { eventDate: value } }]));
    // The settled sample is 2 June: 6/2 month first and 2/6 day first are both that day.
    nothingDiffers(await read(`6/2/${y}`));
    nothingDiffers(await read(`2/6/${y}`));
    // 3/4 is 4 March or 3 April; neither is 2 June.
    const ambiguous = await read(`3/4/${y}`);
    expect(heldOf(ambiguous, "date_ambiguous").map((h) => [h.unit, h.detail])).toEqual([["method_dates", `3/4/${y}`]]);
    expect(ambiguous.sampleChanges).toEqual([]);
    // 13/4 can only be 13 April.
    const day = await read(`13/4/${y}`);
    expect(day.held).toEqual([]);
    expect(day.sampleChanges.map((c) => c.cells.find((x) => x.differs)!.fileSays)).toEqual([`13/4/${y}`]);
    // 3/3 is one day either way, so it is not ambiguous.
    expect(heldOf(await read(`3/3/${y}`), "date_ambiguous")).toEqual([]);
    // A range of days, each read the same way.
    nothingDiffers(await read(`6/2/${y}/6/2/${y}`));
  });

  it("holds a blank cell where Beeline has a value and cannot lack one", async () => {
    const f = await uploadFixture();
    const { a1, a2, a3 } = f.ids;
    const p = await plan(
      f,
      edited(await f.download(), [
        { id: a1, set: { scientificName: "" } },
        // a2 has no name, so a blank is what Beeline says.
        { id: a2, set: { scientificName: "" } },
        ...[a1, a2, a3].map((id) => ({ id, set: { eventDate: "" } })),
      ]),
    );
    expect(heldOf(p, "cannot_be_blank").map((h) => [h.row, h.unit, h.column])).toEqual([
      [2, "determination", "scientificName"],
      [2, "method_dates", "eventDate"],
      [3, "method_dates", "eventDate"],
      [4, "method_dates", "eventDate"],
    ]);
    expect(p.changes).toEqual([]);
    expect(p.sampleChanges).toEqual([]);
  });
});

describe("a held unit names every cell held with it", () => {
  it("lists, for a specimen, the differing cells of the unit with what the file says", async () => {
    const f = await uploadFixture();
    const p = await plan(f, edited(await f.download(), [{ id: f.ids.a1, set: { scientificName: "Bombus", sex: "male", dateIdentified: "garbage" } }]));
    expect(p.changes).toEqual([]);
    const held = heldOf(p, "date_unreadable");
    expect(held).toHaveLength(1);
    expect(held[0]!.column).toBe("dateIdentified");
    expect(held[0]!.cells).toEqual([
      { column: "scientificName", was: "Bombus vosnesenskii", fileSays: "Bombus" },
      { column: "sex", was: "female", fileSays: "male" },
      { column: "dateIdentified", was: "2024-05-03", fileSays: "garbage" },
    ]);
    expect(held[0]!.columns).toEqual(["scientificName", "sex", "dateIdentified"]);
  });

  it("lists, for a sample, the differing cells of the unit across its rows", async () => {
    const f = await uploadFixture();
    const { a1, a2, a3 } = f.ids;
    const p = await plan(
      f,
      edited(await f.download(), [
        ...[a1, a2, a3].map((id) => ({ id, set: { samplingProtocol: "blue vane trap" } })),
        { id: a2, set: { eventDate: "July 14" } },
      ]),
    );
    const held = heldOf(p, "date_unreadable");
    expect(held).toHaveLength(1);
    expect(held[0]!.cells).toEqual([
      { column: "eventDate", was: DAY_A, fileSays: "July 14" },
      { column: "samplingProtocol", was: "net", fileSays: "blue vane trap" },
    ]);
    expect(p.sampleChanges).toEqual([]);
  });

  it("names them for a unit held because the file is stale, too", async () => {
    const f = await uploadFixture();
    const { a1 } = f.ids;
    const download = await f.download();
    await f.conn.run(`UPDATE determination SET sex = 'male' WHERE specimen_id = ${a1}`);
    const p = await plan(f, edited(download, [{ id: a1, set: { scientificName: "Andrena" } }]));
    const held = heldOf(p, "specimen_changed_since")[0]!;
    expect(held.cells.map((c) => [c.column, c.fileSays])).toEqual([["scientificName", "Andrena"], ["sex", "female"]]);
  });
});

describe("saying what kind of change each cell is", () => {
  it("offers each unit whole, sorts every differing column into its kind, and leaves the keys out", async () => {
    const f = await uploadFixture();
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
        ...[a1, a2, a3].map((id) => ({
          id,
          set: { samplingProtocol: "blue vane trap", eventDate: "2026-01-01/2026-01-05", locality: "Albany", decimalLongitude: "-122.5" },
        })),
        { id: a2, set: { sampleNumber: "ignored" } },
      ]),
    );
    expect(p.changes.map((c) => [c.unit, c.cells.map((x) => x.column), differing(c)])).toEqual([
      [
        "determination",
        ["scientificName", "identificationQualifier", "sex", "identifiedBy", "dateIdentified", "caste"],
        ["scientificName", "identificationQualifier", "sex", "identifiedBy", "dateIdentified", "caste"],
      ],
      ["disposition", ["disposition", "occurrenceRemarks"], ["disposition", "occurrenceRemarks"]],
    ]);
    expect(p.sampleChanges.map((c) => [c.unit, c.cells.map((x) => x.column), differing(c)])).toEqual([
      ["method_dates", ["eventDate", "samplingProtocol"], ["eventDate", "samplingProtocol"]],
      ["place", ["locality"], ["locality"]],
      ["coordinates", ["decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters"], ["decimalLongitude"]],
    ]);
    expect(p.notApplied.map((c) => c.column).sort()).toEqual(
      [
        "associatedTaxa",
        "catalogNumber",
        "county",
        "hostFamily",
        "identifiedByExpert",
        "minimumElevationInMeters",
        "recordedBy",
        "sampleNumber",
        "scientificNameAuthorship",
        "taxonRank",
      ].sort(),
    );
    // The row's identity is never a difference.
    for (const key of ["specimenId", "specimenVersion", "sampleVersion", "fieldNumber", "determinationId"]) {
      expect([...p.changes.flatMap((c) => c.cells), ...p.sampleChanges.flatMap((c) => c.cells), ...p.notApplied].map((c) => c.column)).not.toContain(key);
    }
    expect(p.held).toEqual([]);
    // What a cell said and what the file says, as text; a blank is "".
    const place = p.sampleChanges.find((c) => c.unit === "place")!.cells[0]!;
    expect([place.was, place.fileSays]).toEqual(["Corvallis", "Albany"]);
    const disposition = p.changes.find((c) => c.unit === "disposition")!;
    expect(disposition).toMatchObject({ specimenId: a1, fieldNumber: "OBA10001", row: 2 });
    expect(disposition.cells[0]).toEqual({ column: "disposition", was: "", fileSays: "missing", differs: true });
  });

  it("offers a latitude only with its longitude, and holds it when the file has no longitude", async () => {
    const f = await uploadFixture();
    const { a1, a2, a3 } = f.ids;
    const download = await f.download();
    const edits = [a1, a2, a3].map((id) => ({ id, set: { decimalLatitude: "44.6" } }));
    const whole = await plan(f, edited(download, edits));
    expect(whole.sampleChanges).toHaveLength(1);
    expect(whole.sampleChanges[0]!.cells).toEqual([
      { column: "decimalLatitude", was: "44.5646", fileSays: "44.6", differs: true },
      { column: "decimalLongitude", was: "-123.262", fileSays: "-123.262", differs: false },
      { column: "coordinateUncertaintyInMeters", was: "30", fileSays: "30", differs: false },
    ]);
    const half = await plan(f, edited(download, edits, { dropColumns: ["decimalLongitude"] }));
    expect(half.sampleChanges).toEqual([]);
    expect(heldOf(half, "column_missing").map((h) => [h.unit, h.detail, h.columns])).toEqual([["coordinates", "decimalLongitude", ["decimalLatitude"]]]);
  });
});

describe("a file edited against something Beeline no longer says", () => {
  it("holds identification changes when another determination is the record by now", async () => {
    const f = await uploadFixture();
    const { a1, a2 } = f.ids;
    const download = await f.download();
    await f.conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_name, verbatim_identification)
       SELECT ${a1}, entity_id, true, 'worksheet_import', 'Newer Determiner', 'Bombus' FROM animal WHERE scientific_name = 'Bombus'`,
    );
    const text = edited(download, [{ id: a1, set: { scientificName: "Andrena", locality: "Elsewhere", disposition: "missing" } }]);
    const p = await plan(f, text);
    // Every differing cell of the file's identification is held with it, not only the one edited.
    expect(heldOf(p, "specimen_changed_since").map((h) => [h.unit, h.column, h.columns])).toEqual([
      ["determination", "scientificName", ["scientificName", "sex", "identifiedBy", "dateIdentified"]],
      // The disposition is read against the same version, so it is held too.
      ["disposition", "disposition", ["disposition"]],
    ]);
    expect(p.changes).toEqual([]);
    // A file with no specimenVersion cannot say what it was edited against.
    const noKey = await plan(f, edited(download, [{ id: a1, set: { scientificName: "Andrena" } }], { dropColumns: ["specimenVersion"] }));
    expect(heldOf(noKey, "column_missing").map((h) => [h.unit, h.detail])).toEqual([["determination", "specimenVersion"]]);
    // A specimen with no determination has a version too, and an edit made against it stands.
    const first = await plan(f, edited(download, [{ id: a2, set: { scientificName: "Bombus" } }]));
    expect(first.changes.map((c) => [c.specimenId, c.cells[0]!.was, c.cells[0]!.fileSays])).toEqual([[a2, "", "Bombus"]]);
  });

  it("holds a determination that a loader updated in place, where the id did not change", async () => {
    const f = await uploadFixture();
    const { a1 } = f.ids;
    const download = await f.download();
    const before = readRecords(download)[1]!;
    await f.conn.run(`UPDATE determination SET sex = 'male' WHERE specimen_id = ${a1}`);
    const after = readRecords(await f.download())[1]!;
    const head = readRecords(download)[0]!;
    // The determination is the same one, and the version says the row has changed.
    expect(after[head.indexOf("specimenVersion")]).not.toBe(before[head.indexOf("specimenVersion")]);
    const p = await plan(f, edited(download, [{ id: a1, set: { scientificName: "Andrena" } }]));
    expect(heldOf(p, "specimen_changed_since").map((h) => [h.specimenId, h.unit])).toEqual([[a1, "determination"]]);
    expect(p.changes).toEqual([]);
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
    expect(p.changes).toEqual([]);
  });

  it("holds a sample's changes when the sample has changed since, or the file cannot say", async () => {
    const f = await uploadFixture();
    const { a1, a2, a3, sampleA } = f.ids;
    const download = await f.download();
    const all = [a1, a2, a3].map((id) => ({ id, set: { locality: "Elsewhere" } }));
    const fresh = await plan(f, edited(download, all));
    expect(fresh.sampleChanges).toHaveLength(1);

    await f.conn.run(`UPDATE sample SET protocol = 'blue vane trap' WHERE entity_id = ${sampleA}`);
    const stale = await plan(f, edited(download, all));
    expect(stale.sampleChanges).toEqual([]);
    // The method also differs now, from what the file says, so its unit is held too.
    expect(heldOf(stale, "sample_changed_since").map((h) => [h.unit, h.column])).toEqual([
      ["method_dates", "samplingProtocol"],
      ["place", "locality"],
    ]);
    expect(heldOf(stale, "sample_changed_since")[1]).toMatchObject({ sampleNumber: "UP-1", detail: "Elsewhere" });

    const noKey = await plan(f, edited(download, all, { dropColumns: ["sampleVersion"] }));
    expect(heldOf(noKey, "column_missing").map((h) => [h.unit, h.detail])).toEqual([
      ["method_dates", "sampleVersion"],
      ["place", "sampleVersion"],
    ]);
    // Nothing differs, so nothing is held for want of a version.
    nothingDiffers(await plan(f, edited(await f.download(), [], { dropColumns: ["sampleVersion"] })));
  });
});

describe("a sample's change counted once", () => {
  it("is one change for the sample, with how many of its specimens the file holds", async () => {
    const f = await uploadFixture();
    const { a1, a2, a3, sampleA } = f.ids;
    const download = await f.download();
    const p = await plan(f, edited(download, [a1, a2].map((id) => ({ id, set: { locality: "Elsewhere" } })), { dropRows: [a3] }));
    expect(p.sampleChanges).toEqual([
      {
        unit: "place",
        sampleId: sampleA,
        sampleNumber: "UP-1",
        cells: [{ column: "locality", was: "Corvallis", fileSays: "Elsewhere", differs: true }],
        rows: [2, 3],
        specimensInFile: 2,
        specimensInSample: 3,
        // Specimens with no label row at all are imported ones, whose labels are on pins.
        printed: true,
      },
    ]);
    expect(p.counts.withChanges).toEqual({ active: 2, settled: 0, unplaced: 0 });
  });

  it("says when a sample's labels have not printed", async () => {
    const f = await uploadFixture("staffer", { unprinted: true });
    const { c1, sampleC } = f.ids;
    const p = await plan(f, edited(await f.download(), [{ id: c1!, set: { locality: "Elsewhere" } }]));
    expect(p.sampleChanges).toHaveLength(1);
    expect(p.sampleChanges[0]).toMatchObject({ sampleId: sampleC, sampleNumber: "UP-3", printed: false, specimensInFile: 1, specimensInSample: 1 });
  });

  it("holds the change when the rows of one sample do not say the same thing", async () => {
    const f = await uploadFixture();
    const { a1, a2, a3 } = f.ids;
    const download = await f.download();
    // One row edited and its sample-mates left alone.
    const one = await plan(f, edited(download, [{ id: a1, set: { locality: "Elsewhere" } }]));
    expect(one.sampleChanges).toEqual([]);
    expect(heldOf(one, "rows_disagree")).toHaveLength(1);
    expect(heldOf(one, "rows_disagree")[0]).toMatchObject({ unit: "place", column: "locality", sampleNumber: "UP-1", rows: [2, 3, 4] });
    // Two rows edited to different things.
    const two = await plan(f, edited(download, [{ id: a1, set: { locality: "X" } }, { id: a2, set: { locality: "Y" } }]));
    expect(heldOf(two, "rows_disagree")).toHaveLength(1);
    // Every row saying the same is one change.
    const all = await plan(f, edited(download, [a1, a2, a3].map((id) => ({ id, set: { locality: "X" } }))));
    expect(heldOf(all, "rows_disagree")).toEqual([]);
    expect(all.sampleChanges).toHaveLength(1);
  });

  it("splits every count by active and settled season", async () => {
    const f = await uploadFixture();
    const { a1, b1 } = f.ids;
    const p = await plan(
      f,
      edited(await f.download(), [
        { id: a1, set: { county: "Linn" } },
        { id: b1, set: { county: "Linn" } },
      ]),
    );
    expect(p.counts.withChanges).toEqual({ active: 1, settled: 1, unplaced: 0 });
    expect(p.counts.unchanged).toEqual({ active: 2, settled: 0, unplaced: 0 });
  });
});
