import { readdir } from "node:fs/promises";
import { describe as describeInOrder, expect, it } from "vitest";
import { en } from "../src/app/messages/en.js";
import { SAMPLE_REASONS, planSamples, type SampleRowResult, type SamplesPlan } from "../src/app/samples-upload-plan.js";
import { notesCopy, samplesNotes } from "../src/app/upload-notes.js";
import { NOTE_COLUMN, SAMPLES_LAYOUT, parseAnyUpload, parseUpload, type ParsedUpload } from "../src/app/upload-plan.js";
import { readXlsxHere } from "../src/app/xlsx-reader.js";
import { CURRENT_SEASON, SETTLED_SEASON, insertCleanSample, rows } from "./helpers.js";
import { edited, matrixOf, uploadFixture, type UploadFixture } from "./upload-fixture.js";
import { buildWorkbook, type TestCell } from "./workbook.js";

/** The tests run at the same time: each has a store of its own, copied from one made once. */
const describe = describeInOrder.concurrent;

const ORIGIN = "http://localhost:3054";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const THIS_YEAR = (n: number, month: string) => `${CURRENT_SEASON}-${month}-${String(n).padStart(2, "0")}`;

const download = async (f: UploadFixture, query = "scope=all") => {
  const res = await f.app.request(`/samples.xlsx?${query}`);
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
};
const parsed = async (bytes: Uint8Array): Promise<ParsedUpload> => {
  const p = await parseUpload(bytes, { inThread: true }, SAMPLES_LAYOUT);
  if (!p.ok) throw new Error(`refused: ${p.refusal}`);
  return p.upload;
};
const plan = async (f: UploadFixture, bytes: Uint8Array): Promise<SamplesPlan> => planSamples(f.db, f.conn, await parsed(bytes));
const edit = (
  bytes: Uint8Array,
  edits: Array<{ id: number; set: Record<string, TestCell> }> = [],
  options: Parameters<typeof edited>[2] = {},
) => edited(bytes, edits, { idColumn: "sampleId", ...options });
const rowOf = (p: SamplesPlan, id: number): SampleRowResult => p.rows.find((r) => r.sampleId === id)!;
const reasons = (r: SampleRowResult) => r.problems.map((p) => p.reason);
const upload = (f: UploadFixture, file: Uint8Array, fileName = "samples.xlsx") => {
  const body = new FormData();
  body.set("file", new File([file as BlobPart], fileName, { type: XLSX }));
  return f.app.request("/uploads", { method: "POST", headers: { origin: ORIGIN }, body });
};
const pageOf = async (f: UploadFixture, file: Uint8Array) => {
  const res = await upload(f, file);
  expect(res.status).toBe(303);
  return { location: res.headers.get("location")!, html: await (await f.app.request(res.headers.get("location")!)).text() };
};
const esc = (text: string) => text.replaceAll("'", "&#39;");

