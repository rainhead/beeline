import { writeFile, utimes } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { cachedArchivePath } from "../src/fetch-ecdysis.js";
import {
  ASSOCIATION_HEADER,
  associationsCsv,
  catalogNumbersInArchive,
  completeDownload,
  downloadSpecimens,
  downloadsOf,
  startDownload,
  blocking,
  eligibleNow,
  ecdysisRead,
  idsOf,
  INCLUDE_NONE,
  planUpload,
  ArchiveChanged,
  ArchiveTooLarge,
  buildArchive,
  downloadById,
  downloadViewsOf,
  ReadSuperseded,
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
import { BC, BC_OFFERED_YEARS_IN_CODE, fixture, HOUR, WABA } from "./ecdysis-upload-fixture.js";

/**
 * The upload to Ecdysis (beeline-8dx9.12): which specimens, when it may be
 * built, what the two files say. Names and places are invented. British
 * Columbia is the collection files are offered for, since Beeline reads it
 * whole; Washington's is read as a dataset and is not.
 */

type F = Awaited<ReturnType<typeof fixture>>;

/** The plan for British Columbia with these catalog numbers already in Ecdysis. */
const planWith = async (f: F, held: string[] = []): Promise<UploadPlan> => planUpload(f.db, BC, { readAt: new Date(), held: new Set(held.map((n) => n.toLowerCase())) });

/** The specimens in a year's file, with the downloader's choice about obscured ones. */
const inFile = (plan: UploadPlan, year: number, include: Include = INCLUDE_NONE) => {
  const y = plan.years.find((p) => p.year === year);
  return y === undefined ? [] : idsOf(y, include);
};
const everyone = (plan: UploadPlan, include: Include = INCLUDE_NONE) => plan.years.flatMap((y) => idsOf(y, include));
const rulesOf = (held: string[] = [], include: Include = INCLUDE_NONE) => ({ held: new Set(held.map((n) => n.toLowerCase())), include });

/** A specimen as an archive writes it, under the catalog number its label number makes. */
const w = (id: number, catalogNumber = `BCBA_${id}`) => ({ id, catalogNumber });

/** The specimens as an archive would have written them: each under the catalog number its label number makes now. */
const written = async (f: F, ids: number[]) =>
  ((await rows(f.conn, `SELECT entity_id, field_number FROM specimen WHERE entity_id IN (${ids.join(",") || "-1"}) ORDER BY entity_id`)) as [number, string][]).map(([id, field]) => w(Number(id), `BCBA_${field}`));

/** The archive as tables of cells. */
async function archiveOf(f: F, ids: number[], c = BC, rules = rulesOf()) {
  const stream = uploadArchiveStream(f.db, c, ids, rules);
  const files = Object.fromEntries(Object.entries(unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()))).map(([n, d]) => [n, strFromU8(d)]));
  const table = (name: string) => {
    const [header, ...body] = files[name]!.split("\n").filter((l) => l !== "").map((l) => l.split("\t"));
    return { header: header!, body, cell: (r: number, col: string) => body[r]![header!.indexOf(col)] };
  };
  return { files, occurrence: table("occurrence.tsv"), identification: table("identification.tsv") };
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

  it("counts the specimens collected from a plant whose location iNaturalist obscures (a protected plant), and those whose observer obscured theirs, apart, and leaves them out unless chosen", async () => {
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

  it("offers the years the collection's setting names, and lists the others as waiting; nothing else about a year decides it", async () => {
    const f = await fixture();
    expect(BC_OFFERED_YEARS_IN_CODE).toEqual([2026]);
    await f.specimen({ field: "2500001" });
    await f.specimen({ field: "2500002", year: SETTLED_SEASON });
    await f.specimen({ field: "2500003", year: CURRENT_SEASON - 6 });
    const plan = await planWith(f);
    expect(plan.years.map((y) => [y.year, y.offered])).toEqual([[CURRENT_SEASON, true], [SETTLED_SEASON, true], [CURRENT_SEASON - 6, false]]);
    // Ecdysis holding a specimen of the program from a year does not take the year away: what is still eligible is offered.
    const held = await f.specimen({ field: "2500004" });
    await f.conn.run(`INSERT INTO specimen_catalog_number (specimen_id, catalog_number) VALUES (${held.id}, 'BCBA_2500004')`);
    const again = await planWith(f);
    expect(again.years.find((y) => y.year === CURRENT_SEASON)).toMatchObject({ offered: true });
    expect(inFile(again, CURRENT_SEASON)).toHaveLength(1);
  });

  it("leaves out, counted apart, a specimen whose sample's geoprivacy flags are out of date with its observation's", async () => {
    const f = await fixture();
    const plain = await f.specimen({ field: "2500060" });
    const stale = await f.specimen({ field: "2500061", sample: { inat_observation_id: "9001" } });
    // The observation says private; the sample's copy says nothing.
    await f.conn.run(`INSERT INTO observation_field (inat_id, geoprivacy) VALUES (9001, 'private')`);
    const plan = await planWith(f);
    expect(inFile(plan, CURRENT_SEASON, { taxonObscured: true, observerObscured: true })).toEqual([plain.id]);
    expect(plan.years[0]).toMatchObject({ geoprivacyStale: 1, observerObscured: 0, taxonObscured: 0 });
    expect(stale.id).toBeGreaterThan(0);
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

  it("is refused when the last read reloaded the kept archive and did not download one, with its own reason", async () => {
    const f = await fixture();
    await f.cacheArchive(BC, [], { source: "cached" });
    expect(await ecdysisRead(BC, { ecdysisDir: f.dir })).toMatchObject({ ok: false, reason: "reloaded" });
    await f.cacheArchive(BC, [], { source: "downloaded" });
    expect((await ecdysisRead(BC, { ecdysisDir: f.dir })).ok).toBe(true);
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

  it("is refused when the zip has a different number of records than the read loaded, or lacks a catalog number that read recorded", async () => {
    const f = await fixture();
    const a = await f.specimen({ field: "2500001" });
    const b = await f.specimen({ field: "2500002" });
    // Loaded at this read (loaded_at is the read's own start, as the loader writes it).
    await f.cacheArchive(BC, [`BCBA_${a.id}`, `BCBA_${b.id}`], { readHoursAgo: 1 });
    const readAt = JSON.parse(await (await import("node:fs/promises")).readFile(`${f.dir}/collection-196.read.json`, "utf8")).readAt as string;
    for (const s of [a, b]) {
      await f.conn.run(`INSERT INTO specimen_catalog_number (specimen_id, catalog_number, loaded_at) VALUES (${s.id}, 'BCBA_${s.id}', TIMESTAMPTZ '${readAt}')`);
    }
    expect((await uploadStateOf(f.db, BC, { ecdysisDir: f.dir })).ok).toBe(true);
    // The zip holds one fewer record than the marker says it did.
    await f.cacheArchive(BC, [`BCBA_${a.id}`]);
    const marker = `${f.dir}/collection-196.read.json`;
    const { readFile, writeFile: write } = await import("node:fs/promises");
    await write(marker, JSON.stringify({ ...JSON.parse(await readFile(marker, "utf8")), readAt, records: 2 }));
    expect(await uploadStateOf(f.db, BC, { ecdysisDir: f.dir })).toMatchObject({ ok: false, reason: "incomplete" });
    // As many records, but another catalog number in place of one this read recorded.
    await f.cacheArchive(BC, [`BCBA_${a.id}`, "BCBA_other"]);
    await write(marker, JSON.stringify({ ...JSON.parse(await readFile(marker, "utf8")), readAt }));
    expect(await uploadStateOf(f.db, BC, { ecdysisDir: f.dir })).toMatchObject({ ok: false, reason: "incomplete" });
  });

  it("is not refused for good because Ecdysis has deleted a record: the store keeps its catalog number from an earlier read", async () => {
    const f = await fixture();
    const gone = await f.specimen({ field: "2500003" });
    // Loaded long ago, and since deleted in Ecdysis: the loader never removes the row, and this read did not rewrite it.
    await f.conn.run(`INSERT INTO specimen_catalog_number (specimen_id, catalog_number, loaded_at) VALUES (${gone.id}, 'BCBA_${gone.id}', now() - INTERVAL '30 days')`);
    await f.cacheArchive(BC, ["BCBA_1"]);
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
    expect([...one.held].sort()).toEqual(["bcba_1", "bcba_2", "bcba_3"]);
    expect(one.rows).toBe(4);
    expect(two).toBe(one);
    expect(await catalogNumbersInArchive(f.db, path, f.dir)).toBe(one);
  });

  it("runs unpacks one at a time, so one cannot clear the folder another is using", async () => {
    const f = await fixture();
    await f.cacheArchive(BC, Array.from({ length: 200 }, (_, i) => `BCBA_${i}`));
    const copy = `${f.dir}/second.zip`;
    const { copyFile } = await import("node:fs/promises");
    await copyFile(cachedArchivePath(f.dir, BC), copy);
    // Two different archives asked for together: each must find its whole folder, which a parallel cleanup would remove.
    const [one, two] = await Promise.all([catalogNumbersInArchive(f.db, cachedArchivePath(f.dir, BC), f.dir), catalogNumbersInArchive(f.db, copy, f.dir)]);
    expect([one.held.size, two.held.size, one.rows]).toEqual([200, 200, 200]);
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
  });

  it("writes every page of a file of several pages, though rows were dropped from one, and ends on the page marked last", async () => {
    const f = await fixture();
    const made: { id: number; sample: number }[] = [];
    for (let i = 0; i < 7; i++) made.push(await f.specimen({ field: `26000${i}` }));
    const ids = made.map((m) => m.id);
    // The third specimen becomes obscured after the plan: its page is short and is not the last.
    await f.conn.run(`UPDATE sample SET taxon_geoprivacy = 'obscured' WHERE entity_id = ${made[2]!.sample}`);
    const written: { id: number; catalogNumber: string }[] = [];
    // Pages of three: 3 + 3 + 1 specimens, the first of them one short.
    const stream = uploadArchiveStream(f.db, BC, ids, rulesOf(), { pageSize: 3, written });
    const files = unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()));
    const body = strFromU8(files["occurrence.tsv"]!).trim().split("\n").slice(1).map((l) => l.split("\t")[0]);
    expect(body).toHaveLength(6);
    expect(new Set(body)).toEqual(new Set(ids.filter((id) => id !== made[2]!.id).map(String)));
    expect(written.map((w) => w.id).sort((a, b) => a - b)).toEqual(ids.filter((id) => id !== made[2]!.id));
    // Identifications of every page are in the one file.
    expect(strFromU8(files["identification.tsv"]!).split("\n")[0]).toContain("coreid");
  });

  it("ends a file whose last full page is exactly the size of a page", async () => {
    const f = await fixture();
    const made: number[] = [];
    for (let i = 0; i < 4; i++) made.push((await f.specimen({ field: `27000${i}` })).id);
    const a = await archiveOf(f, made);
    expect(a.occurrence.body).toHaveLength(4);
    const stream = uploadArchiveStream(f.db, BC, made, rulesOf(), { pageSize: 2 });
    const files = unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()));
    expect(strFromU8(files["occurrence.tsv"]!).trim().split("\n")).toHaveLength(5);
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
    expect(Object.keys(a.files).sort()).toEqual(["identification.tsv", "meta.xml", "occurrence.tsv"]);
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
  });

  it("writes the first day in eventDate and the last in eventDate2, for a trap sample", async () => {
    const f = await fixture();
    const s = await f.specimen({
      field: "2500002",
      sample: { kind: "'trap'", protocol: "'blue vane trap'", date_start: `DATE '${CURRENT_SEASON}-06-01'`, date_end: `DATE '${CURRENT_SEASON}-06-05'`, host_name_as_observed: "'Ceanothus'", host_rank: "'genus'" },
    });
    const a = await archiveOf(f, [s.id]);
    expect([a.occurrence.cell(0, "eventDate"), a.occurrence.cell(0, "eventDate2")]).toEqual([`${CURRENT_SEASON}-06-01`, `${CURRENT_SEASON}-06-05`]);
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
    const csv = await associationsCsv(f.db, await written(f, ids));
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

  it("has no row at all for a trap sample, decided by the sample's kind and not the words of its protocol", async () => {
    const f = await fixture();
    const trap = await f.specimen({ field: "2500007", sample: { kind: "'trap'", protocol: "'blue vane trap'", inat_observation_id: "666", host_name_as_observed: "'Ceanothus'", host_rank: "'genus'" } });
    const unnamed = await f.specimen({ field: "2500008", sample: { kind: "'trap'", protocol: "'blue vane'", inat_observation_id: "667", host_name_as_observed: "'Rosa'", host_rank: "'genus'" } });
    const netWithTheWord = await f.specimen({ field: "2500010", sample: { kind: "'net'", protocol: "'netting near the trap line'", inat_observation_id: "669", host_name_as_observed: "'Aster'", host_rank: "'genus'" } });
    const net = await f.specimen({ field: "2500009", sample: { inat_observation_id: "668", host_name_as_observed: "'Salvia'", host_rank: "'genus'" } });
    const csv = await associationsCsv(f.db, await written(f, [trap.id, unnamed.id, netWithTheWord.id, net.id]));
    expect(csv.split("\n").filter((l) => l !== "").slice(1)).toEqual([
      "BCBA_2500010,https://www.inaturalist.org/observations/669,Aster",
      "BCBA_2500009,https://www.inaturalist.org/observations/668,Salvia",
    ]);
  });

  it("leaves the host out of the specimens file altogether: no associatedTaxa column in the occurrence file or meta.xml, for a flower visit and a trap alike", async () => {
    const f = await fixture();
    const net = await f.specimen({ field: "2500013", sample: { host_name_as_observed: "'Salvia officinalis'" } });
    const trap = await f.specimen({ field: "2500014", sample: { kind: "'trap'", protocol: "'blue vane trap'", host_name_as_observed: "'Ceanothus'", host_rank: "'genus'" } });
    const a = await archiveOf(f, [net.id, trap.id]);
    expect(a.occurrence.header).not.toContain("associatedTaxa");
    expect(a.files["meta.xml"]).not.toContain("associatedTaxa");
    expect(a.files["occurrence.tsv"]).not.toContain("Salvia");
    expect(a.files["occurrence.tsv"]).not.toContain("Ceanothus");
  });

  it("names the subject by the catalog number the specimen was written under, though the label number was corrected after", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "2500001", sample: { inat_observation_id: "111", host_name_as_observed: "'Salvia'", host_rank: "'genus'" } });
    const recorded = [w(s.id, "BCBA_2500001")];
    await f.conn.run(`UPDATE specimen SET field_number = '2599999' WHERE entity_id = ${s.id}`);
    expect(await associationsCsv(f.db, recorded)).toContain("BCBA_2500001,https://www.inaturalist.org/observations/111,Salvia");
    expect(await associationsCsv(f.db, recorded)).not.toContain("2599999");
  });

  it("writes a name beginning with a formula character as it is, not behind an apostrophe", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "2500012", sample: { inat_observation_id: "669", host_name_as_observed: "'-unknown plant'" } });
    expect(await associationsCsv(f.db, await written(f, [s.id]))).toContain(",-unknown plant\n");
  });

  it("has the header alone for no specimens", async () => {
    const f = await fixture();
    expect(await associationsCsv(f.db, [])).toBe("subject identifier: catalogNumber,resourceUrl,verbatimSciname\n");
  });
});

