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
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { refreshPlantNames } from "../src/app/jobs/registry.js";
import type { JobContext } from "../src/app/jobs/framework.js";
import { parseCsv } from "../src/corrections.js";
import { fetchPlantNames } from "../src/fetch-plant-names.js";
import { loadPlantList, loadPlantListAtBoot, plantListHash, OLD_BEELINE_PLANT_LIST_FILE, parsePlantList } from "../src/load-plant-list.js";
import { createMemoryDb } from "./helpers.js";

const ANSWERS: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("./fixtures/plant-names/answers.json", import.meta.url), "utf8"),
);

let conn: DuckDBConnection;
let instance: DuckDBInstance;
let asked: string[];

beforeEach(async () => {
  ({ conn, instance } = await createMemoryDb());
  asked = [];
});

afterEach(() => {
  conn.closeSync();
  instance.closeSync();
});

const rows = async (sql: string) =>
  ((await (await conn.run(sql)).getRows()) as unknown[][]).map((r) => r.map((v) => (typeof v === "bigint" ? Number(v) : v)));

/** The API as iNaturalist answered, by the name and ranks asked for; a name that was not captured has no hits, as the real one does for a name it does not know. */
function api(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url.toString());
    const ranks = url.searchParams.get("rank")!;
    // The answers were captured asking for a genus's own rank only; the request now also asks for the fallback ranks.
    const answer = ANSWERS[`${url.searchParams.get("q")}|${ranks}`] ?? ANSWERS[`${url.searchParams.get("q")}|${ranks.split(",")[0]}`];
    return new Response(JSON.stringify(answer ?? { total_results: 0, page: 1, per_page: 30, results: [] }));
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
  test("the real file parses; the family filed under the Family column is named by it", () => {
    const { rows: parsed, skippedWithoutName } = parsePlantList(readFileSync(OLD_BEELINE_PLANT_LIST_FILE));
    expect(parsed).toHaveLength(1405);
    expect(skippedWithoutName).toBe(0);
    // Family,Ericaceae,,,heath: the row has no Scientific_name, and its Rank is Family.
    expect(parsed.find((r) => r.scientific_name === "Ericaceae")).toMatchObject({ rank: "Family", family: "Ericaceae", common_name: "heath" });
    // The curly apostrophe survived, where it had been read as three other characters.
    expect(parsed.find((r) => r.scientific_name === "Polemonium carneum")!.common_name).toContain("Jacob’s-ladder");
    const maple = parsed.find((r) => r.scientific_name === "Acer macrophyllum")!;
    expect(maple).toMatchObject({ rank: "Species", family: "Sapindaceae", synonym: null, common_name: "bigleaf maple, Oregon maple" });
  });

  async function listFile(text: string) {
    const dir = await mkdtemp(join(tmpdir(), "beeline-plant-list-"));
    const path = join(dir, "list.csv");
    await writeFile(path, text);
    return path;
  }
  const HEADER = "Rank,Family,Scientific_name,Synonym,Common_name\n";

  test("a byte order mark and CRLF line ends do not become part of a name; empty cells are null", async () => {
    const path = await listFile(`\uFEFF${HEADER}Species,Rosaceae,Rubus idaeus,,red raspberry\nGenus,,,,no name at all\nFamily,Ericaceae,,,heath\n`.replaceAll("\n", "\r\n"));
    const r = await loadPlantList(conn, { path });
    expect(r).toEqual({ changed: true, entries: 2, skippedWithoutName: 1 });
    expect(await rows("SELECT scientific_name, rank, family, synonym, common_name FROM plant_list_entry")).toEqual([
      ["Rubus idaeus", "Species", "Rosaceae", null, "red raspberry"],
      ["Ericaceae", "Family", "Ericaceae", null, "heath"],
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

  test("a change to the loader reloads a list whose file did not change: the hash covers the loader's version", async () => {
    const text = `${HEADER}Species,Rosaceae,Rubus idaeus,,red raspberry\n`;
    const path = await listFile(text);
    await loadPlantList(conn, { path });
    const [[stored]] = (await rows("SELECT content_hash FROM plant_list")) as [[string]];
    expect(stored).toBe(plantListHash(Buffer.from(text)));
    expect(stored).not.toBe(createHash("sha256").update(text).digest("hex"));
    // A store loaded by a loader that hashed the bytes alone is loaded again, though the file is the same.
    await conn.run("UPDATE plant_list SET content_hash = $1", [createHash("sha256").update(text).digest("hex")]);
    expect((await loadPlantList(conn, { path })).changed).toBe(true);
    expect((await loadPlantList(conn, { path })).changed).toBe(false);
  });

  test("a parse error's row number counts the blank lines above it", async () => {
    const text = `${HEADER}\nSpecies,Rosaceae,Rubus idaeus,,a\n\nSpecies,Rosaceae,Rubus ursinus,,b,extra\n`;
    expect(() => parsePlantList(Buffer.from(text))).toThrow(/row 5 has 6 fields/);
    expect(() => parsePlantList(Buffer.from(`${HEADER}\nSpecies,Rosaceae,Rubus idaeus,,a\n\nSpecies,Rosaceae,Rubus idaeus,,b\n`))).toThrow(/Rubus idaeus appears twice \(row 5\)/);
  });

  test("a malformed file changes nothing", async () => {
    const good = await listFile(`${HEADER}Species,Rosaceae,Rubus idaeus,,red raspberry\n`);
    await loadPlantList(conn, { path: good });
    for (const bad of [
      `${HEADER}Species,Rosaceae,Rubus idaeus,,red,extra\n`,
      `${HEADER}Species,Rosaceae,Rubus idaeus,,a\nSpecies,Rosaceae,Rubus idaeus,,b\n`,
      "Rank,Name\nSpecies,Rubus\n",
      // A quote never closed would swallow every row after it, and the load would replace the list with the short version.
      `${HEADER}Species,Rosaceae,Rubus idaeus,,"red raspberry\nSpecies,Rosaceae,Rubus ursinus,,Pacific blackberry\n`,
      `${HEADER}Species,Rosaceae,Rubus idaeus,,red "raspberry"\n`,
      `${HEADER}Species,Rosaceae,Rubus idaeus,,"red" raspberry\n`,
    ]) {
      await expect(loadPlantList(conn, { path: await listFile(bad) })).rejects.toThrow(/plant list/);
    }
    expect(await rows("SELECT scientific_name, common_name FROM plant_list_entry")).toEqual([["Rubus idaeus", "red raspberry"]]);
    expect(await rows("SELECT count(*) FROM plant_list")).toEqual([[1]]);
  });

  test("strict parsing refuses malformed quoting and reads well-formed quoting as before", () => {
    expect(parseCsv('a,"b,c","d ""e"" f"\n', { strict: true })).toEqual([["a", "b,c", 'd "e" f']]);
    expect(() => parseCsv('a,"b\n', { strict: true })).toThrow(/never closed/);
    expect(() => parseCsv('a,b"c"\n', { strict: true })).toThrow(/middle of a field/);
    expect(() => parseCsv('a,"b"c\n', { strict: true })).toThrow(/after a closing quote/);
    // The lenient default is what the other files' loaders depend on.
    expect(parseCsv('a,"b\n')).toEqual([["a", "b\n"]]);
  });

  test("the boot carries on when the list cannot be loaded, and says what is left to look up when it can", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const reported: unknown[] = [];
    try {
      const failed = await loadPlantListAtBoot(() => instance.connect(), { path: join(tmpdir(), "no-such-plant-list.csv"), report: (e) => reported.push(e) });
      expect(failed).toBeNull();
      expect(reported).toHaveLength(1);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
    const logged: string[] = [];
    const path = await listFile(`${HEADER}Species,Rosaceae,Rubus idaeus,,red raspberry\nGenus,Rosaceae,Rubus,,\n`);
    const loaded = await loadPlantListAtBoot(() => instance.connect(), { path, log: (m) => logged.push(m) });
    expect(loaded).toMatchObject({ changed: true, entries: 2 });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("2 name(s) not yet looked up");
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
    // A retired subspecies of this name points at another taxon, and a current one has the name itself:
    // the active hit whose own name is the name wins outright.
    expect(o["Veronica peregrina xalapensis"]).toEqual(["matched", 491173]);
    // The same for the genus: iNaturalist has Abelia current, and a retired Abelia that points at another genus.
    expect(o["Abelia"]).toEqual(["matched", 155567]);
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
    expect(unmatched).toEqual({ Brassicoidae: "no match" });
    expect(await rows("SELECT inat_taxon_id, entries, scientific_names FROM plant_list_taxon_shared")).toEqual([
      [181525, 2, "Mentha piperita; Mentha × piperita"],
    ]);
  });

  test("every taxon the names' exact hits came to joins the taxon cache's worklist, not only the one a name resolved to", async () => {
    await lookUp();
    const wanted = (await rows("SELECT inat_taxon_id FROM inat_taxon_uncached")).map(([id]) => id);
    expect(wanted).toContain(181525);
    expect(wanted).toContain(1074432);
    // Veronica peregrina xalapensis: the current taxon it resolved to, and the retired one and its replacement it did not.
    expect(wanted).toContain(491173);
    expect(wanted).toContain(59030);
    expect(wanted).toContain(60317);
  });

  test("the job asks for the names, then has the taxa read", async () => {
    await addEntries(["Urtica dioica", "Species", null]);
    // A taxon that is stored and stale: the nightly's rolling refresh would read it, and this job must not.
    await conn.run("INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active, fetched_at) VALUES (123, 'Stale taxon', 'species', 10, true, TIMESTAMPTZ '2020-01-01 00:00:00+00')");
    const steps: string[] = [];
    const fetched: string[] = [];
    const both = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (!url.pathname.startsWith("/v2/taxa/")) return api()(input, init);
      // Synthetic taxa for the ids asked for: the taxa endpoint's shape, with a name made up from the id.
      fetched.push(url.pathname);
      const results = url.pathname.split("/").pop()!.split(",").map((id) => ({
        id: Number(id), name: `Taxon ${id}`, rank: "species", rank_level: 10, parent_id: 48460, is_active: true,
        preferred_common_name: null, ancestor_ids: [48460], current_synonymous_taxon_ids: null, ancestors: [],
      }));
      return new Response(JSON.stringify({ total_results: results.length, page: 1, per_page: 30, results }));
    }) as typeof fetch;
    const detail = await refreshPlantNames(conn, {
      fetchImpl: both,
      requestDelayMs: 0,
      step: async (label, fn) => {
        steps.push(label);
        return fn();
      },
    });
    expect(detail).toContain("1 of 1 plant list names answered");
    expect(await rows("SELECT count(*) FROM plant_name_lookup")).toEqual([[1]]);
    // The taxa read went through the same fetch, and a taxon the name led to is in the cache.
    expect(await rows("SELECT name FROM inat_taxon WHERE inat_taxon_id = 51884")).toEqual([["Taxon 51884"]]);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.join()).not.toContain("123");
    expect(await rows("SELECT fetched_at < TIMESTAMPTZ '2021-01-01 00:00:00+00' FROM inat_taxon WHERE inat_taxon_id = 123")).toEqual([[true]]);
    expect(steps).toEqual(["ask for plant names", "fetch taxa the names reached"]);
  });
});

