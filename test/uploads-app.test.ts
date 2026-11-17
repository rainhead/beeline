import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { en } from "../src/app/messages/en.js";
import { MAX_FILE_BYTES, SPECIMENS_LAYOUT, UNIT_COLUMNS } from "../src/app/upload-plan.js";
import { IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { rows } from "./helpers.js";
import { CURRENT_SEASON } from "./helpers.js";
import { bytesOf, edited, matrixOf, uploadFixture, type UploadFixture } from "./upload-fixture.js";
import { buildWorkbook, serialOf } from "./workbook.js";

/**
 * This file tests how the page shows every kind of unit, though the specimens file reads only a specimen's two: a
 * sample's dates, place and coordinates wait for the samples upload (beeline-kgyd.4). So for the run of this file, and
 * only this file, every column that belongs to a unit is named as read. The comparison's own tests do the same by
 * giving it a parsed upload (test/upload-plan.test.ts); here it is the app's route that is given the wider layout.
 */
const narrow = SPECIMENS_LAYOUT.read;
const readColumns = (read: readonly string[]) => {
  (SPECIMENS_LAYOUT as { read: readonly string[] }).read = read;
};
beforeAll(() => readColumns(UNIT_COLUMNS));
afterAll(() => readColumns(narrow));

const ORIGIN = "http://localhost:3054";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const esc = (text: string) => text.replaceAll("'", "&#39;");

const upload = (f: UploadFixture, file: Uint8Array | string, fileName = "edited.xlsx", fields: Record<string, string> = {}, cookie?: string) => {
  const body = new FormData();
  body.set("file", new File([file as BlobPart], fileName, { type: XLSX }));
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return f.app.request("/uploads", { method: "POST", headers: { origin: ORIGIN, ...(cookie === undefined ? {} : { cookie }) }, body });
};

/** Every row a later slice would change, as text, so a before and an after can be compared. */
const records = async (f: UploadFixture) =>
  JSON.stringify(
    await Promise.all(
      ["determination", "sample", "specimen", "specimen_disposition", "sample_location"].map((t) =>
        rows(f.conn, `SELECT * FROM ${t} ORDER BY 1`).then((r) => r.map((row) => row.map(String))),
      ),
    ),
  );

const uploadCount = async (f: UploadFixture) => Number((await rows(f.conn, `SELECT count(*) FROM upload`))[0]![0]);
const kept = async (f: UploadFixture) => {
  try {
    return await readdir(f.paths.uploadsDir);
  } catch {
    return [];
  }
};

describe("uploads: who may use them", () => {
  it("answers a volunteer no, on every route, though the Excel file is theirs to download", async () => {
    const f = await uploadFixture("volunteer");
    expect((await f.app.request("/uploads")).status).toBe(403);
    expect((await upload(f, await f.download())).status).toBe(403);
    expect((await f.app.request("/uploads/1")).status).toBe(403);
    expect(await uploadCount(f)).toBe(0);
    expect(await kept(f)).toEqual([]);
    // Not offered the link to upload, and offered the file to edit.
    const page = await (await f.app.request("/specimens?scope=all")).text();
    expect(page).not.toContain(`href="/uploads"`);
    expect(page).toContain("/specimens.xlsx?");
    // The download is written from the layout the app has, so it gets the real one and not this file's wider one.
    readColumns(narrow);
    try {
      expect((await f.app.request("/specimens.xlsx?scope=all")).status).toBe(200);
    } finally {
      readColumns(UNIT_COLUMNS);
    }
  });

  it("refuses staff who are viewing Beeline as somebody else", async () => {
    const f = await uploadFixture();
    const cookie = `${IMPERSONATING_COOKIE}=${encodeURIComponent("Vera Volunteer")}`;
    const get = await f.app.request("/uploads", { headers: { cookie } });
    expect(get.status).toBe(403);
    const post = await upload(f, await f.download(), "edited.xlsx", {}, cookie);
    expect(post.status).toBe(403);
    expect(await post.text()).toBe(en.errors.readOnlyImpersonating);
    expect(await uploadCount(f)).toBe(0);
    expect(await kept(f)).toEqual([]);
  });

  it("links staff to it from the specimens listing, beside the Excel file, and from the exports", async () => {
    const f = await uploadFixture();
    const page = await (await f.app.request("/specimens?scope=all")).text();
    expect(page).toContain(`href="/uploads"`);
    expect(page).toContain(en.uploads.linkFromSpecimens);
    expect(page).toContain(en.listings.csv.edit);
    expect(await (await f.app.request("/exports")).text()).toContain(`href="/uploads"`);
  });
});

describe("uploading a file", () => {
  it("shows the form, which takes an Excel file, with the example in the hint and not as a placeholder", async () => {
    const f = await uploadFixture();
    const body = await (await f.app.request("/uploads")).text();
    expect(body).toContain(`enctype="multipart/form-data"`);
    expect(body).toContain(`type="file"`);
    expect(body).toContain(`accept=".xlsx,${XLSX}"`);
    expect(body).toContain(en.uploads.form.fileLabel);
    expect(body).toContain(en.uploads.none);
    expect(body).not.toContain("placeholder=");
    expect(body).toContain("an email&#39;s message id");
  });

  it("stores nothing for a file it cannot read, and says why", async () => {
    const f = await uploadFixture();
    const refused = async (file: Uint8Array | string, says: string) => {
      const res = await upload(f, file);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(esc(says));
    };
    await refused(buildWorkbook([["fieldNumber", "locality"], ["OBA10001", "Corvallis"]]), en.uploads.refused.no_specimen_id_column!);
    await refused(buildWorkbook([["specimenId", "locality", "locality"], ["1", "a", "b"]]), en.uploads.refusedRepeatedColumn("locality"));
    await refused(buildWorkbook([["specimenId", "locality"]]), en.uploads.refused.no_rows!);
    await refused(buildWorkbook([["specimen Id", "locality"], ["1", "a"]]), en.uploads.refusedNearMiss("specimenId"));
    await refused(zipSync({ "hello.txt": strToU8("hi") }), en.uploads.refused.unreadable!);
    // An encrypted or labelled workbook is an old Office file, not a zip.
    await refused(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]), en.uploads.refused.protected_file!);
    // Several tabs, none of them specimens: they are named, and the person is told what to do.
    const tabs = edited(await f.download(), [], { sheets: { name: "Sheet1", others: ["Notes"] } });
    await refused(tabs, en.uploads.refusedNoSuchSheet("Sheet1, Notes"));
    expect(en.uploads.refusedNoSuchSheet("Sheet1, Notes")).toMatch(/Keep the edited rows on a tab named specimens/);
    expect(await uploadCount(f)).toBe(0);
    expect(await kept(f)).toEqual([]);
    const none = await f.app.request("/uploads", { method: "POST", headers: { origin: ORIGIN }, body: new FormData() });
    expect(none.status).toBe(400);
    expect(await none.text()).toContain(en.uploads.refused.noFile);
  });

  it("refuses a CSV, and tells the person to download the Excel file from Specimens and edit that", async () => {
    const f = await uploadFixture();
    const res = await upload(f, "specimenId,locality\n1,Corvallis\n", "edited.csv");
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain(esc(en.uploads.refused.not_a_zip!));
    expect(en.uploads.refused.not_a_zip).toMatch(/Download the Excel file from Specimens, edit that/);
    // Under any name: a CSV called .xlsx is still not a workbook.
    expect((await upload(f, "specimenId,locality\n1,Corvallis\n", "edited.xlsx")).status).toBe(400);
    expect(await uploadCount(f)).toBe(0);
    expect(await kept(f)).toEqual([]);
  });

  it("keeps an accepted file on disk and in upload, byte for byte, and sends the person to its page", async () => {
    const f = await uploadFixture();
    const bytes = edited(await f.download(), [{ id: f.ids.a1, set: { disposition: "missing", occurrenceRemarks: "Lost" } }]);
    const res = await upload(f, bytes, "C:\\Users\\x\\my edited file.xlsx", { reference: " https://github.com/example/example/issues/7 " });
    expect(res.status).toBe(303);
    const [id, by, name, sha, size, count, reference] = (
      await rows(f.conn, `SELECT entity_id, uploaded_by, file_name, sha256, byte_size, row_count, reference FROM upload`)
    )[0]!;
    expect(res.headers.get("location")).toBe(`/uploads/${id}`);
    expect(by).toBe(f.staffer);
    expect(name).toBe("C:\\Users\\x\\my edited file.xlsx");
    expect(count).toBe(4);
    expect(size).toBe(bytes.byteLength);
    expect(sha).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(reference).toBe("https://github.com/example/example/issues/7");
    // On disk under the upload's id, with a safe name, byte for byte.
    expect(await kept(f)).toEqual([String(id)]);
    expect(await readdir(join(f.paths.uploadsDir, String(id)))).toEqual(["upload.xlsx"]);
    expect(Buffer.compare(await readFile(join(f.paths.uploadsDir, String(id), "upload.xlsx")), Buffer.from(bytes))).toBe(0);
    // And in the person's list, as a link.
    expect(await (await f.app.request("/uploads")).text()).toContain(`<a href="/uploads/${id}">C:\\Users\\x\\my edited file.xlsx</a>`);
  });
});

