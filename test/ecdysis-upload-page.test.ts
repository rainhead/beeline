import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { CURRENT_SEASON, SETTLED_SEASON, rows, scratchPaths } from "./helpers.js";
import { BC, fixture, WABA } from "./ecdysis-upload-fixture.js";
import { cachedArchivePath } from "../src/fetch-ecdysis.js";

/** The Ecdysis section of the Exports page, and the routes that serve its files (beeline-8dx9.12). */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};
const e = en.exports.ecdysis;
/** Text as the page's markup spells it. */
const html = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const ARCHIVE = `/exports/ecdysis/BC-${CURRENT_SEASON}-upload.zip`;
const ASSOCIATIONS = `/exports/ecdysis/BC-${CURRENT_SEASON}-associations.csv`;

async function setup() {
  const f = await fixture();
  const [[staff]] = (await rows(f.conn, `INSERT INTO person (display_name) VALUES ('Sam Staff') RETURNING entity_id`)) as [[number]];
  await f.conn.run(`INSERT INTO person_admin (person_id) VALUES (${staff})`);
  const [[volunteer]] = (await rows(f.conn, `INSERT INTO person (display_name) VALUES ('Val Volunteer') RETURNING entity_id`)) as [[number]];
  // British Columbia was read an hour ago and Ecdysis holds one record Beeline could not match.
  await f.cacheArchive(BC, ["BCBA_9999999"], { readHoursAgo: 1 });
  const makeApp = async (personId: number) =>
    createApp({
      ...(await scratchPaths()),
      ecdysisDir: f.dir,
      db: f.db,
      config: { environment: "sandbox" as const, origin: "http://localhost:3054", exportsDir: f.dir },
      inat: unusedInat,
      resolveSession: async () => ({ personId, login: "someone", iconUrl: null }),
    });
  return { f, staff, app: await makeApp(staff), volunteerApp: await makeApp(volunteer) };
}

/** The archive's data rows: the ids of the specimens it holds. */
const specimensIn = async (res: Response) => {
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  return strFromU8(files["occurrence.txt"]!).trim().split("\n").slice(1).map((l) => l.split("\t")[0]!);
};

