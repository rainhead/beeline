import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { BY_ID_SOURCE, canonicalJson, fetchObservationsById, syncINat } from "../src/sync-inat.js";
import { refreshCitedObservations } from "../src/app/jobs/registry.js";

let conn: DuckDBConnection;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
});

function obs(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    uuid: `uuid-${id}`,
    observed_on: "2026-07-14",
    geojson: { coordinates: [-123.262, 44.5646], type: "Point" },
    positional_accuracy: 30,
    public_positional_accuracy: 30,
    geoprivacy: null,
    taxon_geoprivacy: null,
    obscured: false,
    user: { id: 100, login: "adacollects", name: "Ada Collector" },
    // ancestor_ids is self-inclusive; 211194 = Tracheophyta
    taxon: { id: 51048, name: "Salvia officinalis", rank: "species", ancestor_ids: [48460, 47126, 211194, 47125, 48151, 51048] },
    ofvs: [
      { name: "sampleId", value: "1", datatype: "numeric" },
      { name: "numberOfSpecimens", value: "3", datatype: "numeric" },
    ],
    ...extra,
  };
}

/** Serves fixed pages; per_page=2 in tests so 2 full + 1 short page works. */
function fakeApi(pages: Array<Array<Record<string, unknown>>>): typeof fetch {
  let call = 0;
  return (async () => {
    const page = pages[Math.min(call, pages.length - 1)] ?? [];
    call += 1;
    return new Response(JSON.stringify({ results: page }), { status: 200 });
  }) as typeof fetch;
}

const base = { projectId: 99706, perPage: 2, pageDelayMs: 0, token: "test-jwt" };

