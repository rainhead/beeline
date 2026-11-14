// Old Beeline's plant list and what iNaturalist says about its names
// (schema/067, schema/111, src/load-plant-list.ts, src/fetch-plant-names.ts,
// beeline-rfkj.2). The names are lifted from the real file
// (ingest/old-beeline-plant-list.csv); the answers in
// test/fixtures/plant-names/answers.json are captured from the real API
// (v1 /taxa, is_active=any) on 2026-11-14, so the shapes and the surprises
// are iNaturalist's: a hybrid that the list writes without its sign, a name
// two taxa claim, a retired subspecies. Taxa and lineages that were not
// captured are synthetic, and say so.
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, test } from "vitest";
import { refreshPlantNames } from "../src/app/jobs/registry.js";
import { fetchPlantNames } from "../src/fetch-plant-names.js";
import { loadPlantList, OLD_BEELINE_PLANT_LIST_FILE, parsePlantList } from "../src/load-plant-list.js";
import { createMemoryDb } from "./helpers.js";

const ANSWERS: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("./fixtures/plant-names/answers.json", import.meta.url), "utf8"),
);

let conn: DuckDBConnection;
let asked: string[];

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  asked = [];
});

const rows = async (sql: string) =>
  ((await (await conn.run(sql)).getRows()) as unknown[][]).map((r) => r.map((v) => (typeof v === "bigint" ? Number(v) : v)));

/** The API as iNaturalist answered, by the name and ranks asked for; a name that was not captured has no hits, as the real one does for a name it does not know. */
function api(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url.toString());
    const key = `${url.searchParams.get("q")}|${url.searchParams.get("rank")}`;
    return new Response(JSON.stringify(ANSWERS[key] ?? { total_results: 0, page: 1, per_page: 30, results: [] }));
  }) as typeof fetch;
}

async function addEntries(...entries: Array<[name: string, rank: string, common: string | null]>) {
  for (const [name, rank, common] of entries) {
    await conn.run("INSERT INTO plant_list_entry (list_key, scientific_name, rank, common_name) VALUES ('old-beeline', $1, $2, $3)", [
      name,
      rank,
      common,
    ]);
  }
}

// Rows of the real file, with the quirks that matter: the file's own rank
// column is wrong for Poaceae (a family filed as a genus) and Apocynum (a
// genus filed as a family), a species is written without its hybrid sign,
// an infraspecific name carries ssp., a cell lists several common names, and
// the genus Abelia has a placeholder where a common name would be.
const REAL_ROWS: Array<[string, string, string | null]> = [
  ["Abelia chinensis", "Species", "glossy abelia"],
  ["Abelia", "Genus", "Abelia Species"],
  ["Aster chilensis", "Species", "Chilean aster"], // synthetic common name; the name is real, and is an older name of Symphyotrichum chilense
  ["Mentha piperita", "Species", "peppermint"],
  ["Carduus pycnocephalus ssp. cinereus", "Subspecies", "Turkish thistle, ashen thistle"],
  ["Poaceae", "Genus", "grass"], // synthetic common name
  ["Apocynum", "Family", "dogbane"],
  ["Urtica dioica", "Species", "stinging nettle"],
  ["Urtica dioica gracilis", "Species", "Northwest nettle"],
  ["Acer macrophyllum", "Species", "bigleaf maple, Oregon maple"],
  ["Veronica peregrina xalapensis", "Subspecies", "purslane speedwell"], // synthetic common name
  ["Salix lasiolepis", "Species", "arroyo willow"], // synthetic common name; iNaturalist's answer names the taxon but matches it under another term
  ["Brassicoidae", "Subfamily", null], // no iNaturalist taxon of this name: the list's spelling of a subfamily
];

