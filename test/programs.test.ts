import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { programHref } from "../src/app/programs.js";
import { parseProgramContacts, readProgramContacts } from "../src/program-contacts.js";
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

const CONTACTS = "program,kind,value,label,source,recorded_by,recorded_on";

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

async function programsApp({ admin = false, contacts = [] as string[] } = {}) {
  if (admin) await conn.run(`INSERT INTO person_admin (person_id) VALUES (1)`);
  const dir = await mkdtemp(join(tmpdir(), "beeline-programs-"));
  const programContactsPath = join(dir, "program-contacts.csv");
  await writeFile(programContactsPath, [CONTACTS, ...contacts].join("\n"));
  return createApp({
    ...(await scratchPaths()),
    programContactsPath,
    db: createKysely(instance),
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: 1, login: "adacollects", iconUrl: null }),
  });
}

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

  it("gives the program's published addresses beside its leads, and says when it has none", async () => {
    const app = await programsApp({
      contacts: [
        "WaBA,email,beeatlas@example.org,Volunteer coordinator,https://example.org/contact,Test,2026-10-23",
        "WaBA,website,https://example.org/,,https://example.org/,Test,2026-10-23",
      ],
    });
    const contact = between(await page(app, "/programs/WaBA"), "<h2>Contact</h2>", "<h2>Labels</h2>");
    expect(contact).toContain("Karen Lead");
    expect(contact).toContain(`<dt>Volunteer coordinator</dt><dd><a href="mailto:beeatlas@example.org">`);
    expect(contact).toContain(`<dt>Website</dt><dd><a href="https://example.org/">`);
    expect(await page(app, "/programs/ID")).toContain("No address recorded for the program yet.");
  });

  it("states the licence decisions with where each was seen, and that no policy means no export", async () => {
    const body = await page(await programsApp(), "/programs/WaBA");
    // From the curated file in ingest/.
    expect(body).toContain("CC BY-NC 4.0, from the 2023 season");
    expect(body).toContain("Recorded by Peter Abrahamsen on Oct 10, 2026.");
    expect(body).toContain(`href="https://www.gbif.org/occurrence/search?catalog_number=WSDA_2303966"`);
    expect(body).toContain("No privacy policy yet");
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

describe("program contacts", () => {
  const parse = (...rows: string[]) => parseProgramContacts([CONTACTS, ...rows].join("\n"), "contacts.csv");

  it("reads the curated file in ingest/", async () => {
    // A malformed row must fail here rather than on a page.
    await expect(readProgramContacts()).resolves.toBeInstanceOf(Array);
  });

  it("refuses a row that does not say where it was seen, or is not an address", () => {
    expect(() => parse("WaBA,email,x@example.org,,,Test,2026-10-23")).toThrow("where it was seen");
    expect(() => parse("WaBA,email,not-an-address,,https://example.org,Test,2026-10-23")).toThrow("not an email address");
    expect(() => parse("WaBA,website,javascript:alert(1),,https://example.org,Test,2026-10-23")).toThrow("not a web address");
    expect(() => parse("WaBA,phone,555,,https://example.org,Test,2026-10-23")).toThrow("kind 'phone'");
  });
});