describe("iNat sync", () => {
  test("refreshes observation_field when it loads something, and leaves it alone when it loads nothing", async () => {
    // The projection reads observation_load alone, so a run that added no
    // load cannot have changed it, and the whole-table refresh is skipped:
    // on the sandbox it was most of a dashboard check's time (beeline-yso).
    const first = await syncINat(conn, { ...base, fetchImpl: fakeApi([[obs(1)]]) });
    expect(first.newLoads).toBe(1);
    expect(await rows(conn, "SELECT inat_id FROM observation_field")).toEqual([[1n]]);
    expect(await rows(conn, "SELECT inat_id FROM observation_field_stale")).toEqual([]);
    // A row taken away by hand shows whether the next run refreshed.
    await conn.run("DELETE FROM observation_field");
    const again = await syncINat(conn, { ...base, fetchImpl: fakeApi([[obs(1)]]) });
    expect(again.newLoads).toBe(0);
    expect(await rows(conn, "SELECT inat_id FROM observation_field")).toEqual([]);
  });

  test("refuses to run silently anonymous", async () => {
    await expect(
      syncINat(conn, { projectId: 99706, token: null, fetchImpl: fakeApi([[]]) }),
    ).rejects.toThrow(/anonymous/);
  });

  /**
   * The `fields` parameter IS the projection: a field not asked for is not in
   * the stored load and no view can recover it later. Notes were missing from
   * every one of the dev store's 64,227 loads for exactly that reason
   * (beeline-hza), which is a failure no schema test could have caught.
   */
  test("asks iNaturalist for the whole projection, including the observer's notes", async () => {
    const asked: string[] = [];
    const recording = (async (input: string | URL | Request) => {
      asked.push(new URL(String(input)).searchParams.get("fields") ?? "");
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof fetch;
    await syncINat(conn, { ...base, fetchImpl: recording });
    const fields = (asked[0] ?? "").split(",");
    expect(fields).toContain("description");
    // The rest of it, so a field dropped by accident fails here rather than
    // showing up as a column that is quietly always null.
    for (const field of ["geojson", "private_geojson", "place_guess", "ofvs.value", "taxon.rank"]) {
      expect(fields, field).toContain(field);
    }
  });

  test("keyset sweep loads every observation and completes the run", async () => {
    const result = await syncINat(conn, {
      ...base,
      fetchImpl: fakeApi([[obs(1), obs(2)], [obs(3)]]),
    });
    expect(result).toMatchObject({ fetched: 3, newLoads: 3, unchanged: 0 });
    const [[completed, authenticated]] = (await rows(
      conn,
      "SELECT completed_at IS NOT NULL, authenticated FROM sync_run",
    )) as [[unknown, unknown]];
    expect([completed, authenticated]).toEqual([true, true]);
  });

  test("an aborted signal stops the sweep before the next page and rolls it back (beeline-fth)", async () => {
    const controller = new AbortController();
    let calls = 0;
    const api: typeof fetch = (async () => {
      calls += 1;
      controller.abort(); // the shutdown arrives while page one is being served
      return new Response(JSON.stringify({ results: [obs(1), obs(2)], total_results: 4 }), { status: 200 });
    }) as typeof fetch;
    await expect(syncINat(conn, { ...base, fetchImpl: api, signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(calls).toBe(1);
    // The transaction went with it: no run, no loads.
    const [[runs, loads]] = (await rows(conn, "SELECT count(*), (SELECT count(*) FROM observation_load) FROM sync_run")) as [[bigint, bigint]];
    expect([Number(runs), Number(loads)]).toEqual([0, 0]);
  });

  test("re-syncing unchanged data appends nothing; an edit appends one load", async () => {
    await syncINat(conn, { ...base, fetchImpl: fakeApi([[obs(1)]]) });
    const again = await syncINat(conn, { ...base, fetchImpl: fakeApi([[obs(1)]]) });
    expect(again).toMatchObject({ fetched: 1, newLoads: 0, unchanged: 1 });

    const edited = await syncINat(conn, {
      ...base,
      fetchImpl: fakeApi([[obs(1, { observed_on: "2026-07-15" })]]),
    });
    expect(edited).toMatchObject({ newLoads: 1 });
    const [[loads, current]] = (await rows(
      conn,
      `SELECT (SELECT count(*) FROM observation_load), (SELECT count(*) FROM observation_current)`,
    )) as [[unknown, unknown]];
    expect([loads, current]).toEqual([2n, 1n]); // history kept, one current
  });

  test("a failed run persists nothing", async () => {
    const failing = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    await expect(syncINat(conn, { ...base, fetchImpl: failing })).rejects.toThrow(/503/);
    const [[runs, loads]] = (await rows(
      conn,
      "SELECT (SELECT count(*) FROM sync_run), (SELECT count(*) FROM observation_load)",
    )) as [[unknown, unknown]];
    expect([runs, loads]).toEqual([0n, 0n]);
  });

  test("typed extraction reads the projection, junk stays verbatim", async () => {
    await syncINat(conn, {
      ...base,
      fetchImpl: fakeApi([
        [
          obs(7, {
            geoprivacy: "obscured",
            private_geojson: { coordinates: [-123.01, 44.01], type: "Point" },
            viewer_trusted_by_observer: true,
            ofvs: [
              { name: "sampleId", value: "ID 1", datatype: "numeric" },
              { name: "Number of bees collected", value: "5", datatype: "numeric" },
            ],
          }),
        ],
      ]),
    });
    const [row] = await rows(
      conn,
      `SELECT geoprivacy, viewer_trusted, private_latitude, sample_number_raw, specimen_count_raw
       FROM observation_current_fields WHERE inat_id = 7`,
    );
    expect(row).toEqual(["obscured", true, 44.01, "ID 1", "5"]);
  });

  test("count mismatch between observation and sample is a warning finding", async () => {
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    const sampleId = await insertCleanSample(conn, {
      specimen_count: "3",
      inat_observation_id: "42",
    });
    await syncINat(conn, {
      ...base,
      fetchImpl: fakeApi([
        [obs(42, { ofvs: [{ name: "numberOfSpecimens", value: "5", datatype: "numeric" }] })],
      ]),
    });
    const findings = await rows(
      conn,
      `SELECT rule_name, details FROM qc_finding WHERE sample_id = ${sampleId} AND rule_name = 'count_mismatch'`,
    );
    expect(findings).toEqual([["count_mismatch", "observation says 5 but sample count is 3"]]);
    const printable = await rows(conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${sampleId}`);
    expect(printable).toHaveLength(1); // warning, not blocking
  });

  test("a non-vascular-plant host blocks; a tracheophyte or ancestry-less load stays silent", async () => {
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    const moss = await insertCleanSample(conn, { inat_observation_id: "42" });
    const sage = await insertCleanSample(conn, { sample_number: "'2'", inat_observation_id: "43" });
    const stale = await insertCleanSample(conn, { sample_number: "'3'", inat_observation_id: "44" });
    await syncINat(conn, {
      ...base,
      fetchImpl: fakeApi([
        [
          obs(42, { taxon: { id: 56327, name: "Bryum argenteum", rank: "species", ancestor_ids: [48460, 47126, 311249, 56327] } }),
          obs(43),
        ],
        // A load predating ancestor_ids in the projection: no verdict, no finding.
        [obs(44, { taxon: { id: 51048, name: "Salvia officinalis", rank: "species" } })],
      ]),
    });
    // The detail IS a scientific name, so the rule reports it as one — name
    // and rank, for TaxonName to set — and leaves `details` for the case
    // where the projection has an id and no name (beeline-dys).
    const flagged = await rows(
      conn,
      "SELECT sample_id, details, detail_taxon_name, detail_taxon_rank FROM qc_finding WHERE rule_name = 'non_tracheophyte_host'",
    );
    expect(flagged).toEqual([[moss, null, "Bryum argenteum", "species"]]);
    expect(await rows(conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${moss}`)).toHaveLength(0);
    expect(await rows(conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${sage}`)).toHaveLength(1);
    expect(await rows(conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${stale}`)).toHaveLength(1);
  });

  test("absence from a completed covering run blocks; a window that misses the date does not; reappearing clears", async () => {
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    const sampleId = await insertCleanSample(conn, { inat_observation_id: "42" });
    await syncINat(conn, { ...base, fetchImpl: fakeApi([[obs(42)]]) });

    const missing = async () =>
      rows(conn, `SELECT rule_name FROM qc_finding WHERE sample_id = ${sampleId} AND rule_name = 'observation_missing_upstream'`);

    // A window that cannot contain observed_on (2026-07-14) is not covering.
    await syncINat(conn, { ...base, d1: "2026-08-01", d2: "2026-08-20", fetchImpl: fakeApi([[]]) });
    expect(await missing()).toHaveLength(0);

    // An unbounded run over the same source that comes back empty is.
    await syncINat(conn, { ...base, fetchImpl: fakeApi([[]]) });
    expect(await missing()).toEqual([["observation_missing_upstream"]]);
    const printable = await rows(conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${sampleId}`);
    expect(printable).toHaveLength(0); // blocking

    // Seen again (even unchanged, no new load) — the finding clears.
    await syncINat(conn, { ...base, fetchImpl: fakeApi([[obs(42)]]) });
    expect(await missing()).toHaveLength(0);
  });

  test("an incremental (updated_since) run never claims coverage — and sends the param", async () => {
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    const sampleId = await insertCleanSample(conn, { inat_observation_id: "42" });
    await syncINat(conn, { ...base, fetchImpl: fakeApi([[obs(42)]]) });

    // Empty incremental run: observation 42 wasn't updated — that is NOT
    // evidence it is gone, so no missing-upstream finding may appear.
    const urls: string[] = [];
    const capturing: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    await syncINat(conn, { ...base, updatedSince: "2026-08-20T00:00:00Z", fetchImpl: capturing });

    expect(urls[0]).toContain("updated_since=2026-08-20T00%3A00%3A00Z");
    const run = await rows(conn, `SELECT updated_since FROM sync_run ORDER BY entity_id DESC LIMIT 1`);
    expect(run[0]![0]).not.toBeNull();
    const missing = await rows(
      conn,
      `SELECT rule_name FROM qc_finding WHERE sample_id = ${sampleId} AND rule_name = 'observation_missing_upstream'`,
    );
    expect(missing).toHaveLength(0);

    // The same emptiness from a full sweep IS evidence.
    await syncINat(conn, { ...base, fetchImpl: fakeApi([[]]) });
    const after = await rows(
      conn,
      `SELECT rule_name FROM qc_finding WHERE sample_id = ${sampleId} AND rule_name = 'observation_missing_upstream'`,
    );
    expect(after).toEqual([["observation_missing_upstream"]]);
  });

  test("reads particular observations by id, as a run of its own kind, recording only what it asked for", async () => {
    const urls: string[] = [];
    const api: typeof fetch = async (input) => {
      urls.push(String(input));
      // 43 is gone upstream; 77 was never asked for and must not be recorded.
      return new Response(JSON.stringify({ results: [obs(42, { geoprivacy: "private" }), obs(77)] }), { status: 200 });
    };
    const r = await fetchObservationsById(conn, { ids: [42, 43, 42], token: "test-jwt", fetchImpl: api, pageDelayMs: 0 });
    expect(r).toMatchObject({ asked: 2, fetched: 1, newLoads: 1, unchanged: 0 });
    expect(new URL(urls[0]!).searchParams.get("id")).toBe("42,43");
    expect(new URL(urls[0]!).searchParams.has("project_id")).toBe(false);
    expect(await rows(conn, `SELECT source, fetched_by_id, completed_at IS NOT NULL FROM sync_run`)).toEqual([[BY_ID_SOURCE, true, true]]);
    expect(await rows(conn, `SELECT inat_id FROM observation_seen ORDER BY 1`)).toEqual([[42n]]);
    // And the shredded form is there for promotion to read.
    expect(await rows(conn, `SELECT inat_id, geoprivacy FROM observation_field`)).toEqual([[42n, "private"]]);
  });

  test("asks in requests of two hundred ids", async () => {
    const asked: number[] = [];
    const api: typeof fetch = async (input) => {
      asked.push(new URL(String(input)).searchParams.get("id")!.split(",").length);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    const ids = Array.from({ length: 450 }, (_, i) => i + 1);
    await fetchObservationsById(conn, { ids, token: "test-jwt", fetchImpl: api, pageDelayMs: 0 });
    expect(asked).toEqual([200, 200, 50]);
  });

  test("a by-id run never claims coverage of an observation it did not ask for", async () => {
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    const swept = await insertCleanSample(conn, { inat_observation_id: "42" });
    const cited = await insertCleanSample(conn, { sample_number: "'2'", inat_observation_id: "55" });
    await syncINat(conn, { ...base, fetchImpl: fakeApi([[obs(42)]]) });
    await fetchObservationsById(conn, { ids: [55], token: "test-jwt", fetchImpl: fakeApi([[obs(55)]]), pageDelayMs: 0 });
    // A later by-id run that asks about neither.
    await fetchObservationsById(conn, { ids: [99], token: "test-jwt", fetchImpl: fakeApi([[]]), pageDelayMs: 0 });
    const missing = await rows(
      conn,
      `SELECT sample_id FROM qc_finding WHERE sample_id IN (${swept}, ${cited}) AND rule_name = 'observation_missing_upstream'`,
    );
    expect(missing).toEqual([]);
  });

  test("the nightly asks only for the observations samples cite that no sync has read, and never fails the run", async () => {
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    await insertCleanSample(conn, { inat_observation_id: "42" });
    await insertCleanSample(conn, { sample_number: "'2'", inat_observation_id: "55" });
    await insertCleanSample(conn, { sample_number: "'3'" });
    await syncINat(conn, { ...base, fetchImpl: fakeApi([[obs(42)]]) });
    const asked: string[] = [];
    const api: typeof fetch = async (input) => {
      asked.push(new URL(String(input)).searchParams.get("id")!);
      return new Response(JSON.stringify({ results: [obs(55, { taxon_geoprivacy: "obscured" })] }), { status: 200 });
    };
    expect(await refreshCitedObservations(conn, { token: "test-jwt", fetchImpl: api, pageDelayMs: 0 })).toBe(
      "1 of 1 cited observations read by id (1 new)",
    );
    expect(asked).toEqual(["55"]);
    expect(await refreshCitedObservations(conn, { token: "test-jwt", fetchImpl: api })).toBe("every cited observation read");
    // iNaturalist failing is a line in the run's detail, not a failed run.
    await insertCleanSample(conn, { sample_number: "'4'", inat_observation_id: "66" });
    const down: typeof fetch = async () => new Response("", { status: 503 });
    expect(await refreshCitedObservations(conn, { token: "test-jwt", fetchImpl: down })).toMatch(/^cited observations not read \(iNat API 503/);
    expect(await rows(conn, `SELECT count(*) FROM sync_run WHERE fetched_by_id`)).toEqual([[1n]]);
  });

  test("canonical json is order-insensitive", () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] })).toBe('{"a":[{"x":1,"y":2}],"b":1}');
  });

  test("a truncated sweep rolls back instead of posing as a covering run (beeline-m3k)", async () => {
    // The API says 5 observations exist but pagination dries up after 3.
    const withTotals: typeof fetch = (() => {
      const pages = [[obs(1), obs(2)], [obs(3)]];
      let call = 0;
      return async () =>
        new Response(JSON.stringify({ results: pages[Math.min(call++, pages.length - 1)] ?? [], total_results: 5 }), {
          status: 200,
        });
    })() as typeof fetch;
    await expect(syncINat(conn, { ...base, fetchImpl: withTotals })).rejects.toThrow(/3 of 5/);
    const [[runs]] = (await rows(conn, "SELECT count(*) FROM sync_run")) as [[unknown]];
    expect(runs).toBe(0n);
  });

  test("pagination that fails to advance aborts instead of looping forever", async () => {
    // A second full page whose max id is not past the cursor — an API
    // ignoring id_above. (Identical ids would trip the observation_seen
    // primary key; either way the run aborts rather than spinning.)
    await expect(
      syncINat(conn, { ...base, fetchImpl: fakeApi([[obs(10), obs(20)], [obs(5), obs(6)]]) }),
    ).rejects.toThrow(/did not advance/);
  });

  test("per_page is clamped to the API maximum of 200", async () => {
    const urls: string[] = [];
    const capturing: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    await syncINat(conn, { ...base, perPage: 500, fetchImpl: capturing });
    expect(urls[0]).toContain("per_page=200");
  });
});
