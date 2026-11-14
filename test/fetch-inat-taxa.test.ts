// The iNaturalist taxon cache (schema/066, schema/112, src/fetch-inat-taxa.ts,
// beeline-rfkj.1). The responses in test/fixtures/inat-taxa are captured from
// the real API (v2, with the fetcher's own fields list) on 2026-11-13, so the
// shapes here are the ones iNaturalist sends, including the two that are easy
// to get wrong: ancestor_ids leaves the taxon out, and the ancestors array
// leaves out the root.
import { readFileSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, test } from "vitest";
import { refreshInatTaxa } from "../src/app/jobs/registry.js";
import { fetchInatTaxa, TAXON_FIELDS } from "../src/fetch-inat-taxa.js";
import { createMemoryDb, insertCleanSample } from "./helpers.js";

type Json = Record<string, unknown> & { id: number };
const load = (name: string): Json[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/inat-taxa/${name}.json`, import.meta.url), "utf8")).results;

/** What the API holds: every captured taxon, by id. Tests change entries to play out an upstream edit. */
let upstream: Map<number, Json>;
let asked: string[];

/** The body iNaturalist sent, captured, for a single id it does not hold: status 404, an empty list. */
const ABSENT_BODY = readFileSync(new URL("./fixtures/inat-taxa/absent.json", import.meta.url), "utf8");

const idsOf = (url: string) => new URL(url).pathname.split("/").pop()!.split(",").map(Number);

/**
 * A fake of /v2/taxa/{ids} that answers as the real one does (checked by
 * calling it on 2026-11-13): several ids answer 200 with the ones it holds,
 * and a single id it does not hold answers 404 with the captured empty list.
 * `respond` lets a test refuse some requests.
 */
function api(respond?: (ids: number[]) => Response | undefined): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const ids = idsOf(url);
    const refused = respond?.(ids);
    if (refused) return refused;
    const results = ids.flatMap((id) => (upstream.has(id) ? [upstream.get(id)!] : []));
    if (ids.length === 1 && results.length === 0) return new Response(ABSENT_BODY, { status: 404 });
    return new Response(JSON.stringify({ total_results: results.length, page: 1, per_page: 30, results }));
  }) as typeof fetch;
}

const opts = () => ({ fetchImpl: api(), requestDelayMs: 0 });

let conn: DuckDBConnection;

/** An ancestor served as a taxon of its own: the real API gives it an `ancestors` array too, of what is above it (and not the root). */
function ancestorAsTaxon(a: Json, child: Json): Json {
  const lineage = (child.ancestor_ids as number[]) ?? [];
  const at = lineage.indexOf(a.id);
  const above = new Set(lineage.slice(0, at));
  return {
    ...a,
    ancestor_ids: lineage.slice(0, at),
    current_synonymous_taxon_ids: null,
    ancestors: ((child.ancestors as Json[]) ?? []).filter((x) => above.has(x.id)),
  };
}

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
  upstream = new Map([...load("hosts"), ...load("replacements"), ...load("split")].map((t) => [t.id, t]));
  // The API also answers for each ancestor by itself. The captured responses
  // carry them only inside a child, so serve those as taxa of their own.
  for (const t of [...upstream.values()]) {
    for (const a of (t.ancestors as Json[]) ?? []) {
      if (!upstream.has(a.id)) upstream.set(a.id, ancestorAsTaxon(a, t));
    }
  }
  asked = [];
});

/** `n` taxa of no particular kind, held upstream and named as hosts on observations, so a run has more than one request's worth. */
async function manyHosts(n: number, first = 8_000_000, held = true) {
  for (let i = 0; i < n; i++) {
    const id = first + i;
    if (held) {
      upstream.set(id, {
        id, name: `Plantus ${id}`, rank: "species", rank_level: 10, parent_id: 47126, is_active: true,
        preferred_common_name: null, ancestor_ids: [48460, 47126], current_synonymous_taxon_ids: null,
        ancestors: [{ id: 47126, name: "Plantae", rank: "kingdom", rank_level: 70, parent_id: 48460, is_active: true, preferred_common_name: "Plants" }],
      });
    }
    await conn.run(`INSERT INTO observation_field (inat_id, host_taxon_id) VALUES (${first + i}, ${id})`);
  }
}

const ageAll = (interval = "13 hours") => conn.run(`UPDATE inat_taxon SET fetched_at = now() - INTERVAL '${interval}'`);
/** Make one taxon the stalest, so the rolling refresh picks it. */
const ageOne = (id: number, interval = "90 days") =>
  conn.run(`UPDATE inat_taxon SET fetched_at = now() - INTERVAL '${interval}' WHERE inat_taxon_id = ${id}`);

const host = (n: number, taxonId: number) => insertCleanSample(conn, { sample_number: `'${n}'`, host_inat_taxon_id: String(taxonId) });
const q = async (sql: string) => (await (await conn.run(sql)).getRows()) as unknown[][];
const uncached = async () => (await q("SELECT inat_taxon_id FROM inat_taxon_uncached ORDER BY 1")).map((r) => Number(r[0]));

describe("the worklist", () => {
  test("is the hosts on samples and on observations, until they are stored", async () => {
    await host(1, 56861);
    await conn.run("INSERT INTO observation_field (inat_id, host_taxon_id) VALUES (900001, 887293)");
    expect(await uncached()).toEqual([56861, 887293]);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(await uncached()).toEqual([]);
    expect(await q("SELECT count(*) FROM inat_taxon WHERE inat_taxon_id IN (56861, 887293)")).toEqual([[2n]]);
  });

  test("a current taxon is stored with its Oregon common name, its lineage and itself at depth 0", async () => {
    await host(1, 56861);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(await q("SELECT name, rank, rank_level, parent_id, is_active, preferred_common_name FROM inat_taxon WHERE inat_taxon_id = 56861")).toEqual([
      ["Symphyotrichum chilense", "species", 10, 1416880n, true, "Pacific Aster"],
    ]);
    // 13 ids in ancestor_ids, none of them the taxon; the self row makes 14.
    expect(await q("SELECT count(*) FROM inat_taxon_ancestor WHERE inat_taxon_id = 56861")).toEqual([[14n]]);
    expect(await q("SELECT depth FROM inat_taxon_ancestor WHERE inat_taxon_id = 56861 AND ancestor_id = 56861")).toEqual([[0]]);
    expect(await q("SELECT depth FROM inat_taxon_ancestor WHERE inat_taxon_id = 56861 AND ancestor_id = 1416880")).toEqual([[1]]);
    expect(await q("SELECT depth FROM inat_taxon_ancestor WHERE inat_taxon_id = 56861 AND ancestor_id = 48460")).toEqual([[13]]);
    // No replacements for a current taxon.
    expect(await q("SELECT count(*) FROM inat_taxon_replacement")).toEqual([[0n]]);
  });

  test("the request asks for Oregon's name, English, and only the fields it keeps", async () => {
    await host(1, 56861);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    const url = new URL(asked[0]!);
    expect(url.origin + url.pathname.replace(/\/[^/]*$/, "")).toBe("https://api.inaturalist.org/v2/taxa");
    expect(url.searchParams.get("preferred_place_id")).toBe("10");
    expect(url.searchParams.get("locale")).toBe("en");
    expect(url.searchParams.get("fields")).toBe(TAXON_FIELDS);
    expect(url.searchParams.get("fields")).toContain("current_synonymous_taxon_ids");
  });

  test("more than 30 ids on the worklist go in requests of at most 30, each with the fields list", async () => {
    await manyHosts(65);
    const r = await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    const sizes = asked.map((u) => idsOf(u).length);
    // 65 hosts and Plantae, which none of them has stored yet: 30, 30 and 6.
    expect(sizes.slice(0, 3)).toEqual([30, 30, 6]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(30);
    for (const u of asked) {
      expect(new URL(u).searchParams.get("fields")).toBe(TAXON_FIELDS);
      expect(new URL(u).searchParams.get("per_page")).toBe("30");
    }
    expect(r.cached).toBeGreaterThanOrEqual(65);
    expect(await uncached()).toEqual([]);
  });

  test("ancestors come from the child's response, and the root, which that response leaves out, is fetched by id", async () => {
    await host(1, 56861);
    const r = await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(r.ancestorsStored).toBe(12);
    // Genus Symphyotrichum is stored with its own lineage, taken from the child's.
    expect(await q("SELECT name, rank FROM inat_taxon WHERE inat_taxon_id = 56112")).toEqual([["Symphyotrichum", "genus"]]);
    expect(await q("SELECT count(*) FROM inat_taxon_ancestor WHERE inat_taxon_id = 56112")).toEqual([[11n]]);
    // Life took a second request; nothing else did.
    expect(r.requested).toBe(2);
    expect(await q("SELECT name, parent_id FROM inat_taxon WHERE inat_taxon_id = 48460")).toEqual([["Life", null]]);
  });
});

describe("retired taxa", () => {
  test("322554, a subspecies replaced by a species its stale parent is not, keeps its stale lineage and gains the replacement", async () => {
    await host(1, 322554);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(await q("SELECT is_active, parent_id FROM inat_taxon WHERE inat_taxon_id = 322554")).toEqual([[false, 56861n]]);
    expect(await q("SELECT replacement_taxon_id FROM inat_taxon_replacement WHERE retired_taxon_id = 322554")).toEqual([[79294n]]);
    // The replacement was fetched in its turn, with its own lineage.
    expect(await q("SELECT name, is_active FROM inat_taxon WHERE inat_taxon_id = 79294")).toEqual([["Symphyotrichum ascendens", true]]);
    expect(await uncached()).toEqual([]);
  });

  test("887293, a genus replaced by a section, is followed to the section", async () => {
    await host(1, 887293);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(await q("SELECT replacement_taxon_id FROM inat_taxon_replacement WHERE retired_taxon_id = 887293")).toEqual([[742759n]]);
    expect(await q("SELECT rank FROM inat_taxon WHERE inat_taxon_id = 742759")).toEqual([["section"]]);
  });

  test("1415100 is the replacement of two retired names, 148304 and 78444, and both are stored as retired", async () => {
    await host(1, 148304);
    await host(2, 78444);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(await q("SELECT retired_taxon_id FROM inat_taxon_replacement WHERE replacement_taxon_id = 1415100 ORDER BY 1")).toEqual([[78444n], [148304n]]);
    expect(await q("SELECT count(*) FROM inat_taxon WHERE inat_taxon_id = 1415100 AND is_active")).toEqual([[1n]]);
  });

  test("a chain is followed: A replaced by B, and B retired later, brings in B's replacement", async () => {
    await host(1, 148304);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(await q("SELECT count(*) FROM inat_taxon WHERE inat_taxon_id = 742759")).toEqual([[0n]]);
    // Upstream retires B (1415100) in favour of 742759, a day later.
    upstream.set(1415100, { ...upstream.get(1415100)!, is_active: false, current_synonymous_taxon_ids: [742759] });
    // Read 13 hours ago: a night's run, about a day after the last, finds it due.
    await ageAll();
    // B is the replacement of a retired taxon, so it is read again tonight,
    // and what it names is fetched in the same run.
    expect(await q("SELECT inat_taxon_id FROM inat_taxon_recheck")).toEqual([[1415100n]]);
    const r = await fetchInatTaxa(conn, { ...opts(), maxRequests: 10 });
    expect(await q("SELECT is_active FROM inat_taxon WHERE inat_taxon_id = 1415100")).toEqual([[false]]);
    expect(await q("SELECT replacement_taxon_id FROM inat_taxon_replacement WHERE retired_taxon_id = 1415100")).toEqual([[742759n]]);
    expect(await q("SELECT count(*) FROM inat_taxon WHERE inat_taxon_id = 742759")).toEqual([[1n]]);
    expect(await uncached()).toEqual([]);
    expect(r.capped).toBe(false);
  });

  test("a reinstated taxon loses its replacement rows", async () => {
    await host(1, 322554);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(await q("SELECT count(*) FROM inat_taxon_replacement WHERE retired_taxon_id = 322554")).toEqual([[1n]]);
    // Reinstated upstream: active again, nothing replaces it.
    upstream.set(322554, { ...upstream.get(322554)!, is_active: true, current_synonymous_taxon_ids: null });
    await ageAll();
    await ageOne(322554);
    await fetchInatTaxa(conn, opts());
    expect(await q("SELECT is_active FROM inat_taxon WHERE inat_taxon_id = 322554")).toEqual([[true]]);
    expect(await q("SELECT count(*) FROM inat_taxon_replacement WHERE retired_taxon_id = 322554")).toEqual([[0n]]);
  });

  test("1588297, a species iNaturalist split into three, has all three as replacements, and a later lump leaves exactly one", async () => {
    // Captured from the real API: Symphyotrichum oolentangiense, retired and
    // replaced by the species and two of its subspecies.
    await host(1, 1588297);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(await q("SELECT replacement_taxon_id FROM inat_taxon_replacement WHERE retired_taxon_id = 1588297 ORDER BY 1")).toEqual([[130371n], [1588301n], [1588302n]]);
    expect(await q("SELECT count(*) FROM inat_taxon WHERE inat_taxon_id IN (130371, 1588301, 1588302) AND is_active")).toEqual([[3n]]);
    expect(await uncached()).toEqual([]);
    // Upstream changes its mind: one replacement. The other rows must go.
    upstream.set(1588297, { ...upstream.get(1588297)!, current_synonymous_taxon_ids: [130371] });
    await ageAll();
    await ageOne(1588297);
    await fetchInatTaxa(conn, opts());
    expect(await q("SELECT replacement_taxon_id FROM inat_taxon_replacement WHERE retired_taxon_id = 1588297")).toEqual([[130371n]]);
    // Its lineage has one self row and no duplicates.
    expect(await q("SELECT count(*) = count(DISTINCT ancestor_id), count(*) FILTER (WHERE depth = 0) FROM inat_taxon_ancestor WHERE inat_taxon_id = 1588297")).toEqual([[true, 1n]]);
  });
});

describe("what comes back empty, and how a run ends", () => {
  test("an id iNaturalist does not return is recorded absent and not asked again", async () => {
    await host(1, 99999999999);
    const r = await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(r.unresolved).toEqual([99999999999]);
    expect(await q("SELECT inat_taxon_id FROM inat_taxon_absent")).toEqual([[99999999999n]]);
    expect(await uncached()).toEqual([]);
    asked.length = 0;
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(asked).toEqual([]);
  });

  test("the worklist empties, and a second run asks for nothing but the refresh's thirtieth", async () => {
    for (const [i, id] of [56861, 322554, 887293, 148304].entries()) await host(i + 1, id);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(await uncached()).toEqual([]);
    const stored = (await q("SELECT count(*) FROM inat_taxon"))[0]![0];
    // Read just now, so none of it is due: a cold fill does not refresh itself.
    expect((await fetchInatTaxa(conn, opts())).requested).toBe(0);
    // Read 6 hours ago is not due, 13 hours ago is: the rule must catch a
    // run about a day after the last, which "older than a day" did not.
    await ageAll("6 hours");
    expect((await fetchInatTaxa(conn, opts())).requested).toBe(0);
    await ageAll();
    asked.length = 0;
    const r = await fetchInatTaxa(conn, opts());
    // A thirtieth of what is stored, rounded up, and the replacements of the
    // retired hosts, which may or may not be among the stalest; one request.
    expect(r.refreshed).toBeGreaterThanOrEqual(Math.ceil(Number(stored) / 30));
    expect(r.refreshed).toBeLessThanOrEqual(Math.ceil(Number(stored) / 30) + 3);
    expect(r.requested).toBe(1);
  });

  test("an interrupted run resumes: what one run stored, the next does not ask for again", async () => {
    await host(1, 56861);
    await host(2, 322554);
    await host(3, 887293);
    const first = await fetchInatTaxa(conn, { ...opts(), skipRefresh: true, maxRequests: 1 });
    expect(first.capped).toBe(true);
    expect(await uncached()).not.toEqual([]);
    asked.length = 0;
    const second = await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(second.capped).toBe(false);
    expect(await uncached()).toEqual([]);
    // Nothing asked twice across the two runs.
    const idsAsked = asked.flatMap((u) => new URL(u).pathname.split("/").pop()!.split(","));
    expect(new Set(idsAsked).size).toBe(idsAsked.length);
    expect(idsAsked).not.toContain("56861");
  });

  test("a request that fails stores nothing from it and is reported, not thrown; the nightly step turns that into a line", async () => {
    await host(1, 56861);
    const failing = (async () => new Response("no", { status: 503 })) as typeof fetch;
    const r = await fetchInatTaxa(conn, { fetchImpl: failing, requestDelayMs: 0 });
    expect(r.errors[0]).toMatch(/503/);
    expect(r.failed).toEqual([56861]);
    expect(await q("SELECT count(*) FROM inat_taxon")).toEqual([[0n]]);
    // Failed is not absent: the next run asks again.
    expect(await q("SELECT count(*) FROM inat_taxon_absent")).toEqual([[0n]]);
    expect(await uncached()).toEqual([56861]);
    expect(await refreshInatTaxa(conn, { fetchImpl: failing, requestDelayMs: 0 })).toMatch(/1 taxon id\(s\) could not be read \(56861\).*503/);
    const garbled = (async () => new Response(JSON.stringify({ error: "x" }))) as typeof fetch;
    expect(await refreshInatTaxa(conn, { fetchImpl: garbled, requestDelayMs: 0 })).toMatch(/no results array/);
    expect(await q("SELECT count(*) FROM inat_taxon_absent")).toEqual([[0n]]);
    const throws = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    expect(await refreshInatTaxa(conn, { fetchImpl: throws, requestDelayMs: 0 })).toMatch(/fetch failed/);
  });

  test("a captured 404 for a single id is the answer 'not here', not a failure", async () => {
    await host(1, 99999999999);
    const r = await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(r.errors).toEqual([]);
    expect(r.unresolved).toEqual([99999999999]);
  });

  test("an id that cannot be answered costs only itself: the batch is asked again in halves", async () => {
    for (const [i, id] of [56861, 887293, 666, 322554, 148304].entries()) await host(i + 1, id);
    upstream.set(666, { id: 666 });
    const poisoned = api((ids) => (ids.includes(666) ? new Response("bad", { status: 400 }) : undefined));
    const r = await fetchInatTaxa(conn, { fetchImpl: poisoned, requestDelayMs: 0, skipRefresh: true });
    expect(r.failed).toEqual([666]);
    expect(r.errors).toHaveLength(1);
    // Everything else was stored, and 666 is neither stored nor recorded absent.
    expect(await q("SELECT count(*) FROM inat_taxon WHERE inat_taxon_id IN (56861, 887293, 322554, 148304)")).toEqual([[4n]]);
    expect(await q("SELECT count(*) FROM inat_taxon_absent")).toEqual([[0n]]);
    // The first request carried all five ids, and the next ones are halves of it.
    const sizes = asked.map((u) => idsOf(u).length);
    expect(sizes[0]).toBe(5);
    expect(sizes.slice(1, 3)).toEqual([3, 2]);
    expect(asked.map((u) => idsOf(u))).toContainEqual([666]);
  });

  test("an API that is down stops the phase after three failures in a row, not after every id", async () => {
    await manyHosts(8);
    const down = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const r = await fetchInatTaxa(conn, { fetchImpl: down, requestDelayMs: 0 });
    // 8 ids narrowed to a single id takes three requests more, and the third
    // single id failing in a row ends the phase: 8, 4, 2, 1, 1, 2, 1 is seven.
    // The refresh phase runs after and finds nothing stored to refresh.
    expect(r.requested).toBe(7);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(await q("SELECT count(*) FROM inat_taxon")).toEqual([[0n]]);
  });

  test("the refresh still runs when the worklist could not be finished", async () => {
    await host(1, 56861);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    await ageAll();
    // A new host that the API rate-limits stops the worklist, and 56861 is still refreshed.
    await host(2, 777);
    upstream.set(777, { id: 777 });
    const limited = api((ids) => (ids.includes(777) ? new Response("slow down", { status: 429 }) : undefined));
    const r = await fetchInatTaxa(conn, { fetchImpl: limited, requestDelayMs: 0 });
    expect(r.errors.join()).toMatch(/429/);
    expect(r.refreshed).toBeGreaterThan(0);
  });

  test("the nightly step reports a complete cache, a fill and a cap", async () => {
    expect(await refreshInatTaxa(conn, opts())).toBe("taxa cache complete");
    await host(1, 56861);
    expect(await refreshInatTaxa(conn, opts())).toMatch(/^2 taxa read in 2 request\(s\) \(0 refreshed\)/);
    await host(2, 322554);
    expect(await refreshInatTaxa(conn, { ...opts(), maxRequests: 1 })).toMatch(/stopped at the cap/);
  });
});

describe("a taxon whose lineage changes", () => {
  test("loses the ancestors it no longer has, and its depths are renumbered", async () => {
    await host(1, 56861);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    const before = await q("SELECT ancestor_id, depth FROM inat_taxon_ancestor WHERE inat_taxon_id = 56861 ORDER BY depth");
    expect(before.length).toBe(14);
    const old = (upstream.get(56861)!.ancestor_ids as number[]);
    expect(before).toContainEqual([56112n, old.length - old.indexOf(56112)]);
    expect(before).toContainEqual([48460n, 13]);
    // Upstream moves the species to another genus (9000001) and inserts a rank
    // (9000002) above the family, which pushes every depth above it up one.
    const t = upstream.get(56861)!;
    const lineage = (t.ancestor_ids as number[]).map((a) => (a === 56112 ? 9000001 : a));
    lineage.splice(5, 0, 9000002);
    upstream.set(56861, { ...t, ancestor_ids: lineage, parent_id: lineage.at(-1)! });
    await ageAll();
    await ageOne(56861);
    await fetchInatTaxa(conn, opts());
    const after = await q("SELECT ancestor_id, depth FROM inat_taxon_ancestor WHERE inat_taxon_id = 56861 ORDER BY depth");
    expect(after.map((r) => Number(r[0]))).not.toContain(56112);
    expect(after).toContainEqual([9000001n, lineage.length - lineage.indexOf(9000001)]);
    expect(after).toContainEqual([48460n, 14]);
    // One self row, no duplicates, depths 0..14 each once.
    expect(after.map((r) => r[1])).toEqual(Array.from({ length: 15 }, (_, i) => i));
  });
});

describe("what the API tells us about ancestors", () => {
  test("an inactive ancestor in a response is not stored from it, and is fetched itself", async () => {
    await host(1, 56861);
    const t = upstream.get(56861)!;
    upstream.set(56861, {
      ...t,
      ancestors: (t.ancestors as Json[]).map((a) => (a.id === 56112 ? { ...a, is_active: false } : a)),
    });
    const r = await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(r.ancestorsStored).toBe(11);
    // It reached the cache by a request of its own (and Life by another).
    expect(asked.some((u) => idsOf(u).includes(56112))).toBe(true);
    expect(await q("SELECT is_active FROM inat_taxon WHERE inat_taxon_id = 56112")).toEqual([[true]]);
  });

  test("a retired child's response supplies no ancestors: its lineage is stale", async () => {
    await host(1, 322554);
    // After the first request only: 322554 is stored, and none of the
    // ancestors its response listed, because that lineage is stale. They come
    // later, from the worklist and from the replacement's current response.
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true, maxRequests: 1 });
    expect(await q("SELECT count(*) FROM inat_taxon")).toEqual([[1n]]);
    expect(idsOf(asked[0]!)).toEqual([322554]);
  });

  test("an ancestor the child's ancestor_ids does not list is not stored with only its own row", async () => {
    await host(1, 56861);
    const t = upstream.get(56861)!;
    upstream.set(56861, { ...t, ancestors: [...(t.ancestors as Json[]), { id: 5551212, name: "Stray", rank: "genus", rank_level: 20, parent_id: 47126, is_active: true }] });
    // Nothing upstream by that id, so the worklist cannot fetch it either.
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(await q("SELECT count(*) FROM inat_taxon WHERE inat_taxon_id = 5551212")).toEqual([[0n]]);
    expect(await q("SELECT count(*) FROM inat_taxon_ancestor WHERE inat_taxon_id = 5551212")).toEqual([[0n]]);
  });

  test("a result with no usable name or rank is skipped, and neither stored nor recorded absent", async () => {
    await host(1, 56861);
    upstream.set(56861, { id: 56861 });
    const r = await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(r.cached).toBe(0);
    expect(r.unresolved).toEqual([]);
    expect(await q("SELECT count(*) FROM inat_taxon_absent")).toEqual([[0n]]);
    expect(await uncached()).toEqual([56861]);
  });

  test("a chain that has already formed when the first taxon is fetched is followed in the same run", async () => {
    upstream.set(1415100, { ...upstream.get(1415100)!, is_active: false, current_synonymous_taxon_ids: [742759] });
    await host(1, 148304);
    const r = await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(r.capped).toBe(false);
    expect(await q("SELECT retired_taxon_id, replacement_taxon_id FROM inat_taxon_replacement ORDER BY 1")).toEqual([[148304n, 1415100n], [1415100n, 742759n]]);
    expect(await q("SELECT count(*) FROM inat_taxon WHERE inat_taxon_id = 742759")).toEqual([[1n]]);
    expect(await uncached()).toEqual([]);
  });
});

describe("absent verdicts", () => {
  test("a stored taxon that a refresh no longer gets back keeps its row, and is not chosen again", async () => {
    await host(1, 56861);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    await ageAll();
    await ageOne(56861);
    upstream.delete(56861);
    const r = await fetchInatTaxa(conn, opts());
    expect(r.unresolved).toContain(56861);
    expect(await q("SELECT count(*) FROM inat_taxon WHERE inat_taxon_id = 56861")).toEqual([[1n]]);
    expect(await q("SELECT count(*) FROM inat_taxon_absent WHERE inat_taxon_id = 56861")).toEqual([[1n]]);
    asked.length = 0;
    await fetchInatTaxa(conn, opts());
    expect(asked.flatMap(idsOf)).not.toContain(56861);
  });

  test("a response that lists a stored taxon as an ancestor clears its verdict", async () => {
    await host(1, 56861);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    // Genus 56112 is stored, and a verdict says it is gone, though iNaturalist has it.
    await conn.run("INSERT INTO inat_taxon_absent (inat_taxon_id) VALUES (56112)");
    // 79294 is another species of that genus; its response lists 56112 among its ancestors.
    await host(2, 79294);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(await q("SELECT count(*) FROM inat_taxon_absent")).toEqual([[0n]]);
  });

  test("an old verdict is asked about again, and a recent one is not", async () => {
    await host(1, 99999999999);
    await host(2, 99999999998);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(await q("SELECT count(*) FROM inat_taxon_absent")).toEqual([[2n]]);
    expect(await uncached()).toEqual([]);
    // One of them was asked 31 days ago, the other 29.
    await conn.run("UPDATE inat_taxon_absent SET asked_at = now() - INTERVAL '31 days' WHERE inat_taxon_id = 99999999999");
    await conn.run("UPDATE inat_taxon_absent SET asked_at = now() - INTERVAL '29 days' WHERE inat_taxon_id = 99999999998");
    expect(await uncached()).toEqual([99999999999]);
    // iNaturalist has it back.
    upstream.set(99999999999, { ...upstream.get(56861)!, id: 99999999999 });
    asked.length = 0;
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(asked.flatMap(idsOf)).toContain(99999999999);
    expect(asked.flatMap(idsOf)).not.toContain(99999999998);
    expect(await q("SELECT count(*) FROM inat_taxon WHERE inat_taxon_id = 99999999999")).toEqual([[1n]]);
    expect(await q("SELECT count(*) FROM inat_taxon_absent WHERE inat_taxon_id = 99999999999")).toEqual([[0n]]);
  });

  test("a stored taxon recorded absent over 30 days ago is read again by the refresh", async () => {
    await host(1, 56861);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    await ageAll();
    await ageOne(56861);
    await conn.run("INSERT INTO inat_taxon_absent (inat_taxon_id, asked_at) VALUES (56861, now() - INTERVAL '31 days')");
    asked.length = 0;
    await fetchInatTaxa(conn, opts());
    expect(asked.flatMap(idsOf)).toContain(56861);
    expect(await q("SELECT count(*) FROM inat_taxon_absent")).toEqual([[0n]]);
  });
});

describe("the limits of one run", () => {
  test("the cap stops the refresh phase at a batch boundary", async () => {
    await manyHosts(900);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    await ageAll();
    asked.length = 0;
    // A thirtieth of some 900 taxa is over 30 ids: two requests, and the cap allows one.
    const r = await fetchInatTaxa(conn, { ...opts(), maxRequests: 1 });
    expect(r.capped).toBe(true);
    expect(r.requested).toBe(1);
    expect(r.refreshed).toBe(30);
  });

  test("a deadline during the refresh stops the run with the batches already stored kept", async () => {
    await manyHosts(900);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    await ageAll();
    const controller = new AbortController();
    const inner = api();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await inner(input, init);
      controller.abort(new Error("deadline"));
      return response;
    }) as typeof fetch;
    await expect(fetchInatTaxa(conn, { fetchImpl, requestDelayMs: 0, signal: controller.signal })).rejects.toThrow(/deadline/);
    // The first batch of the refresh was stored before the run stopped.
    expect(await q("SELECT count(*) FROM inat_taxon WHERE fetched_at > now() - INTERVAL '1 hour'")).toEqual([[30n]]);
  });

  test("the nightly step ends at its deadline and says so, but rethrows a shutdown", async () => {
    await manyHosts(65);
    const slow = api();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 40));
      return slow(input, init);
    }) as typeof fetch;
    const line = await refreshInatTaxa(conn, { fetchImpl, requestDelayMs: 0, deadlineMs: 10 });
    expect(line).toMatch(/taxa fetch stopped after/);
    // Whatever it stored before the deadline stays.
    expect(await q("SELECT count(*) FROM inat_taxon")).not.toEqual([[0n]]);
    const controller = new AbortController();
    const stopping = (async (input: string | URL | Request, init?: RequestInit) => {
      controller.abort(new Error("shutting down"));
      return slow(input, init);
    }) as typeof fetch;
    await expect(refreshInatTaxa(conn, { fetchImpl: stopping, requestDelayMs: 0, signal: controller.signal })).rejects.toThrow(/shutting down/);
  });
});
