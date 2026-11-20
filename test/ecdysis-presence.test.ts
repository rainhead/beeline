import { describe, expect, it } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { listingHref, parseListingQuery, EMPTY_QUERY } from "../src/app/listings.js";
import { ecdysisRecordUrl } from "../src/app/ecdysis-link.js";
import { prepareRun } from "../src/print-run.js";
import { createKysely } from "../src/db.js";
import { readXlsxHere } from "../src/app/xlsx-reader.js";
import { CURRENT_SEASON, SETTLED_SEASON, createMemoryDb, insertCleanSample, rows, scratchPaths } from "./helpers.js";

/**
 * Which specimens are in Ecdysis, and which are expected there and are not
 * (beeline-8dx9.11). Every specimen here has a field number that says what it
 * is for, so a page or a download can be asked which of them it names.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};
const f = en.listings.filters;
const day = (year: number) => `DATE '${year}-07-14'`;

async function setup() {
  const { instance, conn } = await createMemoryDb();
  const [[staff]] = (await rows(
    conn,
    `INSERT INTO person (display_name, given_name, family_name) VALUES ('Sam Staff', 'Sam', 'Staff') RETURNING entity_id`,
  )) as [[number]];
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staff})`);
  const program = (code: string) => `(SELECT entity_id FROM program WHERE code = '${code}')`;
  /** A sample of the program, collected in the year, with one specimen carrying the field number (none: no label). */
  const specimen = async (field: string | null, code: string | null, year: number, extra: Record<string, string> = {}) => {
    const sample = await insertCleanSample(conn, {
      sample_number: `'S-${field ?? "C-IMPORTED"}'`,
      specimen_count: "1",
      date_start: day(year),
      date_end: day(year),
      ...(code === null ? {} : { atlas_id: program(code) }),
      ...extra,
    });
    const [[id]] = (await rows(
      conn,
      `INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sample}, 1, ${field === null ? "NULL" : `'${field}'`}) RETURNING entity_id`,
    )) as [[number]];
    return { sample, id };
  };
  const inEcdysis = (id: number, occurrence: string | null) =>
    conn.run(
      `INSERT INTO specimen_catalog_number (specimen_id, catalog_number, occurrence_id) VALUES (${id}, 'WSDA_${id}', ${occurrence === null ? "NULL" : `'${occurrence}'`})`,
    );

  // The year's upload has happened for Washington, in this year and not in the settled one.
  const here = await specimen("A-IN", "WaBA", CURRENT_SEASON);
  await inEcdysis(here.id, "0f3c-uuid");
  // The one expected there, and one more of the same kind to prove a count.
  await specimen("B-EXPECTED", "WaBA", CURRENT_SEASON);
  // Each of the other conditions alone.
  // Imported before field numbering: no number, and its label is on paper all the same.
  await specimen(null, "WaBA", CURRENT_SEASON);
  await specimen("D-NO-COLLECTION", "OBA", CURRENT_SEASON); // a program Ecdysis has no collection for
  const missing = await specimen("E-MISSING", "WaBA", CURRENT_SEASON);
  await conn.run(
    `INSERT INTO specimen_disposition (specimen_id, disposition, remarks, stated_by, stated_on, source)
     VALUES (${missing.id}, 'missing', 'No pin found.', 'Inez Inventory', DATE '2026-11-03', 'inventory.xlsx')`,
  );
  await specimen("F-YEAR-NOT-UPLOADED", "WaBA", SETTLED_SEASON); // Ecdysis holds none of Washington's from that year
  await specimen("G-NO-PROGRAM", null, CURRENT_SEASON); // no atlas at all
  // British Columbia has a collection but nothing of its own in Ecdysis this year: Washington's upload does not count for it.
  await specimen("H-BC-NOT-UPLOADED", "BC", CURRENT_SEASON);
  // A catalog row without a record id still counts as being in Ecdysis, and gets no link.
  const noRecord = await specimen("I-IN-NO-RECORD", "WaBA", CURRENT_SEASON);
  await inEcdysis(noRecord.id, null);

  // A sample whose specimens a prepared run has numbered but not printed: they have field numbers and no label on paper.
  await insertCleanSample(conn, {
    sample_number: "'S-J-PREPARED'",
    specimen_count: "1",
    date_start: day(CURRENT_SEASON),
    date_end: day(CURRENT_SEASON),
    atlas_id: program("WaBA"),
  });
  const run = await prepareRun(conn, { atlasId: null, personId: staff });
  expect(run?.labels).toBe(1);
  const [[numbered]] = (await rows(conn, `SELECT field_number FROM specimen WHERE sample_id = (SELECT entity_id FROM sample WHERE sample_number = 'S-J-PREPARED')`)) as [[string]];
  expect(numbered).not.toBeNull();

  const app = createApp({
    ...(await scratchPaths()),
    db: createKysely(instance),
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: staff, login: "staff", iconUrl: null }),
  });
  const get = async (path: string) => (await app.request(path)).text();
  /** The field numbers of the rows a download of the listing holds. */
  const download = async (query: string) => {
    const res = await app.request(`/specimens.xlsx?${query}`);
    expect(res.status).toBe(200);
    const read = readXlsxHere(new Uint8Array(await res.arrayBuffer()));
    if (!read.ok) throw new Error(read.refusal);
    const [head, ...body] = read.sheet.rows.map((r) => r.cells);
    const column = [...head!.entries()].find(([, c]) => c.text === "fieldNumber")![0];
    return body.map((cells) => cells.get(column)?.text ?? "").sort();
  };
  return { app, get, conn, download, ids: { here: here.id, noRecord: noRecord.id, missing: missing.id } };
}

