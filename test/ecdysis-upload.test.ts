import { writeFile, utimes } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { cachedArchivePath } from "../src/fetch-ecdysis.js";
import { listingFilterProblems, parseListingQuery, QC_STATUSES, type ListingQuery } from "../src/app/listings.js";
import {
  ASSOCIATION_HEADER,
  associationsCsv,
  catalogNumbersInArchive,
  claimDownload,
  eligibleNow,
  ecdysisRead,
  idsOf,
  INCLUDE_NONE,
  latestDownload,
  planUpload,
  recordDownload,
  recordWhenComplete,
  releaseDownload,
  symbiotaKey,
  uploadArchiveStream,
  uploadFileName,
  uploadIdentificationRows,
  uploadOccurrenceColumns,
  uploadStateOf,
  UPLOAD_FRESH_HOURS,
  UPLOAD_IDENTIFICATION_COLUMNS,
  type Include,
  type UploadPlan,
} from "../src/app/ecdysis-upload.js";
import { CURRENT_SEASON, SETTLED_SEASON, insertCleanSample, rows } from "./helpers.js";
import { BC, fixture, HOUR, WABA } from "./ecdysis-upload-fixture.js";

/**
 * The upload to Ecdysis (beeline-8dx9.12): which specimens, when it may be
 * built, what the two files say. Names and places are invented. British
 * Columbia is the collection files are offered for, since Beeline reads it
 * whole; Washington's is read as a dataset and is not.
 */

type F = Awaited<ReturnType<typeof fixture>>;
const NOBODY: ListingQuery = parseListingQuery(new URLSearchParams(), { atlasCodes: [] });

/** The plan for British Columbia with these catalog numbers already in Ecdysis. */
const planWith = async (f: F, held: string[] = [], query: ListingQuery = NOBODY): Promise<UploadPlan> =>
  planUpload(f.db, BC, { readAt: new Date(), held: new Set(held.map((n) => n.toLowerCase())) }, query);

/** The specimens in a year's file, with the downloader's choice about obscured ones. */
const inFile = (plan: UploadPlan, year: number, include: Include = INCLUDE_NONE) => {
  const y = plan.years.find((p) => p.year === year);
  return y === undefined ? [] : idsOf(y, include);
};
const everyone = (plan: UploadPlan, include: Include = INCLUDE_NONE) => plan.years.flatMap((y) => idsOf(y, include));
const rulesOf = (held: string[] = [], include: Include = INCLUDE_NONE) => ({ held: new Set(held.map((n) => n.toLowerCase())), include });

/** The archive as tables of cells. */
async function archiveOf(f: F, ids: number[], c = BC, rules = rulesOf()) {
  const stream = uploadArchiveStream(f.db, c, ids, rules);
  const files = Object.fromEntries(Object.entries(unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()))).map(([n, d]) => [n, strFromU8(d)]));
  const table = (name: string) => {
    const [header, ...body] = files[name]!.split("\n").filter((l) => l !== "").map((l) => l.split("\t"));
    return { header: header!, body, cell: (r: number, col: string) => body[r]![header!.indexOf(col)] };
  };
  return { files, occurrence: table("occurrence.txt"), identification: table("identification.txt") };
}

