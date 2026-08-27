import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import {
  CSV_ROW_LIMIT,
  EMPTY_QUERY,
  listSamples,
  listingHref,
  parseListingQuery,
  toCsv,
  type ListingQuery,
} from "../src/app/listings.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

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
async function listingApp(signedInAs: "alice" | "bob" | "staffer" = "alice") {
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
    db,
    // Sandbox, not development: development makes everyone an admin, which
    // is exactly what these tests need to tell apart (beeline-6va).
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: people[signedInAs], login: signedInAs, iconUrl: null }),
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

  it("offers a volunteer no way out of their own records", async () => {
    const { app } = await listingApp();
    // No scope control at all…
    expect(await get(app, "/samples")).not.toContain(`name="scope"`);
    // …and typing one changes nothing.
    const forced = await get(app, "/samples?scope=all");
    expect(forced).not.toContain("B-2");
    expect(forced).toContain("3 samples");
  });

  it("lets staff scope to an atlas, or to all of them", async () => {
    const { app } = await listingApp("staffer");
    // Sam collects nothing: their own listing is empty, not everyone's.
    expect(await get(app, "/samples")).toContain("None of your collecting has reached Beeline yet");

    const wa = await get(app, "/samples?scope=WaBA");
    expect(wa).toContain("B-1");
    expect(wa).toContain("B-2");
    expect(wa).not.toContain("A-1");
    expect(wa).toContain("Staff view: the Washington Bee Atlas");

    const all = await get(app, "/samples?scope=all");
    expect(all).toContain("6 samples");
    expect(all).toContain("Staff view: every atlas");
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
    expect(outside).toContain("Staff view: everywhere no member atlas reaches");
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
    const clear = /href="([^"]*)"[^>]*>Clear</.exec(body)?.[1] ?? "";
    expect(clear).not.toContain("member=");
    expect(clear).not.toContain("place=");
    // Scope survives: clearing is not signing out of an atlas.
    expect(clear).toContain("scope=all");
  });

  it("gives a volunteer neither control, and ignores them when typed", async () => {
    const { app } = await listingApp();
    const body = await get(app, "/samples?scope=outside&member=program");
    expect(body).not.toContain(`name="member"`);
    expect(body).toContain("3 samples"); // still only Alice's own
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

  it("keeps the collector filter to staff", async () => {
    const { app } = await listingApp();
    const body = await get(app, "/samples?collector=barnes");
    // A volunteer's listing is already one collector's: the parameter is
    // dropped rather than obeyed, so this is still Alice's three samples.
    expect(body).toContain("3 samples");
    expect(body).not.toContain(`name="collector"`);
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
        `INSERT INTO sample (kind, collector_id, sample_number, date_start, date_end, specimen_count, country, state_province, county, locality, protocol)
         VALUES ('net', ${alice}, '${n}', DATE '2026-08-01', DATE '2026-08-01', 1, 'USA', 'OR', 'Benton', 'Corvallis', 'net')`,
      );
      await conn.run(
        `INSERT INTO sample_collector (sample_id, person_id, position)
         SELECT entity_id, ${alice}, 1 FROM sample WHERE sample_number = '${n}' AND date_start = DATE '2026-08-01'`,
      );
    }
    const body = await get(app, "/samples");
    const order = ["12", "9", "3"].map((n) => body.indexOf(`<td>${n}</td>`));
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
  it("filters to earlier seasons, or to the open one", async () => {
    const { app } = await listingApp("staffer");
    // A-2 is dated 2025; everything else is this season (beeline-2c3.24).
    const settled = await get(app, "/samples?scope=all&season=settled");
    expect(settled).toContain("A-2");
    expect(settled).not.toContain("A-1");
    expect(settled).toContain("1 sample");

    const open = await get(app, "/samples?scope=all&season=open");
    expect(open).toContain("A-1");
    expect(open).not.toContain("A-2");
  });

  it("is where the dashboard's settled link lands", async () => {
    // The dashboard promises "older samples of yours that still carry flags";
    // this is that set, and nothing wider.
    const { app } = await listingApp();
    const body = await get(app, "/samples?qc=flagged&season=settled");
    expect(body).toContain("A-2");
    expect(body).toContain("1 sample");
  });
});