describe("the samples download", () => {
  it("is staff's alone, and its tabs and columns are the file's", async () => {
    const f = await uploadFixture();
    const bytes = await download(f);
    const matrix = matrixOf(bytes);
    expect(matrix[0]).toEqual([...SAMPLES_LAYOUT.headings]);
    const read = readXlsxHere(bytes);
    expect(read.ok && [read.sheet.name, read.otherSheets]).toEqual(["samples", ["collectors", "about"]]);
    // Both samples of the fixture, with the values the samples CSV writes for the columns it has.
    const csv = await (await f.app.request("/samples.csv?scope=all")).text();
    const row = (matrix.find((r) => r[matrix[0]!.indexOf("fieldNumber")] === "UP-1"))!;
    const at = (h: string) => matrix[0]!.indexOf(h);
    expect([row[at("recordedBy")], row[at("eventDate")], row[at("samplingProtocol")], row[at("trapCount")], row[at("specimenCount")]]).toEqual([
      "Vera Volunteer",
      THIS_YEAR(14, "07"),
      "net",
      "",
      "3",
    ]);
    expect([row[at("countryCode")], row[at("stateProvince")], row[at("county")], row[at("locality")], row[at("decimalLatitude")], row[at("decimalLongitude")], row[at("coordinateUncertaintyInMeters")]]).toEqual([
      "US",
      "OR",
      "BentonCo",
      "Corvallis",
      "44.5646",
      "-123.262",
      "30",
    ]);
    expect(csv).toContain("UP-1");
    expect(row[at("sampleId")]).toBe(String(f.ids.sampleA));
    expect(row[at("sampleVersion")]).toMatch(/^f[0-9a-f]{12}$/);
    const volunteer = await uploadFixture("volunteer");
    expect((await volunteer.app.request("/samples.xlsx?scope=all")).status).toBe(403);
  });

  it("writes the trap count from the effort, and takes the listing's filters", async () => {
    const f = await uploadFixture();
    await insertCleanSample(f.conn, { kind: "'trap'", sample_number: "'OBAS-00001'", protocol: "'vane trap'", sampling_effort: "'6 vane traps'", collector_id: String(f.volunteer) });
    const matrix = matrixOf(await download(f));
    const head = matrix[0]!;
    const trap = matrix.find((r) => r[head.indexOf("fieldNumber")] === "OBAS-00001")!;
    expect(trap[head.indexOf("trapCount")]).toBe("6");
    // Every kind of sample, net and trap, but only what the filters select.
    const trapsOnly = matrixOf(await download(f, "scope=all&kind=trap"));
    expect(trapsOnly.slice(1).map((r) => r[head.indexOf("fieldNumber")])).toEqual(["OBAS-00001"]);
  });

  it("lists on the collectors tab those who collected in the last 24 months, once, sorted", async () => {
    const f = await uploadFixture();
    // Sam collected long ago: not listed. Vera, and a second sample of hers, are listed once.
    await insertCleanSample(f.conn, { collector_id: String(f.staffer), sample_number: "'OLD'", date_start: "DATE '2019-06-01'", date_end: "DATE '2019-06-01'" });
    await insertCleanSample(f.conn, { collector_id: String(f.volunteer), sample_number: "'UP-4'" });
    const read = readXlsxHere(await download(f), { sheetName: "collectors" });
    expect(read.ok && read.sheet.rows.map((r) => r.cells.get(0)?.text)).toEqual(["recordedBy", "Vera Volunteer"]);
  });

  it("says in its about tab what each white column takes, without Beeline's own words for it", async () => {
    const f = await uploadFixture();
    const read = readXlsxHere(await download(f), { sheetName: "about" });
    if (!read.ok) throw new Error("unreadable");
    const text = read.sheet.rows.map((r) => `${r.cells.get(0)?.text} ${r.cells.get(1)?.text}`).join("\n");
    for (const column of SAMPLES_LAYOUT.read) expect(text, column).toContain(column);
    expect(text).toContain("blank sampleId will become a new trap sample");
    expect(text).not.toMatch(/\b(held|hold|holds|draft|drafts|plan|unit|reader|layout)\b/i);
  });

  it("is offered to staff on the samples page, with the limit in its note, and to nobody else", async () => {
    const f = await uploadFixture();
    const page = await (await f.app.request("/samples?scope=all")).text();
    expect(page).toContain(en.listings.csv.editSamples);
    expect(page).toContain("/samples.xlsx?");
    expect(page).toContain(`href="/uploads"`);
    expect(en.listings.csv.editSamplesNote).toContain("20,000");
    const volunteer = await uploadFixture("volunteer");
    expect(await (await volunteer.app.request("/samples?scope=all")).text()).not.toContain(en.listings.csv.editSamples);
  });
});