describe("which specimens go in a file", () => {
  it("takes a program's printed specimens that Ecdysis does not hold, by collection year", async () => {
    const f = await fixture();
    const wanted = await f.specimen({ field: "2500001" });
    const lastYear = await f.specimen({ field: "2500002", year: SETTLED_SEASON });
    const held = await f.specimen({ field: "2500003" });
    await f.conn.run(`INSERT INTO specimen_catalog_number (specimen_id, catalog_number) VALUES (${held.id}, 'BCBA_2500003')`);
    const noNumber = await f.specimen({ field: null });
    const otherProgram = await f.specimen({ field: "2500006", program: "OBA" });
    const washington = await f.specimen({ field: "2500007", program: "WaBA" });
    const plan = await planWith(f);
    expect(inFile(plan, CURRENT_SEASON)).toEqual([wanted.id]);
    expect(inFile(plan, SETTLED_SEASON)).toEqual([lastYear.id]);
    for (const left of [held, noNumber, otherProgram, washington]) expect(everyone(plan)).not.toContain(left.id);
  });

  it("leaves out a specimen whose label is not on paper yet", async () => {
    const f = await fixture();
    const printed = await f.specimen({ field: "2500001" });
    const { prepareRun } = await import("../src/print-run.js");
    await insertCleanSample(f.conn, {
      sample_number: "'S-PREPARED'",
      specimen_count: "1",
      date_start: `DATE '${CURRENT_SEASON}-07-14'`,
      date_end: `DATE '${CURRENT_SEASON}-07-14'`,
      atlas_id: "(SELECT entity_id FROM program WHERE code = 'BC')",
    });
    const [[staff]] = (await rows(f.conn, `INSERT INTO person (display_name) VALUES ('Sam Staff') RETURNING entity_id`)) as [[number]];
    const run = await prepareRun(f.conn, { atlasId: null, personId: staff });
    expect(run?.labels).toBe(1);
    const [[numbered]] = (await rows(f.conn, `SELECT field_number FROM specimen WHERE sample_id = (SELECT entity_id FROM sample WHERE sample_number = 'S-PREPARED')`)) as [[string | null]];
    expect(numbered).not.toBeNull();
    expect(everyone(await planWith(f))).toEqual([printed.id]);
  });

  it("leaves out a specimen whose would-be catalog number is in the Ecdysis archive but matched to no specimen", async () => {
    const f = await fixture();
    const unknownToBeeline = await f.specimen({ field: "2500010" });
    const fresh = await f.specimen({ field: "2500011" });
    expect(((await rows(f.conn, `SELECT count(*) FROM specimen_catalog_number`)) as [[number]])[0][0]).toBe(0n);
    expect(everyone(await planWith(f, ["BCBA_2500010", "BCBA_99999999"]))).toEqual([fresh.id]);
    // The comparison is the database's: case does not matter, and the prefix belongs to the collection.
    expect(everyone(await planWith(f, ["bcba_2500010"]))).toEqual([fresh.id]);
    expect(everyone(await planWith(f, ["WSDA_2500010"]))).toEqual([unknownToBeeline.id, fresh.id]);
  });

  it("leaves out, and counts apart, a label number that is not digits, a recorded disposition other than 'in collection', and an unusable catalog number", async () => {
    const f = await fixture();
    const ok = await f.specimen({ field: "2500030" });
    const inCollection = await f.specimen({ field: "2500031" });
    await f.conn.run(`INSERT INTO specimen_disposition (specimen_id, disposition, remarks, stated_by, stated_on, source) VALUES (${inCollection.id}, 'in collection', 'Pin in box 7.', 'Inez Inventory', DATE '2026-11-03', 'inventory.xlsx')`);
    const missing = await f.specimen({ field: "2500032" });
    await f.conn.run(`INSERT INTO specimen_disposition (specimen_id, disposition, remarks, stated_by, stated_on, source) VALUES (${missing.id}, 'missing', 'No pin.', 'Inez Inventory', DATE '2026-11-03', 'inventory.xlsx')`);
    // A remark and no disposition: old Beeline recorded the specimen twice.
    const twice = await f.specimen({ field: "2500033" });
    await f.conn.run(`INSERT INTO specimen_disposition (specimen_id, disposition, remarks, stated_by, stated_on, source) VALUES (${twice.id}, NULL, 'Recorded twice.', 'Old Beeline', DATE '2026-11-03', 'repair')`);
    await f.specimen({ field: "Ada Lovelace 12" });
    await f.specimen({ field: "2500035" });
    await f.specimen({ field: "2500035" });
    await f.specimen({ field: "1234567890123456789012345678" }); // BCBA_ and 28 digits: 33 characters
    const plan = await planWith(f);
    expect(inFile(plan, CURRENT_SEASON)).toEqual([ok.id, inCollection.id]);
    expect(plan.years[0]).toMatchObject({ labelNotDigits: 1, dispositionHeld: 2, unusable: 3 });
  });

  it("counts the specimens whose taxon is obscured, and those whose observer obscured theirs, apart, and leaves them out unless chosen", async () => {
    const f = await fixture();
    const plain = await f.specimen({ field: "2500020" });
    const taxon = await f.specimen({ field: "2500022", sample: { taxon_geoprivacy: "'obscured'" } });
    const taxonPrivate = await f.specimen({ field: "2500023", sample: { taxon_geoprivacy: "'private'" } });
    const observer = await f.specimen({ field: "2500024", sample: { geoprivacy: "'obscured'" } });
    const hidden = await f.specimen({ field: "2500025", sample: { geoprivacy: "'private'" } });
    const both = await f.specimen({ field: "2500026", sample: { geoprivacy: "'obscured'", taxon_geoprivacy: "'obscured'" } });
    const plan = await planWith(f);
    const year = plan.years[0]!;
    expect(year).toMatchObject({ taxonObscured: 3, observerObscured: 3 });
    expect(inFile(plan, CURRENT_SEASON)).toEqual([plain.id]);
    expect(inFile(plan, CURRENT_SEASON, { taxonObscured: true, observerObscured: false })).toEqual([plain.id, taxon.id, taxonPrivate.id]);
    expect(inFile(plan, CURRENT_SEASON, { taxonObscured: false, observerObscured: true })).toEqual([plain.id, observer.id, hidden.id]);
    // A specimen in both kinds goes only when both are chosen.
    expect(inFile(plan, CURRENT_SEASON, { taxonObscured: true, observerObscured: true })).toEqual(
      [plain.id, taxon.id, taxonPrivate.id, observer.id, hidden.id, both.id].sort((a, b) => a - b),
    );
  });

  it("offers a year only if it is an active season or the one that settled last, and Ecdysis holds none of its specimens", async () => {
    const f = await fixture();
    await f.specimen({ field: "2500001" });
    await f.specimen({ field: "2500002", year: SETTLED_SEASON });
    await f.specimen({ field: "2500003", year: CURRENT_SEASON - 6 });
    const plan = await planWith(f);
    expect(plan.years.map((y) => [y.year, y.offered, y.notOffered])).toEqual([
      [CURRENT_SEASON, true, null],
      [SETTLED_SEASON, true, null],
      [CURRENT_SEASON - 6, false, "older"],
    ]);
    // Ecdysis holds a specimen of the program from the settled year: that year is not offered, and says why.
    const held = await f.specimen({ field: "2500004", year: SETTLED_SEASON });
    await f.conn.run(`INSERT INTO specimen_catalog_number (specimen_id, catalog_number) VALUES (${held.id}, 'BCBA_2500004')`);
    const again = await planWith(f);
    expect(again.years.find((y) => y.year === SETTLED_SEASON)).toMatchObject({ offered: false, notOffered: "held" });
    expect(again.years.find((y) => y.year === CURRENT_SEASON)?.offered).toBe(true);
  });

  it("narrows by the Specimens listing's own filters, and every quality filter runs", async () => {
    const f = await fixture();
    const trap = await f.specimen({ field: "2500040", sample: { kind: "'trap'", protocol: "'blue vane trap'" } });
    const net = await f.specimen({ field: "2500041" });
    const query = (qs: string) => parseListingQuery(new URLSearchParams(qs), { atlasCodes: ["BC"] });
    expect(inFile(await planWith(f, [], query("kind=trap")), CURRENT_SEASON)).toEqual([trap.id]);
    expect(inFile(await planWith(f, [], query("kind=net")), CURRENT_SEASON)).toEqual([net.id]);
    expect(inFile(await planWith(f, [], query("collector=Nobody")), CURRENT_SEASON)).toEqual([]);
    // The statuses that read the flag roll-up (flagged, blocking, warning, clean) joined it for the listing and not for a file.
    for (const qc of QC_STATUSES) {
      const plan = await planWith(f, [], query(`qc=${qc}`));
      expect(plan.years.flatMap((y) => y.eligible.length)).toBeDefined();
    }
    expect(inFile(await planWith(f, [], query("qc=clean")), CURRENT_SEASON)).toEqual([trap.id, net.id]);
  });

  it("reports the country and state values that it had no spelling for, and writes them as they are", async () => {
    const f = await fixture();
    const odd = await f.specimen({ field: "2500050", sample: { state_province: "'AB'", country: "'CAN'" } });
    const plan = await planWith(f);
    expect(plan.unspelled).toEqual(["AB"]);
    const a = await archiveOf(f, [odd.id]);
    expect([a.occurrence.cell(0, "country"), a.occurrence.cell(0, "stateProvince")]).toEqual(["Canada", "AB"]);
  });
});

