import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createKysely } from "../src/db.js";
import type { Database } from "../src/model.js";
import {
  EMPTY_QUERY,
  SAMPLE_SORT_KEYS,
  SPECIMEN_SORT_KEYS,
  STAFF_READER,
  listSamples,
  nameLocalityChoices,
  listSpecimens,
  parseListingQuery,
  type ListingQuery,
  type Reader,
} from "../src/app/listings.js";
import { CURRENT_SEASON, SETTLED_SEASON, createMemoryDb, insertCleanSample } from "./helpers.js";

/**
 * Both listings choose their page of rows first and look up the rest of each row's columns for those rows alone
 * (beeline-amdt.5 and .6). That changes how the statement is planned and must change nothing a person sees. This
 * file holds two things that stand on their own:
 *
 * 1. What a reader may not see stays withheld, and the names offered for a point are read only when asked.
 * 2. The order cannot tie: every page read in small pages, put together, equals one full read with no row twice,
 *    so the inner query's order and the outer query's agree. A fixture with many equal sort keys is the hard case:
 *    the order is a total one only because it ends in the sample's or the specimen's own key.
 *
 * The first page of every sort and filter was also compared, column for column, with the statements as they were
 * before the change, for staff and for volunteers. The full cross, every sort in both directions and each filter
 * with each sort, on the second and last pages as well, was compared on production's backup of 2026-11-22 (796
 * pages, no differences) before the copy of the old statements was removed; PR #450 has the result. A copy of the
 * old statements shared the filters, sorts and withholding with the code it tested, so it guarded little and had to
 * be edited for every new listing column.
 */

/** The order tests page by ten: enough pages that every boundary is crossed, few enough calls to stay quick. */
const TIE_PAGE = 10;

let db: Kysely<Database>;
let people: Record<string, number>;
let close: () => void;

const parse = (search: string): ListingQuery =>
  parseListingQuery(new URLSearchParams(search), { atlasCodes: ["OBA", "WaBA"], programCodes: ["NWR"] });

type Who = { name: string; personId: number; reader: Reader };
const readers = (): Who[] => [
  { name: "staff", personId: people.staff!, reader: STAFF_READER },
  { name: "volunteer reading others' obscured samples", personId: people.alice!, reader: { staff: false, personIds: [people.alice!] } },
  { name: "another volunteer", personId: people.bob!, reader: { staff: false, personIds: [people.bob!] } },
];

