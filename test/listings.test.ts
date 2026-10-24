import { en } from "../src/app/messages/en.js";
import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import {
  exportFilename,
  CSV_PAGE_SIZE,
  csvCell,
  csvStream,
  EMPTY_QUERY,
  listSamples,
  listingHref,
  MINE,
  parseListingQuery,
  toCsv,
  type ListingQuery,
  type SpecimenRow,
} from "../src/app/listings.js";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { specimenArchiveStream, type IdentificationRow } from "../src/app/dwc-archive.js";
import { writeProgramArchives } from "../src/app/program-archives.js";
import type { GovernancePaths } from "../src/program-governance.js";
import { createMemoryDb, insertCleanSample, OPEN_SEASON, rows, scratchPaths } from "./helpers.js";

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const person = async (conn: Awaited<ReturnType<typeof createMemoryDb>>["conn"], name: string) => {
  // Parted, because a label prints "A. Adams" and that is derived from the
  // parts, never re-split from the display name (src/person-name.ts).
  const [given, family] = name.split(" ");
  const [[id]] = (await (
    await conn.run(
      `INSERT INTO person (display_name, given_name, family_name)
       VALUES ('${name}', '${given}', '${family}') RETURNING entity_id`,
    )
  ).getRows()) as [[number]];
  return id;
};

/**
 * Three collectors, two atlases, and the ground outside both — enough for
 * every scope, filter, and column the listings have.
 *
 * The membership rows are deliberately uneven, because the store's are
 * (beeline-lcl): Bob is a WaBA member who also collects in Nevada, Cleo
 * belongs to Master Melittology itself with no atlas, and nobody has recorded
 * where Alice belongs. Those are three different answers, and a listing has
 * to be able to ask for each of them separately from where a sample fell.
 */
