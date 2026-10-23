import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { programHref } from "../src/app/programs.js";
import { parseProgramContacts } from "../src/program-contacts.js";
import { createMemoryDb, insertCleanSample, OPEN_SEASON, scratchPaths } from "./helpers.js";

/**
 * The programs pages (beeline-rrit).
 *
 * Sandbox rather than development, because development makes everyone an
 * admin and these pages are for people who are not as well.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

let instance: DuckDBInstance;
let conn: DuckDBConnection;

const atlas = (code: string) => `(SELECT entity_id FROM atlas WHERE code = '${code}')`;
const program = (code: string) => `(SELECT entity_id FROM program WHERE code = '${code}')`;

beforeEach(async () => {
  ({ instance, conn } = await createMemoryDb());
  await conn.run(`INSERT INTO person (entity_id, display_name) VALUES
    (1, 'Ada Collector'), (2, 'Bea Partner'), (3, 'Karen Lead'), (4, 'Olivia Lead')`);
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (1, 101, 'adacollects'), (3, 103, 'karenlead')`);
  // Two Washington samples this season, one collected by a pair; one last
  // season; one outside every atlas, which is Master Melittology's.
  const pair = await insertCleanSample(conn, { atlas_id: atlas("WaBA"), state_province: "'WA'" });
  await conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${pair}, 2, 2)`);
  await insertCleanSample(conn, { atlas_id: atlas("WaBA"), state_province: "'WA'", sample_number: "'2'" });
  const lastSeason = `DATE '${OPEN_SEASON - 1}-07-14'`;
  await insertCleanSample(conn, {
    atlas_id: atlas("WaBA"),
    state_province: "'WA'",
    sample_number: "'3'",
    date_start: lastSeason,
    date_end: lastSeason,
  });
  const outside = await insertCleanSample(conn, { state_province: "'NV'", sample_number: "'4'" });
  await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${pair}, 1), (${pair}, 2), (${outside}, 1)`);
  await conn.run(`INSERT INTO person_membership (person_id, kind, atlas_id) VALUES
    (1, 'atlas', ${atlas("WaBA")}), (2, 'atlas', ${atlas("WaBA")}), (3, 'program', NULL)`);
  await conn.run(`INSERT INTO program_lead (program_id, person_id) VALUES
    (${program("WaBA")}, 3), (${program("NM")}, 4), (${program("BLM")}, 4)`);
});

async function programsApp({ admin = false } = {}) {
  if (admin) await conn.run(`INSERT INTO person_admin (person_id) VALUES (1) ON CONFLICT DO NOTHING`);
  const paths = await scratchPaths();
  const app = createApp({
    ...paths,
    db: createKysely(instance),
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: 1, login: "adacollects", iconUrl: null }),
  });
  return Object.assign(app, { contactsPath: paths.programContactsPath });
}

const saveEmail = (app: Awaited<ReturnType<typeof programsApp>>, code: string, email: string) =>
  app.request(`/programs/${code}/contact`, { method: "POST", body: new URLSearchParams({ email }) });

const page = async (app: Awaited<ReturnType<typeof programsApp>>, path: string) => {
  const res = await app.request(path);
  expect(res.status, path).toBe(200);
  return res.text();
};

const between = (body: string, start: string, end: string) => {
  const from = body.indexOf(start);
  return from < 0 ? "" : body.slice(from, body.indexOf(end, from));
};

/** The table row linking to this program. */
const rowFor = (body: string, code: string) =>
  body.split("<tr>").find((row) => row.includes(`href="${programHref(code)}"`)) ?? "";

const EMPTY_VALUE_CELL = /<td><\/td>|<td class="nowrap"><\/td>/;

