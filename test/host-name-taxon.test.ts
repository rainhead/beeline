// Hosts with a name and no iNaturalist id, read through the taxon the name
// comes to (schema/068, schema/116, src/plant-name-key.ts, beeline-rfkj.5).
// The names are lifted from production's store of 2026-11-15 unless a line
// says otherwise; the taxa are synthetic.
import { describe, expect, test } from "vitest";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { refreshPlantCommonNames } from "../src/plant-common-names.js";
import { fetchPlantNames } from "../src/fetch-plant-names.js";
import { plantNameKey } from "../src/plant-name-key.js";

describe("plantNameKey, the page's copy of plant_name_normal's rule", () => {
  test("gives the view's answer for every kind of name the rule is about", async () => {
    const { conn } = await createMemoryDb();
    const names = [
      "Agastache \nurticifolia", // production: a line break between genus and epithet
      "Reynoutria Ã— bohemica", // production: a hybrid sign read in the wrong character set
      "Mentha × piperita",
      "Mentha piperita",
      "Carduus pycnocephalus ssp. cinereus",
      "Lepidium virginicum subsp. menziesii",
      "Eriophyllum lanatum var. integrifolium",
      "Rubus x var.y", // synthetic: an 'x' that is not a sign, and a marker with no space after it
      "  Salix\tsp. ", // synthetic: a tab, and spaces at both ends
      "Salix?",
      "Grass cover crop",
      "ASTERACEAE",
    ];
    for (const [i, n] of names.entries()) {
      await conn.run("INSERT INTO plant_name_lookup_hit VALUES ('k', 'species', $1, 'n', 'species', true, $2)", [i, n]);
    }
    const sql = Object.fromEntries((await rows(conn, "SELECT raw_name, name_key FROM plant_name_normal")) as Array<[string, string]>);
    for (const n of names) expect(plantNameKey(n), JSON.stringify(n)).toBe(sql[n]);
  });
});