async function listingApp(
  signedInAs: "alice" | "bob" | "staffer" = "alice",
  /** Where the program archives live and which decisions govern them; nowhere real unless a test says. */
  exports: { dir?: string; governance?: GovernancePaths } = {},
) {
  const { instance, conn } = await createMemoryDb();
  const alice = await person(conn, "Alice Adams");
  const bob = await person(conn, "Bob Barnes");
  const cleo = await person(conn, "Cleo Cortez");
  const staffer = await person(conn, "Sam Staff");

  // One of them has an iNat account, so search-by-login has something to find.
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${alice}, 4242, 'aadams')`);

  const atlas = (code: string) => `(SELECT entity_id FROM atlas WHERE code = '${code}')`;

  // Alice, Oregon: clean, two printed specimens, both determined.
  const a1 = await insertCleanSample(conn, {
    collector_id: String(alice),
    atlas_id: atlas("OBA"),
    sample_number: "'A-1'",
    specimen_count: "2",
    date_start: "DATE '2026-07-14'",
    date_end: "DATE '2026-07-14'",
    locality: "'Corvallis'",
  });
  // Alice, Oregon: no locality, so a blocking finding — and a different year.
  await insertCleanSample(conn, {
    collector_id: String(alice),
    atlas_id: atlas("OBA"),
    sample_number: "'A-2'",
    locality: "NULL",
    date_start: "DATE '2025-06-01'",
    date_end: "DATE '2025-06-01'",
  });
  // Bob, Washington: his numbering, and Alice was there too (beeline-77j).
  const b1 = await insertCleanSample(conn, {
    collector_id: String(bob),
    atlas_id: atlas("WaBA"),
    sample_number: "'B-1'",
    specimen_count: "1",
    county: "'Whatcom'",
    state_province: "'WA'",
    locality: "'Bellingham'",
  });
  await conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${b1}, ${alice}, 2)`);
  // Bob alone, Washington: nothing of Alice's in it.
  await insertCleanSample(conn, {
    collector_id: String(bob),
    atlas_id: atlas("WaBA"),
    sample_number: "'B-2'",
    locality: "'Anacortes'",
    state_province: "'WA'",
  });
  // Bob again, Nevada: a member of an atlas, collecting where none reaches.
  await insertCleanSample(conn, {
    collector_id: String(bob),
    atlas_id: "NULL",
    sample_number: "'B-3'",
    locality: "'Gerlach'",
    county: "'Washoe'",
    state_province: "'NV'",
  });
  // Cleo, Nevada: no atlas to be a member of, and that is her answer.
  await insertCleanSample(conn, {
    collector_id: String(cleo),
    atlas_id: "NULL",
    sample_number: "'C-1'",
    locality: "'Fallon'",
    county: "'Churchill'",
    state_province: "'NV'",
  });

  await conn.run(
    `INSERT INTO person_membership (person_id, kind, atlas_id)
     VALUES (${bob}, 'atlas', ${atlas("WaBA")}), (${cleo}, 'program', NULL)`,
  );

  // A slice of taxonomy: family → genus → species, so a family filter has
  // something to descend through.
  await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('family', 'Apidae')`);
  await conn.run(
    `INSERT INTO animal (rank, scientific_name, parent_id)
     SELECT 'genus', 'Bombus', entity_id FROM animal WHERE scientific_name = 'Apidae'`,
  );
  await conn.run(
    `INSERT INTO animal (rank, scientific_name, parent_id, authorship)
     SELECT 'species', 'Bombus vosnesenskii', entity_id, 'Radoszkowski, 1862'
     FROM animal WHERE scientific_name = 'Bombus'`,
  );
  await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('genus', 'Andrena')`);

  await conn.run(
    `INSERT INTO specimen (sample_id, specimen_number, field_number)
     VALUES (${a1}, 1, 'OBA00001'), (${a1}, 2, 'OBA00002'), (${b1}, 1, 'WABA0001')`,
  );
  await conn.run(
    `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_id,
                                qualifier, verbatim_identification)
     SELECT sp.entity_id, an.entity_id, true, 'legacy_import', ${bob},
            'cf.', 'Bombus cf. vosnesenskii'
     FROM specimen sp, animal an
     WHERE sp.field_number = 'OBA00001' AND an.scientific_name = 'Bombus vosnesenskii'`,
  );
  await conn.run(
    `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_name)
     SELECT sp.entity_id, an.entity_id, false, 'legacy_import', 'A Volunteer'
     FROM specimen sp, animal an
     WHERE sp.field_number = 'WABA0001' AND an.scientific_name = 'Andrena'`,
  );

  // Admin is a person_admin row now, not a config list (beeline-eft).
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staffer})`);

  const people = { alice, bob, staffer };
  const db = createKysely(instance);
  const app = createApp({
    ...(await scratchPaths()),
    db,
    // Sandbox, not development: development makes everyone an admin, which
    // is exactly what these tests need to tell apart (beeline-6va).
    config: { environment: "sandbox" as const, origin: "http://localhost:3054", exportsDir: exports.dir },
    inat: unusedInat,
    resolveSession: async () => ({ personId: people[signedInAs], login: signedInAs, iconUrl: null }),
    programGovernance: exports.governance,
  });
  return { app, db, conn, ...people };
}

const get = async (app: Awaited<ReturnType<typeof listingApp>>["app"], path: string) => {
  const res = await app.request(path);
  expect(res.status, path).toBe(200);
  return res.text();
};

describe("sample listing", () => {
  it("shows every sample the signed-in person collected, and nobody else's", async () => {
    const { app } = await listingApp();
    const body = await get(app, "/samples");
    expect(body).toContain("A-1");
    expect(body).toContain("A-2");
    // Bob's trap line, which Alice also collected: hers to see.
    expect(body).toContain("B-1");
    // The label form, because that is the name that will be printed.
    expect(body).toContain("B. Barnes");
    expect(body).not.toContain("Bob Barnes");
    // Bob's solo sample stays his.
    expect(body).not.toContain("B-2");
    expect(body).toContain("3 samples");
  });

  it("carries the QC state of each row", async () => {
    const { app } = await listingApp();
    const body = await get(app, "/samples");
    expect(body).toContain("1 flag blocks printing");
    expect(body).toContain("clean");
  });

  it("starts a volunteer at their own records, and lets them see everybody's", async () => {
    const { app } = await listingApp();
    const mine = await get(app, "/samples");
    expect(mine).toContain("3 samples");
    expect(mine).toContain(`name="scope"`);
    // Every record is open to everyone signed in (beeline-20w3).
    const all = await get(app, "/samples?scope=all");
    expect(all).toContain("6 samples");
    expect(all).toContain("B-2");
    // And they are told why some of them say less about where.
    expect(all).toContain(en.listings.scope.withheldNote.replaceAll("'", "&#39;"));
  });

  it("lets staff scope to an atlas, or to all of them", async () => {
    const { app } = await listingApp("staffer");
    // Sam collects nothing: their own listing is empty, not everyone's.
    expect(await get(app, "/samples")).toContain("None of your collecting has reached Beeline yet");

    const wa = await get(app, "/samples?scope=WaBA");
    expect(wa).toContain("B-1");
    expect(wa).toContain("B-2");
    expect(wa).not.toContain("A-1");

    const all = await get(app, "/samples?scope=all");
    expect(all).toContain("6 samples");
    // Staff see every location, so the note about hidden ones is not theirs.
    expect(all).not.toContain(en.listings.scope.withheldNote.replaceAll("'", "&#39;"));
  });

  // The two axes, and the point is that they disagree: B-3 is outside every
  // atlas AND collected by a WaBA member, so neither control alone finds
  // what the other one does (beeline-lcl).
  it("scopes to the ground outside every atlas, members travelling included", async () => {
    const { app } = await listingApp("staffer");
    const outside = await get(app, "/samples?scope=outside");
    expect(outside).toContain("2 samples");
    expect(outside).toContain("B-3");
    expect(outside).toContain("C-1");
    expect(outside).not.toContain("B-2");
  });

  it("filters by where the collector belongs, which is not where they collected", async () => {
    const { app } = await listingApp("staffer");

    // A WaBA member's records, wherever they fell — B-3 is in Nevada.
    const waba = await get(app, "/samples?scope=all&member=WaBA");
    expect(waba).toContain("3 samples");
    expect(waba).toContain("B-3");

    // Belonging to the program itself is an answer, and finds only Cleo.
    const program = await get(app, "/samples?scope=all&member=program");
    expect(program).toContain("1 sample");
    expect(program).toContain("C-1");

    // Unrecorded is the absence — and it is a fact about every collector on
    // the sample, so B-1 (Bob and Alice) is not unrecorded just because
    // nobody has asked about Alice.
    const unrecorded = await get(app, "/samples?scope=all&member=unrecorded");
    expect(unrecorded).toContain("2 samples");
    expect(unrecorded).toContain("A-1");
    expect(unrecorded).not.toContain("B-1");
  });

  it("clears the membership filter along with every other one", async () => {
    // Clear kept `member` while clearing the rest, because emptyFilters is
    // spread over the query and the key was simply missing (CodeRabbit).
    const { app } = await listingApp("staffer");
    const body = await get(app, "/samples?scope=all&member=program&place=Fallon");
    const clear = /href="([^"]*)"[^>]*>Clear all</.exec(body)?.[1] ?? "";
    expect(clear).not.toContain("member=");
    expect(clear).not.toContain("place=");
    // Scope survives: clearing is not signing out of an atlas.
    expect(clear).toContain("scope=all");
  });

  it("gives a volunteer the same two axes staff have", async () => {
    const { app } = await listingApp();
    const body = await get(app, "/samples?scope=outside&member=program");
    expect(body).toContain(`name="member"`);
    // Collected outside every atlas, by somebody who belongs to the program.
    expect(body).toContain("1 sample");
    expect(body).toContain("C-1");
  });

  it("remembers a staff member's chosen scope for the next visit", async () => {
    const { app } = await listingApp("staffer");
    const res = await app.request("/samples?scope=WaBA");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("beeline_scope=WaBA");
    const next = await app.request("/samples", { headers: { cookie: "beeline_scope=WaBA" } });
    expect(await next.text()).toContain("B-2");
  });

  it("searches sample numbers, collectors, and field numbers", async () => {
    const { app } = await listingApp("staffer");
    expect(await get(app, "/samples?scope=all&q=B-1")).toContain("1 sample");
    expect(await get(app, "/samples?scope=all&q=barnes")).toContain("3 samples");
    // An iNat login finds the same person the collector filter would.
    expect(await get(app, "/samples?scope=all&q=aadams")).toContain("3 samples");
    // A field number in hand: which sample is this specimen from?
    const byCatalog = await get(app, "/samples?scope=all&q=OBA00001");
    expect(byCatalog).toContain("1 sample");
    expect(byCatalog).toContain("A-1");
  });

  it("filters by date window, place, and QC state", async () => {
    const { app } = await listingApp("staffer");
    expect(await get(app, "/samples?scope=all&from=2026-01-01")).toContain("5 samples");
    expect(await get(app, "/samples?scope=all&to=2025-12-31")).toContain("1 sample");
    expect(await get(app, "/samples?scope=all&place=whatcom")).toContain("1 sample");
    // The county is stored bare and the state as its code, so a person's way
    // of writing a county must still find it (beeline-ky5e).
    for (const place of ["Whatcom, WA", "Whatcom county", "Whatcom Co.", "wa whatcom"]) {
      expect(await get(app, `/samples?scope=all&place=${encodeURIComponent(place)}`), place).toContain("1 sample");
      expect(await get(app, `/specimens?scope=all&place=${encodeURIComponent(place)}`), place).toContain("WABA0001");
    }
    // Every word must match: Whatcom is not in Nevada.
    expect(await get(app, "/samples?scope=all&place=Whatcom%2C%20NV")).toContain("No samples match");
    // A kind word alone is kept, not dropped into matching everything.
    expect(await get(app, "/samples?scope=all&place=county")).toContain("No samples match");
    expect(await get(app, "/samples?scope=all&qc=blocking")).toContain("1 sample");
    expect(await get(app, "/samples?scope=all&qc=clean")).toContain("5 samples");
  });

  // Every rule view emits NULL as specimen_id today, so nothing in the model
  // exercises the other route a finding can take. Standing in a specimen-keyed
  // definition for one rule is the cheapest way to prove the roll-up before a
  // real specimen-level rule lands (beeline-2c3.29) — qc_finding unions the
  // rule views by name, so replacing one is enough.
  async function flagSpecimen(conn: Awaited<ReturnType<typeof listingApp>>["conn"], catalog: string) {
    await conn.run(
      `CREATE OR REPLACE VIEW qc_rule_observation_missing_upstream AS
       SELECT CAST(NULL AS INTEGER) AS sample_id,
              sp.entity_id AS specimen_id,
              'observation_missing_upstream' AS rule_name,
              'stood in for a specimen-level rule' AS details
       FROM specimen sp WHERE sp.field_number = '${catalog}'`,
    );
  }

  it("counts a finding on a specimen as a flag on its sample", async () => {
    const { app, conn } = await listingApp("staffer");
    // A-1 is the clean sample; OBA00001 is one of its two specimens.
    expect(await get(app, "/samples?scope=all&qc=clean")).toContain("A-1");
    await flagSpecimen(conn, "OBA00001");

    // The chip and printability are the same question asked twice: a sample
    // whose specimen blocks must not read clean while printing is refused.
    const blocking = await get(app, "/samples?scope=all&qc=blocking");
    expect(blocking).toContain("A-1");
    expect(await get(app, "/samples?scope=all&qc=clean")).not.toContain("A-1");
    const printable = await rows(conn, `SELECT sample_id FROM printable_sample`);
    const blocked = await rows(conn, `SELECT sample_id FROM blocking_sample`);
    expect(blocked.flat()).not.toEqual([]);
    expect(printable.flat()).not.toContain(blocked.flat()[0]);
  });

  it("gives staff a collector filter, matching anyone on the sample", async () => {
    const { app } = await listingApp("staffer");
    // Bob numbered B-1; Alice collected it with him, so it is hers to find too.
    const alice = await get(app, "/samples?scope=all&collector=alice");
    expect(alice).toContain("A-1");
    expect(alice).toContain("B-1");
    expect(alice).not.toContain("B-2");
    // By surname: Bob's own two, and not the ones only Alice collected.
    expect(await get(app, "/samples?scope=all&collector=barnes")).toContain("3 samples");
    // Specimens take the same filter.
    expect(await get(app, "/specimens?scope=all&collector=adams")).toContain("OBA00001");
  });

  it("gives a volunteer the collector filter too", async () => {
    const { app } = await listingApp();
    expect(await get(app, "/samples?scope=all&collector=barnes")).toContain("3 samples");
    // Within their own, it finds what they collected with somebody.
    const together = await get(app, "/samples?collector=barnes");
    expect(together).toContain("1 sample");
    expect(together).toContain("B-1");
    expect(together).toContain(`name="collector"`);
  });

  it("filters by taxon, descending the taxonomy", async () => {
    const { app } = await listingApp("staffer");
    // The species itself, its genus, and its family all find the sample.
    for (const taxon of ["Bombus vosnesenskii", "Bombus", "Apidae"]) {
      const body = await get(app, `/samples?scope=all&taxon=${encodeURIComponent(taxon)}`);
      expect(body, taxon).toContain("A-1");
      expect(body, taxon).toContain("1 sample");
    }
    // A taxon nothing was determined as selects nothing, rather than everything.
    expect(await get(app, "/samples?scope=all&taxon=Megachile")).toContain("No samples match");
  });

  it("reads in the collector's own numbering within a day, not upload order", async () => {
    // A day's samples reach iNaturalist in whatever order they were
    // photographed; the collector numbered them 1, 2, 3 (Peter, 2026-08-23).
    const { app, conn, alice } = await listingApp();
    for (const n of ["3", "12", "9"]) {
      await conn.run(
        `INSERT INTO sample (kind, sample_number, date_start, date_end, specimen_count, country, state_province, county, locality, protocol)
         VALUES ('net', '${n}', DATE '2026-08-01', DATE '2026-08-01', 1, 'USA', 'OR', 'Benton', 'Corvallis', 'net')`,
      );
      await conn.run(
        `INSERT INTO sample_collector (sample_id, person_id, position)
         SELECT entity_id, ${alice}, 1 FROM sample WHERE sample_number = '${n}' AND date_start = DATE '2026-08-01'`,
      );
    }
    const body = await get(app, "/samples");
    // The number is a link to the sample's own page (beeline-2c3.34), so
    // match the link text rather than a bare cell.
    const order = ["12", "9", "3"].map((n) => body.indexOf(`>${n}</a>`));
    expect(order.every((i) => i >= 0)).toBe(true);
    // Descending, and 12 above 9 — length before text, so digits read as numbers.
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("says what is missing rather than showing an empty table", async () => {
    const { app } = await listingApp();
    expect(await get(app, "/samples?q=nothing-matches-this")).toContain("No samples match these filters");
  });
});

describe("specimen listing", () => {
  it("lists specimens from the signed-in person's samples, with their determinations", async () => {
    const { app } = await listingApp();
    const body = await get(app, "/specimens");
    expect(body).toContain("OBA00001");
    expect(body).toContain("WABA0001");
    expect(body).toContain("3 specimens");
    // Set by the component, not by eye: a species is italic, and a qualifier
    // sits before the epithet rather than after the name (/design/names).
    expect(body).toContain("<i>Bombus</i> cf. <i>vosnesenskii</i>");
    expect(body).toContain("B. Barnes");
    expect(body).toContain("not determined");
  });

  it("scopes to an atlas for staff, and to your own samples otherwise", async () => {
    const { app } = await listingApp("staffer");
    expect(await get(app, "/specimens")).toContain("Nothing here yet");
    const or = await get(app, "/specimens?scope=OBA");
    expect(or).toContain("OBA00002");
    expect(or).not.toContain("WABA0001");
  });

  it("filters on this specimen's determination, not its sample's", async () => {
    const { app } = await listingApp("staffer");
    const body = await get(app, "/specimens?scope=all&taxon=Bombus");
    expect(body).toContain("OBA00001");
    // Same sample, undetermined specimen — the taxon filter excludes it.
    expect(body).not.toContain("OBA00002");
  });
});

describe("what is still waiting for a name", () => {
  it("finds undetermined specimens, which a taxon name never can", async () => {
    const { app } = await listingApp("staffer");
    const undetermined = await get(app, "/specimens?scope=all&det=undetermined");
    expect(undetermined).toContain("OBA00002");
    expect(undetermined).not.toContain("OBA00001");
    expect(undetermined).toContain("1 specimen");

    const determined = await get(app, "/specimens?scope=all&det=determined");
    expect(determined).toContain("OBA00001");
    expect(determined).not.toContain("OBA00002");
  });

  it("on samples, means a sample with a specimen still waiting", async () => {
    const { app } = await listingApp("staffer");
    // A-1 has two specimens, one of them undetermined; B-1's only specimen is
    // determined; A-2 has no specimens at all, so it is neither.
    const waiting = await get(app, "/samples?scope=all&det=undetermined");
    expect(waiting).toContain("A-1");
    expect(waiting).not.toContain("B-1");
    const done = await get(app, "/samples?scope=all&det=determined");
    expect(done).toContain("B-1");
    expect(done).not.toContain("A-1");
    expect(done).toContain("1 sample");
  });

  it("finds everything carrying a flag, either severity", async () => {
    const { app } = await listingApp("staffer");
    // Where the dashboard sends a volunteer for their settled seasons.
    const flagged = await get(app, "/samples?scope=all&qc=flagged");
    expect(flagged).toContain("A-2");
    expect(flagged).toContain("1 sample");
  });
});

describe("seasons", () => {
  it("is where the dashboard's settled link lands: a date, since there is no season control", async () => {
    // The dashboard promises "older samples of yours that still carry flags";
    // this is that set, and nothing wider. The listing has no season filter
    // (Peter, 2026-09-16), so the link names the last day of the settled
    // seasons — the day before this one started.
    const { app, conn } = await listingApp();
    const [[through]] = (await rows(conn, "SELECT CAST(started_on - 1 AS TEXT) FROM season")) as [[string]];
    const body = await get(app, `/samples?qc=flagged&to=${through}`);
    expect(body).toContain("A-2");
    expect(body).toContain("1 sample");
  });
});

describe("sorting", () => {
  it("orders by a column in either direction, and says so in the heading", async () => {
    const { app } = await listingApp("staffer");
    const asc = await get(app, "/samples?scope=all&sort=place");
    // Anacortes, Bellingham, Corvallis, Fallon, Gerlach, then the one with no place.
    expect(asc.indexOf("Anacortes")).toBeLessThan(asc.indexOf("Corvallis"));
    expect(asc.indexOf("Gerlach")).toBeLessThan(asc.indexOf("A-2"));
    const desc = await get(app, "/samples?scope=all&sort=place&dir=desc");
    expect(desc.indexOf("Gerlach")).toBeLessThan(desc.indexOf("Anacortes"));
    // The heading says the direction, to a screen reader and to the eye.
    expect(desc).toContain(`<th aria-sort="descending">`);
    expect(asc).toContain(`<th aria-sort="ascending">`);
    // Exactly one column orders the table.
    expect(desc.match(/<th aria-sort=/g)).toHaveLength(1);
  });

  it("orders specimens by determination", async () => {
    const { app } = await listingApp("staffer");
    const body = await get(app, "/specimens?scope=all&sort=determination");
    expect(body.indexOf("Andrena")).toBeLessThan(body.indexOf("Bombus"));
    expect(body.indexOf("Bombus")).toBeLessThan(body.indexOf("not determined"));
  });

  it("keeps the sort while a filter is applied, and leaves the default out of the URL", () => {
    const query: ListingQuery = { ...EMPTY_QUERY, sort: "place", dir: "desc" };
    expect(listingHref("/samples", query, { place: "Corvallis" })).toBe("/samples?place=Corvallis&sort=place&dir=desc");
    // A column's own default direction stays implicit.
    expect(listingHref("/samples", { ...EMPTY_QUERY, sort: "place", dir: "asc" })).toBe("/samples?sort=place");
    expect(listingHref("/samples", { ...EMPTY_QUERY, dir: "asc" })).toBe("/samples?dir=asc");
  });
});

describe("the host plant column", () => {
  it("shows the floral host and filters on it", async () => {
    const { app, conn } = await listingApp("staffer");
    await conn.run(`UPDATE sample SET host_name_as_observed = 'Phacelia', host_rank = 'genus' WHERE sample_number = 'A-1'`);
    const body = await get(app, "/samples?scope=all&host=phac");
    expect(body).toContain("<i>Phacelia</i>");
    expect(body).toContain("1 sample");
    expect(body).toContain("Host plant: phac");
  });

  it("is on the specimens listing too, with the same filter", async () => {
    const { app, conn } = await listingApp("staffer");
    await conn.run(`UPDATE sample SET host_name_as_observed = 'Phacelia', host_rank = 'genus' WHERE sample_number = 'A-1'`);
    const body = await get(app, "/specimens?scope=all&host=phac");
    expect(body).toContain("<i>Phacelia</i>");
    expect(body).toContain("2 specimens");
    expect(body).toContain("Host plant: phac");
    // A bee off no flower: the dash, since the absence repeats down the column.
    const all = await get(app, "/specimens?scope=all");
    expect(all).toContain("WABA0001");
    expect(all).not.toMatch(/<td><\/td>/);
  });
});

describe("the method column", () => {
  it("says whether each sample was netted or trapped, and filters on it", async () => {
    const { app, conn } = await listingApp("staffer");
    await conn.run(`UPDATE sample SET kind = 'trap' WHERE sample_number = 'B-1'`);
    const all = await get(app, "/samples?scope=all");
    expect(all).toContain("<td>Trap</td>");
    expect(all).toContain("<td>Net</td>");
    const traps = await get(app, "/samples?scope=all&kind=trap");
    expect(traps).toContain("1 sample");
    expect(traps).toContain("B-1");
    expect(traps).toContain("Method: Trap");
    const nets = await get(app, "/samples?scope=all&kind=net");
    expect(nets).toContain("5 samples");
    expect(nets).not.toContain(">B-1<");
  });

  it("narrows specimens to the kind of sample they came from", async () => {
    const { app, conn } = await listingApp("staffer");
    await conn.run(`UPDATE sample SET kind = 'trap' WHERE sample_number = 'B-1'`);
    const body = await get(app, "/specimens?scope=all&kind=trap");
    expect(body).toContain("1 specimen");
    expect(body).toContain("WABA0001");
    expect(body).toContain("Method: Trap");
  });

  it("ignores a kind the store does not have", async () => {
    const { app } = await listingApp("staffer");
    expect(await get(app, "/samples?scope=all&kind=pan")).toContain("6 samples");
  });
});

describe("the determination date column", () => {
  it("shows when the determination of record was made, and orders by it", async () => {
    const { app, conn } = await listingApp("staffer");
    await conn.run(`UPDATE determination SET determined_on = DATE '2025-04-28' WHERE verbatim_identification = 'Bombus cf. vosnesenskii'`);
    const body = await get(app, "/specimens?scope=all");
    expect(body).toContain("Determined</");
    expect(body).toContain("Apr 28, 2025");
    // Newest determination first by default; undated and undetermined last.
    const sorted = await get(app, "/specimens?scope=all&sort=determined");
    expect(sorted.indexOf("OBA00001")).toBeLessThan(sorted.indexOf("WABA0001"));
    expect(sorted).toContain('aria-sort="descending"');
    const csv = await (await app.request("/specimens.csv?scope=all")).text();
    expect(csv.split("\n")[0]).toContain("identifiedBy,identifiedByID,dateIdentified");
    expect(csv).toContain(",2025-04-28,");

    // A year-only date is the year, on the page and in the file (beeline-9ut).
    await conn.run(`UPDATE determination SET determined_on_precision = 'year' WHERE verbatim_identification = 'Bombus cf. vosnesenskii'`);
    const yearly = await get(app, "/specimens?scope=all");
    expect(yearly).toContain(">2025<");
    expect(yearly).not.toContain("Apr 28, 2025");
    expect(await (await app.request("/specimens.csv?scope=all")).text()).toContain(",2025,");
  });
});

describe("missing values", () => {
  // Absence was drawn three ways — words, a bare em dash, an empty cell — and
  // an empty cell cannot be told from a value that failed to load (Nora,
  // 2026-09-17). Every value cell now draws something, through one component.
  const EMPTY_VALUE_CELL = /<td><\/td>|<td class="nowrap"><\/td>/;

  it("never leaves a value cell empty, on either listing", async () => {
    const { app, conn } = await listingApp("staffer");
    // Gaps everywhere they can be: no place at all, no host, no atlas.
    await conn.run(`UPDATE sample SET locality = NULL, county = NULL, state_province = NULL, country = NULL
                    WHERE sample_number = 'C-1'`);
    for (const path of ["/samples?scope=all", "/specimens?scope=all"]) {
      const body = await get(app, path);
      expect(body, path).not.toMatch(EMPTY_VALUE_CELL);
    }
  });

  it("spells out an absence that tells the reader something, and dashes one that repeats", async () => {
    const { app } = await listingApp("staffer");
    const samples = await get(app, "/samples?scope=all");
    // Outside every atlas is an answer, so it is written.
    expect(samples).toContain(`<span class="meta absent">outside</span>`);
    // No floral host repeats down the column: a dash, with its meaning read aloud.
    expect(samples).toContain(
      `<span class="meta absent"><span aria-hidden="true">—</span><span class="visually-hidden">none</span></span>`,
    );
    const specimens = await get(app, "/specimens?scope=all");
    expect(specimens).toContain(`<span class="meta absent">not determined</span>`);
  });
});

describe("the toolbar", () => {
  it("gives staff a three-way toggle: mine, my atlas, everything", async () => {
    const { app, conn, staffer } = await listingApp("staffer");
    await conn.run(
      `INSERT INTO person_membership (person_id, kind, atlas_id)
       VALUES (${staffer}, 'atlas', (SELECT entity_id FROM atlas WHERE code = 'WaBA'))`,
    );
    const body = await get(app, "/samples?scope=WaBA");
    expect(body).toContain(">My records</a>");
    expect(body).toContain(`aria-current="page">Washington Bee Atlas records</a>`);
    expect(body).toContain(">All records</a>");
  });

  it("is two-way for somebody with no atlas, and three-way for a volunteer who belongs to one", async () => {
    const toggle = (body: string) => /<nav class="segmented"[^>]*>(.*?)<\/nav>/s.exec(body)?.[1] ?? "";
    const staff = await listingApp("staffer");
    const body = toggle(await get(staff.app, "/samples?scope=all"));
    expect(body).toContain(">My records</a>");
    expect(body.match(/<a /g)).toHaveLength(2);
    // Bob belongs to Washington.
    const volunteer = toggle(await get((await listingApp("bob")).app, "/samples"));
    expect(volunteer).toContain(">Washington Bee Atlas records</a>");
    expect(volunteer.match(/<a /g)).toHaveLength(3);
  });

  it("shows the filters in force as pills, each dismissable", async () => {
    const { app } = await listingApp("staffer");
    const body = await get(app, "/samples?scope=all&place=Fallon&qc=clean");
    expect(body).toContain("Place: Fallon");
    expect(body).toContain("Flags: Clean");
    // A named group, so assistive technology announces what the pills are.
    expect(body).toContain(`<div class="active-filters" role="group" aria-label="Filters in force">`);
    // Dismissing one keeps the other.
    const remove = /href="([^"]*)"[^>]*aria-label="Remove the Place filter"/.exec(body)?.[1] ?? "";
    expect(remove).toContain("qc=clean");
    expect(remove).not.toContain("place=");
  });

  it("draws every column's menu the same way, through the one table component", async () => {
    // The menus had drifted: three different glyphs depending on sort state,
    // the commonest too small to read (Peter, 2026-09-17). Every menu now
    // wears the same chevron, and an order in force is a separate arrow.
    const CHEVRON = `d="m19.5 8.25-7.5 7.5-7.5-7.5"`;
    const { app, conn, staffer } = await listingApp("staffer");
    void conn;
    void staffer;
    for (const path of ["/samples?scope=all", "/specimens?scope=all", "/samples?scope=all&sort=place"]) {
      const body = await get(app, path);
      const menus = body.match(/<details class="menu col-menu">/g) ?? [];
      expect(menus.length, path).toBeGreaterThan(5);
      expect(body.match(new RegExp(CHEVRON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")), path).toHaveLength(menus.length);
      expect(body, path).not.toContain("▾");
      expect(body, path).not.toContain("col-sort");
    }
  });

  it("gives a column's filter a real Apply button, not a menu row", async () => {
    const { app } = await listingApp("staffer");
    const body = await get(app, "/samples?scope=all");
    // Filled, the default variant: inside a form with the class the menu
    // panel's row-flattening rule is scoped away from.
    expect(body).toMatch(/<form method="get" action="\/samples" class="col-filter">.*?<button type="submit">Apply<\/button><\/form>/s);
  });

  it("names each column's menu for what it holds", async () => {
    const { app } = await listingApp("staffer");
    const samples = await get(app, "/samples?scope=all");
    expect(samples).toContain(`aria-label="Sample: sort"`);
    expect(samples).toContain(`aria-label="Date: sort and filter"`);
    const specimens = await get(app, "/specimens?scope=all");
    expect(specimens).toContain(`aria-label="Determined by: sort"`);
    expect(specimens).not.toContain(`aria-label="Determined by: sort and filter"`);
  });

  it("carries the rest of the query through a column's filter form", async () => {
    const { app } = await listingApp("staffer");
    const body = await get(app, "/samples?scope=all&place=Fallon&sort=place&dir=desc");
    // The date column's form keeps place, sort and direction as hidden inputs...
    expect(body).toContain(`<input type="hidden" name="place" value="Fallon"/>`);
    expect(body).toContain(`<input type="hidden" name="sort" value="place"/>`);
    // ...and the search form keeps everything but the search itself.
    expect(body).toContain(`<input type="search" name="q" value=""`);
  });
});

describe("CSV export", () => {
  it("names the file for when it was taken, in Pacific time, sortable and without colons (GitHub #106)", () => {
    expect(exportFilename("beeline-samples", new Date("2026-09-28T21:05:07Z"))).toBe("beeline-samples-2026-09-28-140507.csv");
    // A UTC morning that is still the evening before in Oregon, and midnight as 00.
    expect(exportFilename("beeline-people", new Date("2026-01-03T03:00:09Z"))).toBe("beeline-people-2026-01-02-190009.csv");
    expect(exportFilename("beeline-specimens", new Date("2026-09-28T07:00:00Z"))).toBe("beeline-specimens-2026-09-28-000000.csv");
  });

  it("downloads the filtered rows, coordinates and provenance included", async () => {
    const { app } = await listingApp("staffer");
    const res = await app.request("/samples.csv?scope=all&place=whatcom");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    // Stamped, so two exports of one listing save as two files (GitHub #106).
    expect(res.headers.get("content-disposition")).toMatch(/filename="beeline-samples-\d{4}-\d{2}-\d{2}-\d{6}\.csv"/);
    // A byte order mark so Excel reads names as UTF-8 (text() strips it, so
    // it is read from the bytes), and Unix line endings.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes);
    expect(csv).not.toContain("\r");
    const [header, ...lines] = csv.split("\n").filter((l) => l !== "");
    // Darwin Core terms wherever one exists: the sample is the collecting
    // event, so its number is dwc:fieldNumber.
    expect(header!.split(",").slice(0, 4)).toEqual(["fieldNumber", "eventDate", "samplingProtocol", "recordedBy"]);
    // A collector's own coordinates are the ones they recorded and the ones
    // their labels print; withholding them protected nobody (Peter, 2026-08-23).
    expect(header).toContain("decimalLatitude,decimalLongitude,geodeticDatum,coordinateUncertaintyInMeters");
    // And a reader can tell what they are looking at without asking us.
    expect(header).toContain("locationSource");
    expect(header).toContain("geoprivacy");
    expect(lines).toHaveLength(1);
    // A longitude is a number, never a defused "formula" with an apostrophe in front.
    expect(lines[0]).toContain(",-123.");
    expect(lines[0]).not.toContain("'-");
    expect(lines[0]).toContain("B-1");
    expect(lines[0]).toContain("44.5646");
    expect(lines[0]).toContain("inat_public");
    // The export keeps the full names: recordedBy means the whole name, not
    // the abbreviation a label has room for.
    expect(lines[0]).toContain("Bob Barnes | Alice Adams");
  });

  it("exports specimens with their determination", async () => {
    const { app, conn } = await listingApp("staffer");
    // The museum's number for one of them, as Ecdysis reported it.
    await conn.run(
      `INSERT INTO specimen_catalog_number (specimen_id, catalog_number)
       SELECT entity_id, 'OSAC_9001' FROM specimen WHERE field_number = 'OBA00002'`,
    );
    const csv = await (await app.request("/specimens.csv?scope=OBA")).text();
    expect(csv).toContain("OBA00001");
    expect(csv).toContain("Bombus vosnesenskii");
    expect(csv).toContain("Radoszkowski, 1862");
    // How sure the determiner was, and the words they wrote — a downstream
    // consumer reading only scientific_name would read an assertion that was
    // never made (beeline-tgu).
    expect(csv.split("\n")[0]).toContain("identificationQualifier,verbatimIdentification");
    expect(csv).toContain("cf.,Bombus cf. vosnesenskii");
    // The pin's number is Beeline's, so it is fieldNumber; catalogNumber is
    // the museum's, empty until a museum has said, never derived (gh-98).
    // The sample number has a column of its own.
    const [header, ...records] = csv.split("\n");
    expect(header).toContain("occurrenceID,basisOfRecord,catalogNumber,fieldNumber");
    expect(header).toContain("dateIdentified,sampleNumber,specimenNumber,atlas");
    expect(csv).toContain("PreservedSpecimen,,OBA00001,");
    expect(csv).toContain("PreservedSpecimen,OSAC_9001,OBA00002,");
    expect(records.find((l) => l.includes(",OBA00001,"))).toContain(",A-1,1,OBA,");
  });

  it("writes the whole selection, a page at a time, with nothing in the file that is not a record", async () => {
    const offsets: number[] = [];
    const stream = csvStream(
      ["n"],
      async (limit, offset) => {
        offsets.push(offset);
        // A full page, then a short one: the short page is the last.
        const size = offset === 0 ? limit : 2;
        return { rows: Array.from({ length: size }, (_, i) => offset + i), total: limit + 2, collectors: new Map() };
      },
      (n: number) => [n],
    );
    const text = await new Response(stream).text();
    expect(offsets).toEqual([0, CSV_PAGE_SIZE]);
    const lines = text.split("\n"); // text() has already dropped the byte order mark
    expect(lines[0]).toBe("n");
    expect(lines.at(-1)).toBe(""); // every record ends in \n, the last included
    expect(lines).toHaveLength(1 + CSV_PAGE_SIZE + 2 + 1);
    expect(lines.at(-2)).toBe(String(CSV_PAGE_SIZE + 1));
  });

  it("ends a download that fails partway as an error, not as a quietly short file", async () => {
    const stream = csvStream(
      ["n"],
      async (limit, offset) => {
        if (offset > 0) throw new Error("store went away");
        return { rows: Array.from({ length: limit }, (_, i) => i), total: 0, collectors: new Map() };
      },
      (n: number) => [n],
    );
    await expect(new Response(stream).text()).rejects.toThrow();
  });

  it("reports once how long its pages spent in the store, and how the download ended", async () => {
    // The response has gone before any page is fetched, so this is the only
    // place a slow CSV can be seen (src/app/request-timing.ts).
    const heard: Array<[number, number, string]> = [];
    const timing = (ms: number, rows: number, outcome: string) => void heard.push([ms, rows, outcome]);
    const pages = (fail: boolean) => async (limit: number, offset: number) => {
      await new Promise((r) => setTimeout(r, 15));
      if (fail && offset > 0) throw new Error("store went away");
      return { rows: Array.from({ length: offset === 0 ? limit : 2 }, (_, i) => offset + i), total: 0, collectors: new Map() };
    };

    await new Response(csvStream(["n"], pages(false), (n: number) => [n], timing)).text();
    expect(heard).toHaveLength(1);
    expect(heard[0]![0]).toBeGreaterThanOrEqual(25); // two pages of at least 15ms each, less timer slack
    expect(heard[0]!.slice(1)).toEqual([CSV_PAGE_SIZE + 2, "complete"]);

    heard.length = 0;
    await expect(new Response(csvStream(["n"], pages(true), (n: number) => [n], timing)).text()).rejects.toThrow();
    expect(heard.map((h) => h.slice(1))).toEqual([[CSV_PAGE_SIZE, "failed"]]);

    // A row that will not convert ends the download as a failure too.
    heard.length = 0;
    const badRow = (n: number) => {
      if (n === 3) throw new Error("cannot write this row");
      return [n];
    };
    await expect(new Response(csvStream(["n"], pages(false), badRow, timing)).text()).rejects.toThrow();
    expect(heard.map((h) => h.slice(1))).toEqual([[0, "failed"]]);

    heard.length = 0;
    const reader = csvStream(["n"], pages(false), (n: number) => [n], timing).getReader();
    await reader.read(); // the header
    await reader.read(); // the first page
    await reader.cancel();
    expect(heard.map((h) => h.slice(1))).toEqual([[CSV_PAGE_SIZE, "cancelled"]]);

    // Cancelled while a page is still being fetched: reported once that page
    // settles, with its whole time counted.
    heard.length = 0;
    const slowPages = async (limit: number, offset: number) => {
      await new Promise((r) => setTimeout(r, 60));
      return { rows: Array.from({ length: limit }, (_, i) => offset + i), total: 0, collectors: new Map() };
    };
    const midway = csvStream(["n"], slowPages, (n: number) => [n], timing).getReader();
    await midway.read(); // the header
    const pending = midway.read(); // starts fetching the first page
    await new Promise((r) => setTimeout(r, 10));
    await midway.cancel();
    await pending.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 80));
    expect(heard).toHaveLength(1);
    expect(heard[0]![2]).toBe("cancelled");
    expect(heard[0]![0]).toBeGreaterThanOrEqual(50);
  });

  it("quotes what must be quoted and defuses formulas, but never a number", async () => {
    const csv = toCsv(["a", "b", "c", "d"], [[`say "hi", now`, "=SUM(A1:A2)", -123.262, "-45.1"]]);
    expect(csv).toBe(`\uFEFFa,b,c,d\n"say ""hi"", now",'=SUM(A1:A2),-123.262,-45.1\n`);
    expect(csvCell("-Ada")).toBe("'-Ada");
    // A tab or carriage return in front is a formula trigger too.
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
    expect(csvCell("\r=1+1")).toBe(`"'\r=1+1"`);
  });
});