describe("the programs listing", () => {
  it("is read by everyone signed in, and is in the menu beside the brand", async () => {
    const body = await page(await programsApp(), "/programs");
    expect(between(body, 'class="menu nav-menu"', "</details>")).toContain(`href="/programs"`);
    for (const code of ["OBA", "WaBA", "BC", "ID", "NM", "OK", "MM", "BLM"]) expect(rowFor(body, code), code).not.toBe("");
  });

  it("counts each program's own: an atlas's ground, and Master Melittology's outside every atlas", async () => {
    const body = await page(await programsApp(), "/programs");
    const waba = rowFor(body, "WaBA");
    // Two samples this season; three specimens across every season, all on one sample.
    expect(waba).toContain("<td>2</td>");
    expect(waba).toContain("Karen Lead");
    expect(waba).toContain("2 people");
    const mm = rowFor(body, "MM");
    expect(mm).toContain("<td>1</td>");
    // Membership of the program with no atlas is Master Melittology's.
    expect(mm).toContain("1 person");
  });

  it("never leaves a value cell empty, and says what the surveys cannot be counted by", async () => {
    const body = await page(await programsApp(), "/programs");
    expect(body).not.toMatch(EMPTY_VALUE_CELL);
    expect(rowFor(body, "OK")).toContain("no lead recorded");
    expect(rowFor(body, "BLM")).toContain("not recorded");
  });

  it("links leads and members into the roster for staff only", async () => {
    const volunteer = rowFor(await page(await programsApp(), "/programs"), "WaBA");
    expect(volunteer).not.toContain(`href="/people`);
    const staff = rowFor(await page(await programsApp({ admin: true }), "/programs"), "WaBA");
    expect(staff).toContain(`href="/people/karenlead"`);
    expect(staff).toContain(`href="/people?member=WaBA"`);
  });
});