describe("the filters of a file are read as given or refused", () => {
  const problems = (qs: string) => {
    const params = new URLSearchParams(qs);
    return listingFilterProblems(params, parseListingQuery(params, { atlasCodes: ["BC", "WaBA"] }));
  };
  it("accepts the listing's filters, blank values, and 'any'", () => {
    expect(problems("kind=trap&collector=Casey%20Collector&det=any&q=")).toEqual([]);
    expect(problems("from=2026-06-01&to=2026-06-30&qc=blocking&flag=")).toEqual([]);
  });
  it("names a filter the parser would have ignored, so a mistyped one never gives the whole year", () => {
    expect(problems("kind=traps")).toEqual(["kind"]);
    expect(problems("from=2026-13-99")).toEqual(["from"]);
    expect(problems("qc=bad&det=nonsense")).toEqual(["qc", "det"]);
    expect(problems("area=nope")).toEqual(["area"]);
    expect(problems("member=nobody")).toEqual(["member"]);
  });
  it("refuses a parameter that is not a filter, or is given twice", () => {
    expect(problems("colector=Casey")).toEqual(["colector"]);
    expect(problems("scope=BC")).toEqual(["scope"]);
    expect(problems("labels=waiting&ecdysis=in&page=2&sort=date")).toEqual(["labels", "ecdysis", "page", "sort"]);
    expect(problems("kind=trap&kind=net")).toEqual(["kind"]);
  });
});