beforeAll(async () => {
  const { instance, conn } = await createMemoryDb();
  db = createKysely(instance);
  close = () => conn.closeSync();
  const person = async (name: string) => {
    const [given, family] = name.split(" ");
    const [[id]] = (await (
      await conn.run(`INSERT INTO person (display_name, given_name, family_name) VALUES ('${name}', '${given}', '${family}') RETURNING entity_id`)
    ).getRows()) as [[number]];
    return id;
  };
  people = {
    alice: await person("Alice Adams"),
    bob: await person("Bob Barnes"),
    cleo: await person("Cleo Cortez"),
    dana: await person("Dana Dunn"),
    staff: await person("Sam Staff"),
  };
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${people.staff})`);
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${people.alice}, 4242, 'aadams')`);
  const atlas = (code: string) => `(SELECT entity_id FROM program WHERE code = '${code}')`;
  await conn.run(
    `INSERT INTO person_membership (person_id, program_id) VALUES (${people.bob}, ${atlas("WaBA")}), (${people.cleo}, ${atlas("MM")})`,
  );

  // A slice of taxonomy, so a family filter descends and every rank band has something.
  await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('family', 'Apidae')`);
  await conn.run(
    `INSERT INTO animal (rank, scientific_name, parent_id) SELECT 'genus', 'Bombus', entity_id FROM animal WHERE scientific_name = 'Apidae'`,
  );
  await conn.run(
    `INSERT INTO animal (rank, scientific_name, parent_id, authorship)
     SELECT 'species', 'Bombus vosnesenskii', entity_id, 'Radoszkowski, 1862' FROM animal WHERE scientific_name = 'Bombus'`,
  );
  await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('genus', 'Andrena'), ('species', 'Osmia lignaria')`);
  await conn.run(
    `INSERT INTO area (source, source_id, kind, name, geom, gazetteer_build) VALUES ('usfws', '13588', 'refuge', 'Ankeny NWR', 'POINT (0 0)'::GEOMETRY, 'test')`,
  );
  const animals = ["Bombus vosnesenskii", "Andrena", "Osmia lignaria", "Apidae"];
  const collectors = [people.alice!, people.bob!, people.cleo!, people.dana!];
  const atlases = [atlas("OBA"), atlas("WaBA"), "NULL"];
  const dates = [`${CURRENT_SEASON}-07-14`, `${CURRENT_SEASON}-07-14`, `${CURRENT_SEASON}-06-02`, `${SETTLED_SEASON}-05-20`];
  const localities = ["'Corvallis'", "'corvallis'", "NULL", "'Bellingham'", "'Anacortes'", "'Gerlach'"];
  const hosts = ["'Salvia'", "'salvia'", "NULL", "'Rosa'"];
  const states = ["'OR'", "'WA'", "'NV'"];
  const counties = ["'BentonCo'", "'Whatcom'", "'Washoe'", "NULL"];

  // Thirty samples. Few distinct dates, localities, hosts and collectors, so that most sort keys tie.
  for (let i = 0; i < 30; i++) {
    const trap = i % 5 === 0;
    const date = dates[i % dates.length]!;
    const geo = i % 6 === 0 ? "'obscured'" : i % 12 === 5 ? "'private'" : "NULL";
    const id = await insertCleanSample(conn, {
      collector_id: String(collectors[i % 4]),
      atlas_id: atlases[i % 3]!,
      sample_number: `'${["A", "B", "T", ""][i % 4]}${i % 3 === 0 ? "-" : ""}${[9, 10, 100, 7, 12][i % 5]! + i}'`,
      kind: trap ? "'trap'" : "'net'",
      date_start: `DATE '${date}'`,
      date_end: trap ? `DATE '${date.slice(0, 8)}${String(Number(date.slice(8)) + 3).padStart(2, "0")}'` : `DATE '${date}'`,
      specimen_count: String(i % 4),
      locality: localities[i % localities.length]!,
      county: counties[i % counties.length]!,
      state_province: states[i % states.length]!,
      host_name_as_observed: hosts[i % hosts.length]!,
      geoprivacy: geo,
      // A sample citing an observation nobody here has read is withheld too.
      ...(i % 7 === 3 ? { inat_observation_id: String(9_000_000 + i) } : {}),
    });
    if (i % 9 === 0) {
      await conn.run(`INSERT INTO sample_hold (sample_id, reason, held_by) VALUES (${id}, 'Hold ${i}', ${people.staff})`);
    }
    if (i % 4 === 1) {
      await conn.run(
        `INSERT INTO sample_locality_candidate (sample_id, rank, locality, basis, latitude, longitude, gazetteer_build, rule_version, derived_at)
         VALUES (${id}, 1, 'Candidate ${i}', 'town', 44.5646, -123.2620, 'test', 1, current_timestamp),
                (${id}, 2, 'Second ${i}', 'feature', 44.5646, -123.2620, 'test', 1, current_timestamp)`,
      );
    }
    if (i === 4) {
      await conn.run(
        `INSERT INTO sample_area_derivation (sample_id, latitude, longitude, gazetteer_build, rule_version, derived_at)
         VALUES (${id}, 44.5646, -123.2620, 'test', 1, current_timestamp)`,
      );
      await conn.run(`INSERT INTO sample_area (sample_id, area_source, area_source_id) VALUES (${id}, 'usfws', '13588')`);
    }
    // Specimens: field numbers of different lengths, some none at all.
    for (let n = 1; n <= (i % 7 === 0 ? 0 : 1 + (i % 3)); n++) {
      const field = i % 5 === 2 && n === 1 ? "NULL" : `'F${[1, 9, 10, 100][(i + n) % 4]}-${i}-${n}'`;
      const [[spId]] = (await (
        await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${id}, ${n}, ${field}) RETURNING entity_id`)
      ).getRows()) as [[number]];
      // Most are determined, by a person, by a name only, or twice (the name of record is one of the two).
      if ((i + n) % 5 !== 0) {
        const animal = animals[(i + n) % animals.length]!;
        const byVal = (i + n) % 3 === 0 ? `${collectors[(i + n) % 4]}, NULL` : `NULL, 'Volunteer ${(i + n) % 2}'`;
        const day = (i + n) % 4 === 0 ? "NULL" : `DATE '${SETTLED_SEASON}-0${1 + ((i + n) % 8)}-1${n}'`;
        await conn.run(
          `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_id, determiner_name, determined_on, qualifier, verbatim_identification)
           SELECT ${spId}, entity_id, ${(i + n) % 2 === 0}, 'legacy_import', ${byVal}, ${day}, ${(i + n) % 7 === 0 ? "'cf.'" : "NULL"}, 'v ${i}'
           FROM animal WHERE scientific_name = '${animal}'`,
        );
        if ((i + n) % 6 === 1) {
          // A second, older, non-expert determination that must not be the one of record.
          await conn.run(
            `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_name)
             SELECT ${spId}, entity_id, false, 'legacy_import', 'Older' FROM animal WHERE scientific_name = 'Andrena'`,
          );
        }
      }
      if ((i + n) % 4 === 1) {
        await conn.run(`INSERT INTO specimen_catalog_number (specimen_id, catalog_number) VALUES (${spId}, 'WSDA_${1000 + i * 10 + n}')`);
      }
      if ((i + n) % 5 === 1) {
        await conn.run(
          `INSERT INTO specimen_disposition (specimen_id, disposition, remarks, stated_by, stated_on, source)
           VALUES (${spId}, ${n === 1 ? "'missing'" : "NULL"}, 'remark ${i}', 'tester', DATE '${SETTLED_SEASON}-01-01', 'test')`,
        );
      }
    }
  }
}, 120_000);

afterAll(() => {
  close?.();
});

describe("the samples listing chooses its page first", () => {
  it("withholds another volunteer's locality and coordinates exactly as before, and the choices of the names offered", async () => {
    const alice = readers()[1]!;
    const page = await listSamples(db, parse("scope=all"), alice.personId, alice.reader, { limit: 30, offset: 0, hostNames: new Map(), withLocalityChoices: true });
    const hidden = page.rows.filter((r) => r.location_withheld);
    expect(hidden.length).toBeGreaterThan(3);
    for (const r of hidden) {
      expect(r.latitude).toBeNull();
      expect(r.locality).toBeNull();
      expect(r.locality_choices).toBeNull();
    }
    expect(page.rows.some((r) => !r.location_withheld && r.locality_choices !== null)).toBe(true);
    const staff = await listSamples(db, parse("scope=all"), people.staff!, STAFF_READER, { limit: 30, offset: 0, hostNames: new Map(), withLocalityChoices: true });
    expect(staff.rows.every((r) => !r.location_withheld)).toBe(true);
    expect(staff.rows.filter((r) => r.locality_choices !== null).length).toBeGreaterThan(3);
  });

  it("reads the names offered for a point only when asked, and none where a row does not say it is not withheld", async () => {
    const staff = readers()[0]!;
    const plain = await listSamples(db, parse("scope=all"), staff.personId, staff.reader, { limit: 30, offset: 0, hostNames: new Map() });
    expect(plain.rows.every((r) => r.locality_choices === null)).toBe(true);
    const asked = await listSamples(db, parse("scope=all"), staff.personId, staff.reader, { limit: 30, offset: 0, hostNames: new Map(), withLocalityChoices: true });
    const withChoices = asked.rows.filter((r) => r.locality_choices !== null);
    expect(withChoices.length).toBeGreaterThan(3);
    // A row without the column (a renamed one, say) is withheld, not shown.
    const rows = withChoices.map((r) => ({ sample_id: r.sample_id, locality_choices: "stale" })) as unknown as Parameters<typeof nameLocalityChoices>[1];
    await nameLocalityChoices(db, rows);
    expect(rows.every((r) => r.locality_choices === null)).toBe(true);
  });

  // Pages read against one full read, in one direction: `dir` only flips ASC to DESC in the
  // same ORDER BY text, which the inner and outer queries build from one function, so the other direction takes the same path. Every key ends in the sample's own id, so no
  // two samples compare equal and a page cannot differ between runs.
  for (const who of ["staff", "volunteer reading others' obscured samples"]) {
    it(`has an order that cannot tie, for ${who}`, async () => {
      const w = readers().find((r) => r.name === who)!;
      const searches = [
        ...SAMPLE_SORT_KEYS.map((sort) => `scope=all&sort=${sort}`),
        "scope=all&qc=flagged",
        "scope=all&qc=flagged&sort=flags&dir=desc",
        "scope=all&qc=flagged&sort=flags&dir=asc",
      ];
      for (const search of searches) {
        const q = parse(search);
        const all = await listSamples(db, q, w.personId, w.reader, { limit: 1000, offset: 0, hostNames: new Map() });
        expect(all.rows.length, search).toBeGreaterThan(TIE_PAGE);
        const paged: number[] = [];
        for (let offset = 0; offset < all.rows.length; offset += TIE_PAGE) {
          const p = await listSamples(db, q, w.personId, w.reader, { limit: TIE_PAGE, offset, hostNames: new Map() });
          paged.push(...p.rows.map((r) => r.sample_id));
        }
        expect(paged, search).toEqual(all.rows.map((r) => r.sample_id));
        expect(new Set(paged).size, search).toBe(paged.length);
      }
    }, 300_000);
  }
});

describe("the specimens listing chooses its page first", () => {
  it("gives each row a reprint blocker only while the reprint action is chosen", async () => {
    const staff = readers()[0]!;
    const plain = await listSpecimens(db, parse("scope=all"), staff.personId, staff.reader, { limit: 1000, offset: 0, hostNames: new Map() });
    expect(plain.rows.length).toBeGreaterThan(TIE_PAGE);
    expect(plain.rows.every((r) => r.reprint_blocker === null)).toBe(true);
    const acting = await listSpecimens(db, parse("scope=all&act=reprint"), staff.personId, staff.reader, { limit: 1000, offset: 0, hostNames: new Map() });
    expect(acting.total).toBe(plain.total);
    expect(acting.rows.some((r) => r.reprint_blocker !== null)).toBe(true);
  });

  for (const who of ["staff", "volunteer reading others' obscured samples"]) {
    it(`has an order that cannot tie, for ${who}`, async () => {
      const w = readers().find((r) => r.name === who)!;
      const searches = [
        ...SPECIMEN_SORT_KEYS.map((sort) => `scope=all&sort=${sort}`),
        "scope=all&qc=flagged",
        "scope=all&taxon=Bombus&sort=determiner",
      ];
      for (const search of searches) {
        const q = parse(search);
        const all = await listSpecimens(db, q, w.personId, w.reader, { limit: 1000, offset: 0, hostNames: new Map() });
        expect(all.rows.length, search).toBeGreaterThan(TIE_PAGE);
        const paged: number[] = [];
        for (let offset = 0; offset < all.rows.length; offset += TIE_PAGE) {
          const p = await listSpecimens(db, q, w.personId, w.reader, { limit: TIE_PAGE, offset, hostNames: new Map() });
          paged.push(...p.rows.map((r) => r.specimen_id));
        }
        expect(paged, search).toEqual(all.rows.map((r) => r.specimen_id));
        expect(new Set(paged).size, search).toBe(paged.length);
      }
    }, 300_000);
  }
});
