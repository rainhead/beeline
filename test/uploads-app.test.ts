import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { en } from "../src/app/messages/en.js";
import { MAX_FILE_BYTES } from "../src/app/upload-plan.js";
import { IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { rows } from "./helpers.js";
import { CURRENT_SEASON } from "./helpers.js";
import { bytesOf, edited, matrixOf, uploadFixture, type UploadFixture } from "./upload-fixture.js";
import { buildWorkbook, serialOf } from "./workbook.js";

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
    expect((await f.app.request("/specimens.xlsx?scope=all")).status).toBe(200);
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
    await refused(zipSync({ "hello.txt": strToU8("hi") }), en.uploads.refused.not_a_workbook!);
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
    expect(en.uploads.page.notChanged).toContain("does not yet check that a name is in the taxonomy or that a determiner is someone it knows");
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
    expect(body).toMatch(/<details>\s*<summary>[^<]*Differences in columns Beeline does not read from a file/);
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

  it("shows a date the spreadsheet converted, held with the new name, with what to do", async () => {
    const f = await uploadFixture();
    const bytes = edited(await f.download(), [
      { id: f.ids.a1, set: { scientificName: "Bombus", dateIdentified: { date: serialOf("2025-07-01") } } },
    ]);
    const body = await pageOf(f, bytes);
    expect(body).toContain(esc(en.uploads.page.held.converted_to_date!));
    expect(body).toContain(esc(en.uploads.page.heldTodo.converted_to_date!));
    expect(body).toContain("<code>scientificName</code>: was <q>Bombus vosnesenskii</q>, file says <q>Bombus</q>");
    expect(body).toContain("<code>dateIdentified</code>: was <q>2024-05-03</q>, file says <q>2025-07-01</q>");
    expect(body).toContain(esc(en.uploads.page.unitNote.determination!));
    expect(en.uploads.page.heldTodo.converted_to_date).toMatch(/Format the cell as text/);
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
