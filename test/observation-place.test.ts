import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, rows } from "./helpers.js";
import { canonicalJson } from "../src/sync-inat.js";
import { fetchPlaces } from "../src/fetch-places.js";
import { refreshObservationFields } from "../src/refresh-observation-fields.js";

/**
 * Reading an observation's geography, and the two observation fields nothing
 * was reading (beeline-2yt).
 *
 * The place ids and admin levels here are the real ones, checked against the
 * live API when this was written — Oregon 10, Washington 46, Benton County
 * 484, United States 1 — because the whole claim being tested is that
 * admin_level 0/10/20 means country/state/county, and a test using invented
 * levels would only be testing itself. Same reason
 * test/legacy-name-parse.test.ts lifts its corpus from production staging.
 */

let conn: DuckDBConnection;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
});

const count = async (sql: string) => Number(((await rows(conn, sql))[0] ?? [0])[0]);

/** The real place records, as /v1/places returns them. */
const PLACES: Record<number, { name: string; admin_level: number | null; ancestor_place_ids: number[] | null }> = {
  1: { name: "United States", admin_level: 0, ancestor_place_ids: [97394, 1] },
  10: { name: "Oregon", admin_level: 10, ancestor_place_ids: [97394, 1, 10] },
  46: { name: "Washington", admin_level: 10, ancestor_place_ids: [97394, 1, 46] },
  484: { name: "Benton", admin_level: 20, ancestor_place_ids: [97394, 1, 10, 484] },
  535: { name: "Linn", admin_level: 20, ancestor_place_ids: [97394, 1, 10, 535] },
  // The kind of place that makes up most of an observation's place_ids and
  // must be ignored: no admin_level at all.
  117097: { name: "Willamette Valley EcoRegion", admin_level: null, ancestor_place_ids: null },
  6712: { name: "Canada", admin_level: 0, ancestor_place_ids: [97394, 6712] },
  7085: { name: "British Columbia", admin_level: 10, ancestor_place_ids: [97394, 6712, 7085] },
};

async function seedPlaces(ids: number[]): Promise<void> {
  for (const id of ids) {
    const p = PLACES[id];
    if (!p) throw new Error(`test fixture has no place ${id}`);
    await conn.run(
      `INSERT INTO inat_place (inat_place_id, name, admin_level, ancestor_place_ids)
       VALUES ($1, $2, $3, CAST($4 AS BIGINT[]))`,
      [id, p.name, p.admin_level, p.ancestor_place_ids ? `[${p.ancestor_place_ids.join(",")}]` : null] as never,
    );
  }
}

async function stageLoad(o: Record<string, unknown>): Promise<void> {
  await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
  await conn.run(
    `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
     VALUES ($1, (SELECT max(entity_id) FROM sync_run), $2, $3)`,
    [Number(o.id), canonicalJson(o), `hash-${o.id}`] as never,
  );
}

describe("observation_place", () => {
  test("resolves country, state and county, and the two-letter code with them", async () => {
    await seedPlaces([1, 10, 484, 117097]);
    await stageLoad({ id: 1, place_ids: [1, 10, 484, 117097] });

    expect(await rows(conn, `SELECT country_name, state_name, state_province, country_code, county_name
                             FROM observation_place`)).toEqual([
      ["United States", "Oregon", "OR", "USA", "Benton"],
    ]);
  });

  test("ignores places with no admin_level — most of what an observation carries", async () => {
    await seedPlaces([117097]);
    await stageLoad({ id: 1, place_ids: [117097] });
    expect(await rows(conn, "SELECT state_place_id, county_place_id FROM observation_place")).toEqual([
      [null, null],
    ]);
  });

  test("an observation with no place ids is still a row — 'we cannot say where' is an answer", async () => {
    await stageLoad({ id: 1, place_guess: "somewhere" });
    expect(await rows(conn, "SELECT inat_id, state_province FROM observation_place")).toEqual([[1n, null]]);
  });

  test("private_place_ids win over place_ids, as private coordinates do", async () => {
    // The population the trust apparatus exists for: iNat withholds place_ids
    // on a private observation and delivers private_place_ids to a trusted
    // reader. Unexercised by the dev corpus, which was synced without trust.
    await seedPlaces([1, 10, 46]);
    await stageLoad({ id: 1, geoprivacy: "private", place_ids: [1, 46], private_place_ids: [1, 10] });
    expect(await rows(conn, "SELECT state_province FROM observation_place")).toEqual([["OR"]]);
  });

  test("a state iNat knows and atlas_region does not leaves the code null, not the row missing", async () => {
    // qc_rule_place_unrecognised's job, and it needs a row to fire on.
    await conn.run("UPDATE atlas_region SET inat_place_id = NULL WHERE state_province = 'OR'");
    await seedPlaces([1, 10]);
    await stageLoad({ id: 1, place_ids: [1, 10] });
    expect(await rows(conn, "SELECT state_name, state_province FROM observation_place")).toEqual([
      ["Oregon", null],
    ]);
  });

  test("British Columbia resolves to CAN, so the code is not US-only", async () => {
    await seedPlaces([6712, 7085]);
    await stageLoad({ id: 1, place_ids: [6712, 7085] });
    expect(await rows(conn, "SELECT state_province, country_code FROM observation_place")).toEqual([
      ["BC", "CAN"],
    ]);
  });
});

