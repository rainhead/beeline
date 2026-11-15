// iNaturalist's common names in sentence case, proper nouns kept
// (schema/114 plant_inat_common_name, schema/067 plant_proper_noun,
// src/load-plant-list.ts, beeline-rfkj.9). The names are iNaturalist's own,
// read from the cache of a copy of production's store on 2026-11-14; the
// list's names are lifted from ingest/old-beeline-plant-list.csv. The taxon
// ids and the lineages are made up (none is read), and are marked so where a
// name is synthetic.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadPlantList, parseProperNouns } from "../src/load-plant-list.js";
import { refreshPlantCommonNames } from "../src/plant-common-names.js";
import { createMemoryDb } from "./helpers.js";

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

let nextId = 1000;
/** A cached taxon with iNaturalist's name; returns what Beeline calls it, in sentence case. */
async function converted(name: string, opts: { rank?: string; scientific?: string } = {}): Promise<string | null> {
  const id = nextId++;
  await conn.run(
    "INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active, preferred_common_name) VALUES ($1, $2, $3, 10, true, $4)",
    [id, opts.scientific ?? `Synthetica taxon${id}`, opts.rank ?? "species", name],
  );
  const got = await rows(`SELECT common_name FROM plant_inat_common_name WHERE inat_taxon_id = ${id}`);
  return (got[0]?.[0] as string | undefined) ?? null;
}
let nextEntry = 0;
const list = async (...names: string[]) => {
  for (const common of names) {
    await conn.run("INSERT INTO plant_list_entry (list_key, scientific_name, rank, common_name) VALUES ('old-beeline', $1, 'Species', $2)", [`Synthetica listed${nextEntry++}`, common]);
  }
};
const noun = (word: string, treatment: "keep" | "lower", reason = "test") =>
  conn.run("INSERT INTO plant_proper_noun VALUES ($1, $2, $3)", [word, treatment, reason]);

describe("title case becomes sentence case", () => {
  test("a name written in title case loses every capital", async () => {
    expect(await converted("Silverleaf Phacelia")).toBe("silverleaf phacelia");
    expect(await converted("Western Water Hemlock")).toBe("western water hemlock");
    expect(await converted("Dwarf Yellow Fleabane")).toBe("dwarf yellow fleabane");
  });

  test("a name already in sentence case loses the capital of its first word, as the style puts it after the scientific name", async () => {
    expect(await converted("Silverleaf phacelia")).toBe("silverleaf phacelia");
    expect(await converted("Alsike clover")).toBe("alsike clover");
  });

  test("the parts of a hyphenated word are judged one at a time", async () => {
    await noun("Douglas", "keep");
    expect(await converted("Coast Douglas-fir")).toBe("coast Douglas-fir");
    expect(await converted("Yellow Star-Thistle")).toBe("yellow star-thistle");
    // Synthetic: the shape of "love-in-a-mist", with every part in capitals.
    expect(await converted("Love-In-A-Mist")).toBe("love-in-a-mist");
    expect(await converted("Farewell-To-Spring")).toBe("farewell-to-spring");
  });

  test("a group of names with commas keeps its punctuation", async () => {
    expect(await converted("Mustards, Capers, and Allies")).toBe("mustards, capers, and allies");
  });

  test("the name stored is not changed", async () => {
    await converted("Silverleaf Phacelia");
    expect(await rows("SELECT preferred_common_name FROM inat_taxon WHERE preferred_common_name = 'Silverleaf Phacelia'")).toEqual([["Silverleaf Phacelia"]]);
  });
});

