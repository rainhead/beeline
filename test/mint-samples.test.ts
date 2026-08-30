import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { canonicalJson } from "../src/sync-inat.js";
import { promoteObservations } from "../src/promote-observations.js";
import { refreshObservationFields } from "../src/refresh-observation-fields.js";

/**
 * Minting samples from observations (beeline-oyq).
 *
 * Until this existed, observation promotion could only upgrade records the
 * legacy dump had already supplied. At cutover the legacy import freezes and
 * iNaturalist becomes the only entry point, so this is the path every future
 * season arrives by.
 *
 * The place ids and admin levels are the real ones (Oregon 10, Benton County
 * 484, United States 1), for the reason test/observation-place.test.ts gives:
 * the claim under test is what admin_level means, and invented levels would
 * only test themselves. The place_guess strings are lifted from the dev
 * corpus rather than written here, because the locality rule is a pile of
 * assumptions about strings nobody in this repo typed.
 */

let conn: DuckDBConnection;
let ada: number;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
  [[ada]] = (await rows(conn, "SELECT min(entity_id) FROM person")) as [[number]];
  await conn.run(
    `INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${ada}, 100, 'adacollects')`,
  );
  for (const [id, name, level] of [
    [1, "United States", 0],
    [10, "Oregon", 10],
    [484, "Benton", 20],
  ] as const) {
    await conn.run(
      `INSERT INTO inat_place (inat_place_id, name, admin_level) VALUES (${id}, '${name}', ${level})`,
    );
  }
});

/** An observation that is a collection record: number, count, date, observer. */
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
    place_ids: [1, 10, 484],
    place_guess: "Corvallis, OR, US",
    user: { id: 100, login: "adacollects", name: "Ada Collector" },
    taxon: { id: 47604, name: "Rubus", ancestor_ids: [48460, 47126, 211194, 47604] },
    ofvs: [
      { name: "sampleId", value: "7" },
      { name: "numberOfSpecimens", value: "3" },
    ],
    ...extra,
  };
}

/** The ofvs array for a given sample number and count; null omits the field. */
function ofvs(sampleNumber: string | null, count: string | null): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  if (sampleNumber !== null) out.push({ name: "sampleId", value: sampleNumber });
  if (count !== null) out.push({ name: "numberOfSpecimens", value: count });
  return out;
}

async function stage(o: Record<string, unknown>): Promise<void> {
  await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
  await conn.run(
    `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
     VALUES ($1, (SELECT max(entity_id) FROM sync_run), $2, $3)`,
    [Number(o.id), canonicalJson(o), `hash-${o.id}`] as never,
  );
}

const count = async (sql: string) => Number(((await rows(conn, sql))[0] ?? [0])[0]);
const one = async (sql: string) => (await rows(conn, sql))[0];

