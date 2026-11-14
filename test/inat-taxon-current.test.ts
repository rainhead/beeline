// What a stored plant taxon stands for today (schema/113, beeline-rfkj.3).
// The taxa are synthetic except where a name says otherwise: the ids and names of
// the real cases (322554 replaced by 79294, 1588297 split in three) are the ones
// captured in test/fixtures/inat-taxa/, and the lineage around them is made up.
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { refreshPlantCommonNames } from "../src/plant-common-names.js";
import { createMemoryDb, insertCleanSample } from "./helpers.js";

let conn: DuckDBConnection;
let instance: DuckDBInstance;
beforeEach(async () => {
  ({ conn, instance } = await createMemoryDb());
});
afterEach(() => {
  conn.closeSync();
  instance.closeSync();
});

const rows = async (sql: string) =>
  ((await (await conn.run(sql)).getRows()) as unknown[][]).map((r) => r.map((v) => (typeof v === "bigint" ? Number(v) : v)));

const LIFE = 48460;
const FAMILY_A = 100; // Asteraceae-like
const FAMILY_B = 101;
const GENUS_A = 110;
const GENUS_B = 111;
const GENUS_C = 112; // in family B

type Taxon = { id: number; name: string; rank: string; active: boolean; parent?: number; replacedBy?: number[]; oregon?: string | null };

