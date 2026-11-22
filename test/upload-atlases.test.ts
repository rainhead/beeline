import { describe as describeInOrder, expect, it } from "vitest";
import { en } from "../src/app/messages/en.js";
import { planUpload } from "../src/app/upload-plan.js";
import { CURRENT_SEASON } from "./helpers.js";
import { UPLOAD_TODAY, edited, uploadFixture, type UploadFixture } from "./upload-fixture.js";
import type { TestCell } from "./workbook.js";

/**
 * An upload asks before it changes the records of a program the person does not lead (beeline-kgyd.13). A person's own
 * programs are the ones they lead; a change of identification is never asked about, since taxonomists identify bees for
 * one another's atlases; and nothing is refused, only confirmed once. The fixture's samples are UP-1 (a1, a2, a3; this
 * season) and UP-2 (b1; a settled season), which these tests file under programs.
 */
const describe = describeInOrder.concurrent;

const ORIGIN = "http://localhost:3054";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const esc = (text: string) => text.replaceAll("'", "&#39;");
const p = en.uploads.page;
const BOX = 'name="confirm_elsewhere"';

const fileUnder = (f: UploadFixture, sampleId: number, code: string) =>
  f.conn.run(`INSERT INTO sample_atlas (sample_id, atlas_id) SELECT ${sampleId}, entity_id FROM program WHERE code = '${code}'`);
const leads = (f: UploadFixture, code: string, person = f.staffer) =>
  f.conn.run(`INSERT INTO program_lead (program_id, person_id) SELECT entity_id, ${person} FROM program WHERE code = '${code}'`);
/** The sample lies in a national wildlife refuge, so the refuges program's records include it as well as its atlas's. */
async function inRefuge(f: UploadFixture, sampleId: number) {
  await f.conn.run(
    `INSERT INTO area (source, source_id, kind, name, geom, gazetteer_build) VALUES ('usfws', '13588', 'refuge', 'Ankeny NWR', 'POINT (0 0)'::GEOMETRY, 'test')`,
  );
  await f.conn.run(
    `INSERT INTO sample_area_derivation (sample_id, latitude, longitude, gazetteer_build, rule_version, derived_at)
     SELECT sample_id, latitude, longitude, 'test', 1, current_timestamp FROM sample_location WHERE sample_id = ${sampleId}`,
  );
  await f.conn.run(`INSERT INTO sample_area (sample_id, area_source, area_source_id) VALUES (${sampleId}, 'usfws', '13588')`);
}

const newRow = (over: Record<string, TestCell> = {}) => ({
  fieldNumber: "OBAS-00011",
  recordedBy: "Vera Volunteer",
  eventDate: `${CURRENT_SEASON}-05-01`,
  samplingProtocol: "vane trap",
  trapCount: "6",
  specimenCount: "2",
  decimalLatitude: "44.5",
  decimalLongitude: "-123.2",
  coordinateUncertaintyInMeters: "50",
  countryCode: "US",
  stateProvince: "OR",
  county: "Benton",
  locality: "Fir Butte",
  ...over,
});

const samplesDownload = async (f: UploadFixture) => new Uint8Array(await (await f.app.request("/samples.xlsx?scope=all")).arrayBuffer());
const upload = async (f: UploadFixture, file: Uint8Array) => {
  const body = new FormData();
  body.set("file", new File([file as BlobPart], "edited.xlsx", { type: XLSX }));
  const res = await f.app.request("/uploads", { method: "POST", headers: { origin: ORIGIN }, body });
  expect(res.status).toBe(303);
  return res.headers.get("location")!;
};
const digestIn = (html: string) => /name="digest" value="([0-9a-f]+)"/.exec(html)?.[1];
/** What the page's box carries: the codes of the programs it named. */
const boxIn = (html: string) => /name="confirm_elsewhere" value="([^"]*)"/.exec(html)?.[1] ?? "";
/** Apply, ticking the box with what it carries (`confirm` true: the page's own; a string: those codes). */
const applyWith = (f: UploadFixture, location: string, digest: string | undefined, confirm: boolean | string, html = "") => {
  const body = new FormData();
  body.set("digest", digest ?? "");
  body.set("obas", "1");
  if (confirm !== false) body.set("confirm_elsewhere", confirm === true ? boxIn(html) : confirm);
  return f.app.request(`${location}/apply-samples`, { method: "POST", headers: { origin: ORIGIN }, body });
};
const queued = async (f: UploadFixture) => Number((await f.conn.run(`SELECT count(*) FROM upload_sample_outcome`).then((r) => r.getRows()))[0]![0]);

