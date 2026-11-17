import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_ROWS,
  parseCsvRecords,
  planUpload,
  safeBaseName,
  type HeldItem,
  type UploadPlan,
} from "../src/app/upload-plan.js";
import { csvLine } from "../src/app/listings.js";
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

describe("reading an uploaded file", () => {
  it("reads RFC 4180: quoted cells, doubled quotes, a newline inside quotes, either line ending", () => {
    expect(parseCsvRecords('a,b,c\n1,"x,y","say ""hi"""\r\n2,"two\nlines",\r\n')).toEqual([
      ["a", "b", "c"],
      ["1", "x,y", 'say "hi"'],
      ["2", "two\nlines", ""],
    ]);
    // No final newline, and a blank last cell.
    expect(parseCsvRecords("a,b\n1,")).toEqual([["a", "b"], ["1", ""]]);
  });

  it("keeps a kept file's name to a safe base name", () => {
    expect(safeBaseName("C:\\Users\\x\\edited specimens (1).csv")).toBe("edited_specimens_1_.csv");
    expect(safeBaseName("../../etc/passwd")).toBe("passwd");
    expect(safeBaseName(".hidden")).toBe("hidden");
    expect(safeBaseName("///")).toBe("upload.csv");
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

    // Rewritten with carriage returns and a byte order mark, as Excel does.
    nothingDiffers(await plan(f, edited(download, [], { lineEnding: "\r\n" })));
    // Columns the file leaves out are never a difference, nor are ones it adds.
    nothingDiffers(await plan(f, edited(download, [], { dropColumns: ["locality", "scientificName", "sex", "caste"] })));
    nothingDiffers(await plan(f, readRecords(download).map((r, i) => csvLine([...r, i === 0 ? "myNotes" : "see me"])).join("")));
  });

  it("finds columns by name in any order", async () => {
    const f = await uploadFixture();
    const records = readRecords(await f.download());
    nothingDiffers(await plan(f, records.map((r) => csvLine([...r].reverse())).join("")));
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
    const download = await f.download();
    const text = edited(download, [{ id: a2, set: { specimenId: String(a1) } }]);
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
    // a3 has no field number: the blank cell agrees.
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
          // A day as M/D/YYYY, which Excel writes for 2026-07-14.
          eventDate: "7/14/2026".replace("2026", download.match(/(\d{4})-07-14/)![1]!),
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
      { id: a2, set: { eventDate: `${download.match(/(\d{4})-07-14/)![0]}/${download.match(/(\d{4})-07-14/)![0]}` } },
    ]);
    nothingDiffers(await plan(f, text));
  });

  it("is case-blind for sex, identification qualifier and caste, and for nothing else", async () => {
    const f = await uploadFixture();
    const p = await plan(f, edited(await f.download(), [{ id: f.ids.a1, set: { sex: "Female", scientificName: "BOMBUS VOSNESENSKII Radoszkowski, 1862" } }]));
    expect(p.changes.map((c) => c.column)).toEqual(["scientificName"]);
  });

  it("holds a cell that is not a number or not a date, and nothing else of the row", async () => {
    const f = await uploadFixture();
    const { a1, a2, a3, b1 } = f.ids;
    const p = await plan(
      f,
      edited(await f.download(), [
        { id: a1, set: { decimalLatitude: "forty-four", eventDate: "July 14", dateIdentified: "May 2024" } },
        ...[a1, a2, a3].map((id) => ({ id, set: { locality: "Elsewhere" } })),
        { id: b1, set: { coordinateUncertaintyInMeters: "30m" } },
      ]),
    );
    expect(heldOf(p, "number_unreadable").map((h) => [h.column, h.detail])).toEqual([
      ["decimalLatitude", "forty-four"],
      ["coordinateUncertaintyInMeters", "30m"],
    ]);
    expect(heldOf(p, "date_unreadable").map((h) => [h.column, h.detail])).toEqual([
      ["eventDate", "July 14"],
      ["dateIdentified", "May 2024"],
    ]);
    // The readable cell of the same row is still a difference.
    expect(p.sampleChanges.map((c) => c.column)).toEqual(["locality"]);
    // A row with an unreadable cell has changes, not nothing.
    expect(p.counts.withChanges).toEqual({ active: 3, settled: 1, unplaced: 0 });
  });

  it("reads a date identified as a year, a month or a day, and a day only when it is one", async () => {
    const f = await uploadFixture();
    const { a1 } = f.ids;
    const read = async (value: string) => (await plan(f, edited(await f.download(), [{ id: a1, set: { dateIdentified: value } }])));
    // The fixture's determination says the day 2024-05-03.
    expect((await read("2024-05-03")).changes).toEqual([]);
    expect((await read("5/3/2024")).changes).toEqual([]);
    expect((await read("2024-05")).changes.map((c) => c.fileSays)).toEqual(["2024-05"]);
    expect((await read("2024")).changes.map((c) => c.fileSays)).toEqual(["2024"]);
    expect(heldOf(await read("2/30/2024"), "date_unreadable")).toHaveLength(1);
    expect(heldOf(await read("2024-13"), "date_unreadable")).toHaveLength(1);
  });
});