describe("loading the list", () => {
  test("the real file parses, and its one row without a name is skipped", () => {
    const { rows: parsed, skippedWithoutName } = parsePlantList(readFileSync(OLD_BEELINE_PLANT_LIST_FILE));
    expect(parsed).toHaveLength(1404);
    expect(skippedWithoutName).toBe(1);
    const nettle = parsed.find((r) => r.scientific_name === "Acer macrophyllum")!;
    expect(nettle).toMatchObject({ rank: "Species", family: "Sapindaceae", synonym: null, common_name: "bigleaf maple, Oregon maple" });
  });

  async function listFile(text: string) {
    const dir = await mkdtemp(join(tmpdir(), "beeline-plant-list-"));
    const path = join(dir, "list.csv");
    await writeFile(path, text);
    return path;
  }
  const HEADER = "Rank,Family,Scientific_name,Synonym,Common_name\n";

  test("a byte order mark and CRLF line ends do not become part of a name; empty cells are null", async () => {
    const path = await listFile(`\uFEFF${HEADER}Species,Rosaceae,Rubus idaeus,,red raspberry\nFamily,,,,heath\n`.replaceAll("\n", "\r\n"));
    const r = await loadPlantList(conn, { path });
    expect(r).toEqual({ changed: true, entries: 1, skippedWithoutName: 1 });
    expect(await rows("SELECT scientific_name, rank, family, synonym, common_name FROM plant_list_entry")).toEqual([
      ["Rubus idaeus", "Species", "Rosaceae", null, "red raspberry"],
    ]);
  });

  test("an unchanged file is not loaded again, and a changed one replaces the entries", async () => {
    const path = await listFile(`${HEADER}Species,Rosaceae,Rubus idaeus,,red raspberry\nSpecies,Rosaceae,Rubus ursinus,,Pacific blackberry\n`);
    expect((await loadPlantList(conn, { path })).changed).toBe(true);
    const loadedAt = (await rows("SELECT loaded_at FROM plant_list"))[0]![0];
    expect((await loadPlantList(conn, { path })).changed).toBe(false);
    expect(await rows("SELECT loaded_at FROM plant_list")).toEqual([[loadedAt]]);

    await writeFile(path, `${HEADER}Species,Rosaceae,Rubus idaeus,,raspberry\n`);
    expect((await loadPlantList(conn, { path })).changed).toBe(true);
    // The removed entry is gone, and the kept one says what the file now says.
    expect(await rows("SELECT scientific_name, common_name FROM plant_list_entry")).toEqual([["Rubus idaeus", "raspberry"]]);
  });

  test("a malformed file changes nothing", async () => {
    const good = await listFile(`${HEADER}Species,Rosaceae,Rubus idaeus,,red raspberry\n`);
    await loadPlantList(conn, { path: good });
    for (const bad of [
      `${HEADER}Species,Rosaceae,Rubus idaeus,,red,extra\n`,
      `${HEADER}Species,Rosaceae,Rubus idaeus,,a\nSpecies,Rosaceae,Rubus idaeus,,b\n`,
      "Rank,Name\nSpecies,Rubus\n",
    ]) {
      await expect(loadPlantList(conn, { path: await listFile(bad) })).rejects.toThrow(/plant list/);
    }
    expect(await rows("SELECT scientific_name FROM plant_list_entry")).toEqual([["Rubus idaeus"]]);
  });
});

describe("normalising a name and inferring its rank", () => {
  test("the shape of the name says the rank, not the list's Rank column", async () => {
    await addEntries(...REAL_ROWS);
    const byName = Object.fromEntries(
      (await rows("SELECT scientific_name, name_key, expected_rank FROM plant_list_entry_name")).map(([n, k, r]) => [n, [k, r]]),
    );
    expect(byName["Mentha piperita"]).toEqual(["mentha piperita", "species"]);
    expect(byName["Carduus pycnocephalus ssp. cinereus"]).toEqual(["carduus pycnocephalus cinereus", "infraspecific"]);
    expect(byName["Poaceae"]).toEqual(["poaceae", "family"]); // the list files it as a genus
    expect(byName["Apocynum"]).toEqual(["apocynum", "genus"]); // the list files it as a family
    expect(byName["Urtica dioica gracilis"]).toEqual(["urtica dioica gracilis", "infraspecific"]); // the list files it as a species
  });

  test("the hybrid sign and var./ssp./subsp. are dropped from either side", async () => {
    await conn.run(`INSERT INTO plant_name_lookup_hit VALUES ('x', 'species', 1, 'n', 'hybrid', true, 'Mentha × piperita')`);
    await addEntries(["Lepidium virginicum ssp. menziesii", "Subspecies", null], ["Rubus x var. y", "Species", null]);
    const keys = Object.fromEntries((await rows("SELECT raw_name, name_key FROM plant_name_normal")).map(([a, b]) => [a, b]));
    expect(keys["Mentha × piperita"]).toBe("mentha piperita");
    expect(keys["Lepidium virginicum ssp. menziesii"]).toBe("lepidium virginicum menziesii");
    expect(keys["Rubus x var. y"]).toBe("rubus x y");
  });
});

