import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { cachedArchivePath, detailSaysRead } from "../src/fetch-ecdysis.js";
import { parseListingQuery } from "../src/app/listings.js";
import {
  ASSOCIATION_HEADER,
  associationsCsv,
  catalogNumbersInArchive,
  ecdysisRead,
  planUpload,
  uploadArchiveStream,
  uploadFileName,
  UPLOAD_FRESH_HOURS,
  UPLOAD_IDENTIFICATION_COLUMNS,
  UPLOAD_OCCURRENCE_COLUMNS,
  type UploadPlan,
} from "../src/app/ecdysis-upload.js";
import { CURRENT_SEASON, SETTLED_SEASON, insertCleanSample, rows } from "./helpers.js";

/**
 * The upload to Ecdysis (beeline-8dx9.12): which specimens, when it may be
 * built, what the two files say. Names and places are invented.
 */

import { BC, fixture, HOUR, readDetail, WABA } from "./ecdysis-upload-fixture.js";

/** The plan for a collection with the given catalog numbers already in Ecdysis. */
const planWith = async (f: Awaited<ReturnType<typeof fixture>>, c: typeof WABA, held: string[] = [], query = parseListingQuery(new URLSearchParams(), { atlasCodes: [] })) =>
  planUpload(f.db, c, { readAt: new Date(), held: new Set(held.map((n) => n.toLowerCase())) }, query);

const idsOf = (plan: UploadPlan, year: number) => plan.years.find((y) => y.year === year)?.specimenIds ?? [];

/** The archive as tables of cells. */
async function archiveOf(f: Awaited<ReturnType<typeof fixture>>, c: typeof WABA, ids: number[]) {
  const stream = uploadArchiveStream(f.db, c, ids);
  const files = Object.fromEntries(Object.entries(unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()))).map(([n, d]) => [n, strFromU8(d)]));
  const table = (name: string) => {
    const [header, ...body] = files[name]!.split("\n").filter((l) => l !== "").map((l) => l.split("\t"));
    return { header: header!, body, cell: (r: number, col: string) => body[r]![header!.indexOf(col)] };
  };
  return { files, occurrence: table("occurrence.txt"), identification: table("identification.txt") };
}

