// Common names in sentence case, proper nouns kept (schema/114
// plant_name_sentence_case, schema/067 plant_proper_noun,
// src/load-plant-list.ts, beeline-rfkj.9). A name is iNaturalist's own, read
// from the cache of a copy of production's store on 2026-11-14, or is the
// list's, lifted from ingest/old-beeline-plant-list.csv, unless a comment says
// "Synthetic": a name made up to hold one construct. The taxon ids and the
// lineages are always made up, since the tests never read them.
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
/** A name in the plant list's Common_name cell; returns what Beeline shows for it, in sentence case. */
async function listed(name: string): Promise<string | null> {
  await conn.run("INSERT INTO plant_list_entry (list_key, scientific_name, rank, common_name) VALUES ('old-beeline', $1, 'Species', $2)", [`Synthetica listed${nextEntry++}`, name]);
  const got = await rows(`SELECT common_name FROM plant_name_sentence_case WHERE name = '${name.replaceAll("'", "''")}'`);
  return (got[0]?.[0] as string | undefined) ?? null;
}
const noun = (word: string, treatment: "keep" | "lower", reason = "test") =>
  conn.run("INSERT INTO plant_proper_noun VALUES ($1, $2, $3)", [word, treatment, reason]);

// Names are iNaturalist's or the list's own unless a test says "Synthetic": a name made up to hold one construct.

describe("title case becomes sentence case", () => {
  test("a name written in title case loses every capital", async () => {
    // Synthetic: the title-case spelling of iNaturalist's "silverleaf phacelia" (it writes many names this way, but not this one).
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
    // Synthetic: "Coast" before the real "Douglas-fir".
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
    // Synthetic: as above.
    await converted("Silverleaf Phacelia");
    expect(await rows("SELECT preferred_common_name FROM inat_taxon WHERE preferred_common_name = 'Silverleaf Phacelia'")).toEqual([["Silverleaf Phacelia"]]);
  });

  test("nothing is learned from the data: a capital the list writes is lost unless the file keeps the word", async () => {
    await listed("tall Oregon-grape");
    expect(await converted("Oregon Gumplant")).toBe("oregon gumplant");
    await noun("Oregon", "keep", "a state");
    expect(await converted("Oregon Gumplant")).toBe("Oregon gumplant");
    // Synthetic: a lower-case "canada thistle", which the list does not write; without a row, Canada is only a word.
    expect(await converted("canada thistle")).toBe("canada thistle");
  });
});

describe("a possessive keeps its capital", () => {
  test("an eponym keeps its capital, with and without the final s", async () => {
    expect(await converted("Nuttall's Linanthus")).toBe("Nuttall's linanthus");
    // Synthetic: real eponyms (Douglas', Frémont's) in names that carry a made-up first word.
    expect(await converted("Oregon Douglas' Aster")).toBe("oregon Douglas' aster");
    expect(await converted("Showy Frémont's Fleabane")).toBe("showy Frémont's fleabane");
  });

  test("a word that ends in a bare apostrophe after another letter is not a possessive", async () => {
    // Synthetic: the shape of Jack-o'-lantern, with the O' in capitals.
    expect(await converted("Orange Jack-O'-Lantern")).toBe("orange jack-o'-lantern");
    expect(await converted("Orange Jack-O’-Lantern")).toBe("orange jack-o’-lantern");
  });

  test("a word that begins with a lower-case letter and has a capital inside it is left alone", async () => {
    // Synthetic: the tests' own names for iNaturalist, which would otherwise read "inaturalist".
    expect(await converted("Coast Nettle (iNaturalist)")).toBe("coast nettle (iNaturalist)");
  });

  test("a capital after the apostrophe of a word that begins in lower case goes too", async () => {
    // Synthetic: title-case spelling of iNaturalist's "Mountain Four o'Clock", with a capital after the apostrophe.
    expect(await converted("Mountain Four O'Clock")).toBe("mountain four o'clock");
    // Synthetic: the spelling with a lower-case start.
    expect(await converted("Mountain four o'Clock")).toBe("mountain four o'clock");
  });

  test("a curly apostrophe counts", async () => {
    // Synthetic: curly-apostrophe spellings of eponyms, which iNaturalist writes straight ("Blue Jacob's Ladder").
    expect(await converted("Royal Jacob’s Ladder")).toBe("royal Jacob’s ladder");
    expect(await converted("Hooded Douglas’ Aster")).toBe("hooded Douglas’ aster");
  });
});