describe("telling the two files apart", () => {
  it("reads a file by its headings, and the specimens file as before", async () => {
    const f = await uploadFixture();
    const samples = await parseAnyUpload(await download(f), { inThread: true });
    expect(samples.ok && samples.upload.layout.kind).toBe("samples");
    const specimens = await parseAnyUpload(await f.file(), { inThread: true });
    expect(specimens.ok && specimens.upload.layout.kind).toBe("specimens");
    // A tab named samples with no sampleId says what is missing, and not a specimen column.
    const noId = await parseAnyUpload(buildWorkbook([["fieldNumber"], ["UP-1"]], { name: "samples" }), { inThread: true });
    expect(noId).toMatchObject({ ok: false, refusal: "no_sample_id_column" });
    const none = await parseAnyUpload(buildWorkbook([["fieldNumber"], ["UP-1"]], { name: "other" }), { inThread: true });
    expect(none).toMatchObject({ ok: false, refusal: "no_specimen_id_column" });
    // Several tabs, none of them either file's.
    const several = await parseAnyUpload(buildWorkbook([["sampleId"], ["1"]], { name: "mine", others: ["theirs"] }), { inThread: true });
    expect(several).toMatchObject({ ok: false, refusal: "no_such_sheet" });
    expect(en.uploads.refusedNoSuchSheet("mine, theirs")).toContain("specimens or samples");
  });
});