/** A samples file with the edits (or new rows) uploaded: where it is, its page and its digest. */
async function offered(f: UploadFixture, edits: Array<{ id: number; set: Record<string, TestCell> }>, addRows: Array<Record<string, TestCell>> = []) {
  const location = await upload(f, edited(await samplesDownload(f), edits, { idColumn: "sampleId", addRows }));
  const html = await (await f.app.request(location)).text();
  return { location, html, digest: digestIn(html) };
}
const albany = (sample: number) => [{ id: sample, set: { locality: "Albany" } as Record<string, TestCell> }];
const line = (abbreviation: string, count: number, active: number, settled: number) => esc(p.otherProgramSamples(abbreviation, count, p.split(active, settled, 0)));

describe("the samples file", () => {
  it("does not ask a lead who changes a sample of their own program, and applies it without a confirmation", async () => {
    const f = await uploadFixture();
    await fileUnder(f, f.ids.sampleA, "OBA");
    await leads(f, "OBA");
    const { location, html, digest } = await offered(f, albany(f.ids.sampleA));
    expect(html).toContain("apply-samples");
    expect(html).not.toContain(BOX);
    expect(html).not.toContain("a program you don&#39;t lead");
    expect((await applyWith(f, location, digest, false)).status).toBe(303);
    expect(await queued(f)).toBeGreaterThan(0);
  });

  it("names the program and its count when a lead changes another program's sample, and applies only once it is confirmed", async () => {
    const f = await uploadFixture();
    await fileUnder(f, f.ids.sampleA, "OBA");
    await fileUnder(f, f.ids.sampleB, "WaBA");
    await leads(f, "OBA");
    const { location, html, digest } = await offered(f, albany(f.ids.sampleB));
    // Written as people abbreviate it (WABA, not the code WaBA), with the settled season it is in.
    expect(html).toContain(line("WABA", 1, 0, 1));
    expect(html).toContain(BOX);
    expect(html).not.toContain(line("OBA", 1, 1, 0));
    // Not confirmed: refused by the server, and told why. Nothing is queued.
    const refused = await applyWith(f, location, digest, false);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain(esc(p.samplesOtherProgramsNotConfirmed));
    expect(await queued(f)).toBe(0);
    // Confirmed: applied.
    expect((await applyWith(f, location, digest, true, html)).status).toBe(303);
    expect(await queued(f)).toBeGreaterThan(0);
  });

  it("asks again about a program that was not on the page the confirmation was ticked on", async () => {
    const f = await uploadFixture();
    await fileUnder(f, f.ids.sampleA, "OBA");
    await fileUnder(f, f.ids.sampleB, "WaBA");
    await leads(f, "OBA");
    const { location, html, digest } = await offered(f, [...albany(f.ids.sampleA), ...albany(f.ids.sampleB)]);
    expect(boxIn(html)).toBe("WaBA");
    // They stop leading OBA before pressing Apply: the box they ticked named WABA only, so OBA is asked about.
    await f.conn.run(`DELETE FROM program_lead WHERE person_id = ${f.staffer}`);
    const again = await applyWith(f, location, digest, true, html);
    expect(again.status).toBe(409);
    const shown = await again.text();
    expect(shown).toContain(line("OBA", 1, 1, 0));
    expect(await queued(f)).toBe(0);
    // Ticked on the page that names both: applied.
    expect((await applyWith(f, location, digest, true, shown)).status).toBe(303);
    expect(await queued(f)).toBeGreaterThan(0);
  });

  it("asks a staff member who leads no program about every change", async () => {
    const f = await uploadFixture();
    await fileUnder(f, f.ids.sampleA, "OBA");
    const { location, html, digest } = await offered(f, albany(f.ids.sampleA));
    expect(html).toContain(line("OBA", 1, 1, 0));
    expect(html).toContain(BOX);
    expect((await applyWith(f, location, digest, false)).status).toBe(409);
    expect(await queued(f)).toBe(0);
    expect((await applyWith(f, location, digest, true, html)).status).toBe(303);
  });

  it("does not ask about a sample that is in two programs when the person leads one of them, and names both when they lead neither", async () => {
    const f = await uploadFixture();
    await fileUnder(f, f.ids.sampleA, "OBA");
    await inRefuge(f, f.ids.sampleA);
    // Leading the refuges program makes it the person's own although its atlas is another's.
    await leads(f, "NWR");
    const own = await offered(f, albany(f.ids.sampleA));
    expect(own.html).not.toContain(BOX);
    expect((await applyWith(f, own.location, own.digest, false)).status).toBe(303);

    // Another store, so that the first apply's change does not stand in the way: the same sample, led by a third program.
    const g = await uploadFixture();
    await fileUnder(g, g.ids.sampleA, "OBA");
    await inRefuge(g, g.ids.sampleA);
    await leads(g, "BC");
    const neither = await offered(g, albany(g.ids.sampleA));
    expect(neither.html).toContain(line("NWR", 1, 1, 0));
    expect(neither.html).toContain(line("OBA", 1, 1, 0));
    expect(neither.html).toContain(BOX);
  });

  it("asks about a new trap sample by the program its state would file it under", async () => {
    const f = await uploadFixture();
    await leads(f, "WaBA");
    // Oregon is the Oregon Bee Atlas's, which this person does not lead.
    const other = await offered(f, [], [newRow()]);
    expect(other.html).toContain(line("OBA", 1, 1, 0));
    expect((await applyWith(f, other.location, other.digest, false)).status).toBe(409);
    expect(await queued(f)).toBe(0);
    expect((await applyWith(f, other.location, other.digest, true, other.html)).status).toBe(303);

    const g = await uploadFixture();
    await leads(g, "OBA");
    const own = await offered(g, [], [newRow()]);
    expect(own.html).not.toContain(BOX);
    expect((await applyWith(g, own.location, own.digest, false)).status).toBe(303);

    // A state no atlas covers is Master Melittology's, which the lead of an atlas does not lead either.
    const h = await uploadFixture();
    await leads(h, "OBA");
    const outside = await offered(h, [], [newRow({ stateProvince: "NV", county: "Clark" })]);
    expect(outside.html).toContain(line("MM", 1, 1, 0));
  });

  it("does not ask where the ticked kinds change nothing outside the person's programs", async () => {
    const f = await uploadFixture();
    await fileUnder(f, f.ids.sampleB, "WaBA");
    await leads(f, "OBA");
    // The file only restates what Beeline has: nothing to apply, so nothing to confirm.
    const same = await upload(f, await samplesDownload(f));
    const html = await (await f.app.request(same)).text();
    expect(html).not.toContain(BOX);
  });
});