describe("a word keeps its capital: rule 1, the plant list capitalises it", () => {
  test("Oregon is learned from 'tall Oregon-grape', and not before the list has it", async () => {
    expect(await converted("Oregon Gumplant")).toBe("oregon gumplant");
    await list("tall Oregon-grape", "common California aster");
    expect(await converted("Oregon Gumplant")).toBe("Oregon gumplant");
    expect(await converted("Pacific Aster")).toBe("pacific aster");
    expect(await rows("SELECT word FROM plant_list_proper_noun ORDER BY word")).toEqual([["California"], ["Oregon"]]);
  });

  test("a word that begins the list's name teaches nothing, since a name begins with a capital whatever the word is", async () => {
    await list("Canada thistle");
    expect(await rows("SELECT word FROM plant_list_proper_noun")).toEqual([]);
  });

  test("a row the list wrote entirely in title case teaches nothing", async () => {
    await list("Perennial Sow Thistle", "Willamette Valley daisy");
    expect(await rows("SELECT word FROM plant_list_proper_noun ORDER BY word")).toEqual([["Valley"]]);
    expect(await converted("Mountain Sow Thistle")).toBe("mountain sow thistle");
  });

  test("a word that the list or iNaturalist also writes in lower case is a common noun, not a proper one", async () => {
    // "Stonecrop" is capitalised in the middle of one list name and begins another in lower case.
    await list("Butterfly Stonecrop and yellow", "stonecrop family");
    expect(await rows("SELECT word FROM plant_list_proper_noun")).toEqual([]);
    // "Willow" is lower case in one of iNaturalist's names.
    await list("arroyo Willow");
    await converted("willow family");
    expect(await rows("SELECT word FROM plant_list_proper_noun")).toEqual([]);
  });

  test("the second and later names of a cell teach too", async () => {
    await list("ventenata, North Africa grass");
    expect(await rows("SELECT word FROM plant_list_proper_noun")).toEqual([["Africa"]]);
  });

  test("a placeholder or a rank before a name teaches nothing", async () => {
    await list("Abelia Species", "tribe Cardueae", "subfamily Faboideae");
    expect(await rows("SELECT word FROM plant_list_proper_noun")).toEqual([]);
  });
});

describe("a word keeps its capital: rule 2, a possessive", () => {
  test("an eponym keeps its capital, with and without the final s", async () => {
    expect(await converted("Nuttall's Linanthus")).toBe("Nuttall's linanthus");
    expect(await converted("Hooded Ladies' Tresses")).toBe("hooded Ladies' tresses");
    expect(await converted("Oregon Douglas' Aster")).toBe("oregon Douglas' aster");
    expect(await converted("Showy Frémont's Fleabane")).toBe("showy Frémont's fleabane");
    expect(await converted("Hairy Cat's Ear")).toBe("hairy Cat's ear");
  });

  test("a possessive of an animal or a role loses its capital where the file says lower", async () => {
    await noun("Shepherd's", "lower");
    await noun("Cat's", "lower");
    expect(await converted("Smooth Cat's Ear")).toBe("smooth cat's ear");
    expect(await converted("Shepherd's Purse")).toBe("shepherd's purse");
  });

  test("a word that begins with a lower-case letter and has a capital inside it is left alone", async () => {
    // From the tests' own names for iNaturalist, which would otherwise read "inaturalist"; real names include "bebb's".
    expect(await converted("Coast Nettle (iNaturalist)")).toBe("coast nettle (iNaturalist)");
  });

  test("a capital after the apostrophe of a word that begins in lower case goes too", async () => {
    expect(await converted("Mountain Four O'Clock")).toBe("mountain four o'clock");
    expect(await converted("Mountain four o'Clock")).toBe("mountain four o'clock");
  });

  test("a curly apostrophe counts", async () => {
    expect(await converted("Royal Jacob’s Ladder")).toBe("royal Jacob’s ladder");
  });
});

describe("a word keeps its capital: rule 3, the file says keep", () => {
  test("Utah is kept only once the file says so", async () => {
    expect(await converted("Utah Serviceberry")).toBe("utah serviceberry");
    await noun("Utah", "keep", "a state");
    expect(await converted("Utah Serviceberry")).toBe("Utah serviceberry");
  });

  test("the file beats the possessive rule and the list", async () => {
    await noun("Baby's", "lower");
    expect(await converted("Baby's Breath")).toBe("baby's breath");
  });
});