describe("observation_place_ambiguous", () => {
  test("empty when each level resolves once — the case the corpus shows", async () => {
    await seedPlaces([1, 10, 484]);
    await stageLoad({ id: 1, place_ids: [1, 10, 484] });
    expect(await count("SELECT count(*) FROM observation_place_ambiguous")).toBe(0);
  });

  test("two counties on one observation are named, and the lowest id is taken", async () => {
    await seedPlaces([1, 10, 484, 535]);
    await stageLoad({ id: 1, place_ids: [1, 10, 484, 535] });

    expect(await rows(conn, "SELECT admin_level, places, names FROM observation_place_ambiguous")).toEqual([
      [20, 2, "Benton | Linn"],
    ]);
    // Arbitrary but stable: a tie broken differently between runs would move
    // a sample between atlases with nothing to show for it.
    expect(await rows(conn, "SELECT county_place_id FROM observation_place")).toEqual([[484n]]);
  });
});

describe("atlas_region place ids", () => {
  test("every region has one, and they are distinct", async () => {
    expect(await count("SELECT count(*) FROM atlas_region WHERE inat_place_id IS NULL")).toBe(0);
    expect(await count("SELECT count(DISTINCT inat_place_id) FROM atlas_region")).toBe(
      await count("SELECT count(*) FROM atlas_region"),
    );
  });

  test("where an atlas carries a place id, it agrees with its region's", async () => {
    // Only Washington's was ever documented (schema/010 leaves the other five
    // null on purpose). This is what stops the two copies drifting apart.
    expect(
      await rows(
        conn,
        `SELECT a.code, a.inat_place_id, r.inat_place_id
         FROM atlas a JOIN atlas_region r ON r.atlas_id = a.entity_id
         WHERE a.inat_place_id IS NOT NULL AND a.inat_place_id IS DISTINCT FROM r.inat_place_id`,
      ),
    ).toEqual([]);
    // …and that the join above is not vacuously empty.
    expect(await count("SELECT count(*) FROM atlas WHERE inat_place_id IS NOT NULL")).toBe(1);
  });
});