describe("a possessive that is not a person loses its capital where the file says lower", () => {
  test("the file's lower row beats the possessive rule, with a straight or a curly apostrophe on either side", async () => {
    await noun("Shepherd's", "lower");
    await noun("Cat's", "lower");
    await noun("Ladies'", "lower");
    await noun("Baby’s", "lower");
    // Synthetic: title-case spellings of "shepherd's-purse", "baby's-breath" and the like, which iNaturalist and the list write otherwise.
    expect(await converted("Shepherd's Purse")).toBe("shepherd's purse");
    expect(await converted("Shepherd’s Purse")).toBe("shepherd’s purse");
    expect(await converted("Smooth Cat's Ear")).toBe("smooth cat's ear");
    expect(await converted("Hooded Ladies' Tresses")).toBe("hooded ladies' tresses");
    expect(await converted("Baby's Breath")).toBe("baby's breath");
    // Synthetic: no row for Dog's, so it stays an eponym.
    expect(await converted("Hairy Dog's Ear")).toBe("hairy Dog's ear");
  });
});

describe("a word keeps its capital because the file says keep", () => {
  test("Utah is kept only once the file says so", async () => {
    expect(await converted("Utah Serviceberry")).toBe("utah serviceberry");
    await noun("Utah", "keep", "a state");
    expect(await converted("Utah Serviceberry")).toBe("Utah serviceberry");
  });

  test("a keep row is found with either apostrophe, and is set with the apostrophe the name wrote", async () => {
    await noun("Bebb’s", "keep", "a botanist");
    // Synthetic: iNaturalist writes "bebb's willow" in lower case with a straight apostrophe, and "wilkes' cryptantha" likewise; these are the other spellings.
    expect(await converted("Bebb's Willow")).toBe("Bebb's willow");
    expect(await converted("bebb’s willow")).toBe("Bebb’s willow");
    await noun("Wilkes'", "keep", "a naval officer");
    expect(await converted("wilkes’ cryptantha")).toBe("Wilkes’ cryptantha");
  });

  test("a Roman numeral and the abbreviations keep their capitals", async () => {
    await noun("II", "keep", "a numeral");
    await noun("Saint", "keep", "a title");
    await noun("Washington", "keep", "a state");
    // Synthetic: the shape of a numbered group.
    expect(await converted("Eupolypods Ii")).toBe("eupolypods II");
    // Synthetic: St. John's wort with a made-up first word, a made-up mountain, and the title-case "saint".
    expect(await converted("Common St. John's wort")).toBe("common St. John's wort");
    expect(await converted("Mt. Washington Fleabane")).toBe("Mt. Washington fleabane");
    expect(await converted("saint John's wort")).toBe("Saint John's wort");
    // With no period, and joined to a hyphenated word: iNaturalist's "Imperforate St John's-wort".
    expect(await converted("Imperforate St John's-wort")).toBe("imperforate St John's-wort");
    // Synthetic: not the st of "1st", nor the end of a word.
    expect(await converted("1st Rate Daisy")).toBe("1st rate daisy");
    expect(await converted("Fast Daisy")).toBe("fast daisy");
  });
});