describe("when a file may be built", () => {
  it("is refused for Washington, which Beeline reads as a dataset and not as the whole collection", async () => {
    const f = await fixture();
    await f.cacheArchive(WABA, []);
    expect(await ecdysisRead(WABA, { ecdysisDir: f.dir })).toEqual({ ok: false, reason: "dataset", readAt: null });
    expect(await uploadStateOf(f.db, WABA, { ecdysisDir: f.dir })).toEqual({ ok: false, reason: "dataset", readAt: null });
  });

  it("is refused when no read has left its marker", async () => {
    const f = await fixture();
    expect(await ecdysisRead(BC, { ecdysisDir: f.dir })).toEqual({ ok: false, reason: "never", readAt: null });
    await writeFile(`${f.dir}/collection-196.read.json`, "not json");
    expect(await ecdysisRead(BC, { ecdysisDir: f.dir })).toEqual({ ok: false, reason: "never", readAt: null });
  });

  it("is refused when the last read is more than two hours old, and allowed just inside", async () => {
    const f = await fixture();
    expect(UPLOAD_FRESH_HOURS).toBe(2);
    await f.cacheArchive(BC, [], { readHoursAgo: UPLOAD_FRESH_HOURS + 0.5 });
    expect(await ecdysisRead(BC, { ecdysisDir: f.dir })).toMatchObject({ ok: false, reason: "stale" });
    await f.cacheArchive(BC, [], { readHoursAgo: UPLOAD_FRESH_HOURS - 0.5 });
    expect(await ecdysisRead(BC, { ecdysisDir: f.dir })).toMatchObject({ ok: true, archivePath: cachedArchivePath(f.dir, BC) });
  });

  it("is refused when the archive of the read is missing", async () => {
    const f = await fixture();
    await f.cacheArchive(BC, []);
    const { rm } = await import("node:fs/promises");
    await rm(cachedArchivePath(f.dir, BC));
    expect(await ecdysisRead(BC, { ecdysisDir: f.dir })).toMatchObject({ ok: false, reason: "no-archive" });
  });

  it("is refused when the zip on disk is not the one the read loaded: older than the marker says, or a different size", async () => {
    const f = await fixture();
    await f.cacheArchive(BC, ["BCBA_1"]);
    expect((await ecdysisRead(BC, { ecdysisDir: f.dir })).ok).toBe(true);
    // The zip's own time is not the marker's.
    await utimes(cachedArchivePath(f.dir, BC), new Date(Date.now() - 48 * HOUR), new Date(Date.now() - 48 * HOUR));
    expect(await ecdysisRead(BC, { ecdysisDir: f.dir })).toMatchObject({ ok: false, reason: "changed" });
    // A different archive in its place.
    await f.cacheArchive(BC, ["BCBA_1"]);
    await f.writeMarker(BC, 1, 1);
    expect((await ecdysisRead(BC, { ecdysisDir: f.dir })).ok).toBe(true);
    const bigger = await import("fflate");
    await writeFile(cachedArchivePath(f.dir, BC), bigger.zipSync({ "occurrences.tab": bigger.strToU8("id\tcatalogNumber\n1\tBCBA_1\n2\tBCBA_2\n") }));
    expect(await ecdysisRead(BC, { ecdysisDir: f.dir })).toMatchObject({ ok: false, reason: "changed" });
  });

  it("is refused when the archive holds fewer catalog numbers than Beeline has recorded from Ecdysis", async () => {
    const f = await fixture();
    const a = await f.specimen({ field: "2500001" });
    const b = await f.specimen({ field: "2500002" });
    for (const s of [a, b]) await f.conn.run(`INSERT INTO specimen_catalog_number (specimen_id, catalog_number) VALUES (${s.id}, 'BCBA_${s.id}')`);
    await f.cacheArchive(BC, [`BCBA_${a.id}`]);
    expect(await uploadStateOf(f.db, BC, { ecdysisDir: f.dir })).toMatchObject({ ok: false, reason: "incomplete" });
    await f.cacheArchive(BC, [`BCBA_${a.id}`, `BCBA_${b.id}`]);
    expect((await uploadStateOf(f.db, BC, { ecdysisDir: f.dir })).ok).toBe(true);
  });

  it("is refused when the archive cannot be read", async () => {
    const f = await fixture();
    await f.cacheArchive(BC, []);
    await writeFile(cachedArchivePath(f.dir, BC), "not a zip");
    await f.writeMarker(BC, 1);
    expect(await uploadStateOf(f.db, BC, { ecdysisDir: f.dir })).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("reads every catalog number from the cached archive, matched or not, whatever the case of the header, and shares one unpack between two requests", async () => {
    const f = await fixture();
    await f.cacheArchive(BC, ["BCBA_1", " BCBA_2 ", "bcba_3", ""], { header: "CATALOGNUMBER" });
    const path = cachedArchivePath(f.dir, BC);
    const [one, two] = await Promise.all([catalogNumbersInArchive(f.db, path, f.dir), catalogNumbersInArchive(f.db, path, f.dir)]);
    expect([...one].sort()).toEqual(["bcba_1", "bcba_2", "bcba_3"]);
    expect(two).toBe(one);
    expect(await catalogNumbersInArchive(f.db, path, f.dir)).toBe(one);
  });

  it("removes the folder an earlier unpack left behind", async () => {
    const f = await fixture();
    const { mkdir, readdir } = await import("node:fs/promises");
    await mkdir(`${f.dir}/upload-left-behind`);
    await writeFile(`${f.dir}/upload-left-behind/occurrences.tab`, "x");
    await f.cacheArchive(BC, ["BCBA_1"]);
    await catalogNumbersInArchive(f.db, cachedArchivePath(f.dir, BC), f.dir);
    expect((await readdir(f.dir)).filter((n) => n.startsWith("upload-"))).toEqual([]);
  });
});

describe("the rules hold when the rows are written", () => {
  it("leaves out a specimen that became obscured, marked missing, held in Ecdysis or unusable between the plan and the file", async () => {
    const f = await fixture();
    const stays = await f.specimen({ field: "2500001" });
    const obscured = await f.specimen({ field: "2500002" });
    const missing = await f.specimen({ field: "2500003" });
    const observerHid = await f.specimen({ field: "2500004" });
    const heldNow = await f.specimen({ field: "2500005" });
    const twin = await f.specimen({ field: "2500006" });
    const plan = await planWith(f);
    const ids = inFile(plan, CURRENT_SEASON);
    expect(ids).toHaveLength(6);
    // After the plan, before the file.
    await f.conn.run(`UPDATE sample SET taxon_geoprivacy = 'obscured' WHERE entity_id = ${obscured.sample}`);
    await f.conn.run(`INSERT INTO specimen_disposition (specimen_id, disposition, remarks, stated_by, stated_on, source) VALUES (${missing.id}, 'missing', 'No pin.', 'Inez', DATE '2026-11-03', 'inventory.xlsx')`);
    await f.conn.run(`UPDATE sample SET geoprivacy = 'private' WHERE entity_id = ${observerHid.sample}`);
    await f.conn.run(`INSERT INTO specimen_catalog_number (specimen_id, catalog_number) VALUES (${heldNow.id}, 'BCBA_2500005')`);
    await f.specimen({ field: "2500006" }); // a second specimen now carries the label number
    expect(twin.id).toBeGreaterThan(0);
    const a = await archiveOf(f, ids);
    expect(a.occurrence.body.map((r) => r[0])).toEqual([String(stays.id)]);
    expect(await eligibleNow(f.db, BC, ids, rulesOf())).toEqual([stays.id]);
    // The associations file is written under the same rules.
    await f.conn.run(`UPDATE sample SET inat_observation_id = 5 WHERE entity_id IN (${stays.sample}, ${obscured.sample})`);
    const csv = await associationsCsv(f.db, BC, ids, rulesOf());
    expect(csv.split("\n").filter((l) => l !== "")).toEqual([ASSOCIATION_HEADER.join(","), `BCBA_2500001,https://www.inaturalist.org/observations/5,`]);
  });

  it("writes every page of a long file, though rows were dropped from a page", async () => {
    const f = await fixture();
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push((await f.specimen({ field: `26000${i}` })).id);
    // Many more ids than there are specimens, as a plan that has gone stale: only the real ones are written, and the file ends.
    const a = await archiveOf(f, [...ids, 999999, 999998]);
    expect(a.occurrence.body).toHaveLength(3);
  });
});

describe("the upload archive", () => {
  it("declares each column's term in meta.xml in the order the file writes them", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "2500001" });
    const a = await archiveOf(f, [s.id]);
    const columns = uploadOccurrenceColumns(BC);
    expect(a.occurrence.header).toEqual(["id", ...columns.map(([h]) => h)]);
    expect(a.identification.header).toEqual(["coreid", ...UPLOAD_IDENTIFICATION_COLUMNS.map(([h]) => h)]);
    const meta = a.files["meta.xml"]!;
    columns.forEach(([, term], i) => expect(meta).toContain(`<field index="${i + 1}" term="${term}"/>`));
    UPLOAD_IDENTIFICATION_COLUMNS.forEach(([, term], i) => expect(meta).toContain(`<field index="${i + 1}" term="${term}"/>`));
    expect(meta).toContain('term="https://symbiota.org/terms/eventDate2"');
    expect(meta).toContain('term="https://symbiota.org/terms/identificationIsCurrent"');
    expect(meta).not.toContain("default=");
    expect(a.occurrence.header).not.toContain("occurrenceID");
    expect(a.occurrence.header).not.toContain("sampleNumber");
    expect(a.occurrence.header).not.toContain("geoprivacy");
    expect(Object.keys(a.files).sort()).toEqual(["identification.txt", "meta.xml", "occurrence.txt"]);
  });

  it("declares the fixed values for each collection: Washington's records carry a label project, British Columbia's none yet", async () => {
    expect(uploadOccurrenceColumns(WABA).map(([h]) => h)).toContain("labelProject");
    expect(uploadOccurrenceColumns(BC).map(([h]) => h)).not.toContain("labelProject");
    expect(uploadOccurrenceColumns(WABA).find(([h]) => h === "labelProject")![1]).toBe("https://symbiota.org/terms/labelProject");
    const f = await fixture();
    const s = await f.specimen({ field: "2500001", program: "WaBA" });
    const a = await archiveOf(f, [s.id], WABA, { ...rulesOf() });
    expect([a.occurrence.cell(0, "labelProject"), a.occurrence.cell(0, "catalogNumber"), a.occurrence.cell(0, "stateProvince")]).toEqual(["Washington Bee Atlas", "WSDA_2500001", "Washington"]);
  });

  it("writes a net sample's specimen as the label has it, with the constants as real columns", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "2500001", n: 4, sample: { host_name_as_observed: "'Salvia officinalis'", host_rank: "'species'", inat_observation_id: "123456" } });
    const a = await archiveOf(f, [s.id]);
    const cell = (c: string) => a.occurrence.cell(0, c);
    expect(a.occurrence.body[0]![0]).toBe(String(s.id));
    expect(cell("catalogNumber")).toBe("BCBA_2500001");
    expect(cell("basisOfRecord")).toBe("PreservedSpecimen");
    expect(cell("fieldNumber")).toMatch(/^S\d+$/);
    expect(cell("recordNumber")).toBe(`${cell("fieldNumber")}.4`);
    expect(cell("eventDate")).toBe(`${CURRENT_SEASON}-07-14`);
    expect(cell("eventDate2")).toBe("");
    expect(cell("country")).toBe("Canada");
    expect(cell("stateProvince")).toBe("British Columbia");
    expect(cell("county")).toBe("Kittitas");
    expect(cell("locality")).toBe("Umtanum Creek");
    expect(cell("verbatimCoordinates")).toBe("Umtanum Creek");
    expect(cell("decimalLatitude")).toBe("44.5646");
    expect(cell("decimalLongitude")).toBe("-123.262");
    expect(cell("geodeticDatum")).toBe("WGS84");
    expect(cell("coordinateUncertaintyInMeters")).toBe("30");
    expect(cell("minimumElevationInMeters")).toBe("72");
    expect(cell("lifeStage")).toBe("adult");
    expect(cell("preparations")).toBe("pinned");
    expect(cell("individualCount")).toBe("1");
    expect(cell("samplingProtocol")).toBe("net");
    expect(cell("recordedBy")).toBe("Casey Collector");
    expect(cell("associatedTaxa")).toBe('"visits flowers of":"Salvia officinalis"');
  });

  it("writes the first day in eventDate and the last in eventDate2, for a trap sample", async () => {
    const f = await fixture();
    const s = await f.specimen({
      field: "2500002",
      sample: { kind: "'trap'", protocol: "'blue vane trap'", date_start: `DATE '${CURRENT_SEASON}-06-01'`, date_end: `DATE '${CURRENT_SEASON}-06-05'`, host_name_as_observed: "'Ceanothus'", host_rank: "'genus'" },
    });
    const a = await archiveOf(f, [s.id]);
    expect([a.occurrence.cell(0, "eventDate"), a.occurrence.cell(0, "eventDate2")]).toEqual([`${CURRENT_SEASON}-06-01`, `${CURRENT_SEASON}-06-05`]);
    expect(a.occurrence.cell(0, "associatedTaxa")).toBe('"near":"Ceanothus"');
  });

  it("names the record only where the determination of record is an expert's, and writes the caste where Symbiota keeps it", async () => {
    const f = await fixture();
    const expert = await f.specimen({ field: "2500003" });
    await f.determine(expert.id, "Bombus mixtus", { person: f.eva }, true, { on: "2026-06-02", sex: "female", caste: "worker", qualifier: "cf." });
    const volunteer = await f.specimen({ field: "2500004" });
    await f.determine(volunteer.id, "Bombus vosnesenskii", { person: f.vic }, false, { on: "2026-06-03", sex: "male" });
    const nobody = await f.specimen({ field: "2500005" });
    const a = await archiveOf(f, [expert.id, volunteer.id, nobody.id]);
    const row = (id: number) => a.occurrence.body.findIndex((r) => r[0] === String(id));
    const name = ["scientificName", "scientificNameAuthorship", "identificationQualifier", "identifiedBy", "dateIdentified", "sex", "reproductiveCondition"];
    expect(name.map((c) => a.occurrence.cell(row(expert.id), c))).toEqual(["Bombus mixtus", "Cresson, 1878", "cf.", "Eva Expert", "2026-06-02", "female", "worker"]);
    expect(name.map((c) => a.occurrence.cell(row(volunteer.id), c))).toEqual(["", "", "", "", "", "", ""]);
    expect(name.map((c) => a.occurrence.cell(row(nobody.id), c))).toEqual(["", "", "", "", "", "", ""]);
  });

  it("names the record from an expert's determination whose determiner has no name", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "2500006" });
    await f.determine(s.id, "Bombus mixtus", {}, true, { recorded: "2026-05-02 10:00:00" });
    const a = await archiveOf(f, [s.id]);
    expect([a.occurrence.cell(0, "scientificName"), a.occurrence.cell(0, "identifiedBy")]).toEqual(["Bombus mixtus", ""]);
    expect(a.identification.body.map((r) => [r[a.identification.header.indexOf("scientificName")], r[a.identification.header.indexOf("identifiedBy")], r[a.identification.header.indexOf("identificationIsCurrent")]])).toEqual([["Bombus mixtus", "", "1"]]);
  });

  it("writes every determination as history, current only on an expert's determination of record", async () => {
    const f = await fixture();
    const expert = await f.specimen({ field: "2500007" });
    await f.determine(expert.id, "Bombus vosnesenskii", { person: f.vic }, false, { recorded: "2026-05-01 10:00:00" });
    await f.determine(expert.id, "Bombus mixtus", { person: f.eva }, true, { on: "2026-06-02", recorded: "2026-05-02 10:00:00" });
    const volunteerOnly = await f.specimen({ field: "2500008" });
    await f.determine(volunteerOnly.id, "Bombus vosnesenskii", { person: f.vic }, false, { recorded: "2026-05-01 10:00:00" });
    await f.determine(volunteerOnly.id, "Andrena prunorum", { name: "Other Volunteer" }, false, { recorded: "2026-05-03 10:00:00" });
    const a = await archiveOf(f, [expert.id, volunteerOnly.id]);
    const of = (id: number) => a.identification.body.filter((r) => r[0] === String(id));
    const col = (r: string[], c: string) => r[a.identification.header.indexOf(c)];
    expect(of(expert.id).map((r) => [col(r!, "scientificName"), col(r!, "identificationIsCurrent")])).toEqual([["Bombus vosnesenskii", "0"], ["Bombus mixtus", "1"]]);
    expect(of(volunteerOnly.id).map((r) => col(r!, "identificationIsCurrent"))).toEqual(["0", "0"]);
    const ids = ((await rows(f.conn, `SELECT entity_id FROM determination WHERE specimen_id = ${expert.id} ORDER BY recorded_at`)) as [[number]][]).map((r) => String(r[0]));
    expect(of(expert.id).map((r) => col(r!, "sourceIdentifier"))).toEqual(ids);
  });

  it("merges determinations that agree on name, determiner and date, current if any of them is", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "2500009" });
    await f.determine(s.id, "Bombus mixtus", { person: f.eva }, true, { recorded: "2026-05-01 10:00:00" });
    await f.determine(s.id, "Bombus mixtus", { person: f.eva }, true, { recorded: "2026-05-02 10:00:00", qualifier: "cf." });
    await f.determine(s.id, "Bombus mixtus", { person: f.eva }, true, { recorded: "2026-05-03 10:00:00", on: "2026-06-01" });
    await f.determine(s.id, "Bombus mixtus", { person: f.vic }, false, { recorded: "2026-05-04 10:00:00" });
    const a = await archiveOf(f, [s.id]);
    const col = (r: string[], c: string) => r[a.identification.header.indexOf(c)];
    expect(a.identification.body.map((r) => [col(r, "identifiedBy"), col(r, "dateIdentified"), col(r, "identificationIsCurrent")])).toEqual([["Eva Expert", "", "0"], ["Eva Expert", "2026-06-01", "1"], ["Vic Volunteer", "", "0"]]);
    const t = await f.specimen({ field: "2500010" });
    await f.determine(t.id, "Bombus mixtus", { person: f.eva }, true, { recorded: "2026-05-01 10:00:00" });
    await f.determine(t.id, "Bombus mixtus", { person: f.eva }, true, { recorded: "2026-05-02 10:00:00" });
    const b = await archiveOf(f, [t.id]);
    expect(b.identification.body).toHaveLength(1);
    expect(b.identification.body[0]![b.identification.header.indexOf("identificationIsCurrent")]).toBe("1");
  });

  it("compares as Symbiota does: without accents or case, and with runs of white space as one", () => {
    expect(symbiotaKey("  Pérez   Cruz ")).toBe("perez cruz");
    expect(symbiotaKey("PEREZ\tCRUZ")).toBe("perez cruz");
    const d = (id: number, determiner: string, current: boolean) =>
      ({ specimen_id: 1, determination_id: id, scientific_name: "Bombus mixtus", authorship: null, rank: "species", qualifier: null, verbatim_identification: null, determiner, determiner_orcid: null, determined_on: null, determined_on_precision: null, sex: null, caste: null, is_expert: true, of_record: current }) as never;
    const merged = uploadIdentificationRows([d(1, "José Pérez", false), d(2, "Jose  PEREZ", true), d(3, "José Perez Other", false)]);
    expect(merged.map((r) => [r[4], r[6], r[7]])).toEqual([["Jose  PEREZ", 1, 2], ["José Perez Other", 0, 3]]);
  });

  it("writes a specimen's tab as a space, and nothing is quoted", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "2500011", sample: { locality: "'Rock\tCreek'" } });
    const a = await archiveOf(f, [s.id]);
    expect(a.occurrence.cell(0, "locality")).toBe("Rock Creek");
  });
});