describe("which specimens go in a file", () => {
  it("takes a program's printed, unmissing specimens that Ecdysis does not hold, by collection year", async () => {
    const f = await fixture();
    const wanted = await f.specimen({ field: "25000001" });
    const lastYear = await f.specimen({ field: "25000002", year: SETTLED_SEASON });
    // Each of the rules, alone.
    const held = await f.specimen({ field: "25000003" });
    await f.conn.run(`INSERT INTO specimen_catalog_number (specimen_id, catalog_number) VALUES (${held.id}, 'WSDA_25000003')`);
    const missing = await f.specimen({ field: "25000004" });
    await f.conn.run(
      `INSERT INTO specimen_disposition (specimen_id, disposition, remarks, stated_by, stated_on, source) VALUES (${missing.id}, 'missing', 'No pin.', 'Inez Inventory', DATE '2026-11-03', 'inventory.xlsx')`,
    );
    const noNumber = await f.specimen({ field: null });
    const otherProgram = await f.specimen({ field: "25000006", program: "OBA" });
    const bc = await f.specimen({ field: "25000007", program: "BC" });

    const plan = await planWith(f, WABA);
    expect(idsOf(plan, CURRENT_SEASON)).toEqual([wanted.id]);
    expect(idsOf(plan, SETTLED_SEASON)).toEqual([lastYear.id]);
    const all = plan.years.flatMap((y) => y.specimenIds);
    for (const left of [held, missing, noNumber, otherProgram, bc]) expect(all).not.toContain(left.id);
    // The other collection's file is its own.
    expect((await planWith(f, BC)).years.flatMap((y) => y.specimenIds)).toEqual([bc.id]);
  });

  it("leaves out a specimen whose label is not on paper yet", async () => {
    const f = await fixture();
    const printed = await f.specimen({ field: "25000001" });
    // A run that has numbered a sample's labels and not printed them.
    const { prepareRun } = await import("../src/print-run.js");
    await insertCleanSample(f.conn, {
      sample_number: "'S-PREPARED'",
      specimen_count: "1",
      date_start: `DATE '${CURRENT_SEASON}-07-14'`,
      date_end: `DATE '${CURRENT_SEASON}-07-14'`,
      atlas_id: "(SELECT entity_id FROM program WHERE code = 'WaBA')",
    });
    const [[staff]] = (await rows(f.conn, `INSERT INTO person (display_name) VALUES ('Sam Staff') RETURNING entity_id`)) as [[number]];
    const run = await prepareRun(f.conn, { atlasId: null, personId: staff });
    expect(run?.labels).toBe(1);
    const [[prepared]] = (await rows(f.conn, `SELECT entity_id FROM specimen WHERE sample_id = (SELECT entity_id FROM sample WHERE sample_number = 'S-PREPARED')`)) as [[number]];
    const [[numbered]] = (await rows(f.conn, `SELECT field_number FROM specimen WHERE entity_id = ${prepared}`)) as [[string | null]];
    expect(numbered).not.toBeNull();
    const plan = await planWith(f, WABA);
    expect(plan.years.flatMap((y) => y.specimenIds)).toEqual([printed.id]);
  });

  it("leaves out a specimen whose would-be catalog number is in the Ecdysis archive but matched to no specimen", async () => {
    const f = await fixture();
    const unknownToBeeline = await f.specimen({ field: "25000010" });
    const fresh = await f.specimen({ field: "25000011" });
    // Beeline's store has no catalog row for the first: the loader could not match its Ecdysis record (an ambiguous label number, say).
    const [[rowsHeld]] = (await rows(f.conn, `SELECT count(*) FROM specimen_catalog_number`)) as [[number]];
    expect(Number(rowsHeld)).toBe(0);
    const plan = await planWith(f, WABA, ["WSDA_25000010", "WSDA_99999999"]);
    expect(plan.years.flatMap((y) => y.specimenIds)).toEqual([fresh.id]);
    expect(unknownToBeeline.id).not.toBe(fresh.id);
    // The comparison is the database's: case does not matter, and the prefix belongs to the collection.
    expect((await planWith(f, WABA, ["wsda_25000010"])).years.flatMap((y) => y.specimenIds)).toEqual([fresh.id]);
    expect((await planWith(f, WABA, ["BCBA_25000010"])).years.flatMap((y) => y.specimenIds)).toEqual([unknownToBeeline.id, fresh.id]);
  });

  it("counts the specimens whose taxon is obscured or private apart, and leaves them out", async () => {
    const f = await fixture();
    const plain = await f.specimen({ field: "25000020" });
    const open = await f.specimen({ field: "25000021", sample: { taxon_geoprivacy: "NULL" } });
    const obscured = await f.specimen({ field: "25000022", sample: { taxon_geoprivacy: "'obscured'" } });
    const hidden = await f.specimen({ field: "25000023", sample: { taxon_geoprivacy: "'private'" }, year: SETTLED_SEASON });
    const plan = await planWith(f, WABA);
    expect(idsOf(plan, CURRENT_SEASON)).toEqual([plain.id, open.id]);
    expect(plan.years.find((y) => y.year === CURRENT_SEASON)).toMatchObject({ obscured: 1, unusable: 0 });
    expect(plan.years.find((y) => y.year === SETTLED_SEASON)).toMatchObject({ obscured: 1, specimenIds: [] });
    const everyone = plan.years.flatMap((y) => y.specimenIds);
    expect(everyone).not.toContain(obscured.id);
    expect(everyone).not.toContain(hidden.id);
  });

  it("leaves out a label number on two specimens, or a catalog number longer than Symbiota's column, and counts them", async () => {
    const f = await fixture();
    const ok = await f.specimen({ field: "25000030" });
    await f.specimen({ field: "25000031" });
    await f.specimen({ field: "25000031" });
    await f.specimen({ field: "1234567890123456789012345678" }); // WSDA_ plus 28 characters: 33
    const plan = await planWith(f, WABA);
    expect(idsOf(plan, CURRENT_SEASON)).toEqual([ok.id]);
    expect(plan.years[0]!.unusable).toBe(3);
  });

  it("narrows by the Specimens listing's own filters", async () => {
    const f = await fixture();
    const trap = await f.specimen({ field: "25000040", sample: { kind: "'trap'", protocol: "'blue vane trap'" } });
    const net = await f.specimen({ field: "25000041" });
    const query = (qs: string) => parseListingQuery(new URLSearchParams(qs), { atlasCodes: ["WaBA"] });
    expect(idsOf(await planWith(f, WABA, [], query("kind=trap")), CURRENT_SEASON)).toEqual([trap.id]);
    expect(idsOf(await planWith(f, WABA, [], query("kind=net")), CURRENT_SEASON)).toEqual([net.id]);
    expect(idsOf(await planWith(f, WABA, [], query("collector=Nobody")), CURRENT_SEASON)).toEqual([]);
    // What the rules decide is not the listing's to override: a scope, labels or ecdysis filter of its own changes nothing.
    expect(idsOf(await planWith(f, WABA, [], query("scope=BC&labels=waiting&ecdysis=in")), CURRENT_SEASON)).toEqual([trap.id, net.id]);
  });

  it("reports the country and state values that it had no spelling for, and writes them as they are", async () => {
    const f = await fixture();
    const odd = await f.specimen({ field: "25000050", sample: { state_province: "'ID'", country: "'USA'" } });
    const plan = await planWith(f, WABA);
    expect(plan.unspelled).toEqual(["ID"]);
    const a = await archiveOf(f, WABA, [odd.id]);
    expect([a.occurrence.cell(0, "country"), a.occurrence.cell(0, "stateProvince")]).toEqual(["United States", "ID"]);
  });
});