describe("a phrase of several words keeps its capitals", () => {
  test("without a row for it, the second word of a place loses its capital", async () => {
    expect(await converted("Rocky Mountain maple")).toBe("rocky mountain maple");
  });

  test("a phrase at the start, in the middle and at the end of a name", async () => {
    await noun("Rocky Mountain", "keep", "a range");
    await noun("Great Valley", "keep", "a valley in California");
    expect(await converted("Rocky Mountain Maple")).toBe("Rocky Mountain maple");
    expect(await converted("Rocky Mountain pussytoes")).toBe("Rocky Mountain pussytoes");
    expect(await converted("Showy Rocky Mountain Maple")).toBe("showy Rocky Mountain maple");
    expect(await converted("Narrowleaf Great Valley")).toBe("narrowleaf Great Valley");
    expect(await converted("Great Valley gumweed")).toBe("Great Valley gumweed");
  });

  test("a phrase is found whatever case the name has it in, and is set as the file spells it", async () => {
    await noun("Rocky Mountain", "keep", "a range");
    expect(await converted("rocky mountain bee plant")).toBe("Rocky Mountain bee plant");
    expect(await converted("ROCKY MOUNTAIN Maple")).toBe("Rocky Mountain maple");
  });

  test("a phrase overlapping a hyphenated word: the hyphen ends the phrase and the other part is judged alone", async () => {
    await noun("Rocky Mountain", "keep", "a range");
    await noun("Blue Mountain", "keep", "a range in Oregon");
    expect(await converted("Rocky Mountain-Ash")).toBe("Rocky Mountain-ash");
    expect(await converted("Wild-Blue Mountain Aster")).toBe("wild-Blue Mountain aster");
  });

  test("a phrase is not found inside a longer word, and two words that merely sit near each other are not a phrase", async () => {
    await noun("Rocky Mountain", "keep", "a range");
    expect(await converted("Rocky Mountainous Maple")).toBe("rocky mountainous maple");
    expect(await converted("Rocky, Mountain Maple")).toBe("rocky, mountain maple");
    expect(await converted("Rockys Mountain Maple")).toBe("rockys mountain maple");
  });
});

describe("an eponym that iNaturalist wrote in lower case", () => {
  test("a keep row restores the capital, with the apostrophe as written", async () => {
    expect(await converted("bebb's willow")).toBe("bebb's willow");
    await noun("Bebb's", "keep", "Michael Schuck Bebb, a botanist");
    await noun("Wilkes'", "keep", "Charles Wilkes, who led the United States Exploring Expedition");
    expect(await converted("bebb's willow")).toBe("Bebb's willow");
    expect(await converted("Bebb's Willow")).toBe("Bebb's willow");
    expect(await converted("wilkes' cryptantha")).toBe("Wilkes' cryptantha");
  });
});

describe("what is not converted", () => {
  test("the scientific names of sections and subgenera are left as written", async () => {
    expect(await converted("Allium Subg. Cepa", { rank: "subgenus" })).toBeNull();
    expect(await converted("Subsection Hypericum", { rank: "subsection" })).toBeNull();
  });

  test("a name that is the taxon's own scientific name is left as written", async () => {
    expect(await converted("Lavandula", { rank: "genus", scientific: "Lavandula" })).toBeNull();
  });

  test("the list's own names are shown as the list wrote them, and iNaturalist's are converted beside them", async () => {
    // Phacelia hastata: the list's entry names it; iNaturalist's name for another taxon is converted.
    await conn.run("INSERT INTO plant_list_entry (list_key, scientific_name, rank, common_name) VALUES ('old-beeline', 'Symphyotrichum chilense', 'Species', 'common California aster')");
    await conn.run("INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active, preferred_common_name) VALUES (1, 'Symphyotrichum chilense', 'species', 10, true, 'Pacific Aster')");
    await conn.run("INSERT INTO inat_taxon_ancestor VALUES (1, 1, 0)");
    await conn.run("INSERT INTO plant_name_lookup (name_key, expected_rank, total_results, read_in_full) VALUES ('symphyotrichum chilense', 'species', 1, true)");
    await conn.run("INSERT INTO plant_name_lookup_hit VALUES ('symphyotrichum chilense', 'species', 1, 'Symphyotrichum chilense', 'species', true, 'Symphyotrichum chilense')");
    await conn.run("INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active, preferred_common_name) VALUES (2, 'Phacelia hastata', 'species', 10, true, 'Silverleaf Phacelia')");
    await conn.run("INSERT INTO inat_taxon_ancestor VALUES (2, 2, 0)");
    await refreshPlantCommonNames(conn);
    expect(await rows("SELECT inat_taxon_id, common_name, source FROM plant_common_name_cache ORDER BY 1")).toEqual([
      [1, "common California aster", "list"],
      [2, "silverleaf phacelia", "inaturalist"],
    ]);
    expect(await rows("SELECT count(*) FROM plant_common_name_stale")).toEqual([[0]]);
  });
});