describe("the Ecdysis section of the Exports page", () => {
  it("offers a year with its counts, what was left out, the choice about obscured specimens and both files; and lists years not offered", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    await f.specimen({ field: "2500002" });
    await f.specimen({ field: "2500003", sample: { taxon_geoprivacy: "'obscured'" } });
    await f.specimen({ field: "2500004", sample: { geoprivacy: "'private'" } });
    await f.specimen({ field: "2500005", sample: { geoprivacy: "'obscured'" } });
    await f.specimen({ field: "Zed Zebra 12" });
    await f.specimen({ field: "2500007" });
    await f.specimen({ field: "2500007" });
    await f.specimen({ field: "2500008", year: CURRENT_SEASON - 6 });
    const res = await app.request("/exports");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain(e.heading);
    for (const step of Object.values(e.steps)) expect(page).toContain(html(step));
    expect(page).toContain(e.readNowButton);
    expect(page).toContain('action="/jobs/run/ecdysis-fetch"');
    expect(page).toContain(e.collection("British Columbia Bee Atlas", "collection 196"));
    expect(page).toContain(e.uploadInto(196, "BCBA_"));
    expect(page).toContain(e.yearHeading(CURRENT_SEASON, 2));
    expect(page).toContain(html(e.leftOutTaxon(1)));
    expect(page).toContain(html(e.leftOutObserver(2)));
    expect(page).toContain(html(e.leftOutNotDigits(1)));
    expect(page).toContain(html(e.leftOutUnusable(2)));
    // The label number that is not digits is counted and never shown.
    expect(page).not.toContain("Zed Zebra");
    expect(page).toContain(e.includeTaxon);
    expect(page).toContain(e.includeObserver);
    expect(page).toContain(e.choiceWarning);
    expect(page).toContain(`action="${ARCHIVE}"`);
    expect(page).toContain(`formaction="${ASSOCIATIONS}"`);
    expect(page).toContain(e.notOfferedHeading);
    expect(page).toContain(html(e.notOfferedOlder(CURRENT_SEASON - 6, 1)));
    expect(page).toContain(`/specimens?scope=BC&amp;year=${CURRENT_SEASON - 6}&amp;ecdysis=not`);
  });

  it("holds Washington, which Beeline reads as a dataset, out of the offer with a sentence", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001", program: "WaBA" });
    await f.cacheArchive(WABA, []);
    const page = await (await app.request("/exports")).text();
    expect(page).toContain(e.collection("Washington Bee Atlas", "dataset 44"));
    expect(page).toContain(html(e.refused.dataset("dataset 44")));
    expect(page).not.toContain("/exports/ecdysis/WaBA-");
    expect((await app.request(`/exports/ecdysis/WaBA-${CURRENT_SEASON}-upload.zip`)).status).toBe(409);
  });

  it("says what to do when the read is old, missing, or its archive is gone or changed", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    await f.cacheArchive(BC, [], { readHoursAgo: 5 });
    expect(await (await app.request("/exports")).text()).toContain("more than 2 hours ago");
    await f.conn.run(`SELECT 1`);
    const { rm, writeFile } = await import("node:fs/promises");
    await rm(`${f.dir}/collection-196.read.json`);
    expect(await (await app.request("/exports")).text()).toContain(html(e.refused.never));
    await f.cacheArchive(BC, []);
    await rm(cachedArchivePath(f.dir, BC));
    const gone = await (await app.request("/exports")).text();
    expect(gone).toContain("no longer has the archive it downloaded");
    expect(gone).not.toContain("/exports/ecdysis/BC-");
    await writeFile(cachedArchivePath(f.dir, BC), "not a zip");
    await f.writeMarker(BC, 1);
    expect(await (await app.request("/exports")).text()).toContain("could not read it");
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
  it("serves the archive for a collection and year, named for them, the count and the day, and not to be cached", async () => {
    const { f, app } = await setup();
    const wanted = await f.specimen({ field: "2500001" });
    await f.specimen({ field: "2500004", year: SETTLED_SEASON });
    const res = await app.request(ARCHIVE);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(new RegExp(`filename="ecdysis-upload-BC-${CURRENT_SEASON}-1-specimens-\\d{4}-\\d{2}-\\d{2}-\\d{6}\\.zip"`));
    expect(await specimensIn(res)).toEqual([String(wanted.id)]);
  });

  it("holds as many specimens as the page counts for the year, and the choice changes both the file and its name", async () => {
    const { f, app } = await setup();
    for (let i = 0; i < 3; i++) await f.specimen({ field: `25001${i}` });
    await f.specimen({ field: "2500020", sample: { taxon_geoprivacy: "'obscured'" } });
    await f.specimen({ field: "2500021", sample: { geoprivacy: "'private'" } });
    const page = await (await app.request("/exports")).text();
    expect(page).toContain(e.yearHeading(CURRENT_SEASON, 3));
    const first = await app.request(`${ASSOCIATIONS}?includeTaxonObscured=1`);
    expect(first.headers.get("content-disposition")).toContain("-4-specimens-");
    const both = await app.request(`${ASSOCIATIONS}?includeTaxonObscured=1&includeObserverObscured=1`);
    expect(both.headers.get("content-disposition")).toContain("-5-specimens-");
    const plain = await app.request(ARCHIVE);
    expect(await specimensIn(plain)).toHaveLength(3);
  });

  it("records the download with who took it, the choice and the read it rested on, and refuses a second archive", async () => {
    const { f, staff, app } = await setup();
    await f.specimen({ field: "2500001" });
    await f.specimen({ field: "2500002", year: SETTLED_SEASON });
    await f.specimen({ field: "2500003", sample: { taxon_geoprivacy: "'obscured'" } });
    const first = await app.request(`${ARCHIVE}?includeTaxonObscured=1&kind=net`);
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    const [[recorded]] = (await rows(f.conn, `SELECT collection, year, filters, include_taxon_obscured, include_observer_obscured, specimens, person_id FROM ecdysis_upload_download`)) as [[unknown]];
    expect(recorded).toBeDefined();
    const record = (await rows(f.conn, `SELECT collection, year, filters, include_taxon_obscured, include_observer_obscured, specimens, person_id, read_at FROM ecdysis_upload_download`))[0]!;
    expect(record.slice(0, 7)).toEqual(["BC", CURRENT_SEASON, "kind=net", true, false, 2, staff]);
    // Another year, other filters: still one archive for each read.
    const second = await app.request(`/exports/ecdysis/BC-${SETTLED_SEASON}-upload.zip`);
    expect(second.status).toBe(409);
    const refusal = await second.text();
    expect(refusal).toContain("Sam Staff downloaded the archive");
    expect(refusal).toContain("read Ecdysis again");
    // The page says who took it, and offers the associations file but not the archive.
    const page = await (await app.request("/exports")).text();
    expect(page).toContain("Sam Staff downloaded the archive");
    expect(page).not.toContain(e.downloadArchive);
    expect(page).toContain(e.downloadAssociations);
    expect((await app.request(ASSOCIATIONS)).status).toBe(200);
    // After the next read, an archive is offered again.
    await f.cacheArchive(BC, ["BCBA_9999999"], { readHoursAgo: 0 });
    await f.conn.run(`UPDATE ecdysis_upload_download SET downloaded_at = now() - INTERVAL '1 hour'`);
    expect((await app.request(ARCHIVE)).status).toBe(200);
  });

  it("serves the associations file with the same specimens", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001", sample: { inat_observation_id: "111", host_name_as_observed: "'Salvia officinalis'", host_rank: "'species'" } });
    await f.specimen({ field: "2500002" });
    const res = await app.request(ASSOCIATIONS);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/filename="ecdysis-associations-BC-\d{4}-2-specimens-/);
    expect(await res.text()).toBe(
      "subject identifier: catalogNumber,resourceUrl,verbatimSciname\nBCBA_2500001,https://www.inaturalist.org/observations/111,Salvia officinalis\n",
    );
  });

  it("answers 400 to a filter it cannot read or a parameter it does not know, and writes nothing", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    for (const query of ["kind=traps", "colector=Casey", "from=2026-13-99", "includeTaxonObscured=yes", "scope=WaBA", "year=2025"]) {
      const res = await app.request(`${ARCHIVE}?${query}`);
      expect(res.status, query).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-disposition")).toBeNull();
    }
    expect((await rows(f.conn, `SELECT count(*) FROM ecdysis_upload_download`))[0]![0]).toBe(0n);
    expect(await (await app.request(`${ARCHIVE}?kind=traps`)).text()).toContain("kind");
  });

  it("answers every quality filter value", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    for (const qc of ["any", "flagged", "blocking", "warning", "clean", "locality"]) {
      const res = await app.request(`${ASSOCIATIONS}?qc=${qc}`);
      expect([200, 404], qc).toContain(res.status);
    }
  });

  it("refuses a year that is not offered, and both files when the read is old", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001", year: CURRENT_SEASON - 6 });
    await f.specimen({ field: "2500002" });
    const old = await app.request(`/exports/ecdysis/BC-${CURRENT_SEASON - 6}-upload.zip`);
    expect(old.status).toBe(409);
    expect(await old.text()).toBe(e.yearNotOffered);
    await f.cacheArchive(BC, ["BCBA_9999999"], { readHoursAgo: 3 });
    for (const file of [ARCHIVE, ASSOCIATIONS]) {
      const res = await app.request(file);
      expect(res.status).toBe(409);
      expect(res.headers.get("content-disposition")).toBeNull();
      expect(await res.text()).toContain("more than 2 hours ago");
    }
  });

  it("refuses when no read has succeeded", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    const { rm } = await import("node:fs/promises");
    await rm(`${f.dir}/collection-196.read.json`);
    const res = await app.request(ARCHIVE);
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(e.refused.never);
  });

  it("is 404 for an unknown collection, a year with nothing to write, and a name it does not make", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    expect((await app.request(`/exports/ecdysis/NM-${CURRENT_SEASON}-upload.zip`)).status).toBe(404);
    const none = await app.request(`/exports/ecdysis/BC-${SETTLED_SEASON}-upload.zip`);
    expect(none.status).toBe(404);
    expect(await none.text()).toBe(e.noSpecimensForFile);
    expect((await app.request(`/exports/ecdysis/BC-${CURRENT_SEASON}-other.zip`)).status).toBe(404);
  });

  it("is for admins only", async () => {
    const { volunteerApp } = await setup();
    expect((await volunteerApp.request(ARCHIVE)).status).toBe(403);
    expect((await volunteerApp.request(ASSOCIATIONS)).status).toBe(403);
  });
});