describe("minting a sample from an observation", () => {
  test("an observation the store has no sample for becomes one, with everything the observation can say", async () => {
    await stage(obs(7));
    const counts = await promoteObservations(conn);
    expect(counts).toMatchObject({ samplesMinted: 1, freeLinks: 0, unresolvedObservers: 0 });

    expect(
      await one(`SELECT kind, collector_id, sample_number, CAST(date_start AS VARCHAR), CAST(date_end AS VARCHAR), specimen_count,
                        inat_observation_id, protocol, country, state_province, county, locality,
                        host_inat_taxon_id, host_name_as_observed
                 FROM sample`),
    ).toEqual([
      "net",
      ada,
      "7",
      "2026-07-14",
      "2026-07-14",
      3,
      7n,
      // Constant, never derived from OBA Collection Method: an iNat-backed
      // sample is an aerial-net sample, and an observation carries one date
      // so it cannot evidence a trap range.
      "aerial net",
      "USA",
      "OR",
      "Benton",
      "Corvallis",
      47604n,
      "Rubus",
    ]);
  });

  test("the observer is the primary collector, so the invariant view stays empty", async () => {
    await stage(obs(7));
    await promoteObservations(conn);
    expect(await one("SELECT person_id, position FROM sample_collector")).toEqual([ada, 1]);
    expect(await count("SELECT count(*) FROM sample_primary_collector_mismatch")).toBe(0);
  });

  test("the location and geoprivacy statements reach a sample minted on the same pass", async () => {
    // The whole reason minting runs before them rather than after: a sample
    // minted at the tail of promotion would wait a full night for its
    // coordinates.
    await stage(obs(7));
    await promoteObservations(conn);
    expect(
      await one("SELECT source, latitude, longitude, coordinate_uncertainty_m FROM sample_location"),
    ).toEqual(["inat_public", 44.5646, -123.262, 30]);
  });

  test("promoting twice mints once", async () => {
    await stage(obs(7));
    expect((await promoteObservations(conn)).samplesMinted).toBe(1);
    expect((await promoteObservations(conn)).samplesMinted).toBe(0);
    expect(await count("SELECT count(*) FROM sample")).toBe(1);
  });

  test("an account harvested on this pass mints on this pass", async () => {
    // The harvest runs first for exactly this: minting resolves an observer
    // through inat_account, so minting first would leave the sample for the
    // next run and "twice mints the same count" would be a property of the
    // fixture rather than of the design.
    await conn.run("INSERT INTO person (display_name) VALUES ('Bo Newcomer')");
    const [[bo]] = (await rows(conn, "SELECT max(entity_id) FROM person")) as [[number]];
    // Bo holds no inat_account; the harvest can only learn one from a sample
    // that already cites an observation of theirs.
    await insertCleanSample(conn, { collector_id: String(bo), inat_observation_id: "8", sample_number: "'1'" });
    await conn.run(`UPDATE sample_collector SET person_id = ${bo} WHERE sample_id = (SELECT max(entity_id) FROM sample)`);
    await stage(obs(8, { user: { id: 200, login: "bonew" }, ofvs: ofvs("1", "3") }));
    await stage(obs(9, { user: { id: 200, login: "bonew" }, observed_on: "2026-07-20", ofvs: ofvs("2", "5") }));

    const counts = await promoteObservations(conn);
    expect(counts.accountsLinked).toBe(1);
    expect(counts.samplesMinted).toBe(1);
    expect(await one("SELECT sample_number, collector_id FROM sample WHERE inat_observation_id = 9")).toEqual(["2", bo]);
  });
});

describe("what is not minted", () => {
  test("an observer the store holds no account for is staged, not minted", async () => {
    await stage(obs(7, { user: { id: 999, login: "stranger" } }));
    const counts = await promoteObservations(conn);
    expect(counts).toMatchObject({ samplesMinted: 0, unresolvedObservers: 1 });
    expect(await count("SELECT count(*) FROM sample")).toBe(0);
    expect(await one("SELECT user_login, sample_number FROM observation_sample_unresolved")).toEqual(["stranger", "7"]);
  });

  test.each([
    ["a count of zero — the project's own signal that nothing was collected", ofvs("7", "0"), "specimen count is zero"],
    ["no count at all", ofvs("7", null), "no specimen count"],
    ["a count that is not a number", ofvs("7", "a few"), "specimen count 'a few' is not a number"],
  ])("%s is unusable, not minted", async (_label, fields, reason) => {
    await stage(obs(7, { ofvs: fields }));
    expect((await promoteObservations(conn)).samplesMinted).toBe(0);
    expect(await one("SELECT reason FROM observation_sample_unusable")).toEqual([reason]);
  });

  test("a negative count says so, rather than arriving with an empty reason", async () => {
    // Six on the dev store. They fall out of the candidate set correctly
    // either way; the bug was that every CASE arm missed them, so the
    // unclaimed screen got a record with nothing said about it.
    await stage(obs(7, { ofvs: ofvs("7", "-1") }));
    expect((await promoteObservations(conn)).samplesMinted).toBe(0);
    expect(await one("SELECT reason FROM observation_sample_unusable")).toEqual([
      "specimen count -1 is negative",
    ]);
  });

  test("no date is unusable", async () => {
    await stage(obs(7, { observed_on: null }));
    expect((await promoteObservations(conn)).samplesMinted).toBe(0);
    expect(await one("SELECT reason FROM observation_sample_unusable")).toEqual(["no observed date"]);
  });

  test("an observation with no sample number is not a collection record at all", async () => {
    await stage(obs(7, { ofvs: ofvs(null, "3") }));
    expect((await promoteObservations(conn)).samplesMinted).toBe(0);
    // Not unusable either: nothing about it claims to be a sample.
    expect(await count("SELECT count(*) FROM observation_sample_unusable")).toBe(0);
  });
});

