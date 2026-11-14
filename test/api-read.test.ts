import { describe, expect, it } from "vitest";
import { type KyselyPlugin } from "kysely";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely, loadSpatial } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApi } from "../src/app/api.js";
import { describedRoutes } from "../src/app/api-description.js";
import { createKey, keyRateLimiter } from "../src/app/api-keys.js";
import { ReadQueue } from "../src/app/api-queue.js";
import { plain, sampleJson } from "../src/app/api-read.js";
import {
  COUNT_GROUPS,
  QC_RULE_NAMES,
  SAMPLE_CSV_HEADER,
  SORT_KEYS,
  SPECIMEN_CSV_HEADER,
} from "../src/app/listings.js";
import { gatherSample } from "../src/app/record.js";
import { createApp } from "../src/app/server.js";
import { duckdbReader } from "../src/person-change.js";
import { recordSampleChanges } from "../src/sample-change.js";
import { CURRENT_SEASON, createMemoryDb, insertCleanSample, rows, SETTLED_SEASON, scratchPaths } from "./helpers.js";

/**
 * Reading through the API (beeline-pnqr.2): that a key sees what its person
 * sees on the pages and no more. The world is the listings test's: three
 * collectors, two atlases, the ground outside both, and a staff member. Run
 * on the sandbox environment, since development makes everyone staff.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const ORIGIN = "http://localhost:3054";
const UID = { alice: 4242, bob: 4343, cleo: 4545, sam: 4444 } as const;
type Who = keyof typeof UID;

/** Where Bob's obscured sample really was: none of this may reach anyone but Bob and staff. */
const SECRET = { place: "Anacortes Ferry Landing", note: "near the Anacortes ferry", latitude: "48.5123", longitude: "-122.6789", elevation: "1357" };