describe("the specimens file", () => {
  const specimens = async (f: UploadFixture, edits: Array<{ id: number; set: Record<string, TestCell> }>, uploader = f.staffer) => {
    const result = await planUpload(f.db, edited(await f.file(), edits), { today: UPLOAD_TODAY, uploader });
    if (!result.ok) throw new Error(`refused: ${result.refusal}`);
    return result.plan;
  };
  const lost = (f: UploadFixture) => [{ id: f.ids.a2, set: { disposition: "missing", occurrenceRemarks: "Lost" } as Record<string, TestCell> }];

  it("counts a change of disposition or remarks outside the person's programs, by program and season", async () => {
    const f = await uploadFixture();
    await fileUnder(f, f.ids.sampleA, "OBA");
    await leads(f, "WaBA");
    const plan = await specimens(f, lost(f));
    expect(plan.otherPrograms).toEqual([{ code: "OBA", abbreviation: "OBA", records: { active: 1, settled: 0, unplaced: 0 } }]);
    // A person who leads that program has no question.
    await leads(f, "OBA");
    expect((await specimens(f, lost(f))).otherPrograms).toEqual([]);
  });

  it("does not count a change of identification, which taxonomists make for other programs' bees", async () => {
    const f = await uploadFixture();
    await fileUnder(f, f.ids.sampleA, "OBA");
    await leads(f, "WaBA");
    const plan = await specimens(f, [{ id: f.ids.a1, set: { sex: "male" } }]);
    expect(plan.differences.map((d) => d.unit)).toEqual(["determination"]);
    expect(plan.otherPrograms).toEqual([]);
  });

  it("counts every change for a staff member who leads nothing, and says nothing where the comparison does not know who is uploading", async () => {
    const f = await uploadFixture();
    await fileUnder(f, f.ids.sampleB, "WaBA");
    const plan = await specimens(f, [{ id: f.ids.b1, set: { disposition: "missing", occurrenceRemarks: "Lost" } }]);
    expect(plan.otherPrograms).toEqual([{ code: "WaBA", abbreviation: "WABA", records: { active: 0, settled: 1, unplaced: 0 } }]);
    const unknown = await planUpload(f.db, edited(await f.file(), lost(f)), { today: UPLOAD_TODAY });
    expect(unknown.ok && unknown.plan.otherPrograms).toBeNull();
  });

  it("says so on the page of an uploaded file, and only for the programs outside the person's own", async () => {
    const f = await uploadFixture();
    await fileUnder(f, f.ids.sampleA, "OBA");
    await leads(f, "WaBA");
    const location = await upload(f, edited(await f.file(), lost(f)));
    const html = await (await f.app.request(location)).text();
    expect(html).toContain(esc(p.otherProgramSpecimens("OBA", 1, p.split(1, 0, 0))));
    const g = await uploadFixture();
    await fileUnder(g, g.ids.sampleA, "OBA");
    await leads(g, "OBA");
    const own = await upload(g, edited(await g.file(), lost(g)));
    expect(await (await g.app.request(own)).text()).not.toContain("a program you don&#39;t lead");
  });
});