describe("a sample's host read by its name", () => {
  async function store() {
    const { conn } = await createMemoryDb();
    await conn.run("INSERT INTO person (display_name) VALUES ('Collector')");
    for (const [id, name, rank, ancestors] of [
      [1, "Alpha lanata", "species", [1, 211194]],
      [2, "Beta", "genus", [2, 211194]],
    ] as const) {
      await conn.run(`INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active) VALUES (${id}, '${name}', '${rank}', 10, true)`);
      for (const [d, a] of ancestors.entries()) await conn.run(`INSERT INTO inat_taxon_ancestor VALUES (${id}, ${a}, ${d})`);
    }
    // iNaturalist's answer for the name, as the plant names job stores it.
    await conn.run("INSERT INTO plant_name_lookup (name_key, expected_rank, total_results, read_in_full) VALUES ('alpha lanata', 'species', 1, true)");
    await conn.run("INSERT INTO plant_name_lookup_hit VALUES ('alpha lanata', 'species', 1, 'Alpha lanata', 'species', true, 'Alpha lanata')");
    const sample = (n: string, id: string, name: string) =>
      insertCleanSample(conn, { sample_number: `'${n}'`, host_inat_taxon_id: id, host_name_as_observed: name, host_rank: "'species'" });
    return { conn, sample };
  }

  test("gives one row per sample, says which way the host was found, and leaves the id where it was", async () => {
    const { conn, sample } = await store();
    const byName = await sample("1", "NULL", "'Alpha lanata'");
    const byNameAgain = await sample("2", "NULL", "'alpha lanata'");
    const byId = await sample("3", "2", "'Beta'");
    // The same name as a host with an id: the id decides, the name is not looked at.
    const idWins = await sample("4", "2", "'Alpha lanata'");
    const unresolved = await sample("5", "NULL", "'Gamma nil'");
    await refreshPlantCommonNames(conn);
    expect(await rows(conn, "SELECT sample_id, inat_taxon_id, resolved_by FROM sample_host ORDER BY 1")).toEqual([
      [byName, 1n, "name"],
      [byNameAgain, 1n, "name"],
      [byId, 2n, "id"],
      [idWins, 2n, "id"],
    ]);
    expect(await rows(conn, "SELECT count(*) FROM sample WHERE host_inat_taxon_id IS NULL AND entity_id IN (SELECT sample_id FROM sample_host)")).toEqual([[2n]]);
    expect(await rows(conn, "SELECT sample_id, outcome FROM sample_host_unresolved")).toEqual([[unresolved, "not looked up"]]);
  });

  test("the copy follows each writer: a refresh after the plant names job leaves nothing stale", async () => {
    const { conn, sample } = await store();
    await sample("1", "NULL", "'Alpha lanata'");
    await sample("2", "NULL", "'Beta vulgaris'");
    expect(await rows(conn, "SELECT host_name FROM host_name_taxon_stale")).toEqual([["Alpha lanata"]]);
    // Until a refresh, the name resolves but a page cannot read it: listed, so it is not lost between the two.
    expect(await rows(conn, "SELECT count(*) FROM sample_host")).toEqual([[0n]]);
    expect(await rows(conn, "SELECT host_name, outcome FROM sample_host_unresolved ORDER BY 1")).toEqual([
      ["Alpha lanata", "not copied yet"],
      ["Beta vulgaris", "not looked up"],
    ]);
    await refreshPlantCommonNames(conn);
    expect(await rows(conn, "SELECT host_name, inat_taxon_id FROM host_name_taxon_cache")).toEqual([["Alpha lanata", 1n]]);
    // The job asks for the other name, iNaturalist answers with taxon 2, and the job's own refresh takes it in.
    const answer = { total_results: 1, page: 1, per_page: 30, results: [{ id: 2, name: "Beta vulgaris", rank: "species", is_active: true, matched_term: "Beta vulgaris" }] };
    await fetchPlantNames(conn, { fetchImpl: (async () => new Response(JSON.stringify(answer))) as typeof fetch, requestDelayMs: 0 });
    expect(await rows(conn, "SELECT count(*) FROM host_name_taxon_stale")).toEqual([[0n]]);
    expect(await rows(conn, "SELECT host_name, inat_taxon_id FROM host_name_taxon_cache ORDER BY 1")).toEqual([
      ["Alpha lanata", 1n],
      ["Beta vulgaris", 2n],
    ]);
  });

  test("a name that came to a taxon the cache has not read is not read yet, and is listed, so no sample falls between the two", async () => {
    const { conn, sample } = await store();
    await conn.run("INSERT INTO plant_name_lookup (name_key, expected_rank, total_results, read_in_full) VALUES ('gamma nil', 'species', 1, true)");
    await conn.run("INSERT INTO plant_name_lookup_hit VALUES ('gamma nil', 'species', 9, 'Gamma nil', 'species', true, 'Gamma nil')");
    const unread = await sample("1", "NULL", "'Gamma nil'");
    await refreshPlantCommonNames(conn);
    expect(await rows(conn, `SELECT count(*) FROM sample_host WHERE sample_id = ${unread}`)).toEqual([[0n]]);
    expect(await rows(conn, "SELECT sample_id, outcome, candidate_taxon_id FROM sample_host_unresolved")).toEqual([[unread, "taxon not read yet", 9n]]);
  });

  test("a name another taxon once had is read through the active taxon of that name, and listed for a person", async () => {
    // The shape of Mimulus on production (2026-11-15): the active genus of the name, and a retired one of the
    // same name that iNaturalist replaced by another genus. The lookup's rule takes the active one.
    const { conn, sample } = await store();
    await conn.run("INSERT INTO plant_name_lookup (name_key, expected_rank, total_results, read_in_full) VALUES ('beta', 'genus', 2, true)");
    await conn.run("INSERT INTO plant_name_lookup_hit VALUES ('beta', 'genus', 2, 'Beta', 'genus', true, 'Beta'), ('beta', 'genus', 8, 'Beta', 'genus', false, 'Beta')");
    await conn.run("INSERT INTO plant_name_lookup_hit_replacement VALUES ('beta', 'genus', 8, 1)");
    const once = await sample("1", "NULL", "'Beta'");
    await refreshPlantCommonNames(conn);
    expect(await rows(conn, `SELECT resolved_by, inat_taxon_id FROM sample_host WHERE sample_id = ${once}`)).toEqual([["name", 2n]]);
    expect(await rows(conn, "SELECT sample_id, outcome, candidate_taxon_id FROM sample_host_unresolved")).toEqual([[once, "other taxa had this name", 2n]]);
  });

  test("a retired hit whose replacement was itself replaced by the winning taxon names no other plant, and is not listed", async () => {
    // The lookup's answer said hit 8 was replaced by taxon 1; the taxon cache has since read 1 as retired and
    // replaced by 2, the active taxon of the name. Followed to the end, both hits are taxon 2.
    const { conn, sample } = await store();
    await conn.run("UPDATE inat_taxon SET is_active = false WHERE inat_taxon_id = 1");
    await conn.run("INSERT INTO inat_taxon_replacement VALUES (1, 2)");
    await conn.run("INSERT INTO plant_name_lookup (name_key, expected_rank, total_results, read_in_full) VALUES ('beta', 'genus', 2, true)");
    await conn.run("INSERT INTO plant_name_lookup_hit VALUES ('beta', 'genus', 2, 'Beta', 'genus', true, 'Beta'), ('beta', 'genus', 8, 'Beta', 'genus', false, 'Beta')");
    await conn.run("INSERT INTO plant_name_lookup_hit_replacement VALUES ('beta', 'genus', 8, 1)");
    const same = await sample("1", "NULL", "'Beta'");
    await refreshPlantCommonNames(conn);
    expect(await rows(conn, `SELECT resolved_by, inat_taxon_id FROM sample_host WHERE sample_id = ${same}`)).toEqual([["name", 2n]]);
    expect(await rows(conn, "SELECT count(*) FROM sample_host_unresolved")).toEqual([[0n]]);
  });

  test("a name whose taxon is a plant but not a vascular one is read, and listed for a person", async () => {
    // Synthetic: no host name on production resolves to a moss (2026-11-15), but the lookups search all plants.
    const { conn, sample } = await store();
    await conn.run("INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active) VALUES (3, 'Muscus', 'genus', 20, true)");
    await conn.run("INSERT INTO inat_taxon_ancestor VALUES (3, 3, 0), (3, 47126, 1)");
    await conn.run("INSERT INTO plant_name_lookup (name_key, expected_rank, total_results, read_in_full) VALUES ('muscus', 'genus', 1, true)");
    await conn.run("INSERT INTO plant_name_lookup_hit VALUES ('muscus', 'genus', 3, 'Muscus', 'genus', true, 'Muscus')");
    const moss = await sample("1", "NULL", "'Muscus'");
    await refreshPlantCommonNames(conn);
    expect(await rows(conn, `SELECT resolved_by, is_vascular FROM sample_host WHERE sample_id = ${moss}`)).toEqual([["name", false]]);
    expect(await rows(conn, "SELECT sample_id, outcome, candidate_taxon_id FROM sample_host_unresolved")).toEqual([[moss, "not a vascular plant", 3n]]);
  });
});