async function person(conn: DuckDBConnection, name: string, login: string, uid: number): Promise<number> {
  const [given, family] = name.split(" ");
  const [[id]] = (await (
    await conn.run(`INSERT INTO person (display_name, given_name, family_name) VALUES ('${name}', '${given}', '${family}') RETURNING entity_id`)
  ).getRows()) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${uid}, '${login}')`);
  return Number(id);
}

async function world({ extras = false }: { extras?: boolean } = {}) {
  const { instance, conn } = await createMemoryDb();
  const alice = await person(conn, "Alice Adams", "aadams", UID.alice);
  const bob = await person(conn, "Bob Barnes", "bbarnes", UID.bob);
  const cleo = await person(conn, "Cleo Cortez", "ccortez", UID.cleo);
  const sam = await person(conn, "Sam Staff", "samstaff", UID.sam);
  await conn.run(`INSERT INTO person_admin (person_id, granted_by) VALUES (${sam}, 'peter')`);
  // Alice may act for Cleo, which a key must never do.
  await conn.run(`INSERT INTO person_delegate (person_id, acts_for_id, granted_by) VALUES (${alice}, ${cleo}, 'peter')`);
  const atlas = (code: string) => `(SELECT entity_id FROM program WHERE code = '${code}')`;
  await conn.run(`INSERT INTO person_membership (person_id, program_id) VALUES (${bob}, ${atlas("WaBA")})`);

  const a1 = await insertCleanSample(conn, {
    collector_id: String(alice),
    atlas_id: atlas("OBA"),
    sample_number: "'A-1'",
    specimen_count: "2",
    inat_observation_id: "123456789",
  });
  // Alice, no locality: a blocking flag, in a settled season.
  await insertCleanSample(conn, {
    collector_id: String(alice),
    atlas_id: atlas("OBA"),
    sample_number: "'A-2'",
    locality: "NULL",
    date_start: `DATE '${SETTLED_SEASON}-06-01'`,
    date_end: `DATE '${SETTLED_SEASON}-06-01'`,
  });
  // Bob's, with Alice as a second collector.
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
  // Bob alone, and obscured on iNaturalist: not Alice's to locate.
  const b2 = await insertCleanSample(
    conn,
    {
      collector_id: String(bob),
      atlas_id: atlas("WaBA"),
      sample_number: "'B-2'",
      specimen_count: "1",
      locality: `'${SECRET.place}'`,
      state_province: "'WA'",
      geoprivacy: "'obscured'",
    },
    { latitude: SECRET.latitude, longitude: SECRET.longitude, elevation_m: SECRET.elevation },
  );
  // Bob in Nevada, where no atlas reaches; Cleo's, which Alice may act for.
  await insertCleanSample(conn, { collector_id: String(bob), sample_number: "'B-3'", locality: "'Gerlach'", county: "'Washoe'", state_province: "'NV'", kind: "'trap'" });
  const c1 = await insertCleanSample(conn, {
    collector_id: String(cleo),
    sample_number: "'C-1'",
    locality: "'Fallon'",
    county: "'Churchill'",
    state_province: "'NV'",
    geoprivacy: "'obscured'",
  });
  await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('family', 'Apidae')`);
  await conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) SELECT 'genus', 'Bombus', entity_id FROM animal WHERE scientific_name = 'Apidae'`);
  await conn.run(
    `INSERT INTO specimen (sample_id, specimen_number, field_number)
     VALUES (${a1}, 1, 'OBA00001'), (${a1}, 2, 'OBA00002'), (${b1}, 1, 'WABA0001'), (${b2}, 1, 'WABA0002')`,
  );
  await conn.run(
    `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_id, verbatim_identification)
     SELECT sp.entity_id, an.entity_id, true, 'legacy_import', ${bob}, 'Bombus sp.'
     FROM specimen sp, animal an WHERE sp.field_number = 'OBA00001' AND an.scientific_name = 'Bombus'`,
  );
  await conn.run(
    `INSERT INTO specimen_catalog_number (specimen_id, catalog_number) SELECT entity_id, 'OSAC_0001234' FROM specimen WHERE field_number = 'OBA00001'`,
  );
  // Staff's notes on Bob's obscured sample, which can say where it was.
  await conn.run(`INSERT INTO sample_hold (sample_id, reason, held_by) VALUES (${b2}, '${SECRET.note}', ${sam})`);
  await conn.run(
    `INSERT INTO sample_qc_waiver (sample_id, rule_name, finding, reason, waived_by, in_force)
     VALUES (${b2}, 'place_unabbreviated', 'x', '${SECRET.note}', ${sam}, true)`,
  );

  const extra: Record<string, number> = {};
  if (extras) {
    await loadSpatial(conn);
    // A private observation, with everything the record page can say about where it was.
    extra.b4 = await insertCleanSample(
      conn,
      { collector_id: String(bob), atlas_id: atlas("WaBA"), sample_number: "'B-4'", locality: "'Private Cove'", county: "'Skagit'", state_province: "'WA'", geoprivacy: "'private'", inat_observation_id: "777" },
      { latitude: "48.7001", longitude: "-122.5002", elevation_m: "1888" },
    );
    await conn.run(
      `INSERT INTO observation_field (inat_id, place_guess, private_place_guess, notes) VALUES (777, 'Guess Harbor, WA', 'Private Guess Cove, WA', 'Observer note')`,
    );
    await conn.run(
      `INSERT INTO sample_locality_candidate (sample_id, rank, locality, basis, latitude, longitude, gazetteer_build, rule_version, derived_at)
       VALUES (${extra.b4}, 1, 'Candidate One', 'town', 48.7001, -122.5002, 'test', 1, current_timestamp),
              (${extra.b4}, 2, 'Candidate Two', 'town', 48.7001, -122.5002, 'test', 1, current_timestamp)`,
    );
    await conn.run(
      `INSERT INTO area (source, source_id, kind, name, geom, gazetteer_build) VALUES
         ('wilderness.net', '1', 'wilderness', 'Hidden Wilderness', ST_GeomFromText('POINT(-122.5 48.7)'), 'test'),
         ('epa-cec', '2.3', 'ecoregion', 'Hidden Ecoregion', ST_GeomFromText('POINT(-122.5 48.7)'), 'test')`,
    );
    await conn.run(`INSERT INTO sample_area_derivation (sample_id, latitude, longitude, gazetteer_build, derived_at) VALUES (${extra.b4}, 48.7001, -122.5002, 'test', current_timestamp)`);
    await conn.run(
      `INSERT INTO sample_area (sample_id, area_source, area_source_id) VALUES (${extra.b4}, 'wilderness.net', '1'), (${extra.b4}, 'epa-cec', '2.3')`,
    );
    // Staff's two overrides, which say where in a name and in a point.
    await conn.run(`INSERT INTO sample_locality_override (sample_id, locality, set_by, reason) VALUES (${extra.b4}, 'Override Place', ${sam}, 'Override Reason')`);
    await conn.run(`INSERT INTO sample_location_override (sample_id, latitude, longitude, set_by, reason) VALUES (${extra.b4}, 48.7001, -122.5002, ${sam}, 'Point Reason')`);
    // Obscured by the taxon, not the observer.
    extra.b5 = await insertCleanSample(
      conn,
      { collector_id: String(bob), atlas_id: atlas("WaBA"), sample_number: "'B-5'", locality: "'Taxon Meadow'", state_province: "'WA'", taxon_geoprivacy: "'obscured'" },
      { latitude: "48.9001", longitude: "-122.9002", elevation_m: "1999" },
    );
    // Cites an observation Beeline never fetched, so nobody here knows whether it is protected.
    extra.b6 = await insertCleanSample(
      conn,
      { collector_id: String(bob), atlas_id: atlas("WaBA"), sample_number: "'B-6'", locality: "'Unfetched Flats'", state_province: "'WA'", inat_observation_id: "888" },
      { latitude: "48.8001", longitude: "-122.8002", elevation_m: "1777" },
    );
  }

  // The history: a baseline, then Bob's locality changed, so the log holds
  // an entry that says where B-2 was.
  const paths = await scratchPaths();
  const logPaths = { log: paths.sampleChangesPath, state: paths.sampleStatePath };
  await recordSampleChanges(duckdbReader(conn), logPaths, { source: "observation_promotion" });
  await conn.run(`UPDATE sample SET locality = '${SECRET.place} dock', county = 'Skagit', protocol = 'hand net' WHERE entity_id = ${b2}`);
  await recordSampleChanges(duckdbReader(conn), logPaths, { source: "app", author: "bbarnes", reason: SECRET.note });

  const db = createKysely(instance);
  const who: { current: Who } = { current: "alice" };
  const session = async () => ({ personId: { alice, bob, cleo, sam }[who.current], login: who.current, inatUserId: BigInt(UID[who.current]), iconUrl: null });
  const app = createApp({
    ...paths,
    db,
    config: { environment: "sandbox" as const, origin: ORIGIN },
    inat: unusedInat,
    resolveSession: session,
    conn,
    // The limit on reading is what a person needs, and most tests here read far more than that.
    apiLimits: { readLimiter: keyRateLimiter({ limit: 1_000_000 }), limiter: keyRateLimiter({ limit: 1_000_000 }) },
  });
  const keyFor = async (uid: number, scope: string) => {
    const made = await createKey(db, { inatUserId: uid, name: "test", scope, lifetimeDays: 30, offered: ["read", "edit", "staff"] });
    if ("problem" in made) throw new Error(made.problem);
    return made.key;
  };
  const keys = {
    alice: await keyFor(UID.alice, "read"),
    bob: await keyFor(UID.bob, "read"),
    // Staff's own key, and a staff-made key that only reads.
    sam: await keyFor(UID.sam, "staff"),
    samRead: await keyFor(UID.sam, "read"),
  };
  const get = (key: string | undefined, path: string) =>
    app.request(`/api/v1${path}`, { headers: key === undefined ? {} : { authorization: `Bearer ${key}` } });
  const json = async (key: string | undefined, path: string, status = 200) => {
    const res = await get(key, path);
    expect(res.status, path).toBe(status);
    return (await res.json()) as any;
  };
  /** The page as the signed-in person sees it. */
  const page = async (as: Who, path: string) => {
    who.current = as;
    const res = await app.request(path);
    expect(res.status, path).toBe(200);
    return res.text();
  };
  const idOf = async (n: string) => Number(((await rows(conn, `SELECT entity_id FROM sample WHERE sample_number = '${n}'`)) as number[][])[0]![0]);
  return { app, db, conn, paths, logPaths, keys, get, json, page, who, idOf, people: { alice, bob, cleo, sam }, ids: { a1, b1, b2, c1 }, extra, keyFor, instance };
}

/** A CSV with quoted cells, as text, to rows of cells. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (cell += '"', i++);
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (row.push(cell), (cell = ""));
    else if (ch === "\n") (row.push(cell), out.push(row), (row = []), (cell = ""));
    else cell += ch;
  }
  if (cell !== "" || row.length > 0) (row.push(cell), out.push(row));
  return out;
}

describe("the listings", () => {
  it("answer with the page's total and rows, the CSV's columns for names, and an id and a url", async () => {
    const w = await world();
    const body = await w.json(w.keys.alice, "/samples");
    expect(Object.keys(body)).toEqual(["total", "page", "page_size", "pages", "rows"]);
    // Alice's default scope is her own collecting, as the page's is.
    expect(body).toMatchObject({ total: 3, page: 1, page_size: 50, pages: 1 });
    expect(Object.keys(body.rows[0])).toEqual([...SAMPLE_CSV_HEADER, "id", "url", "location_withheld"]);
    const a1 = body.rows.find((r: any) => r.fieldNumber === "A-1");
    expect(a1).toMatchObject({ id: w.ids.a1, url: `${ORIGIN}/samples/${w.ids.a1}`, inatObservationId: 123456789, locality: "Corvallis", qcStatus: "clean" });
    expect(await w.page("alice", "/samples")).toContain("3 samples");

    const specimens = await w.json(w.keys.alice, "/specimens?scope=all");
    expect(Object.keys(specimens.rows[0])).toEqual([...SPECIMEN_CSV_HEADER, "id", "url", "sample_id", "sample_url", "location_withheld"]);
    expect(specimens.total).toBe(4);
    const first = specimens.rows.find((r: any) => r.fieldNumber === "OBA00001");
    expect(first).toMatchObject({ catalogNumber: "OSAC_0001234", scientificName: "Bombus", sampleNumber: "A-1", specimenNumber: 1 });
    expect(first.url).toBe(`${ORIGIN}/specimens/${first.id}`);
  });

  it("hold the CSV's values: the JSON and the download cannot disagree", async () => {
    const w = await world();
    const queries = [
      "",
      "scope=all",
      "scope=all&sort=collector&dir=asc",
      "scope=all&qc=flagged",
      "scope=OBA",
      "scope=outside",
      "scope=all&kind=trap",
      "scope=all&q=B-",
      "scope=all&place=Corvallis",
      "scope=all&taxon=Apidae",
      "scope=all&from=2025-01-01&to=2025-12-31",
      "scope=all&collector=Barnes&member=WaBA",
    ];
    for (const person of ["alice", "sam"] as const) {
      for (const kind of ["samples", "specimens"] as const) {
        const header: readonly string[] = kind === "samples" ? SAMPLE_CSV_HEADER : SPECIMEN_CSV_HEADER;
        for (const q of queries) {
          const api = await w.json(w.keys[person], `/${kind}?${q}&page_size=500`);
          const csv = parseCsv(await w.page(person, `/${kind}.csv?${q}`));
          expect(csv[0], `${kind} ${q}`).toEqual(header);
          const body = csv.slice(1).filter((r) => r.length > 1);
          expect(api.rows.length, `${person} ${kind} ${q}`).toBe(body.length);
          expect(api.total).toBe(body.length);
          body.forEach((cells, i) => {
            header.forEach((name, j) => expect(String(api.rows[i][name] ?? ""), `${person} ${kind} ${q} row ${i} ${name}`).toBe(cells[j]));
          });
        }
      }
    }
  });

  it("filter, sort, scope and page as the page does", async () => {
    const w = await world();
    const numbers = (b: any) => b.rows.map((r: any) => r.fieldNumber);
    // Scope: mine by default, all, an atlas, outside every atlas.
    expect(numbers(await w.json(w.keys.alice, "/samples?scope=all&sort=number&dir=asc")).sort()).toEqual(["A-1", "A-2", "B-1", "B-2", "B-3", "C-1"]);
    expect(numbers(await w.json(w.keys.alice, "/samples?scope=WaBA")).sort()).toEqual(["B-1", "B-2"]);
    expect(numbers(await w.json(w.keys.alice, "/samples?scope=outside")).sort()).toEqual(["B-3", "C-1"]);
    // Sort and direction.
    const up = numbers(await w.json(w.keys.alice, "/samples?scope=all&sort=number&dir=asc"));
    const down = numbers(await w.json(w.keys.alice, "/samples?scope=all&sort=number&dir=desc"));
    expect(down).toEqual([...up].reverse());
    // Filters.
    // B-2 is blocked by its staff hold, A-2 by its missing locality.
    expect(numbers(await w.json(w.keys.alice, "/samples?scope=all&qc=blocking")).sort()).toEqual(["A-2", "B-2"]);
    expect(numbers(await w.json(w.keys.alice, `/samples?scope=all&flag=${QC_RULE_NAMES[0]}`))).toEqual(["A-2"]);
    expect(numbers(await w.json(w.keys.alice, "/samples?scope=all&kind=trap"))).toEqual(["B-3"]);
    expect(numbers(await w.json(w.keys.alice, "/samples?scope=all&collector=Barnes&member=WaBA&sort=number&dir=asc"))).toEqual(["B-1", "B-2", "B-3"]);
    // The same rows as the page lists.
    const html = await w.page("alice", "/samples?scope=WaBA");
    for (const n of ["B-1", "B-2"]) expect(html).toContain(n);
    // Paging: two to a page, then the rest.
    const all = numbers(await w.json(w.keys.alice, "/samples?scope=all&sort=number&dir=asc&page_size=500"));
    const second = await w.json(w.keys.alice, "/samples?scope=all&sort=number&dir=asc&page_size=2&page=2");
    expect(second).toMatchObject({ total: 6, page: 2, page_size: 2, pages: 3 });
    expect(numbers(second)).toEqual(all.slice(2, 4));
    expect((await w.json(w.keys.alice, "/samples?scope=all&page_size=2&page=9")).rows).toEqual([]);
  });

  it("take page sizes from 1 to 500, and refuse anything else", async () => {
    const w = await world();
    expect((await w.json(w.keys.alice, "/samples?page_size=1")).rows).toHaveLength(1);
    expect((await w.json(w.keys.alice, "/samples?page_size=500")).page_size).toBe(500);
    for (const bad of ["0", "501", "-1", "abc", "2.5", "", "1e2"]) {
      const body = await w.json(w.keys.alice, `/samples?page_size=${bad}`, 400);
      expect(body.error).toBe("invalid_request");
      expect(body.message).toContain("page_size");
    }
  });

  it("refuse a parameter they do not know, naming it, and a value the page would quietly replace", async () => {
    const w = await world();
    for (const path of ["/samples?colour=red", "/specimens?qcc=flagged", "/samples?act=reprint", "/samples/count?page=2", "/samples/count?sort=date", "/samples?q=a&q=b"]) {
      const body = await w.json(w.keys.alice, path, 400);
      expect(body.error, path).toBe("invalid_request");
    }
    expect((await w.json(w.keys.alice, "/samples?colour=red", 400)).message).toContain('"colour"');
    for (const bad of ["scope=nowhere", "qc=flaged", "sort=size", "dir=up", "from=2026-13-99", "page=0", "kind=wing", "flag=nope", "member=zzz"]) {
      const body = await w.json(w.keys.alice, `/samples?${bad}`, 400);
      expect(body.message, bad).toContain(bad.split("=")[0]!);
    }
    // The page ignores the same things, which is why this is said in the docs.
    who(w, "alice");
    expect((await w.app.request("/samples?colour=red&qc=flaged")).status).toBe(200);
  });

  it("find one record by what a person has in hand, exactly", async () => {
    const w = await world();
    const numbers = (b: any) => b.rows.map((r: any) => r.fieldNumber);
    // q matches part of a value, so it cannot say "this one".
    expect((await w.json(w.keys.alice, "/samples?scope=all&q=1")).total).toBeGreaterThan(1);
    expect(numbers(await w.json(w.keys.alice, "/samples?scope=all&sample_number=a-1"))).toEqual(["A-1"]);
    expect(numbers(await w.json(w.keys.alice, "/samples?scope=all&field_number=OBA00002"))).toEqual(["A-1"]);
    expect(numbers(await w.json(w.keys.alice, "/samples?scope=all&field_number=OBA0000"))).toEqual([]);
    expect(numbers(await w.json(w.keys.alice, "/samples?scope=all&inat_observation_id=123456789"))).toEqual(["A-1"]);
    expect(numbers(await w.json(w.keys.alice, "/samples?scope=all&inat_observation_id=12345678"))).toEqual([]);
    const specimens = await w.json(w.keys.alice, "/specimens?scope=all&catalog_number=osac_0001234");
    expect(specimens.rows.map((r: any) => r.fieldNumber)).toEqual(["OBA00001"]);
    expect((await w.json(w.keys.alice, "/specimens?scope=all&field_number=WABA0001")).total).toBe(1);
    await w.json(w.keys.alice, "/samples?inat_observation_id=abc", 400);
  });
});

function who(w: Awaited<ReturnType<typeof world>>, as: Who) {
  w.who.current = as;
}

describe("the counts", () => {
  it("equal the listing's total for the same filters, and divide it by season, atlas and kind", async () => {
    const w = await world();
    const filters = ["", "scope=all", "scope=WaBA", "scope=outside", "scope=all&qc=flagged", "scope=all&kind=trap", "scope=all&place=Gerlach", "scope=all&taxon=Bombus", "scope=all&q=B-"];
    for (const kind of ["samples", "specimens"] as const) {
      for (const f of filters) {
        const listed = await w.json(w.keys.alice, `/${kind}?${f}&page_size=1`);
        const counted = await w.json(w.keys.alice, `/${kind}/count?${f}`);
        expect(counted, `${kind} ${f}`).toEqual({ total: listed.total });
        for (const group of COUNT_GROUPS) {
          const grouped = await w.json(w.keys.alice, `/${kind}/count?${f}&group_by=${group}`);
          expect(grouped.total).toBe(listed.total);
          expect(grouped.group_by).toBe(group);
          expect(grouped.groups.reduce((n: number, g: any) => n + g.total, 0), `${kind} ${f} ${group}`).toBe(listed.total);
        }
      }
    }
    const seasons = await w.json(w.keys.alice, "/samples/count?scope=all&group_by=season");
    expect(seasons.groups).toEqual([
      { key: SETTLED_SEASON, total: 1 },
      { key: CURRENT_SEASON, total: 5 },
    ]);
    const atlases = await w.json(w.keys.alice, "/samples/count?scope=all&group_by=atlas");
    expect(Object.fromEntries(atlases.groups.map((g: any) => [g.key, g.total]))).toEqual({ OBA: 2, WaBA: 2, null: 2 });
    await w.json(w.keys.alice, "/samples/count?group_by=colour", 400);
  });

  it("do not match a place they may not see", async () => {
    const w = await world();
    expect(await w.json(w.keys.alice, `/samples/count?scope=all&place=Anacortes`)).toEqual({ total: 0 });
    expect(await w.json(w.keys.sam, `/samples/count?scope=all&place=Anacortes`)).toEqual({ total: 1 });
  });
});

describe("what a key may see", () => {
  const secrets = Object.values(SECRET);

  it("is the page's: another collector's withheld location is withheld in the listing, in the record and under every filter", async () => {
    const w = await world();
    const leaks = (body: unknown) => secrets.filter((s) => JSON.stringify(body).includes(s));
    // The listing, specimens too.
    const samples = await w.json(w.keys.alice, "/samples?scope=all&page_size=500");
    const b2 = samples.rows.find((r: any) => r.fieldNumber === "B-2");
    expect(b2).toMatchObject({ locality: null, decimalLatitude: null, decimalLongitude: null, minimumElevationInMeters: null, locationSource: null, location_withheld: true, stateProvince: "WA", county: "Skagit" });
    expect(leaks(samples)).toEqual([]);
    expect(leaks(await w.json(w.keys.alice, "/specimens?scope=all&page_size=500"))).toEqual([]);
    // Filters that would reveal it.
    for (const q of [`place=${encodeURIComponent("Anacortes")}`, "place=ferry", "q=Anacortes", "place=48.5"]) {
      expect((await w.json(w.keys.alice, `/samples?scope=all&${q}`)).rows.filter((r: any) => r.fieldNumber === "B-2" && q.startsWith("place")), q).toEqual([]);
    }
    // The record: the sample, the specimen, the findings, the hold, the waiver, the history.
    const record = await w.json(w.keys.alice, `/samples/${w.ids.b2}`);
    expect(record.sample).toMatchObject({ locality: null, latitude: null, longitude: null, elevation_m: null, location_withheld: true });
    expect(leaks(record)).toEqual([]);
    expect(record.hold).toMatchObject({ reason: null, reason_withheld: true });
    expect(record.waivers[0]).toMatchObject({ reason: null, finding: null, text_withheld: true });
    expect(record.findings.every((f: any) => f.details === null)).toBe(true);
    expect(record.history.map((h: any) => h.field)).not.toContain("locality");
    const specimen = await w.json(w.keys.alice, `/specimens/${record.specimens.rows[0].id}`);
    expect(specimen.sample.location_withheld).toBe(true);
    expect(leaks(specimen)).toEqual([]);
    // The page withholds what the API does.
    const html = await w.page("alice", `/samples/${w.ids.b2}`);
    for (const s of [SECRET.place, SECRET.latitude, SECRET.longitude]) expect(html).not.toContain(s);
    const listing = await w.page("alice", "/samples?scope=all");
    for (const s of [SECRET.place, SECRET.latitude]) expect(listing).not.toContain(s);
  });

  it("shows the collector and staff what the page shows them", async () => {
    const w = await world();
    for (const key of [w.keys.bob, w.keys.sam]) {
      const record = await w.json(key, `/samples/${w.ids.b2}`);
      expect(record.sample).toMatchObject({ locality: `${SECRET.place} dock`, latitude: Number(SECRET.latitude), location_withheld: false });
      expect(record.hold.reason).toBe(SECRET.note);
      expect(record.waivers[0].reason).toBe(SECRET.note);
      expect(record.history.map((h: any) => h.field)).toContain("locality");
      const row = (await w.json(key, "/samples?scope=all&page_size=500")).rows.find((r: any) => r.fieldNumber === "B-2");
      expect(row).toMatchObject({ locality: `${SECRET.place} dock`, location_withheld: false });
      expect((await w.json(key, "/samples?scope=all&place=Anacortes")).total).toBe(1);
    }
    expect(await w.page("bob", `/samples/${w.ids.b2}`)).toContain(SECRET.place);
    expect(await w.page("sam", `/samples/${w.ids.b2}`)).toContain(SECRET.place);
  });

  it("is a volunteer's even for a staff-made key that only reads", async () => {
    const w = await world();
    // A read key reads as its person does; staff see what staff see, so the person is what matters,
    // and a key made without the staff scope is not a staff key.
    const as = await w.json(w.keys.samRead, "/me");
    expect(as).toMatchObject({ staff: false, key: { scope: "read" } });
    const row = (await w.json(w.keys.samRead, "/samples?scope=all&page_size=500")).rows.find((r: any) => r.fieldNumber === "B-2");
    expect(row).toMatchObject({ locality: null, location_withheld: true });
  });

  it("never reads as someone its person may act for, and loses staff reading at once", async () => {
    const w = await world();
    // Alice may act for Cleo, whose C-1 is obscured: Alice's key does not see its location, and her own scope is hers alone.
    const mine = await w.json(w.keys.alice, "/samples?page_size=500");
    expect(mine.rows.map((r: any) => r.fieldNumber).sort()).toEqual(["A-1", "A-2", "B-1"]);
    const c1 = await w.json(w.keys.alice, `/samples/${w.ids.c1}`);
    expect(c1.sample).toMatchObject({ location_withheld: true, locality: null, mine: false });
    // A staff key reads as staff while its person is staff, and as a volunteer when they stop being.
    expect((await w.json(w.keys.sam, `/samples/${w.ids.b2}`)).sample.location_withheld).toBe(false);
    await w.conn.run(`DELETE FROM person_admin`);
    expect((await w.json(w.keys.sam, "/me")).staff).toBe(false);
    expect((await w.json(w.keys.sam, `/samples/${w.ids.b2}`)).sample).toMatchObject({ location_withheld: true, locality: null });
    expect((await w.json(w.keys.sam, "/samples?scope=all&place=Anacortes")).total).toBe(0);
  });
});

describe("one record", () => {
  it("is what the page's gathering returns, serialised", async () => {
    const w = await world();
    const reader = { staff: false, personIds: [w.people.alice] };
    const gathered = await gatherSample({ db: w.db, changesPath: w.paths.sampleChangesPath }, w.ids.a1, w.people.alice, reader, 1);
    expect(gathered).not.toBeNull();
    const body = await w.json(w.keys.alice, `/samples/${w.ids.a1}`);
    expect(body).toEqual(JSON.parse(JSON.stringify(sampleJson(gathered!, ORIGIN, false))));
    expect(body.sample).toMatchObject({ id: w.ids.a1, url: `${ORIGIN}/samples/${w.ids.a1}`, sample_number: "A-1", date_start: `${CURRENT_SEASON}-07-14`, mine: true, inat_observation_id: 123456789 });
    expect(body.specimens).toMatchObject({ total: 2, page: 1, pages: 1, page_size: 50 });
    expect(body.specimens.rows[0]).toMatchObject({ field_number: "OBA00001", scientific_name: "Bombus", url: expect.stringContaining(`${ORIGIN}/specimens/`) });
    // The page shows the same specimens.
    const html = await w.page("alice", `/samples/${w.ids.a1}`);
    for (const r of body.specimens.rows) expect(html).toContain(r.field_number);
  });

  it("includes a specimen's determinations, labels and sample", async () => {
    const w = await world();
    const id = (await w.json(w.keys.alice, `/samples/${w.ids.a1}`)).specimens.rows[0].id;
    const body = await w.json(w.keys.alice, `/specimens/${id}`);
    expect(Object.keys(body)).toEqual(["specimen", "sample", "determinations", "findings", "labels", "reprint"]);
    expect(body.specimen).toMatchObject({ id, field_number: "OBA00001", specimen_number: 1 });
    expect(body.sample.sample_number).toBe("A-1");
    expect(body.determinations).toHaveLength(1);
    expect(body.determinations[0]).toMatchObject({ scientific_name: "Bombus", is_expert: true, of_record: true });
    expect(typeof body.determinations[0].recorded_at).toBe("string");
  });

  it("is not found for what does not exist, and 'count' is not an id", async () => {
    const w = await world();
    for (const path of ["/samples/999999", "/samples/0", "/samples/abc", "/samples/1.5", "/specimens/999999", "/specimens/abc", "/samples/99999999999"]) {
      expect((await w.json(w.keys.alice, path, 404)).error, path).toBe("not found");
    }
    await w.json(w.keys.alice, `/samples/${w.ids.a1}?colour=red`, 400);
    expect(await w.json(w.keys.alice, "/samples/count")).toEqual({ total: 3 });
  });

  it("writes values as JSON: days, instants and big numbers", () => {
    expect(plain(new Date("2026-07-14T00:00:00Z"), "date_start")).toBe("2026-07-14");
    expect(plain(new Date("2026-07-14T01:02:03Z"), "recorded_at")).toBe("2026-07-14T01:02:03.000Z");
    expect(plain(123n)).toBe(123);
    expect(plain(9007199254740993n)).toBe("9007199254740993");
    expect(plain(undefined)).toBeNull();
    expect(plain({ a: [1n, null] })).toEqual({ a: [1, null] });
  });
});

describe("the gate, the limit and the record of use", () => {
  it("needs a key like everything else, and leaves no row in api_key_use for a read", async () => {
    const w = await world();
    for (const path of ["", "/samples", "/samples/count", `/samples/${w.ids.a1}`, "/specimens", "/specimens/count"]) {
      expect((await w.get(undefined, path)).status, path).toBe(401);
    }
    for (const path of ["", "/samples", "/samples/count?group_by=season", `/samples/${w.ids.a1}`, "/specimens", "/specimens/1", "/samples?colour=1", "/samples/999999"]) {
      await w.get(w.keys.alice, path);
    }
    expect(await rows(w.conn, `SELECT count(*)::INTEGER FROM api_key_use`)).toEqual([[0]]);
    const res = await w.get(w.keys.alice, "/samples");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("counts reads against the key's limit", async () => {
    const w = await world();
    const api = createApi({ db: w.db, isStaff: async () => false, limiter: keyRateLimiter({ limit: 2 }) });
    const ask = () => api.request("/samples/count", { headers: { authorization: `Bearer ${w.keys.alice}` } });
    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(200);
    const third = await ask();
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).not.toBeNull();
  });

  it("says 503 for a listing or a record where the instance cannot read them, and still counts", async () => {
    const w = await world();
    const api = createApi({ db: w.db, isStaff: async () => false });
    const ask = (path: string) => api.request(path, { headers: { authorization: `Bearer ${w.keys.alice}` } });
    expect((await ask("/samples")).status).toBe(503);
    expect((await ask(`/samples/${w.ids.a1}`)).status).toBe(503);
    expect((await ask("/samples/count")).status).toBe(200);
  });
});

describe("a volunteer's own read key", () => {
  it("is made on /keys, reads as that volunteer, and cannot be made for another scope", async () => {
    const w = await world();
    who(w, "alice");
    const post = (body: Record<string, string>) =>
      w.app.request("/keys", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
      });
    const made = await post({ name: "my assistant", scope: "read", lifetime: "30" });
    expect(made.status).toBe(200);
    const key = /beeline_[A-Za-z0-9_-]{43}/.exec(await made.text())![0];
    expect(await w.json(key, "/me")).toMatchObject({ person: { inat_login: "aadams" }, key: { scope: "read" }, staff: false });
    expect((await w.json(key, "/samples")).total).toBe(3);
    expect((await w.json(key, `/samples/${w.ids.b2}`)).sample.location_withheld).toBe(true);
    expect((await post({ name: "x", scope: "edit", lifetime: "30" })).status).toBe(400);
    expect((await post({ name: "x", scope: "staff", lifetime: "30" })).status).toBe(400);
  });
});

describe("the description at /api/v1", () => {
  it("is served to a key, at the root of the API", async () => {
    const w = await world();
    const body = await w.json(w.keys.alice, "");
    expect(body).toMatchObject({ name: "Beeline API", version: "v1", base_url: `${ORIGIN}/api/v1` });
  });

  it("lists every route the router registers, and no other", async () => {
    const w = await world();
    const api = createApi({ db: w.db, isStaff: async () => false, corrections: undefined, read: { changesPath: "", origin: ORIGIN } });
    const registered = api.routes
      .filter((r) => r.method !== "ALL" && r.path !== "/*" && r.path !== "*")
      .map((r) => `${r.method} ${r.path}`);
    expect([...new Set(registered)].sort()).toEqual([...describedRoutes()].sort());
  });

  it("takes its lists of values from the ones the parser uses", async () => {
    const w = await world();
    const body = await w.json(w.keys.alice, "");
    const samples = body.endpoints.find((e: any) => e.method === "GET" && e.route === "/samples");
    expect(samples.path).toBe("/api/v1/samples");
    expect(samples.parameters.sort.values).toEqual([...SORT_KEYS]);
    expect(samples.parameters.flag.values).toEqual([...QC_RULE_NAMES]);
    expect(samples.parameters.scope.values).toEqual(expect.arrayContaining(["mine", "all", "outside", "OBA", "WaBA"]));
    expect(Object.keys(samples.parameters)).toEqual(expect.arrayContaining(["page_size", "inat_observation_id", "field_number", "catalog_number", "sample_number"]));
    const count = body.endpoints.find((e: any) => e.route === "/specimens/count");
    expect(count.parameters.group_by.values).toEqual([...COUNT_GROUPS]);
    expect(body.columns.samples.map((c: any) => c.name)).toEqual([...SAMPLE_CSV_HEADER]);
    expect(body.columns.specimens.map((c: any) => c.name)).toEqual([...SPECIMEN_CSV_HEADER]);
    expect(body.columns.samples.every((c: any) => c.meaning.length > 10)).toBe(true);
    expect(Object.keys(body.statuses)).toEqual(expect.arrayContaining(["400", "401", "404", "429"]));
  });

  it("names a parameter the endpoint takes for every one it accepts", async () => {
    // A parameter the description names is one the endpoint accepts: nothing is described that is refused.
    const w = await world();
    const body = await w.json(w.keys.alice, "");
    for (const e of body.endpoints.filter((e: any) => e.method === "GET" && e.parameters && ["/samples", "/specimens", "/samples/count", "/specimens/count"].includes(e.route))) {
      for (const [name, spec] of Object.entries<any>(e.parameters)) {
        const value = spec.values?.[0] ?? (name === "from" || name === "to" ? "2026-01-01" : name === "page" || name === "page_size" ? "1" : name === "inat_observation_id" ? "1" : "x");
        const res = await w.get(w.keys.alice, `${e.route}?${name}=${encodeURIComponent(value)}`);
        expect(res.status, `${e.route} ${name}`).toBe(200);
      }
    }
  });
});

describe("what a reason, a hold and a name may say", () => {
  it("drops the reason on every history entry that stays, on the page and through the API", async () => {
    const w = await world();
    // One change to the locality, the county and the protocol, with one reason that says where.
    const record = await w.json(w.keys.alice, `/samples/${w.ids.b2}`);
    const fields = record.history.map((h: any) => h.field);
    expect(fields).toEqual(expect.arrayContaining(["county", "protocol"]));
    expect(fields).not.toContain("locality");
    for (const entry of record.history) expect(entry.reason, entry.field).toBe("");
    expect(JSON.stringify(record)).not.toContain(SECRET.note);
    const html = await w.page("alice", `/samples/${w.ids.b2}`);
    expect(html).not.toContain(SECRET.note);
    expect(html).toContain("hand net");
    // The collector and staff keep the reason.
    for (const key of [w.keys.bob, w.keys.sam]) {
      const own = await w.json(key, `/samples/${w.ids.b2}`);
      expect(own.history.filter((h: any) => h.reason === SECRET.note).length).toBeGreaterThanOrEqual(3);
    }
    expect(await w.page("bob", `/samples/${w.ids.b2}`)).toContain(SECRET.note);
  });

  it("drops it where staff made the change as a coordinate correction", async () => {
    // The change log as setCoordinates writes it: the note on the point's entries and on the county and elevation it moved.
    const w = await world();
    const { appendSampleChanges, readSampleChanges } = await import("../src/sample-change.js");
    const base = (await readSampleChanges(w.paths.sampleChangesPath)).find((c) => c.field === "county")!;
    await appendSampleChanges(
      w.paths.sampleChangesPath,
      ["location", "county", "elevation_m"].map((field, i) => ({
        ...base,
        at: new Date(Date.now() + 1000 + i).toISOString(),
        field: field as never,
        old_value: "a",
        new_value: "b",
        author: "samstaff",
        source: "app" as const,
        reason: "it was at the ferry",
      })),
    );
    const alice = await w.json(w.keys.alice, `/samples/${w.ids.b2}`);
    expect(JSON.stringify(alice)).not.toContain("the ferry");
    expect(alice.history.every((h: any) => h.reason === "")).toBe(true);
    expect(await w.page("alice", `/samples/${w.ids.b2}`)).not.toContain("the ferry");
    expect(JSON.stringify(await w.json(w.keys.sam, `/samples/${w.ids.b2}`))).toContain("the ferry");
  });

  it("names who placed a hold only to staff", async () => {
    const w = await world();
    expect((await w.json(w.keys.alice, `/samples/${w.ids.b2}`)).hold).toMatchObject({ held_by: null });
    expect((await w.json(w.keys.bob, `/samples/${w.ids.b2}`)).hold).toMatchObject({ held_by: null, reason: SECRET.note });
    expect((await w.json(w.keys.sam, `/samples/${w.ids.b2}`)).hold).toMatchObject({ held_by: "Sam Staff", reason: SECRET.note });
    // As the page does.
    expect(await w.page("bob", `/samples/${w.ids.b2}`)).not.toContain("Sam Staff placed");
  });
});

describe("what the API publishes of a record, field by field", () => {
  it("is a list somebody decided, not a copy of what the page reads", async () => {
    const w = await world();
    const sample = await w.json(w.keys.alice, `/samples/${w.ids.a1}`);
    expect(Object.keys(sample.sample).sort()).toEqual(
      [
        "atlas_code", "atlas_name", "collectors", "coordinate_uncertainty_m", "country", "county", "date_end", "date_start", "ecoregion",
        "elevation_file", "elevation_m", "elevation_source", "elevation_stale", "from_old_records", "geoprivacy", "host_inat_taxon_id",
        "host_name_as_observed", "host_rank", "id", "inat_observation_id", "kind", "label_diverged", "latitude", "locality",
        "locality_alternatives", "locality_override", "locality_suggestion", "location_override", "location_source",
        "location_withheld", "longitude", "mine", "observation_gone_since", "observation_notes", "observation_place_guess", "printed",
        "program_code", "program_name", "protocol", "sample_id", "sample_number", "sampling_effort", "specimen_count", "state_province",
        "taxon_geoprivacy", "url", "wildernesses",
      ].sort(),
    );
    expect(Object.keys(sample).sort()).toEqual(["findings", "history", "hold", "sample", "specimens", "waivers"]);
    expect(Object.keys(sample.specimens.rows[0]).sort()).toEqual(
      ["authorship", "determiner", "field_number", "id", "is_expert", "label_at", "label_state", "qualifier", "rank", "reprint_requested", "scientific_name", "sex", "specimen_id", "specimen_number", "url"].sort(),
    );
    const specimen = await w.json(w.keys.alice, `/specimens/${sample.specimens.rows[0].id}`);
    expect(Object.keys(specimen.specimen).sort()).toEqual(
      ["disposition", "field_number", "id", "remarks", "remarks_by", "remarks_on", "specimen_id", "specimen_number", "url"].sort(),
    );
    // The sample inside a specimen has none of the specimen's own columns.
    expect(Object.keys(specimen.sample).sort()).toEqual(Object.keys(sample.sample).sort());
    for (const own of ["specimen_number", "field_number", "disposition", "remarks"]) expect(specimen.sample).not.toHaveProperty(own);
    expect(Object.keys(specimen.determinations[0]).sort()).toEqual(
      ["authorship", "caste", "channel", "determined_on", "determined_on_precision", "determiner", "entity_id", "is_expert", "notes", "of_record", "qualifier", "rank", "recorded_at", "scientific_name", "sex", "verbatim_identification"].sort(),
    );
    const withHistory = await w.json(w.keys.bob, `/samples/${w.ids.b2}`);
    expect(Object.keys(withHistory.history[0]).sort()).toEqual(["author", "at", "field", "new_value", "old_value", "reason", "source"].sort());
    expect(Object.keys(withHistory.findings[0]).sort()).toEqual(
      ["detail_taxon_name", "detail_taxon_rank", "details", "field_number", "rule_name", "severity", "specimen_id", "waivable"].sort(),
    );
  });
});

describe("what a volunteer's page and key may not learn, for every kind of withholding", () => {
  const SECRETS = [
    "Private Cove", "Candidate One", "Candidate Two", "Hidden Wilderness", "Hidden Ecoregion", "Override Place", "Override Reason", "Point Reason",
    "Guess Harbor", "Private Guess Cove", "48.7001", "-122.5002", "1888", "Taxon Meadow", "48.9001", "-122.9002", "1999", "Unfetched Flats", "48.8001", "-122.8002", "1777",
  ];
  const leaks = (value: unknown) => SECRETS.filter((x) => JSON.stringify(value).includes(x));

  it("keeps a private observation's county, a taxon-obscured point, and a point on an observation never fetched out of every answer", async () => {
    const w = await world({ extras: true });
    const all = await w.json(w.keys.alice, "/samples?scope=all&page_size=500");
    const byNumber = (n: string) => all.rows.find((r: any) => r.fieldNumber === n);
    // The private observation loses its county as well; the other two keep it.
    expect(byNumber("B-4")).toMatchObject({ county: null, stateProvince: "WA", locality: null, location_withheld: true });
    expect(byNumber("B-5")).toMatchObject({ locality: null, decimalLatitude: null, location_withheld: true });
    expect(byNumber("B-6")).toMatchObject({ locality: null, decimalLatitude: null, location_withheld: true });
    expect(leaks(all)).toEqual([]);
    expect(leaks(await w.json(w.keys.alice, "/specimens?scope=all&page_size=500"))).toEqual([]);
    for (const [n, id] of Object.entries({ "B-4": w.extra.b4, "B-5": w.extra.b5, "B-6": w.extra.b6 })) {
      const record = await w.json(w.keys.alice, `/samples/${id}`);
      expect(record.sample, n).toMatchObject({ location_withheld: true, locality: null, observation_place_guess: null, locality_suggestion: null, locality_override: null, location_override: null, ecoregion: null });
      expect(record.sample.locality_alternatives).toEqual([]);
      expect(record.sample.wildernesses).toEqual([]);
      expect(leaks(record), n).toEqual([]);
      const html = await w.page("alice", `/samples/${id}`);
      for (const x of SECRETS) expect(html, `${n} ${x}`).not.toContain(x);
    }
    // Nor can a filter find them by what they hide.
    for (const place of ["Private", "Wilderness", "Ecoregion", "Override", "Candidate", "Taxon", "Unfetched", "Skagit"]) {
      const found = await w.json(w.keys.alice, `/samples?scope=all&place=${place}`);
      expect(found.rows.map((r: any) => r.fieldNumber).filter((n: string) => ["B-4", "B-5", "B-6"].includes(n)), place).toEqual([]);
    }
    expect((await w.json(w.keys.alice, "/samples?scope=all&q=Private")).total).toBe(0);
  });

  it("shows the same things to the collector and to staff", async () => {
    const w = await world({ extras: true });
    for (const key of [w.keys.bob, w.keys.sam]) {
      const record = await w.json(key, `/samples/${w.extra.b4}`);
      expect(record.sample).toMatchObject({
        location_withheld: false,
        locality: "Private Cove",
        county: "Skagit",
        observation_place_guess: "Private Guess Cove, WA",
        locality_suggestion: { locality: "Candidate One" },
        locality_override: { locality: "Override Place", reason: "Override Reason" },
        location_override: { reason: "Point Reason" },
        ecoregion: "Hidden Ecoregion",
        wildernesses: ["Hidden Wilderness"],
      });
      expect(record.sample.locality_alternatives).toEqual([{ locality: "Candidate Two", basis: "town" }]);
      expect((await w.json(key, "/samples?scope=all&place=Hidden+Wilderness")).total).toBe(1);
    }
  });

  it("sorts by the place a reader may see, so a withheld row sorts as having none", async () => {
    const w = await world({ extras: true });
    const places = async (key: string) => (await w.json(key, "/samples?scope=all&sort=place&dir=asc&page_size=500")).rows.map((r: any) => [r.fieldNumber, r.locality]);
    const forAlice = await places(w.keys.alice);
    const named = forAlice.filter(([, l]: any) => l !== null).map(([, l]: any) => l.toLowerCase());
    expect(named).toEqual([...named].sort());
    // Rows with no locality to show come last, the withheld ones among them, in the order of what is shown.
    const firstBlank = forAlice.findIndex(([, l]: any) => l === null);
    expect(forAlice.slice(firstBlank).every(([, l]: any) => l === null)).toBe(true);
    expect(forAlice.slice(firstBlank).map(([n]: any) => n)).toEqual(expect.arrayContaining(["B-2", "B-4", "B-5", "B-6"]));
    // Staff sort by the real thing: the Anacortes landing comes first.
    expect((await places(w.keys.sam))[0][0]).toBe("B-2");
    // And the order of the withheld rows says nothing about their places: the same however the secret localities read.
    await w.conn.run(`UPDATE sample SET locality = 'Zzz' WHERE sample_number IN ('B-4', 'B-5', 'B-6', 'B-2')`);
    expect((await places(w.keys.alice)).map(([n]: any) => n)).toEqual(forAlice.map(([n]: any) => n));
  });
});

describe("what the API refuses and answers at the edges", () => {
  it("refuses search text over 100 characters, naming it, where the page cuts it", async () => {
    const w = await world();
    const long = "x".repeat(101);
    for (const name of ["q", "place", "collector", "taxon", "host"]) {
      const body = await w.json(w.keys.alice, `/samples?${name}=${long}`, 400);
      expect(body.message, name).toContain(`${name} may be at most 100`);
    }
    expect((await w.json(w.keys.alice, `/samples?q=${"x".repeat(100)}`)).total).toBe(0);
    who(w, "alice");
    expect((await w.app.request(`/samples?q=${long}`)).status).toBe(200);
  });

  it("refuses a repeated parameter on a record, and answers the page of specimens asked for, empty past the end", async () => {
    const w = await world();
    await w.json(w.keys.alice, `/samples/${w.ids.a1}?page=1&page=2`, 400);
    await w.json(w.keys.alice, `/samples/${w.ids.a1}?page=0`, 400);
    const past = await w.json(w.keys.alice, `/samples/${w.ids.a1}?page=999`);
    expect(past.specimens).toMatchObject({ total: 2, page: 999, pages: 1, rows: [] });
    // The page still shows the last page, as it did.
    expect(await w.page("alice", `/samples/${w.ids.a1}?page=999`)).toContain("OBA00001");
  });

  it("answers the description at /api/v1/ as well", async () => {
    const w = await world();
    const bare = await w.json(w.keys.alice, "");
    const res = await w.app.request("/api/v1/", { headers: { authorization: `Bearer ${w.keys.alice}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(bare);
    expect((await w.app.request("/api/v1/")).status).toBe(401);
  });

  it("counts grouped by one query whose groups add up, for every status filter", async () => {
    const w = await world();
    for (const kind of ["samples", "specimens"] as const) {
      for (const f of ["qc=blocking", "qc=warning", "qc=clean", "qc=flagged", "qc=locality", "flag=staff_hold", "qc=blocking&flag=staff_hold"]) {
        const listed = await w.json(w.keys.alice, `/${kind}?scope=all&${f}&page_size=1`);
        expect(await w.json(w.keys.alice, `/${kind}/count?scope=all&${f}`), `${kind} ${f}`).toEqual({ total: listed.total });
        const grouped = await w.json(w.keys.alice, `/${kind}/count?scope=all&${f}&group_by=season`);
        expect(grouped.total, `${kind} ${f}`).toBe(listed.total);
        expect(grouped.groups.reduce((n: number, g: any) => n + g.total, 0)).toBe(listed.total);
      }
    }
  });
});

