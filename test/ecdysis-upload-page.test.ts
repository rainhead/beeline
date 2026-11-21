import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { readFile } from "node:fs/promises";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { fetchEcdysis } from "../src/fetch-ecdysis.js";
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
const FIXTURES = new URL("./fixtures/ecdysis/archive/", import.meta.url).pathname;

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
  /** The next nightly read, run for real against a stand-in for Ecdysis serving the repository's archive fixture with BC's prefix. */
  const readAgain = async () => {
    const zip = zipSync({
      "occurrences.csv": new TextEncoder().encode((await readFile(`${FIXTURES}occurrences.csv`, "utf8")).replaceAll("WSDA_", "BCBA_")),
      "identifications.csv": new Uint8Array(await readFile(`${FIXTURES}identifications.csv`)),
    });
    const stand: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v2/occurrence") return Response.json({ count: 6, results: [] });
      if (url.pathname === "/profile/index.php") return new Response(null, { status: 302, headers: [["location", "/"], ["set-cookie", "PHPSESSID=abc; path=/"]] });
      return new Response(Buffer.from(zip), { headers: { "content-type": "application/zip" } });
    };
    await fetchEcdysis(f.conn, BC, { dir: f.dir, credentials: { username: "u", password: "p" }, fetch: stand, now: new Date() });
  };
  return { f, staff, app: await makeApp(staff), volunteerApp: await makeApp(volunteer), readAgain };
}