describe("a program's page", () => {
  it("is addressed by code, in any case, and a code nobody holds is not found", async () => {
    const app = await programsApp();
    expect(await page(app, "/programs/waba")).toContain("<h1>Washington Bee Atlas</h1>");
    const missing = await app.request("/programs/XX");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("There is no program with that code.");
  });

  it("gives this season's numbers and every season's records, a pair counting as two collectors", async () => {
    const body = await page(await programsApp(), "/programs/WaBA");
    const glance = between(body, "At a glance", "</dl>");
    expect(glance).toContain(`Collectors in ${OPEN_SEASON}</dt><dd>2</dd>`);
    expect(glance).toContain(`Samples in ${OPEN_SEASON}</dt><dd>2</dd>`);
    expect(glance).toContain(`Specimens in ${OPEN_SEASON}</dt><dd>2</dd>`);
    const seasons = between(body, "Records by season", "</table>");
    expect(seasons.indexOf(`${OPEN_SEASON} season`)).toBeLessThan(seasons.indexOf(`${OPEN_SEASON - 1} season`));
    expect(body).not.toMatch(EMPTY_VALUE_CELL);
  });

  it("says whether the atlas prints its own labels, and its answer on taxon-obscured records", async () => {
    const app = await programsApp();
    const waba = await page(app, "/programs/WaBA");
    expect(waba).toContain("Does not print its own labels");
    expect(waba).toContain("Has not said whether its labels may carry the true point");
    // Oregon's answer is seeded by the schema, with where it was given.
    const oba = await page(app, "/programs/OBA");
    expect(oba).toContain("Arthur Schrenk said so on Oct 21, 2026.");
    expect(oba).toContain(`href="https://github.com/rainhead/beeline/issues/13#issuecomment-6327141377"`);
    await conn.run(`INSERT INTO atlas_printing (atlas_id) VALUES (${atlas("WaBA")})`);
    expect(await page(app, "/programs/WaBA")).toContain("Prints its own labels");
    expect(await page(app, "/programs/MM")).toContain("No atlas answers for records collected outside every atlas");
  });

  it("shows the atlas's mark beside its name, and none for a program without one", async () => {
    const app = await programsApp();
    expect(await page(app, "/programs/WaBA")).toContain(`<img class="atlas-mark" src="/static/atlas/WaBA.jpg" alt="Washington Bee Atlas"`);
    expect(await page(app, "/programs/MM")).not.toContain(`class="atlas-mark"`);
  });

  it("gives the leads, the address staff set, and an atlas's own website", async () => {
    const app = await programsApp({ admin: true });
    const before = between(await page(app, "/programs/WaBA"), "<h2>Contact</h2>", "<h2>Labels</h2>");
    expect(before).toContain("Karen Lead");
    expect(before).toContain(`<span class="meta absent">none recorded yet</span>`);
    expect(before).toContain(`<dt>Website</dt><dd><a href="https://agr.wa.gov/departments/insects-pests-and-weeds/insects/apiary-pollinators/pollinator-health/bee-atlas/">agr.wa.gov</a>`);
    const saved = await saveEmail(app, "waba", " beeatlas@example.org ");
    expect(saved.status).toBe(302);
    expect(saved.headers.get("location")).toBe("/programs/WaBA");
    const after = between(await page(app, "/programs/WaBA"), "<h2>Contact</h2>", "<h2>Labels</h2>");
    expect(after).toContain(`<dt>Email</dt><dd><a href="mailto:beeatlas@example.org">beeatlas@example.org</a>`);
    expect(after).toContain("Set by adacollects");
    // Master Melittology has no atlas, so no website on file.
    expect(between(await page(app, "/programs/MM"), "<h2>Contact</h2>", "<h2>Labels</h2>")).not.toContain("<dt>Website</dt>");
  });

  it("keeps every save in the log, the latest standing, and an emptied field as removed", async () => {
    const app = await programsApp({ admin: true });
    await saveEmail(app, "WaBA", "first@example.org");
    await saveEmail(app, "WaBA", "first@example.org"); // unchanged: nothing appended
    await saveEmail(app, "WaBA", "second@example.org");
    await saveEmail(app, "WaBA", "");
    const log = (await readFile(app.contactsPath, "utf8")).trim().split("\n");
    expect(log[0]).toBe("recorded_at,program,field,value,author");
    expect(log.slice(1).map((line) => line.split(",").slice(1).join(","))).toEqual([
      "WaBA,email,first@example.org,adacollects",
      "WaBA,email,second@example.org,adacollects",
      "WaBA,email,,adacollects",
    ]);
    expect(await page(app, "/programs/WaBA")).toContain("none recorded yet");
  });

  it("refuses an address that is not one, and refuses anyone but staff", async () => {
    const staff = await programsApp({ admin: true });
    expect((await saveEmail(staff, "WaBA", "not an address")).status).toBe(400);
    // The page makes a mailto: link of it, where a query would add recipients.
    expect((await saveEmail(staff, "WaBA", "a@example.org?bcc=x@example.org")).status).toBe(400);
    expect((await saveEmail(staff, "XX", "a@example.org")).status).toBe(404);
    await conn.run(`DELETE FROM person_admin`);
    const volunteer = await programsApp();
    expect((await saveEmail(volunteer, "WaBA", "a@example.org")).status).toBe(403);
    expect(await page(volunteer, "/programs/WaBA")).not.toContain(`action="/programs/WaBA/contact"`);
  });

  it("does not show licences or privacy policies, which are the exports' business", async () => {
    const body = await page(await programsApp(), "/programs/WaBA");
    expect(body).not.toContain("CC BY-NC");
    expect(body).not.toContain("privacy policy");
    expect(body).toContain("dataset 44");
    expect(await page(await programsApp(), "/programs/OBA")).not.toContain("Expert determinations");
  });

  it("gives the surveys no records by geography, and says why", async () => {
    const body = await page(await programsApp(), "/programs/BLM");
    expect(body).toContain("survey samples will come in through the surveys&#39; own field entry");
    expect(body).not.toContain("<h2>Labels</h2>");
    expect(body).not.toMatch(EMPTY_VALUE_CELL);
  });

  it("links into the listings for staff only, by the program's scope", async () => {
    expect(await page(await programsApp(), "/programs/MM")).not.toContain(`href="/samples?scope=`);
    const staff = await page(await programsApp({ admin: true }), "/programs/MM");
    expect(staff).toContain(`href="/samples?scope=outside"`);
    expect(staff).toContain(`href="/specimens?scope=outside"`);
  });
});

describe("the program contact log", () => {
  it("is read leniently: a line that does not parse is skipped, and the latest line stands", () => {
    const contacts = parseProgramContacts(
      [
        "recorded_at,program,field,value,author",
        "2026-10-23T10:00:00.000Z,WaBA,email,old@example.org,a",
        "garbage",
        "2026-10-23T11:00:00.000Z,WaBA,phone,555,a",
        "2026-10-23T12:00:00.000Z,WaBA,email,new@example.org,b",
        "2026-10-23T13:00:00.000Z,OBA,email,x@example.org,a",
        "2026-10-23T14:00:00.000Z,OBA,email,,a",
      ].join("\n"),
    );
    expect(contacts.get("WaBA")?.email?.value).toBe("new@example.org");
    expect(contacts.get("WaBA")?.email?.author).toBe("b");
    expect(contacts.get("OBA")?.email).toBeUndefined();
  });
});
