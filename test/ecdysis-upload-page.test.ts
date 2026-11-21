import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { CURRENT_SEASON, SETTLED_SEASON, rows, scratchPaths } from "./helpers.js";
import { BC, fixture, readDetail, WABA } from "./ecdysis-upload-fixture.js";
import { UPLOAD_FRESH_HOURS } from "../src/app/ecdysis-upload.js";

/** The Exports page's section for the Ecdysis upload, and the routes that serve its files (beeline-8dx9.12). */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};
const e = en.exports.ecdysis;
/** Text as the page's markup spells it. */
const html = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

async function setup() {
  const f = await fixture();
  const [[staff]] = (await rows(f.conn, `INSERT INTO person (display_name) VALUES ('Sam Staff') RETURNING entity_id`)) as [[number]];
  await f.conn.run(`INSERT INTO person_admin (person_id) VALUES (${staff})`);
  const [[volunteer]] = (await rows(f.conn, `INSERT INTO person (display_name) VALUES ('Val Volunteer') RETURNING entity_id`)) as [[number]];
  // Washington: a read two hours ago and its archive on disk; British Columbia: a read two days ago.
  await f.cacheArchive(WABA, ["WSDA_25000003"]);
  await f.cacheArchive(BC, []);
  await f.readHoursAgo(2, readDetail(WABA, "downloaded"));
  await f.readHoursAgo(UPLOAD_FRESH_HOURS + 12, readDetail(BC));
  const makeApp = async (personId: number) =>
    createApp({
      ...(await scratchPaths()),
      ecdysisDir: f.dir,
      db: f.db,
      config: { environment: "sandbox" as const, origin: "http://localhost:3054", exportsDir: f.dir },
      inat: unusedInat,
      resolveSession: async () => ({ personId, login: "someone", iconUrl: null }),
    });
  return { f, app: await makeApp(staff), volunteerApp: await makeApp(volunteer) };
}

describe("the Ecdysis section of the Exports page", () => {
  it("offers each year's counts and both files where the read is recent, and refuses where it is old", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "25000001" });
    await f.specimen({ field: "25000002", sample: { taxon_geoprivacy: "'obscured'" } });
    await f.specimen({ field: "25000003" }); // in Ecdysis, though Beeline matched it to nothing
    await f.specimen({ field: "25000004", year: SETTLED_SEASON });
    await f.specimen({ field: "2404406", program: "BC" });
    const res = await app.request("/exports");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain(e.heading);
    for (const step of e.steps) expect(page).toContain(html(step));
    // Washington: read two hours ago.
    expect(page).toContain(e.collection("Washington Bee Atlas", "dataset 44"));
    expect(page).toContain(`/exports/ecdysis/WaBA-${CURRENT_SEASON}-upload.zip`);
    expect(page).toContain(`/exports/ecdysis/WaBA-${CURRENT_SEASON}-associations.csv`);
    expect(page).toContain(`/exports/ecdysis/WaBA-${SETTLED_SEASON}-upload.zip`);
    const cells = (year: number) => {
      const row = page.split("<tr>").find((r) => r.startsWith(`<td>${year}</td>`) && r.includes("WaBA-"))!;
      return [...row.matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1]);
    };
    // Specimens in the file, left out for an obscured taxon, and left out for an unusable label number.
    expect(cells(CURRENT_SEASON)).toEqual([String(CURRENT_SEASON), "1", "1", "0"]);
    expect(cells(SETTLED_SEASON)).toEqual([String(SETTLED_SEASON), "1", "0", "0"]);
    expect(page).toContain(e.obscuredNote);
    // British Columbia: read two days ago, so no link and the reason.
    expect(page).toContain(e.collection("British Columbia Bee Atlas", "collection 196"));
    expect(page).not.toContain("/exports/ecdysis/BC-");
    expect(page).toContain("more than 36 hours ago");
    expect(page).toContain("so Beeline writes none");
  });

  it("says what to do when no read has succeeded, or the archive is gone", async () => {
    const { f, app } = await setup();
    await f.conn.run(`DELETE FROM job_run`);
    expect(await (await app.request("/exports")).text()).toContain(e.refused.never.slice(0, 60));
    await f.readHoursAgo(1, readDetail(WABA));
    await f.conn.run(`UPDATE job_run SET detail = detail`); // keep the run, remove the archive below
    const { rm } = await import("node:fs/promises");
    const { cachedArchivePath } = await import("../src/fetch-ecdysis.js");
    await rm(cachedArchivePath(f.dir, WABA));
    const page = await (await app.request("/exports")).text();
    expect(page).toContain("no longer has the archive it downloaded");
    expect(page).not.toContain("/exports/ecdysis/WaBA-");
  });

  it("says what was left out for a label number Ecdysis cannot take, and which place names went out as the store has them", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "25000001" });
    await f.specimen({ field: "25000002" });
    await f.specimen({ field: "25000002" });
    await f.specimen({ field: "25000005", sample: { state_province: "'ID'" } });
    const page = await (await app.request("/exports")).text();
    expect(page).toContain(e.unusableNote);
    expect(page).toContain(e.unspelled("ID"));
  });

  it("says when the archive Beeline downloaded cannot be read", async () => {
    const { f, app } = await setup();
    const { writeFile } = await import("node:fs/promises");
    const { cachedArchivePath } = await import("../src/fetch-ecdysis.js");
    await writeFile(cachedArchivePath(f.dir, WABA), "not a zip");
    const page = await (await app.request("/exports")).text();
    expect(page).toContain("could not read it");
    expect(page).not.toContain("/exports/ecdysis/WaBA-");
  });

  it("says there is nothing to upload when Ecdysis holds everything", async () => {
    const { app } = await setup();
    expect(await (await app.request("/exports")).text()).toContain(e.nothing.slice(0, 40));
  });

  it("keeps the warning that the program archives are not for upload, and says the Ecdysis files are another thing", async () => {
    const { app } = await setup();
    const page = await (await app.request("/exports")).text();
    expect(page).toContain("Do not upload them");
    expect(page).toContain("further down this page");
  });

  it("is for admins only", async () => {
    const { volunteerApp } = await setup();
    expect((await volunteerApp.request("/exports")).status).toBe(403);
  });
});

