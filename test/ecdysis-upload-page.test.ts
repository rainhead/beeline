import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { readFile } from "node:fs/promises";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { fetchEcdysis } from "../src/fetch-ecdysis.js";
import { CURRENT_SEASON, SETTLED_SEASON, rows, scratchPaths } from "./helpers.js";
import { BC, fixture, refusalSaid, WABA } from "./ecdysis-upload-fixture.js";
import { cachedArchivePath } from "../src/fetch-ecdysis.js";
import { downloadsOf } from "../src/app/ecdysis-upload.js";

/** The Ecdysis section of a program's Data tab, and the routes that serve its files (beeline-8dx9.12, moved from Exports by beeline-q8di). */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};
const e = en.programData.ecdysis;
/** Text as the page's markup spells it. */
const html = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const TAB = "/programs/BC/data";
const ARCHIVE = `${TAB}/ecdysis/${CURRENT_SEASON}-upload.zip`;
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
  return strFromU8(files["occurrence.tsv"]!).trim().split("\n").slice(1).map((l) => l.split("\t")[0]!);
};
/** Asks for an archive the way the page's form does: a POST, with the choices as fields. A query string is for the tests that must be refused. */
const ask = (app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }, opts: { year?: number; query?: string; fields?: Record<string, string> } = {}) =>
  app.request(`${TAB}/ecdysis/${opts.year ?? CURRENT_SEASON}-upload.zip${opts.query === undefined ? "" : `?${opts.query}`}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(opts.fields ?? {}).toString(),
  });
/** The newest recorded download of British Columbia, as the page's history line words it (through the catalog, with the same date formatting). */
const line = async (f: Awaited<ReturnType<typeof fixture>>, state: "prepared" | "preparing" | "unfinished", notKnown: number | null, established: boolean, which = 0) => {
  const d = (await downloadsOf(f.db, BC, 1000))[which]!;
  return html(e.downloadItem(d.by, en.format.dateTime(d.startedAt), d.year, d.specimens ?? d.planned, notKnown, established, state));
};
/** What the refusal after a recorded download says, through the catalog. */
const refusal = async (f: Awaited<ReturnType<typeof fixture>>, which = 0) => {
  const d = (await downloadsOf(f.db, BC, 1000))[which]!;
  return e.downloaded(d.by, en.format.dateTime(d.startedAt), d.year, d.specimens ?? d.planned, d.completedAt !== null);
};
const drain = async (res: Response) => void (await res.arrayBuffer());
const textOf = async (res: Response) => res.text();

describe("the Ecdysis section of the Data tab", () => {
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
    const res = await app.request(TAB);
    expect(res.status).toBe(200);
    const page = await textOf(res);
    expect(page).toContain(e.heading);
    for (const step of Object.values(e.steps)) expect(page).toContain(html(step));
    expect(page).toContain(e.readNowButton);
    expect(page).toContain(`action="${TAB}/check-ecdysis"`);
    expect(page).toContain(e.collection("collection 196"));
    expect(page).toContain(e.uploadInto("BCBA_"));
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
    const listing = `/specimens?scope=BC&amp;year=${CURRENT_SEASON - 6}&amp;labels=printed&amp;ecdysis=not`;
    expect(page).toContain(html(e.notOfferedYear.year(CURRENT_SEASON - 6)) + `<a href="${listing}">${e.notOfferedYear.count(1)}</a>` + html(e.notOfferedYear.rest(1, en.format.list([String(CURRENT_SEASON), String(SETTLED_SEASON)]))));
    expect(page).not.toContain("See them");
    // The count there is the listing's: its link carries the labels filter the plan uses.
    expect(page).toContain(`/specimens?scope=BC&amp;year=${CURRENT_SEASON - 6}&amp;labels=printed&amp;ecdysis=not`);
  });

  it("holds Washington, which Beeline reads as a dataset, out of the offer with a sentence", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001", program: "WaBA" });
    await f.cacheArchive(WABA, []);
    const page = await textOf(await app.request("/programs/WaBA/data"));
    expect(page).toContain(e.collection("dataset 44"));
    expect(page).toContain(html(e.refused.dataset("dataset 44")));
    expect(page).not.toContain("/programs/WaBA/data/ecdysis/20");
    const refused = await app.request(`/programs/WaBA/data/ecdysis/${CURRENT_SEASON}-upload.zip`, { method: "POST" });
    expect(refused.status).toBe(409);
    await drain(refused);
  });

  it("says what to do when the read is old, missing, or its archive is gone, changed or unreadable", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    await f.cacheArchive(BC, [], { readHoursAgo: 5 });
    const readAt = new Date(JSON.parse(await (await import("node:fs/promises")).readFile(`${f.dir}/collection-196.read.json`, "utf8")).readAt);
    expect(await textOf(await app.request(TAB))).toContain(html(e.refused.stale(en.format.dateTime(readAt))));
    const { rm, writeFile } = await import("node:fs/promises");
    await rm(`${f.dir}/collection-196.read.json`);
    expect(await textOf(await app.request(TAB))).toContain(html(e.refused.never));
    await f.cacheArchive(BC, []);
    await rm(cachedArchivePath(f.dir, BC));
    const gone = await textOf(await app.request(TAB));
    expect(gone).toContain(html(e.refused["no-archive"]));
    expect(gone).not.toContain(`${TAB}/ecdysis/20`);
    await writeFile(cachedArchivePath(f.dir, BC), "not a zip");
    await f.writeMarker(BC, 1);
    expect(await textOf(await app.request(TAB))).toContain(html(e.refused.unreadable));
  });

  it("says there is nothing to upload when Ecdysis holds everything", async () => {
    const { app } = await setup();
    expect(await textOf(await app.request(TAB))).toContain(e.nothing.slice(0, 40));
  });

  it("keeps the warning that the program archives are not for upload, and says the Ecdysis files are another thing", async () => {
    const { app } = await setup();
    const page = await textOf(await app.request(TAB));
    expect(page).toContain("Do not upload these to Ecdysis, GBIF or anywhere else");
    expect(page).toContain("To upload to Ecdysis, use the files above instead.");
  });

  it("says nothing about another program: a program with no Ecdysis collection has no such section", async () => {
    const { app } = await setup();
    const page = await textOf(await app.request("/programs/OBA/data"));
    expect(page).not.toContain(e.heading);
    expect(page).not.toContain("check-ecdysis");
    expect(page).not.toContain("To upload to Ecdysis, use the files above instead.");
  });

  it("is not found for a person who is neither a lead of the program nor an admin (the full matrix is in program-data-permission.test.ts)", async () => {
    const { volunteerApp } = await setup();
    const res = await volunteerApp.request(TAB);
    expect(res.status).toBe(404);
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
    const page = await textOf(await app.request(TAB));
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
    expect(await refusalSaid(second)).toBe(await refusal(f));
    const page = await textOf(await app.request(TAB));
    expect(page).toContain(await line(f, "prepared", 1, true));
    expect(page).not.toContain(e.downloadArchive);
    expect(page).toMatch(/\/programs\/BC\/data\/ecdysis\/downloads\/\d+\/associations\.csv/);
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
    expect(await textOf(await app.request(TAB))).toContain(await line(f, "prepared", 1, true));
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
    expect(await refusalSaid(await ask(app, { query: "kind=net" }))).toContain("kind");
  });

  it("refuses a year that is not offered, and the archive when the read is old", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001", year: CURRENT_SEASON - 6 });
    await f.specimen({ field: "2500002" });
    const old = await ask(app, { year: CURRENT_SEASON - 6 });
    expect(old.status).toBe(409);
    expect(await refusalSaid(old)).toBe(e.yearNotOffered);
    await f.cacheArchive(BC, ["BCBA_9999999"], { readHoursAgo: 3 });
    const res = await ask(app);
    expect(res.status).toBe(409);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await refusalSaid(res)).toContain("more than 2 hours ago");
  });

  it("refuses when no read has succeeded", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    const { rm } = await import("node:fs/promises");
    await rm(`${f.dir}/collection-196.read.json`);
    const res = await ask(app);
    expect(res.status).toBe(409);
    expect(await refusalSaid(res)).toBe(e.refused.never);
  });

  it("is 404 for an unknown collection, a year with nothing to write, and a name it does not make", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    for (const [path, status] of [[`/programs/NM/data/ecdysis/${CURRENT_SEASON}-upload.zip`, 404], [`${TAB}/ecdysis/${SETTLED_SEASON}-upload.zip`, 404], [`${TAB}/ecdysis/${CURRENT_SEASON}-other.zip`, 404]] as const) {
      const res = await app.request(path, { method: "POST" });
      expect(res.status, path).toBe(status);
      await drain(res);
    }
  });

  it("is not found for a person who may not open the tab, whatever the method", async () => {
    const { volunteerApp } = await setup();
    for (const path of [ARCHIVE, `${TAB}/ecdysis/downloads/1/associations.csv`]) {
      for (const method of ["GET", "POST"]) {
        const res = await volunteerApp.request(path, { method });
        expect(res.status, `${method} ${path}`).toBe(404);
        await drain(res);
      }
    }
    expect((await ask(volunteerApp)).status).toBe(404);
  });
});

describe("the read the archive rests on, and the copy about it", () => {
  it("refuses, with its own sentence, when the last read reloaded the kept archive; the button forces a download", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    await f.cacheArchive(BC, ["BCBA_9999999"], { readHoursAgo: 1, source: "cached" });
    const page = await textOf(await app.request(TAB));
    expect(page).toContain(html(e.refused.reloaded));
    expect(page).toContain(`action="${TAB}/check-ecdysis"`);
    const res = await ask(app);
    expect(res.status).toBe(409);
    expect(await refusalSaid(res)).toBe(e.refused.reloaded);
  });

  it("says a box must be ticked for a year in which everything eligible is obscured, and answers a request with none with that sentence", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001", sample: { taxon_geoprivacy: "'obscured'" } });
    const page = await textOf(await app.request(TAB));
    expect(page).toContain(e.yearHeading(CURRENT_SEASON, 0));
    expect(page).toContain(html(e.choiceNeeded));
    const res = await ask(app);
    expect(res.status).toBe(400);
    expect(await refusalSaid(res)).toBe(e.choiceNeeded);
    expect((await rows(f.conn, `SELECT count(*) FROM ecdysis_upload_download`))[0]).toEqual([0n]);
    const chosen = await ask(app, { fields: { includeTaxonObscured: "1" } });
    expect(chosen.status).toBe(200);
    await drain(chosen);
  });

  it("describes a file being made as being made, and one that was not made as not made, each in its own words", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    const { startDownload, INCLUDE_NONE } = await import("../src/app/ecdysis-upload.js");
    const readAt = new Date(Date.now() - 3_600_000);
    const r = await startDownload(f.db, { collection: BC, year: CURRENT_SEASON, include: INCLUDE_NONE, planned: 1, readAt, personId: null });
    expect(r.ok).toBe(true);
    const preparing = await textOf(await app.request(TAB));
    expect(preparing).toContain(await line(f, "preparing", null, true));
    expect(preparing).not.toContain(await line(f, "unfinished", null, true));
    await f.conn.run(`UPDATE ecdysis_upload_download SET started_at = now() - INTERVAL '20 minutes'`);
    const unfinished = await textOf(await app.request(TAB));
    expect(unfinished).toContain(await line(f, "unfinished", null, true));
    expect(unfinished).not.toContain(await line(f, "preparing", null, true));
    // What a person who did not get the file is told, in the words they read.
    expect(e.downloaded("Sam", "today", 2026, 1, true)).toContain("If you did not get the file, check Ecdysis again and download a new one.");
    expect(e.downloadsNote).toContain("If you did not get the file, check Ecdysis again and download a new one.");
    expect(e.tooLarge).toContain("50 MB");
  });
});

describe("finished downloads on the page, whatever the state of the read", () => {
  it("stay listed, with their associations link, when the read is old, missing, or the archive is gone; and say whether Ecdysis holds their specimens", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001" });
    await drain(await ask(app));
    const { rm } = await import("node:fs/promises");
    await f.cacheArchive(BC, ["BCBA_9999999"], { readHoursAgo: 5 });
    const stale = await textOf(await app.request(TAB));
    expect(stale).toContain(await line(f, "prepared", 1, false));
    expect(stale).toMatch(/\/programs\/BC\/data\/ecdysis\/downloads\/\d+\/associations\.csv/);
    expect(stale).not.toContain(e.downloadArchive);
    // With no recent read, absence from Ecdysis cannot be established, and the line says so in its own words.
    expect(await line(f, "prepared", 1, false)).not.toBe(await line(f, "prepared", 1, true));
    await rm(`${f.dir}/collection-196.read.json`);
    const never = await textOf(await app.request(TAB));
    expect(never).toContain(html(e.refused.never));
    expect(never).toMatch(/\/programs\/BC\/data\/ecdysis\/downloads\/\d+\/associations\.csv/);
    // Ecdysis now holds the specimen: still listed, and says so.
    const [[specimen]] = (await rows(f.conn, `SELECT specimen_id FROM ecdysis_upload_download_specimen`)) as [[number]];
    await f.conn.run(`INSERT INTO specimen_catalog_number (specimen_id, catalog_number, loaded_at) VALUES (${specimen}, 'BCBA_2500001', now() - INTERVAL '30 days')`);
    expect(await textOf(await app.request(TAB))).toContain(await line(f, "prepared", 0, false));
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
    const page = await textOf(await app.request(TAB));
    expect([...page.matchAll(/downloads\/(\d+)\/associations\.csv/g)]).toHaveLength(11);
    // The oldest of the twelve is the one still outstanding, listed after the ten most recent.
    expect(page).toContain(await line(f, "prepared", 1, true, 11));
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
    const path = `${TAB}/ecdysis/downloads/${id}/associations.csv`;
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
    const none = await app.request(`${TAB}/ecdysis/downloads/999999/associations.csv`);
    expect(none.status).toBe(404);
    await drain(none);
  });

  it("names the subject by the catalog number written, though the label number was corrected after the archive was prepared", async () => {
    const { f, app } = await setup();
    const spec = await f.specimen({ field: "2500001", sample: { inat_observation_id: "111", host_name_as_observed: "'Salvia'", host_rank: "'genus'" } });
    await drain(await ask(app));
    await f.conn.run(`UPDATE specimen SET field_number = '2599999' WHERE entity_id = ${spec.id}`);
    const [[id]] = (await rows(f.conn, `SELECT entity_id FROM ecdysis_upload_download`)) as [[number]];
    const res = await app.request(`${TAB}/ecdysis/downloads/${id}/associations.csv`);
    expect(await res.text()).toContain("BCBA_2500001,https://www.inaturalist.org/observations/111,Salvia");
  });

  it("is on the page beside the finished download, not beside the checkboxes", async () => {
    const { f, app } = await setup();
    await f.specimen({ field: "2500001", sample: { geoprivacy: "'private'" } });
    await f.specimen({ field: "2500002" });
    const before = await textOf(await app.request(TAB));
    expect(before).not.toContain("associations.csv");
    await drain(await ask(app));
    const after = await textOf(await app.request(TAB));
    expect(after).toContain(`>${e.downloadAssociations}</a>`);
    const items = [...after.matchAll(/<li>([^]*?)<\/li>/g)].map((m) => m[1]!);
    expect(items.some((li) => li.includes("Sam Staff") && li.includes("associations.csv"))).toBe(true);
  });
});