describe("comparing the samples file", () => {
  it("finds no difference in a file nobody edited, and the page says so", async () => {
    const f = await uploadFixture();
    const bytes = await download(f);
    const p = await plan(f, bytes);
    expect(p.rows.flatMap((r) => [...r.differences, ...r.problems])).toEqual([]);
    expect(p.counts.same).toEqual({ active: 1, settled: 1, unplaced: 0 });
    const { html } = await pageOf(f, bytes);
    expect(html).toContain(esc(en.uploads.page.samplesSame(2, en.uploads.page.split(1, 1, 0))));
    expect(html).toContain(esc(en.uploads.page.samplesNothingChanged));
    expect(html).not.toContain(en.uploads.page.downloadStaff);
  });

  const units: Array<[string, string, Record<string, TestCell>, string[]]> = [
    ["method_dates", "a different method", { samplingProtocol: "pan trap" }, ["samplingProtocol"]],
    ["method_dates", "a different day", { eventDate: `${THIS_YEAR(10, "07")}/${THIS_YEAR(14, "07")}` }, ["eventDate"]],
    ["trap_count", "a trap count", { trapCount: "4" }, ["trapCount"]],
    ["specimen_count", "a different count", { specimenCount: "5" }, ["specimenCount"]],
    ["collectors", "another collector", { recordedBy: "Vera Volunteer | Sam Staff" }, ["recordedBy"]],
    ["area", "another state", { stateProvince: "WA" }, ["stateProvince"]],
    ["area", "another country", { countryCode: "CA" }, ["countryCode"]],
    ["place", "another place", { locality: "Albany" }, ["locality"]],
    ["coordinates", "another point", { decimalLatitude: "44.6" }, ["decimalLatitude"]],
  ];
  for (const [unit, says, set, columns] of units) {
    it(`lists a changed ${unit} (${says}), whole, with the cells that differ`, async () => {
      const f = await uploadFixture();
      const p = await plan(f, edit(await download(f), [{ id: f.ids.sampleA, set }]));
      const r = rowOf(p, f.ids.sampleA);
      expect(r.problems).toEqual([]);
      expect(r.differences.map((d) => d.unit)).toEqual([unit]);
      expect(r.differences[0]!.cells.filter((c) => c.differs).map((c) => c.column)).toEqual(columns);
      expect(p.counts.differ).toEqual({ active: 1, settled: 0, unplaced: 0 });
    });
  }

  it("takes a list of collectors as the names in it, so `A|B` is `A | B`, and a two-letter country without case", async () => {
    const f = await uploadFixture();
    const p = await plan(f, edit(await download(f), [{ id: f.ids.sampleA, set: { recordedBy: " Vera Volunteer |", countryCode: "us" } }]));
    expect(rowOf(p, f.ids.sampleA)).toMatchObject({ differences: [], problems: [] });
  });

  const wrong: Array<[string, Record<string, TestCell>, string]> = [
    ["trap_count_invalid", { trapCount: "0" }, "trap_count_invalid"],
    ["a trap count that is not whole", { trapCount: "1.5" }, "trap_count_invalid"],
    ["specimen_count_invalid", { specimenCount: "" }, "specimen_count_invalid"],
    ["a negative specimen count", { specimenCount: "-1" }, "specimen_count_invalid"],
    ["collectors_blank", { recordedBy: "" }, "collectors_blank"],
    ["country_blank", { countryCode: "" }, "country_blank"],
    ["state_blank", { stateProvince: "" }, "state_blank"],
    ["country_unknown", { countryCode: "XX" }, "country_unknown"],
    ["a four-letter country", { countryCode: "USAA" }, "country_unknown"],
    ["event_date_blank", { eventDate: "" }, "event_date_blank"],
    ["event_date_future", { eventDate: "2999-01-01" }, "event_date_future"],
    ["date_unreadable", { eventDate: "7/4/2026" }, "date_unreadable"],
    ["number_unreadable", { decimalLatitude: "north" }, "number_unreadable"],
    ["latitude_range", { decimalLatitude: "91" }, "latitude_range"],
    ["coordinates_incomplete", { decimalLongitude: "" }, "coordinates_incomplete"],
    ["uncertainty_invalid", { coordinateUncertaintyInMeters: "0" }, "uncertainty_invalid"],
    ["converted_to_date", { locality: { date: 46000 } }, "converted_to_date"],
    ["collector_unknown", { recordedBy: "Nobody Known" }, "collector_unknown"],
    ["a person named twice", { recordedBy: "Vera Volunteer | Vera Volunteer" }, "collector_unknown"],
  ];
  for (const [name, set, reason] of wrong) {
    it(`cannot use a row with ${name}, and says which cell`, async () => {
      const f = await uploadFixture();
      const p = await plan(f, edit(await download(f), [{ id: f.ids.sampleA, set }]));
      const r = rowOf(p, f.ids.sampleA);
      expect(reasons(r)).toEqual([reason]);
      expect(r.differences).toEqual([]);
      expect(p.counts.cantUse).toEqual({ active: 1, settled: 0, unplaced: 0 });
    });
  }

  it("holds a changed group when the sample changed since the download, or the file has no version", async () => {
    const f = await uploadFixture();
    const bytes = await download(f);
    const changedSince = await plan(f, edit(bytes, [{ id: f.ids.sampleA, set: { locality: "Albany", sampleVersion: "fdeadbeef0000" } }]));
    expect(reasons(rowOf(changedSince, f.ids.sampleA))).toEqual(["sample_changed_since"]);
    const noVersion = await plan(f, edit(bytes, [{ id: f.ids.sampleA, set: { locality: "Albany" } }], { dropColumns: ["sampleVersion"] }));
    expect(rowOf(noVersion, f.ids.sampleA).problems.map((p) => [p.reason, p.detail])).toEqual([["column_missing", "sampleVersion"]]);
    // And a sample that changed in Beeline after the download is seen the same way.
    await f.conn.run(`UPDATE sample SET specimen_count = 9 WHERE entity_id = ${f.ids.sampleA}`);
    const moved = await plan(f, edit(bytes, [{ id: f.ids.sampleA, set: { locality: "Albany" } }]));
    // The specimen count the file says is not Beeline's now either, so that group is held for the same reason.
    expect(reasons(rowOf(moved, f.ids.sampleA))).toEqual(["sample_changed_since", "sample_changed_since"]);
  });

  it("lists the groups that are fine and holds the one that is not, in one row", async () => {
    const f = await uploadFixture();
    const p = await plan(f, edit(await download(f), [{ id: f.ids.sampleA, set: { locality: "Albany", specimenCount: "x" } }]));
    const r = rowOf(p, f.ids.sampleA);
    expect(r.differences.map((d) => d.unit)).toEqual(["place"]);
    expect(reasons(r)).toEqual(["number_unreadable"]);
  });

  it("cannot use a row that is not a sample it says", async () => {
    const f = await uploadFixture();
    const bytes = await download(f);
    const p = await plan(
      f,
      edit(bytes, [
        { id: f.ids.sampleB, set: { fieldNumber: "UP-9" } },
        { id: f.ids.sampleA, set: { sampleId: "abc" } },
      ], { addRows: [{ sampleId: "9999999", fieldNumber: "X" }] }),
    );
    expect(p.rows.map((r) => [r.kind, reasons(r)])).toEqual([["existing", ["no_sample_id"]], ["existing", ["sample_number_disagrees"]], ["existing", ["no_sample"]]]);
    // The number is never a change: not even on a sample that could be renumbered.
    expect(rowOf(p, f.ids.sampleB).differences).toEqual([]);
    const twice = await plan(f, edit(bytes, [], { addRows: [{ sampleId: String(f.ids.sampleA), fieldNumber: "UP-1" }] }));
    expect(twice.rows.filter((r) => r.sampleId === f.ids.sampleA).map(reasons)).toEqual([["sample_repeated"], ["sample_repeated"]]);
    expect(twice.counts.cantUse.active).toBe(2);
  });

  it("splits what it counts by season: an existing sample by its season, a new row by its first day", async () => {
    const f = await uploadFixture();
    const settled = `${SETTLED_SEASON}-06-02`;
    const base = { recordedBy: "Vera Volunteer", samplingProtocol: "vane trap", specimenCount: "0", decimalLatitude: "44.5", decimalLongitude: "-123.2", countryCode: "US", stateProvince: "OR" };
    const p = await plan(
      f,
      edit(await download(f), [{ id: f.ids.sampleB, set: { locality: "Albany", sampleVersion: "fold" } }], {
        addRows: [
          { ...base, fieldNumber: "OBAS-10001", eventDate: THIS_YEAR(10, "07") },
          { ...base, fieldNumber: "OBAS-10002", eventDate: settled },
          { ...base, fieldNumber: "OBAS-10003", eventDate: "later" },
        ],
      }),
    );
    // The third new row has no date to place it by.
    expect(p.counts.rows).toEqual({ active: 2, settled: 2, unplaced: 1 });
    expect(p.counts.newReady).toEqual({ active: 1, settled: 1, unplaced: 0 });
    expect(p.counts.cantUse).toEqual({ active: 0, settled: 1, unplaced: 1 });
    expect(p.counts.same).toEqual({ active: 1, settled: 0, unplaced: 0 });
  });
});