describe("reconciling against samples the store already holds", () => {
  test("a trap sample's observation is dated on the END of its range, and the link is free", async () => {
    // The finding that made the key a date RANGE rather than date_start. All
    // 20 samples this reaches on the dev store cite no observation, so keying
    // on date_start turned free links into duplicate collecting events —
    // invisible, because qc_rule_duplicate_sample_number also groups on
    // date_start.
    const sampleId = await insertCleanSample(conn, {
      kind: "'trap'",
      sample_number: "'7'",
      date_start: "DATE '2026-07-10'",
      date_end: "DATE '2026-07-14'",
    });
    await stage(obs(7));
    const counts = await promoteObservations(conn);
    expect(counts).toMatchObject({ samplesMinted: 0, freeLinks: 1 });
    expect(await count("SELECT count(*) FROM sample")).toBe(1);
    expect(await one(`SELECT inat_observation_id, kind, CAST(date_start AS VARCHAR), CAST(date_end AS VARCHAR)
                      FROM sample WHERE entity_id = ${sampleId}`))
      .toEqual([7n, "trap", "2026-07-10", "2026-07-14"]);
  });

  test("a free link never rewrites the sample's own number, date or count", async () => {
    const sampleId = await insertCleanSample(conn, {
      kind: "'trap'",
      sample_number: "'7'",
      date_start: "DATE '2026-07-10'",
      date_end: "DATE '2026-07-14'",
      specimen_count: "11",
    });
    await stage(obs(7));
    await promoteObservations(conn);
    expect(await one(`SELECT sample_number, CAST(date_start AS VARCHAR), CAST(date_end AS VARCHAR), specimen_count
                      FROM sample WHERE entity_id = ${sampleId}`))
      .toEqual(["7", "2026-07-10", "2026-07-14", 11]);
  });

  test("a group matching two existing samples is neither linked nor minted", async () => {
    // Three of these on the dev store, all one collector, all trap samples of
    // the same number with overlapping ranges: duplicate collecting events
    // the store already held. Picking one silently would be worse than saying
    // so, and minting a third would manufacture the duplicate.
    const a = await insertCleanSample(conn, {
      kind: "'trap'", sample_number: "'7'", date_start: "DATE '2026-07-13'", date_end: "DATE '2026-07-14'",
    });
    const b = await insertCleanSample(conn, {
      kind: "'trap'", sample_number: "'7'", date_start: "DATE '2026-07-14'", date_end: "DATE '2026-07-16'",
    });
    await stage(obs(7));
    const counts = await promoteObservations(conn);
    expect(counts).toMatchObject({ samplesMinted: 0, freeLinks: 0, ambiguousGroups: 1 });
    expect(await count("SELECT count(*) FROM sample")).toBe(2);
    expect(await count(`SELECT count(*) FROM sample WHERE inat_observation_id IS NOT NULL`)).toBe(0);
    expect(await one("SELECT samples, sample_ids FROM sample_mint_ambiguous")).toEqual([2, `${a} | ${b}`]);
  });

  test("once linked, the link is the identity: an upstream edit to the sample number mints nothing", async () => {
    // The reference implementation's sha256-primary-key bug, avoided: a
    // volunteer correcting a sampleId upstream must not produce a second
    // collecting event.
    await stage(obs(7));
    await promoteObservations(conn);
    await stage(obs(7, { ofvs: ofvs("8", "3") }));
    expect((await promoteObservations(conn)).samplesMinted).toBe(0);
    expect(await count("SELECT count(*) FROM sample")).toBe(1);
    // And the disagreement is named rather than silent.
    expect(await one("SELECT sample_number, observation_sample_number FROM sample_observation_number_mismatch"))
      .toEqual(["7", "8"]);
  });

  test("a trap sample matched on two of its days links once, to the lowest observation id", async () => {
    // sample_mint_group groups by observed_on, so a sample spanning several
    // days matches one group per day its observations fall on — a trap set on
    // one day and collected on another. Two on the dev store. Both belong to
    // the sample and inat_observation_id holds one, and `UPDATE ... FROM` with
    // several source rows for one target picks an arbitrary one, so without a
    // tie-break the sample's coordinates would be decided by whatever the join
    // emitted and could differ on a re-promotion.
    const sampleId = await insertCleanSample(conn, {
      kind: "'trap'",
      sample_number: "'7'",
      date_start: "DATE '2026-07-10'",
      date_end: "DATE '2026-07-14'",
    });
    await stage(obs(30587701, { observed_on: "2026-07-14" }));
    await stage(obs(30494816, { observed_on: "2026-07-10" }));

    // One row, not two — the count is samples linked, not matches found.
    // (Refreshed by hand because the view reads the stored projection, which
    // promotion is otherwise the first thing to fill.)
    await refreshObservationFields(conn);
    expect(await count("SELECT count(*) FROM sample_mint_match")).toBe(2);
    expect(await count("SELECT count(*) FROM sample_mint_free_link")).toBe(1);
    const counts = await promoteObservations(conn);
    expect(counts).toMatchObject({ samplesMinted: 0, freeLinks: 1 });
    expect(await count("SELECT count(*) FROM sample")).toBe(1);
    expect(await one(`SELECT inat_observation_id FROM sample WHERE entity_id = ${sampleId}`))
      .toEqual([30494816n]);
    // The day it did not take is not lost, and not minted into a second
    // sample either: it is the same collecting event, and this is what says so.
    expect(await one("SELECT sample_id, cited_inat_id, other_observations FROM sample_multi_observation"))
      .toEqual([sampleId, 30494816n, 1]);
    // And a second pass changes nothing, rather than swapping the citation.
    expect((await promoteObservations(conn)).freeLinks).toBe(0);
    expect(await one(`SELECT inat_observation_id FROM sample WHERE entity_id = ${sampleId}`))
      .toEqual([30494816n]);
  });

  test("several observations of one collecting event make one sample, counting them all", async () => {
    await stage(obs(12, { ofvs: ofvs("7", "3") }));
    await stage(obs(9, { ofvs: ofvs("7", "5") }));
    expect((await promoteObservations(conn)).samplesMinted).toBe(1);
    // It cites the lowest id — arbitrary but stable, as legacy_sample_map's
    // arg_min is — and its count is the total.
    const [sampleId] = (await one("SELECT entity_id, inat_observation_id, specimen_count FROM sample")) as [number];
    expect(await one("SELECT inat_observation_id, specimen_count FROM sample")).toEqual([9n, 8]);
    // A scalar link cannot say the rest, so qc_rule_count_mismatch compares 8
    // against the cited observation's 5 and reports a disagreement in which
    // both sides are right. This is the view that explains it.
    expect(await one("SELECT rule_name, details FROM qc_finding WHERE rule_name = 'count_mismatch'"))
      .toEqual(["count_mismatch", "observation says 5 but sample count is 8"]);
    expect(await one("SELECT sample_id, cited_inat_id, other_observations FROM sample_multi_observation"))
      .toEqual([sampleId, 9n, 1]);
  });
});