describe("saying what kind of change each cell is", () => {
  it("sorts every differing column into its kind, and leaves the keys out", async () => {
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
            disposition: "Lost",
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
          set: {
            samplingProtocol: "blue vane trap",
            eventDate: "2026-01-01/2026-01-05",
            locality: "Albany",
            decimalLongitude: "-122.5",
          },
        })),
        { id: a2, set: { sampleNumber: "ignored" } },
      ]),
    );
    expect(p.changes.map((c) => [c.column, c.kind])).toEqual([
      ["disposition", "disposition"],
      ["occurrenceRemarks", "disposition"],
      ["scientificName", "determination"],
      ["identificationQualifier", "determination"],
      ["sex", "determination"],
      ["identifiedBy", "determination"],
      ["dateIdentified", "determination"],
      ["caste", "determination"],
    ]);
    expect(p.sampleChanges.map((c) => [c.column, c.kind])).toEqual([
      ["eventDate", "method_dates"],
      ["samplingProtocol", "method_dates"],
      ["locality", "place"],
      ["decimalLongitude", "coordinates"],
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
    for (const key of ["specimenId", "determinationId", "sampleVersion", "fieldNumber"]) {
      expect([...p.changes, ...p.notApplied].map((c) => c.column)).not.toContain(key);
    }
    expect(p.held).toEqual([]);
    // What a cell said and what the file says, as text; a blank is "".
    const locality = p.sampleChanges.find((c) => c.column === "locality")!;
    expect([locality.was, locality.fileSays]).toEqual(["Corvallis", "Albany"]);
    expect(p.changes.find((c) => c.column === "disposition")).toMatchObject({ was: "", fileSays: "Lost", specimenId: a1, fieldNumber: "OBA10001", row: 2 });
  });
});

describe("a file edited against something Beeline no longer says", () => {
  it("holds identification changes when another determination is the record by now", async () => {
    const f = await uploadFixture();
    const { a1 } = f.ids;
    const download = await f.download();
    await f.conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_name, verbatim_identification)
       SELECT ${a1}, entity_id, true, 'worksheet_import', 'Newer Determiner', 'Bombus' FROM animal WHERE scientific_name = 'Bombus'`,
    );
    const text = edited(download, [{ id: a1, set: { scientificName: "Andrena", locality: "Elsewhere", disposition: "Lost" } }]);
    const p = await plan(f, text);
    // Every cell of the file's identification that differs from the new record is held, not only the one edited.
    expect(heldOf(p, "determination_changed_since").map((h) => [h.specimenId, h.column])).toEqual([
      [a1, "scientificName"],
      [a1, "sex"],
      [a1, "identifiedBy"],
      [a1, "dateIdentified"],
    ]);
    // What is not an identification is still compared.
    expect(p.changes.map((c) => c.column)).toEqual(["disposition"]);
    // A file with no determinationId cannot say what it was edited against.
    const noKey = await plan(f, edited(download, [{ id: a1, set: { scientificName: "Andrena" } }], { dropColumns: ["determinationId"] }));
    expect(heldOf(noKey, "column_missing").map((h) => [h.column, h.detail])).toEqual(
      ["scientificName", "sex", "identifiedBy", "dateIdentified"].map((column) => [column, "determinationId"]),
    );
    // A blank determinationId means none, and a specimen with none has none.
    const { a2 } = f.ids;
    const first = await plan(f, edited(download, [{ id: a2, set: { scientificName: "Bombus" } }]));
    expect(first.changes.map((c) => [c.specimenId, c.was, c.fileSays])).toEqual([[a2, "", "Bombus"]]);
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
    // The method also differs now, from what the file says, so it is held too.
    expect(heldOf(stale, "sample_changed_since").map((h) => h.column)).toEqual(["samplingProtocol", "locality"]);
    expect(heldOf(stale, "sample_changed_since")[1]).toMatchObject({ sampleNumber: "UP-1", detail: "Elsewhere" });

    const noKey = await plan(f, edited(download, all, { dropColumns: ["sampleVersion"] }));
    expect(heldOf(noKey, "column_missing").map((h) => [h.column, h.detail])).toEqual([
      ["samplingProtocol", "sampleVersion"],
      ["locality", "sampleVersion"],
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
        sampleId: sampleA,
        sampleNumber: "UP-1",
        column: "locality",
        kind: "place",
        was: "Corvallis",
        fileSays: "Elsewhere",
        rows: [2, 3],
        specimensInFile: 2,
        specimensInSample: 3,
        // Specimens with no label row at all are imported ones, whose labels are on pins.
        printed: true,
      },
    ]);
    expect(p.counts.withChanges).toEqual({ active: 2, settled: 0, unplaced: 0 });
  });

  it("holds the change when the rows of one sample do not say the same thing", async () => {
    const f = await uploadFixture();
    const { a1, a2 } = f.ids;
    const download = await f.download();
    // One row edited and its sample-mates left alone.
    const one = await plan(f, edited(download, [{ id: a1, set: { locality: "Elsewhere" } }]));
    expect(one.sampleChanges).toEqual([]);
    expect(heldOf(one, "rows_disagree")).toHaveLength(1);
    expect(heldOf(one, "rows_disagree")[0]).toMatchObject({ column: "locality", sampleNumber: "UP-1", rows: [2, 3, 4] });
    // Two rows edited to different things.
    const two = await plan(f, edited(download, [{ id: a1, set: { locality: "X" } }, { id: a2, set: { locality: "Y" } }]));
    expect(heldOf(two, "rows_disagree")).toHaveLength(1);
    // A column on which they all agree with Beeline is not held for it.
    const other = await plan(f, edited(download, [{ id: a1, set: { locality: "X" } }, { id: a2, set: { locality: "X" } }, { id: f.ids.a3, set: { locality: "X" } }]));
    expect(heldOf(other, "rows_disagree")).toEqual([]);
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