describe("looking names up", () => {
  async function lookUp() {
    await addEntries(...REAL_ROWS);
    return fetchPlantNames(conn, { fetchImpl: api(), requestDelayMs: 0 });
  }
  const outcomes = async () =>
    Object.fromEntries((await rows("SELECT scientific_name, outcome, inat_taxon_id FROM plant_list_entry_taxon")).map(([n, o, id]) => [n, [o, id]]));

  test("each outcome, from iNaturalist's own answers", async () => {
    const r = await lookUp();
    expect(r).toMatchObject({ unlooked: 13, requested: 13, stored: 13, errors: [], stoppedEarly: false });
    const o = await outcomes();
    expect(o["Abelia chinensis"]).toEqual(["matched", 553157]);
    // An older name of the taxon: Aster chilensis is now Symphyotrichum chilense (56861). The search also
    // returned two other taxa whose own names are not the one asked for, and they are ignored.
    expect(o["Aster chilensis"]).toEqual(["matched", 56861]);
    // iNaturalist files the species as a hybrid, with the sign; the two retired species of the same plain
    // name point at it too, and three hits that agree are one answer.
    expect(o["Mentha piperita"]).toEqual(["matched", 181525]);
    expect(o["Carduus pycnocephalus ssp. cinereus"]).toEqual(["matched", 883189]);
    expect(o["Poaceae"]).toEqual(["matched", 47434]);
    expect(o["Apocynum"]).toEqual(["matched", 47361]);
    expect(o["Urtica dioica"]).toEqual(["matched", 51884]); // the six taxa the search returned are not all this name
    // A retired subspecies stands for the taxon that replaced it.
    expect(o["Urtica dioica gracilis"]).toEqual(["matched", 1074432]);
    // Two current taxa claim this name (a retired one points at another): nothing is picked.
    expect(o["Veronica peregrina xalapensis"]).toEqual(["ambiguous", null]);
    // The search returned the taxon of this name, with matched_term 'Salix lasiolepis lasiolepis': the
    // taxon's own name is what counts.
    expect(o["Salix lasiolepis"]).toEqual(["matched", 53452]);
    expect(o["Brassicoidae"]).toEqual(["no match", null]);
  });

  test("the search goes under Plantae, asks for retired taxa too, and only for the ranks the shape allows", async () => {
    await lookUp();
    const url = new URL(asked.find((u) => u.includes("q=mentha"))!);
    expect(url.origin + url.pathname).toBe("https://api.inaturalist.org/v1/taxa");
    expect(url.searchParams.get("taxon_id")).toBe("47126");
    expect(url.searchParams.get("is_active")).toBe("any");
    expect(url.searchParams.get("rank")).toBe("species,hybrid");
    const trinomial = new URL(asked.find((u) => u.includes("carduus"))!);
    expect(trinomial.searchParams.get("q")).toBe("carduus pycnocephalus cinereus");
  });

  test("a name is asked about once: later runs find nothing to ask", async () => {
    await lookUp();
    const again = await fetchPlantNames(conn, { fetchImpl: api(), requestDelayMs: 0 });
    expect(again).toMatchObject({ unlooked: 0, requested: 0 });
    expect(asked).toHaveLength(13);
  });

  test("a name the API fails on is not recorded as an answer, and is asked again", async () => {
    await addEntries(["Urtica dioica", "Species", null]);
    const failing = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    const r = await fetchPlantNames(conn, { fetchImpl: failing, requestDelayMs: 0 });
    expect(r.errors).toHaveLength(1);
    expect(await rows("SELECT count(*) FROM plant_name_lookup")).toEqual([[0]]);
    expect(await rows("SELECT count(*) FROM plant_name_unlooked")).toEqual([[1]]);
  });

  test("the cap leaves the rest for the next run", async () => {
    await addEntries(["Urtica dioica", "Species", null], ["Abelia chinensis", "Species", null], ["Apocynum", "Genus", null]);
    const r = await fetchPlantNames(conn, { fetchImpl: api(), requestDelayMs: 0, maxRequests: 2 });
    expect(r).toMatchObject({ requested: 2, stored: 2, stoppedEarly: true });
    expect(await rows("SELECT count(*) FROM plant_name_unlooked")).toEqual([[1]]);
  });

  test("the entries without a taxon are listed with the reason, and two entries reaching one taxon are listed together", async () => {
    await lookUp();
    // Two spellings of one plant: a synthetic second entry for the species the list writes without its sign.
    await addEntries(["Mentha × piperita", "Species", "mint"]);
    await fetchPlantNames(conn, { fetchImpl: api(), requestDelayMs: 0 });
    const unmatched = Object.fromEntries((await rows("SELECT scientific_name, outcome FROM plant_list_entry_unmatched")).map(([n, o]) => [n, o]));
    expect(unmatched).toEqual({
      // The real genus: iNaturalist has Abelia current, and a retired Abelia that points at another genus.
      Abelia: "ambiguous",
      "Veronica peregrina xalapensis": "ambiguous",
      Brassicoidae: "no match",
    });
    expect(await rows("SELECT inat_taxon_id, entries, scientific_names FROM plant_list_taxon_shared")).toEqual([
      [181525, 2, "Mentha piperita; Mentha × piperita"],
    ]);
  });

  test("the taxa the names reached join the taxon cache's worklist, and an ambiguous name adds none", async () => {
    await lookUp();
    const wanted = (await rows("SELECT inat_taxon_id FROM inat_taxon_uncached")).map(([id]) => id);
    expect(wanted).toContain(181525);
    expect(wanted).toContain(1074432);
    expect(wanted).not.toContain(491173); // Veronica peregrina xalapensis, claimed by two taxa
    expect(wanted).toHaveLength(10); // the ten entries that matched
  });

  test("the job asks for the names, then has the taxa read", async () => {
    await addEntries(["Urtica dioica", "Species", null]);
    const detail = await refreshPlantNames(conn, { fetchImpl: api(), requestDelayMs: 0 });
    expect(detail).toContain("1 of 1 plant list names answered");
    expect(await rows("SELECT count(*) FROM plant_name_lookup")).toEqual([[1]]);
  });
});

