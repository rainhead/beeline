// What a stored plant taxon stands for today (schema/114, beeline-rfkj.3).
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

  test("a split that is one taxon and a dead end is still a split: nothing is picked", async () => {
    await store([
      ...base,
      { id: 1, name: "Whole", rank: "species", active: false, parent: GENUS_A, replacedBy: [11, 12] },
      { id: 11, name: "Alpha a", rank: "species", active: true, parent: GENUS_A },
      { id: 12, name: "Alpha b", rank: "species", active: false, parent: GENUS_A },
    ]);
    expect((await current(1))![0]).toBe("split");
    expect((await current(1))![1]).toBeNull();
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

  test("a taxon iNaturalist no longer has is absent, though its row stays active", async () => {
    await store([...base, { id: 1, name: "Deleted", rank: "species", active: true, parent: GENUS_A }]);
    await conn.run("INSERT INTO inat_taxon_absent (inat_taxon_id) VALUES (1)");
    expect(await current(1)).toEqual(["absent", null, null, null, null, null]);
    // The verdict lapses after 30 days, as the fetcher's does.
    await conn.run("UPDATE inat_taxon_absent SET asked_at = now() - INTERVAL '31 days'");
    expect((await current(1))![0]).toBe("current");
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
    // The names are read from the copy the writers refresh (schema/115).
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