describe("inat_place_uncached", () => {
  test("names exactly the ids no row exists for, and empties as they arrive", async () => {
    await seedPlaces([1, 10]);
    await stageLoad({ id: 1, place_ids: [1, 10, 484] });
    expect(await rows(conn, "SELECT inat_place_id FROM inat_place_uncached")).toEqual([[484n]]);
    await seedPlaces([484]);
    expect(await count("SELECT count(*) FROM inat_place_uncached")).toBe(0);
  });

  test("it is what the fetcher asks for, so 'missing' is defined once", async () => {
    await stageLoad({ id: 1, place_ids: [10, 484] });
    const asked: string[] = [];
    const result = await fetchPlaces(conn, {
      requestDelayMs: 0,
      fetchImpl: (async (url: string) => {
        asked.push(String(url));
        const ids = String(url).split("/places/")[1]!.split(",").map(Number);
        return {
          ok: true,
          json: async () => ({
            results: ids.map((id) => ({ id, ...PLACES[id] })),
          }),
        };
      }) as unknown as typeof fetch,
    });

    expect(asked).toEqual(["https://api.inaturalist.org/v1/places/10,484"]);
    expect(result).toMatchObject({ missing: 2, requested: 1, cached: 2, unresolved: [] });
    expect(await count("SELECT count(*) FROM inat_place_uncached")).toBe(0);
  });

  test("an id iNat will not return is reported, never cached as a guess", async () => {
    // Places get merged and deleted upstream while an observation keeps
    // naming the old id. Caching a placeholder would make observation_place
    // answer confidently about a place that is gone.
    await stageLoad({ id: 1, place_ids: [10, 999999] });
    const result = await fetchPlaces(conn, {
      requestDelayMs: 0,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ results: [{ id: 10, ...PLACES[10] }] }),
      })) as unknown as typeof fetch,
    });
    expect(result.unresolved).toEqual([999999]);
    expect(await count("SELECT count(*) FROM inat_place WHERE inat_place_id = 999999")).toBe(0);
  });

  test("a malformed page fails loudly rather than caching nothing quietly", async () => {
    await stageLoad({ id: 1, place_ids: [10] });
    await expect(
      fetchPlaces(conn, {
        requestDelayMs: 0,
        fetchImpl: (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/no results array/);
  });

  test("re-fetching an id already cached updates it rather than failing", async () => {
    await seedPlaces([10]);
    await conn.run("UPDATE inat_place SET name = 'stale' WHERE inat_place_id = 10");
    await stageLoad({ id: 1, place_ids: [10] });
    // The view says nothing is missing, so nothing is asked for…
    expect(await count("SELECT count(*) FROM inat_place_uncached")).toBe(0);
    // …but the writer is still an upsert, which is what makes a future
    // refresh pass possible without a delete step.
    await conn.run(
      `INSERT INTO inat_place (inat_place_id, name, admin_level) VALUES (10, 'Oregon', 10)
       ON CONFLICT (inat_place_id) DO UPDATE SET name = excluded.name`,
    );
    expect(await rows(conn, "SELECT name FROM inat_place WHERE inat_place_id = 10")).toEqual([["Oregon"]]);
  });
});

describe("the two observation fields nothing was reading", () => {
  const withOfvs = (id: number, ofvs: Array<{ name: string; value: string }>) => ({
    id,
    observed_on: "2018-05-12",
    user: { id: 100, login: "adacollects" },
    ofvs,
  });

  test("the 2018 'sample id' field is read as a sample number", async () => {
    await stageLoad(withOfvs(1, [{ name: "sample id", value: "17" }]));
    await refreshObservationFields(conn);
    expect(await rows(conn, "SELECT sample_number_raw FROM observation_field")).toEqual([["17"]]);
  });

  test("'sampleId' wins where an observation carries both, and the conflict is named", async () => {
    // 31 observations in the corpus carry both fields and 14 disagree, which
    // is too many to prefer one silently.
    await stageLoad(withOfvs(1, [
      { name: "sampleId", value: "5" },
      { name: "sample id", value: "17" },
    ]));
    await refreshObservationFields(conn);
    expect(await rows(conn, "SELECT sample_number_raw FROM observation_field")).toEqual([["5"]]);
    expect(await rows(conn, `SELECT sample_id_value, sample_id_2018_value
                             FROM observation_sample_number_conflict`)).toEqual([["5", "17"]]);
  });

  test("agreeing values are not a conflict", async () => {
    await stageLoad(withOfvs(1, [
      { name: "sampleId", value: "5" },
      { name: "sample id", value: "5" },
    ]));
    expect(await count("SELECT count(*) FROM observation_sample_number_conflict")).toBe(0);
  });

  test("a blank sampleId does not swallow a real 2018 value", async () => {
    // coalesce falls through on NULL only, so a present-but-empty 'sampleId'
    // would win, project as '', and take the 2018 value with it — silently,
    // since the conflict view drops blanks too. 119 observations in the
    // corpus carry a blank 'sampleId'; 2 have a real 'sample id' under it.
    await stageLoad(withOfvs(1, [
      { name: "sampleId", value: "   " },
      { name: "sample id", value: "17" },
    ]));
    await refreshObservationFields(conn);
    expect(await rows(conn, "SELECT sample_number_raw FROM observation_field")).toEqual([["17"]]);
  });

  test("a blank in both leaves no sample number rather than an empty string", async () => {
    await stageLoad(withOfvs(1, [{ name: "sampleId", value: "" }]));
    await refreshObservationFields(conn);
    expect(await rows(conn, "SELECT sample_number_raw FROM observation_field")).toEqual([[null]]);
  });

  test("a non-blank number is stored verbatim, untrimmed", async () => {
    // The guard belongs in the WHERE, not around the value: the column is
    // documented verbatim, and trimming here would quietly rewrite what the
    // volunteer typed.
    await stageLoad(withOfvs(1, [{ name: "sampleId", value: " 17 " }]));
    await refreshObservationFields(conn);
    expect(await rows(conn, "SELECT sample_number_raw FROM observation_field")).toEqual([[" 17 "]]);
  });

  test("the same guard is on the count arms", async () => {
    await stageLoad(withOfvs(1, [
      { name: "numberOfSpecimens", value: "" },
      { name: "Number of bees collected", value: "4" },
    ]));
    await refreshObservationFields(conn);
    expect(await rows(conn, "SELECT specimen_count_raw FROM observation_field")).toEqual([["4"]]);
  });

  test("collection method is read verbatim", async () => {
    await stageLoad(withOfvs(1, [{ name: "OBA Collection Method", value: "vane trap" }]));
    await refreshObservationFields(conn);
    expect(await rows(conn, "SELECT collection_method_raw FROM observation_field")).toEqual([["vane trap"]]);
  });

  test("the new column keeps the stored projection in step with the view", async () => {
    // The positional-insert hazard: observation_field is filled with
    // INSERT ... SELECT * and observation_field_stale compares with EXCEPT,
    // so a column in the wrong position swaps silently with its neighbour.
    await stageLoad(withOfvs(1, [
      { name: "sampleId", value: "5" },
      { name: "numberOfSpecimens", value: "2" },
      { name: "OBA Collection Method", value: "net" },
    ]));
    await refreshObservationFields(conn);
    expect(await count("SELECT count(*) FROM observation_field_stale")).toBe(0);
    expect(await rows(conn, `SELECT sample_number_raw, specimen_count_raw, collection_method_raw
                             FROM observation_field`)).toEqual([["5", "2", "net"]]);
  });
});