describe("the associations file", () => {
  it("has exactly the three headers Symbiota maps, one row for each specimen whose sample has an observation", async () => {
    const f = await fixture();
    const species = await f.specimen({ field: "2500001", sample: { inat_observation_id: "111", host_name_as_observed: "'Salvia officinalis'", host_rank: "'species'" } });
    const genus = await f.specimen({ field: "2500002", sample: { inat_observation_id: "222", host_name_as_observed: "'Ceanothus'", host_rank: "'genus'" } });
    const noHost = await f.specimen({ field: "2500003", sample: { inat_observation_id: "333" } });
    const noObservation = await f.specimen({ field: "2500004" });
    const gone = await f.specimen({ field: "2500005", sample: { inat_observation_id: "444" } });
    await f.conn.run(`INSERT INTO observation_absent (inat_id) VALUES (444)`);
    const quoted = await f.specimen({ field: "2500006", sample: { inat_observation_id: "555", host_name_as_observed: "'Rosa, \"wild\"'", host_rank: "'genus'" } });
    const ids = [species, genus, noHost, noObservation, gone, quoted].map((s) => s.id);
    const csv = await associationsCsv(f.db, BC, ids, rulesOf());
    expect([...ASSOCIATION_HEADER]).toEqual(["subject identifier: catalogNumber", "resourceUrl", "verbatimSciname"]);
    expect(csv.split("\n").filter((l) => l !== "")).toEqual([
      "subject identifier: catalogNumber,resourceUrl,verbatimSciname",
      "BCBA_2500001,https://www.inaturalist.org/observations/111,Salvia officinalis",
      "BCBA_2500002,https://www.inaturalist.org/observations/222,Ceanothus",
      "BCBA_2500003,https://www.inaturalist.org/observations/333,",
      'BCBA_2500006,https://www.inaturalist.org/observations/555,"Rosa, ""wild"""',
    ]);
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("leaves the host empty for a trap, where the plant is only near it", async () => {
    const f = await fixture();
    const trap = await f.specimen({ field: "2500007", sample: { kind: "'trap'", protocol: "'blue vane trap'", inat_observation_id: "666", host_name_as_observed: "'Ceanothus'", host_rank: "'genus'" } });
    const pan = await f.specimen({ field: "2500008", sample: { kind: "'trap'", protocol: "'pan trap'", inat_observation_id: "667", host_name_as_observed: "'Rosa'", host_rank: "'genus'" } });
    const net = await f.specimen({ field: "2500009", sample: { inat_observation_id: "668", host_name_as_observed: "'Salvia'", host_rank: "'genus'" } });
    const csv = await associationsCsv(f.db, BC, [trap.id, pan.id, net.id], rulesOf());
    expect(csv.split("\n").filter((l) => l !== "").slice(1)).toEqual([
      "BCBA_2500007,https://www.inaturalist.org/observations/666,",
      "BCBA_2500008,https://www.inaturalist.org/observations/667,",
      "BCBA_2500009,https://www.inaturalist.org/observations/668,Salvia",
    ]);
  });

  it("writes a name beginning with a formula character as it is, not behind an apostrophe", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "2500012", sample: { inat_observation_id: "669", host_name_as_observed: "'-unknown plant'" } });
    expect(await associationsCsv(f.db, BC, [s.id], rulesOf())).toContain(",-unknown plant\n");
  });

  it("has the header alone for no specimens", async () => {
    const f = await fixture();
    expect(await associationsCsv(f.db, BC, [], rulesOf())).toBe("subject identifier: catalogNumber,resourceUrl,verbatimSciname\n");
  });
});