describe("when a file may be built", () => {
  const withDir = async () => {
    const f = await fixture();
    return f;
  };

  it("is refused when no read of Ecdysis has succeeded for the collection", async () => {
    const f = await withDir();
    expect(await ecdysisRead(f.db, WABA, { ecdysisDir: f.dir })).toEqual({ ok: false, reason: "never", readAt: null });
    // A read that found nothing to do because there was no login is not a read.
    await f.readHoursAgo(1, "no Ecdysis login (ECDYSIS_USERNAME / ECDYSIS_PASSWORD) — nothing to fetch");
    // Nor is a run that failed before it read this collection.
    await f.readHoursAgo(2, "WaBA failed: Ecdysis API answered 500", "failed");
    expect((await ecdysisRead(f.db, WABA, { ecdysisDir: f.dir })).ok).toBe(false);
  });

  it("is refused when the last read is more than 36 hours old, and allowed just inside", async () => {
    const f = await withDir();
    await f.cacheArchive(WABA, []);
    await f.readHoursAgo(UPLOAD_FRESH_HOURS + 1, readDetail(WABA));
    const stale = await ecdysisRead(f.db, WABA, { ecdysisDir: f.dir });
    expect(stale).toMatchObject({ ok: false, reason: "stale" });
    await f.readHoursAgo(UPLOAD_FRESH_HOURS - 1, readDetail(WABA, "downloaded"));
    const fresh = await ecdysisRead(f.db, WABA, { ecdysisDir: f.dir });
    expect(fresh).toMatchObject({ ok: true, archivePath: cachedArchivePath(f.dir, WABA) });
  });

  it("is refused when the archive of the read is missing, though the read succeeded", async () => {
    const f = await withDir();
    await f.readHoursAgo(3, readDetail(WABA));
    expect(await ecdysisRead(f.db, WABA, { ecdysisDir: f.dir })).toMatchObject({ ok: false, reason: "no-archive" });
  });

  it("counts a night on which another collection failed, for the collection that was read", async () => {
    const f = await withDir();
    await f.cacheArchive(WABA, []);
    await f.readHoursAgo(2, `${readDetail(WABA)}; BC failed: Ecdysis download answered 500`, "failed");
    expect((await ecdysisRead(f.db, WABA, { ecdysisDir: f.dir })).ok).toBe(true);
    expect(await ecdysisRead(f.db, BC, { ecdysisDir: f.dir })).toEqual({ ok: false, reason: "never", readAt: null });
  });

  it("takes the newest read, and says when it started", async () => {
    const f = await withDir();
    await f.cacheArchive(WABA, []);
    await f.readHoursAgo(30, readDetail(WABA));
    await f.readHoursAgo(5, readDetail(WABA));
    const read = await ecdysisRead(f.db, WABA, { ecdysisDir: f.dir, now: new Date() });
    expect(read.ok).toBe(true);
    expect(Date.now() - read.readAt!.getTime()).toBeGreaterThan(4.9 * HOUR);
    expect(Date.now() - read.readAt!.getTime()).toBeLessThan(5.1 * HOUR);
  });

  it("knows which collection a job's detail says was read", () => {
    expect(detailSaysRead(readDetail(WABA), WABA)).toBe(true);
    expect(detailSaysRead(readDetail(WABA), BC)).toBe(false);
    expect(detailSaysRead(`${readDetail(WABA)}; ${readDetail(BC, "downloaded")}`, BC)).toBe(true);
    expect(detailSaysRead("BC failed: dataset 44 downloaded (x)", WABA)).toBe(false);
    expect(detailSaysRead(null, WABA)).toBe(false);
  });

  it("reads every catalog number from the cached archive, matched or not, and keeps the answer for one file", async () => {
    const f = await withDir();
    await f.cacheArchive(WABA, ["WSDA_1", " WSDA_2 ", "wsda_3", ""]);
    const held = await catalogNumbersInArchive(f.db, cachedArchivePath(f.dir, WABA), f.dir);
    expect([...held].sort()).toEqual(["wsda_1", "wsda_2", "wsda_3"]);
    expect(await catalogNumbersInArchive(f.db, cachedArchivePath(f.dir, WABA), f.dir)).toBe(held);
  });
});

