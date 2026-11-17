import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../src/app/messages/en.js";
import { MAX_FILE_BYTES } from "../src/app/upload-plan.js";
import { IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { rows } from "./helpers.js";
import { CURRENT_SEASON } from "./helpers.js";
import { bytesOf, edited, readRecords, uploadFixture, type UploadFixture } from "./upload-fixture.js";

const ORIGIN = "http://localhost:3054";
const esc = (text: string) => text.replaceAll("'", "&#39;");

const upload = (f: UploadFixture, text: string, fileName = "edited.csv", fields: Record<string, string> = {}, cookie?: string) => {
  const body = new FormData();
  body.set("file", new File([text], fileName, { type: "text/csv" }));
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
  it("answers a volunteer no, on every route", async () => {
    const f = await uploadFixture("volunteer");
    expect((await f.app.request("/uploads")).status).toBe(403);
    expect((await upload(f, await f.download())).status).toBe(403);
    expect((await f.app.request("/uploads/1")).status).toBe(403);
    expect(await uploadCount(f)).toBe(0);
    expect(await kept(f)).toEqual([]);
    // And is not offered the link.
    expect(await (await f.app.request("/specimens?scope=all")).text()).not.toContain(`href="/uploads"`);
  });

  it("refuses staff who are viewing Beeline as somebody else", async () => {
    const f = await uploadFixture();
    const cookie = `${IMPERSONATING_COOKIE}=${encodeURIComponent("Vera Volunteer")}`;
    const get = await f.app.request("/uploads", { headers: { cookie } });
    expect(get.status).toBe(403);
    const post = await upload(f, await f.download(), "edited.csv", {}, cookie);
    expect(post.status).toBe(403);
    expect(await post.text()).toBe(en.errors.readOnlyImpersonating);
    expect(await uploadCount(f)).toBe(0);
    expect(await kept(f)).toEqual([]);
  });

  it("links staff to it from the specimens listing and from the exports", async () => {
    const f = await uploadFixture();
    expect(await (await f.app.request("/specimens?scope=all")).text()).toContain(`href="/uploads"`);
    expect(await (await f.app.request("/exports")).text()).toContain(`href="/uploads"`);
  });
});

describe("uploading a file", () => {
  it("shows the form, with the example in the hint and not as a placeholder", async () => {
    const f = await uploadFixture();
    const body = await (await f.app.request("/uploads")).text();
    expect(body).toContain(`enctype="multipart/form-data"`);
    expect(body).toContain(`type="file"`);
    expect(body).toContain(en.uploads.none);
    expect(body).not.toContain("placeholder=");
    expect(body).toContain("an email&#39;s message id");
  });

  it("stores nothing for a file it cannot read, and says why", async () => {
    const f = await uploadFixture();
    const res = await upload(f, "fieldNumber,locality\nOBA10001,Corvallis\n");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(en.uploads.refused.no_specimen_id_column);
    // A file with a column twice is refused with its name.
    const unclosed = await upload(f, 'specimenId,occurrenceRemarks\n1,"never closed\n2,x\n');
    expect(unclosed.status).toBe(400);
    expect(await unclosed.text()).toContain("never closes");
    const twice = await upload(f, "specimenId,locality,locality\n1,a,b\n");
    expect(twice.status).toBe(400);
    expect(await twice.text()).toContain(en.uploads.refusedRepeatedColumn("locality"));
    expect(await uploadCount(f)).toBe(0);
    expect(await kept(f)).toEqual([]);
    const none = await f.app.request("/uploads", { method: "POST", headers: { origin: ORIGIN }, body: new FormData() });
    expect(none.status).toBe(400);
    expect(await none.text()).toContain(en.uploads.refused.noFile);
  });

  it("keeps an accepted file on disk and in upload, and sends the person to its page", async () => {
    const f = await uploadFixture();
    const text = edited(await f.download(), [{ id: f.ids.a1, set: { disposition: "Lost" } }]);
    const res = await upload(f, text, "C:\\Users\\x\\my edited file.csv", { reference: " https://github.com/example/example/issues/7 " });
    expect(res.status).toBe(303);
    const [id, by, name, sha, size, count, reference] = (
      await rows(f.conn, `SELECT entity_id, uploaded_by, file_name, sha256, byte_size, row_count, reference FROM upload`)
    )[0]!;
    expect(res.headers.get("location")).toBe(`/uploads/${id}`);
    expect(by).toBe(f.staffer);
    expect(name).toBe("C:\\Users\\x\\my edited file.csv");
    expect(count).toBe(4);
    expect(size).toBe(bytesOf(text).byteLength);
    expect(sha).toBe(createHash("sha256").update(bytesOf(text)).digest("hex"));
    expect(reference).toBe("https://github.com/example/example/issues/7");
    // On disk under the upload's id, with a safe name, byte for byte.
    expect(await kept(f)).toEqual([String(id)]);
    // Under a fixed name: the person's own never reaches the file system.
    expect(await readdir(join(f.paths.uploadsDir, String(id)))).toEqual(["upload.csv"]);
    expect(await readFile(join(f.paths.uploadsDir, String(id), "upload.csv"), "utf8")).toBe(text);
    // And in the person's list, as a link.
    expect(await (await f.app.request("/uploads")).text()).toContain(`<a href="/uploads/${id}">C:\\Users\\x\\my edited file.csv</a>`);
  });
});