describe("the files' routes", () => {
  it("serves the archive for a collection and year, named for them and the day, and only that year's specimens", async () => {
    const { f, app } = await setup();
    const wanted = await f.specimen({ field: "25000001" });
    await f.specimen({ field: "25000004", year: SETTLED_SEASON });
    const res = await app.request(`/exports/ecdysis/WaBA-${CURRENT_SEASON}-upload.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(new RegExp(`filename="ecdysis-upload-WaBA-${CURRENT_SEASON}-\\d{4}-\\d{2}-\\d{2}-\\d{6}\\.zip"`));
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["identification.txt", "meta.xml", "occurrence.txt"]);
    const lines = strFromU8(files["occurrence.txt"]!).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]!.split("\t")[0]).toBe(String(wanted.id));
  });

  it("narrows by the Specimens listing's filters in the query string", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "25000041" });
    const trap = await f.specimen({ field: "25000040", sample: { kind: "'trap'", protocol: "'blue vane trap'" } });
    const res = await app.request(`/exports/ecdysis/WaBA-${CURRENT_SEASON}-upload.zip?kind=trap`);
    const lines = strFromU8(unzipSync(new Uint8Array(await res.arrayBuffer()))["occurrence.txt"]!).trim().split("\n");
    expect(lines.slice(1).map((l) => l.split("\t")[0])).toEqual([String(trap.id)]);
  });

  it("serves the associations file with the same specimens", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "25000001", sample: { inat_observation_id: "111", host_name_as_observed: "'Salvia officinalis'", host_rank: "'species'" } });
    await f.specimen({ field: "25000002" }); // no observation
    const res = await app.request(`/exports/ecdysis/WaBA-${CURRENT_SEASON}-associations.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/filename="ecdysis-associations-WaBA-\d{4}-\d{4}-\d{2}-\d{2}-\d{6}\.csv"/);
    expect(await res.text()).toBe(
      "subject identifier: catalogNumber,resourceUrl,verbatimSciname\nWSDA_25000001,https://www.inaturalist.org/observations/111,Salvia officinalis\n",
    );
  });

  it("refuses both files, with no file, when the read is stale", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2404406", program: "BC" });
    for (const file of [`BC-${CURRENT_SEASON}-upload.zip`, `BC-${CURRENT_SEASON}-associations.csv`]) {
      const res = await app.request(`/exports/ecdysis/${file}`);
      expect(res.status).toBe(409);
      expect(res.headers.get("content-disposition")).toBeNull();
      expect(await res.text()).toContain("more than 36 hours ago");
    }
  });

  it("refuses when no read has succeeded", async () => {
    const { f, app } = await setup();
    await f.conn.run(`DELETE FROM job_run`);
    await f.specimen({ field: "25000001" });
    const res = await app.request(`/exports/ecdysis/WaBA-${CURRENT_SEASON}-upload.zip`);
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(e.refused.never);
  });

  it("is 404 for an unknown collection, a year with nothing to write, and a name it does not make", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "25000001" });
    expect((await app.request(`/exports/ecdysis/NM-${CURRENT_SEASON}-upload.zip`)).status).toBe(404);
    const none = await app.request(`/exports/ecdysis/WaBA-${SETTLED_SEASON}-upload.zip`);
    expect(none.status).toBe(404);
    expect(await none.text()).toBe(e.noSpecimensForFile);
    expect((await app.request(`/exports/ecdysis/WaBA-${CURRENT_SEASON}-other.zip`)).status).toBe(404);
  });

  it("is for admins only", async () => {
    const { volunteerApp } = await setup();
    expect((await volunteerApp.request(`/exports/ecdysis/WaBA-${CURRENT_SEASON}-upload.zip`)).status).toBe(403);
    expect((await volunteerApp.request(`/exports/ecdysis/WaBA-${CURRENT_SEASON}-associations.csv`)).status).toBe(403);
  });
});