describe("descriptive fields are a fill-only refresh", () => {
  test("a gap is filled from the observation", async () => {
    // Why fill rather than write-once: inat_place is network-fetched, so a
    // reseeded store promotes before pnpm inat:fetch-places has run and mints
    // samples with no geography that no later fetch could repair.
    const sampleId = await insertCleanSample(conn, {
      inat_observation_id: "7", sample_number: "'7'", locality: "NULL", county: "NULL",
    });
    await stage(obs(7));
    await promoteObservations(conn);
    expect(await one(`SELECT locality, county FROM sample WHERE entity_id = ${sampleId}`)).toEqual([
      "Corvallis",
      "Benton",
    ]);
  });

  test("a value the store already holds is never overwritten", async () => {
    // Verified on the real corpus too: across 66,293 existing samples the
    // refresh changed 26 localities and 2 counties, all of them from NULL,
    // and overwrote nothing on any field.
    const sampleId = await insertCleanSample(conn, {
      inat_observation_id: "7", sample_number: "'7'", locality: "'Bald Hill'", county: "'Linn'",
    });
    await stage(obs(7));
    await promoteObservations(conn);
    expect(await one(`SELECT locality, county FROM sample WHERE entity_id = ${sampleId}`)).toEqual([
      "Bald Hill",
      "Linn",
    ]);
  });

  test("an atlas a human assigned is not moved by the lookup", async () => {
    const sampleId = await insertCleanSample(conn, {
      inat_observation_id: "7", sample_number: "'7'", atlas_id: "NULL",
      atlas_assigned_by: `(SELECT min(entity_id) FROM person)`,
    });
    await stage(obs(7));
    await promoteObservations(conn);
    expect(await one(`SELECT atlas_id FROM sample WHERE entity_id = ${sampleId}`)).toEqual([null]);
  });
});