describe("Darwin Core archives, by program and year", () => {
  /** The archive's files by name, as text. */
  const unpack = (bytes: Uint8Array) =>
    Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, data]) => [name, strFromU8(data)]));
  const table = (text: string) => text.split("\n").filter((l) => l !== "").map((l) => l.split("\t"));

  const LICENSES_HEADER = "program,from_year,license,decided_by,decided_on,source,reason";
  const POLICIES_HEADER = "program,from_year,url,decided_by,decided_on,reason";

  /** A scratch exports directory and decision files, written as a test says. */
  async function exportsFixture(licenses: string[], policies: string[]) {
    const dir = await mkdtemp(join(tmpdir(), "beeline-dwca-"));
    const governance = { licenses: join(dir, "licenses.csv"), policies: join(dir, "policies.csv") };
    const write = async (l: string[], p: string[]) => {
      await writeFile(governance.licenses, [LICENSES_HEADER, ...l].join("\n") + "\n");
      await writeFile(governance.policies, [POLICIES_HEADER, ...p].join("\n") + "\n");
    };
    await write(licenses, policies);
    return { dir, governance, write };
  }
  const OBA_LICENSE = "OBA,2017,CC-BY-NC-4.0,Test,2026-10-10,https://example.org/oba,Published under it";
  const OBA_POLICY = "OBA,2026,https://example.org/oba-privacy,Test,2026-10-10,Agreed";

  it("writes a year with its licence, and every determination", async () => {
    const fx = await exportsFixture([OBA_LICENSE], [OBA_POLICY]);
    const { app, db, conn } = await listingApp("staffer", { dir: fx.dir, governance: fx.governance });
    // A later volunteer determination of OBA00001, beside the expert one the
    // CSV shows; a tab in what they wrote must not split the row.
    await conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_name,
                                  verbatim_identification, sex, recorded_at)
       SELECT sp.entity_id, an.entity_id, false, 'in_app', 'A Volunteer', 'Bombus\tsp.', 'female', now() + INTERVAL 1 DAY
       FROM specimen sp, animal an
       WHERE sp.field_number = 'OBA00001' AND an.scientific_name = 'Bombus'`,
    );
    const manifest = await writeProgramArchives(db, fx.dir, { governance: fx.governance });
    const oba = manifest.entries.find((e) => e.program === "OBA" && e.year === 2026)!;
    expect(oba).toMatchObject({ specimens: 2, license: "CC-BY-NC-4.0", policy: true, file: "OBA-2026.zip" });
    // Washington has specimens and no licence: written all the same, for review.
    expect(manifest.entries.find((e) => e.program === "WaBA")).toMatchObject({ license: null, file: `WaBA-${OPEN_SEASON}.zip` });

    const res = await app.request("/exports/dwca/OBA-2026.zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain(`filename="beeline-OBA-2026-dwca.zip"`);
    const files = unpack(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files)).toEqual(["meta.xml", "occurrence.txt", "identification.txt"]);

    // meta.xml declares a Darwin Core term for each Darwin Core column, at
    // the index the file holds it, and the licence as a constant.
    const meta = files["meta.xml"]!;
    const [header, ...occurrences] = table(files["occurrence.txt"]!);
    expect(meta).toContain(`rowType="http://rs.tdwg.org/dwc/terms/Occurrence"`);
    expect(meta).toContain(`rowType="http://rs.tdwg.org/dwc/terms/Identification"`);
    for (const term of ["occurrenceID", "catalogNumber", "fieldNumber", "decimalLatitude", "scientificName", "dateIdentified"]) {
      expect(meta).toContain(`<field index="${header!.indexOf(term)}" term="http://rs.tdwg.org/dwc/terms/${term}"/>`);
    }
    expect(meta).toContain(
      `<field default="http://creativecommons.org/licenses/by-nc/4.0/legalcode" term="http://purl.org/dc/terms/license"/>`,
    );
    // Beeline's own columns are in the file and declared as nothing.
    expect(header).toContain("geoprivacy");
    expect(meta).not.toContain("terms/geoprivacy");

    // OBA's two specimens, and nothing of Washington's. Neither has a
    // museum's catalog number yet, so that column is empty (gh-98).
    const field = header!.indexOf("fieldNumber");
    expect(occurrences.map((r) => r[field]).sort()).toEqual(["OBA00001", "OBA00002"]);
    expect(occurrences.map((r) => r[header!.indexOf("catalogNumber")])).toEqual(["", ""]);
    const oba1 = occurrences.find((r) => r[field] === "OBA00001")!;
    expect(oba1[header!.indexOf("scientificName")]).toBe("Bombus vosnesenskii");

    // Both determinations of OBA00001, oldest first, joined by the core's id;
    // OBA00002 has none and so no rows.
    const [identHeader, ...identifications] = table(files["identification.txt"]!);
    expect(identHeader!.slice(0, 2)).toEqual(["coreid", "scientificName"]);
    expect(identifications.every((r) => r.length === identHeader!.length)).toBe(true);
    expect(identifications.map((r) => r[0])).toEqual([oba1[0], oba1[0]]);
    const col = (name: string) => identHeader!.indexOf(name);
    expect(identifications.map((r) => r[col("scientificName")])).toEqual(["Bombus vosnesenskii", "Bombus"]);
    expect(identifications.map((r) => r[col("verbatimIdentification")])).toEqual([
      "Bombus cf. vosnesenskii",
      "Bombus sp.",
    ]);
    // The expert's is current even though the volunteer's came later, said as
    // Symbiota reads it: its own term, 1 or 0.
    expect(identifications.map((r) => r[col("identificationIsCurrent")])).toEqual(["1", "0"]);
    expect(meta).toContain(
      `<field index="${col("identificationIsCurrent")}" term="https://symbiota.org/terms/identificationIsCurrent"/>`,
    );
    // Each determination keeps its own sex, which the core holds only for the record.
    expect(identifications.map((r) => r[col("sex")])).toEqual(["", "female"]);
    expect(meta).not.toContain("terms/caste");
  });

  it("writes a year with no licence or privacy policy for review, and says what publishing it lacks", async () => {
    const fx = await exportsFixture([], []);
    const { app, db } = await listingApp("staffer", { dir: fx.dir, governance: fx.governance });
    const manifest = await writeProgramArchives(db, fx.dir, { governance: fx.governance });
    expect(manifest.entries.find((e) => e.program === "OBA" && e.year === 2026)).toMatchObject({
      license: null,
      policy: false,
      file: "OBA-2026.zip",
    });
    const res = await app.request("/exports/dwca/OBA-2026.zip");
    expect(res.status).toBe(200);
    // No licence is in force, so the archive states none.
    expect(unpack(new Uint8Array(await res.arrayBuffer()))["meta.xml"]).not.toContain("dc/terms/license");
    const page = await get(app, "/exports");
    expect(page).toContain("no licence");
    expect(page).toContain("none yet");
    expect(page).toContain(`href="/exports/dwca/OBA-2026.zip"`);
    expect(page).toContain(`href="/exports/dwca/WaBA-${OPEN_SEASON}.zip"`);
    expect(page).not.toContain("This file states");

    // A licence merged after the night's run shows at once, and the row says
    // the file beside it does not carry it yet.
    await fx.write([OBA_LICENSE], []);
    const after = await get(app, "/exports");
    expect(after).toContain("CC BY-NC 4.0");
    expect(after).toContain("This file states no licence; it is rewritten with this one tonight.");
    await writeProgramArchives(db, fx.dir, { governance: fx.governance });
    expect(await get(app, "/exports")).not.toContain("This file states");
  });

  it("files a sample by the calendar year it was collected in, not by the season", async () => {
    const fx = await exportsFixture([OBA_LICENSE], [OBA_POLICY]);
    const { app, db, conn, alice } = await listingApp("staffer", { dir: fx.dir, governance: fx.governance });
    // Emptied in February 2026: the 2025 season by Beeline's 1 March line,
    // and 2026 to a taxonomist.
    const feb = await insertCleanSample(conn, {
      collector_id: String(alice),
      atlas_id: "(SELECT entity_id FROM atlas WHERE code = 'OBA')",
      sample_number: "'A-3'",
      specimen_count: "1",
      date_start: "DATE '2026-02-10'",
      date_end: "DATE '2026-02-10'",
    });
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${feb}, 1, 'OBA00003')`);
    expect(await rows(conn, `SELECT season FROM sample_season WHERE sample_id = ${feb}`)).toEqual([[2025]]);

    const manifest = await writeProgramArchives(db, fx.dir, { governance: fx.governance });
    expect(manifest.entries.filter((e) => e.program === "OBA").map((e) => [e.year, e.specimens])).toEqual([[2026, 3]]);
    const files = unpack(new Uint8Array(await (await app.request("/exports/dwca/OBA-2026.zip")).arrayBuffer()));
    const [header, ...occurrences] = table(files["occurrence.txt"]!);
    expect(occurrences.map((r) => r[header!.indexOf("fieldNumber")]).sort()).toEqual(["OBA00001", "OBA00002", "OBA00003"]);
  });

  it("removes an archive whose year no longer has specimens, and never serves a file the manifest does not name", async () => {
    const fx = await exportsFixture([OBA_LICENSE], [OBA_POLICY]);
    const { app, db } = await listingApp("staffer", { dir: fx.dir, governance: fx.governance });
    await writeProgramArchives(db, fx.dir, { governance: fx.governance });
    // As a year whose specimens have all gone would leave it.
    await writeFile(join(fx.dir, "dwca", "OBA-2019.zip"), "stale");
    expect((await app.request("/exports/dwca/OBA-2019.zip")).status).toBe(404);
    await writeProgramArchives(db, fx.dir, { governance: fx.governance });
    expect(await readdir(join(fx.dir, "dwca"))).not.toContain("OBA-2019.zip");
  });

  it("lists every program by year, Master Melittology's included, and none for the BLM surveys", async () => {
    const fx = await exportsFixture([OBA_LICENSE], [OBA_POLICY]);
    const { app, db } = await listingApp("staffer", { dir: fx.dir, governance: fx.governance });
    // Before the first run the page says when they appear.
    expect(await get(app, "/exports")).toContain("Not written yet");
    await writeProgramArchives(db, fx.dir, { governance: fx.governance });
    const page = await get(app, "/exports");
    expect(page).toContain(`href="/exports/dwca/OBA-2026.zip"`);
    expect(page).toContain(`aria-label="Download the Oregon Bee Atlas archive for 2026"`);
    expect(page).toContain(`href="https://example.org/oba-privacy"`);
    expect(page).toContain("Washington Bee Atlas");
    expect(page).toContain("Master Melittology");
    expect(page).toContain("BLM surveys");
    expect(page).toContain("belong to them by the day they were collected on");
    // And says what it is for, and what it is not.
    expect(page).toContain("Do not upload them");
    expect(await get(app, "/specimens?scope=OBA")).not.toContain(".zip");
  });

  it("is refused to a volunteer, and an archive nobody wrote is not found", async () => {
    const fx = await exportsFixture([OBA_LICENSE], [OBA_POLICY]);
    const { app: volunteer, db } = await listingApp("alice", { dir: fx.dir, governance: fx.governance });
    await writeProgramArchives(db, fx.dir, { governance: fx.governance });
    expect((await volunteer.request("/exports/dwca/OBA-2026.zip")).status).toBe(403);
    const { app: staff } = await listingApp("staffer", { dir: fx.dir, governance: fx.governance });
    expect((await staff.request("/exports/dwca/OBA-2025.zip")).status).toBe(404);
    expect((await staff.request("/exports/dwca/WaBA-2019.zip")).status).toBe(404);
    expect((await staff.request("/exports/dwca/manifest.json")).status).toBe(404);
  });

  it("holds every page's identifications until the core is written", async () => {
    // Synthetic rows, a page and one more: the second file's data is written
    // while the first is still open, and must come out whole after it.
    const specimen = (i: number) =>
      ({ specimen_id: i, sample_id: 1, date_start: "2026-07-14", date_end: "2026-07-14", latitude: null, host_name: null }) as unknown as SpecimenRow;
    const pages = [
      Array.from({ length: CSV_PAGE_SIZE }, (_, i) => specimen(i + 1)),
      [specimen(CSV_PAGE_SIZE + 1)],
    ];
    const ident = (id: number): IdentificationRow => ({
      specimen_id: id,
      scientific_name: "Bombus",
      authorship: null,
      rank: "genus",
      qualifier: null,
      verbatim_identification: null,
      determiner: null,
      determiner_orcid: null,
      determined_on: null,
      determined_on_precision: null,
      sex: null,
      caste: null,
      is_expert: false,
      of_record: true,
    });
    const stream = specimenArchiveStream(async (_limit, offset) => {
      const rows = pages[offset === 0 ? 0 : 1]!;
      return { rows, total: 0, collectors: new Map(), identifications: rows.map((r) => ident(r.specimen_id)) };
    });
    const files = unpack(new Uint8Array(await new Response(stream).arrayBuffer()));
    expect(table(files["occurrence.txt"]!)).toHaveLength(1 + CSV_PAGE_SIZE + 1);
    const identifications = table(files["identification.txt"]!);
    expect(identifications).toHaveLength(1 + CSV_PAGE_SIZE + 1);
    expect(identifications.at(-1)![0]).toBe(String(CSV_PAGE_SIZE + 1));
  });
});