describe("stopping early, dead ends, paging and ranks (synthetic answers)", () => {
  // Names and ids here are made up (Foo bar and the like), so that each case
  // is exactly the shape under test and nothing else; the real answers are above.
  type Hit = { id: number; name: string; rank: string; is_active: boolean; matched_term: string; current_synonymous_taxon_ids?: number[] };
  const hit = (id: number, name: string, rank: string, active: boolean, term = name, replaced: number[] = []): Hit => ({
    id, name, rank, is_active: active, matched_term: term, current_synonymous_taxon_ids: replaced,
  });
  const page = (total: number, results: Hit[]) => new Response(JSON.stringify({ total_results: total, page: 1, per_page: 30, results }));
  /** A fake taxa search: `answer` gets the name asked for and the page number. */
  const fake = (answer: (q: string, page: number) => Response) =>
    (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      asked.push(url.toString());
      return answer(url.searchParams.get("q")!, Number(url.searchParams.get("page")));
    }) as typeof fetch;
  const outcome = async (name: string) =>
    (await rows(`SELECT outcome, inat_taxon_id FROM plant_list_entry_taxon WHERE scientific_name = '${name}'`))[0];

  test("a 429 stops the run at once: nothing is stored for that name and no later name is asked", async () => {
    await addEntries(["Foo bar", "Species", null], ["Foo baz", "Species", null], ["Foo qux", "Species", null]);
    const log: string[] = [];
    const r = await fetchPlantNames(conn, { fetchImpl: fake(() => new Response("{}", { status: 429 })), requestDelayMs: 0, log: (m) => log.push(m) });
    expect(r).toMatchObject({ requested: 1, stored: 0, stoppedEarly: true });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("429");
    expect(log).toEqual(r.errors);
    expect(await rows("SELECT count(*) FROM plant_name_lookup")).toEqual([[0]]);
  });

  test("three failures in a row stop the run; a success in between starts the count again; every error is logged", async () => {
    await addEntries(...["a", "b", "c", "d", "e"].map((x) => [`Foo ${x}`, "Species", null] as [string, string, null]));
    const log: string[] = [];
    const r = await fetchPlantNames(conn, { fetchImpl: fake(() => new Response("{}", { status: 500 })), requestDelayMs: 0, log: (m) => log.push(m) });
    expect(r).toMatchObject({ requested: 3, stored: 0, stoppedEarly: true });
    expect(r.errors).toHaveLength(3);
    expect(log).toHaveLength(3); // the ones after the first are not lost
    expect(await rows("SELECT count(*) FROM plant_name_unlooked")).toEqual([[5]]);

    // Fail, fail, succeed, fail, fail, succeed: never three in a row.
    let n = 0;
    const flaky = fake(() => (++n % 3 === 0 ? page(0, []) : new Response("{}", { status: 500 })));
    const again = await fetchPlantNames(conn, { fetchImpl: flaky, requestDelayMs: 0 });
    expect(again.stoppedEarly).toBe(false);
    expect(again.stored).toBe(1); // only 5 names: fail, fail, ok, fail, fail
  });

  test("the job records its names step as failed after a 429, though the run carries on, and not after a deadline", async () => {
    await addEntries(["Foo bar", "Species", null]);
    const recorded: Array<[string, boolean]> = [];
    const step: JobContext["step"] = async (label, fn, failed) => {
      const result = await fn();
      recorded.push([label, failed ? failed(result) : false]);
      return result;
    };
    const detail = await refreshPlantNames(conn, { fetchImpl: fake(() => new Response("{}", { status: 429 })), requestDelayMs: 0, step });
    expect(detail).toContain("429");
    expect(recorded[0]).toEqual(["ask for plant names", true]);

    recorded.length = 0;
    const hang = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
    await refreshPlantNames(conn, { fetchImpl: hang, requestDelayMs: 0, deadlineMs: 20, step });
    expect(recorded[0]).toEqual(["ask for plant names", false]);
  });

  test("an aborted signal stops the run before the next request, and a deadline stops the job's run", async () => {
    await addEntries(["Foo bar", "Species", null], ["Foo baz", "Species", null]);
    const controller = new AbortController();
    const first = fake(() => {
      controller.abort();
      return page(0, []);
    });
    const r = await fetchPlantNames(conn, { fetchImpl: first, requestDelayMs: 0, signal: controller.signal });
    expect(r).toMatchObject({ requested: 1, stored: 1, stoppedEarly: true });

    // A request that hangs until its signal fires: the job's own deadline is what ends it.
    const hang = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
    const detail = await refreshPlantNames(conn, { fetchImpl: hang, requestDelayMs: 0, deadlineMs: 20 });
    expect(detail).toContain("0 of 1 plant list names answered");
    expect(detail).toContain("the rest wait for the next run");
    expect(await rows("SELECT count(*) FROM plant_name_unlooked")).toEqual([[1]]);
  });

  test("a retired hit with no replacement is a dead end: it makes the name ambiguous, and alone it is retired", async () => {
    await addEntries(["Foo bar", "Species", null], ["Foo baz", "Species", null], ["Foo qux", "Species", null]);
    const r = await fetchPlantNames(conn, {
      requestDelayMs: 0,
      fetchImpl: fake((q) =>
        q === "foo bar"
          ? // retired with no replacement, and an older name of a current taxon
            page(2, [hit(1, "Foo bar", "species", false), hit(2, "Baz qux", "species", true, "Foo bar")])
          : q === "foo baz"
            ? page(1, [hit(3, "Foo baz", "species", false)])
            : page(2, [hit(4, "Foo qux", "species", false, "Foo qux", [5]), hit(5, "Qux quux", "species", true, "Foo qux")]),
      ),
    });
    expect(r.stored).toBe(3);
    expect(await outcome("Foo bar")).toEqual(["ambiguous", null]); // the retired hit might be what was meant
    expect(await outcome("Foo baz")).toEqual(["retired, no replacement", null]);
    expect(await outcome("Foo qux")).toEqual(["matched", 5]); // the retired hit has a replacement, which is the other hit
  });

  test("a retired genus beside an active section of the name is retired with no replacement: the dead end stands, the fallback rank is not taken over it", async () => {
    await addEntries(["Foo", "Genus", null]);
    await fetchPlantNames(conn, {
      requestDelayMs: 0,
      fetchImpl: fake(() => page(2, [hit(1, "Foo", "genus", false), hit(2, "Foo", "section", true)])),
    });
    expect(await outcome("Foo")).toEqual(["retired, no replacement", null]);
  });

  /** Ask once, then have the cache find the taxon retired, so the name is due to be asked again. */
  async function dueAgain() {
    await addEntries(["Foo bar", "Species", null]);
    await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: fake(() => page(1, [hit(1, "Foo bar", "species", true)])) });
    await conn.run("INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active, fetched_at) VALUES (1, 'Foo bar', 'species', 10, false, now())");
    expect(await rows("SELECT name_key FROM plant_name_unlooked")).toEqual([["foo bar"]]);
  }

  test("a name asked again keeps its old answer when the request fails, is rate limited, or hits the cap", async () => {
    await dueAgain();
    for (const options of [
      { fetchImpl: fake(() => new Response("{}", { status: 500 })) },
      { fetchImpl: fake(() => new Response("{}", { status: 429 })) },
      { fetchImpl: fake(() => page(1, [])), maxRequests: 0 },
    ]) {
      await fetchPlantNames(conn, { requestDelayMs: 0, ...options });
      expect(await rows("SELECT count(*) FROM plant_name_lookup")).toEqual([[1]]);
      expect(await rows("SELECT inat_taxon_id FROM plant_name_lookup_hit")).toEqual([[1]]);
      expect(await outcome("Foo bar")).toEqual(["matched", 1]);
    }
  });

  test("a name asked again whose later page fails keeps its old answer", async () => {
    await dueAgain();
    const filler = Array.from({ length: 30 }, (_, i) => hit(100 + i, `Other ${i}`, "species", true));
    await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: fake((_q, pg) => (pg === 1 ? page(40, filler) : new Response("{}", { status: 500 }))) });
    expect(await rows("SELECT inat_taxon_id FROM plant_name_lookup_hit")).toEqual([[1]]);
    expect(await outcome("Foo bar")).toEqual(["matched", 1]);
  });

  describe("a name iNaturalist refuses", () => {
    const refusing = fake((q) => (q === "foo bad" ? new Response("{}", { status: 422 }) : page(1, [hit(7, "Foo good", "species", true, "Foo good")])));
    const lookup = async () => (await rows("SELECT answered, total_results FROM plant_name_lookup WHERE name_key = 'foo bad'"))[0];
    const age = (days: number) => conn.run(`UPDATE plant_name_lookup SET looked_up_at = now() - INTERVAL ${days} DAY WHERE NOT answered`);

    test("a 4xx is recorded at once as could not be asked, shows in the unmatched view, does not fail the step, and is asked again after 30 days", async () => {
      await addEntries(["Foo bad", "Species", null], ["Foo good", "Species", null]);
      const log: string[] = [];
      const r1 = await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: refusing, log: (m) => log.push(m) });
      expect(r1).toMatchObject({ stored: 1, refused: 1, errors: [], stoppedEarly: false });
      expect(log).toEqual(['iNat API 422 on /taxa for "foo bad": recorded as could not be asked']);
      expect(await lookup()).toEqual([false, 0]);
      expect(await outcome("Foo bad")).toEqual(["could not be asked", null]);
      expect(await rows("SELECT outcome FROM plant_list_entry_unmatched WHERE scientific_name = 'Foo bad'")).toEqual([["could not be asked"]]);
      // Not asked again for 30 days.
      await age(29);
      expect(await rows("SELECT count(*) FROM plant_name_unlooked")).toEqual([[0]]);
      asked.length = 0;
      expect(await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: refusing })).toMatchObject({ unlooked: 0, requested: 0 });
      expect(asked).toEqual([]);
      // After 31 days it is asked again, and answered when iNaturalist now answers it.
      await age(31);
      expect(await rows("SELECT name_key FROM plant_name_unlooked")).toEqual([["foo bad"]]);
      await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: fake(() => page(1, [hit(8, "Foo bad", "species", true)])) });
      expect(await outcome("Foo bad")).toEqual(["matched", 8]);
    });

    test("refused again when asked again, it is recorded again with a new time, so it waits another 30 days", async () => {
      await addEntries(["Foo bad", "Species", null]);
      await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: refusing });
      await age(31);
      expect(await rows("SELECT count(*) FROM plant_name_unlooked")).toEqual([[1]]);
      const r = await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: refusing });
      expect(r).toMatchObject({ refused: 1, errors: [] });
      expect(await rows("SELECT answered, looked_up_at > now() - INTERVAL 1 DAY FROM plant_name_lookup")).toEqual([[false, true]]);
      expect(await rows("SELECT count(*) FROM plant_name_unlooked")).toEqual([[0]]);
    });

    test("a 429 is not an answer about the name: nothing is recorded and the run stops", async () => {
      await addEntries(["Foo bad", "Species", null]);
      const r = await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: fake(() => new Response("{}", { status: 429 })) });
      expect(r).toMatchObject({ rateLimited: true, refused: 0 });
      expect(await rows("SELECT count(*) FROM plant_name_lookup")).toEqual([[0]]);
    });

    test("a 500 is never recorded: the name keeps its previous answer, fails the step, and is asked again next run", async () => {
      await dueAgain();
      const failing = fake(() => new Response("{}", { status: 500 }));
      const r = await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: failing });
      expect(r).toMatchObject({ stored: 0, refused: 0 });
      expect(r.errors).toHaveLength(1);
      expect(await outcome("Foo bar")).toEqual(["matched", 1]);
      expect(await rows("SELECT answered FROM plant_name_lookup")).toEqual([[true]]);
      expect(await rows("SELECT count(*) FROM plant_name_unlooked")).toEqual([[1]]);
    });

    test("a transient failure on a re-ask of a refused name leaves the row as it is: one request each run, never a retry within a run", async () => {
      await addEntries(["Foo bad", "Species", null]);
      await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: refusing });
      await age(31);
      const before = await rows("SELECT looked_up_at FROM plant_name_lookup");
      const failing = fake(() => new Response("{}", { status: 503 }));
      asked.length = 0;
      for (let night = 0; night < 3; night++) {
        const r = await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: failing });
        expect(r).toMatchObject({ unlooked: 1, requested: 1, refused: 0 });
        expect(r.errors).toHaveLength(1);
      }
      expect(asked).toHaveLength(3);
      expect(await rows("SELECT looked_up_at FROM plant_name_lookup")).toEqual(before);
      expect(await lookup()).toEqual([false, 0]);
    });
  });

  test("after a 429 the job makes no call to iNaturalist for taxa", async () => {
    await addEntries(["Foo bar", "Species", null], ["Foo baz", "Species", null]);
    const steps: string[] = [];
    const calls: string[] = [];
    await refreshPlantNames(conn, {
      requestDelayMs: 0,
      step: async (label, fn) => {
        steps.push(label);
        return fn();
      },
      // The first name is answered, so there are taxa to read; the second is refused.
      fetchImpl: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        return url.searchParams.get("q") === "foo bar" ? page(1, [hit(1, "Foo bar", "species", true)]) : new Response("{}", { status: 429 });
      }) as typeof fetch,
    });
    expect(steps).toEqual(["ask for plant names"]);
    expect(calls).toHaveLength(2);
  });

  test("an active hit whose own name is the name wins outright; two such taxa are ambiguous", async () => {
    await addEntries(["Foo bar", "Species", null], ["Foo baz", "Species", null]);
    await fetchPlantNames(conn, {
      requestDelayMs: 0,
      fetchImpl: fake((q) =>
        q === "foo bar"
          ? page(3, [hit(1, "Foo bar", "species", true), hit(2, "Foo bar", "species", false, "Foo bar", [9]), hit(3, "Other one", "species", true, "Foo bar")])
          : page(2, [hit(4, "Foo baz", "species", true), hit(5, "Foo baz", "species", true)]),
      ),
    });
    expect(await outcome("Foo bar")).toEqual(["matched", 1]);
    expect(await outcome("Foo baz")).toEqual(["ambiguous", null]);
  });

  test("a matched_term that is a common name is not taken for the name; one written as a scientific name is", async () => {
    await addEntries(["Iris foo", "Species", null], ["Aster bar", "Species", null]);
    await fetchPlantNames(conn, {
      requestDelayMs: 0,
      fetchImpl: fake((q) =>
        q === "iris foo"
          ? page(1, [hit(1, "Iris domestica", "species", true, "iris foo")]) // synthetic: a common name, as a lower-case term
          : page(1, [hit(2, "Symphyotrichum bar", "species", true, "Aster bar")]), // an older scientific name
      ),
    });
    expect(await outcome("Iris foo")).toEqual(["no match", null]);
    expect(await outcome("Aster bar")).toEqual(["matched", 2]);
  });

  test("a retired taxon found by its older scientific name counts when that term is capitalised, and not when it is a lower-case (common) name", async () => {
    await addEntries(["Fragaria vesca", "Species", null]);
    const answer = (term: string) =>
      fake(() =>
        page(2, [
          hit(50298, "Fragaria vesca", "species", true), // real ids, from the lookup of 2026-11-14
          hit(286077, "Potentilla vesca", "species", false, term), // real: retired, matched_term "Fragaria vesca"
        ]),
      );
    const seen = async () => (await rows("SELECT hit_taxon_id, own_name FROM plant_name_hit_current ORDER BY 1")).map((r) => r.join("/"));
    await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: answer("Fragaria vesca") });
    expect(await seen()).toEqual(["50298/true", "286077/false"]);
    // Active and own-named, so it wins; the retired hit stood for nothing else.
    expect(await outcome("Fragaria vesca")).toEqual(["matched", 50298]);
    // Synthetic: the same answer with the term in lower case, as iNaturalist writes a common name.
    await conn.run("DELETE FROM plant_name_lookup; DELETE FROM plant_name_lookup_hit");
    await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: answer("fragaria vesca") });
    expect(await seen()).toEqual(["50298/true"]);
  });

  test("a hit counts only at a rank the name's shape allows: a genus is not a species of the same name", async () => {
    await addEntries(["Foo bar", "Species", null]);
    await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: fake(() => page(1, [hit(1, "Foo bar", "genus", true)])) });
    expect(await outcome("Foo bar")).toEqual(["no match", null]);
  });

  test("a one-word name with no genus of that name may be a section, subgenus or supertribe; one with a genus stays the genus", async () => {
    await addEntries(["Foosect", "Genus", null], ["Foosub", "Genus", null], ["Foosuper", "Genus", null], ["Rubus", "Genus", null]);
    const r = await fetchPlantNames(conn, {
      requestDelayMs: 0,
      fetchImpl: fake((q) =>
        q === "foosect" ? page(1, [hit(1, "Foosect", "section", true)])
        : q === "foosub" ? page(1, [hit(2, "Foosub", "subgenus", true)])
        : q === "foosuper" ? page(1, [hit(3, "Foosuper", "supertribe", true)])
        : page(2, [hit(4, "Rubus", "genus", true), hit(5, "Rubus", "subgenus", true)]),
      ),
    });
    expect(r.stored).toBe(4);
    expect(await outcome("Foosect")).toEqual(["matched", 1]);
    expect(await outcome("Foosub")).toEqual(["matched", 2]);
    expect(await outcome("Foosuper")).toEqual(["matched", 3]);
    expect(await outcome("Rubus")).toEqual(["matched", 4]);
    // The search asks for the fallback ranks too, or the section would never be returned.
    expect(new URL(asked[0]!).searchParams.get("rank")).toBe("genus,subgenus,section,supertribe");
  });

  test("more than 30 results: every page is read, so a taxon of the name on a later page is seen", async () => {
    await addEntries(["Foo bar", "Species", null], ["Foo baz", "Species", null], ["Foo qux", "Species", null]);
    const filler = (from: number, n = 30) => Array.from({ length: n }, (_, i) => hit(from + i, `Other ${from + i}`, "species", true, `Other ${from + i}`));
    const r = await fetchPlantNames(conn, {
      requestDelayMs: 0,
      fetchImpl: fake((q, pg) =>
        q === "foo bar"
          ? pg === 1 ? page(35, filler(100)) : page(35, [hit(1, "Foo bar", "species", true)])
          : q === "foo qux"
            ? pg === 1 ? page(32, [hit(7, "Foo qux", "species", true), ...filler(400, 29)]) : page(32, [hit(8, "Foo qux", "species", true), hit(9, "Other 9", "species", true)])
            : page(65, pg === 1 ? filler(200) : pg === 2 ? filler(300) : [hit(9, "Other 9", "species", true)]),
      ),
    });
    expect(await outcome("Foo bar")).toEqual(["matched", 1]);
    expect(await outcome("Foo baz")).toEqual(["no match", null]); // three pages, and the results ran out
    // The name's own taxon is on page 1, and a second taxon of that name is on page 2.
    expect(await outcome("Foo qux")).toEqual(["ambiguous", null]);
    expect(r.requested).toBe(7);
    expect(await rows("SELECT total_results FROM plant_name_lookup ORDER BY 1")).toEqual([[32], [35], [65]]);
  });

  test("a lookup the page cap cuts short gives the name no taxon, and is not asked again every night", async () => {
    await addEntries(["Foo bar", "Species", null]);
    let n = 0;
    // Synthetic: 400 results, the name's own taxon on page 1, and pages full to the cap of ten.
    const r = await fetchPlantNames(conn, {
      requestDelayMs: 0,
      fetchImpl: fake((_q, pg) => {
        n += 1;
        const hits = Array.from({ length: 30 }, (_, i) => hit(pg * 100 + i, `Other ${pg * 100 + i}`, "species", true, `Other ${pg * 100 + i}`));
        return page(400, pg === 1 ? [hit(1, "Foo bar", "species", true), ...hits.slice(1)] : hits);
      }),
    });
    expect(n).toBe(10);
    expect(r.stored).toBe(1);
    expect(await outcome("Foo bar")).toEqual(["too many results", null]);
    expect(await rows("SELECT read_in_full FROM plant_name_lookup")).toEqual([[false]]);
    expect(await rows("SELECT count(*) FROM plant_name_unlooked")).toEqual([[0]]);
  });

  test("a shutdown after the names step begins, before any request, ends the job as a shutdown", async () => {
    await addEntries(["Foo bar", "Species", null]);
    const controller = new AbortController();
    const step: JobContext["step"] = async (_label, fn) => {
      controller.abort(new Error("shutting down"));
      return fn();
    };
    await expect(
      refreshPlantNames(conn, { fetchImpl: fake(() => page(0, [])), requestDelayMs: 0, signal: controller.signal, step }),
    ).rejects.toThrow(/shutting down/);
  });

  test("a later page that fails leaves no half-answer behind", async () => {
    await addEntries(["Foo bar", "Species", null]);
    const filler = Array.from({ length: 30 }, (_, i) => hit(100 + i, `Other ${i}`, "species", true));
    await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: fake((_q, pg) => (pg === 1 ? page(40, filler) : new Response("{}", { status: 500 }))) });
    expect(await rows("SELECT count(*) FROM plant_name_lookup_hit")).toEqual([[0]]);
    expect(await rows("SELECT count(*) FROM plant_name_unlooked")).toEqual([[1]]);
  });

  test("a name whose taxon the cache has since found retired is asked again, once", async () => {
    await addEntries(["Foo bar", "Species", null]);
    await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: fake(() => page(1, [hit(1, "Foo bar", "species", true)])) });
    expect(await rows("SELECT count(*) FROM plant_name_unlooked")).toEqual([[0]]);
    // The cache reads taxon 1 after the lookup, and it is retired now.
    await conn.run("INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active, fetched_at) VALUES (1, 'Foo bar', 'species', 10, false, now() + INTERVAL '1 minute')");
    expect(await rows("SELECT name_key FROM plant_name_unlooked")).toEqual([["foo bar"]]);
    await fetchPlantNames(conn, { requestDelayMs: 0, fetchImpl: fake(() => page(2, [hit(1, "Foo bar", "species", false, "Foo bar", [2]), hit(2, "Foo bar", "species", true)])) });
    expect(await outcome("Foo bar")).toEqual(["matched", 2]);
    expect(await rows("SELECT count(*) FROM plant_name_unlooked")).toEqual([[0]]);
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

  test("a subspecies with no entry of its own takes iNaturalist's name for it, not its species' entry", async () => {
    await resolveAll([["Urtica dioica", "Species", "stinging nettle"]]);
    await cache([[51884, "Urtica dioica", "species", null], [1074432, "Urtica dioica gracilis", "subspecies", "California nettle (iNaturalist)"]]);
    expect(await nameOf(1074432)).toEqual(["California nettle (iNaturalist)", "inaturalist", null, null]);
  });

  test("a subspecies with no entry of its own and no iNaturalist name takes its species' entry, one step up", async () => {
    await resolveAll([["Urtica dioica", "Species", "stinging nettle"]]);
    await cache([[51884, "Urtica dioica", "species", null], [1074432, "Urtica dioica gracilis", "subspecies", null]]);
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
    ]); // 'rhododendron, azalea' is two names at genus rank, so no name
  });

  test("a genus-or-above cell that holds several names is no name: the entry gives none, and the host takes iNaturalist's", async () => {
    // Cells lifted from the real file. A species' cell is synonyms, and the first is shown.
    await addEntries(
      ["Prunus", "Genus", "Plums, cherries, and allies"],
      ["Cichorieae", "Tribe", "lettuce, chicory, dandelion and salsify tribe"],
      ["Cucurbitaceae", "Family", "cucumber, gourd family"],
      ["Apiaceae", "Family", "carrot family"],
      ["Carduinae", "Subtribe", "thistles and burdocks"],
      ["Rhododendron", "Genus", "rhododendron, azalea"],
      ["Boraginaceae", "Family", "forget-me-not or borage"],
      ["Salvia", "Genus", "sage; salvia"],
      ["Magnolia", "Genus", "magnolia"],
      ["Linaria vulgaris", "Species", "butter and eggs, common toadflax"],
      ["Myosotis discolor", "Species", "changing forget-me-not, yellow and blue forget-me-not"],
    );
    expect(await rows("SELECT scientific_name FROM plant_list_entry_several_names ORDER BY 1")).toEqual([
      ["Boraginaceae"], ["Carduinae"], ["Cichorieae"], ["Cucurbitaceae"], ["Prunus"], ["Rhododendron"], ["Salvia"],
    ]);
    expect(await rows("SELECT scientific_name, common_name FROM plant_list_entry_common_name ORDER BY 1")).toEqual([
      ["Apiaceae", "carrot family"], // one name, so shown, though it names a group
      ["Linaria vulgaris", "butter and eggs"],
      ["Magnolia", "magnolia"],
      ["Myosotis discolor", "changing forget-me-not"],
    ]);
  });

  test("an ' or ' cell: at genus rank it gives no name and the host takes iNaturalist's; at species rank the cell is shown as written", async () => {
    // The rule is plant_list_entry_several_names; this is the behaviour it gives today (Peter, 2026-11-14).
    await resolveAll([
      ["Poaceae", "Genus", "grass or sedge"], // synthetic cell
      ["Urtica dioica", "Species", "stinging nettle or burning nettle"], // synthetic cell: a species' cell is not cut at 'or'
    ]);
    await cache([
      [777001, "Poa synthetic", "species", "synthetic bluegrass (iNaturalist)", [777001, 47434]], // synthetic taxon
      [777002, "Poa anonyma", "species", null, [777002, 47434]], // synthetic taxon
    ]);
    expect(await nameOf(777001)).toEqual(["synthetic bluegrass (iNaturalist)", "inaturalist", null, null]);
    expect(await nameOf(777002)).toBeUndefined();
    expect(await rows("SELECT common_name FROM plant_list_entry_common_name WHERE scientific_name = 'Urtica dioica'")).toEqual([["stinging nettle or burning nettle"]]);
  });

  test("the rule gives a species under a several-names entry iNaturalist's name, or none, and not the cell", async () => {
    await resolveAll([["Poaceae", "Genus", "grasses, sedges, and allies"]]); // synthetic cell, the real list's shape
    await cache([
      [777001, "Poa synthetic", "species", "synthetic bluegrass (iNaturalist)", [777001, 47434]], // synthetic taxon
      [777002, "Poa anonyma", "species", null, [777002, 47434]], // synthetic taxon
    ]);
    expect(await nameOf(777001)).toEqual(["synthetic bluegrass (iNaturalist)", "inaturalist", null, null]);
    expect(await nameOf(777002)).toBeUndefined();
  });

  test("a family's name covers a species the list has no entry for only where iNaturalist has no name", async () => {
    // Peter, 2026-11-14: a coarser entry's name ("mustard" for Tall Tumblemustard) is worse than
    // iNaturalist's name for the plant itself, so it is the last resort, not the first.
    await resolveAll([["Poaceae", "Genus", "grass"]]);
    await cache([
      [777001, "Poa synthetica", "species", "synthetic bluegrass (iNaturalist)", [777001, 47434]], // synthetic taxon
      [777002, "Poa anonyma", "species", null, [777002, 47434]], // synthetic taxon
    ]);
    expect(await nameOf(777001)).toEqual(["synthetic bluegrass (iNaturalist)", "inaturalist", null, null]);
    expect(await nameOf(777002)).toEqual(["grass", "list", "Poaceae", 1]);
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