describe("the locality a minted sample carries", () => {
  /** Every guess here is a real place_guess from the dev corpus. */
  test.each([
    ["Corvallis, OR, US", "Corvallis"],
    // Not three parts, which the reference rule refuses outright.
    ["Steigerwald NWR", "Steigerwald NWR"],
    // Four parts whose SECOND component is the town.
    ["Peckham Rd, Wilder, ID, US", "Wilder"],
    ["USA, OR, SilverLake, NF road 2916", "SilverLake"],
    // A street number carries no listed suffix and fits in 18 characters.
    ["3334 NW Covey Run, Corvallis, OR 97330, USA", "Corvallis"],
    // Coarse: the volunteer's to fix upstream on iNaturalist, which is SOP.
    ["Oregon, US", null],
    ["Wheeler County, US-OR, US", null],
    ["United States", null],
    // Longer than qc_rule_locality_format allows, so writing it would only
    // manufacture a finding on the same promotion run.
    ["Leach Botanical Garden", null],
  ])("%s -> %s", async (guess, expected) => {
    await stage(obs(7, { place_guess: guess, place_ids: [1, 10, 484] }));
    await promoteObservations(conn);
    expect(await one("SELECT locality FROM sample")).toEqual([expected]);
  });

  test("minting never manufactures a locality_format finding", async () => {
    // True on the corpus as well: the store's 4,100 locality_format findings
    // are unchanged by minting 1,421 samples.
    for (const [i, guess] of [
      "Corvallis, OR, US",
      "Steigerwald NWR",
      "Peckham Rd, Wilder, ID, US",
      "3334 NW Covey Run, Corvallis, OR 97330, USA",
      "Leach Botanical Garden",
      "Oregon, US",
    ].entries()) {
      await stage(obs(100 + i, { place_guess: guess, ofvs: ofvs(String(100 + i), "1") }));
    }
    await promoteObservations(conn);
    expect(await count("SELECT count(*) FROM qc_finding WHERE rule_name = 'locality_format'")).toBe(0);
  });

  test("the private place guess wins, as the private coordinates and place ids do", async () => {
    await stage(obs(7, { place_guess: "Corvallis, OR, US", private_place_guess: "Bald Hill, OR, US" }));
    await promoteObservations(conn);
    expect(await one("SELECT locality FROM sample")).toEqual(["Bald Hill"]);
  });

  test("the street-suffix predicate has one home, and both readers use it", async () => {
    // qc_rule_locality_format judges a locality a sample carries;
    // observation_locality picks one that does not exist yet. beeline-4dt
    // landed in the one place and reached both: 'st' is Saint here, so the
    // component is a place name and the sample gets a locality it used to be
    // refused — and qc_rule_locality_format agrees, which is the half that
    // used to disagree.
    const [[pattern]] = (await rows(conn, "SELECT locality_street_suffix_pattern()")) as [[string]];
    expect(pattern).toContain("boulevard");
    await stage(obs(7, { place_guess: "St Helens, OR, US", ofvs: ofvs("7", "1") }));
    await promoteObservations(conn);
    expect(await one("SELECT locality FROM sample")).toEqual(["St Helens"]);
    expect(await count("SELECT count(*) FROM qc_finding WHERE rule_name = 'locality_format'")).toBe(0);
  });

  // The county is its own label field, so a locality restating it prints
  // nothing — and since the rule takes the FIRST usable component, and these
  // guesses put the county first, it beat the town sitting right behind it.
  // Only the long spelling was ever refused, and only by the accident of
  // `lane` and `county` being street suffixes; beeline-4dt's anchor takes
  // the accident away, so the administrative clause states it (beeline-bev).
  test.each([
    ["Benton Co., Bald Hill, OR, US", "Bald Hill"],
    ["Benton Co, Bald Hill, OR, US", "Bald Hill"],
    ["Benton County, Bald Hill, OR, US", "Bald Hill"],
    // A bare county and nothing else is a guess too coarse to use, which is
    // the volunteer's to fix upstream on iNaturalist.
    ["Benton Co., OR, US", null],
    // But NEVER the bare name: a county is routinely named after its own
    // seat and iNaturalist writes plain 'City, State, Country', so this is
    // the city of Benton and not Benton County. Matching bare would take
    // the locality off 1,304 observations in the corpus — Hood River,
    // Yakima, Nanaimo, Walla Walla, Spokane — to catch the ~200 that are
    // genuinely coarse. The state clause beside it can afford an exact
    // match because a state's name is not a town in that same state.
    ["Benton, OR, US", "Benton"],
  ])("the observation's own county is not a locality: %s -> %s", async (guess, expected) => {
    await stage(obs(7, { place_guess: guess }));
    await promoteObservations(conn);
    expect(await one("SELECT locality FROM sample")).toEqual([expected]);
  });
});