describe("a location iNaturalist keeps from everyone but its observer, on the listings", () => {
  /** Bob's B-2, Bob alone, made obscured (or private) on iNaturalist by Bob. */
  async function protectedApp(signedInAs: "alice" | "bob" | "staffer", geoprivacy = "obscured") {
    const fx = await listingApp(signedInAs);
    await fx.conn.run(`UPDATE sample SET geoprivacy = '${geoprivacy}' WHERE sample_number = 'B-2'`);
    return fx;
  }
  const rowOf = (body: string, sample: string) =>
    new RegExp(`<tr><td><a href="/samples/\\d+" class="pill">${sample}</a>.*?</tr>`, "s").exec(body)?.[0] ?? "";

  it("withholds another volunteer's locality, keeping the county and state, and says so", async () => {
    const { app } = await protectedApp("alice");
    const row = rowOf(await get(app, "/samples?scope=all"), "B-2");
    expect(row).not.toBe("");
    expect(row).not.toContain("Anacortes");
    expect(row).toContain("BentonCo, WA");
    expect(row).toContain(en.listings.locationHidden);
  });

  it("withholds the county too where the observation is private", async () => {
    const { app } = await protectedApp("alice", "private");
    const row = rowOf(await get(app, "/samples?scope=all"), "B-2");
    expect(row).not.toContain("BentonCo");
    expect(row).toContain("WA");
  });

  it("cannot be found by the place it withholds", async () => {
    // The filter reads what the row shows, or a search for the trailhead
    // would say which sample was collected there.
    const { app } = await protectedApp("alice");
    expect(await get(app, "/samples?scope=all&place=Anacortes")).not.toContain("B-2");
    expect(await get(app, "/specimens?scope=all&place=Anacortes")).not.toContain("B-2");
    const staff = await protectedApp("staffer");
    expect(await get(staff.app, "/samples?scope=all&place=Anacortes")).toContain("B-2");
  });

  it("is left out of the download, coordinates and all", async () => {
    const { app } = await protectedApp("alice");
    const csv = await (await app.request("/samples.csv?scope=all")).text();
    const lines = csv.replace(/^\uFEFF/, "").split("\n");
    const header = lines[0]!.split(",");
    const b2 = lines.find((l) => l.startsWith("B-2,"))!.split(",");
    expect(b2[header.indexOf("locality")]).toBe("");
    expect(b2[header.indexOf("decimalLatitude")]).toBe("");
    expect(b2[header.indexOf("decimalLongitude")]).toBe("");
    expect(b2[header.indexOf("geoprivacy")]).toBe("obscured");
    // Unprotected records keep theirs.
    const b1 = lines.find((l) => l.startsWith("B-1,"))!.split(",");
    expect(b1[header.indexOf("decimalLatitude")]).not.toBe("");
  });

  it("is left out of the specimens download and listing too", async () => {
    const { app, conn } = await listingApp("bob");
    // Alice's A-1, with its two specimens, made obscured by Alice.
    await conn.run(`UPDATE sample SET geoprivacy = 'obscured' WHERE sample_number = 'A-1'`);
    const csv = await (await app.request("/specimens.csv?scope=all")).text();
    const lines = csv.replace(/^\uFEFF/, "").split("\n");
    const header = lines[0]!.split(",");
    const fieldNumber = header.indexOf("fieldNumber");
    const oba1 = lines.map((l) => l.split(",")).find((r) => r[fieldNumber] === "OBA00001")!;
    expect(oba1[header.indexOf("locality")]).toBe("");
    expect(oba1[header.indexOf("decimalLatitude")]).toBe("");
    expect(oba1[header.indexOf("minimumElevationInMeters")] ?? "").toBe("");
    const listing = await get(app, "/specimens?scope=all");
    expect(listing).not.toContain("Corvallis");
    expect(listing).toContain(en.listings.locationHidden);
  });

  it("is shown to its collector and to staff", async () => {
    for (const who of ["bob", "staffer"] as const) {
      const { app } = await protectedApp(who);
      const row = rowOf(await get(app, "/samples?scope=all"), "B-2");
      expect(row, who).toContain("Anacortes");
      expect(row, who).not.toContain(en.listings.locationHidden);
    }
  });

  it("is shown to a co-collector, who was there", async () => {
    // B-1 is Bob's numbering with Alice at position 2 (beeline-77j).
    const { app, conn } = await listingApp("alice");
    await conn.run(`UPDATE sample SET taxon_geoprivacy = 'obscured' WHERE sample_number = 'B-1'`);
    expect(rowOf(await get(app, "/samples?scope=all"), "B-1")).toContain("Bellingham");
  });
});