describe("the upload table", () => {
  it("refuses an empty file, a file with no rows and a hash that is not 64 characters, since a deployed store cannot gain a CHECK later", async () => {
    const f = await uploadFixture();
    const insert = (sha: string, size: number, count: number) =>
      f.conn.run(
        `INSERT INTO upload (uploaded_by, uploaded_at, file_name, sha256, byte_size, row_count) VALUES (${f.staffer}, now(), 'x.xlsx', '${sha}', ${size}, ${count})`,
      );
    const good = "a".repeat(64);
    await expect(insert(good, 0, 1)).rejects.toThrow();
    await expect(insert(good, 1, 0)).rejects.toThrow();
    await expect(insert("abc", 1, 1)).rejects.toThrow();
    await insert(good, 1, 1);
  });
});

describe("the preview", () => {
  const onSample = (f: UploadFixture, set: Record<string, string>) => [f.ids.a1, f.ids.a2, f.ids.a3].map((id) => ({ id, set }));
  const pageOf = async (f: UploadFixture, bytes: Uint8Array) => (await f.app.request((await upload(f, bytes)).headers.get("location")!)).text();

  it("shows a difference and a held row, says nothing was changed, and changes no record", async () => {
    const f = await uploadFixture();
    const { a1, b1 } = f.ids;
    const before = await records(f);
    const bytes = edited(await f.download(), [
      { id: a1, set: { disposition: "missing", occurrenceRemarks: "Lost", county: "Linn" } },
      ...onSample(f, { locality: "Albany" }),
      { id: b1, set: { specimenId: "987654" } },
    ]);
    const res = await upload(f, bytes);
    const page = await f.app.request(res.headers.get("location")!);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain(esc(en.uploads.page.notChanged));
    // The page says what is not checked yet, in one sentence, and says "differs", never "offered".
    expect(en.uploads.page.notChanged).toContain("it will check each change against its own rules");
    expect(en.uploads.page.notChanged).toContain("None of those checks is made on this page.");
    expect(body).not.toMatch(/offered/i);
    // A specimen's own difference, with its field number linked to its page.
    expect(body).toContain(en.uploads.page.kind.disposition);
    expect(body).toContain(`<a href="/specimens/${a1}">OBA10001</a>`);
    expect(body).toContain("<q>missing</q>");
    // A sample's difference, once, with the sample linked.
    expect(body).toContain(en.uploads.page.kind.place);
    expect(body).toContain(`<a href="/samples/${f.ids.sampleA}">UP-1</a>`);
    expect(body).toContain("<q>Corvallis</q>");
    expect(body.match(/<q>Albany<\/q>/g)).toHaveLength(1);
    expect(body).toContain(en.uploads.page.sampleSpecimens(3, 3));
    // What a blank locality will mean.
    expect(body).toContain(esc(en.uploads.page.unitNote.place!));
    // A blank is the component for a value that is not there, not an empty quote.
    expect(body).toContain(`<span class="meta absent">${en.uploads.page.nothing}</span>`);
    // The held row, under its reason in plain words, and what to do about it.
    expect(body).toContain(esc(en.uploads.page.held.no_specimen!));
    expect(body).toContain(esc(en.uploads.page.heldTodo.no_specimen!));
    expect(body).toContain("987654");
    // The columns Beeline does not read from a file come last, collapsed.
    expect(body).toMatch(/<details>\s*<summary>[^<]*Differences in columns Beeline does not read from this file/);
    expect(body.indexOf("<details>")).toBeGreaterThan(body.indexOf(en.uploads.page.heldHeading));
    expect(body).toContain("<q>Linn</q>");
    expect(body).toContain(en.uploads.page.colSettled);

    expect(await records(f)).toBe(before);
    expect(await uploadCount(f)).toBe(1);
  });

  it("shows the columns that were not read near the top, and the one that was probably meant", async () => {
    const f = await uploadFixture();
    const bytes = edited(await f.download(), [{ id: f.ids.a1, set: { county: "Linn" } }], {
      renameColumns: { sex: " sex " },
      addColumns: { "My notes": "see me" },
    });
    const body = await pageOf(f, bytes);
    expect(body).toContain(en.uploads.page.unrecognisedHeading);
    expect(body).toContain(en.uploads.page.unrecognisedNote);
    expect(body).toContain("<code>My notes</code>");
    // A heading with only a space after it is the same heading, so it is read and not listed.
    expect(body).not.toContain("<code>sex</code>");
    const renamed = await pageOf(f, edited(await f.download(), [], { renameColumns: { sex: "SEX" } }));
    expect(renamed).toContain("<code>SEX</code>");
    expect(renamed).toContain(`${en.uploads.page.unrecognisedMeant} <code>sex</code>`);
    expect(renamed.indexOf(en.uploads.page.unrecognisedHeading)).toBeLessThan(renamed.indexOf(en.uploads.page.countsHeading));
    // A file with every column as downloaded has no such section.
    expect(await pageOf(f, edited(await f.download()))).not.toContain(en.uploads.page.unrecognisedHeading);
  });

  it("says which tabs were not read", async () => {
    const f = await uploadFixture();
    const body = await pageOf(f, edited(await f.download(), [{ id: f.ids.a1, set: { county: "Linn" } }], { sheets: { others: ["Notes", "specimens (2)"], before: true } }));
    expect(body).toContain(en.uploads.page.otherSheetsHeading);
    expect(body).toContain(en.uploads.page.otherSheetsNote);
    expect(body).toContain("<code>Notes</code>");
    expect(body).toContain("<code>specimens (2)</code>");
    expect(body.indexOf(en.uploads.page.otherSheetsHeading)).toBeLessThan(body.indexOf(en.uploads.page.countsHeading));
    expect(await pageOf(f, edited(await f.download()))).not.toContain(en.uploads.page.otherSheetsHeading);
  });

  it("does not link a row for a specimen Beeline does not have", async () => {
    const f = await uploadFixture();
    const body = await pageOf(f, edited(await f.download(), [{ id: f.ids.a1, set: { specimenId: "987654" } }]));
    expect(body).toContain(esc(en.uploads.page.held.no_specimen!));
    expect(body).toContain("987654");
    expect(body).not.toContain("/specimens/987654");
  });

  it("says how many of a sample's specimens are in the file, in the singular and the plural", () => {
    expect(en.uploads.page.sampleSpecimens(1, 3)).toBe("1 of its 3 specimens is in the file");
    expect(en.uploads.page.sampleSpecimens(2, 3)).toBe("2 of its 3 specimens are in the file");
    expect(en.uploads.page.sampleSpecimens(1, 1)).toBe("1 of its 1 specimen is in the file");
  });

  it("tells the reader what to do about a number, which has a minus sign where an Oregon longitude has one", () => {
    expect(en.uploads.page.heldTodo.number_unreadable).toMatch(/minus sign/);
    expect(en.uploads.page.heldTodo.number_unreadable).not.toMatch(/digits and a decimal point only/);
  });

  it("holds a sample for either reason its details may not match, and says both", async () => {
    const f = await uploadFixture();
    const download = await f.download();
    await f.conn.run(`UPDATE sample SET protocol = 'blue vane trap' WHERE entity_id = ${f.ids.sampleA}`);
    const body = await pageOf(f, edited(download, onSample(f, { locality: "Elsewhere" })));
    expect(body).toContain(esc(en.uploads.page.held.sample_changed_since!));
    expect(body).toContain(esc(en.uploads.page.heldTodo.sample_changed_since!));
    expect(en.uploads.page.heldTodo.sample_changed_since).toMatch(/changed in Beeline since the file was downloaded, or the file was downloaded by someone who is not shown locations/);
  });

  it("says what a blank locality does, for a sample with an observation and for one without", () => {
    expect(en.uploads.page.unitNote.place).toMatch(/has an iNaturalist observation follow that observation's locality again/);
    expect(en.uploads.page.unitNote.place).toMatch(/no observation, a blank changes nothing/);
  });

  it("shows a date with a time of day, held with the new name, with what to do", async () => {
    const f = await uploadFixture();
    const bytes = edited(await f.download(), [
      { id: f.ids.a1, set: { scientificName: "Bombus", dateIdentified: { date: serialOf("2025-07-01") + 0.5 } } },
    ]);
    const body = await pageOf(f, bytes);
    expect(body).toContain(esc(en.uploads.page.held.holds_time!));
    expect(body).toContain(esc(en.uploads.page.heldTodo.holds_time!));
    expect(body).toContain("<code>scientificName</code>: was <q>Bombus vosnesenskii</q>, file says <q>Bombus</q>");
    expect(body).toContain("<code>dateIdentified</code>: was <q>2024-05-03</q>, file says <q>2025-07-01 12:00:00</q>");
    expect(body).toContain(esc(en.uploads.page.unitNote.determination!));
    expect(en.uploads.page.heldTodo.holds_time).toMatch(/Format it as text/);
  });

  it("says in plain words what is held and what to do, for every reason a unit can be held for", () => {
    const words = /\b(parse|schema|normali[sz]e|unit|cell type|null)\b/i;
    for (const [reason, heading] of Object.entries(en.uploads.page.held)) {
      expect(en.uploads.page.heldTodo[reason], reason).toBeTruthy();
      expect(heading, reason).not.toMatch(words);
      expect(en.uploads.page.heldTodo[reason], reason).not.toMatch(words);
    }
  });

  it("shows another person's upload, with its plan, to an admin", async () => {
    const f = await uploadFixture();
    const bytes = edited(await f.download(), [{ id: f.ids.a2, set: { disposition: "missing", occurrenceRemarks: "Lost" } }]);
    await f.conn.run(
      `INSERT INTO upload (uploaded_by, uploaded_at, file_name, sha256, byte_size, row_count)
       VALUES (${f.volunteer}, now(), 'theirs.xlsx', '${createHash("sha256").update(bytes).digest("hex")}', ${bytes.byteLength}, 4)`,
    );
    const id = (await rows(f.conn, `SELECT entity_id FROM upload`))[0]![0];
    await mkdir(join(f.paths.uploadsDir, String(id)), { recursive: true });
    await writeFile(join(f.paths.uploadsDir, String(id), "upload.xlsx"), bytes);
    const res = await f.app.request(`/uploads/${id}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Vera Volunteer");
    expect(body).toContain(en.uploads.page.kind.disposition);
    expect(body).toContain("<q>missing</q>");
    // Not in the staff member's own list.
    expect(await (await f.app.request("/uploads")).text()).not.toContain("theirs.xlsx");
  });

  it("says when the kept file is gone, and refuses one whose bytes are not what arrived", async () => {
    const f = await uploadFixture();
    const bytes = edited(await f.download());
    const res = await upload(f, bytes);
    const location = res.headers.get("location")!;
    const id = location.split("/").pop()!;
    const keptFile = join(f.paths.uploadsDir, id, "upload.xlsx");
    expect((await f.app.request(location)).status).toBe(200);
    // Altered after it arrived, even by a byte.
    await writeFile(keptFile, Buffer.concat([Buffer.from(bytes), Buffer.from(" ")]));
    const altered = await f.app.request(location);
    expect(altered.status).toBe(500);
    expect(await altered.text()).toContain(en.uploads.page.fileAltered);
    // Gone.
    await rm(join(f.paths.uploadsDir, id), { recursive: true });
    const gone = await f.app.request(location);
    expect(gone.status).toBe(500);
    expect(await gone.text()).toContain(en.uploads.page.fileMissing);
    expect((await f.app.request("/uploads/999999")).status).toBe(404);
  });

  it("refuses a body over the limit however it is sent, and stores nothing", async () => {
    const f = await uploadFixture();
    const big = new Uint8Array(MAX_FILE_BYTES + 64 * 1024 + 4096);
    // A body with no declared length: a stream, which is what a lying or chunked client sends.
    const form = new FormData();
    form.set("file", new File([big], "big.xlsx", { type: XLSX }));
    const encoded = new Response(form);
    const contentType = encoded.headers.get("content-type")!;
    const asBytes = new Uint8Array(await encoded.arrayBuffer());
    const streamed = await f.app.request("/uploads", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": contentType },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(asBytes);
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(streamed.status).toBe(400);
    expect(await streamed.text()).toContain(esc(en.uploads.refused.too_large!));
    // And one that does declare its length.
    const declared = await upload(f, big);
    expect(declared.status).toBe(400);
    expect(await declared.text()).toContain(esc(en.uploads.refused.too_large!));
    expect(await uploadCount(f)).toBe(0);
    expect(await kept(f)).toEqual([]);
  });

  it("shows every cell held with a held unit, and what the file says for each", async () => {
    const f = await uploadFixture();
    const body = await pageOf(f, edited(await f.download(), [{ id: f.ids.a1, set: { scientificName: "Bombus", sex: "male", dateIdentified: "garbage" } }]));
    expect(body).toContain(esc(en.uploads.page.held.date_unreadable!));
    // Every cell of the unit, the one that caused the hold included, with what Beeline says and what the file says; columns as literals.
    expect(body).toContain("<code>scientificName</code>: was <q>Bombus vosnesenskii</q>, file says <q>Bombus</q>");
    expect(body).toContain("<code>sex</code>: was <q>female</q>, file says <q>male</q>");
    expect(body).toContain("<code>dateIdentified</code>: was <q>2024-05-03</q>, file says <q>garbage</q>");
    expect(body).toContain(esc(en.uploads.page.heldIntro));
    expect(body).toContain(esc(en.uploads.page.unitNote.determination!));
  });

  it("shows a unit held because it is not complete, with the reason and the cell", async () => {
    const f = await uploadFixture();
    const body = await pageOf(f, edited(await f.download(), [{ id: f.ids.a1, set: { sex: "queen" } }]));
    expect(body).toContain(esc(en.uploads.page.held.sex_unknown!));
    expect(body).toContain(esc(en.uploads.page.heldTodo.sex_unknown!));
    expect(body).toContain("<code>sex</code>: was <q>female</q>, file says <q>queen</q>");
  });

  it("shows a name held because the specimen changed since, with what the file gave, and no version code", async () => {
    const f = await uploadFixture();
    const download = await f.download();
    await f.conn.run(`UPDATE determination SET sex = 'male' WHERE specimen_id = ${f.ids.a1}`);
    const body = await pageOf(f, edited(download, [{ id: f.ids.a1, set: { scientificName: "Andrena" } }]));
    expect(body).toContain(esc(en.uploads.page.held.specimen_changed_since!));
    expect(body).toContain("<code>scientificName</code>: was <q>Bombus vosnesenskii</q>, file says <q>Andrena</q>");
    expect(body).toContain("<code>sex</code>: was <q>male</q>, file says <q>female</q>");
    // The version is bookkeeping and means nothing to the reader.
    const head = matrixOf(download)[0]!;
    const version = matrixOf(download)[1]![head.indexOf("specimenVersion")]!;
    expect(body).not.toContain(version);
    expect(body).not.toMatch(/\bs[0-9a-f]{12}\b/);
  });

  it("says what it finds when only columns it does not read differ, and when nothing differs at all", async () => {
    const f = await uploadFixture();
    const download = await f.download();
    const other = await pageOf(f, edited(download, [{ id: f.ids.a1, set: { county: "Linn" } }]));
    expect(other).toContain(en.uploads.page.nothingDiffers(false, true));
    expect(other).toContain("The only differences are in columns Beeline does not read.");
    expect(other).not.toContain("Nothing in the file differs");
    const none = await pageOf(f, edited(download));
    expect(none).toContain("Nothing in the file differs from what Beeline says.");
    const held = await pageOf(f, edited(download, [{ id: f.ids.a1, set: { specimenId: "987654" } }]));
    expect(held).toContain(en.uploads.page.nothingDiffers(true, false));
    expect(held).not.toContain("Nothing in the file differs");
  });

  it("labels the rows it could not match, and names a sample by its number, its collector and its day", async () => {
    const f = await uploadFixture();
    const body = await pageOf(f, edited(await f.download(), [{ id: f.ids.b1, set: { specimenId: "987654" } }, ...onSample(f, { locality: "Albany" })]));
    expect(body).toContain(en.uploads.page.rowsHeld);
    expect(en.uploads.page.rowsHeld).toBe("Not matched to a specimen");
    expect(body).not.toContain("Held, not compared");
    // The store reads a day as midnight in Oregon.
    const day = new Date(`${CURRENT_SEASON}-07-14T00:00:00-07:00`);
    expect(body).toContain(`<a href="/samples/${f.ids.sampleA}">UP-1</a> <span class="meta">V. Volunteer, ${en.format.dateRange(day, day)}</span>`);
  });

  it("heads the page with the file's name, and says it is an uploaded copy", async () => {
    const f = await uploadFixture();
    const res = await upload(f, edited(await f.download()), "edited specimens.xlsx");
    const body = await (await f.app.request(res.headers.get("location")!)).text();
    expect(body).toContain("<h1>edited specimens.xlsx</h1>");
    expect(body).toContain(en.uploads.page.uploadedCopy);
    expect(body).not.toContain("Edited download");
  });

  it("will not write into a folder an earlier upload already used, and writes no row", async () => {
    const f = await uploadFixture();
    // The id the next upload will draw, as a store restored to an earlier copy could draw it again.
    const next = Number((await rows(f.conn, `SELECT nextval('entity_id_seq')`))[0]![0]) + 1;
    const folder = join(f.paths.uploadsDir, String(next));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "upload.xlsx"), "earlier upload");
    const res = await upload(f, await f.download());
    expect(res.status).toBe(500);
    expect(await readFile(join(folder, "upload.xlsx"), "utf8")).toBe("earlier upload");
    expect(await readdir(folder)).toEqual(["upload.xlsx"]);
    expect(await uploadCount(f)).toBe(0);
  });

  it("caps a list at 200 lines and counts the rest", async () => {
    const f = await uploadFixture();
    const { a1 } = f.ids;
    // One specimen named by 250 rows is held, as one specimen repeated 250 times.
    const matrix = matrixOf(await f.download());
    const row = matrix.find((r) => r.includes("OBA10001"))!;
    const body = await pageOf(f, buildWorkbook([matrix[0]!, ...Array.from({ length: 250 }, () => row)]));
    expect(body).toContain(esc(en.uploads.page.held.repeated!));
    expect(body).toContain(en.uploads.page.more(50));
    expect(body.match(new RegExp(`<a href="/specimens/${a1}">`, "g"))).toHaveLength(200);
  });

  it("compares the Excel file as the app wrote it with no differences, and holds nothing", async () => {
    const f = await uploadFixture();
    const body = await pageOf(f, await f.download());
    expect(body).toContain("Nothing in the file differs from what Beeline says.");
    expect(body).toContain(en.uploads.page.noHeld);
  });
});

describe("reading an upload in a worker", () => {
  const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

  it("shows two previews of one upload at once", async () => {
    const f = await uploadFixture();
    const res = await upload(f, edited(await f.download(), [{ id: f.ids.a1, set: { disposition: "missing", occurrenceRemarks: "Lost" } }]));
    const location = res.headers.get("location")!;
    const pages = await Promise.all([f.app.request(location), f.app.request(location), f.app.request(location)]);
    expect(pages.map((p) => p.status)).toEqual([200, 200, 200]);
    for (const p of pages) expect(await p.text()).toContain("<q>missing</q>");
  });

  it("refuses a file that takes longer than the limit, says so in plain words, and stores nothing", async () => {
    const f = await uploadFixture("staffer", { readLimits: { timeMs: 1 } });
    const res = await upload(f, await f.download());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(esc(en.uploads.refused.took_too_long!));
    expect(await uploadCount(f)).toBe(0);
    expect(await kept(f)).toEqual([]);
  });

  it("refuses a workbook that needs more memory than the reader has, and the app goes on answering", async () => {
    const f = await uploadFixture("staffer", { readLimits: { memoryMb: 24 } });
    const rows = Array.from({ length: 50_000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${"x".repeat(400)}</t></is></c></row>`).join("");
    const bomb = zipSync({ ...unzipSync(buildWorkbook([["specimenId"]])), "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="${MAIN}"><sheetData>${rows}</sheetData></worksheet>`) });
    const res = await upload(f, bomb);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(esc(en.uploads.refused.too_large_unpacked!));
    expect(await uploadCount(f)).toBe(0);
    expect((await f.app.request("/uploads")).status).toBe(200);
    expect((await f.app.request("/specimens?scope=all")).status).toBe(200);
  }, 60_000);

  it("keeps the page small for a file of thousands of rows of one specimen, and for a sample of thousands of specimens", async () => {
    const f = await uploadFixture();
    const matrix = matrixOf(await f.download());
    const row = matrix.find((r) => r.includes("OBA10001"))!;
    const repeated = await pageOf(f, buildWorkbook([matrix[0]!, ...Array.from({ length: 5_000 }, () => row)]));
    expect(repeated).toContain(en.uploads.page.more(4_800));
    expect(repeated.length).toBeLessThan(200_000);
    // A sample with 1,500 more specimens, one row of it edited: one held item that names ten rows and counts the rest.
    await f.conn.run(`INSERT INTO specimen (sample_id, specimen_number) SELECT ${f.ids.sampleA}, 100 + i FROM range(0, 1500) t(i)`);
    const big = await pageOf(f, edited(await f.download(), [{ id: f.ids.a1, set: { locality: "Elsewhere" } }]));
    expect(big).toContain(en.uploads.page.heldRows("2, 3, 4, 5, 6, 7, 8, 9, 10, 11", 1_493));
    expect(big.length).toBeLessThan(60_000);
  }, 90_000);

  const pageOf = async (f: UploadFixture, bytes: Uint8Array) => (await f.app.request((await upload(f, bytes)).headers.get("location")!)).text();
});