describe("the upload archive", () => {
  it("declares each column's term in meta.xml in the order the file writes them", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "25000001" });
    const a = await archiveOf(f, WABA, [s.id]);
    expect(a.occurrence.header).toEqual(["id", ...UPLOAD_OCCURRENCE_COLUMNS.map(([h]) => h)]);
    expect(a.identification.header).toEqual(["coreid", ...UPLOAD_IDENTIFICATION_COLUMNS.map(([h]) => h)]);
    const meta = a.files["meta.xml"]!;
    UPLOAD_OCCURRENCE_COLUMNS.forEach(([, term], i) => expect(meta).toContain(`<field index="${i + 1}" term="${term}"/>`));
    UPLOAD_IDENTIFICATION_COLUMNS.forEach(([, term], i) => expect(meta).toContain(`<field index="${i + 1}" term="${term}"/>`));
    expect(meta).toContain('term="https://symbiota.org/terms/eventDate2"');
    expect(meta).toContain('term="https://symbiota.org/terms/identificationIsCurrent"');
    expect(meta).not.toContain("default=");
    // No occurrenceID, and none of Beeline's own undeclared columns.
    expect(a.occurrence.header).not.toContain("occurrenceID");
    expect(a.occurrence.header).not.toContain("sampleNumber");
    expect(a.occurrence.header).not.toContain("geoprivacy");
    expect(Object.keys(a.files).sort()).toEqual(["identification.txt", "meta.xml", "occurrence.txt"]);
  });

  it("writes a net sample's specimen as the label has it, with the constants as real columns", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "25000001", n: 4, sample: { host_name_as_observed: "'Salvia officinalis'", host_rank: "'species'", inat_observation_id: "123456" } });
    const a = await archiveOf(f, WABA, [s.id]);
    const cell = (c: string) => a.occurrence.cell(0, c);
    expect(a.occurrence.body[0]![0]).toBe(String(s.id));
    expect(cell("catalogNumber")).toBe("WSDA_25000001");
    expect(cell("basisOfRecord")).toBe("PreservedSpecimen");
    expect(cell("fieldNumber")).toMatch(/^S\d+$/);
    expect(cell("recordNumber")).toBe(`${cell("fieldNumber")}.4`);
    expect(cell("eventDate")).toBe(`${CURRENT_SEASON}-07-14`);
    expect(cell("eventDate2")).toBe("");
    expect(cell("country")).toBe("United States");
    expect(cell("stateProvince")).toBe("Washington");
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
    // As the program archive writes it: the relationship word, the host at the rank Beeline holds.
    expect(cell("associatedTaxa")).toBe('"visits flowers of":"Salvia officinalis"');
  });

  it("writes British Columbia's country and province spelled out, with its own prefix", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "2404406", program: "BC" });
    const a = await archiveOf(f, BC, [s.id]);
    expect([a.occurrence.cell(0, "catalogNumber"), a.occurrence.cell(0, "country"), a.occurrence.cell(0, "stateProvince")]).toEqual(["BCBA_2404406", "Canada", "British Columbia"]);
  });

  it("writes the first day in eventDate and the last in eventDate2, for a trap sample", async () => {
    const f = await fixture();
    const s = await f.specimen({
      field: "25000002",
      sample: { kind: "'trap'", protocol: "'blue vane trap'", date_start: `DATE '${CURRENT_SEASON}-06-01'`, date_end: `DATE '${CURRENT_SEASON}-06-05'`, host_name_as_observed: "'Ceanothus'", host_rank: "'genus'" },
    });
    const a = await archiveOf(f, WABA, [s.id]);
    expect([a.occurrence.cell(0, "eventDate"), a.occurrence.cell(0, "eventDate2")]).toEqual([`${CURRENT_SEASON}-06-01`, `${CURRENT_SEASON}-06-05`]);
    expect(a.occurrence.cell(0, "samplingProtocol")).toBe("blue vane trap");
    // A trap does not say which flower, and a host at genus rank is written as held.
    expect(a.occurrence.cell(0, "associatedTaxa")).toBe('"near":"Ceanothus"');
  });

  it("names the record only where the determination of record is an expert's, and writes the caste where Symbiota keeps it", async () => {
    const f = await fixture();
    const expert = await f.specimen({ field: "25000003" });
    await f.determine(expert.id, "Bombus mixtus", { person: f.eva }, true, { on: "2026-06-02", sex: "female", caste: "worker", qualifier: "cf." });
    // A volunteer's is the only one; an expert's older one is outranked by nothing, so a volunteer-only specimen has none.
    const volunteer = await f.specimen({ field: "25000004" });
    await f.determine(volunteer.id, "Bombus vosnesenskii", { person: f.vic }, false, { on: "2026-06-03", sex: "male" });
    const nobody = await f.specimen({ field: "25000005" });
    const a = await archiveOf(f, WABA, [expert.id, volunteer.id, nobody.id]);
    const row = (id: number) => a.occurrence.body.findIndex((r) => r[0] === String(id));
    const name = ["scientificName", "scientificNameAuthorship", "identificationQualifier", "identifiedBy", "dateIdentified", "sex", "reproductiveCondition"];
    expect(name.map((c) => a.occurrence.cell(row(expert.id), c))).toEqual(["Bombus mixtus", "Cresson, 1878", "cf.", "Eva Expert", "2026-06-02", "female", "worker"]);
    expect(name.map((c) => a.occurrence.cell(row(volunteer.id), c))).toEqual(["", "", "", "", "", "", ""]);
    expect(name.map((c) => a.occurrence.cell(row(nobody.id), c))).toEqual(["", "", "", "", "", "", ""]);
  });

  it("writes every determination as history, current only on an expert's determination of record", async () => {
    const f = await fixture();
    const expert = await f.specimen({ field: "25000006" });
    await f.determine(expert.id, "Bombus vosnesenskii", { person: f.vic }, false, { recorded: "2026-05-01 10:00:00" });
    await f.determine(expert.id, "Bombus mixtus", { person: f.eva }, true, { on: "2026-06-02", recorded: "2026-05-02 10:00:00" });
    const volunteerOnly = await f.specimen({ field: "25000007" });
    await f.determine(volunteerOnly.id, "Bombus vosnesenskii", { person: f.vic }, false, { recorded: "2026-05-01 10:00:00" });
    await f.determine(volunteerOnly.id, "Andrena prunorum", { name: "Other Volunteer" }, false, { recorded: "2026-05-03 10:00:00" });
    const a = await archiveOf(f, WABA, [expert.id, volunteerOnly.id]);
    const of = (id: number) => a.identification.body.filter((r) => r[0] === String(id));
    const col = (r: string[], c: string) => r[a.identification.header.indexOf(c)];
    expect(of(expert.id).map((r) => [col(r!, "scientificName"), col(r!, "identificationIsCurrent")])).toEqual([["Bombus vosnesenskii", "0"], ["Bombus mixtus", "1"]]);
    // History and no current name for a specimen with only volunteers' determinations.
    expect(of(volunteerOnly.id).map((r) => col(r!, "identificationIsCurrent"))).toEqual(["0", "0"]);
    // Each identification's own id goes in sourceIdentifier.
    const ids = ((await rows(f.conn, `SELECT entity_id FROM determination WHERE specimen_id = ${expert.id} ORDER BY recorded_at`)) as [[number]][]).map((r) => String(r[0]));
    expect(of(expert.id).map((r) => col(r!, "sourceIdentifier"))).toEqual(ids);
    expect(col(of(expert.id)[1]!, "identifiedBy")).toBe("Eva Expert");
    expect(col(of(expert.id)[1]!, "dateIdentified")).toBe("2026-06-02");
  });

  it("merges determinations that agree on name, determiner and date, current if any of them is", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "25000008" });
    // Two identical undated determinations by one expert: Symbiota would keep only the first of them.
    await f.determine(s.id, "Bombus mixtus", { person: f.eva }, true, { recorded: "2026-05-01 10:00:00" });
    await f.determine(s.id, "Bombus mixtus", { person: f.eva }, true, { recorded: "2026-05-02 10:00:00", qualifier: "cf." });
    // The same name by the same person on a date is a different identification.
    await f.determine(s.id, "Bombus mixtus", { person: f.eva }, true, { recorded: "2026-05-03 10:00:00", on: "2026-06-01" });
    // The same name by someone else too.
    await f.determine(s.id, "Bombus mixtus", { person: f.vic }, false, { recorded: "2026-05-04 10:00:00" });
    const a = await archiveOf(f, WABA, [s.id]);
    const col = (r: string[], c: string) => r[a.identification.header.indexOf(c)];
    // The determination of record is the newest expert one: the dated one.
    const out = a.identification.body.map((r) => [col(r, "identifiedBy"), col(r, "dateIdentified"), col(r, "identificationIsCurrent")]);
    expect(out).toEqual([["Eva Expert", "", "0"], ["Eva Expert", "2026-06-01", "1"], ["Vic Volunteer", "", "0"]]);
    // Two that agree and one of them is of record: one row, current.
    const t = await f.specimen({ field: "25000009" });
    await f.determine(t.id, "Bombus mixtus", { person: f.eva }, true, { recorded: "2026-05-01 10:00:00" });
    await f.determine(t.id, "Bombus mixtus", { person: f.eva }, true, { recorded: "2026-05-02 10:00:00" });
    const b = await archiveOf(f, WABA, [t.id]);
    expect(b.identification.body).toHaveLength(1);
    expect(b.identification.body[0]![b.identification.header.indexOf("identificationIsCurrent")]).toBe("1");
    // The lower-cased comparison is Symbiota's own.
    expect(b.occurrence.cell(0, "scientificName")).toBe("Bombus mixtus");
  });

  it("writes a specimen's tab and line break as a space, and nothing is quoted", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "25000011", sample: { locality: "'Rock\tCreek'" } });
    const a = await archiveOf(f, WABA, [s.id]);
    expect(a.occurrence.cell(0, "locality")).toBe("Rock Creek");
  });
});