describe("one archive for each read of Ecdysis", () => {
  const record = (f: F, over: Partial<Parameters<typeof recordDownload>[1]> = {}) =>
    recordDownload(f.db, { collection: BC, year: CURRENT_SEASON, filters: "kind=trap", include: { taxonObscured: true, observerObscured: false }, specimens: 5, readAt: new Date(Date.now() - HOUR), personId: f.eva, ...over });

  it("records who took which archive, with the filters and the choice, and finds the latest", async () => {
    const f = await fixture();
    expect(await latestDownload(f.db, BC)).toBeNull();
    await record(f, { specimens: 3 });
    await record(f, { specimens: 9, personId: null });
    const latest = (await latestDownload(f.db, BC))!;
    expect(latest).toMatchObject({ collection: "BC", year: CURRENT_SEASON, filters: "kind=trap", specimens: 9, by: null, include: { taxonObscured: true, observerObscured: false } });
    expect(await latestDownload(f.db, WABA)).toBeNull();
  });

  it("offers no second archive after a download that came after the last read, and offers one after a newer read", async () => {
    const f = await fixture();
    await f.specimen({ field: "2500001" });
    await f.cacheArchive(BC, [], { readHoursAgo: 1 });
    const before = await uploadStateOf(f.db, BC, { ecdysisDir: f.dir });
    expect(before).toMatchObject({ ok: true, download: null });
    // Taken 30 minutes ago, after the read an hour ago.
    await record(f, { readAt: new Date(Date.now() - HOUR), personId: f.eva });
    await f.conn.run(`UPDATE ecdysis_upload_download SET downloaded_at = now() - INTERVAL '30 minutes'`);
    const after = (await uploadStateOf(f.db, BC, { ecdysisDir: f.dir })) as Extract<Awaited<ReturnType<typeof uploadStateOf>>, { ok: true }>;
    expect(after.download).toMatchObject({ by: "Eva Expert", year: CURRENT_SEASON, specimens: 5 });
    // The read that ran again, after the upload.
    await f.cacheArchive(BC, [], { readHoursAgo: 0.1 });
    expect(await uploadStateOf(f.db, BC, { ecdysisDir: f.dir })).toMatchObject({ ok: true, download: null });
  });

  it("records a download when its stream ends, and not when it is abandoned or fails", async () => {
    const make = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); c.enqueue(new Uint8Array([2])); c.close(); } });
    let recorded = 0;
    let released = 0;
    await new Response(recordWhenComplete(make(), async () => void recorded++, () => void released++)).arrayBuffer();
    expect([recorded, released]).toEqual([1, 1]);
    // The reader goes away part way: released, nothing recorded.
    const abandoned = recordWhenComplete(make(), async () => void recorded++, () => void released++);
    const reader = abandoned.getReader();
    await reader.read();
    await reader.cancel();
    expect([recorded, released]).toEqual([1, 2]);
    // The source fails.
    const failing = new ReadableStream<Uint8Array>({ pull() { throw new Error("store down"); } });
    await expect(new Response(recordWhenComplete(failing, async () => void recorded++, () => void released++)).arrayBuffer()).rejects.toThrow();
    expect([recorded, released]).toEqual([1, 3]);
  });

  it("lets one archive for a collection be written at a time", () => {
    expect(claimDownload(BC)).toBe(true);
    expect(claimDownload(BC)).toBe(false);
    releaseDownload(BC);
    expect(claimDownload(BC)).toBe(true);
    releaseDownload(BC);
  });
});

describe("file names", () => {
  it("carry the collection, the year, the specimen count and the day written, in Pacific time", () => {
    const at = new Date("2026-11-21T20:05:07Z");
    expect(uploadFileName(BC, 2026, at, "archive", 8100)).toBe("ecdysis-upload-BC-2026-8100-specimens-2026-11-21-120507.zip");
    expect(uploadFileName(BC, 2026, at, "associations", 7)).toBe("ecdysis-associations-BC-2026-7-specimens-2026-11-21-120507.csv");
  });
});