/** The field numbers a listing page names, among the ones this test made. */
const EVERYTHING = ["A-IN", "B-EXPECTED", "C-IMPORTED", "J-PREPARED", "D-NO-COLLECTION", "E-MISSING", "F-YEAR-NOT-UPLOADED", "G-NO-PROGRAM", "H-BC-NOT-UPLOADED", "I-IN-NO-RECORD"];
const named = (page: string) => EVERYTHING.filter((n) => page.includes(n));

describe("the Ecdysis filter on the Specimens listing", () => {
  it("in Ecdysis: the specimens with a catalog number from Ecdysis, with or without a record id", async () => {
    const { get } = await setup();
    const page = await get("/specimens?scope=all&ecdysis=in");
    expect(named(page)).toEqual(["A-IN", "I-IN-NO-RECORD"]);
    expect(page).toContain(`${f.ecdysis}: ${f.ecdysisIn}`);
  });

  it("not in Ecdysis: every other specimen, including those never expected there", async () => {
    const { get } = await setup();
    expect(named(await get("/specimens?scope=all&ecdysis=not"))).toEqual(
      EVERYTHING.filter((n) => n !== "A-IN" && n !== "I-IN-NO-RECORD"),
    );
  });

  it("expected but not there: a label on paper, a program with a collection, not missing, and that year already uploaded", async () => {
    const { get } = await setup();
    const page = await get("/specimens?scope=all&ecdysis=expected");
    expect(named(page)).toEqual(["B-EXPECTED", "C-IMPORTED"]);
    expect(page).toContain(`${f.ecdysis}: ${f.ecdysisExpected}`);
  });

  it("any, or an unknown value, narrows nothing", async () => {
    const { get } = await setup();
    expect(named(await get("/specimens?scope=all"))).toEqual(EVERYTHING);
    expect(named(await get("/specimens?scope=all&ecdysis=nonsense"))).toEqual(EVERYTHING);
  });

  it("each condition on its own leaves a specimen out of 'expected'", async () => {
    const { get, conn, ids } = await setup();
    const expected = async () => named(await get("/specimens?scope=all&ecdysis=expected")).sort();
    expect(await expected()).toEqual(["B-EXPECTED", "C-IMPORTED"]);
    // Each of the other specimens fails exactly one condition, so undoing that one makes it expected.
    await conn.run(`DELETE FROM specimen_disposition WHERE specimen_id = ${ids.missing}`);
    expect(await expected()).toEqual(["B-EXPECTED", "C-IMPORTED", "E-MISSING"]);
    // The run that numbered J's specimen prints: now the label is on paper.
    await conn.run(`UPDATE print_run SET approved_at = current_timestamp, approved_by = (SELECT min(entity_id) FROM person), printed_at = current_timestamp, printed_by = (SELECT min(entity_id) FROM person)`);
    expect(await expected()).toEqual(["B-EXPECTED", "C-IMPORTED", "E-MISSING", "J-PREPARED"]);
  });

  it("a number from a run not yet printed is not a label on paper, and an imported specimen without a number is", async () => {
    const { get } = await setup();
    const page = await get("/specimens?scope=all&ecdysis=expected");
    expect(page).not.toContain("J-PREPARED"); // has a field number, no label on paper
    expect(page).toContain("C-IMPORTED"); // no field number, label on paper
  });

  it("a program's year counts once Ecdysis holds a specimen of that program from that year, and not before", async () => {
    const { get, conn } = await setup();
    const expected = async () => named(await get("/specimens?scope=all&ecdysis=expected")).sort();
    expect(await expected()).toEqual(["B-EXPECTED", "C-IMPORTED"]);
    // Ecdysis now holds one of Washington's from the settled year, so F is expected too.
    const [[sample]] = (await rows(conn, `SELECT sample_id FROM specimen WHERE field_number = 'F-YEAR-NOT-UPLOADED'`)) as [[number]];
    const [[other]] = (await rows(
      conn,
      `INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sample}, 2, 'F-OTHER') RETURNING entity_id`,
    )) as [[number]];
    await conn.run(`INSERT INTO specimen_catalog_number (specimen_id, catalog_number, occurrence_id) VALUES (${other}, 'WSDA_F', 'f-uuid')`);
    expect(await expected()).toEqual(["B-EXPECTED", "C-IMPORTED", "F-YEAR-NOT-UPLOADED"]);
  });

  it("combines with another filter", async () => {
    const { get } = await setup();
    const both = await get(`/specimens?scope=all&ecdysis=not&year=${SETTLED_SEASON}`);
    expect(named(both)).toEqual(["F-YEAR-NOT-UPLOADED"]);
    expect(named(await get(`/specimens?scope=all&ecdysis=expected&year=${SETTLED_SEASON}`))).toEqual([]);
  });

  it("survives paging and sorting in the query string", async () => {
    const q = parseListingQuery(new URLSearchParams("scope=all&ecdysis=expected&sort=date&page=3"), { atlasCodes: [] });
    expect(q.ecdysis).toBe("expected");
    expect(listingHref("/specimens", q, { page: 4 })).toContain("ecdysis=expected");
    expect(listingHref("/specimens", { ...q, sort: "number" }, { page: 1 })).toContain("ecdysis=expected");
    expect(listingHref("/specimens", EMPTY_QUERY)).not.toContain("ecdysis");
  });

  it("pages through the filtered rows with the filter in every link", async () => {
    const { get, conn } = await setup();
    // Sixty more expected specimens in one Washington sample.
    const sample = await insertCleanSample(conn, {
      sample_number: "'BULK'",
      specimen_count: "60",
      atlas_id: "(SELECT entity_id FROM program WHERE code = 'WaBA')",
    });
    await conn.run(
      `INSERT INTO specimen (sample_id, specimen_number, field_number)
       SELECT ${sample}, n, 'BULK-' || n FROM range(1, 61) t(n)`,
    );
    const first = await get("/specimens?scope=all&ecdysis=expected");
    expect(first).toContain("ecdysis=expected&amp;page=2");
    const second = await get("/specimens?scope=all&ecdysis=expected&page=2");
    expect(second).toContain("BULK-");
    expect(second).not.toContain("A-IN");
  });

  it("applies to the download of the listing", async () => {
    const { download } = await setup();
    expect(await download("scope=all&ecdysis=expected")).toEqual(["", "B-EXPECTED"]); // C-IMPORTED has no field number
    expect(await download("scope=all&ecdysis=in")).toEqual(["A-IN", "I-IN-NO-RECORD"]);
    expect(await download("scope=all&ecdysis=not")).toHaveLength(8); // ten specimens, two of them in Ecdysis
  });

  it("on samples, finds the samples that have such a specimen", async () => {
    const { get } = await setup();
    const page = await get("/samples?scope=all&ecdysis=expected");
    expect(page).toContain("S-B-EXPECTED");
    expect(page).not.toContain("S-A-IN");
    expect(page).not.toContain("S-E-MISSING");
  });
});

