import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMA_DIR } from "../src/schema.js";
import { createMemoryDb, insertCleanSample, CURRENT_SEASON, rows, SETTLED_SEASON } from "./helpers.js";

let conn: DuckDBConnection;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  // First entity in a fresh database: the collector always gets id 1,
  // which insertCleanSample hardcodes.
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
});

async function findings(sampleId: number): Promise<Array<{ rule: unknown; details: unknown }>> {
  const r = await rows(
    conn,
    `SELECT rule_name, details FROM qc_finding WHERE sample_id = ${sampleId} ORDER BY rule_name`,
  );
  return r.map(([rule, details]) => ({ rule, details }));
}

async function isPrintable(sampleId: number): Promise<boolean> {
  const r = await rows(conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${sampleId}`);
  return r.length === 1;
}

describe("QC findings and printability", () => {
  test("a clean sample has no findings and is printable", async () => {
    const id = await insertCleanSample(conn);
    expect(await findings(id)).toEqual([]);
    expect(await isPrintable(id)).toBe(true);
  });

  test("missing label fields are one finding naming each gap", async () => {
    const id = await insertCleanSample(conn, { locality: "NULL", protocol: "NULL" });
    expect(await findings(id)).toEqual([
      { rule: "missing_required_field", details: "locality, protocol" },
    ]);
    expect(await isPrintable(id)).toBe(false);
  });

  test("an unobscured sample without a location row is missing its location", async () => {
    const id = await insertCleanSample(conn, {}, null);
    expect(await findings(id)).toEqual([
      { rule: "missing_required_field", details: "location" },
    ]);
    expect(await isPrintable(id)).toBe(false);
  });

  test("a missing county is flagged but does not block printing", async () => {
    const id = await insertCleanSample(conn, { county: "NULL" });
    expect(await findings(id)).toEqual([
      { rule: "missing_recommended_field", details: "county" },
    ]);
    expect(await isPrintable(id)).toBe(true);
  });

  // Collecting outside the six atlases is ordinary and unflagged; a place the
  // lookup cannot find, or a country that contradicts it, is not (beeline-lcl).
  test("collecting outside every member atlas is not a finding", async () => {
    const id = await insertCleanSample(conn, { state_province: "'NV'" });
    expect(await findings(id)).toEqual([]);
    expect(await isPrintable(id)).toBe(true);
  });

  test("a place the region lookup cannot find is flagged", async () => {
    const id = await insertCleanSample(conn, { country: "'NZL'", state_province: "'Waikato'" });
    expect(await findings(id)).toEqual([
      { rule: "place_unabbreviated", details: "state_province 'Waikato'" },
      { rule: "place_unrecognised", details: "state_province 'Waikato' is not a US state or Canadian province" },
    ]);
    // Blocked by the abbreviation rule, not by this one — being somewhere the
    // model does not know is a thing to look at, not a thing to stop.
    expect(await isPrintable(id)).toBe(false);
  });

  test("a country that contradicts its own state is flagged by name", async () => {
    // Bonnie Zand's two: Kane County, Utah, with a BC collector's usual CAN
    // in the country field — which the old six-way CASE filed as "outside".
    const id = await insertCleanSample(conn, { country: "'CAN'", state_province: "'UT'" });
    expect(await findings(id)).toEqual([
      { rule: "place_unrecognised", details: "country 'CAN' disagrees: UT is in USA" },
    ]);
    expect(await isPrintable(id)).toBe(true);
  });

  test("locality format problems are named individually", async () => {
    const id = await insertCleanSample(conn, { locality: "'5th St, Corvallis Oregon'" });
    const [f] = await findings(id);
    expect(f?.rule).toBe("locality_format");
    expect(f?.details).toContain("longer than 18 chars");
    expect(f?.details).toContain("contains comma");
    expect(f?.details).not.toContain("street");
  });

  // Andony no longer remembers why the old system forbade a street address,
  // and a volunteer who writes one has made their choice (Peter, 2026-10-31).
  // Strings lifted from production staging, short and clean enough to raise
  // nothing else.
  test("a street address the volunteer wrote is not a fault", async () => {
    const streets = ["Alice Street", "Eugene Olive St", "Thunderbird Ct", "BLM Rd 39-6-36"];
    for (const [i, locality] of streets.entries()) {
      const id = await insertCleanSample(conn, { locality: `'${locality}'`, sample_number: `'s${i}'` });
      expect(await findings(id), locality).toEqual([]);
    }
  });

  // The county prints in its own place on the label, so a locality that is
  // only a county says nothing; the street suffixes used to catch it, and it
  // is still caught. A county park is a place.
  test("a locality that is only a county is still flagged", async () => {
    const id = await insertCleanSample(conn, { locality: "'Jefferson County'" });
    expect(await findings(id)).toEqual([{ rule: "locality_format", details: "names only a county" }]);
    const stop = await insertCleanSample(conn, { locality: "'Benton County.'", sample_number: "'c1'" });
    expect(await findings(stop)).toEqual([{ rule: "locality_format", details: "names only a county" }]);
    const park = await insertCleanSample(conn, { locality: "'Buell County Park'", sample_number: "'p1'" });
    expect(await findings(park)).toEqual([]);
  });

  // Minting still skips a street component of an observation's place guess
  // (observation_locality, schema/108), by one regular expression rather
  // than nineteen LIKE passes (beeline-2c3.37). The thing worth pinning is
  // that every token still has to stand alone between spaces, an
  // alternation being exactly where that quietly stops being true. Strings
  // lifted from production staging, one per token, because a rule tested
  // only on strings we wrote is a rule tested on our assumptions.
  const isStreet = async (s: string) =>
    ((await rows(
      conn,
      `SELECT regexp_matches(concat(' ', replace(replace(lower('${s.replaceAll("'", "''")}'), '.', ' '), ',', ' , '), ' '),
                             locality_street_suffix_pattern())`,
    )) as [[boolean]])[0]![0];

  test("every street suffix is still matched as a whole word", async () => {
    const streets = [
      "Sisters, Road 1018",
      "Bend Twin Bridges Rd",
      "Alice Street",
      "Eugene Olive St",
      "Corvallis SW Orchard Ave",
      "Rdmnd Flcn Cr Drive",
      "McMinnville NE Elaine Dr",
      "Corvallis NE Circle Blvd",
      "Thunderbird Ct",
      "Williams Bonlinda Lane",
      "Corvallis NE Smith Ln",
      "Jefferson County",
    ];
    for (const s of streets) expect(await isStreet(s), s).toBe(true);
  });

  // beeline-4dt: `st` is Saint and the abbreviation for State as well as
  // Street, so a suffix has to end its phrase, or minting would skip St
  // Helens's own name in its place guess. All real localities.
  test("a suffix that does not end its phrase is part of a place name", async () => {
    const places = [
      "St Helens", // the town in Columbia County, 121 samples
      "St. Helens",
      "St.Helens",
      "W. St. Helens",
      "St. Johns",
      "Mosier St Park", // State, not Street
      "Smith Rock St Prk",
      "Lane Creek",
      "Buell County Park",
    ];
    for (const s of places) expect(await isStreet(s), s).toBe(false);
  });

  // What "ends its phrase" allows either side of the anchor: a comma ends a
  // phrase the way the end of the string does, and a directional or a road
  // number after the suffix is still part of the address.
  test("a comma ends a phrase, and a directional or road number does not", async () => {
    for (const s of ["NW Harrison Blvd, Corvallis", "Salem, Vista Ave SE", "BLM Rd 39-6-36"]) {
      expect(await isStreet(s), s).toBe(true);
    }
  });

  // DuckDB compiles a regex once when the pattern is a literal and once PER
  // ROW when it is anything else, so the predicate is a macro (which the
  // binder expands into a literal) and not the one-row view a shared
  // constant would otherwise be. Reading it out of a view cost 1.1 s over
  // the dev store's 67,304 localities against 18 ms. A timing assertion
  // would be flaky, so what is pinned is the spelling that makes it fast
  // (ADR 0001, beeline-5bm).
  test("minting reaches the predicate through the macro, not a subquery", async () => {
    const [[sql]] = (await rows(conn, `SELECT sql FROM duckdb_views() WHERE view_name = 'observation_locality'`)) as [[string]];
    expect(sql).toContain("locality_street_suffix_pattern()");
    expect(sql).not.toContain("FROM locality_street_suffix_pattern");
  });

  test("parts from the reference implementation only where a suffix does not end its phrase", async () => {
    // The reference's own predicate, kept in the repository so the rule has
    // something to disagree with — first because an alternation is exactly
    // where "each token stands alone between spaces" quietly stops holding,
    // and now because beeline-4dt makes the disagreement itself the point.
    // Every string below is a real locality from production staging; the
    // expected set is the whole of what changed, so a later edit that widens
    // or narrows the divergence has to say so here.
    const corpus = [
      "Sparta Road Vista", "Bend Twin Bridges Rd", "Alice Street", "Mosier St Park",
      "St Helens", "Corvallis SW Orchard Ave", "Rdmnd Flcn Cr Drive", "McMinnville NE Elaine Dr",
      "Corvallis NE Circle Blvd", "Thunderbird Ct", "Williams Bonlinda Lane",
      "Corvallis NE Smith Ln", "Jefferson County", "County Hwy 5-13B", "Lane County",
      "Drain", "Avery Park", "Strawberry Mountain", "Moses Lake", "Canyon City",
      "Sims Corner", "Chinook Pass", "Groundhog Mountain", "Olympic NP", "Painted Hills",
      "Klamath Falls Ashley Ct.", "Steens Mt. Loop Rd.", "Deschutes Rvr. St. Rec.",
      "Cottonwood Canyon St Prk", "Mike Miller County Park", "Lane Creek", "St. Johns",
      "Luckiamute St Natural Area", "NW Harrison Blvd, Corvallis", "Sisters, Road 1018",
      "Eugene Olive St", "Salem, Vista Ave SE",
    ];
    const values = corpus.map((l) => `('${l.replaceAll("'", "''")}')`).join(", ");
    await conn.run(`CREATE TEMP TABLE corpus(locality TEXT)`);
    await conn.run(`INSERT INTO corpus VALUES ${values}`);
    // The reference reads a locality with commas and periods flattened to
    // spaces; ours keeps the comma as a token, which is where the anchor is.
    const referenceNorm = "concat(' ', replace(replace(lower(locality), ',', ' '), '.', ' '), ' ')";
    const ourNorm = "concat(' ', replace(replace(lower(locality), '.', ' '), ',', ' , '), ' ')";
    const disagreements = await rows(
      conn,
      `SELECT locality FROM (SELECT locality, ${referenceNorm} AS r, ${ourNorm} AS n FROM corpus)
       WHERE (r LIKE '% road %' OR r LIKE '% rd %'
              OR r LIKE '% street %' OR r LIKE '% str %' OR r LIKE '% st %'
              OR r LIKE '% avenue %' OR r LIKE '% ave %' OR r LIKE '% av %'
              OR r LIKE '% drive %' OR r LIKE '% dr %'
              OR r LIKE '% boulevard %' OR r LIKE '% blvd %'
              OR r LIKE '% court %' OR r LIKE '% ct %'
              OR r LIKE '% lane %' OR r LIKE '% ln %'
              OR r LIKE '% county %')
         <> regexp_matches(n, locality_street_suffix_pattern())
       ORDER BY locality`,
    );
    // Eight of the ten are the inherited false positive — Saint, State, and
    // the two words that are also place names. The other two are backcountry
    // road references with the number in the middle, which is the measured
    // cost of the anchor (schema/108_views_minting.sql).
    expect(disagreements.map(([l]) => l)).toEqual([
      "Cottonwood Canyon St Prk",
      "County Hwy 5-13B",
      "Deschutes Rvr. St. Rec.",
      "Lane Creek",
      "Luckiamute St Natural Area",
      "Mike Miller County Park",
      "Mosier St Park",
      "Sparta Road Vista",
      "St Helens",
      "St. Johns",
    ]);
  });

  test("a suffix buried inside a word is not a street", async () => {
    // The boundaries come from padding the locality with spaces, not from a
    // lookbehind — so 'Drain' must not read as 'dr' and 'Avery' not as 'av'.
    // All real localities; all short and clean enough to raise nothing else.
    const places = ["Drain", "Avery Park", "Moses Lake", "Canyon City", "Sims Corner", "Chinook Pass"];
    for (const [i, locality] of places.entries()) {
      const id = await insertCleanSample(conn, {
        locality: `'${locality}'`,
        sample_number: `'p${i}'`,
      });
      expect(await findings(id), locality).toEqual([]);
    }
  });

  test("coordinate uncertainty over the limit blocks printing", async () => {
    // Collected before the rule changed, so this is held to the grandfathered
    // 250 m and the flag says so. The date is written out because the
    // fixture's own date is 14 July of the current season, which falls before
    // the change in 2026 and after it from 2027 on.
    const before = "DATE '2026-07-14'";
    const id = await insertCleanSample(
      conn,
      { date_start: before, date_end: before },
      { coordinate_uncertainty_m: "500" },
    );
    expect(await findings(id)).toEqual([
      { rule: "coordinate_uncertainty", details: "500 m > 250 m" },
    ]);
    expect(await isPrintable(id)).toBe(false);
  });

  // 100 m is the rule and always was — three decimal places of latitude, which
  // is what a GPS reports (#22). It could not be applied backwards: for older
  // records the specimens have often left the collector's hands, so the pin
  // can no longer be corrected and a flag would demand the impossible. So the
  // limit is a function of when the sample was collected, and both halves of
  // that need holding down.
  describe("the coordinate limit depends on when the sample was collected", () => {
    const dayBefore = "DATE '2026-09-01'";
    const dayOf = "DATE '2026-09-02'"; // coordinate_precision_rule.effective_from

    test("160 m is fine on a record collected before the change", async () => {
      const id = await insertCleanSample(
        conn,
        { date_start: dayBefore, date_end: dayBefore },
        { coordinate_uncertainty_m: "160" },
      );
      expect(await findings(id)).toEqual([]);
      expect(await isPrintable(id)).toBe(true);
    });

    test("the same 160 m blocks a record collected on the day it changed", async () => {
      const id = await insertCleanSample(
        conn,
        { date_start: dayOf, date_end: dayOf },
        { coordinate_uncertainty_m: "160" },
      );
      expect(await findings(id)).toEqual([
        { rule: "coordinate_uncertainty", details: "160 m > 100 m" },
      ]);
      expect(await isPrintable(id)).toBe(false);
    });

    test("90 m is fine under either limit", async () => {
      for (const day of [dayBefore, dayOf]) {
        const id = await insertCleanSample(
          conn,
          { date_start: day, date_end: day },
          { coordinate_uncertainty_m: "90" },
        );
        expect(await findings(id), day).toEqual([]);
      }
    });

    // Judged on date_end (schema/120): a trap line that ran across the
    // boundary is held to the limit in force when it was emptied.
    test("a trap line spanning the change is judged by when it was emptied", async () => {
      const id = await insertCleanSample(
        conn,
        { kind: "'trap'", date_start: dayBefore, date_end: dayOf },
        { coordinate_uncertainty_m: "160" },
      );
      expect(await findings(id)).toEqual([
        { rule: "coordinate_uncertainty", details: "160 m > 100 m" },
      ]);
    });
  });

  test("a coordinate outside North America blocks, on a record that claims to be in it", async () => {
    // The shape this rule exists for: the pin moved after the place_guess was
    // written, so every text field still says Oregon (real case, sample 122269
    // — Corvallis, at a point 2,000 km west of Peru).
    const pacific = await insertCleanSample(
      conn,
      {},
      { latitude: "-7.079786", longitude: "-121.581916", elevation_m: "NULL" },
    );
    expect(await findings(pacific)).toEqual([
      {
        rule: "coordinate_out_of_region",
        details: "-7.0798, -121.5819 is not in North America, but this record says USA",
      },
    ]);
    expect(await isPrintable(pacific)).toBe(false);

    // A longitude that lost its minus sign: Warm Springs, Oregon read as
    // central Asia. As precise as any other pin, so coordinate_uncertainty
    // never sees it — and this record carries no country at all.
    const flipped = await insertCleanSample(
      conn,
      { sample_number: "'2'", country: "NULL" },
      { latitude: "44.68", longitude: "121.15", elevation_m: "NULL" },
    );
    expect(await findings(flipped)).toContainEqual({
      rule: "coordinate_out_of_region",
      details: "44.68, 121.15 is not in North America, but this record says no country at all",
    });
  });

  test("a record that says it was collected abroad, and was, is not a finding", async () => {
    // The fifth row outside the box on the dev store, and the reason for the
    // country clause: there is no way to satisfy a flag on an honest record,
    // and a finding has no accepted state (beeline-4dt).
    const nz = await insertCleanSample(
      conn,
      { sample_number: "'3'", country: "'NZL'", state_province: "NULL", county: "NULL" },
      { latitude: "-38.39", longitude: "176.02", elevation_m: "NULL" },
    );
    expect((await findings(nz)).map((f) => f.rule)).not.toContain("coordinate_out_of_region");

    // And the box is generous on purpose: collecting in Baja or the Yukon is
    // not a defect.
    for (const [n, lat, lon] of [
      ["4", "23.05", "-109.7"], // Cabo San Lucas
      ["5", "64.06", "-139.43"], // Dawson City
    ] as const) {
      const away = await insertCleanSample(
        conn,
        { sample_number: `'${n}'` },
        { latitude: lat, longitude: lon, elevation_m: "NULL" },
      );
      expect((await findings(away)).map((f) => f.rule)).not.toContain("coordinate_out_of_region");
    }
  });

  test("user- and taxon-driven obscuring both block until true coordinates arrive", async () => {
    // Obscured without trust: the shifted pair never enters the sample layer,
    // so there is no location row — and the obscured rule alone fires, not
    // missing_required_field.
    const a = await insertCleanSample(conn, { geoprivacy: "'obscured'" }, null);
    const b = await insertCleanSample(conn, { sample_number: "'2'", taxon_geoprivacy: "'obscured'" }, null);
    expect(await findings(a)).toEqual([
      { rule: "obscured_no_true_coordinates", details: "geoprivacy=obscured" },
    ]);
    expect(await findings(b)).toEqual([
      { rule: "obscured_no_true_coordinates", details: "taxon_geoprivacy=obscured" },
    ]);
    await conn.run(
      `INSERT INTO sample_location (sample_id, latitude, longitude, source) VALUES (${a}, 44.5646, -123.2620, 'inat_trusted')`,
    );
    expect(await findings(a)).toEqual([]);
    expect(await isPrintable(a)).toBe(true);
    expect(await isPrintable(b)).toBe(false);
  });

  test("a taxon-obscured sample prints only where its atlas has said labels may carry the true point", async () => {
    // Arthur, 2026-10-21 (gh-13): Oregon's labels may; every other atlas's
    // samples wait until it answers, and so does a sample outside every atlas.
    const atlas = (code: string) => `(SELECT entity_id FROM program WHERE code = '${code}')`;
    const oregon = await insertCleanSample(conn, { taxon_geoprivacy: "'obscured'", atlas_id: atlas("OBA") });
    const washington = await insertCleanSample(conn, {
      sample_number: "'2'", state_province: "'WA'", taxon_geoprivacy: "'obscured'", atlas_id: atlas("WaBA"),
    });
    const outside = await insertCleanSample(conn, { sample_number: "'3'", state_province: "'NV'", taxon_geoprivacy: "'obscured'" });
    // The collector's own geoprivacy is not the atlas's question.
    const chosen = await insertCleanSample(conn, { sample_number: "'4'", geoprivacy: "'obscured'", atlas_id: atlas("WaBA") });
    expect(await findings(oregon)).toEqual([]);
    expect(await isPrintable(oregon)).toBe(true);
    expect(await findings(washington)).toEqual([
      { rule: "taxon_obscured_awaiting_atlas", details: "taxon_geoprivacy=obscured, atlas=WaBA" },
    ]);
    expect(await isPrintable(washington)).toBe(false);
    expect(await findings(outside)).toEqual([
      { rule: "taxon_obscured_awaiting_atlas", details: "taxon_geoprivacy=obscured, atlas=none" },
    ]);
    expect(await findings(chosen)).toEqual([]);

    // Once Washington answers, its sample prints.
    await conn.run(
      `INSERT INTO atlas_taxon_obscured_printing VALUES (${atlas("WaBA")}, 'Test', DATE '2026-10-22', 'https://example.org')`,
    );
    expect(await isPrintable(washington)).toBe(true);
  });

  test("a taxon-obscured sample already printed still waits for its atlas", async () => {
    // The old system printed iNaturalist's stand-in point where it lacked the
    // true one, and promotion has since replaced it (beeline-b34), so a
    // further label could be the first to print the true point.
    const id = await insertCleanSample(conn, { taxon_geoprivacy: "'obscured'", specimen_count: "2" });
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${id}, 1, '26000001')`);
    expect((await findings(id)).map((f) => f.rule)).toEqual(["taxon_obscured_awaiting_atlas"]);
    expect(await isPrintable(id)).toBe(false);
  });

  test("duplicate sample numbers flag every colliding sample", async () => {
    const a = await insertCleanSample(conn);
    const b = await insertCleanSample(conn); // same collector, day, and number '1'
    expect((await findings(a))[0]?.rule).toBe("duplicate_sample_number");
    expect((await findings(b))[0]?.rule).toBe("duplicate_sample_number");
    expect(await isPrintable(a)).toBe(false);
  });

  test("a printed sample whose number its collector used twice is named, and flagged nowhere", async () => {
    // Peter, 2026-10-04 (beeline-0199): the pins carry the number for good and
    // there is nothing left for anyone to do. Both shapes: a legacy sample
    // whose records came from two observations, and two printed samples
    // sharing a collector, number and date.
    const merged = await insertCleanSample(conn);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${merged}, 1, '26000001')`);
    await conn.run(`INSERT INTO sample_legacy_observation VALUES (${merged}, 372516130), (${merged}, 397257272)`);
    const a = await insertCleanSample(conn, { sample_number: "'2'" });
    const b = await insertCleanSample(conn, { sample_number: "'2'" });
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${a}, 1, '26000002'), (${b}, 1, '26000003')`);
    for (const id of [merged, a, b]) expect(await findings(id)).toEqual([]);
    expect(await rows(conn, `SELECT sample_id, details FROM sample_number_conflict ORDER BY sample_id`)).toEqual([
      [merged, "sample number 1 is on 2 observations: 372516130, 397257272"],
      [a, expect.stringContaining("sample number 2 used 2 times")],
      [b, expect.stringContaining("sample number 2 used 2 times")],
    ]);
  });

  test("zero-count samples are not printable even when clean", async () => {
    const id = await insertCleanSample(conn, { specimen_count: "0" });
    expect(await findings(id)).toEqual([]);
    expect(await isPrintable(id)).toBe(false);
  });

  test("a count decrease below printed specimens is a warning, not a block", async () => {
    const id = await insertCleanSample(conn, { specimen_count: "2" });
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${id}, 1), (${id}, 2), (${id}, 3)`);
    expect(await findings(id)).toEqual([
      { rule: "count_below_printed", details: "3 specimens printed but count is 2" },
    ]);
    expect(await isPrintable(id)).toBe(true); // severity 'warning'
  });
});