describe("a new trap sample", () => {
  const ready = { fieldNumber: "OBAS-20001", recordedBy: "Vera Volunteer", eventDate: THIS_YEAR(10, "07"), samplingProtocol: "vane trap", trapCount: "6", specimenCount: "", decimalLatitude: "44.5", decimalLongitude: "-123.2", coordinateUncertaintyInMeters: "50", countryCode: "US", stateProvince: "OR", county: "Benton", locality: "Fir Butte" };

  it("is ready when the trap form would take it, and its date may be one day or a range", async () => {
    const f = await uploadFixture();
    const bytes = await download(f);
    const p = await plan(f, edit(bytes, [], { addRows: [ready, { ...ready, fieldNumber: "OBAS-20002", eventDate: `${THIS_YEAR(1, "07")}/${THIS_YEAR(9, "07")}` }] }));
    const added = p.rows.filter((r) => r.kind === "new");
    expect(added.map((r) => [r.sampleNumber, r.problems])).toEqual([["OBAS-20001", []], ["OBAS-20002", []]]);
    expect(p.counts.newReady).toEqual({ active: 2, settled: 0, unplaced: 0 });
  });

  it("says what the form would say of each thing missing, once", async () => {
    const f = await uploadFixture();
    const p = await plan(f, edit(await download(f), [], { addRows: [{ ...ready, fieldNumber: "", samplingProtocol: "", decimalLatitude: "", decimalLongitude: "", coordinateUncertaintyInMeters: "" }] }));
    const r = p.rows.find((x) => x.kind === "new")!;
    expect(r.problems.map((x) => [x.reason, x.column])).toEqual([
      ["new_row_problem", "fieldNumber"],
      ["new_row_problem", "samplingProtocol"],
      ["new_row_problem", "decimalLatitude"],
      ["new_row_problem", "decimalLongitude"],
    ]);
    expect(r.problems.map((x) => x.detail)).toEqual(["A sample number is needed.", "Say what kind of trap.", "A latitude in decimal degrees is needed.", "A longitude in decimal degrees is needed."]);
  });

  it("cannot use two new rows with one number, nor one whose number another trap sample has", async () => {
    const f = await uploadFixture();
    await insertCleanSample(f.conn, { kind: "'trap'", sample_number: "'OBAS-20009'", collector_id: String(f.volunteer) });
    const p = await plan(
      f,
      edit(await download(f), [], { addRows: [ready, { ...ready, locality: "Elsewhere" }, { ...ready, fieldNumber: "OBAS-20009" }] }),
    );
    const added = p.rows.filter((r) => r.kind === "new");
    expect(added.map(reasons)).toEqual([["new_number_repeated"], ["new_number_repeated"], ["new_row_problem"]]);
    expect(added[2]!.problems[0]!.detail).toBe("Trap sample OBAS-20009 is already in Beeline.");
  });

  it("uses the comparison's rules for a date and a point, and its reading of a cell", async () => {
    const f = await uploadFixture();
    const p = await plan(
      f,
      edit(await download(f), [], {
        addRows: [
          { ...ready, eventDate: "2999-01-01" },
          { ...ready, fieldNumber: "OBAS-20002", decimalLatitude: "95" },
          { ...ready, fieldNumber: "OBAS-20003", countryCode: "XX" },
          { ...ready, fieldNumber: "OBAS-20004", trapCount: "0" },
        ],
      }),
    );
    expect(p.rows.filter((r) => r.kind === "new").map(reasons)).toEqual([["event_date_future"], ["latitude_range"], ["country_unknown"], ["trap_count_invalid"]]);
  });

  it("lists a collector Beeline does not know once, with the rows that name it, and cannot use those rows", async () => {
    const f = await uploadFixture();
    // A changed list of collectors of an existing sample counts too.
    const p = await plan(
      f,
      edit(await download(f), [{ id: f.ids.sampleA, set: { recordedBy: "Vera Volunteer | Zed Zebra" } }], {
        addRows: [
          { ...ready, recordedBy: "Zed Zebra" },
          { ...ready, fieldNumber: "OBAS-20002", recordedBy: "Zed Zebra | Vera Volunteer" },
          { ...ready, fieldNumber: "OBAS-20003", recordedBy: "Yan Yak" },
        ],
      }),
    );
    expect(p.unknownCollectors.map((u) => [u.name, u.rows])).toEqual([["Yan Yak", 1], ["Zed Zebra", 3]]);
    expect(p.rows.filter((r) => r.kind === "new").map(reasons)).toEqual([["new_row_problem"], ["new_row_problem"], ["new_row_problem"]]);
    expect(reasons(rowOf(p, f.ids.sampleA))).toEqual(["collector_unknown"]);
  });

  it("names a collector the way the trap form does: by display name without typography, by id, by iNaturalist login", async () => {
    const f = await uploadFixture();
    await f.conn.run(`INSERT INTO inat_account (inat_user_id, login, person_id) VALUES (555, 'vera_v', ${f.volunteer})`);
    const p = await plan(
      f,
      edit(await download(f), [], {
        addRows: [
          { ...ready, recordedBy: "vera  volunteer" },
          { ...ready, fieldNumber: "OBAS-20002", recordedBy: `${f.staffer} | inat:vera_v` },
        ],
      }),
    );
    expect(p.rows.filter((r) => r.kind === "new").map(reasons)).toEqual([[], []]);
    expect(p.unknownCollectors).toEqual([]);
  });
});