describe("listing queries", () => {
  const parse = (search: string) => parseListingQuery(new URLSearchParams(search), { atlasCodes: ["OBA", "WaBA"] });

  it("opens every scope to everyone, and starts at mine", () => {
    expect(parse("").scope).toBe("mine");
    expect(parse("scope=all").scope).toBe("all");
    expect(parse("scope=OBA").scope).toBe("OBA");
    expect(parse("scope=outside").scope).toBe("outside");
    expect(parse("collector=bob&member=WaBA")).toMatchObject({ collector: "bob", member: "WaBA" });
    // An atlas that doesn't exist is not a scope.
    expect(parse("scope=ZZ").scope).toBe("mine");
  });

  it("ignores junk rather than failing on it", () => {
    const q = parse("from=yesterday&to=2026-13-99&qc=whatever&page=-3");
    expect(q.from).toBeNull();
    expect(q.to).toBeNull();
    expect(q.qc).toBe("any");
    expect(q.page).toBe(1);
  });

  it("round-trips through the URL, leaving defaults out of it", () => {
    const query: ListingQuery = { ...EMPTY_QUERY, scope: "OBA", taxon: "Bombus", page: 3 };
    const href = listingHref("/samples", query);
    expect(href).toBe("/samples?scope=OBA&taxon=Bombus&page=3");
    expect(listingHref("/samples", EMPTY_QUERY)).toBe("/samples");
    const [, search] = href.split("?");
    expect(parse(search!)).toEqual(query);
  });

  it("names mine when a caller asks for it, because scope has no single default", () => {
    // MINE is the default for a volunteer and NOT for staff: parseListingQuery
    // falls back to the remembered scope cookie, so a link that leaves scope
    // out resolves to whatever that person last browsed. The QC home's "1
    // older sample of yours ... Show them" therefore went to everybody's
    // (beeline-3kl).
    expect(listingHref("/samples", EMPTY_QUERY, { scope: MINE, qc: "flagged", to: "2026-02-28" })).toBe(
      "/samples?scope=mine&to=2026-02-28&qc=flagged",
    );
    // The round trip is the property that actually matters: what the link
    // says has to survive a staff member whose cookie says otherwise.
    const preferred = parseListingQuery(new URLSearchParams("scope=mine&to=2026-02-28&qc=flagged"), {
      atlasCodes: ["OBA", "WaBA"],
      preferred: "all",
    });
    expect(preferred.scope).toBe(MINE);
    // Without the scope named, the same cookie wins — which is correct for a
    // bare listing and is exactly why the link has to name it.
    expect(
      parseListingQuery(new URLSearchParams("to=2026-02-28&qc=flagged"), {
        atlasCodes: ["OBA", "WaBA"],
        preferred: "all",
      }).scope,
    ).toBe("all");
  });

  it("counts everything the filters select, not just the page", async () => {
    const { db, alice } = await listingApp();
    const page = await listSamples(db, { ...EMPTY_QUERY }, alice, { staff: false, personIds: [alice] }, { limit: 2, offset: 0 });
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(3);
    const second = await listSamples(db, { ...EMPTY_QUERY }, alice, { staff: false, personIds: [alice] }, { limit: 2, offset: 2 });
    expect(second.rows).toHaveLength(1);
  });
});