describe("CSV export", () => {
  it("downloads the filtered rows, coordinates and provenance included", async () => {
    const { app } = await listingApp("staffer");
    const res = await app.request("/samples.csv?scope=all&place=whatcom");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("beeline-samples.csv");
    const csv = await res.text();
    const [header, ...lines] = csv.split("\r\n");
    // A collector's own coordinates are the ones they recorded and the ones
    // their labels print; withholding them protected nobody (Peter, 2026-08-23).
    expect(header).toContain("latitude");
    expect(header).toContain("longitude");
    // And a reader can tell what they are looking at without asking us.
    expect(header).toContain("location_source");
    expect(header).toContain("geoprivacy");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("B-1");
    expect(lines[0]).toContain("44.5646");
    expect(lines[0]).toContain("inat_public");
    // The export keeps the full names: recordedBy means the whole name, not
    // the abbreviation a label has room for.
    expect(lines[0]).toContain("Bob Barnes | Alice Adams");
  });

  it("exports specimens with their determination", async () => {
    const { app } = await listingApp("staffer");
    const csv = await (await app.request("/specimens.csv?scope=OBA")).text();
    expect(csv).toContain("OBA00001");
    expect(csv).toContain("Bombus vosnesenskii");
    expect(csv).toContain("Radoszkowski, 1862");
    // How sure the determiner was, and the words they wrote — a downstream
    // consumer reading only scientific_name would read an assertion that was
    // never made (beeline-tgu).
    expect(csv.split("\r\n")[0]).toContain("identification_qualifier,verbatim_identification");
    expect(csv).toContain("cf.,Bombus cf. vosnesenskii");
  });

  it("says so inside the file when it stopped short", async () => {
    // The page's warning does not travel with a bookmarked download.
    const rows = Array.from({ length: CSV_ROW_LIMIT }, (_, i) => [i]);
    const csv = toCsv(["n"], rows);
    expect(csv.split("\r\n").at(-1)).toContain(`truncated at ${CSV_ROW_LIMIT} rows`);
    expect(toCsv(["n"], [[1]]).split("\r\n")).toHaveLength(2);
  });

  it("quotes what must be quoted and defuses formulas", async () => {
    const csv = toCsv(["a", "b"], [[`say "hi", now`, "=SUM(A1:A2)"]]);
    expect(csv).toBe(`a,b\r\n"say ""hi"", now",'=SUM(A1:A2)`);
  });
});

describe("listing queries", () => {
  const parse = (search: string, admin: boolean) =>
    parseListingQuery(new URLSearchParams(search), { admin, atlasCodes: ["OBA", "WaBA"] });

  it("gives a volunteer exactly one scope, whatever they ask for", () => {
    expect(parse("scope=all", false).scope).toBe("mine");
    expect(parse("scope=OBA", false).scope).toBe("mine");
    expect(parse("", true).scope).toBe("mine");
    expect(parse("scope=OBA", true).scope).toBe("OBA");
    // An atlas that doesn't exist is not a scope.
    expect(parse("scope=ZZ", true).scope).toBe("mine");
  });

  it("ignores junk rather than failing on it", () => {
    const q = parse("from=yesterday&to=2026-13-99&qc=whatever&page=-3", true);
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
    expect(parse(search!, true)).toEqual(query);
  });

  it("counts everything the filters select, not just the page", async () => {
    const { db, alice } = await listingApp();
    const page = await listSamples(db, { ...EMPTY_QUERY }, alice, { limit: 2, offset: 0 });
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(3);
    const second = await listSamples(db, { ...EMPTY_QUERY }, alice, { limit: 2, offset: 2 });
    expect(second.rows).toHaveLength(1);
  });
});