describe("the upload page and the file with notes", () => {
  it("is a few counts and two actions, with no row listed, and writes nothing", async () => {
    const f = await uploadFixture();
    const before = JSON.stringify(await Promise.all(["sample", "sample_collector", "sample_location"].map((t) => rows(f.conn, `SELECT * FROM ${t} ORDER BY 1`))));
    const ready = { fieldNumber: "OBAS-20001", recordedBy: "Vera Volunteer", eventDate: THIS_YEAR(10, "07"), samplingProtocol: "vane trap", specimenCount: "2", decimalLatitude: "44.5", decimalLongitude: "-123.2", countryCode: "US", stateProvince: "OR" };
    const bytes = edit(await download(f), [{ id: f.ids.sampleA, set: { locality: "Albany" } }, { id: f.ids.sampleB, set: { specimenCount: "x" } }], {
      addRows: [ready, { ...ready, fieldNumber: "OBAS-20002", recordedBy: "Zed Zebra" }],
    });
    const { location, html } = await pageOf(f, bytes);
    const p = en.uploads.page;
    expect(html).toContain(esc(p.rows(4)));
    expect(html).toContain(esc(p.samplesNew(1, p.split(1, 0, 0))));
    expect(html).toContain(esc(p.samplesCantUse(2, p.split(1, 1, 0))));
    expect(html).toContain(esc(p.samplesDiffer(1, p.split(1, 0, 0))));
    expect(html).toContain(esc(p.samplesUnknownCollectors(p.samplesUnknownCollector("Zed Zebra", 1))));
    expect(html).toContain(esc(p.samplesNothingChanged));
    expect(html).toContain(`${location}/notes`);
    expect(html).not.toContain("UP-1");
    expect(/<main>.*<\/main>/s.exec(html)![0]).not.toMatch(/\b(held|hold|holds|draft|drafts|plan|unit|reader|layout)\b/i);
    expect(JSON.stringify(await Promise.all(["sample", "sample_collector", "sample_location"].map((t) => rows(f.conn, `SELECT * FROM ${t} ORDER BY 1`))))).toBe(before);
    // Kept as any upload is.
    expect(await readdir(f.paths.uploadsDir)).toHaveLength(1);
  });

  it("hands the file back with a note on each row, which uploads again cleanly", async () => {
    const f = await uploadFixture();
    const ready = { fieldNumber: "OBAS-20001", recordedBy: "Vera Volunteer", eventDate: THIS_YEAR(10, "07"), samplingProtocol: "vane trap", specimenCount: "2", decimalLatitude: "44.5", decimalLongitude: "-123.2", countryCode: "US", stateProvince: "OR" };
    const bytes = edit(await download(f), [{ id: f.ids.sampleA, set: { locality: "Albany" } }, { id: f.ids.sampleB, set: { specimenCount: "x" } }], {
      addRows: [ready, { ...ready, fieldNumber: "OBAS-20002", recordedBy: "Zed Zebra" }],
    });
    const { location } = await pageOf(f, bytes);
    const res = await f.app.request(`${location}/notes`);
    expect(res.status).toBe(200);
    const back = new Uint8Array(await res.arrayBuffer());
    const matrix = matrixOf(back);
    const head = matrix[0]!;
    expect(head.at(-1)).toBe(NOTE_COLUMN);
    const noteOf = (number: string) => matrix.find((r) => r[head.indexOf("fieldNumber")] === number)![head.indexOf(NOTE_COLUMN)];
    const n = en.uploads.notes;
    expect(noteOf("UP-1")).toBe(n.differs(n.cell("locality", '"Corvallis"', '"Albany"')));
    expect(noteOf("UP-2")).toBe(n.cantUse(n.reason.number_unreadable!));
    expect(noteOf("OBAS-20001")).toBe(n.newTrap);
    expect(noteOf("OBAS-20002")).toContain("New trap sample, can't use: ");
    expect(noteOf("OBAS-20002")).toContain("Zed Zebra");
    for (const text of [noteOf("UP-1"), noteOf("UP-2"), noteOf("OBAS-20001"), noteOf("OBAS-20002")]) expect(text).not.toMatch(/\b(held|hold|holds|draft|drafts|plan|unit|reader|layout)\b/i);
    // The same file uploaded again: the note column is not read, and what the rows say is the same.
    const again = await parsed(back);
    expect(again.unrecognised).toEqual([]);
    const first = await plan(f, bytes);
    const second = await plan(f, back);
    expect(second.counts).toEqual(first.counts);
    expect(second.rows.map((r) => [r.sampleId, reasons(r), r.differences.length])).toEqual(first.rows.map((r) => [r.sampleId, reasons(r), r.differences.length]));
    expect(second.unrecognised).toEqual([]);
  });

  it("makes a copy with the notes, in the samples file's own tab and shading, where the file cannot be patched", async () => {
    const f = await uploadFixture();
    const bytes = edit(await download(f), [{ id: f.ids.sampleA, set: { locality: "Albany" } }]);
    const upload = await parsed(bytes);
    const noted = samplesNotes(en, upload, await planSamples(f.db, f.conn, upload));
    const copy = await notesCopy(f.db, en, upload, noted.notes, "samples");
    const matrix = matrixOf(copy);
    expect(matrix[0]).toEqual([...SAMPLES_LAYOUT.headings, NOTE_COLUMN]);
    const again = await parseUpload(copy, { inThread: true }, SAMPLES_LAYOUT);
    expect(again.ok && again.upload.unrecognised).toEqual([]);
    expect(matrix.map((r) => r.at(-1))).toContain(en.uploads.notes.differs(en.uploads.notes.cell("locality", '"Corvallis"', '"Albany"')));
  });

  it("refuses the samples file from someone who is not staff, and keeps nothing", async () => {
    const f = await uploadFixture("volunteer");
    const bytes = new Uint8Array(await (await f.appAs("staffer").request("/samples.xlsx?scope=all")).arrayBuffer());
    const res = await upload(f, bytes);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(esc(en.uploads.refused.staff_only_samples!));
    expect(Number((await rows(f.conn, `SELECT count(*) FROM upload`))[0]![0])).toBe(0);
    expect(await readdir(f.paths.uploadsDir).catch(() => [])).toEqual([]);
  });

  it("still reads a specimens file as before, on the same page", async () => {
    const f = await uploadFixture();
    const { html } = await pageOf(f, edited(await f.file(), [{ id: f.ids.a1, set: { scientificName: "Bombus" } }]));
    expect(html).toContain(esc(en.uploads.page.differ(1)));
    expect(html).toContain(esc(en.uploads.page.staffNothingChanged));
    expect(html).not.toContain(esc(en.uploads.page.samplesNothingChanged));
  });

  it("names the other tabs it did not read, as the tab it read", async () => {
    const f = await uploadFixture();
    const { html } = await pageOf(f, edit(await download(f), [{ id: f.ids.sampleA, set: { locality: "Albany" } }], { sheets: { others: ["Notes"], before: true } }));
    expect(html).toContain(esc(en.uploads.page.otherSheets("Notes", "samples")));
  });
});

