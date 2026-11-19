import { describe as describeInOrder, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { en } from "../src/app/messages/en.js";
import { ACTING_COOKIE, IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { VOLUNTEER_LAYOUT, SPECIMENS_LAYOUT } from "../src/app/upload-plan.js";
import { saveDrafts } from "../src/app/determine.js";
import { commitDeterminationDrafts } from "../src/commit-determinations.js";
import { insertCleanSample, rows } from "./helpers.js";
import { edited, matrixOf, uploadFixture, type UploadFixture } from "./upload-fixture.js";

/**
 * A volunteer naming their own bees from their own copy of the specimens download (beeline-kgyd.7): the file
 * carries their own identification and nothing of an expert's, and its names become drafts on Identify specimens,
 * credited to whoever is signed in, for the specimens that page lets them name. Each test has its own store.
 *
 * The fixture (test/upload-fixture.ts): Vera Volunteer collected UP-1 (a1 with an expert's identification by Dee
 * Determiner, a2 with none, a3 with another volunteer's) and UP-2 (b1, another volunteer's, a settled season).
 * Dana Delegate acts for Vera.
 */
const describe = describeInOrder.concurrent;

const ORIGIN = "http://localhost:3054";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const upload = (f: UploadFixture, file: Uint8Array, cookie?: string) => {
  const body = new FormData();
  body.set("file", new File([file as BlobPart], "my bees.xlsx", { type: XLSX_TYPE }));
  return f.app.request("/uploads", { method: "POST", headers: { origin: ORIGIN, ...(cookie === undefined ? {} : { cookie }) }, body });
};

/** The volunteer's own download, as they would ask for it. */
const ownFile = async (f: UploadFixture, cookie?: string, scope = "all") =>
  new Uint8Array(await (await f.app.request(`/specimens.xlsx?scope=${scope}`, cookie === undefined ? {} : { headers: { cookie } })).arrayBuffer());

/** Upload a file and read its preview, with the digest its form carries. */
async function preview(f: UploadFixture, bytes: Uint8Array, cookie?: string) {
  const res = await upload(f, bytes, cookie);
  expect(res.status).toBe(303);
  const href = res.headers.get("location")!;
  const html = await (await f.app.request(href, cookie === undefined ? {} : { headers: { cookie } })).text();
  const digest = /name="digest" value="([0-9a-f]+)"/.exec(html)?.[1] ?? null;
  return { href, html, digest };
}

const apply = (f: UploadFixture, href: string, digest: string, cookie?: string) => {
  const body = new FormData();
  body.set("digest", digest);
  return f.app.request(`${href}/apply`, { method: "POST", headers: { origin: ORIGIN, ...(cookie === undefined ? {} : { cookie }) }, body });
};

const drafts = (f: UploadFixture) =>
  rows(
    f.conn,
    `SELECT dd.specimen_id, dd.determiner_id, a.scientific_name, dd.sex, dd.caste
     FROM determination_draft dd LEFT JOIN animal a ON a.entity_id = dd.animal_id ORDER BY dd.specimen_id`,
  );

/** A cell of the main sheet, by the specimen's id and the column's heading. */
function cellOf(bytes: Uint8Array, specimenId: number, column: string): string {
  const m = matrixOf(bytes);
  const head = m[0]!;
  const row = m.find((r) => r[head.indexOf("specimenId")] === String(specimenId))!;
  return row[head.indexOf(column)]!;
}

/** A sample somebody else collected, whose one specimen Vera may not name; obscured on iNaturalist, so its place is withheld from her. */
async function othersSpecimen(f: UploadFixture): Promise<number> {
  const sample = await insertCleanSample(f.conn, {
    collector_id: String(f.staffer),
    sample_number: "'UP-9'",
    specimen_count: "1",
    locality: "'Secret Creek'",
    county: "'Hidden Co.'",
    geoprivacy: "'obscured'",
  });
  const [[id]] = (await rows(f.conn, `INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sample}, 1, 'OBA19999') RETURNING entity_id`)) as [[number]];
  return id;
}

const insertAnimal = (f: UploadFixture, rank: string, name: string, parent = "NULL") =>
  f.conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) VALUES ('${rank}', '${name}', ${parent})`);

describe("a volunteer's download", () => {
  it("has their own columns, and their own identification: a draft, else their own latest, never an expert's or another volunteer's", async () => {
    const f = await uploadFixture("volunteer");
    // Vera's own determination of b1, older than another volunteer's there, and an expert one of hers on a3 that is not shown.
    await f.conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_id, verbatim_identification, sex, recorded_at)
       SELECT ${f.ids.b1}, entity_id, false, 'in_app', ${f.volunteer}, 'Bombus', 'male', TIMESTAMP '2020-01-01' FROM animal WHERE scientific_name = 'Bombus'`,
    );
    await f.conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_id, verbatim_identification)
       SELECT ${f.ids.a3}, entity_id, true, 'in_app', ${f.volunteer}, 'Bombus' FROM animal WHERE scientific_name = 'Bombus'`,
    );
    await saveDrafts(f.db, f.volunteer, f.volunteer, [{ specimenId: f.ids.a2, animalId: null, sex: "female", caste: null }]);
    const bytes = await ownFile(f);
    expect(matrixOf(bytes)[0]).toEqual([...VOLUNTEER_LAYOUT.headings]);
    for (const column of ["identifiedBy", "dateIdentified", "identificationQualifier", "disposition", "occurrenceRemarks"]) expect(matrixOf(bytes)[0]).not.toContain(column);
    // a1 has only an expert's identification, a3 another volunteer's and an expert one of Vera's: blank, all three cells.
    for (const id of [f.ids.a1, f.ids.a3]) for (const c of ["scientificName", "sex", "caste"]) expect(cellOf(bytes, id, c), `${id} ${c}`).toBe("");
    // A draft on Identify specimens, here a sex with no name yet.
    expect([cellOf(bytes, f.ids.a2, "scientificName"), cellOf(bytes, f.ids.a2, "sex")]).toEqual(["", "female"]);
    // Her own latest that is not an expert's.
    expect([cellOf(bytes, f.ids.b1, "scientificName"), cellOf(bytes, f.ids.b1, "sex")]).toEqual(["Bombus", "male"]);
    expect(cellOf(bytes, f.ids.a1, "specimenVersion")).toMatch(/^o[0-9a-f]{12}$/);
    // Nowhere in the file is the expert's name.
    expect(new TextDecoder().decode(bytes)).not.toContain("Dee Determiner");

    const b = XLSX.read(bytes, { type: "array", dense: true });
    // No identifiers tab: there is no identifiedBy column to look a name up for.
    expect(b.SheetNames).toEqual(["specimens", "names", "words", "about"]);
    const tab = (name: string) => XLSX.utils.sheet_to_json<string[]>(b.Sheets[name]!, { header: 1, blankrows: false });
    // The words are those a draft takes: no gynandromorph, no qualifier or disposition.
    expect(tab("words")[0]).toEqual(["sex", "caste"]);
    expect(tab("words").map((r) => r[0]).slice(1).filter((w) => w !== undefined)).toEqual(["female", "male"]);
    const about = tab("about");
    const text = (topic: string) => about.find((r) => r[0] === topic)?.[1];
    expect(text(en.workbook.about.purposeTopic)).toBe(en.workbook.about.volunteer.purpose);
    expect(text(en.workbook.about.volunteer.draftsTopic)).toBe(en.workbook.about.volunteer.drafts);
    expect(text("sex")).toBe(en.workbook.about.oneOf("female, male"));
    expect(about.map((r) => r[0])).not.toContain("identifiedBy");
    expect(about.flat().join(" ")).not.toMatch(/identifiers tab/);
  });

  it("is staff's file, unchanged, for staff", async () => {
    const f = await uploadFixture("staffer");
    const bytes = await ownFile(f);
    expect(matrixOf(bytes)[0]).toEqual([...SPECIMENS_LAYOUT.headings]);
    expect(cellOf(bytes, f.ids.a1, "identifiedBy")).toBe("Dee Determiner");
    expect(cellOf(bytes, f.ids.a1, "specimenVersion")).toMatch(/^s/);
    expect(XLSX.read(bytes, { type: "array" }).SheetNames).toEqual(["specimens", "names", "identifiers", "words", "about"]);
  });

  it("is the volunteer's own, while staff view Beeline as them", async () => {
    const f = await uploadFixture("volunteer");
    await saveDrafts(f.db, f.volunteer, f.volunteer, [{ specimenId: f.ids.a2, animalId: null, sex: "male", caste: null }]);
    const staff = f.appAs("staffer");
    const cookie = `${IMPERSONATING_COOKIE}=${encodeURIComponent("Vera Volunteer")}`;
    const bytes = new Uint8Array(await (await staff.request("/specimens.xlsx?scope=all", { headers: { cookie } })).arrayBuffer());
    expect(matrixOf(bytes)[0]).toEqual([...VOLUNTEER_LAYOUT.headings]);
    expect(cellOf(bytes, f.ids.a2, "sex")).toBe("male");
    expect(cellOf(bytes, f.ids.a1, "scientificName")).toBe("");
  });

  it("is never taken as the record when staff upload it: every name in it is held", async () => {
    const f = await uploadFixture("volunteer");
    const bytes = edited(await ownFile(f), [{ id: f.ids.a2, set: { scientificName: "Bombus" } }]);
    const staff = f.appAs("staffer");
    const body = new FormData();
    body.set("file", new File([bytes as BlobPart], "hers.xlsx", { type: XLSX_TYPE }));
    const href = (await staff.request("/uploads", { method: "POST", headers: { origin: ORIGIN }, body })).headers.get("location")!;
    const html = await (await staff.request(href)).text();
    expect(html).toContain(en.uploads.page.held.specimen_changed_since!.replaceAll("'", "&#39;"));
    expect(html).toContain(en.uploads.page.notChanged);
  });

  it("offers everyone the upload page from Specimens, with words for a volunteer", async () => {
    const f = await uploadFixture("volunteer");
    const page = await (await f.app.request("/specimens?scope=all")).text();
    expect(page).toContain(`href="/uploads"`);
    expect(page).toContain(en.listings.csv.editNoteVolunteer);
    const form = await (await f.app.request("/uploads")).text();
    expect(form).toContain(en.uploads.headingVolunteer);
    // The request behind a file is staff's bookkeeping.
    expect(form).not.toContain(`name="reference"`);
  });
});

describe("uploading a volunteer's file", () => {
  it("lists their own specimen named, saves it as a draft credited to them, and the overnight commit records it as theirs", async () => {
    const f = await uploadFixture("volunteer");
    const bytes = edited(await ownFile(f), [{ id: f.ids.a2, set: { scientificName: "Bombus vosnesenskii", sex: "female" } }]);
    const { href, html, digest } = await preview(f, bytes);
    expect(html).toContain(en.uploads.page.notSavedYet);
    expect(html).not.toContain(en.uploads.page.notChanged);
    expect(html).toContain(en.uploads.page.save);
    expect(html).toContain(en.uploads.page.saveNote(1, 0));
    expect(digest).not.toBeNull();
    expect(await drafts(f)).toEqual([]);

    const res = await apply(f, href, digest!);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(href);
    expect(await drafts(f)).toEqual([[f.ids.a2, f.volunteer, "Bombus vosnesenskii", "female", null]]);
    expect(await rows(f.conn, `SELECT applied_by, draft_count FROM upload_applied`)).toEqual([[f.volunteer, 1]]);
    const after = await (await f.app.request(href)).text();
    expect(after).toContain("Saved 1 identification from this file as drafts");
    expect(after).not.toContain(en.uploads.page.save);

    // Committed overnight as her own determination, never an expert's.
    await commitDeterminationDrafts(f.conn);
    expect(
      await rows(
        f.conn,
        `SELECT d.determiner_id, d.is_expert, d.channel, a.scientific_name, d.sex FROM determination d JOIN animal a ON a.entity_id = d.animal_id WHERE d.specimen_id = ${f.ids.a2}`,
      ),
    ).toEqual([[f.volunteer, false, "in_app", "Bombus vosnesenskii", "female"]]);
  });

  it("refuses staff's file, whose names are the record's and an expert's among them, and keeps nothing", async () => {
    const f = await uploadFixture("volunteer");
    const res = await upload(f, await f.download());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(en.uploads.refused.staff_file!.replaceAll("'", "&#39;"));
    expect(await rows(f.conn, `SELECT count(*) FROM upload`)).toEqual([[0n]]);
  });

  it("holds a row for a specimen they cannot name, saving nothing for it, and counts the rest; never shows a place withheld from them", async () => {
    const f = await uploadFixture("volunteer");
    const other = await othersSpecimen(f);
    const file = await ownFile(f);
    // Her download leaves the obscured sample's place out, as her listing does.
    expect(cellOf(file, other, "locality")).toBe("");
    expect(new TextDecoder().decode(file)).not.toContain("Secret Creek");
    const bytes = edited(file, [
      { id: other, set: { scientificName: "Bombus", locality: "Elsewhere" } },
      { id: f.ids.a2, set: { scientificName: "Bombus" } },
    ]);
    const { href, html, digest } = await preview(f, bytes);
    expect(html).toContain(en.uploads.page.held.not_yours);
    expect(html).not.toContain("Secret Creek");
    expect(html).not.toContain("Hidden Co.");
    await apply(f, href, digest!);
    expect((await drafts(f)).map((r) => r[0])).toEqual([f.ids.a2]);

    // A file of one untouched row of someone else's: counted, listed nowhere.
    const quiet = await preview(f, edited(file, [{ id: f.ids.a2, set: { scientificName: "Bombus vosnesenskii" } }]));
    expect(quiet.html).not.toContain(en.uploads.page.held.not_yours);
    expect(quiet.html).toContain(en.uploads.page.notYours(1).replaceAll("'", "&#39;"));
  });

  it("holds what a draft cannot take, or would change, with words saying what to write", async () => {
    const f = await uploadFixture("volunteer");
    // Bumble bees have castes; Osmia has none; a second Bombus at another rank makes the name ambiguous.
    await f.conn.run(`INSERT OR REPLACE INTO animal_caste (rank, scientific_name, has_castes) VALUES ('genus', 'Bombus', true)`);
    await insertAnimal(f, "genus", "Osmia");
    await insertAnimal(f, "subgenus", "Pyrobombus");
    await insertAnimal(f, "species", "Pyrobombus", `(SELECT entity_id FROM animal WHERE scientific_name = 'Bombus' AND rank = 'genus')`);
    const extra = await insertCleanSample(f.conn, { collector_id: String(f.volunteer), sample_number: "'UP-5'", specimen_count: "6" });
    const ids: number[] = [];
    for (let n = 1; n <= 6; n++) {
      const [[id]] = (await rows(f.conn, `INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${extra}, ${n}, 'OBA2000${n}') RETURNING entity_id`)) as [[number]];
      ids.push(id);
    }
    const [notInTree, ambiguous, gynandromorph, casteOnOsmia, casteNoSex, maleBombus] = ids as [number, number, number, number, number, number];
    const bytes = edited(await ownFile(f), [
      { id: notInTree, set: { scientificName: "Bombus imaginarius" } },
      { id: ambiguous, set: { scientificName: "Pyrobombus" } },
      { id: gynandromorph, set: { scientificName: "Osmia", sex: "gynandromorph" } },
      { id: casteOnOsmia, set: { scientificName: "Osmia", sex: "female", caste: "worker" } },
      { id: casteNoSex, set: { scientificName: "Bombus", caste: "worker" } },
      { id: maleBombus, set: { scientificName: "Bombus", sex: "male" } },
      // What another volunteer already said of a3: nothing to save.
      { id: f.ids.a3, set: { scientificName: "Bombus vosnesenskii", sex: "female" } },
      // And one that is fine.
      { id: f.ids.a2, set: { scientificName: "Bombus", sex: "male", caste: "drone" } },
    ]);
    const { href, html, digest } = await preview(f, bytes);
    for (const reason of ["name_not_in_tree", "name_ambiguous", "sex_not_draft", "caste_not_taken", "caste_no_sex", "drone_unsaid", "already_said"]) {
      expect(html, reason).toContain(en.uploads.page.held[reason]!.replaceAll("'", "&#39;"));
      expect(html, reason).toContain(en.uploads.page.heldTodo[reason]!.replaceAll("'", "&#39;"));
    }
    expect(html).toContain(en.uploads.page.saveNote(1, 0));
    await apply(f, href, digest!);
    expect(await drafts(f)).toEqual([[f.ids.a2, f.volunteer, "Bombus", "male", "drone"]]);
  });

  it("replaces a draft made on Identify specimens, and says so; holds one made there after the download", async () => {
    const f = await uploadFixture("volunteer");
    await saveDrafts(f.db, f.volunteer, f.volunteer, [{ specimenId: f.ids.a2, animalId: null, sex: "female", caste: null }]);
    const file = await ownFile(f);
    // After the download, a draft of a1 on the page: the file's row for a1 is now out of date.
    await saveDrafts(f.db, f.volunteer, f.volunteer, [{ specimenId: f.ids.a1, animalId: null, sex: "male", caste: null }]);
    const bytes = edited(file, [
      { id: f.ids.a2, set: { scientificName: "Bombus vosnesenskii" } },
      { id: f.ids.a1, set: { scientificName: "Bombus" } },
    ]);
    const { href, html, digest } = await preview(f, bytes);
    expect(html).toContain(en.uploads.page.replacesDraft);
    expect(html).toContain(en.uploads.page.saveNote(1, 1));
    expect(html).toContain(en.uploads.page.held.specimen_changed_since!.replaceAll("'", "&#39;"));
    await apply(f, href, digest!);
    expect(await drafts(f)).toEqual([
      [f.ids.a1, f.volunteer, null, "male", null],
      [f.ids.a2, f.volunteer, "Bombus vosnesenskii", "female", null],
    ]);
  });

  it("saves nothing when the plan changed since the preview, and shows the new one", async () => {
    const f = await uploadFixture("volunteer");
    const bytes = edited(await ownFile(f), [
      { id: f.ids.a2, set: { scientificName: "Bombus" } },
      { id: f.ids.a1, set: { scientificName: "Bombus vosnesenskii" } },
    ]);
    const { href, digest } = await preview(f, bytes);
    // On Identify specimens, meanwhile, a1 is named: the file's row for it is now out of date.
    await saveDrafts(f.db, f.volunteer, f.volunteer, [{ specimenId: f.ids.a1, animalId: null, sex: "female", caste: null }]);
    const res = await apply(f, href, digest!);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(en.uploads.page.changedSince);
    expect(html).toContain(en.uploads.page.saveNote(1, 0));
    expect(await rows(f.conn, `SELECT count(*) FROM upload_applied`)).toEqual([[0n]]);
    expect((await drafts(f)).map((r) => r[0])).toEqual([f.ids.a1]);
  });

  it("saves once when the same preview is submitted twice at once", async () => {
    const f = await uploadFixture("volunteer");
    const { href, digest } = await preview(f, edited(await ownFile(f), [{ id: f.ids.a2, set: { scientificName: "Bombus" } }]));
    const [one, two] = await Promise.all([apply(f, href, digest!), apply(f, href, digest!)]);
    expect([one.status, two.status]).toEqual([303, 303]);
    expect(await rows(f.conn, `SELECT count(*) FROM upload_applied`)).toEqual([[1n]]);
    expect(await drafts(f)).toEqual([[f.ids.a2, f.volunteer, "Bombus", null, null]]);
    // And once more, afterwards: still once.
    expect((await apply(f, href, digest!)).status).toBe(303);
    expect(await rows(f.conn, `SELECT count(*) FROM upload_applied`)).toEqual([[1n]]);
  });
});

describe("what keeps its own reason", () => {
  it("keeps a held row's reason when the specimen is the person's, and holds both ways a caste can contradict the sex", async () => {
    const f = await uploadFixture("volunteer");
    await f.conn.run(`INSERT OR REPLACE INTO animal_caste (rank, scientific_name, has_castes) VALUES ('genus', 'Bombus', true)`);
    const bytes = edited(await ownFile(f), [
      // Her own specimen, its field number changed: held for that, not as someone else's.
      { id: f.ids.a1, set: { fieldNumber: "OBA99999", scientificName: "Bombus" } },
      { id: f.ids.a2, set: { scientificName: "Bombus", sex: "male", caste: "worker" } },
      { id: f.ids.b1, set: { scientificName: "Bombus", sex: "female", caste: "drone" } },
    ]);
    const { html, digest } = await preview(f, bytes);
    expect(html).toContain(en.uploads.page.held.number_disagrees);
    expect(html).not.toContain(en.uploads.page.held.not_yours);
    // Both rows under the one heading: a male worker and a female drone.
    const section = html.slice(html.indexOf(en.uploads.page.held.caste_sex!)).split("<h3")[0]!;
    expect(section).toContain(">OBA10002<");
    expect(section).toContain(">OBA10004<");
    expect(digest).toBeNull();
  });

  it("still shows the upload of someone no longer staff, read as staff's file, and saves none of it", async () => {
    const f = await uploadFixture("staffer");
    const res = await upload(f, edited(await f.download(), [{ id: f.ids.a2, set: { scientificName: "Bombus" } }]));
    const href = res.headers.get("location")!;
    await f.conn.run(`DELETE FROM person_admin WHERE person_id = ${f.staffer}`);
    const page = await f.app.request(href);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(en.uploads.page.notChanged);
    expect((await apply(f, href, "0".repeat(32))).status).toBe(404);
    expect(await drafts(f)).toEqual([]);
  });
});

describe("whose upload it is", () => {
  it("answers a volunteer 404 for someone else's upload, on the page and on saving", async () => {
    const f = await uploadFixture("volunteer");
    // Dana's upload, in the same store, of a file of her own.
    const dana = f.appAs("delegate");
    const body = new FormData();
    body.set("file", new File([(await ownFile(f)) as BlobPart], "hers.xlsx", { type: XLSX_TYPE }));
    const theirs = (await dana.request("/uploads", { method: "POST", headers: { origin: ORIGIN }, body })).headers.get("location")!;
    expect(theirs).toMatch(/^\/uploads\/\d+$/);
    expect((await f.app.request(theirs)).status).toBe(404);
    expect((await apply(f, theirs, "0".repeat(32))).status).toBe(404);
    // Nor is it in her list.
    expect(await (await f.app.request("/uploads")).text()).not.toContain(`href="${theirs}"`);
  });

  it("shows staff a volunteer's preview as the volunteer sees it, with nothing to save, and staff cannot save it", async () => {
    const f = await uploadFixture("volunteer");
    const other = await othersSpecimen(f);
    const mine = await preview(f, edited(await ownFile(f), [{ id: f.ids.a2, set: { scientificName: "Bombus" } }, { id: other, set: { locality: "Elsewhere" } }]));
    const staff = f.appAs("staffer");
    const html = await (await staff.request(mine.href)).text();
    expect(html).toContain(en.uploads.page.notSavedYet);
    expect(html).toContain(en.uploads.page.kind.determination);
    expect(html).not.toContain(`name="digest"`);
    // Compared as Vera: the place withheld from her is not shown, even to staff, on her preview.
    expect(html).not.toContain("Secret Creek");
    const body = new FormData();
    body.set("digest", mine.digest!);
    expect((await staff.request(`${mine.href}/apply`, { method: "POST", headers: { origin: ORIGIN }, body })).status).toBe(404);
    expect(await drafts(f)).toEqual([]);
  });

  it("refuses everything while staff view Beeline as the volunteer", async () => {
    const f = await uploadFixture("volunteer");
    const mine = await preview(f, edited(await ownFile(f), [{ id: f.ids.a2, set: { scientificName: "Bombus" } }]));
    const staff = f.appAs("staffer");
    const cookie = `${IMPERSONATING_COOKIE}=${encodeURIComponent("Vera Volunteer")}`;
    expect((await staff.request("/uploads", { headers: { cookie } })).status).toBe(403);
    expect((await apply({ ...f, app: staff }, mine.href, mine.digest!, cookie)).status).toBe(403);
    expect(await drafts(f)).toEqual([]);
  });
});

describe("a delegate's upload", () => {
  it("reaches the household's specimens with the switch on, and credits the drafts to the delegate", async () => {
    const f = await uploadFixture("delegate");
    const acting = `${ACTING_COOKIE}=${encodeURIComponent("Vera Volunteer")}`;
    const file = await ownFile(f, acting, "mine");
    // Vera's specimens, with Dana's own identifications: none yet.
    expect(cellOf(file, f.ids.a1, "scientificName")).toBe("");
    const { href, digest } = await preview(f, edited(file, [{ id: f.ids.a1, set: { scientificName: "Bombus", sex: "female" } }]), acting);
    expect((await apply(f, href, digest!, acting)).status).toBe(303);
    expect(await drafts(f)).toEqual([[f.ids.a1, f.delegate, "Bombus", "female", null]]);
  });

  it("reaches nothing of the household's without the switch", async () => {
    const f = await uploadFixture("delegate");
    const acting = `${ACTING_COOKIE}=${encodeURIComponent("Vera Volunteer")}`;
    const file = await ownFile(f, acting, "mine");
    const { html, digest } = await preview(f, edited(file, [{ id: f.ids.a1, set: { scientificName: "Bombus" } }]));
    expect(html).toContain(en.uploads.page.held.not_yours);
    expect(digest).toBeNull();
  });
});