async function pendingCount(sampleId: number): Promise<number | null> {
  const r = await rows(conn, `SELECT pending_count FROM pending_print_sample WHERE sample_id = ${sampleId}`);
  return r.length === 0 ? null : Number(r[0]![0]);
}

describe("what is waiting on labels", () => {
  test("a clean, never-printed sample is pending for its whole count", async () => {
    const id = await insertCleanSample(conn, { specimen_count: "3" });
    expect(await pendingCount(id)).toBe(3);
  });

  test("a fully printed sample is not pending", async () => {
    const id = await insertCleanSample(conn, { specimen_count: "2" });
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${id}, 1), (${id}, 2)`);
    expect(await pendingCount(id)).toBe(null);
  });

  test("a count raised after printing leaves only the difference pending", async () => {
    const id = await insertCleanSample(conn, { specimen_count: "5" });
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${id}, 1), (${id}, 2)`);
    expect(await pendingCount(id)).toBe(3);
  });

  test("a count below what was printed is not pending — it is the other direction's problem", async () => {
    const id = await insertCleanSample(conn, { specimen_count: "2" });
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${id}, 1), (${id}, 2), (${id}, 3)`);
    expect(await pendingCount(id)).toBe(null);
  });

  test("a blocked sample is never pending, however many labels it lacks", async () => {
    const id = await insertCleanSample(conn, { locality: "NULL" });
    expect(await isPrintable(id)).toBe(false);
    expect(await pendingCount(id)).toBe(null);
  });

  test("a warning does not keep a sample out of the waiting list", async () => {
    const id = await insertCleanSample(conn, { county: "NULL", specimen_count: "4" });
    expect(await pendingCount(id)).toBe(4);
  });
});

describe("determination of record", () => {
  test("latest expert wins; else latest volunteer", async () => {
    const sampleId = await insertCleanSample(conn);
    const [[specimenId]] = (await rows(
      conn,
      `INSERT INTO specimen (sample_id, specimen_number) VALUES (${sampleId}, 1) RETURNING entity_id`,
    )) as [[number]];
    const animals = (await rows(
      conn,
      `INSERT INTO animal (rank, scientific_name) VALUES
         ('genus', 'Bombus'), ('species', 'Bombus vosnesenskii'), ('species', 'Bombus caliginosus')
       RETURNING entity_id`,
    )) as [[number], [number], [number]];
    const [[genus], [vosnesenskii], [caliginosus]] = animals;

    const record = async () =>
      (await rows(conn, `SELECT animal_id, is_expert FROM determination_of_record`))[0];

    await conn.run(`INSERT INTO determination (specimen_id, animal_id, is_expert, channel, verbatim_identification, recorded_at)
                    VALUES (${specimenId}, ${genus}, false, 'in_app', 'Bombus', TIMESTAMPTZ '2026-01-01 00:00:00Z')`);
    expect(await record()).toEqual([genus, false]);

    // A later volunteer determination supersedes the earlier one.
    await conn.run(`INSERT INTO determination (specimen_id, animal_id, is_expert, channel, verbatim_identification, recorded_at)
                    VALUES (${specimenId}, ${vosnesenskii}, false, 'in_app', 'Bombus vosnesenskii', TIMESTAMPTZ '2026-02-01 00:00:00Z')`);
    expect(await record()).toEqual([vosnesenskii, false]);

    // An expert determination wins even though it was recorded earlier.
    await conn.run(`INSERT INTO determination (specimen_id, animal_id, is_expert, channel, verbatim_identification, recorded_at)
                    VALUES (${specimenId}, ${caliginosus}, true, 'ecdysis_import', 'Bombus caliginosus', TIMESTAMPTZ '2026-01-15 00:00:00Z')`);
    expect(await record()).toEqual([caliginosus, true]);
  });
});

describe("seasons", () => {
  // Every current-season fixture takes its year from CURRENT_SEASON, and every
  // settled one from SETTLED_SEASON, which restate schema/102's rules in
  // JavaScript so a test can name a date before it has a store to ask. If the
  // two ever disagree, those fixtures are dated in the wrong season and the
  // tests built on them test nothing.
  test("the store's current season and settling line are the fixtures'", async () => {
    expect(await rows(conn, "SELECT current_season, CAST(active_since AS VARCHAR) FROM season")).toEqual([
      [CURRENT_SEASON, `${SETTLED_SEASON + 1}-01-01`],
    ]);
  });

  // The view reads the real clock, so its January branch and its time zone
  // would otherwise only be exercised by running the suite on the right day.
  // This runs schema/102's own SQL with the clock replaced by fixed instants,
  // in a session pinned to UTC as every store is (src/db.ts).
  test.each([
    ["2026-12-31 23:59:00+00", 2026, "2026-01-01"], // 3:59 p.m. in Oregon, still 2026
    ["2027-01-01 07:59:00+00", 2026, "2026-01-01"], // 11:59 p.m. on New Year's Eve in Oregon
    ["2027-01-01 08:00:00+00", 2027, "2026-01-01"], // New Year in Oregon: 2026 is past but still active
    ["2027-03-01 07:59:00+00", 2027, "2026-01-01"], // 11:59 p.m. on 28 February in Oregon
    ["2027-03-01 08:00:00+00", 2027, "2027-01-01"], // 1 March in Oregon: 2026 settles
    ["2027-07-14 12:00:00+00", 2027, "2027-01-01"],
  ])("at %s the current season is %i and the active ones began on %s", async (instant, current, activeSince) => {
    const schema = await readFile(join(SCHEMA_DIR, "102_view_settled_sample.sql"), "utf8");
    const view = /CREATE VIEW season AS\n([\s\S]*?);/.exec(schema)![1]!;
    const at = view.replaceAll("current_timestamp", `TIMESTAMPTZ '${instant}'`);
    expect(at).not.toBe(view);
    expect(await rows(conn, `SELECT current_season, CAST(active_since AS VARCHAR) FROM (${at})`)).toEqual([[current, activeSince]]);
  });

  test("the current season is active and the newest settled one is settled", async () => {
    const current = await insertCleanSample(conn);
    const settled = await insertCleanSample(conn, {
      sample_number: "'2'",
      date_start: `DATE '${SETTLED_SEASON}-07-14'`,
      date_end: `DATE '${SETTLED_SEASON}-07-14'`,
    });
    expect(await rows(conn, "SELECT sample_id FROM settled_sample")).toEqual([[settled]]);
    expect(await rows(conn, `SELECT season FROM sample_season WHERE sample_id = ${current}`)).toEqual([[CURRENT_SEASON]]);
  });

  // A season is a calendar year, by the sample's first day, as the
  // taxonomists count (Peter, 2026-10-23). Until beeline-rxn8 the year ran
  // from 1 March and was judged by the last day, so both of these counted in
  // the season before.
  test("is the calendar year of a sample's first day", async () => {
    const february = await insertCleanSample(conn, {
      sample_number: "'3'",
      date_start: "DATE '2026-02-20'",
      date_end: "DATE '2026-02-27'",
    });
    const acrossNewYear = await insertCleanSample(conn, {
      kind: "'trap'",
      sample_number: "'4'",
      date_start: "DATE '2025-12-28'",
      date_end: "DATE '2026-01-03'",
    });
    expect(
      await rows(conn, `SELECT sample_id, season FROM sample_season WHERE sample_id IN (${february}, ${acrossNewYear}) ORDER BY sample_id`),
    ).toEqual([
      [february, 2026],
      [acrossNewYear, 2025],
    ]);
  });
});
