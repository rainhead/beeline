import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { canonicalJson, syncINat } from "../src/sync-inat.js";

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
    taxon: { id: 51048, name: "Salvia officinalis", rank: "species" },
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
  test("refuses to run silently anonymous", async () => {
    await expect(
      syncINat(conn, { projectId: 99706, token: null, fetchImpl: fakeApi([[]]) }),
    ).rejects.toThrow(/anonymous/);
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

  test("canonical json is order-insensitive", () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] })).toBe('{"a":[{"x":1,"y":2}],"b":1}');
  });
});
