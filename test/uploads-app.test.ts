import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../src/app/messages/en.js";
import { IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { rows } from "./helpers.js";
import { bytesOf, edited, uploadFixture, type UploadFixture } from "./upload-fixture.js";

const ORIGIN = "http://localhost:3054";

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
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(reference).toBe("https://github.com/example/example/issues/7");
    // On disk under the upload's id, with a safe name, byte for byte.
    expect(await kept(f)).toEqual([String(id)]);
    expect(await readdir(join(f.paths.uploadsDir, String(id)))).toEqual(["my_edited_file.csv"]);
    expect(await readFile(join(f.paths.uploadsDir, String(id), "my_edited_file.csv"), "utf8")).toBe(text);
    // And in the person's list, as a link.
    expect(await (await f.app.request("/uploads")).text()).toContain(`<a href="/uploads/${id}">C:\\Users\\x\\my edited file.csv</a>`);
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

  it("shows an upload that is somebody else's to an admin, and says when the kept file is gone", async () => {
    const f = await uploadFixture();
    await f.conn.run(
      `INSERT INTO upload (uploaded_by, uploaded_at, file_name, sha256, byte_size, row_count)
       VALUES (${f.volunteer}, now(), 'theirs.csv', 'abc', 10, 1)`,
    );
    const id = (await rows(f.conn, `SELECT entity_id FROM upload`))[0]![0];
    const res = await f.app.request(`/uploads/${id}`);
    // Not the signed-in person's own, and the file is not there.
    expect(res.status).toBe(500);
    expect(await res.text()).toContain(en.uploads.page.fileMissing);
    expect((await f.app.request("/uploads/999999")).status).toBe(404);
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