describe("common names", () => {
  // Synthetic taxa and lineage for what the names resolve to (real ids, so the
  // lookups are the real ones): species 51884 Urtica dioica sits in a genus
  // and a family that were not captured, and 1074432 is the subspecies under it.
  const GENUS = 990001; // synthetic: Urtica
  const FAMILY = 990002; // synthetic: Urticaceae
  const lineage: Record<number, number[]> = {
    [FAMILY]: [FAMILY],
    [GENUS]: [GENUS, FAMILY],
    51884: [51884, GENUS, FAMILY],
    1074432: [1074432, 51884, GENUS, FAMILY],
  };

  async function cache(taxa: Array<[id: number, name: string, rank: string, oregonName: string | null, ancestors?: number[]]>) {
    for (const [id, name, rank, oregon, ancestors] of taxa) {
      await conn.run(
        "INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active, preferred_common_name) VALUES ($1, $2, $3, 10, true, $4)",
        [id, name, rank, oregon],
      );
      const above = ancestors ?? lineage[id]!;
      for (const [depth, a] of above.entries()) await conn.run("INSERT INTO inat_taxon_ancestor VALUES ($1, $2, $3)", [id, a, depth]);
    }
  }
  const nameOf = async (id: number) => (await rows(`SELECT common_name, source, list_entry, list_entry_depth FROM plant_taxon_common_name WHERE inat_taxon_id = ${id}`))[0];

  async function resolveAll(entries: Array<[string, string, string | null]>) {
    await addEntries(...entries);
    await fetchPlantNames(conn, { fetchImpl: api(), requestDelayMs: 0 });
  }

  test("the nearest entry covering a host names it: the variety's own entry for the variety, the species' for the species", async () => {
    await resolveAll([
      ["Urtica dioica", "Species", "stinging nettle"],
      ["Urtica dioica gracilis", "Species", "Northwest nettle"],
    ]);
    await cache([
      [51884, "Urtica dioica", "species", "stinging nettle (iNaturalist)"],
      [1074432, "Urtica dioica gracilis", "subspecies", "California nettle (iNaturalist)"],
    ]);
    expect(await nameOf(1074432)).toEqual(["Northwest nettle", "list", "Urtica dioica gracilis", 0]);
    expect(await nameOf(51884)).toEqual(["stinging nettle", "list", "Urtica dioica", 0]);
  });

  test("a subspecies with no entry of its own takes its species' entry, one step up", async () => {
    await resolveAll([["Urtica dioica", "Species", "stinging nettle"]]);
    await cache([[51884, "Urtica dioica", "species", null], [1074432, "Urtica dioica gracilis", "subspecies", "California nettle (iNaturalist)"]]);
    expect(await nameOf(1074432)).toEqual(["stinging nettle", "list", "Urtica dioica", 1]);
  });

  test("a host no entry covers takes iNaturalist's name for Oregon, and one with neither has none", async () => {
    await resolveAll([["Acer macrophyllum", "Species", "bigleaf maple, Oregon maple"]]);
    await cache([
      [48227, "Acer macrophyllum", "species", "bigleaf maple (iNaturalist)", [48227]],
      [403427, "Leucanthemum ircutianum", "species", "oxeye daisy (iNaturalist)", [403427]],
      [883189, "Carduus pycnocephalus cinereus", "subspecies", null, [883189]],
    ]);
    // The first of the names the list gives.
    expect(await nameOf(48227)).toEqual(["bigleaf maple", "list", "Acer macrophyllum", 0]);
    expect(await nameOf(403427)).toEqual(["oxeye daisy (iNaturalist)", "inaturalist", null, null]);
    expect(await nameOf(883189)).toBeUndefined();
  });

  test("a placeholder where a common name belongs covers nothing", async () => {
    await resolveAll([
      ["Abelia", "Genus", "Abelia Species"],
      ["Abelia chinensis", "Species", "glossy abelia"],
      ["Poaceae", "Genus", "grass"],
    ]);
    // Abelia chinensis (553157) is under the genus entry, which has no name to give; a species with no
    // entry of its own under it takes iNaturalist's name and not 'Abelia Species'. Genus Abelia is ambiguous
    // in the real answer (a retired genus points elsewhere), so the entry has no taxon in any case.
    expect(await rows("SELECT common_name FROM plant_list_entry_common_name ORDER BY 1")).toEqual([["glossy abelia"], ["grass"]]);
    await cache([[553157, "Abelia chinensis", "species", "Chinese abelia (iNaturalist)", [553157, 155567]]]);
    expect(await nameOf(553157)).toEqual(["glossy abelia", "list", "Abelia chinensis", 0]);
  });

  test("placeholders from the real file are none, and real names that look like them are kept", async () => {
    await addEntries(
      ["Abelia", "Genus", "Abelia Species"],
      ["Knautia", "Genus", "Knautia species"],
      ["Mentheae", "Tribe", "tribe Mentheae"],
      ["Trifolieae", "Tribe", "Tribe trifolieae"],
      ["Pieris", "Genus", "Genus pieris"],
      ["Leucanthemum ircutianum", "Species", "Leucanthemum ircutianum"],
      ["Magnolia", "Genus", "magnolia"],
      ["Iris", "Genus", "iris"],
      ["Rhododendron", "Genus", "rhododendron, azalea"],
      ["Heath", "Family", null],
    );
    expect(await rows("SELECT scientific_name, common_name FROM plant_list_entry_common_name ORDER BY 1")).toEqual([
      ["Iris", "iris"],
      ["Magnolia", "magnolia"],
      ["Rhododendron", "rhododendron"],
    ]);
  });

  test("a family's name covers a species the list has no entry for, ahead of iNaturalist's own", async () => {
    // The literal rule (Peter, 2026-11-14): the nearest entry wins, and a family is an entry. It is
    // visible in list_entry_depth so a caller can see how far up the name came from.
    await resolveAll([["Poaceae", "Genus", "grass"]]);
    await cache([[777001, "Poa synthetica", "species", "synthetic bluegrass (iNaturalist)", [777001, 47434]]]); // synthetic taxon
    expect(await nameOf(777001)).toEqual(["grass", "list", "Poaceae", 1]);
  });

  test("two entries at one distance are settled the same way every time", async () => {
    await resolveAll([
      ["Mentha piperita", "Species", "peppermint"],
      ["Mentha × piperita", "Species", "mint"],
    ]);
    await cache([[181525, "Mentha × piperita", "hybrid", null, [181525]]]);
    expect(await nameOf(181525)).toEqual(["peppermint", "list", "Mentha piperita", 0]); // by scientific name, as it sorts
  });
});
