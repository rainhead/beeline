import { describe as describeInOrder, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { en } from "../src/app/messages/en.js";
import { ACTING_COOKIE, IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { NOTE_COLUMN, VOLUNTEER_LAYOUT, SPECIMENS_LAYOUT } from "../src/app/upload-plan.js";
import { saveDrafts } from "../src/app/determine.js";
import { draftState } from "../src/app/upload-drafts.js";
import { commitDeterminationDrafts } from "../src/commit-determinations.js";
import { insertCleanSample, rows } from "./helpers.js";
import { edited, matrixOf, uploadFixture, type UploadFixture } from "./upload-fixture.js";
import { buildWorkbook } from "./workbook.js";
import { unzipSync } from "fflate";

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
  return { href, html, digest, notes: await notesOf(f, href, cookie) };
}

/** The note on each row of the file handed back, by the row's specimenId cell. */
async function notesOf(f: UploadFixture | { app: UploadFixture["app"] }, href: string, cookie?: string): Promise<Map<string, string>> {
  const res = await f.app.request(`${href}/notes`, cookie === undefined ? {} : { headers: { cookie } });
  expect(res.status).toBe(200);
  const m = matrixOf(new Uint8Array(await res.arrayBuffer()));
  const note = m[0]!.indexOf(NOTE_COLUMN);
  expect(note).toBeGreaterThan(-1);
  const at = m[0]!.indexOf("specimenId");
  return new Map(m.slice(1).map((r) => [r[at]!, r[note] ?? ""]));
}

const p = en.uploads.page;
const n = en.uploads.notes;
const esc = (text: string) => text.replaceAll("'", "&#39;");

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
    expect(html).toContain(esc(p.staffNothingChanged));
    expect((await notesOf({ app: staff }, href)).get(String(f.ids.a2))).toBe(n.cantUse(n.reason.specimen_changed_since!));
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
    const { href, html, digest, notes } = await preview(f, bytes);
    expect(html).toContain(p.ready(1));
    expect(html).toContain(p.same(3));
    expect(html).toContain(p.save(1));
    expect(html).not.toContain(esc(p.staffNothingChanged));
    // Nothing that can't be saved, so no file of notes offered; and every note blank.
    expect(html).not.toContain(p.download);
    expect([...notes.values()].every((note) => note === "")).toBe(true);
    expect(digest).not.toBeNull();
    expect(await drafts(f)).toEqual([]);

    const res = await apply(f, href, digest!);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(href);
    expect(await drafts(f)).toEqual([[f.ids.a2, f.volunteer, "Bombus vosnesenskii", "female", null]]);
    expect(await rows(f.conn, `SELECT applied_by, draft_count FROM upload_applied`)).toEqual([[f.volunteer, 1]]);
    const after = await (await f.app.request(href)).text();
    expect(after).toContain("Saved 1 identification on ");
    expect(after).toContain("They are on Identify specimens now, and can be undone there until 1am Pacific.");
    expect(after).not.toContain(p.save(1));
    // Worked out again, the saved row now says what Beeline has.
    expect(after).toContain(p.same(4));

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
    const { href, html, digest, notes } = await preview(f, bytes);
    expect(html).toContain(esc(p.notSaved(1)));
    expect(notes.get(String(other))).toBe(n.notSaved(n.reason.not_yours!));
    expect(html).not.toContain("Secret Creek");
    expect(html).not.toContain("Hidden Co.");
    expect([...notes.values()].join(" ")).not.toContain("Secret Creek");
    await apply(f, href, digest!);
    expect((await drafts(f)).map((r) => r[0])).toEqual([f.ids.a2]);

    // A new file whose row of someone else's is untouched: the same as Beeline has, with no note.
    const quiet = await preview(f, edited(await ownFile(f), [{ id: f.ids.a3, set: { scientificName: "Bombus" } }]));
    expect(quiet.notes.get(String(other))).toBe("");
    expect(quiet.html).not.toContain(esc(p.notSaved(1)));
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
    const { href, html, digest, notes } = await preview(f, bytes);
    const expected: Array<[number, string]> = [
      [notInTree, "name_not_in_tree"],
      [ambiguous, "name_ambiguous"],
      [gynandromorph, "sex_not_draft"],
      [casteOnOsmia, "caste_not_taken"],
      [casteNoSex, "caste_no_sex"],
      [maleBombus, "drone_unsaid"],
    ];
    for (const [id, reason] of expected) expect(notes.get(String(id)), reason).toBe(n.notSaved(n.reason[reason]!));
    // What another volunteer already said: the same as Beeline has, with no note.
    expect(notes.get(String(f.ids.a3))).toBe("");
    expect(notes.get(String(f.ids.a2))).toBe("");
    expect(html).toContain(p.ready(1));
    expect(html).toContain(esc(p.notSaved(6)));
    expect(html).toContain(p.download);
    await apply(f, href, digest!);
    expect(await drafts(f)).toEqual([[f.ids.a2, f.volunteer, "Bombus", "male", "drone"]]);
  });

  it("does not save a name that only agrees with another volunteer's while she has something typed on Identify specimens", async () => {
    const f = await uploadFixture("volunteer");
    // Her own older identification of a2, another volunteer's newer one, and a sex she typed on Identify specimens.
    await f.conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_id, verbatim_identification, recorded_at)
       SELECT ${f.ids.a2}, entity_id, false, 'in_app', ${f.volunteer}, 'Bombus', TIMESTAMP '2020-01-01' FROM animal WHERE scientific_name = 'Bombus'`,
    );
    await f.conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_name, verbatim_identification, sex)
       SELECT ${f.ids.a2}, entity_id, false, 'in_app', 'A Volunteer', 'Bombus vosnesenskii', 'female' FROM animal WHERE scientific_name = 'Bombus vosnesenskii'`,
    );
    await saveDrafts(f.db, f.volunteer, f.volunteer, [{ specimenId: f.ids.a2, sex: "male", caste: null }]);
    const { notes, digest } = await preview(f, edited(await ownFile(f), [{ id: f.ids.a2, set: { scientificName: "Bombus vosnesenskii", sex: "female", caste: "" } }]));
    expect(notes.get(String(f.ids.a2))).toBe(n.notSaved(n.reason.matches_another!));
    expect(digest).toBeNull();
    expect((await drafts(f)).map((r) => r[0])).toEqual([f.ids.a2]);
  });

  it("replaces what was typed on Identify specimens before the download; holds a row changed there after it", async () => {
    const f = await uploadFixture("volunteer");
    await saveDrafts(f.db, f.volunteer, f.volunteer, [{ specimenId: f.ids.a2, animalId: null, sex: "female", caste: null }]);
    const file = await ownFile(f);
    // After the download, a draft of a1 on the page: the file's row for a1 is now out of date.
    await saveDrafts(f.db, f.volunteer, f.volunteer, [{ specimenId: f.ids.a1, animalId: null, sex: "male", caste: null }]);
    const bytes = edited(file, [
      { id: f.ids.a2, set: { scientificName: "Bombus vosnesenskii" } },
      { id: f.ids.a1, set: { scientificName: "Bombus" } },
    ]);
    const { href, html, digest, notes } = await preview(f, bytes);
    expect(html).toContain(p.ready(1));
    expect(notes.get(String(f.ids.a2))).toBe("");
    expect(notes.get(String(f.ids.a1))).toBe(n.notSaved(n.reason.specimen_changed_since!));
    await apply(f, href, digest!);
    expect(await drafts(f)).toEqual([
      [f.ids.a1, f.volunteer, null, "male", null],
      [f.ids.a2, f.volunteer, "Bombus vosnesenskii", "female", null],
    ]);
  });

  it("sets the sex of a draft naming a taxon Ecdysis no longer offers, keeping its name", async () => {
    const f = await uploadFixture("volunteer");
    // A sawfly from Ecdysis, in the thesaurus but not among the names that may be picked now (not in ecdysis_adoptable).
    await f.conn.run(
      `INSERT INTO ecdysis_taxon (tid, rank, name, status, accepted_tid, fetched_on) VALUES (777001, 'genus', 'Tenthredo', 'accepted', 777001, DATE '2026-11-01')`,
    );
    await f.conn.run(`INSERT INTO determination_draft (specimen_id, determiner_id, ecdysis_tid, sex) VALUES (${f.ids.a2}, ${f.volunteer}, 777001, NULL)`);
    const file = await ownFile(f);
    expect(cellOf(file, f.ids.a2, "scientificName")).toBe("Tenthredo");
    const { href, digest } = await preview(f, edited(file, [{ id: f.ids.a2, set: { sex: "female" } }]));
    expect(digest).not.toBeNull();
    expect((await apply(f, href, digest!)).status).toBe(303);
    expect(await rows(f.conn, `SELECT CAST(ecdysis_tid AS INTEGER), animal_id, sex FROM determination_draft WHERE specimen_id = ${f.ids.a2}`)).toEqual([
      [777001, null, "female"],
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
    expect(html).toContain(esc(p.changedSince));
    expect(html).toContain(p.ready(1));
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

  it("tells a second Save that the first saved, when the second works its plan out after the first has saved", async () => {
    // Both requests read the upload before either saves; the one that arrives second works its plan out only after
    // the other is done, so it sees the saved rows as the same as Beeline has and a plan that changed.
    let arrived = 0;
    let bothIn!: () => void;
    const together = new Promise<void>((resolve) => (bothIn = resolve));
    let eitherDone: Promise<unknown> | undefined;
    const f = await uploadFixture("volunteer", {
      applyPause: async () => {
        if (++arrived === 1) await together;
        else {
          bothIn();
          await eitherDone;
        }
      },
    });
    const { href, digest } = await preview(f, edited(await ownFile(f), [{ id: f.ids.a2, set: { scientificName: "Bombus" } }]));
    const one = Promise.resolve(apply(f, href, digest!));
    const two = Promise.resolve(apply(f, href, digest!));
    eitherDone = Promise.race([one, two]);
    const answers = await Promise.all([one, two]);
    expect(arrived).toBe(2);
    expect(answers.map((r) => r.status)).toEqual([303, 303]);
    for (const r of answers) expect(r.headers.get("location")).toBe(href);
    expect(await rows(f.conn, `SELECT count(*) FROM upload_applied`)).toEqual([[1n]]);
  });

  it("saves nothing when something changed on Identify specimens while the plan was worked out, even on a row the file leaves alone", async () => {
    let changed: (() => Promise<unknown>) | undefined;
    const f = await uploadFixture("volunteer", { applyPause: async () => void (await changed?.()) });
    const { href, digest } = await preview(f, edited(await ownFile(f), [{ id: f.ids.a2, set: { scientificName: "Bombus" } }]));
    // While the plan is being worked out, she names a1 on Identify specimens: a row the file does not change.
    changed = () => saveDrafts(f.db, f.volunteer, f.volunteer, [{ specimenId: f.ids.a1, sex: "female", caste: null }]);
    const res = await apply(f, href, digest!);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(esc(p.changedSince));
    expect(await rows(f.conn, `SELECT count(*) FROM upload_applied`)).toEqual([[0n]]);
    expect((await drafts(f)).map((r) => r[0])).toEqual([f.ids.a1]);
  });

  it("re-reads, when saving, what it read of the bees to be saved, and sees a change made on Identify specimens", async () => {
    const f = await uploadFixture("volunteer");
    const who = { personId: f.volunteer, determinerId: f.volunteer };
    const before = await draftState(f.db, who, [f.ids.a1, f.ids.a2]);
    expect(await draftState(f.db, who, [f.ids.a1, f.ids.a2])).toBe(before);
    await saveDrafts(f.db, f.volunteer, f.volunteer, [{ specimenId: f.ids.a2, sex: "female", caste: null }]);
    expect(await draftState(f.db, who, [f.ids.a1, f.ids.a2])).not.toBe(before);
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
    const { digest, notes } = await preview(f, bytes);
    expect(notes.get(String(f.ids.a1))).toBe(n.notSaved(n.reason.number_disagrees!));
    // A male worker and a female drone.
    expect(notes.get(String(f.ids.a2))).toBe(n.notSaved(n.reason.caste_sex!));
    expect(notes.get(String(f.ids.b1))).toBe(n.notSaved(n.reason.caste_sex!));
    expect(digest).toBeNull();
  });

  it("still shows the upload of someone no longer staff, read as staff's file, with no place now withheld from them, and saves none of it", async () => {
    const f = await uploadFixture("staffer");
    const res = await upload(f, edited(await f.download(), [{ id: f.ids.a2, set: { scientificName: "Bombus", locality: "Elsewhere" } }]));
    const href = res.headers.get("location")!;
    // Vera's sample, obscured on iNaturalist: its place is Vera's and staff's to see.
    await f.conn.run(`UPDATE sample SET geoprivacy = 'obscured' WHERE entity_id = ${f.ids.sampleA}`);
    // As staff, the notes say what Beeline holds for the place.
    const was = n.cell("locality", '"Corvallis"', '"Elsewhere"');
    expect((await notesOf(f, href)).get(String(f.ids.a2))).toContain(was);
    await f.conn.run(`DELETE FROM person_admin WHERE person_id = ${f.staffer}`);
    const page = await f.app.request(href);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(esc(p.staffNothingChanged));
    // No longer staff, he is not shown it: what Beeline holds reads as blank.
    const now = (await notesOf(f, href)).get(String(f.ids.a2))!;
    expect(now).not.toContain("Corvallis");
    expect(now).toContain(n.cell("locality", n.nothing, '"Elsewhere"'));
    expect((await apply(f, href, "0".repeat(32))).status).toBe(404);
    expect(await drafts(f)).toEqual([]);
  });
});

describe("the page", () => {
  it("says only the counts that are not zero, offers nothing that does nothing, and lists no rows", async () => {
    const f = await uploadFixture("volunteer");
    const unchanged = await preview(f, await ownFile(f));
    expect(unchanged.html).toContain(p.same(4));
    expect(unchanged.html).not.toMatch(/ready to save|can&#39;t be saved|grey columns|Download your file/);
    expect(unchanged.digest).toBeNull();
    expect(unchanged.html).not.toContain("<h2");
    // A change to a grey column: noted, counted, never saved.
    const grey = await preview(f, edited(await ownFile(f), [{ id: f.ids.a1, set: { locality: "Elsewhere" } }]));
    expect(grey.html).toContain(esc(p.grey(1)));
    expect(grey.html).toContain(p.download);
    expect(grey.notes.get(String(f.ids.a1))).toBe(n.grey);
    expect(grey.digest).toBeNull();
  });

  it("hands back her own file with a note on each row, which she can fix and upload again", async () => {
    const f = await uploadFixture("volunteer");
    const first = await preview(f, edited(await ownFile(f), [{ id: f.ids.a2, set: { scientificName: "Bombus imaginarius" } }]));
    expect(first.notes.get(String(f.ids.a2))).toBe(n.notSaved(n.reason.name_not_in_tree!));
    const noted = new Uint8Array(await (await f.app.request(`${first.href}/notes`)).arrayBuffer());
    // Her own file, tabs and all: this one was made with only the one tab.
    expect(XLSX.read(noted, { type: "array" }).SheetNames).toEqual(["specimens"]);
    // She fixes the name in the file with notes and uploads it: the note column is not read, and the name is ready.
    const again = await preview(f, edited(noted, [{ id: f.ids.a2, set: { scientificName: "Bombus" } }]));
    expect(again.html).toContain(p.ready(1));
    expect(again.html).not.toContain("didn&#39;t read these columns");
    expect(again.notes.get(String(f.ids.a2))).toBe("");
  });

  it("hands back Beeline's own download as she uploaded it, every part the same, with the note column after the last", async () => {
    const f = await uploadFixture("volunteer");
    const mine = await ownFile(f);
    // After she downloads, she names a2 on Identify specimens: her file's blank name for it now can't be saved.
    await saveDrafts(f.db, f.volunteer, f.volunteer, [{ specimenId: f.ids.a2, animalId: null, sex: "male", caste: null }]);
    const { href, notes, html } = await preview(f, mine);
    expect(html).not.toContain(esc(p.notesCopy));
    expect(notes.get(String(f.ids.a2))).toMatch(/^Not saved: /);
    const back = new Uint8Array(await (await f.app.request(`${href}/notes`)).arrayBuffer());
    const [a, b] = [unzipSync(mine), unzipSync(back)];
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    const changed = Object.keys(a).filter((name) => Buffer.compare(Buffer.from(a[name]!), Buffer.from(b[name]!)) !== 0);
    expect(changed).toEqual(["xl/worksheets/sheet1.xml"]);
    const [was, now] = [matrixOf(mine), matrixOf(back)];
    expect(now[0]).toEqual([...was[0]!, NOTE_COLUMN]);
    was.slice(1).forEach((row, i) => expect(now[i + 1]!.slice(0, row.length)).toEqual(row));
  });

  it("hands back a copy, and says so, for a file it cannot add a column to safely", async () => {
    const f = await uploadFixture("volunteer");
    const m = matrixOf(edited(await ownFile(f), [{ id: f.ids.a2, set: { scientificName: "Bombus imaginarius" } }]));
    const withTable = buildWorkbook(m, { afterSheetData: `<tableParts count="1"><tablePart r:id="rId5"/></tableParts>` });
    const { href, html, notes } = await preview(f, withTable);
    expect(html).toContain(esc(p.notesCopy));
    expect(notes.get(String(f.ids.a2))).toBe(n.notSaved(n.reason.name_not_in_tree!));
    const book = XLSX.read(new Uint8Array(await (await f.app.request(`${href}/notes`)).arrayBuffer()), { type: "array" });
    expect(book.SheetNames).toEqual(["specimens", "names", "words", "about"]);
  });

  it("never says held, hold, draft, plan, unit, reader or layout to a volunteer, on the page, in the notes, or in the file's about tab", async () => {
    const f = await uploadFixture("volunteer");
    const jargon = /\b(held|hold|holds|draft|drafts|plan|unit|reader|layout)\b/i;
    const { html } = await preview(f, edited(await ownFile(f), [{ id: f.ids.a2, set: { scientificName: "Bombus imaginarius" } }, { id: f.ids.a1, set: { locality: "x" } }]));
    const text = html.replace(/<[^>]*>/g, " ");
    expect(text).not.toMatch(jargon);
    for (const note of Object.values(n.reason)) expect(note).not.toMatch(jargon);
    for (const words of [n.grey, en.uploads.introVolunteer, en.uploads.headingVolunteer, en.uploads.form.fileHintVolunteer, en.uploads.refused.staff_file!, en.listings.csv.editNoteVolunteer])
      expect(words).not.toMatch(jargon);
    const about = XLSX.utils.sheet_to_json<string[]>(XLSX.read(await ownFile(f), { type: "array" }).Sheets.about!, { header: 1 });
    for (const [, words] of about) expect(String(words ?? "")).not.toMatch(jargon);
  });
});

describe("the copy in Drive", () => {
  it("links only staff to it: a volunteer cannot open the program's shared drive", async () => {
    const archive = { keep: async () => "drive-9", discard: async () => {} };
    const f = await uploadFixture("volunteer", { archive });
    const mine = await preview(f, edited(await ownFile(f), [{ id: f.ids.a2, set: { scientificName: "Bombus" } }]));
    expect(await rows(f.conn, `SELECT drive_file_id FROM upload`)).toEqual([["drive-9"]]);
    expect(mine.html).not.toContain("drive.google.com");
    expect(await (await f.appAs("staffer").request(mine.href)).text()).toContain("https://drive.google.com/file/d/drive-9/view");
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
    expect(html).toContain(p.ready(1));
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
    const { notes, digest } = await preview(f, edited(file, [{ id: f.ids.a1, set: { scientificName: "Bombus" } }]));
    expect(notes.get(String(f.ids.a1))).toBe(n.notSaved(n.reason.not_yours!));
    expect(digest).toBeNull();
  });
});
