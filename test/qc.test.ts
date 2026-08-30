import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

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
    expect(f?.details).toContain("street address");
  });

  // The street-suffix check is one regular expression rather than nineteen
  // LIKE passes (beeline-2c3.37), and the thing worth pinning is that every
  // token still has to stand alone between spaces — an alternation is exactly
  // where that quietly stops being true. Strings lifted from production
  // staging, one per token, because a rule tested only on strings we wrote is
  // a rule tested on our assumptions.
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
    for (const [i, locality] of streets.entries()) {
      const id = await insertCleanSample(conn, {
        locality: `'${locality}'`,
        sample_number: `'s${i}'`,
      });
      const details = (await findings(id)).find((f) => f.rule === "locality_format")?.details ?? "";
      expect(details, locality).toContain("looks like a street address");
    }
  });

  // beeline-4dt: `st` is Saint and the abbreviation for State as well as
  // Street, and telling a volunteer that St Helens looks like a street
  // address is the one kind of finding that damages data — the only way to
  // satisfy it is to write the locality wrongly. All real localities, all
  // short and clean enough to raise nothing else.
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
    for (const [i, locality] of places.entries()) {
      const id = await insertCleanSample(conn, {
        locality: `'${locality}'`,
        sample_number: `'n${i}'`,
      });
      expect(await findings(id), locality).toEqual([]);
    }
  });

  // What "ends its phrase" allows either side of the anchor: a comma ends a
  // phrase the way the end of the string does, and a directional or a road
  // number after the suffix is still part of the address.
  test("a comma ends a phrase, and a directional or road number does not", async () => {
    const streets = ["NW Harrison Blvd, Corvallis", "Salem, Vista Ave SE", "BLM Rd 39-6-36"];
    for (const [i, locality] of streets.entries()) {
      const id = await insertCleanSample(conn, {
        locality: `'${locality}'`,
        sample_number: `'a${i}'`,
      });
      const details = (await findings(id)).find((f) => f.rule === "locality_format")?.details ?? "";
      expect(details, locality).toContain("looks like a street address");
    }
  });

  // DuckDB compiles a regex once when the pattern is a literal and once PER
  // ROW when it is anything else, so the shared predicate is a macro (which
  // the binder expands into a literal) and not the one-row view a shared
  // constant would otherwise be. Reading it out of a view cost 1.1 s over
  // the dev store's 67,304 localities against 18 ms — and every QC read in
  // the app goes through this union. A timing assertion would be flaky, so
  // what is pinned is the spelling that makes it fast (ADR 0001, beeline-5bm).
  test("both readers reach the predicate through the macro, not a subquery", async () => {
    const bodies = (await rows(
      conn,
      `SELECT view_name, sql FROM duckdb_views()
       WHERE view_name IN ('qc_rule_locality_format', 'observation_locality')
       ORDER BY view_name`,
    )) as [string, string][];
    expect(bodies.map(([name]) => name)).toEqual(["observation_locality", "qc_rule_locality_format"]);
    for (const [name, sql] of bodies) {
      expect(sql, name).toContain("locality_street_suffix_pattern()");
      expect(sql, name).not.toContain("FROM locality_street_suffix_pattern");
    }
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

  test("coordinate uncertainty over 250 m blocks printing", async () => {
    const id = await insertCleanSample(conn, {}, { coordinate_uncertainty_m: "500" });
    expect(await findings(id)).toEqual([
      { rule: "coordinate_uncertainty", details: "500 m > 250 m" },
    ]);
    expect(await isPrintable(id)).toBe(false);
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

  test("duplicate sample numbers flag every colliding sample", async () => {
    const a = await insertCleanSample(conn);
    const b = await insertCleanSample(conn); // same collector, day, and number '1'
    expect((await findings(a))[0]?.rule).toBe("duplicate_sample_number");
    expect((await findings(b))[0]?.rule).toBe("duplicate_sample_number");
    expect(await isPrintable(a)).toBe(false);
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

    await conn.run(`INSERT INTO determination (specimen_id, animal_id, is_expert, channel, recorded_at)
                    VALUES (${specimenId}, ${genus}, false, 'in_app', TIMESTAMPTZ '2026-01-01 00:00:00Z')`);
    expect(await record()).toEqual([genus, false]);

    // A later volunteer determination supersedes the earlier one.
    await conn.run(`INSERT INTO determination (specimen_id, animal_id, is_expert, channel, recorded_at)
                    VALUES (${specimenId}, ${vosnesenskii}, false, 'in_app', TIMESTAMPTZ '2026-02-01 00:00:00Z')`);
    expect(await record()).toEqual([vosnesenskii, false]);

    // An expert determination wins even though it was recorded earlier.
    await conn.run(`INSERT INTO determination (specimen_id, animal_id, is_expert, channel, recorded_at)
                    VALUES (${specimenId}, ${caliginosus}, true, 'ecdysis_import', TIMESTAMPTZ '2026-01-15 00:00:00Z')`);
    expect(await record()).toEqual([caliginosus, true]);
  });
});
