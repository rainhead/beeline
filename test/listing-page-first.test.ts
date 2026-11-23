import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createKysely } from "../src/db.js";
import type { Database } from "../src/model.js";
import {
  EMPTY_QUERY,
  SPECIMEN_SORT_KEYS,
  STAFF_READER,
  listSpecimens,
  parseListingQuery,
  type ListingQuery,
  type Reader,
} from "../src/app/listings.js";
import { CURRENT_SEASON, SETTLED_SEASON, createMemoryDb, insertCleanSample } from "./helpers.js";
import { referenceSpecimenRows } from "./reference-listings.js";

/**
 * Both listings choose their page of rows first and look up the rest of each row's columns for those rows alone
 * (beeline-amdt.5 and .6). That changes how the statement is planned and must change nothing a person sees: so each
 * page is held equal, in every column, to the rows the statement chose before (`test/reference-listings.ts`), for every
 * sort in both directions, for every filter, for staff and for volunteers, on pages of five so that paging is
 * exercised. A fixture with many equal sort keys is the hard case: the order is a total one only because it ends in
 * the sample's or the specimen's own key.
 */

const PAGE = 5;
const total = { samples: 0, specimens: 0 };

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
           VALUES (${spId}, ${n === 1 ? "'missing'" : "NULL"}, 'remark ${i}', 'tester', DATE '2026-01-01', 'test')`,
        );
      }
    }
  }
}, 120_000);

afterAll(() => {
  console.log(`page-first comparisons: ${total.samples} samples pages, ${total.specimens} specimens pages`);
  close?.();
});

/** The rows' fields that the host lookup fills after the statement, which the reference leaves out. */
const withoutHostNames = <T extends object>(rows: T[]) =>
  rows.map((r) => ({ ...r, host_current_name: null, host_family: null, host_common_name: null }));

/**
 * The flag list comes out of a string_agg with no order of its own, so the same statement can list the same
 * flags in either order; the page sorts them (`parseFlags`) before showing them. Compared as the set it is.
 */
const flagsSorted = <T extends object>(rows: T[]) =>
  rows.map((r) => {
    const list = (r as { flag_list?: string | null }).flag_list;
    return list === undefined || list === null ? r : { ...r, flag_list: list.split(",").sort().join(",") };
  });

/** Offsets of the first page, the second and the last, for a total: the last is where the page is short. */
const offsets = (n: number) => [...new Set([0, PAGE, Math.max(0, Math.floor((n - 1) / PAGE) * PAGE)])].sort((a, b) => a - b);

async function sameSpecimens(search: string, who: Who): Promise<number> {
  const query = parse(search);
  const first = await listSpecimens(db, query, who.personId, who.reader, { limit: PAGE, offset: 0, hostNames: new Map() });
  for (const offset of offsets(first.total)) {
    const now = await listSpecimens(db, query, who.personId, who.reader, { limit: PAGE, offset, hostNames: new Map() as never });
    const before = await referenceSpecimenRows(db, query, who.personId, who.reader, { limit: PAGE, offset });
    expect(now.rows, `${who.name}, specimens ${search} at ${offset}`).toEqual(withoutHostNames(before));
    expect(now.total).toBe(first.total);
    total.specimens++;
  }
  return first.total;
}

// Every filter the listings accept, each with the least it must find so that a comparison of nothing with nothing
// cannot pass. The searches are query strings, as a person's URL carries them.
const FILTERS: Array<[search: string, atLeastSamples: number, atLeastSpecimens: number]> = [
  ["scope=all", 20, 20],
  ["scope=mine", 1, 1],
  ["scope=OBA", 5, 5],
  ["scope=WaBA", 5, 5],
  ["scope=outside", 5, 5],
  ["scope=NWR", 0, 0],
  ["scope=all&qc=flagged", 3, 3],
  ["scope=all&qc=blocking", 3, 3],
  ["scope=all&qc=warning", 0, 0],
  ["scope=all&qc=clean", 3, 3],
  ["scope=all&qc=locality", 3, 3],
  ["scope=all&flag=staff_hold", 2, 2],
  ["scope=all&collector=alice", 3, 3],
  ["scope=all&collector=aadams", 3, 3],
  ["scope=all&member=WaBA", 2, 2],
  ["scope=all&member=unrecorded", 1, 1],
  ["scope=all&place=Corvallis", 3, 3],
  ["scope=all&place=wa", 3, 3],
  ["scope=all&taxon=Bombus", 3, 3],
  ["scope=all&taxon=Apidae", 3, 3],
  ["scope=all&host=salvia", 3, 3],
  ["scope=all&host=rosa", 3, 3],
  ["scope=all&from=2026-06-01&to=2026-12-31", 3, 3],
  ["scope=all&from=2026-06-30", 3, 3],
  ["scope=all&to=2026-06-30", 3, 3],
  [`scope=all&year=${CURRENT_SEASON}`, 3, 3],
  ["scope=all&kind=trap", 3, 3],
  ["scope=all&kind=net", 3, 3],
  ["scope=all&q=a-1", 1, 0],
  ["scope=all&q=F9", 0, 3],
  ["scope=all&q=bob", 3, 3],
  ["scope=all&det=undetermined", 3, 3],
  ["scope=all&det=determined", 3, 3],
  ["scope=all&det=coarse", 1, 1],
  ["scope=all&det=genus", 1, 1],
  ["scope=all&det=species", 1, 1],
  ["scope=all&det=from_genus", 1, 1],
  ["scope=all&labels=waiting", 3, 0],
  ["scope=all&labels=printed", 0, 0],
  ["scope=all&ecdysis=in", 0, 3],
  ["scope=all&ecdysis=not", 3, 3],
  ["scope=all&place=Corvallis&kind=net&qc=flagged&taxon=Bombus", 0, 0],
  ["scope=all&collector=bob&host=salvia&from=2026-01-01", 0, 0],
];

describe("the specimens listing chooses its page first and returns what it returned before", () => {
  for (const who of ["staff", "volunteer reading others' obscured samples", "another volunteer"]) {
    it(`every sort, both ways, for ${who}`, async () => {
      const w = readers().find((r) => r.name === who)!;
      for (const sort of SPECIMEN_SORT_KEYS) {
        for (const dir of ["asc", "desc"]) {
          const n = await sameSpecimens(`scope=all&sort=${sort}&dir=${dir}`, w);
          expect(n, `${sort} ${dir}`).toBeGreaterThanOrEqual(PAGE * 3);
        }
      }
    }, 300_000);

    if (who !== "another volunteer") it(`every filter, for ${who}`, async () => {
      const w = readers().find((r) => r.name === who)!;
      for (const [search, , atLeast] of FILTERS) {
        const n = await sameSpecimens(search, w);
        if (search !== "scope=mine") expect(n, search).toBeGreaterThanOrEqual(atLeast);
      }
    }, 300_000);

    if (who !== "another volunteer") it(`a filter with each sort, for ${who}`, async () => {
      const w = readers().find((r) => r.name === who)!;
      for (const sort of SPECIMEN_SORT_KEYS) {
        for (const search of ["scope=all&qc=flagged", "scope=all&place=Corvallis", "scope=all&kind=trap", "scope=all&taxon=Bombus", "scope=all&det=undetermined"]) {
          await sameSpecimens(`${search}&sort=${sort}`, w);
        }
      }
    }, 300_000);
  }

  it("holds the reprint action's blocker to the old statement's", async () => {
    const staff = readers()[0]!;
    await sameSpecimens("scope=all&act=reprint", staff);
  });

  it("has an order that cannot tie, so a page cannot differ between runs", async () => {
    for (const sort of SPECIMEN_SORT_KEYS) {
      const q = { ...EMPTY_QUERY, scope: "all", sort };
      const all = await listSpecimens(db, q, people.staff!, STAFF_READER, { limit: 1000, offset: 0, hostNames: new Map() });
      const paged: number[] = [];
      for (let offset = 0; offset < all.rows.length; offset += PAGE) {
        const p = await listSpecimens(db, q, people.staff!, STAFF_READER, { limit: PAGE, offset, hostNames: new Map() });
        paged.push(...p.rows.map((r) => r.specimen_id));
      }
      expect(paged, sort).toEqual(all.rows.map((r) => r.specimen_id));
      expect(new Set(paged).size, sort).toBe(paged.length);
    }
  });
});