describe("a phrase of several words keeps its capitals", () => {
  test("without a row for it, the second word of a place loses its capital", async () => {
    expect(await converted("Rocky Mountain maple")).toBe("rocky mountain maple");
  });

  test("a phrase at the start, in the middle and at the end of a name", async () => {
    await noun("Rocky Mountain", "keep", "a range");
    await noun("Great Valley", "keep", "a valley in California");
    // Synthetic: iNaturalist's "Rocky Mountain maple" in title case, and the same with a made-up first word.
    expect(await converted("Rocky Mountain Maple")).toBe("Rocky Mountain maple");
    expect(await converted("Rocky Mountain pussytoes")).toBe("Rocky Mountain pussytoes");
    expect(await converted("Showy Rocky Mountain Maple")).toBe("showy Rocky Mountain maple");
    // Synthetic: the valley at the end.
    expect(await converted("Narrowleaf Great Valley")).toBe("narrowleaf Great Valley");
    expect(await converted("Great Valley gumweed")).toBe("Great Valley gumweed");
  });

  test("a phrase is found every time it occurs, whatever case the name has it in, and is set as the file spells it", async () => {
    await noun("Rocky Mountain", "keep", "a range");
    // Synthetic: lower-case and upper-case spellings of "Rocky Mountain bee plant" and "Rocky Mountain maple".
    expect(await converted("rocky mountain bee plant")).toBe("Rocky Mountain bee plant");
    expect(await converted("ROCKY MOUNTAIN Maple")).toBe("Rocky Mountain maple");
    // Synthetic: a name that says it twice.
    expect(await converted("Rocky Mountain Maple of the rocky mountain")).toBe("Rocky Mountain maple of the Rocky Mountain");
  });

  test("a phrase does not begin or end inside a longer word, and two words that merely sit near each other are not a phrase", async () => {
    await noun("Rocky Mountain", "keep", "a range");
    // Synthetic: names made up with the phrase's words in places where they are not the phrase.
    expect(await converted("Rocky Mountainous Maple")).toBe("rocky mountainous maple");
    expect(await converted("Rocky, Mountain Maple")).toBe("rocky, mountain maple");
    expect(await converted("Rockys Mountain Maple")).toBe("rockys mountain maple");
    // Synthetic: a longer word ends in the phrase's first word.
    expect(await converted("Prerocky Mountain Maple")).toBe("prerocky mountain maple");
    expect(await converted("Sky-Rocky Mountain Maple")).toBe("sky-rocky mountain maple");
  });

  test("a phrase does not reach into a hyphenated compound on either side", async () => {
    await noun("Blue Mountain", "keep", "a range in Oregon");
    // Synthetic: "Blue Mountain-Heath" (a made-up compound), the hyphen before the phrase, and the phrase on its own.
    expect(await converted("Blue Mountain-Heath")).toBe("blue mountain-heath");
    expect(await converted("Wild-Blue Mountain Aster")).toBe("wild-blue mountain aster");
    expect(await converted("Blue Mountain Heath")).toBe("Blue Mountain heath");
  });

  test("a plural is a row of its own", async () => {
    await noun("Rocky Mountain", "keep", "a range");
    // Synthetic: a plural in a made-up name.
    expect(await converted("Rocky Mountains Maple")).toBe("rocky mountains maple");
    await noun("Rocky Mountains", "keep", "the plural of the range");
    expect(await converted("Rocky Mountains Maple")).toBe("Rocky Mountains maple");
  });

  test("a phrase with an apostrophe or a period is found with either apostrophe", async () => {
    await noun("Lady Banks’", "keep", "a person");
    await noun("Mount St. Helens", "keep", "a volcano");
    // The apostrophe is the name's own, the letters are the file's.
    expect(await converted("Lady Banks' Rose")).toBe("Lady Banks' rose");
    expect(await converted("lady banks’ rose")).toBe("Lady Banks’ rose");
    // Synthetic: a volcano in made-up names.
    expect(await converted("Mount St. Helens Lupine")).toBe("Mount St. Helens lupine");
    expect(await converted("Mount Saint Helens Lupine")).toBe("mount saint helens lupine");
  });

  test("overlapping phrases are decided by where they begin, then by their spelling", async () => {
    // Synthetic rows and names: two phrases share the word "mountain" and spell it differently, so the answer shows which one decided.
    await noun("Blue MOUNTAIN", "keep", "synthetic: begins first");
    await noun("Mountain LAKE", "keep", "synthetic: begins second");
    expect(await converted("blue mountain lake plant")).toBe("Blue MOUNTAIN LAKE plant");
    // The same start: the first by spelling spells the shared words, so "Rocky Mountain" before "rocky Mountain Maple".
    await noun("rocky Mountain Maple", "keep", "synthetic");
    await noun("Rocky Mountain", "keep", "synthetic");
    expect(await converted("rocky mountain maple plant")).toBe("Rocky Mountain Maple plant");
  });

  test("a hyphen that is part of a phrase of the file is kept, and not one that is not", async () => {
    await noun("Trans-Pecos", "keep", "a region of Texas");
    expect(await converted("trans-Pecos Poreleaf")).toBe("Trans-Pecos poreleaf");
    expect(await converted("Trans-Pecos Rock-Daisy")).toBe("Trans-Pecos rock-daisy");
    // Synthetic: the phrase inside a longer compound is not the phrase.
    expect(await converted("Sub-Trans-Pecos Daisy")).toBe("sub-trans-pecos daisy");
    expect(await converted("Trans-Pecos-Daisy")).toBe("trans-pecos-daisy");
  });

  test("a keep phrase beats a lower row for a word inside it", async () => {
    await noun("Devil's", "lower", "not a person");
    await noun("Devil's Tower", "keep", "a monument");
    // Synthetic: Devil's Tower is a monument in Wyoming, in a made-up name.
    expect(await converted("Devil's Tower Aster")).toBe("Devil's Tower aster");
    expect(await converted("Devil's Club")).toBe("devil's club");
  });
});