/** The archive's data rows: the ids of the specimens it holds. A body that is not read is cancelled, so none is left open. */
const specimensIn = async (res: Response) => {
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  return strFromU8(files["occurrence.txt"]!).trim().split("\n").slice(1).map((l) => l.split("\t")[0]!);
};
/** Asks for an archive the way the page's form does: a POST, with the choices as fields. A query string is for the tests that must be refused. */
const ask = (app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }, opts: { year?: number; query?: string; fields?: Record<string, string> } = {}) =>
  app.request(`/exports/ecdysis/BC-${opts.year ?? CURRENT_SEASON}-upload.zip${opts.query === undefined ? "" : `?${opts.query}`}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(opts.fields ?? {}).toString(),
  });
const drain = async (res: Response) => void (await res.arrayBuffer());
const textOf = async (res: Response) => res.text();

describe("the Ecdysis section of the Exports page", () => {
  it("offers a year with its counts, what was left out, the choice about obscured specimens and the archive; and lists years not offered", async () => {
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
    const page = await textOf(res);
    expect(page).toContain(e.heading);
    for (const step of Object.values(e.steps)) expect(page).toContain(html(step));
    expect(page).toContain(e.readNowButton);
    expect(page).toContain('action="/jobs/run/ecdysis-read-now"');
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
    // The associations file is for a finished download, and there is none yet.
    expect(page).not.toContain("associations.csv");
    expect(page).toContain(e.notOfferedHeading);
    expect(page).toContain(html(e.notOfferedYear(CURRENT_SEASON - 6, 1, `${CURRENT_SEASON}, ${SETTLED_SEASON}`)));
    // The count there is the listing's: its link carries the labels filter the plan uses.
    expect(page).toContain(`/specimens?scope=BC&amp;year=${CURRENT_SEASON - 6}&amp;labels=printed&amp;ecdysis=not`);
  });

  it("holds Washington, which Beeline reads as a dataset, out of the offer with a sentence", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001", program: "WaBA" });
    await f.cacheArchive(WABA, []);
    const page = await textOf(await app.request("/exports"));
    expect(page).toContain(e.collection("Washington Bee Atlas", "dataset 44"));
    expect(page).toContain(html(e.refused.dataset("dataset 44")));
    expect(page).not.toContain("/exports/ecdysis/WaBA-");
    const refused = await app.request(`/exports/ecdysis/WaBA-${CURRENT_SEASON}-upload.zip`, { method: "POST" });
    expect(refused.status).toBe(409);
    await drain(refused);
  });

  it("says what to do when the read is old, missing, or its archive is gone, changed or unreadable", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    await f.cacheArchive(BC, [], { readHoursAgo: 5 });
    expect(await textOf(await app.request("/exports"))).toContain("more than 2 hours ago");
    const { rm, writeFile } = await import("node:fs/promises");
    await rm(`${f.dir}/collection-196.read.json`);
    expect(await textOf(await app.request("/exports"))).toContain(html(e.refused.never));
    await f.cacheArchive(BC, []);
    await rm(cachedArchivePath(f.dir, BC));
    const gone = await textOf(await app.request("/exports"));
    expect(gone).toContain("no longer has the archive it downloaded");
    expect(gone).not.toContain("/exports/ecdysis/BC-");
    await writeFile(cachedArchivePath(f.dir, BC), "not a zip");
    await f.writeMarker(BC, 1);
    expect(await textOf(await app.request("/exports"))).toContain("could not read it");
  });

  it("says there is nothing to upload when Ecdysis holds everything", async () => {
    const { app } = await setup();
    expect(await textOf(await app.request("/exports"))).toContain(e.nothing.slice(0, 40));
  });

  it("keeps the warning that the program archives are not for upload, and says the Ecdysis files are another thing", async () => {
    const { app } = await setup();
    const page = await textOf(await app.request("/exports"));
    expect(page).toContain("Do not upload them");
    expect(page).toContain("further down this page");
  });

  it("is for admins only", async () => {
    const { volunteerApp } = await setup();
    const res = await volunteerApp.request("/exports");
    expect(res.status).toBe(403);
    await drain(res);
  });
});

describe("downloading the archive", () => {
  it("serves the archive for a collection and year, named for them, the count and the day, and not to be cached", async () => {
    const { f, app } = await setup();
    const wanted = await f.specimen({ field: "2500001" });
    await f.specimen({ field: "2500004", year: SETTLED_SEASON });
    const res = await ask(app);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(new RegExp(`filename="ecdysis-upload-BC-${CURRENT_SEASON}-1-specimens-\\d{4}-\\d{2}-\\d{2}-\\d{6}\\.zip"`));
    expect(await specimensIn(res)).toEqual([String(wanted.id)]);
  });

  it("answers GET and HEAD with 405: asking for an archive records a start and uses up the read", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    for (const method of ["GET", "HEAD"]) {
      const res = await app.request(ARCHIVE, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      await drain(res);
    }
    expect((await rows(f.conn, `SELECT count(*) FROM ecdysis_upload_download`))[0]).toEqual([0n]);
  });

  it("holds as many specimens as the page counts for the year", async () => {
    const { f, app } = await setup();
    for (let i = 0; i < 3; i++) await f.specimen({ field: `25001${i}` });
    await f.specimen({ field: "2500020", sample: { taxon_geoprivacy: "'obscured'" } });
    await f.specimen({ field: "2500021", sample: { geoprivacy: "'private'" } });
    const page = await textOf(await app.request("/exports"));
    expect(page).toContain(e.yearHeading(CURRENT_SEASON, 3));
    expect(await specimensIn(await ask(app))).toHaveLength(3);
  });

  it("includes the obscured specimens only when the choice is made in the form, and records the choice with the download", async () => {
    const { f, app } = await setup();
    for (let i = 0; i < 3; i++) await f.specimen({ field: `25001${i}` });
    await f.specimen({ field: "2500020", sample: { taxon_geoprivacy: "'obscured'" } });
    await f.specimen({ field: "2500021", sample: { geoprivacy: "'private'" } });
    const res = await ask(app, { fields: { includeTaxonObscured: "1", includeObserverObscured: "1" } });
    expect(res.headers.get("content-disposition")).toContain("-5-specimens-");
    expect(await specimensIn(res)).toHaveLength(5);
    expect((await rows(f.conn, `SELECT include_taxon_obscured, include_observer_obscured, planned_specimens FROM ecdysis_upload_download`))[0]).toEqual([true, true, 5]);
  });

  it("records the start, then the completion with the specimens actually written, before the archive is sent, and refuses a second archive", async () => {
    const { f, staff, app } = await setup();
    const a = await f.specimen({ field: "2500001" });
    await f.specimen({ field: "2500002", year: SETTLED_SEASON });
    const first = await ask(app);
    expect(first.status).toBe(200);
    // Complete already: the person may have the file from the moment it is sent.
    expect((await rows(f.conn, `SELECT person_id, planned_specimens FROM ecdysis_upload_download`))[0]).toEqual([staff, 1]);
    expect((await rows(f.conn, `SELECT specimens FROM ecdysis_upload_download_completed`))[0]).toEqual([1]);
    expect((await rows(f.conn, `SELECT specimen_id, catalog_number FROM ecdysis_upload_download_specimen`))[0]).toEqual([a.id, "BCBA_2500001"]);
    await drain(first);
    // Another year: still one archive for each read.
    const second = await ask(app, { year: SETTLED_SEASON });
    expect(second.status).toBe(409);
    expect(await textOf(second)).toContain("Sam Staff prepared the archive");
    const page = await textOf(await app.request("/exports"));
    expect(page).toContain("Sam Staff prepared the archive");
    expect(page).not.toContain(e.downloadArchive);
    expect(page).toMatch(/\/exports\/ecdysis\/downloads\/\d+\/associations\.csv/);
    expect(page).toContain(e.downloadsHeading);
    expect(page).toContain(html(e.downloadsNote));
  });

  it("offers an archive again after the next read, which is run for real, and what was left out earlier can go", async () => {
    const { f, app, readAgain } = await setup();
    await f.specimen({ field: "2500001" });
    const later = await f.specimen({ field: "2500002", sample: { geoprivacy: "'private'" } });
    await drain(await ask(app));
    const blocked = await ask(app);
    expect(blocked.status).toBe(409);
    await drain(blocked);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await readAgain();
    // The observer's flag was lifted meanwhile: the specimen left out before is eligible now.
    await f.conn.run(`UPDATE sample SET geoprivacy = NULL WHERE entity_id = ${later.sample}`);
    const again = await ask(app);
    expect(again.status).toBe(200);
    expect(await specimensIn(again)).toContain(String(later.id));
  });

  it("leaves a completed download on the page when the client goes away after the archive was sent", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    const res = await ask(app);
    expect(res.status).toBe(200);
    await res.body!.cancel();
    expect((await rows(f.conn, `SELECT count(*) FROM ecdysis_upload_download_completed`))[0]).toEqual([1n]);
    expect(await textOf(await app.request("/exports"))).toContain("Sam Staff prepared the archive");
  });

  it("lets only one of two simultaneous requests for an archive through", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    const both = await Promise.all([ask(app), ask(app)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    for (const r of both) await drain(r);
    expect((await rows(f.conn, `SELECT count(*) FROM ecdysis_upload_download`))[0]).toEqual([1n]);
  });

  it("answers 400 to any query parameter, a field it does not take or a choice given twice, and writes nothing", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    for (const query of ["kind=net", "collector=Casey", "place=Umtanum", "scope=WaBA", "year=2025", "includeTaxonObscured=1"]) {
      const res = await ask(app, { query });
      expect(res.status, query).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-disposition")).toBeNull();
      await drain(res);
    }
    for (const fields of [{ includeTaxonObscured: "yes" }, { other: "1" }] as Record<string, string>[]) {
      const res = await ask(app, { fields });
      expect(res.status, JSON.stringify(fields)).toBe(400);
      await drain(res);
    }
    const twice = await app.request(ARCHIVE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "includeTaxonObscured=1&includeTaxonObscured=1" });
    expect(twice.status).toBe(400);
    await drain(twice);
    expect((await rows(f.conn, `SELECT count(*) FROM ecdysis_upload_download`))[0]).toEqual([0n]);
    expect(await textOf(await ask(app, { query: "kind=net" }))).toContain("kind");
  });

  it("refuses a year that is not offered, and the archive when the read is old", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001", year: CURRENT_SEASON - 6 });
    await f.specimen({ field: "2500002" });
    const old = await ask(app, { year: CURRENT_SEASON - 6 });
    expect(old.status).toBe(409);
    expect(await textOf(old)).toBe(e.yearNotOffered);
    await f.cacheArchive(BC, ["BCBA_9999999"], { readHoursAgo: 3 });
    const res = await ask(app);
    expect(res.status).toBe(409);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await textOf(res)).toContain("more than 2 hours ago");
  });

  it("refuses when no read has succeeded", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    const { rm } = await import("node:fs/promises");
    await rm(`${f.dir}/collection-196.read.json`);
    const res = await ask(app);
    expect(res.status).toBe(409);
    expect(await textOf(res)).toBe(e.refused.never);
  });

  it("is 404 for an unknown collection, a year with nothing to write, and a name it does not make", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    for (const [path, status] of [[`/exports/ecdysis/NM-${CURRENT_SEASON}-upload.zip`, 404], [`/exports/ecdysis/BC-${SETTLED_SEASON}-upload.zip`, 404], [`/exports/ecdysis/BC-${CURRENT_SEASON}-other.zip`, 404]] as const) {
      const res = await app.request(path, { method: "POST" });
      expect(res.status, path).toBe(status);
      await drain(res);
    }
  });

  it("is for admins only", async () => {
    const { volunteerApp } = await setup();
    for (const path of [ARCHIVE, "/exports/ecdysis/downloads/1/associations.csv"]) {
      for (const method of ["GET", "POST"]) {
        const res = await volunteerApp.request(path, { method });
        expect([403, 404], `${method} ${path}`).toContain(res.status);
        expect(res.status === 404 || res.status === 403).toBe(true);
        await drain(res);
      }
    }
    expect((await ask(volunteerApp)).status).toBe(403);
  });
});

describe("the read the archive rests on, and the copy about it", () => {
  it("refuses, with its own sentence, when the last read reloaded the kept archive; the button forces a download", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    await f.cacheArchive(BC, ["BCBA_9999999"], { readHoursAgo: 1, source: "cached" });
    const page = await textOf(await app.request("/exports"));
    expect(page).toContain(html(e.refused.reloaded));
    expect(page).toContain('action="/jobs/run/ecdysis-read-now"');
    const res = await ask(app);
    expect(res.status).toBe(409);
    expect(await textOf(res)).toBe(e.refused.reloaded);
  });

  it("says a box must be ticked for a year in which everything eligible is obscured, and answers a request with none with that sentence", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001", sample: { taxon_geoprivacy: "'obscured'" } });
    const page = await textOf(await app.request("/exports"));
    expect(page).toContain(e.yearHeading(CURRENT_SEASON, 0));
    expect(page).toContain(html(e.choiceNeeded));
    const res = await ask(app);
    expect(res.status).toBe(400);
    expect(await textOf(res)).toBe(e.choiceNeeded);
    expect((await rows(f.conn, `SELECT count(*) FROM ecdysis_upload_download`))[0]).toEqual([0n]);
    const chosen = await ask(app, { fields: { includeTaxonObscured: "1" } });
    expect(chosen.status).toBe(200);
    await drain(chosen);
  });

  it("describes an archive being prepared without saying it did not finish, and one that was not prepared as such", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    const { startDownload, INCLUDE_NONE } = await import("../src/app/ecdysis-upload.js");
    const readAt = new Date(Date.now() - 3_600_000);
    const r = await startDownload(f.db, { collection: BC, year: CURRENT_SEASON, include: INCLUDE_NONE, planned: 1, readAt, personId: null });
    expect(r.ok).toBe(true);
    const preparing = await textOf(await app.request("/exports"));
    expect(preparing).toContain("Beeline is preparing it now");
    expect(preparing).not.toContain("was not prepared");
    await f.conn.run(`UPDATE ecdysis_upload_download SET started_at = now() - INTERVAL '20 minutes'`);
    const unfinished = await textOf(await app.request("/exports"));
    expect(unfinished).toContain("and it was not prepared");
    expect(unfinished).not.toContain("did not finish");
    // The record is described as prepared, and tells a person who did not receive the file what to do.
    expect(e.downloaded("Sam", "today", 2026, 1, true)).toContain("If you did not receive the file, read Ecdysis again and ask for it again.");
    expect(e.downloadsNote).toContain("if you did not receive the file, read Ecdysis again and ask for it again");
    expect(e.tooLarge).toContain("until Ecdysis has been read again");
  });
});

describe("finished downloads on the page, whatever the state of the read", () => {
  it("stay listed, with their associations link, when the read is old, missing, or the archive is gone; and say whether Ecdysis holds their specimens", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    await drain(await ask(app));
    const { rm } = await import("node:fs/promises");
    await f.cacheArchive(BC, ["BCBA_9999999"], { readHoursAgo: 5 });
    const stale = await textOf(await app.request("/exports"));
    expect(stale).toContain("more than 2 hours ago");
    expect(stale).toContain("Sam Staff prepared the archive");
    expect(stale).toMatch(/\/exports\/ecdysis\/downloads\/\d+\/associations\.csv/);
    expect(stale).not.toContain(e.downloadArchive);
    // With no recent read, absence from Ecdysis cannot be established: "not known", not "not in Ecdysis yet".
    expect(stale).toContain("not known to be in Ecdysis");
    expect(stale).not.toContain("not in Ecdysis yet");
    await rm(`${f.dir}/collection-196.read.json`);
    const never = await textOf(await app.request("/exports"));
    expect(never).toContain(html(e.refused.never));
    expect(never).toMatch(/\/exports\/ecdysis\/downloads\/\d+\/associations\.csv/);
    // Ecdysis now holds the specimen: still listed, and says so.
    const [[specimen]] = (await rows(f.conn, `SELECT specimen_id FROM ecdysis_upload_download_specimen`)) as [[number]];
    await f.conn.run(`INSERT INTO specimen_catalog_number (specimen_id, catalog_number, loaded_at) VALUES (${specimen}, 'BCBA_2500001', now() - INTERVAL '30 days')`);
    expect(await textOf(await app.request("/exports"))).toContain("all in Ecdysis since the last read");
  });

  it("list the ten most recent, newest first, with an older one that is still outstanding after them", async () => {
    const { f, app } = await setup();
    const spec = await f.specimen({ field: "2500001" });
    const absent = await f.specimen({ field: "2500002" });
    const { startDownload, completeDownload, INCLUDE_NONE } = await import("../src/app/ecdysis-upload.js");
    for (let i = 0; i < 12; i++) {
      const r = await startDownload(f.db, { collection: BC, year: CURRENT_SEASON, include: INCLUDE_NONE, planned: 1, readAt: i === 0 ? new Date(Date.now() - 300 * 3_600_000) : new Date(), personId: null });
      if (!r.ok) throw new Error("not started");
      await completeDownload(f.db, r.id, [i === 0 ? { id: absent.id, catalogNumber: "BCBA_2500002" } : { id: spec.id, catalogNumber: "BCBA_2500001" }]);
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    await f.conn.run(`INSERT INTO specimen_catalog_number (specimen_id, catalog_number, loaded_at) VALUES (${spec.id}, 'BCBA_2500001', now() - INTERVAL '30 days')`);
    const page = await textOf(await app.request("/exports"));
    expect([...page.matchAll(/downloads\/(\d+)\/associations\.csv/g)]).toHaveLength(11);
    expect(page).toContain("1 of them not in Ecdysis yet");
  });
});

describe("the associations file of a finished download", () => {
  it("holds exactly the specimens that archive held, under the catalog numbers they were written under, and stays after later reads", async () => {
    const { f, app, readAgain } = await setup();
    await f.specimen({ field: "2500001", sample: { inat_observation_id: "111", host_name_as_observed: "'Salvia officinalis'", host_rank: "'species'" } });
    await f.specimen({ field: "2500002", sample: { kind: "'trap'", protocol: "'blue vane trap'", inat_observation_id: "112", host_name_as_observed: "'Ceanothus'", host_rank: "'genus'" } });
    await f.specimen({ field: "2500003" }); // no observation
    await f.specimen({ field: "2500004", sample: { inat_observation_id: "113", geoprivacy: "'private'" } }); // left out of the archive
    await drain(await ask(app));
    const [[id]] = (await rows(f.conn, `SELECT entity_id FROM ecdysis_upload_download`)) as [[number]];
    const path = `/exports/ecdysis/downloads/${id}/associations.csv`;
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/filename="ecdysis-associations-BC-\d{4}-3-specimens-/);
    // The trap has no row, the private one was not in the archive, and the one with no observation has none.
    expect(await res.text()).toBe("subject identifier: catalogNumber,resourceUrl,verbatimSciname\nBCBA_2500001,https://www.inaturalist.org/observations/111,Salvia officinalis\n");
    // The year's choice is not the file's to change, and a filter is refused.
    const filtered = await app.request(`${path}?kind=trap`);
    expect(filtered.status).toBe(400);
    await drain(filtered);
    // Later reads do not take it away.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await readAgain();
    const later = await app.request(path);
    expect(later.status).toBe(200);
    await drain(later);
    const none = await app.request("/exports/ecdysis/downloads/999999/associations.csv");
    expect(none.status).toBe(404);
    await drain(none);
  });

  it("names the subject by the catalog number written, though the label number was corrected after the archive was prepared", async () => {
    const { f, app } = await setup();
    const spec = await f.specimen({ field: "2500001", sample: { inat_observation_id: "111", host_name_as_observed: "'Salvia'", host_rank: "'genus'" } });
    await drain(await ask(app));
    await f.conn.run(`UPDATE specimen SET field_number = '2599999' WHERE entity_id = ${spec.id}`);
    const [[id]] = (await rows(f.conn, `SELECT entity_id FROM ecdysis_upload_download`)) as [[number]];
    const res = await app.request(`/exports/ecdysis/downloads/${id}/associations.csv`);
    expect(await res.text()).toContain("BCBA_2500001,https://www.inaturalist.org/observations/111,Salvia");
  });

  it("is on the page beside the finished download, not beside the checkboxes", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001", sample: { geoprivacy: "'private'" } });
    await f.specimen({ field: "2500002" });
    const before = await textOf(await app.request("/exports"));
    expect(before).not.toContain("associations.csv");
    await drain(await ask(app));
    const after = await textOf(await app.request("/exports"));
    expect(after).toContain(`>${e.downloadAssociations}</a>`);
    expect(after).toMatch(/<li>[^<]*Sam Staff prepared the archive[^]*associations\.csv/);
  });
});