describe("how much the API lets one person ask of the machine", () => {
  /** Counts the queries the store is asked, and can refuse some. */
  const watcher = (refuse?: RegExp) => {
    const seen = { queries: 0 };
    const plugin: KyselyPlugin = {
      transformQuery: (args) => {
        seen.queries += 1;
        if (refuse !== undefined && refuse.test(JSON.stringify(args.node))) throw new Error("refused by the test");
        return args.node;
      },
      transformResult: async (args) => args.result,
    };
    return { seen, plugin };
  };
  const asking = (api: ReturnType<typeof createApi>, key: string, path: string) => api.request(path, { headers: { authorization: `Bearer ${key}` } });

  it("counts a person's keys together, and still answers a key over its limit without asking the store", async () => {
    const w = await world();
    const { seen, plugin } = watcher();
    const api = createApi({ db: w.db.withPlugin(plugin), isStaff: async () => false, limiter: keyRateLimiter({ limit: 4 }) });
    const keys = [w.keys.alice, await w.keyFor(UID.alice, "read"), await w.keyFor(UID.alice, "read")];
    // Three keys share one budget of four, from their first requests on.
    for (const k of keys) expect((await asking(api, k, "/me")).status).toBe(200);
    expect((await asking(api, keys[0]!, "/me")).status).toBe(200);
    const queries = seen.queries;
    const refused = await asking(api, keys[2]!, "/me");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    // Nothing was asked of the store for it.
    expect(seen.queries).toBe(queries);
    // Another person is not affected.
    expect((await asking(api, w.keys.bob, "/me")).status).toBe(200);
  });

  it("keeps a lower limit for reading, per person, and leaves the rest on the general one", async () => {
    const w = await world();
    const api = createApi({ db: w.db, isStaff: async () => false, readLimiter: keyRateLimiter({ limit: 3 }), read: { changesPath: w.paths.sampleChangesPath, origin: ORIGIN } });
    const keys = [w.keys.alice, await w.keyFor(UID.alice, "read"), await w.keyFor(UID.alice, "read")];
    for (const k of keys) expect((await asking(api, k, "/samples/count")).status).toBe(200);
    const limited = await asking(api, keys[2]!, "/specimens/count");
    expect(limited.status).toBe(429);
    expect((await limited.json()).message).toContain("60 requests a minute");
    // The description and /me are not reading, and the general limit still allows them.
    expect((await asking(api, keys[2]!, "/me")).status).toBe(200);
    expect((await asking(api, keys[2]!, "")).status).toBe(200);
    // The default is 60.
    const plain60 = createApi({ db: w.db, isStaff: async () => false });
    const statuses: number[] = [];
    for (let i = 0; i < 63; i++) statuses.push((await asking(plain60, w.keys.bob, "/samples/count")).status);
    expect(statuses.indexOf(429)).toBe(60);
  });

  it("lets two reads run and twenty wait, turns away the next, and gives each turn back", async () => {
    const queue = new ReadQueue(2, 20);
    const turns = await Promise.all([queue.acquire(), queue.acquire()]);
    expect(turns.every((t) => t !== null)).toBe(true);
    expect(queue.state).toEqual({ running: 2, waiting: 0 });
    const waiting = Array.from({ length: 20 }, () => queue.acquire());
    expect(queue.state).toEqual({ running: 2, waiting: 20 });
    expect(await queue.acquire()).toBeNull();
    // Giving a turn back starts the next waiter, in order, and never exceeds two.
    turns[0]!();
    turns[0]!();
    expect(queue.state).toEqual({ running: 2, waiting: 19 });
    const first = await waiting[0]!;
    expect(first).not.toBeNull();
    turns[1]!();
    for (let i = 1; i < 20; i++) (await waiting[i]!)!();
    first!();
    expect(queue.state).toEqual({ running: 0, waiting: 0 });
    // A client that goes away while waiting leaves the line.
    const gone = new AbortController();
    const held = [await queue.acquire(), await queue.acquire()];
    expect(queue.state.running).toBe(2);
    const leaver = queue.acquire(gone.signal);
    gone.abort();
    expect(await leaver).toBeNull();
    expect(queue.state.waiting).toBe(0);
    held.forEach((t) => t!());
    expect(queue.state).toEqual({ running: 0, waiting: 0 });
  });

  it("answers 429 when the line is full, never makes the description or /me wait, and gives the turn back after an error", async () => {
    const w = await world();
    const queue = new ReadQueue(1, 0);
    const api = createApi({ db: w.db, isStaff: async () => false, readQueue: queue, read: { changesPath: w.paths.sampleChangesPath, origin: ORIGIN } });
    const turn = await queue.acquire();
    const full = await asking(api, w.keys.alice, "/samples/count");
    expect(full.status).toBe(429);
    expect(full.headers.get("retry-after")).toBe("2");
    expect((await full.json()).message).toContain("Try again");
    expect((await asking(api, w.keys.alice, "/me")).status).toBe(200);
    expect((await asking(api, w.keys.alice, "")).status).toBe(200);
    turn!();
    expect((await asking(api, w.keys.alice, "/samples/count")).status).toBe(200);
    expect(queue.state).toEqual({ running: 0, waiting: 0 });
    // A request that fails in the store gives its turn back.
    const { plugin } = watcher(/atlas_region/);
    const broken = createApi({ db: w.db.withPlugin(plugin), isStaff: async () => false, readQueue: queue, read: { changesPath: w.paths.sampleChangesPath, origin: ORIGIN } });
    expect((await asking(broken, w.keys.alice, "/samples/count")).status).toBe(500);
    expect(queue.state).toEqual({ running: 0, waiting: 0 });
  });
});