describe("the upload table", () => {
  it("refuses an empty file, a file with no rows and a hash that is not 64 characters, since a deployed store cannot gain a CHECK later", async () => {
    const f = await uploadFixture();
    const insert = (sha: string, size: number, count: number) =>
      f.conn.run(
        `INSERT INTO upload (uploaded_by, uploaded_at, file_name, sha256, byte_size, row_count) VALUES (${f.staffer}, now(), 'x.csv', '${sha}', ${size}, ${count})`,
      );
    const good = "a".repeat(64);
    await expect(insert(good, 0, 1)).rejects.toThrow();
    await expect(insert(good, 1, 0)).rejects.toThrow();
    await expect(insert("abc", 1, 1)).rejects.toThrow();
    await insert(good, 1, 1);
  });
});

describe("the preview", () => {
  it("shows a change and a held row, says nothing was changed, and changes no record", async () => {
    const f = await uploadFixture();
    const { a1, a2, a3, b1 } = f.ids;
    const before = await records(f);
    const text = edited(await f.download(), [
      { id: a1, set: { disposition: "Lost", county: "Linn" } },
      ...[a1, a2, a3].map((id) => ({ id, set: { locality: "Albany" } })),
      { id: b1, set: { specimenId: "987654" } },
    ]);
    const res = await upload(f, text);
    const page = await f.app.request(res.headers.get("location")!);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain(en.uploads.page.notChanged);
    // A specimen's own change, with its field number linked to its page.
    expect(body).toContain(en.uploads.page.kind.disposition);
    expect(body).toContain(`<a href="/specimens/${a1}">OBA10001</a>`);
    expect(body).toContain("<q>Lost</q>");
    // A sample's change, once, with the sample linked.
    expect(body).toContain(en.uploads.page.kind.place);
    expect(body).toContain(`<a href="/samples/${f.ids.sampleA}">UP-1</a>`);
    expect(body).toContain("<q>Corvallis</q>");
    expect(body).toContain("<q>Albany</q>");
    expect(body.match(/<q>Albany<\/q>/g)).toHaveLength(1);
    expect(body).toContain(en.uploads.page.sampleSpecimens(3, 3));
    // A blank is the component for a value that is not there, not an empty quote.
    expect(body).toContain(`<span class="meta absent">${en.uploads.page.nothing}</span>`);
    // The held row, under its reason in plain words.
    expect(body).toContain(en.uploads.page.held.no_specimen);
    expect(body).toContain("987654");
    // The columns Beeline does not read from a file come last, collapsed.
    expect(body).toMatch(/<details>\s*<summary>[^<]*Differences in columns Beeline does not read from a file/);
    expect(body.indexOf("<details>")).toBeGreaterThan(body.indexOf(en.uploads.page.heldHeading));
    expect(body).toContain("<q>Linn</q>");
    // Counts, split by season: one row is settled and held, so the three of the current season are changed.
    expect(body).toContain(en.uploads.page.colSettled);

    expect(await records(f)).toBe(before);
    expect(await uploadCount(f)).toBe(1);
  });

  it("shows another person's upload, with its plan, to an admin", async () => {
    const f = await uploadFixture();
    const text = edited(await f.download(), [{ id: f.ids.a1, set: { disposition: "missing" } }]);
    const bytes = bytesOf(text);
    await f.conn.run(
      `INSERT INTO upload (uploaded_by, uploaded_at, file_name, sha256, byte_size, row_count)
       VALUES (${f.volunteer}, now(), 'theirs.csv', '${createHash("sha256").update(bytes).digest("hex")}', ${bytes.byteLength}, 4)`,
    );
    const id = (await rows(f.conn, `SELECT entity_id FROM upload`))[0]![0];
    await mkdir(join(f.paths.uploadsDir, String(id)), { recursive: true });
    await writeFile(join(f.paths.uploadsDir, String(id), "upload.csv"), bytes);
    const res = await f.app.request(`/uploads/${id}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Vera Volunteer");
    expect(body).toContain(en.uploads.page.kind.disposition);
    expect(body).toContain("<q>missing</q>");
    // Not in the staff member's own list.
    expect(await (await f.app.request("/uploads")).text()).not.toContain("theirs.csv");
  });

  it("says when the kept file is gone, and refuses one whose bytes are not what arrived", async () => {
    const f = await uploadFixture();
    const text = edited(await f.download());
    const res = await upload(f, text);
    const location = res.headers.get("location")!;
    const id = location.split("/").pop()!;
    const kept = join(f.paths.uploadsDir, id, "upload.csv");
    expect((await f.app.request(location)).status).toBe(200);
    // Altered after it arrived, even by a letter.
    await writeFile(kept, text.replace("Corvallis", "Corvalliz"));
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
    const big = `specimenId\n${"1\n".repeat(MAX_FILE_BYTES / 2 + 40_000)}`;
    expect(big.length).toBeGreaterThan(MAX_FILE_BYTES + 64 * 1024);
    // A body with no declared length: a stream, which is what a lying or chunked client sends.
    const form = new FormData();
    form.set("file", new File([big], "big.csv", { type: "text/csv" }));
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
    expect(await streamed.text()).toContain(en.uploads.refused.too_large);
    // And one that does declare its length.
    const declared = await upload(f, big);
    expect(declared.status).toBe(400);
    expect(await declared.text()).toContain(en.uploads.refused.too_large);
    expect(await uploadCount(f)).toBe(0);
    expect(await kept(f)).toEqual([]);
  });

  it("shows every cell held with a held unit, and what the file says for each", async () => {
    const f = await uploadFixture();
    const text = edited(await f.download(), [{ id: f.ids.a1, set: { scientificName: "Bombus", sex: "male", dateIdentified: "garbage" } }]);
    const res = await upload(f, text);
    const body = await (await f.app.request(res.headers.get("location")!)).text();
    expect(body).toContain(en.uploads.page.held.date_unreadable);
    // Every cell of the unit, the one that caused the hold included, with what Beeline says and what the file says; columns as literals.
    expect(body).toContain("<code>scientificName</code>: was <q>Bombus vosnesenskii</q>, file says <q>Bombus</q>");
    expect(body).toContain("<code>sex</code>: was <q>female</q>, file says <q>male</q>");
    expect(body).toContain("<code>dateIdentified</code>: was <q>2024-05-03</q>, file says <q>garbage</q>");
    expect(body).toContain(en.uploads.page.heldIntro);
    expect(body).toContain(esc(en.uploads.page.unitNote.determination!));
  });

  it("shows a name held because the specimen changed since, with what the file gave, and no version code", async () => {
    const f = await uploadFixture();
    const download = await f.download();
    await f.conn.run(`UPDATE determination SET sex = 'male' WHERE specimen_id = ${f.ids.a1}`);
    const res = await upload(f, edited(download, [{ id: f.ids.a1, set: { scientificName: "Andrena" } }]));
    const body = await (await f.app.request(res.headers.get("location")!)).text();
    expect(body).toContain(esc(en.uploads.page.held.specimen_changed_since!));
    expect(body).toContain("<code>scientificName</code>: was <q>Bombus vosnesenskii</q>, file says <q>Andrena</q>");
    expect(body).toContain("<code>sex</code>: was <q>male</q>, file says <q>female</q>");
    // The version is bookkeeping and means nothing to the reader.
    const version = readRecords(download)[1]![readRecords(download)[0]!.indexOf("specimenVersion")]!;
    expect(body).not.toContain(version);
    expect(body).not.toMatch(/\bs[0-9a-f]{12}\b/);
  });

  it("says what it would do when only columns it does not read differ, and when nothing differs at all", async () => {
    const f = await uploadFixture();
    const download = await f.download();
    const page = async (text: string) => (await f.app.request((await upload(f, text)).headers.get("location")!)).text();
    const other = await page(edited(download, [{ id: f.ids.a1, set: { county: "Linn" } }]));
    expect(other).toContain(en.uploads.page.nothingOffered(false, true));
    expect(other).toContain("Beeline would change nothing from this file. The differences in other columns are listed below.");
    expect(other).not.toContain("Nothing in the file differs");
    const none = await page(edited(download));
    expect(none).toContain("Nothing in the file differs from what Beeline says.");
    const held = await page(edited(download, [{ id: f.ids.a1, set: { specimenId: "987654" } }]));
    expect(held).toContain(en.uploads.page.nothingOffered(true, false));
    expect(held).not.toContain("Nothing in the file differs");
  });

  it("labels the rows it could not match, and names a sample by its number, its collector and its day", async () => {
    const f = await uploadFixture();
    const { a1, a2, a3 } = f.ids;
    const res = await upload(
      f,
      edited(await f.download(), [
        { id: f.ids.b1, set: { specimenId: "987654" } },
        ...[a1, a2, a3].map((id) => ({ id, set: { locality: "Albany" } })),
      ]),
    );
    const body = await (await f.app.request(res.headers.get("location")!)).text();
    expect(body).toContain(en.uploads.page.rowsHeld);
    expect(en.uploads.page.rowsHeld).toBe("Not matched to a specimen");
    expect(body).not.toContain("Held, not compared");
    // The store reads a day as midnight in Oregon.
    const day = new Date(`${CURRENT_SEASON}-07-14T00:00:00-07:00`);
    expect(body).toContain(`<a href="/samples/${f.ids.sampleA}">UP-1</a> <span class="meta">V. Volunteer, ${en.format.dateRange(day, day)}</span>`);
  });

  it("heads the page with the file's name, and says it is an uploaded copy", async () => {
    const f = await uploadFixture();
    const res = await upload(f, edited(await f.download()), "edited specimens.csv");
    const body = await (await f.app.request(res.headers.get("location")!)).text();
    expect(body).toContain("<h1>edited specimens.csv</h1>");
    expect(body).toContain(en.uploads.page.uploadedCopy);
    expect(body).not.toContain("Edited download");
  });

  it("will not write into a folder an earlier upload already used, and writes no row", async () => {
    const f = await uploadFixture();
    // The id the next upload will draw, as a store restored to an earlier copy could draw it again.
    const next = Number((await rows(f.conn, `SELECT nextval('entity_id_seq')`))[0]![0]) + 1;
    const folder = join(f.paths.uploadsDir, String(next));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "upload.csv"), "earlier upload");
    const res = await upload(f, await f.download());
    expect(res.status).toBe(500);
    expect(await readFile(join(folder, "upload.csv"), "utf8")).toBe("earlier upload");
    expect(await readdir(folder)).toEqual(["upload.csv"]);
    expect(await uploadCount(f)).toBe(0);
  });

  it("caps a list at 200 lines and counts the rest", async () => {
    const f = await uploadFixture();
    const { a1 } = f.ids;
    // One specimen named by 250 rows is held, as one specimen repeated 250 times.
    const download = await f.download();
    const lines = download.split("\n");
    const header = lines[0]!;
    const row = lines.find((l) => l.includes("OBA10001"))!;
    const res = await upload(f, `${header}\n${`${row}\n`.repeat(250)}`);
    const body = await (await f.app.request(res.headers.get("location")!)).text();
    expect(body).toContain(en.uploads.page.held.repeated);
    expect(body).toContain(en.uploads.page.more(50));
    expect(body.match(new RegExp(`<a href="/specimens/${a1}">`, "g"))).toHaveLength(200);
  });
});
