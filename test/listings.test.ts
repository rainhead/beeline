import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import {
  EMPTY_QUERY,
  listSamples,
  listingHref,
  parseListingQuery,
  toCsv,
  type ListingQuery,
} from "../src/app/listings.js";
import { createMemoryDb, insertCleanSample } from "./helpers.js";

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const person = async (conn: Awaited<ReturnType<typeof createMemoryDb>>["conn"], name: string) => {
  const [[id]] = (await (
    await conn.run(`INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)
  ).getRows()) as [[number]];
  return id;
};

/**
 * Two collectors in two atlases, with specimens and determinations: enough
 * for every scope, filter, and column the listings have.
 */
async function listingApp(signedInAs: "alice" | "bob" | "staffer" = "alice") {
  const { instance, conn } = await createMemoryDb();
  const alice = await person(conn, "Alice Adams");
  const bob = await person(conn, "Bob Barnes");
  const staffer = await person(conn, "Sam Staff");

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
    `INSERT INTO specimen (sample_id, specimen_number, catalog_number)
     VALUES (${a1}, 1, 'OBA00001'), (${a1}, 2, 'OBA00002'), (${b1}, 1, 'WABA0001')`,
  );
  await conn.run(
    `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_id)
     SELECT sp.entity_id, an.entity_id, true, 'legacy_import', ${bob}
     FROM specimen sp, animal an
     WHERE sp.catalog_number = 'OBA00001' AND an.scientific_name = 'Bombus vosnesenskii'`,
  );
  await conn.run(
    `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_name)
     SELECT sp.entity_id, an.entity_id, false, 'legacy_import', 'A Volunteer'
     FROM specimen sp, animal an
     WHERE sp.catalog_number = 'WABA0001' AND an.scientific_name = 'Andrena'`,
  );

  const people = { alice, bob, staffer };
  const db = createKysely(instance);
  const app = createApp({
    db,
    // Sandbox, not development: development makes everyone an admin, which
    // is exactly what these tests need to tell apart (beeline-6va).
    config: { environment: "sandbox" as const, origin: "http://localhost:3054", adminLogins: ["staffer"] },
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
    expect(body).toContain("Bob Barnes");
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
    expect(all).toContain("4 samples");
    expect(all).toContain("Staff view: every atlas");
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
    expect(await get(app, "/samples?scope=all&q=barnes")).toContain("2 samples");
    // A field number in hand: which sample is this specimen from?
    const byCatalog = await get(app, "/samples?scope=all&q=OBA00001");
    expect(byCatalog).toContain("1 sample");
    expect(byCatalog).toContain("A-1");
  });

  it("filters by date window, place, and QC state", async () => {
    const { app } = await listingApp("staffer");
    expect(await get(app, "/samples?scope=all&from=2026-01-01")).toContain("3 samples");
    expect(await get(app, "/samples?scope=all&to=2025-12-31")).toContain("1 sample");
    expect(await get(app, "/samples?scope=all&place=whatcom")).toContain("1 sample");
    expect(await get(app, "/samples?scope=all&qc=blocking")).toContain("1 sample");
    expect(await get(app, "/samples?scope=all&qc=clean")).toContain("3 samples");
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
    // Set by the component, not by eye: a species is italic (/design/names).
    expect(body).toContain("<i>Bombus</i> <i>vosnesenskii</i>");
    expect(body).toContain("Bob Barnes");
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

describe("CSV export", () => {
  it("downloads the filtered rows, and never a coordinate", async () => {
    const { app } = await listingApp("staffer");
    const res = await app.request("/samples.csv?scope=all&place=whatcom");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("beeline-samples.csv");
    const csv = await res.text();
    const [header, ...lines] = csv.split("\r\n");
    expect(header).not.toContain("latitude");
    expect(header).not.toContain("longitude");
    expect(header).not.toContain("elevation");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("B-1");
    // Collectors ride along as the Darwin Core list they are.
    expect(lines[0]).toContain("Bob Barnes | Alice Adams");
  });

  it("exports specimens with their determination", async () => {
    const { app } = await listingApp("staffer");
    const csv = await (await app.request("/specimens.csv?scope=OBA")).text();
    expect(csv).toContain("OBA00001");
    expect(csv).toContain("Bombus vosnesenskii");
    expect(csv).toContain("Radoszkowski, 1862");
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
