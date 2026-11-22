import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { ACTING_COOKIE, IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { completeDownload, INCLUDE_NONE, startDownload } from "../src/app/ecdysis-upload.js";
import { en } from "../src/app/messages/en.js";
import { writeProgramArchives } from "../src/app/program-archives.js";
import { programDataAccess } from "../src/app/programs.js";
import { createApp } from "../src/app/server.js";
import { CURRENT_SEASON, rows, scratchPaths } from "./helpers.js";
import { BC, fixture } from "./ecdysis-upload-fixture.js";

/**
 * Who may open a program's Data tab, and every route under it (beeline-q8di).
 *
 * The files behind the tab hold collectors' names and the true coordinates of
 * hidden locations, so the rule is tested cell by cell: every route, for every
 * kind of person. A refusal must answer with the right status, record nothing,
 * start no job, and send no file. The rule itself is stated on
 * `programDataAccess` (src/app/programs.ts).
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const KINDS = [
  "signed out",
  "signed in, no role",
  "member of the program, not a lead",
  "lead of a different program",
  "lead of this program",
  "admin",
  "admin impersonating a lead of this program",
  "admin impersonating someone who is not a lead",
] as const;
type Kind = (typeof KINDS)[number];

const ROUTES = ["tab", "archive download", "specimens file", "associations file", "check Ecdysis", "Exports"] as const;
type Route = (typeof ROUTES)[number];

/** The status each kind of person gets from each route of the British Columbia program (Ecdysis collection 196). */
const EXPECTED: Record<Kind, Record<Route, number>> = {
  "signed out": { tab: 401, "archive download": 401, "specimens file": 401, "associations file": 401, "check Ecdysis": 401, Exports: 401 },
  "signed in, no role": { tab: 404, "archive download": 404, "specimens file": 404, "associations file": 404, "check Ecdysis": 404, Exports: 403 },
  "member of the program, not a lead": { tab: 404, "archive download": 404, "specimens file": 404, "associations file": 404, "check Ecdysis": 404, Exports: 403 },
  "lead of a different program": { tab: 404, "archive download": 404, "specimens file": 404, "associations file": 404, "check Ecdysis": 404, Exports: 403 },
  "lead of this program": { tab: 200, "archive download": 200, "specimens file": 200, "associations file": 200, "check Ecdysis": 302, Exports: 403 },
  admin: { tab: 200, "archive download": 200, "specimens file": 200, "associations file": 200, "check Ecdysis": 302, Exports: 200 },
  // The tab is drawn as the impersonated lead would see it; nothing is downloaded or started meanwhile.
  "admin impersonating a lead of this program": { tab: 200, "archive download": 403, "specimens file": 403, "associations file": 403, "check Ecdysis": 403, Exports: 403 },
  "admin impersonating someone who is not a lead": { tab: 404, "archive download": 404, "specimens file": 404, "associations file": 404, "check Ecdysis": 404, Exports: 403 },
};

const readNames = (res: Response) => res.headers.get("content-type") ?? "";

/** A store with British Columbia's Ecdysis collection read an hour ago, one eligible specimen, one finished download, and one of each kind of person. */
async function setup() {
  const f = await fixture();
  const person = async (name: string) => ((await rows(f.conn, `INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)) as [[number]])[0][0];
  const who = {
    noRole: f.vic,
    member: f.eva,
    otherLead: f.casey,
    lead: await person("Lena Lead"),
    admin: await person("Sam Staff"),
  };
  const program = (code: string) => `(SELECT entity_id FROM program WHERE code = '${code}')`;
  await f.conn.run(`INSERT INTO person_membership (person_id, program_id) VALUES (${who.member}, ${program("BC")})`);
  await f.conn.run(`INSERT INTO program_lead (program_id, person_id) VALUES (${program("WaBA")}, ${who.otherLead}), (${program("BC")}, ${who.lead})`);
  await f.conn.run(`INSERT INTO person_admin (person_id) VALUES (${who.admin})`);
  await f.cacheArchive(BC, ["BCBA_9999999"], { readHoursAgo: 1 });
  await f.specimen({ field: "2500001", sample: { inat_observation_id: "111", host_name_as_observed: "'Salvia officinalis'", host_rank: "'species'" } });
  await f.specimen({ field: "2600001", program: "OBA" });
  // A finished download from before the read, so its associations file exists and a new archive is still allowed.
  const started = await startDownload(f.db, { collection: BC, year: CURRENT_SEASON, include: INCLUDE_NONE, planned: 1, readAt: new Date(Date.now() - 7_200_000), personId: who.lead });
  if (!started.ok) throw new Error("not started");
  await completeDownload(f.db, started.id, [{ id: ((await rows(f.conn, `SELECT entity_id FROM specimen WHERE field_number = '2500001'`)) as [[number]])[0][0], catalogNumber: "BCBA_2500001" }]);
  await f.conn.run(`UPDATE ecdysis_upload_download SET started_at = now() - INTERVAL '2 hours'`);
  const dir = await mkdtemp(join(tmpdir(), "beeline-data-tab-"));
  const governance = { licenses: join(dir, "licenses.csv"), policies: join(dir, "policies.csv") };
  await writeFile(governance.licenses, "program,from_year,license,decided_by,decided_on,source,reason\n");
  await writeFile(governance.policies, "program,from_year,url,decided_by,decided_on,reason\n");
  await writeProgramArchives(f.db, f.dir, { governance });
  const started_jobs: string[] = [];
  const appFor = async (personId: number | null) =>
    createApp({
      ...(await scratchPaths()),
      ecdysisDir: f.dir,
      db: f.db,
      config: { environment: "sandbox" as const, origin: "http://localhost:3054", exportsDir: f.dir },
      inat: unusedInat,
      programGovernance: governance,
      jobs: { list: [], start: async (name) => (started_jobs.push(name), true) },
      resolveSession: async () => (personId === null ? null : { personId, login: "someone", iconUrl: null }),
    });
  const counts = async () => ({
    downloads: (await rows(f.conn, `SELECT count(*) FROM ecdysis_upload_download`))[0]![0] as bigint,
    completed: (await rows(f.conn, `SELECT count(*) FROM ecdysis_upload_download_completed`))[0]![0] as bigint,
    jobs: started_jobs.length,
  });
  const [[downloadId]] = (await rows(f.conn, `SELECT entity_id FROM ecdysis_upload_download`)) as [[number]];
  return { f, who, appFor, counts, downloadId, program };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** The request each route is, for British Columbia's tab. */
const request = (s: Setup, route: Route, init: { cookie?: string } = {}): [string, RequestInit] => {
  const headers: Record<string, string> = { origin: "http://localhost:3054", ...(init.cookie === undefined ? {} : { cookie: init.cookie }) };
  const form = { ...headers, "content-type": "application/x-www-form-urlencoded" };
  switch (route) {
    case "tab":
      return ["/programs/BC/data", { headers }];
    case "archive download":
      return [`/programs/BC/data/dwca/BC-${CURRENT_SEASON}.zip`, { headers }];
    case "specimens file":
      return [`/programs/BC/data/ecdysis/${CURRENT_SEASON}-upload.zip`, { method: "POST", headers: form, body: "" }];
    case "associations file":
      return [`/programs/BC/data/ecdysis/downloads/${s.downloadId}/associations.csv`, { headers }];
    case "check Ecdysis":
      return ["/programs/BC/data/check-ecdysis", { method: "POST", headers: form, body: "" }];
    case "Exports":
      return ["/exports", { headers }];
  }
};

const personOf = (s: Setup, kind: Kind): { id: number | null; cookie?: string } => {
  switch (kind) {
    case "signed out":
      return { id: null };
    case "signed in, no role":
      return { id: s.who.noRole };
    case "member of the program, not a lead":
      return { id: s.who.member };
    case "lead of a different program":
      return { id: s.who.otherLead };
    case "lead of this program":
      return { id: s.who.lead };
    case "admin":
      return { id: s.who.admin };
    case "admin impersonating a lead of this program":
      return { id: s.who.admin, cookie: `${IMPERSONATING_COOKIE}=${encodeURIComponent("Lena Lead")}` };
    case "admin impersonating someone who is not a lead":
      return { id: s.who.admin, cookie: `${IMPERSONATING_COOKIE}=${encodeURIComponent("Vic Volunteer")}` };
  }
};

describe("who may open a program's Data tab", () => {
  for (const kind of KINDS) {
    it(`${kind}: every route answers as the rule says, and a refusal records nothing, starts nothing and sends no file`, async () => {
      for (const route of ROUTES) {
        // A new store for each route, since asking for a specimens file uses up the read.
        const s = await setup();
        const { id, cookie } = personOf(s, kind);
        const app = await s.appFor(id);
        const before = await s.counts();
        const [path, init] = request(s, route, { cookie });
        const res = await app.request(path, init);
        const label = `${kind}: ${route}`;
        expect(res.status, label).toBe(EXPECTED[kind][route]);
        const after = await s.counts();
        const refused = res.status >= 400;
        if (refused) {
          expect(after, label).toEqual(before);
          expect(readNames(res), label).not.toMatch(/zip|csv/);
          expect(res.headers.get("content-disposition"), label).toBeNull();
          // No file bytes: a zip starts with "PK".
          expect((await res.text()).startsWith("PK"), label).toBe(false);
        } else {
          // Nothing under the tab is kept by a browser or a shared cache: the files hold names and true coordinates.
          if (res.status === 200 && route !== "Exports") expect(res.headers.get("cache-control"), label).toBe("no-store");
          await res.arrayBuffer();
        }
        // Only the specimens file records a download; only the check starts a job.
        if (!refused && route === "specimens file") expect(after.downloads, label).toBe(before.downloads + 1n);
        else expect(after.downloads, label).toBe(before.downloads);
        if (!refused && route === "check Ecdysis") expect(after.jobs, label).toBe(1);
        else expect(after.jobs, label).toBe(0);
      }
    });
  }

  it("says what a refused download is refused for while impersonating, in the app's own sentence, and shows the tab as the lead would see it", async () => {
    const s = await setup();
    const { id, cookie } = personOf(s, "admin impersonating a lead of this program");
    const app = await s.appFor(id);
    const [path, init] = request(s, "specimens file", { cookie });
    expect(await (await app.request(path, init)).text()).toBe(en.errors.readOnlyImpersonating);
    const tab = await (await app.request(...request(s, "tab", { cookie }))).text();
    expect(tab).toContain(en.programData.ecdysis.heading);
    // As the lead sees it: the tab links, and nothing of an admin's.
    expect(tab).toContain('href="/programs/BC/data"');
  });

  it("does not let a lead of one program reach another program's files by an address or an id", async () => {
    const s = await setup();
    // The lead of BC, who also leads Oregon here; Oregon has specimens and so an archive.
    await s.f.conn.run(`INSERT INTO program_lead (program_id, person_id) VALUES (${s.program("OBA")}, ${s.who.lead})`);
    const app = await s.appFor(s.who.lead);
    const before = await s.counts();
    const cases: [string, string, RequestInit?][] = [
      ["Oregon's tab address with British Columbia's download id", `/programs/OBA/data/ecdysis/downloads/${s.downloadId}/associations.csv`],
      ["Washington's tab address (not a lead of it)", `/programs/WaBA/data/ecdysis/downloads/${s.downloadId}/associations.csv`],
      ["British Columbia's address with Oregon's archive name", `/programs/BC/data/dwca/OBA-${CURRENT_SEASON}.zip`],
      ["Oregon's address with British Columbia's archive name", `/programs/OBA/data/dwca/BC-${CURRENT_SEASON}.zip`],
      ["British Columbia's address with Oregon's all-years archive", "/programs/BC/data/dwca/OBA-all.zip"],
      ["British Columbia's address with a download that does not exist", "/programs/BC/data/ecdysis/downloads/999999/associations.csv"],
    ];
    for (const [label, path] of cases) {
      const res = await app.request(path);
      expect(res.status, label).toBe(404);
      expect(res.headers.get("content-disposition"), label).toBeNull();
      await res.text();
    }
    // Oregon's own archive, from Oregon's address, is served to its lead.
    const own = await app.request(`/programs/OBA/data/dwca/OBA-${CURRENT_SEASON}.zip`);
    expect(own.status).toBe(200);
    await own.arrayBuffer();
    expect(await s.counts()).toEqual(before);
  });

  it("is not found, on every route under the tab, for a household delegate acting for a lead: delegation widens reach to samples and never what may be downloaded", async () => {
    const s = await setup();
    const [[dee]] = (await rows(s.f.conn, `INSERT INTO person (display_name) VALUES ('Dee Delegate') RETURNING entity_id`)) as [[number]];
    await s.f.conn.run(`INSERT INTO person_delegate (person_id, acts_for_id, granted_by) VALUES (${dee}, ${s.who.lead}, 'peter')`);
    const app = await s.appFor(dee);
    const cookie = `${ACTING_COOKIE}=${encodeURIComponent("Lena Lead")}`;
    const before = await s.counts();
    for (const route of ROUTES.filter((r) => r !== "Exports")) {
      const [path, init] = request(s, route, { cookie });
      const res = await app.request(path, init);
      expect(res.status, route).toBe(404);
      expect(res.headers.get("content-disposition"), route).toBeNull();
      await res.text();
    }
    expect(await s.counts()).toEqual(before);
    // The switch really is on, so the sample reach of the lead is what the delegate sees as "mine".
    const page = await (await app.request("/programs/BC", { headers: { cookie } })).text();
    expect(page).not.toContain('href="/programs/BC/data"');
  });

  it("is not found on the next request, in the same session, for a lead who is removed from program_lead", async () => {
    const s = await setup();
    const app = await s.appFor(s.who.lead);
    expect((await app.request("/programs/BC/data")).status).toBe(200);
    expect(await (await app.request("/programs/BC")).text()).toContain('href="/programs/BC/data"');
    await s.f.conn.run(`DELETE FROM program_lead WHERE person_id = ${s.who.lead}`);
    for (const route of ROUTES.filter((r) => r !== "Exports")) {
      const [path, init] = request(s, route);
      const res = await app.request(path, init);
      expect(res.status, route).toBe(404);
      await res.text();
    }
    expect(await (await app.request("/programs/BC")).text()).not.toContain('href="/programs/BC/data"');
  });

  it("has no catalog sentence under the tab that sends a person to the Exports page, or to 'above' or 'this page' where the sentence is shown at the address of a refused POST", () => {
    const e = en.programData.ecdysis;
    const everything = JSON.stringify(en.programData, (_key, value) => (typeof value === "function" ? String(value) : value));
    expect(everything).not.toMatch(/Exports/);
    for (const refusalText of [e.beingWritten, e.postOnly, e.superseded, e.tooLarge, e.choiceNeeded, e.associationsUnfinished, ...Object.values(e.refused).map(String)]) {
      expect(String(refusalText)).not.toMatch(/\babove\b|this page|Exports/);
    }
  });

  it("shows a lead who is not staff the same specimens, and as many, at the link on a year that is not offered, with the locations iNaturalist hides left out", async () => {
    // What the review asked to find out (beeline-q8di): the listing applies the ordinary reader's rule for true coordinates.
    const s = await setup();
    const year = CURRENT_SEASON - 6;
    for (let i = 0; i < 3; i++) await s.f.specimen({ field: String(2500100 + i), year });
    await s.f.specimen({ field: "2500110", year, sample: { geoprivacy: "'private'" } });
    await s.f.specimen({ field: "2500111", year, sample: { geoprivacy: "'obscured'" } });
    await s.f.specimen({ field: "2500112", year, sample: { taxon_geoprivacy: "'obscured'" } });
    const seen: Record<string, { count: string; rows: number; hidden: number; localities: number }> = {};
    for (const [who, id] of [["lead", s.who.lead], ["admin", s.who.admin]] as const) {
      const app = await s.appFor(id);
      const tab = await (await app.request("/programs/BC/data")).text();
      const link = /<a href="(\/specimens\?[^"]*ecdysis=not[^"]*)">([^<]+)<\/a>/.exec(tab)!;
      const listing = await (await app.request(link[1]!.replaceAll("&amp;", "&"))).text();
      const body = listing.match(/<tbody>[^]*<\/tbody>/)![0];
      seen[who] = {
        count: link[2]!,
        rows: (body.match(/<tr>/g) ?? []).length,
        hidden: body.split(en.listings.locationHidden).length - 1,
        localities: body.split("Umtanum Creek").length - 1,
      };
    }
    // The count on the link is the number of rows the lead gets, and the same as the admin's.
    expect(seen.lead).toMatchObject({ count: "6 specimens", rows: 6 });
    expect(seen.admin).toMatchObject({ count: "6 specimens", rows: 6, hidden: 0, localities: 6 });
    // The difference is only the place: three rows, the ones whose location iNaturalist hides, have none for a lead.
    expect(seen.lead).toMatchObject({ hidden: 3, localities: 3 });
  });

  it("answers an unknown program, and any case of a real one, as the rule does", async () => {
    const s = await setup();
    const lead = await s.appFor(s.who.lead);
    expect((await lead.request("/programs/NOPE/data")).status).toBe(404);
    expect((await lead.request("/programs/bc/data")).status).toBe(200);
    const admin = await s.appFor(s.who.admin);
    expect((await admin.request("/programs/NOPE/data")).status).toBe(404);
  });

  it("is the same rule on the program's page: the tab links are drawn exactly for those who may open the tab", async () => {
    const s = await setup();
    for (const kind of KINDS.filter((k) => k !== "signed out")) {
      const { id, cookie } = personOf(s, kind);
      const app = await s.appFor(id);
      const page = await app.request("/programs/BC", { headers: cookie === undefined ? {} : { cookie } });
      expect(page.status, kind).toBe(200);
      const html = await page.text();
      const mayOpen = EXPECTED[kind].tab === 200;
      expect(html.includes('href="/programs/BC/data"'), kind).toBe(mayOpen);
      expect(html.includes(`>${en.programData.tab}</a>`), kind).toBe(mayOpen);
      // The tab and the rule agree.
      const access = await programDataAccess(s.f.db, {
        code: "BC",
        personId: cookie === undefined ? id : id === s.who.admin ? (cookie.includes("Lena") ? s.who.lead : s.who.noRole) : id,
        admin: kind === "admin",
      });
      expect(access !== null, kind).toBe(mayOpen);
    }
  });

  it("lists each program on Exports, with the link to its tab, for an admin", async () => {
    const s = await setup();
    const admin = await s.appFor(s.who.admin);
    const page = await (await admin.request("/exports")).text();
    for (const code of ["BC", "OBA", "WaBA", "MM"]) expect(page).toContain(`href="/programs/${code}/data"`);
    // What spans programs stays.
    expect(page).toContain(en.exports.occurrences.replaceAll("'", "&#39;"));
    expect(page).toContain('href="/exports/held-back"');
    // And what is one program's has gone: no archives, no Ecdysis section.
    expect(page).not.toContain(en.programData.ecdysis.heading);
    expect(page).not.toContain("/dwca/");
  });

  it("is gone from the old addresses, for an admin too", async () => {
    const s = await setup();
    const admin = await s.appFor(s.who.admin);
    for (const [method, path] of [
      ["GET", `/exports/dwca/BC-${CURRENT_SEASON}.zip`],
      ["POST", `/exports/ecdysis/BC-${CURRENT_SEASON}-upload.zip`],
      ["GET", `/exports/ecdysis/downloads/${s.downloadId}/associations.csv`],
    ]) {
      const res = await admin.request(path!, { method: method!, headers: { origin: "http://localhost:3054" } });
      expect(res.status, path).toBe(404);
      await res.text();
    }
    expect((await s.counts()).downloads).toBe(1n);
  });
});