describe("the associations file", () => {
  it("has exactly the three headers Symbiota maps, one row for each specimen whose sample has an observation", async () => {
    const f = await fixture();
    const species = await f.specimen({ field: "25000001", sample: { inat_observation_id: "111", host_name_as_observed: "'Salvia officinalis'", host_rank: "'species'" } });
    const genus = await f.specimen({ field: "25000002", sample: { inat_observation_id: "222", host_name_as_observed: "'Ceanothus'", host_rank: "'genus'" } });
    const noHost = await f.specimen({ field: "25000003", sample: { inat_observation_id: "333" } });
    const noObservation = await f.specimen({ field: "25000004" });
    const gone = await f.specimen({ field: "25000005", sample: { inat_observation_id: "444" } });
    await f.conn.run(`INSERT INTO observation_absent (inat_id) VALUES (444)`);
    const sameSample = await f.specimen({ field: "25000006", sample: { inat_observation_id: "555", host_name_as_observed: "'Rosa, \"wild\"'", host_rank: "'genus'" } });
    const csv = await associationsCsv(f.db, WABA, [species, genus, noHost, noObservation, gone, sameSample].map((s) => s.id));
    expect(csv.startsWith("subject identifier: catalogNumber,resourceUrl,verbatimSciname\n")).toBe(true);
    expect([...ASSOCIATION_HEADER]).toEqual(["subject identifier: catalogNumber", "resourceUrl", "verbatimSciname"]);
    expect(csv.split("\n").filter((l) => l !== "")).toEqual([
      "subject identifier: catalogNumber,resourceUrl,verbatimSciname",
      "WSDA_25000001,https://www.inaturalist.org/observations/111,Salvia officinalis",
      "WSDA_25000002,https://www.inaturalist.org/observations/222,Ceanothus",
      "WSDA_25000003,https://www.inaturalist.org/observations/333,",
      'WSDA_25000006,https://www.inaturalist.org/observations/555,"Rosa, ""wild"""',
    ]);
    // No byte order mark: the headers are the exact bytes Symbiota maps.
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("writes a name beginning with a formula character as it is, not behind an apostrophe", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "25000007", sample: { inat_observation_id: "666", host_name_as_observed: "'-unknown plant'" } });
    expect(await associationsCsv(f.db, WABA, [s.id])).toContain(",-unknown plant\n");
  });

  it("has the header alone for no specimens", async () => {
    const f = await fixture();
    expect(await associationsCsv(f.db, WABA, [])).toBe("subject identifier: catalogNumber,resourceUrl,verbatimSciname\n");
  });
});

describe("file names", () => {
  it("carry the collection, the year and the day written, in Pacific time", () => {
    const at = new Date("2026-11-21T20:05:07Z");
    expect(uploadFileName(WABA, 2026, at, "archive")).toBe("ecdysis-upload-WaBA-2026-2026-11-21-120507.zip");
    expect(uploadFileName(BC, 2026, at, "associations")).toBe("ecdysis-associations-BC-2026-2026-11-21-120507.csv");
  });
});
