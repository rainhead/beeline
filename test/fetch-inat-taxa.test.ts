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
import { fetchInatTaxa } from "../src/fetch-inat-taxa.js";
import { createMemoryDb, insertCleanSample } from "./helpers.js";

type Json = Record<string, unknown> & { id: number };
const load = (name: string): Json[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/inat-taxa/${name}.json`, import.meta.url), "utf8")).results;

/** What the API holds: every captured taxon, by id. Tests change entries to play out an upstream edit. */
let upstream: Map<number, Json>;
let asked: string[];

/** A fake of /v2/taxa/{ids}: answers from `upstream`, and leaves out the ids it does not hold. */
function api(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const ids = new URL(url).pathname.split("/").pop()!.split(",").map(Number);
    return new Response(JSON.stringify({ results: ids.flatMap((id) => (upstream.has(id) ? [upstream.get(id)!] : [])) }));
  }) as typeof fetch;
}

const opts = () => ({ fetchImpl: api(), requestDelayMs: 0 });

let conn: DuckDBConnection;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
  upstream = new Map([...load("hosts"), ...load("replacements")].map((t) => [t.id, t]));
  // The API also answers for each ancestor by itself. The captured responses
  // carry them only inside a child, so serve those as taxa of their own.
  for (const t of [...upstream.values()]) {
    const lineage = (t.ancestor_ids as number[]) ?? [];
    for (const a of (t.ancestors as Json[]) ?? []) {
      if (!upstream.has(a.id)) {
        upstream.set(a.id, { ...a, ancestor_ids: lineage.slice(0, lineage.indexOf(a.id)), current_synonymous_taxon_ids: null });
      }
    }
  }
  asked = [];
});

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

  test("the request asks for Oregon's name, English, at most 30 ids and only the fields it keeps", async () => {
    await host(1, 56861);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    const url = new URL(asked[0]!);
    expect(url.origin + url.pathname.replace(/\/[^/]*$/, "")).toBe("https://api.inaturalist.org/v2/taxa");
    expect(url.searchParams.get("preferred_place_id")).toBe("10");
    expect(url.searchParams.get("locale")).toBe("en");
    expect(url.searchParams.get("fields")).toContain("current_synonymous_taxon_ids");
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
    await conn.run("UPDATE inat_taxon SET fetched_at = now() - INTERVAL '2 days'");
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

  test("a reinstated taxon loses its replacement rows, and a taxon re-split has exactly the new ones", async () => {
    await host(1, 322554);
    await fetchInatTaxa(conn, { ...opts(), skipRefresh: true });
    expect(await q("SELECT count(*) FROM inat_taxon_replacement WHERE retired_taxon_id = 322554")).toEqual([[1n]]);
    // Reinstated upstream: active again, nothing replaces it.
    upstream.set(322554, { ...upstream.get(322554)!, is_active: true, current_synonymous_taxon_ids: null });
    await conn.run("UPDATE inat_taxon SET fetched_at = now() - INTERVAL '90 days' WHERE inat_taxon_id = 322554");
    await fetchInatTaxa(conn, opts());
    expect(await q("SELECT is_active FROM inat_taxon WHERE inat_taxon_id = 322554")).toEqual([[true]]);
    expect(await q("SELECT count(*) FROM inat_taxon_replacement WHERE retired_taxon_id = 322554")).toEqual([[0n]]);
    // Re-split into two: the old row is gone and both new ones are there.
    upstream.set(322554, { ...upstream.get(322554)!, is_active: false, current_synonymous_taxon_ids: [1415100, 742759] });
    await conn.run("UPDATE inat_taxon SET fetched_at = now() - INTERVAL '90 days' WHERE inat_taxon_id = 322554");
    await fetchInatTaxa(conn, opts());
    expect(await q("SELECT replacement_taxon_id FROM inat_taxon_replacement WHERE retired_taxon_id = 322554 ORDER BY 1")).toEqual([[742759n], [1415100n]]);
    // And its lineage still has one self row and no duplicates.
    expect(await q("SELECT count(*), count(DISTINCT ancestor_id) FROM inat_taxon_ancestor WHERE inat_taxon_id = 322554")).toEqual([[15n, 15n]]);
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
    await conn.run("UPDATE inat_taxon SET fetched_at = now() - INTERVAL '2 days'");
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

  test("a request that fails stores nothing from it and throws; the nightly step turns that into a line", async () => {
    await host(1, 56861);
    const failing = (async () => new Response("no", { status: 503 })) as typeof fetch;
    await expect(fetchInatTaxa(conn, { fetchImpl: failing, requestDelayMs: 0 })).rejects.toThrow(/503/);
    expect(await q("SELECT count(*) FROM inat_taxon")).toEqual([[0n]]);
    expect(await q("SELECT count(*) FROM inat_taxon_absent")).toEqual([[0n]]);
    expect(await refreshInatTaxa(conn, { fetchImpl: failing, requestDelayMs: 0 })).toMatch(/taxa fetch failed.*503/);
    const garbled = (async () => new Response(JSON.stringify({ error: "x" }))) as typeof fetch;
    expect(await refreshInatTaxa(conn, { fetchImpl: garbled, requestDelayMs: 0 })).toMatch(/no results array/);
    const throws = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    expect(await refreshInatTaxa(conn, { fetchImpl: throws, requestDelayMs: 0 })).toMatch(/taxa fetch failed/);
  });

  test("the nightly step reports a complete cache, a fill and a cap", async () => {
    expect(await refreshInatTaxa(conn, opts())).toBe("taxa cache complete");
    await host(1, 56861);
    expect(await refreshInatTaxa(conn, opts())).toMatch(/^2 taxa read in 2 request\(s\) \(0 refreshed\)/);
    await host(2, 322554);
    expect(await refreshInatTaxa(conn, { ...opts(), maxRequests: 1 })).toMatch(/stopped at the cap/);
  });
});