describe("the link to Ecdysis", () => {
  it("is built in one place from the record id", () => {
    expect(ecdysisRecordUrl("0f3c-uuid")).toBe("https://ecdysis.org/collections/individual/index.php?guid=0f3c-uuid");
    expect(ecdysisRecordUrl("a b&c")).toBe("https://ecdysis.org/collections/individual/index.php?guid=a%20b%26c");
    expect(ecdysisRecordUrl(null)).toBeNull();
  });

  it("the specimen page links the catalog number when there is a record id", async () => {
    const { get, ids } = await setup();
    const page = await get(`/specimens/${ids.here}`);
    expect(page).toContain(`href="https://ecdysis.org/collections/individual/index.php?guid=0f3c-uuid"`);
    expect(page).toContain(`WSDA_${ids.here}`);
  });

  it("shows the catalog number as plain text without a record id, and says nothing where there is none", async () => {
    const { get, ids, conn } = await setup();
    const page = await get(`/specimens/${ids.noRecord}`);
    expect(page).toContain(`WSDA_${ids.noRecord}`);
    expect(page).not.toContain("collections/individual");
    const [[plain]] = (await rows(conn, `SELECT entity_id FROM specimen WHERE field_number = 'B-EXPECTED'`)) as [[number]];
    const bare = await get(`/specimens/${plain}`);
    expect(bare).not.toContain("collections/individual");
    expect(bare).not.toContain(en.record.specimen.ecdysis.catalogNumber);
  });
});