describe("the file of proper nouns", () => {
  test("a bad row is refused with its line", () => {
    const h = "Word,Treatment,Reason\n";
    expect(() => parseProperNouns(Buffer.from("Word,Reason\n"))).toThrow(/header/);
    expect(() => parseProperNouns(Buffer.from(`${h}Utah,keep\n`))).toThrow(/row 2/);
    expect(() => parseProperNouns(Buffer.from(`${h}Utah,sometimes,because\n`))).toThrow(/keep or lower, not sometimes/);
    expect(() => parseProperNouns(Buffer.from(`${h}Utah,keep,a state\nUtah,keep,again\n`))).toThrow(/Utah appears twice, ignoring case \(row 3\)/);
    expect(() => parseProperNouns(Buffer.from(`${h}Utah,keep,a state\nutah,keep,again\n`))).toThrow(/appears twice, ignoring case/);
    expect(() => parseProperNouns(Buffer.from(`${h}Rocky Mountain,lower,because\n`))).toThrow(/only a keep row may hold a phrase/);
    expect(() => parseProperNouns(Buffer.from(`${h}Rocky  Mountain,keep,a range\n`))).toThrow(/single spaces/);
    expect(() => parseProperNouns(Buffer.from(`${h}Mountain-ash,keep,x\n`))).toThrow(/hyphen/);
    expect(parseProperNouns(Buffer.from(`${h}Rocky Mountain,keep,a range\n`))).toEqual([{ word: "Rocky Mountain", treatment: "keep", reason: "a range" }]);
    expect(parseProperNouns(Buffer.from(`${h}Utah,keep,"a state, in the west"\n`))).toEqual([{ word: "Utah", treatment: "keep", reason: "a state, in the west" }]);
  });

  test("the load replaces the rows, and a change to the file alone reloads the list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beeline-proper-nouns-"));
    const listPath = join(dir, "list.csv");
    const nounPath = join(dir, "nouns.csv");
    await writeFile(listPath, "Rank,Family,Scientific_name,Synonym,Common_name\nSpecies,Rosaceae,Rubus idaeus,,red raspberry\n");
    await writeFile(nounPath, "Word,Treatment,Reason\nUtah,keep,a state\n");
    expect((await loadPlantList(conn, { path: listPath, properNounsPath: nounPath })).changed).toBe(true);
    expect(await rows("SELECT word, treatment FROM plant_proper_noun")).toEqual([["Utah", "keep"]]);
    expect((await loadPlantList(conn, { path: listPath, properNounsPath: nounPath })).changed).toBe(false);

    await writeFile(nounPath, "Word,Treatment,Reason\nIdaho,keep,a state\n");
    expect((await loadPlantList(conn, { path: listPath, properNounsPath: nounPath })).changed).toBe(true);
    expect(await rows("SELECT word FROM plant_proper_noun")).toEqual([["Idaho"]]);
  });

  test("the file in git loads, and its words are the ones the views read", async () => {
    await loadPlantList(conn);
    const keeps = (await rows("SELECT count(*) FROM plant_proper_noun WHERE treatment = 'keep'"))[0]![0] as number;
    expect(keeps).toBeGreaterThan(50);
    expect(await converted("Utah Serviceberry")).toBe("Utah serviceberry");
    expect(await converted("Shepherd's Purse")).toBe("shepherd's purse");
    expect(await converted("Point Reyes Ceanothus")).toBe("Point Reyes ceanothus");
  });
});