describe("the words", () => {
  it("has a sentence for every reason only the samples file has, none in Beeline's own words", () => {
    const own = SAMPLE_REASONS.filter((r) => r !== "collector_unknown" && r !== "new_row_problem");
    for (const reason of own) {
      expect(en.uploads.notes.sampleReason[reason], reason).toBeTruthy();
      expect(en.uploads.notes.sampleReason[reason], reason).not.toMatch(/\b(held|hold|holds|draft|drafts|plan|unit|reader|layout)\b/i);
    }
    expect(Object.keys(en.uploads.notes.sampleReason).sort()).toEqual([...own].sort());
    const said = [en.uploads.notes.newTrap, en.uploads.notes.newTrapCantUse("x"), ...Object.values(en.workbook.samples.column), en.workbook.samples.purpose, en.workbook.samples.newRows, en.workbook.samples.leave];
    for (const text of said) expect(text).not.toMatch(/\b(held|hold|holds|draft|drafts|plan|unit|reader|layout)\b/i);
  });

  it("notes nothing for a row with nothing to say", async () => {
    const f = await uploadFixture();
    const bytes = await download(f);
    const upload = await parsed(bytes);
    const noted = samplesNotes(en, upload, await planSamples(f.db, f.conn, upload));
    expect([...noted.notes.values()]).toEqual(["", ""]);
    expect(noted.summary.counts.same.active + noted.summary.counts.same.settled).toBe(2);
  });
});