describe("one archive for each read of Ecdysis", () => {
  const start = (f: F, over: Partial<Parameters<typeof startDownload>[1]> = {}) =>
    startDownload(f.db, { collection: BC, year: CURRENT_SEASON, include: { taxonObscured: true, observerObscured: false }, planned: 5, readAt: new Date(Date.now() - HOUR), personId: f.eva, ...over });

  it("records the start of a download with who, the choice and the read it rested on, and its completion apart", async () => {
    const f = await fixture();
    expect(await downloadsOf(f.db, BC)).toEqual([]);
    const a = await f.specimen({ field: "2500001" });
    const b = await f.specimen({ field: "2500002" });
    const started = await start(f);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const [before] = await downloadsOf(f.db, BC);
    expect(before).toMatchObject({ id: started.id, year: CURRENT_SEASON, planned: 5, by: "Eva Expert", completedAt: null, specimens: null, include: { taxonObscured: true, observerObscured: false } });
    await completeDownload(f.db, started.id, [w(a.id), w(b.id)]);
    const [after] = await downloadsOf(f.db, BC);
    expect(after).toMatchObject({ specimens: 2 });
    expect(after!.completedAt).toBeInstanceOf(Date);
    expect(await downloadSpecimens(f.db, started.id)).toEqual([w(a.id), w(b.id)].sort((x, y) => x.id - y.id));
    expect(await downloadsOf(f.db, WABA)).toEqual([]);
  });

  it("refuses a second archive after a download that began after the read, whatever the year, until a newer read", async () => {
    const f = await fixture();
    const readAt = new Date(Date.now() - HOUR);
    expect((await start(f, { readAt })).ok).toBe(true);
    const second = await start(f, { readAt, year: SETTLED_SEASON });
    expect(second).toMatchObject({ ok: false });
    // A read that began after the download: the next archive is allowed.
    const newer = new Date(Date.now() + 1);
    expect(blocking(await downloadsOf(f.db, BC), newer)).toBeNull();
    expect((await start(f, { readAt: newer })).ok).toBe(true);
  });

  it("lets only one of two simultaneous requests start: the table's unique key refuses the second", async () => {
    const f = await fixture();
    const readAt = new Date(Date.now() - HOUR);
    const results = await Promise.all([start(f, { readAt }), start(f, { readAt }), start(f, { readAt, year: SETTLED_SEASON })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await downloadsOf(f.db, BC)).toHaveLength(1);
  });

  it("blocks a second archive when a read began before the download and finished after it", async () => {
    const f = await fixture();
    await f.specimen({ field: "2500001" });
    // The download rests on the read of two hours ago and begins now.
    await f.cacheArchive(BC, [], { readHoursAgo: 1.9 });
    const started = await start(f, { readAt: new Date(Date.now() - 1.9 * HOUR) });
    expect(started.ok).toBe(true);
    // A read that began ten minutes ago, before the download, finishes now: its marker lands after the download began.
    await f.cacheArchive(BC, [], { readHoursAgo: 1 / 6 });
    const state = await uploadStateOf(f.db, BC, { ecdysisDir: f.dir });
    if (!state.ok) throw new Error(`refused: ${state.reason}`);
    expect(state.blocking).toMatchObject({ id: started.ok ? started.id : -1 });
  });

});

describe("building the whole archive before answering", () => {
  const current = async () => true;

  it("builds the archive in memory and says how many specimens it actually wrote", async () => {
    const f = await fixture();
    const a = await f.specimen({ field: "2500001" });
    const b = await f.specimen({ field: "2500002" });
    await f.conn.run(`UPDATE sample SET taxon_geoprivacy = 'obscured' WHERE entity_id = ${b.sample}`);
    const built = await buildArchive(f.db, BC, [a.id, b.id], rulesOf(), { stillCurrent: current });
    expect(built.written).toEqual([{ id: a.id, catalogNumber: "BCBA_2500001" }]);
    const files = unzipSync(built.bytes);
    expect(strFromU8(files["occurrence.tsv"]!).trim().split("\n")).toHaveLength(2);
  });

  it("stops, with nothing to record, when the read the plan rested on is replaced while it is written", async () => {
    const f = await fixture();
    const made: number[] = [];
    for (let i = 0; i < 5; i++) made.push((await f.specimen({ field: `28000${i}` })).id);
    let pages = 0;
    const stillCurrent = async () => ++pages < 3;
    await expect(buildArchive(f.db, BC, made, rulesOf(), { stillCurrent, pageSize: 2 })).rejects.toBeInstanceOf(ReadSuperseded);
    // A read that lands after the last page is caught by the check at the end.
    let calls = 0;
    await expect(buildArchive(f.db, BC, made, rulesOf(), { stillCurrent: async () => ++calls <= 1, pageSize: 10 })).rejects.toBeInstanceOf(ReadSuperseded);
  });

  it("refuses an archive larger than the bound, with a clear error", async () => {
    const f = await fixture();
    const s = await f.specimen({ field: "2500001" });
    await expect(buildArchive(f.db, BC, [s.id], rulesOf(), { stillCurrent: current, limit: 10 })).rejects.toBeInstanceOf(ArchiveTooLarge);
  });

  it("asks again about the year, as each page is written", async () => {
    const f = await fixture();
    const kept = await f.specimen({ field: "2500001" });
    const moved = await f.specimen({ field: "2500002" });
    const ids = [kept.id, moved.id];
    // After the plan: one sample's date was corrected to another year.
    await f.conn.run(`UPDATE sample SET date_start = DATE '${SETTLED_SEASON}-07-14', date_end = DATE '${SETTLED_SEASON}-07-14' WHERE entity_id = ${moved.sample}`);
    expect(await eligibleNow(f.db, BC, ids, { ...rulesOf(), year: CURRENT_SEASON })).toEqual([kept.id]);
    const built = await buildArchive(f.db, BC, ids, { ...rulesOf(), year: CURRENT_SEASON }, { stillCurrent: current });
    expect(built.written.map((w) => w.id)).toEqual([kept.id]);
  });
});

describe("the cached archive is the file the marker describes", () => {
  it("refuses a file whose size or time is not the marker's, before or after it is read", async () => {
    const f = await fixture();
    await f.cacheArchive(BC, ["BCBA_1"]);
    const path = cachedArchivePath(f.dir, BC);
    const { stat } = await import("node:fs/promises");
    const st = await stat(path);
    const expected = { bytes: st.size, modifiedAt: st.mtime.toISOString() };
    expect((await catalogNumbersInArchive(f.db, path, f.dir, expected)).rows).toBe(1);
    await utimes(path, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    await expect(catalogNumbersInArchive(f.db, path, f.dir, expected)).rejects.toBeInstanceOf(ArchiveChanged);
    await expect(catalogNumbersInArchive(f.db, path, f.dir, { bytes: st.size + 1, modifiedAt: expected.modifiedAt })).rejects.toBeInstanceOf(ArchiveChanged);
  });
});

describe("the finished downloads of a collection, whatever the state of the read", () => {
  const start = (f: F, over: Partial<Parameters<typeof startDownload>[1]> = {}) =>
    startDownload(f.db, { collection: BC, year: CURRENT_SEASON, include: INCLUDE_NONE, planned: 1, readAt: new Date(Date.now() - 100 * HOUR), personId: f.eva, ...over });

  it("finds one download by id in one query, finished or not", async () => {
    const f = await fixture();
    const a = await start(f);
    if (!a.ok) throw new Error("not started");
    expect(await downloadById(f.db, a.id)).toMatchObject({ id: a.id, completedAt: null, by: "Eva Expert" });
    expect(await downloadById(f.db, 999_999)).toBeNull();
  });

  it("lists the ten most recent finished ones, and any beyond them with specimens still absent from Ecdysis, newest first", async () => {
    const f = await fixture();
    const spec = await f.specimen({ field: "2500001" });
    const absent = await f.specimen({ field: "2500002" });
    // Twelve finished downloads, each on its own read; the oldest holds a specimen Ecdysis does not hold.
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) {
      // Each rests on a read that began after the download before it.
      const r = await start(f, { readAt: i === 0 ? new Date(Date.now() - 200 * HOUR) : new Date() });
      if (!r.ok) throw new Error("not started");
      await completeDownload(f.db, r.id, i === 0 ? [w(absent.id, "BCBA_2500002")] : [w(spec.id, "BCBA_2500001")]);
      ids.push(r.id);
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    await f.conn.run(`INSERT INTO specimen_catalog_number (specimen_id, catalog_number) VALUES (${spec.id}, 'BCBA_2500001')`);
    const views = await downloadViewsOf(f.db, BC, null, null);
    // Ten newest, then the oldest because it is still outstanding.
    expect(views.map((v) => v.id)).toEqual([...ids.slice(2).reverse(), ids[0]]);
    expect(views.find((v) => v.id === ids[0])).toMatchObject({ notKnown: 1, established: false });
    expect(views.find((v) => v.id === ids[11])).toMatchObject({ notKnown: 0 });
  });

  it("judges by the cached archive too, where it is in hand, and then absence is established", async () => {
    const f = await fixture();
    const spec = await f.specimen({ field: "2500001" });
    const r = await start(f);
    if (!r.ok) throw new Error("not started");
    await completeDownload(f.db, r.id, [w(spec.id, "BCBA_2500001")]);
    expect((await downloadViewsOf(f.db, BC, null, null))[0]).toMatchObject({ notKnown: 1, established: false });
    expect((await downloadViewsOf(f.db, BC, new Set(), null))[0]).toMatchObject({ notKnown: 1, established: true });
    expect((await downloadViewsOf(f.db, BC, new Set(["bcba_2500001"]), null))[0]).toMatchObject({ notKnown: 0, established: true });
  });

  it("compares the catalog number the specimen was written under, so a label number corrected afterwards changes nothing", async () => {
    const f = await fixture();
    const spec = await f.specimen({ field: "2500001" });
    const r = await start(f);
    if (!r.ok) throw new Error("not started");
    await completeDownload(f.db, r.id, [w(spec.id, "BCBA_2500001")]);
    // The label number is corrected, and Ecdysis holds a record under the corrected number, not the one written.
    await f.conn.run(`UPDATE specimen SET field_number = '2599999' WHERE entity_id = ${spec.id}`);
    expect((await downloadViewsOf(f.db, BC, new Set(["bcba_2599999"]), null))[0]).toMatchObject({ notKnown: 1 });
    expect((await downloadViewsOf(f.db, BC, new Set(["bcba_2500001"]), null))[0]).toMatchObject({ notKnown: 0 });
  });

  it("does not take a specimen deleted afterwards for one Ecdysis holds", async () => {
    const f = await fixture();
    const spec = await f.specimen({ field: "2500001" });
    const kept = await f.specimen({ field: "2500002" });
    const r = await start(f);
    if (!r.ok) throw new Error("not started");
    await completeDownload(f.db, r.id, [w(spec.id, "BCBA_2500001"), w(kept.id, "BCBA_2500002")]);
    await f.conn.run(`DELETE FROM specimen WHERE entity_id = ${spec.id}`);
    // The cached collection holds both catalog numbers; the deleted one is still not known to be held.
    expect((await downloadViewsOf(f.db, BC, new Set(["bcba_2500001", "bcba_2500002"]), null))[0]).toMatchObject({ notKnown: 1 });
  });
});

describe("file names", () => {
  it("carry the collection, the year, the specimen count and the day written, in Pacific time", () => {
    const at = new Date("2026-11-21T20:05:07Z");
    expect(uploadFileName(BC, 2026, at, "archive", 8100)).toBe("ecdysis-upload-BC-2026-8100-specimens-2026-11-21-120507.zip");
    expect(uploadFileName(BC, 2026, at, "associations", 7)).toBe("ecdysis-associations-BC-2026-7-specimens-2026-11-21-120507.csv");
  });
});