/** Stores a taxon with its lineage (itself at depth 0, then each ancestor as `parent` says). */
async function store(taxa: Taxon[]) {
  const byId = new Map(taxa.map((t) => [t.id, t]));
  for (const t of taxa) {
    await conn.run(
      `INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, parent_id, is_active, preferred_common_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [t.id, t.name, t.rank, { species: 10, genus: 20, family: 30, subspecies: 5, kingdom: 70 }[t.rank] ?? 10, t.parent ?? null, t.active, t.oregon ?? null],
    );
    for (const r of t.replacedBy ?? []) await conn.run("INSERT INTO inat_taxon_replacement VALUES ($1, $2)", [t.id, r]);
    let depth = 0;
    for (let at: Taxon | undefined = t; at; at = at.parent === undefined ? undefined : byId.get(at.parent)) {
      await conn.run("INSERT INTO inat_taxon_ancestor VALUES ($1, $2, $3)", [t.id, at.id, depth++]);
    }
  }
}

const base: Taxon[] = [
  { id: FAMILY_A, name: "Familia alpha", rank: "family", active: true },
  { id: FAMILY_B, name: "Familia beta", rank: "family", active: true },
  { id: GENUS_A, name: "Alpha", rank: "genus", active: true, parent: FAMILY_A },
  { id: GENUS_B, name: "Beta", rank: "genus", active: true, parent: FAMILY_A },
  { id: GENUS_C, name: "Gamma", rank: "genus", active: true, parent: FAMILY_B },
];

const current = async (id: number) =>
  (await rows(
    `SELECT standing, current_taxon_id, current_name, current_rank, genus_name, family_name FROM inat_taxon_current WHERE inat_taxon_id = ${id}`,
  ))[0];

describe("inat_taxon_current: standing", () => {
  test("an active taxon is its own current taxon, with its genus and family", async () => {
    await store([...base, { id: 1, name: "Alpha one", rank: "species", active: true, parent: GENUS_A }]);
    expect(await current(1)).toEqual(["current", 1, "Alpha one", "species", "Alpha", "Familia alpha"]);
  });

  test("a taxon at genus or family rank is its own genus or family, and has none above", async () => {
    await store(base);
    expect(await current(GENUS_A)).toEqual(["current", GENUS_A, "Alpha", "genus", "Alpha", "Familia alpha"]);
    expect(await current(FAMILY_A)).toEqual(["current", FAMILY_A, "Familia alpha", "family", null, "Familia alpha"]);
  });

  test("a replaced taxon takes the current taxon's name, rank, genus and family, not its own stale lineage", async () => {
    // 322554 is a subspecies iNaturalist replaced with a species in another genus;
    // its stored parent still names the old one.
    await store([
      ...base,
      { id: 10, name: "Alpha old", rank: "species", active: true, parent: GENUS_A },
      { id: 322554, name: "Alpha old gamma", rank: "subspecies", active: false, parent: 10, replacedBy: [79294] },
      { id: 79294, name: "Gamma new", rank: "species", active: true, parent: GENUS_C },
    ]);
    expect(await current(322554)).toEqual(["replaced", 79294, "Gamma new", "species", "Gamma", "Familia beta"]);
  });

  test("a taxon replaced by a genus is set as the genus: the current taxon's rank is what is reported", async () => {
    await store([
      ...base,
      { id: 887293, name: "Old genus", rank: "genus", active: false, parent: FAMILY_A, replacedBy: [742759] },
      { id: 742759, name: "Section gamma", rank: "section", active: true, parent: GENUS_C },
    ]);
    expect(await current(887293)).toEqual(["replaced", 742759, "Section gamma", "section", "Gamma", "Familia beta"]);
  });

  test("a chain of replacements is followed to its end", async () => {
    await store([
      ...base,
      { id: 1, name: "First", rank: "species", active: false, parent: GENUS_A, replacedBy: [2] },
      { id: 2, name: "Second", rank: "species", active: false, parent: GENUS_A, replacedBy: [3] },
      { id: 3, name: "Third", rank: "species", active: true, parent: GENUS_B },
    ]);
    expect(await current(1)).toEqual(["replaced", 3, "Third", "species", "Beta", "Familia alpha"]);
    expect(await current(2)).toEqual(["replaced", 3, "Third", "species", "Beta", "Familia alpha"]);
  });

  test("a chain that loops back on itself ends, and is retired", async () => {
    await store([
      ...base,
      { id: 1, name: "One", rank: "species", active: false, parent: GENUS_A, replacedBy: [2] },
      { id: 2, name: "Two", rank: "species", active: false, parent: GENUS_A, replacedBy: [1] },
    ]);
    expect(await current(1)).toEqual(["retired", null, null, null, null, null]);
  });

  test("a split within one genus has no current taxon but names the genus and family", async () => {
    // 1588297 is a real species split into three; the three share a genus here.
    await store([
      ...base,
      { id: 1588297, name: "Alpha whole", rank: "species", active: false, parent: GENUS_A, replacedBy: [11, 12, 13] },
      { id: 11, name: "Alpha a", rank: "species", active: true, parent: GENUS_A },
      { id: 12, name: "Alpha b", rank: "species", active: true, parent: GENUS_A },
      { id: 13, name: "Alpha c", rank: "species", active: true, parent: GENUS_A },
    ]);
    expect(await current(1588297)).toEqual(["split", null, null, null, "Alpha", "Familia alpha"]);
  });

  test("a split across genera shares the family where it does, and nothing where it does not", async () => {
    await store([
      ...base,
      { id: 1, name: "Whole", rank: "species", active: false, parent: GENUS_A, replacedBy: [11, 12] },
      { id: 11, name: "Alpha a", rank: "species", active: true, parent: GENUS_A },
      { id: 12, name: "Beta b", rank: "species", active: true, parent: GENUS_B },
      { id: 2, name: "Whole two", rank: "species", active: false, parent: GENUS_A, replacedBy: [11, 14] },
      { id: 14, name: "Gamma d", rank: "species", active: true, parent: GENUS_C },
    ]);
    expect(await current(1)).toEqual(["split", null, null, null, null, "Familia alpha"]);
    expect(await current(2)).toEqual(["split", null, null, null, null, null]);
  });

  test("a split into a species and a family has no genus: one of them has none to share", async () => {
    await store([
      ...base,
      { id: 1, name: "Whole", rank: "species", active: false, parent: GENUS_A, replacedBy: [11, FAMILY_A] },
      { id: 11, name: "Alpha a", rank: "species", active: true, parent: GENUS_A },
    ]);
    expect(await current(1)).toEqual(["split", null, null, null, null, "Familia alpha"]);
  });

  test("one active taxon beside a dead end is retired: it might be half of a split, so nothing is picked", async () => {
    await store([
      ...base,
      { id: 1, name: "Whole", rank: "species", active: false, parent: GENUS_A, replacedBy: [11, 12] },
      { id: 11, name: "Alpha a", rank: "species", active: true, parent: GENUS_A },
      { id: 12, name: "Alpha b", rank: "species", active: false, parent: GENUS_A },
    ]);
    expect(await current(1)).toEqual(["retired", null, null, null, null, null]);
  });

  test("a split is more than one active taxon, whatever dead end sits beside them, and its genus and family are theirs", async () => {
    await store([
      ...base,
      { id: 1, name: "Whole", rank: "species", active: false, parent: GENUS_A, replacedBy: [11, 12, 13] },
      { id: 11, name: "Alpha a", rank: "species", active: true, parent: GENUS_A },
      { id: 12, name: "Alpha b", rank: "species", active: true, parent: GENUS_A },
      { id: 13, name: "Alpha gone", rank: "species", active: false, parent: GENUS_B },
    ]);
    // The dead end is in another genus and does not count against the two that share one.
    expect(await current(1)).toEqual(["split", null, null, null, "Alpha", "Familia alpha"]);
  });

  test("a diamond, two branches that come to the same taxon, is replaced by it and not split", async () => {
    await store([
      ...base,
      { id: 1, name: "Top", rank: "species", active: false, parent: GENUS_A, replacedBy: [2, 3] },
      { id: 2, name: "Left", rank: "species", active: false, parent: GENUS_A, replacedBy: [4] },
      { id: 3, name: "Right", rank: "species", active: false, parent: GENUS_A, replacedBy: [4] },
      { id: 4, name: "Bottom", rank: "species", active: true, parent: GENUS_B },
    ]);
    expect(await current(1)).toEqual(["replaced", 4, "Bottom", "species", "Beta", "Familia alpha"]);
  });

  test("a retired taxon with no replacement, or only a dead end, is retired and says nothing about its lineage", async () => {
    await store([
      ...base,
      { id: 1, name: "Gone", rank: "species", active: false, parent: GENUS_A },
      { id: 2, name: "Gone too", rank: "species", active: false, parent: GENUS_A, replacedBy: [1] },
    ]);
    expect(await current(1)).toEqual(["retired", null, null, null, null, null]);
    expect(await current(2)).toEqual(["retired", null, null, null, null, null]);
  });

  test("a chain that reaches a taxon the cache has not read is pending, not retired", async () => {
    await store([...base, { id: 1, name: "Whole", rank: "species", active: false, parent: GENUS_A, replacedBy: [999] }]);
    expect(await current(1)).toEqual(["pending", null, null, null, null, null]);
    // One read and one not: nothing is said until the rest is known.
    await store([{ id: 11, name: "Alpha a", rank: "species", active: true, parent: GENUS_A }]);
    await conn.run("INSERT INTO inat_taxon_replacement VALUES (1, 11)");
    expect(await current(1)).toEqual(["pending", null, null, null, null, null]);
  });

  test("a taxon that is not cached has no row, so a page falls back to the name as observed", async () => {
    await store(base);
    expect(await rows("SELECT * FROM inat_taxon_current WHERE inat_taxon_id = 424242")).toEqual([]);
  });

  test("a taxon iNaturalist no longer has is absent, though its row stays active, until a fetch returns it", async () => {
    await store([...base, { id: 1, name: "Deleted", rank: "species", active: true, parent: GENUS_A }]);
    await conn.run("INSERT INTO inat_taxon_absent (inat_taxon_id) VALUES (1)");
    expect(await current(1)).toEqual(["absent", null, null, null, null, null]);
    // The 30 days of inat_taxon_known_absent say when the fetcher asks again, not that iNaturalist has changed its
    // answer: until the fetch returns the taxon (and removes the row), it stays absent.
    await conn.run("UPDATE inat_taxon_absent SET asked_at = now() - INTERVAL '31 days'");
    expect((await current(1))![0]).toBe("absent");
    await conn.run("DELETE FROM inat_taxon_absent WHERE inat_taxon_id = 1");
    expect((await current(1))![0]).toBe("current");
  });

  test("a replacement iNaturalist does not have is a dead end, whether or not the cache holds a row for it", async () => {
    await store([
      ...base,
      // 2 was never cached; 3 was cached active and has since gone.
      { id: 1, name: "Whole", rank: "species", active: false, parent: GENUS_A, replacedBy: [2] },
      { id: 4, name: "Whole too", rank: "species", active: false, parent: GENUS_A, replacedBy: [3] },
      { id: 3, name: "Alpha three", rank: "species", active: true, parent: GENUS_A },
    ]);
    // Not asked yet: pending. Asked and not returned: retired, not pending and not current.
    expect((await current(1))![0]).toBe("pending");
    await conn.run("INSERT INTO inat_taxon_absent (inat_taxon_id) VALUES (2)");
    await conn.run("INSERT INTO inat_taxon_absent (inat_taxon_id) VALUES (3)");
    expect(await current(1)).toEqual(["retired", null, null, null, null, null]);
    expect(await current(4)).toEqual(["retired", null, null, null, null, null]);
    expect(await rows("SELECT retired_taxon_id, end_taxon_id, end_kind FROM inat_taxon_replacement_end WHERE retired_taxon_id IN (1, 4) ORDER BY 1")).toEqual([
      [1, 2, "absent"],
      [4, 3, "absent"],
    ]);
  });

  test("an absent replacement beside an active one leaves nothing picked, and beside two it is a split", async () => {
    await store([
      ...base,
      { id: 1, name: "Whole", rank: "species", active: false, parent: GENUS_A, replacedBy: [11, 12] },
      { id: 2, name: "Whole two", rank: "species", active: false, parent: GENUS_A, replacedBy: [11, 13, 12] },
      { id: 11, name: "Alpha a", rank: "species", active: true, parent: GENUS_A },
      { id: 13, name: "Alpha c", rank: "species", active: true, parent: GENUS_A },
    ]);
    await conn.run("INSERT INTO inat_taxon_absent (inat_taxon_id) VALUES (12)");
    expect((await current(1))![0]).toBe("retired");
    expect(await current(2)).toEqual(["split", null, null, null, "Alpha", "Familia alpha"]);
  });

  test("a chain does not go on through a taxon that is absent", async () => {
    await store([
      ...base,
      { id: 1, name: "One", rank: "species", active: false, parent: GENUS_A, replacedBy: [2] },
      { id: 2, name: "Two", rank: "species", active: false, parent: GENUS_A, replacedBy: [3] },
      { id: 3, name: "Three", rank: "species", active: true, parent: GENUS_A },
    ]);
    expect((await current(1))![0]).toBe("replaced");
    await conn.run("INSERT INTO inat_taxon_absent (inat_taxon_id) VALUES (2)");
    expect((await current(1))![0]).toBe("retired");
    expect((await current(2))![0]).toBe("absent");
  });

  test("a reinstated taxon is current again once the fetcher has rewritten its row", async () => {
    await store([
      ...base,
      { id: 1, name: "Flip", rank: "species", active: false, parent: GENUS_A, replacedBy: [2] },
      { id: 2, name: "Flop", rank: "species", active: true, parent: GENUS_A },
    ]);
    expect((await current(1))![0]).toBe("replaced");
    await conn.run("UPDATE inat_taxon SET is_active = true WHERE inat_taxon_id = 1");
    await conn.run("DELETE FROM inat_taxon_replacement WHERE retired_taxon_id = 1");
    expect(await current(1)).toEqual(["current", 1, "Flip", "species", "Alpha", "Familia alpha"]);
  });
});

describe("inat_taxon_current: lineage through current resolution", () => {
  const PLANTAE = 47126;
  const TRACHEOPHYTA = 211194;
  const lineageOf = async (id: number) =>
    (await rows(`SELECT standing, genus_name, family_name, is_plant, is_vascular FROM inat_taxon_current WHERE inat_taxon_id = ${id}`))[0];

  test("a genus in a lineage that iNaturalist has retired is the genus that replaced it, never the retired one", async () => {
    // The species is current; its stored lineage still runs through Old genus, replaced by Alpha.
    await store([
      ...base,
      { id: 120, name: "Old genus", rank: "genus", active: false, parent: FAMILY_A, replacedBy: [GENUS_A] },
      { id: 1, name: "Old genus one", rank: "species", active: true, parent: 120 },
    ]);
    expect(await lineageOf(1)).toEqual(["current", "Alpha", "Familia alpha", false, false]);
    // The stored taxon, retired, is judged by the current taxon's lineage as well.
    await store([{ id: 2, name: "Old genus two", rank: "species", active: false, parent: 120, replacedBy: [1] }]);
    expect((await lineageOf(2))![1]).toBe("Alpha");
  });

  test("a retired genus that came to several genera, to nothing, or to a taxon that is not a genus names none", async () => {
    await store([
      ...base,
      { id: 120, name: "Split genus", rank: "genus", active: false, parent: FAMILY_A, replacedBy: [GENUS_A, GENUS_B] },
      { id: 121, name: "Lost genus", rank: "genus", active: false, parent: FAMILY_A },
      { id: 122, name: "Genus to section", rank: "genus", active: false, parent: FAMILY_A, replacedBy: [742759] },
      { id: 742759, name: "Section gamma", rank: "section", active: true, parent: GENUS_C },
      { id: 1, name: "Split genus one", rank: "species", active: true, parent: 120 },
      { id: 2, name: "Lost genus one", rank: "species", active: true, parent: 121 },
      { id: 3, name: "Sectioned one", rank: "species", active: true, parent: 122 },
    ]);
    // The family above them is active and is still given.
    expect(await lineageOf(1)).toEqual(["current", null, "Familia alpha", false, false]);
    expect(await lineageOf(2)).toEqual(["current", null, "Familia alpha", false, false]);
    expect(await lineageOf(3)).toEqual(["current", null, "Familia alpha", false, false]);
  });

  test("a retired family is resolved the same way", async () => {
    await store([
      { id: 102, name: "Old family", rank: "family", active: false, replacedBy: [FAMILY_B] },
      { id: FAMILY_B, name: "Familia beta", rank: "family", active: true },
      { id: GENUS_C, name: "Gamma", rank: "genus", active: true, parent: 102 },
      { id: 1, name: "Gamma one", rank: "species", active: true, parent: GENUS_C },
    ]);
    expect(await lineageOf(1)).toEqual(["current", "Gamma", "Familia beta", false, false]);
  });

  test("a current taxon never has a retired genus or family, whatever its stored lineage says", async () => {
    await store([
      ...base,
      { id: 120, name: "Old genus", rank: "genus", active: false, parent: FAMILY_A, replacedBy: [GENUS_A] },
      { id: 121, name: "Lost genus", rank: "genus", active: false, parent: FAMILY_A },
      { id: 1, name: "One", rank: "species", active: true, parent: 120 },
      { id: 2, name: "Two", rank: "species", active: true, parent: 121 },
      { id: 3, name: "Three", rank: "species", active: true, parent: GENUS_B },
    ]);
    expect(
      await rows(`SELECT count(*) FROM inat_taxon_current c
                  JOIN inat_taxon g ON g.inat_taxon_id IN (c.genus_taxon_id, c.family_taxon_id) AND NOT g.is_active
                  WHERE c.standing IN ('current', 'replaced')`),
    ).toEqual([[0]]);
  });

  test("is_plant and is_vascular follow the current taxon's lineage, not the retired one's", async () => {
    await store([
      { id: LIFE, name: "Life", rank: "kingdom", active: true },
      { id: PLANTAE, name: "Plantae", rank: "kingdom", active: true, parent: LIFE },
      { id: TRACHEOPHYTA, name: "Tracheophyta", rank: "phylum", active: true, parent: PLANTAE },
      { id: 300, name: "Animalia", rank: "kingdom", active: true, parent: LIFE },
      { id: 301, name: "Mossfamily", rank: "family", active: true, parent: PLANTAE },
      { id: 302, name: "Ferny", rank: "family", active: true, parent: TRACHEOPHYTA },
      { id: 303, name: "Bugfamily", rank: "family", active: true, parent: 300 },
      { id: 1, name: "Moss one", rank: "species", active: true, parent: 301 },
      { id: 2, name: "Fern one", rank: "species", active: true, parent: 302 },
      { id: 3, name: "Bug one", rank: "species", active: true, parent: 303 },
      // Stored as a bug, replaced by a fern: the fern's lineage is the answer.
      { id: 4, name: "Bug old", rank: "species", active: false, parent: 303, replacedBy: [2] },
      // A split into a fern and a moss is a plant, and a vascular one only if both are.
      { id: 5, name: "Both old", rank: "species", active: false, parent: 303, replacedBy: [1, 2] },
      // A split into a fern and a bug is not.
      { id: 6, name: "Mixed old", rank: "species", active: false, parent: 303, replacedBy: [2, 3] },
    ]);
    expect(await lineageOf(1)).toEqual(["current", null, "Mossfamily", true, false]);
    expect(await lineageOf(2)).toEqual(["current", null, "Ferny", true, true]);
    expect(await lineageOf(3)).toEqual(["current", null, "Bugfamily", false, false]);
    expect(await lineageOf(4)).toEqual(["replaced", null, "Ferny", true, true]);
    expect(await lineageOf(5)).toEqual(["split", null, null, true, false]);
    expect(await lineageOf(6)).toEqual(["split", null, null, false, false]);
    // Nothing is said of a taxon with no current taxon or with no lineage cached.
    await store([{ id: 7, name: "Gone", rank: "species", active: false }]);
    expect(await lineageOf(7)).toEqual(["retired", null, null, null, null]);
    await conn.run("INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active) VALUES (8, 'Bare', 'species', 10, true)");
    expect(await lineageOf(8)).toEqual(["current", null, null, null, null]);
  });
});

// The old plant list's entry for a taxon, as its lookup came to it (the tables
// the fetcher fills, seeded directly: the lookup itself is test/plant-list.test.ts).
async function listEntry(scientific: string, common: string, taxonId: number, rank = "species") {
  await conn.run("INSERT INTO plant_list_entry (list_key, scientific_name, rank, common_name) VALUES ('old-beeline', $1, $2, $3)", [scientific, rank, common]);
  const key = scientific.toLowerCase();
  await conn.run("INSERT INTO plant_name_lookup (name_key, expected_rank, total_results, read_in_full) VALUES ($1, $2, 1, true)", [key, rank]);
  await conn.run("INSERT INTO plant_name_lookup_hit VALUES ($1, $2, $3, $4, $2, true, $4)", [key, rank, taxonId, scientific]);
}

const named = async (id: number) =>
  (await rows(`SELECT standing, current_name, common_name, common_name_source FROM inat_taxon_current_named WHERE inat_taxon_id = ${id}`))[0];

describe("inat_taxon_current_named: the common name is the current taxon's", () => {
  const taxa: Taxon[] = [
    ...base,
    { id: 1, name: "Alpha listed", rank: "species", active: true, parent: GENUS_A, oregon: "iNat alpha" },
    { id: 2, name: "Alpha inat", rank: "species", active: true, parent: GENUS_A, oregon: "iNat two" },
    { id: 3, name: "Alpha bare", rank: "species", active: true, parent: GENUS_A },
    // 322554 (replaced by 79294) is the real case; the names are made up.
    { id: 322554, name: "Alpha old", rank: "subspecies", active: false, parent: 2, replacedBy: [1], oregon: "old name nobody uses" },
    { id: 20, name: "Alpha whole", rank: "species", active: false, parent: GENUS_A, replacedBy: [1, 2] },
    { id: 21, name: "Alpha gone", rank: "species", active: false, parent: GENUS_A },
  ];
  beforeEach(async () => {
    await store(taxa);
    await listEntry("Alpha listed", "listed name, second name", 1);
    // The names are read from the copy the writers refresh (schema/068).
    await refreshPlantCommonNames(conn);
  });

  test("the list's name for a taxon wins, and iNaturalist's name stands where the list has none", async () => {
    expect(await named(1)).toEqual(["current", "Alpha listed", "listed name", "list"]);
    expect(await named(2)).toEqual(["current", "Alpha inat", "iNat two", "inaturalist"]);
    expect(await named(3)).toEqual(["current", "Alpha bare", null, null]);
  });

  test("a replaced host is named for the taxon it is now, not for the retired one", async () => {
    // The retired taxon has an Oregon name of its own and its stored parent is species 2, which has another:
    // neither is used.
    expect(await named(322554)).toEqual(["replaced", "Alpha listed", "listed name", "list"]);
  });

  test("a split, a retired taxon with no replacement and an absent taxon have no common name", async () => {
    expect(await named(20)).toEqual(["split", null, null, null]);
    expect(await named(21)).toEqual(["retired", null, null, null]);
    await conn.run("INSERT INTO inat_taxon_absent (inat_taxon_id) VALUES (2)");
    expect(await named(2)).toEqual(["absent", null, null, null]);
  });
});

describe("a list entry follows its taxon's replacement", () => {
  const taxa: Taxon[] = [
    ...base,
    { id: 1, name: "Alpha new", rank: "species", active: true, parent: GENUS_A },
    { id: 2, name: "Alpha child", rank: "subspecies", active: true, parent: 1 },
    { id: 3, name: "Beta other", rank: "species", active: true, parent: GENUS_B },
    { id: 10, name: "Alpha old", rank: "species", active: false, parent: GENUS_A, replacedBy: [1] },
  ];
  const commonName = async (id: number) => (await rows(`SELECT common_name, list_entry, list_entry_depth FROM plant_taxon_common_name WHERE inat_taxon_id = ${id}`))[0];

  test("an entry whose taxon was replaced covers the hosts beneath the replacement", async () => {
    await store(taxa);
    // The list names the retired taxon; its lookup came to it.
    await listEntry("Alpha old", "old alpha name", 10);
    expect(await commonName(1)).toEqual(["old alpha name", "Alpha old", 0]);
    expect(await commonName(2)).toEqual(["old alpha name", "Alpha old", 1]);
    expect(await commonName(3)).toBeUndefined();
  });

  test("an entry for a genus that was replaced covers what lies under the new genus, through a retired genus in a lineage too", async () => {
    await store([
      ...taxa,
      { id: 120, name: "Oldgenus", rank: "genus", active: false, parent: FAMILY_A, replacedBy: [GENUS_A] },
      { id: 4, name: "Oldgenus one", rank: "species", active: true, parent: 120 },
    ]);
    await listEntry("Oldgenus", "old genus name", 120, "genus");
    // Alpha species sit under the new genus; the one whose own lineage names the retired genus still matches.
    expect(await commonName(1)).toEqual(["old genus name", "Oldgenus", 1]);
    expect(await commonName(4)).toEqual(["old genus name", "Oldgenus", 1]);
    expect(await commonName(3)).toBeUndefined();
  });

  test("an entry whose taxon was split, or has nothing to replace it, covers nothing", async () => {
    await store([
      ...taxa,
      { id: 20, name: "Alpha split", rank: "species", active: false, parent: GENUS_A, replacedBy: [1, 3] },
      { id: 21, name: "Alpha lost", rank: "species", active: false, parent: GENUS_A },
    ]);
    await listEntry("Alpha split", "split name", 20);
    await listEntry("Alpha lost", "lost name", 21);
    expect(await commonName(1)).toBeUndefined();
    expect(await commonName(3)).toBeUndefined();
    expect(await rows("SELECT count(*) FROM plant_taxon_common_name WHERE list_entry IN ('Alpha split', 'Alpha lost')")).toEqual([[0]]);
  });
});

describe("sample_host", () => {
  test("one row per sample whose host is cached, with the current taxon, and none for the rest", async () => {
    await conn.run("INSERT INTO person (display_name, given_name, family_name) VALUES ('Ada Adams', 'Ada', 'Adams')");
    await store([
      ...base,
      { id: 1, name: "Alpha new", rank: "species", active: true, parent: GENUS_A, oregon: "new alpha" },
      { id: 2, name: "Alpha old", rank: "species", active: false, parent: GENUS_A, replacedBy: [1] },
    ]);
    const current = await insertCleanSample(conn, { sample_number: "'1'", host_inat_taxon_id: "1", host_name_as_observed: "'Alpha new'", host_rank: "'species'" });
    const replaced = await insertCleanSample(conn, { sample_number: "'2'", host_inat_taxon_id: "2", host_name_as_observed: "'Alpha old'", host_rank: "'species'" });
    const uncached = await insertCleanSample(conn, { sample_number: "'3'", host_inat_taxon_id: "999", host_name_as_observed: "'Elsewhere'", host_rank: "'species'" });
    const nameOnly = await insertCleanSample(conn, { sample_number: "'4'", host_name_as_observed: "'Alpha new'", host_rank: "'species'" });
    const none = await insertCleanSample(conn, { sample_number: "'5'" });
    await refreshPlantCommonNames(conn);
    expect(await rows("SELECT sample_id, inat_taxon_id, standing, current_name, common_name FROM sample_host ORDER BY sample_id")).toEqual([
      [current, 1, "current", "Alpha new", "new alpha"],
      [replaced, 2, "replaced", "Alpha new", "new alpha"],
    ]);
    expect([uncached, nameOnly, none].every((id) => typeof id === "number")).toBe(true);
  });
});