describe("an eponym that iNaturalist wrote in lower case", () => {
  test("a keep row restores the capital, with the apostrophe as written", async () => {
    // iNaturalist's own "bebb's willow" and "wilkes' cryptantha"; the title-case "Bebb's Willow" below is synthetic.
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

  test("the name a taxon is given, in plant_taxon_common_name, shows a subgenus's or a section's name as written", async () => {
    await conn.run("INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active, preferred_common_name) VALUES (1, 'Allium subg. Cepa', 'subgenus', 12, true, 'Allium Subg. Cepa')");
    await conn.run("INSERT INTO inat_taxon_ancestor VALUES (1, 1, 0)");
    await conn.run("INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active, preferred_common_name) VALUES (2, 'Phacelia hastata', 'species', 10, true, 'Silverleaf Phacelia')");
    await conn.run("INSERT INTO inat_taxon_ancestor VALUES (2, 2, 0)");
    expect(await rows("SELECT inat_taxon_id, common_name, source FROM plant_taxon_common_name ORDER BY 1")).toEqual([
      [1, "Allium Subg. Cepa", "inaturalist"],
      [2, "silverleaf phacelia", "inaturalist"],
    ]);
  });

  test("a name that holds the abbreviation of a rank is a scientific name, and is left as written", async () => {
    // iNaturalist's names for the taxa of rank complex "Acer pseudoplatanus" and "Acer palmatum".
    expect(await converted("Acer ser. Acer", { rank: "complex" })).toBe("Acer ser. Acer");
    expect(await converted("Acer ser. Palmata", { rank: "complex" })).toBe("Acer ser. Palmata");
    // Synthetic: the same with another abbreviation, which the view reads whatever its case.
    expect(await converted("Hypericum Sect. Ascyreia", { rank: "complex" })).toBe("Hypericum Sect. Ascyreia");
    // Not a rank: "Ser" is no abbreviation without its period.
    expect(await converted("Ser Daisy")).toBe("ser daisy");
  });

  test("a name that is the taxon's own scientific name is left as written", async () => {
    // Synthetic: a taxon whose preferred name is its own scientific name.
    expect(await converted("Lavandula", { rank: "genus", scientific: "Lavandula" })).toBeNull();
  });
});

describe("the list's own names are set in sentence case too", () => {
  test("a name the list wrote in title case loses its capitals, and a connector stays in lower case", async () => {
    expect(await listed("Common Fiddleneck")).toBe("common fiddleneck");
    expect(await listed("Perennial Sow Thistle")).toBe("perennial sow thistle");
    expect(await listed("Western Lily of the Valley")).toBe("western lily of the valley");
  });

  test("a rank before a scientific name is left as the list wrote it", async () => {
    expect(await listed("section Salicaster")).toBeNull();
    // The list's view still gives it, so it is left alone here and not dropped there.
    expect(await rows("SELECT common_name FROM plant_list_entry_common_name")).toEqual([["section Salicaster"]]);
    expect(await rows("SELECT count(*) FROM plant_name_sentence_case WHERE name ILIKE 'section %'")).toEqual([[0]]);
  });

  test("a proper noun the file keeps keeps its capital in the list's names", async () => {
    await noun("Oregon", "keep", "a state");
    await noun("Canada", "keep", "a country");
    expect(await listed("tall Oregon-grape")).toBe("tall Oregon-grape");
    expect(await listed("Canada thistle")).toBe("Canada thistle");
    // The list's own capital is no reason: no row, no capital.
    expect(await listed("common California aster")).toBe("common california aster");
  });

  test("the list's possessives follow the same rule", async () => {
    await noun("Shepherd's", "lower");
    // Synthetic: a title-case list name for shepherd's purse.
    expect(await listed("Shepherd's Purse")).toBe("shepherd's purse");
    // With no row, Queen is the first word and a common noun; the real file keeps the phrase.
    expect(await listed("Queen Anne's lace")).toBe("queen Anne's lace");
    await noun("Queen Anne's", "keep", "a person's name and title");
    expect(await listed("Queen Anne's lace")).toBe("Queen Anne's lace");
  });

  test("the name a taxon shows comes from the list, converted, and iNaturalist's is converted beside it", async () => {
    // Symphyotrichum chilense: the list's entry names it; iNaturalist's name for another taxon is converted.
    await noun("California", "keep", "a state");
    await conn.run("INSERT INTO plant_list_entry (list_key, scientific_name, rank, common_name) VALUES ('old-beeline', 'Symphyotrichum chilense', 'Species', 'Common California Aster')");
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
    expect(() => parseProperNouns(Buffer.from(`${h}Utah,keep,a state\nUtah,keep,again\n`))).toThrow(/Utah appears twice, ignoring case and the kind of apostrophe \(row 3\)/);
    expect(() => parseProperNouns(Buffer.from(`${h}Utah,keep,a state\nUTAH,keep,again\n`))).toThrow(/appears twice, ignoring case/);
    expect(() => parseProperNouns(Buffer.from(`${h}Rocky Mountain,lower,because\n`))).toThrow(/only a keep row may hold a phrase/);
    expect(() => parseProperNouns(Buffer.from(`${h}Rocky  Mountain,keep,a range\n`))).toThrow(/single ordinary spaces/);
    expect(() => parseProperNouns(Buffer.from(`${h}Rocky\u00a0Mountain,keep,a range\n`))).toThrow(/single ordinary spaces/);
    expect(() => parseProperNouns(Buffer.from(`${h}\u00a0Utah,keep,a state\n`))).toThrow(/not a word or a phrase/);
    expect(() => parseProperNouns(Buffer.from(`${h}Rocky\tMountain,keep,a range\n`))).toThrow(/not a word or a phrase/);
    // A hyphen belongs between two words (Trans-Pecos is a phrase); at an edge or doubled it could never match.
    expect(() => parseProperNouns(Buffer.from(`${h}-Pecos,keep,x\n`))).toThrow(/not a word or a phrase/);
    expect(() => parseProperNouns(Buffer.from(`${h}Trans--Pecos,keep,x\n`))).toThrow(/not a word or a phrase/);
    expect(() => parseProperNouns(Buffer.from(`${h}Trans-pecos,lower,x\n`))).toThrow(/only a keep row may hold a phrase/);
    // A keep row sets the name to the row, so a row with no capital would keep nothing.
    expect(() => parseProperNouns(Buffer.from(`${h}oregon,keep,a state\n`))).toThrow(/a keep row needs a capital letter \(oregon has none\)/);
    expect(() => parseProperNouns(Buffer.from(`${h}Trans-Pecos,keep,a region\n`)).map((r) => r.word)).not.toThrow();
    expect(() => parseProperNouns(Buffer.from(`${h}Route 66,keep,x\n`))).toThrow(/not a word or a phrase/);
    expect(() => parseProperNouns(Buffer.from(`${h}St.,keep,x\n`))).toThrow(/not a word or a phrase/);
    expect(() => parseProperNouns(Buffer.from(`${h}Shepherd,lower,not a possessive\n`))).toThrow(/a lower row is for a possessive/);
    expect(() => parseProperNouns(Buffer.from(`${h}Bebb's,keep,a botanist\nBebb’s,keep,the same\n`))).toThrow(/kind of apostrophe \(row 3\)/);
    expect(parseProperNouns(Buffer.from(`${h}Mount St. Helens,keep,a volcano\nLadies',lower,not a person\nBebb’s,keep,a botanist\n`)).map((r) => r.word)).toEqual(["Mount St. Helens", "Ladies'", "Bebb’s"]);
    // A row number is the line the row is on, with the blank lines counted.
    expect(() => parseProperNouns(Buffer.from(`${h}\n\nUtah,keep,a state\n\noregon,keep,a state\n`))).toThrow(/row 6: a keep row needs/);
    // A file that is not a CSV is refused in the same words as the rest.
    expect(() => parseProperNouns(Buffer.from(`${h}Utah,keep,"a state\n`))).toThrow(/^plant proper nouns: /);
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
    // Synthetic: the title-case spelling.
    expect(await converted("Shepherd's Purse")).toBe("shepherd's purse");
    expect(await converted("Point Reyes Ceanothus")).toBe("Point Reyes ceanothus");
    // Rows added in beeline-rfkj.9's last batch: a word, the common-noun possessives, a place with a hyphen in it.
    expect(await converted("Korean Spice Viburnum")).toBe("Korean spice viburnum");
    // Synthetic: iNaturalist writes the first as "miner's lettuce", this is the title-case spelling it can also give, and the second is the list's "Fuller's teasel" in title case.
    expect(await converted("Miner's Lettuce")).toBe("miner's lettuce");
    expect(await converted("Fuller's Teasel")).toBe("fuller's teasel");
    expect(await converted("Trans-Pecos Poreleaf")).toBe("Trans-Pecos poreleaf");
  });

  test("every keep row of the file, as a name by itself, comes out as the file spells it, and a lower row comes out in lower case", async () => {
    await loadPlantList(conn);
    const all = (await rows("SELECT word, treatment FROM plant_proper_noun ORDER BY word")) as Array<[string, string]>;
    const wrong: string[] = [];
    for (const [word, treatment] of all) {
      const got = await converted(word.toUpperCase());
      const want = treatment === "keep" ? word : word.toLowerCase();
      if (got !== want) wrong.push(`${word} -> ${got}`);
    }
    expect(wrong).toEqual([]);
  });
});
