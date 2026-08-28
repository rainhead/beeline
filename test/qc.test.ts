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
      "Sparta Road Vista",
      "Bend Twin Bridges Rd",
      "Alice Street",
      "Mosier St Park",
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

  test("agrees with the nineteen LIKE patterns it replaced, string for string", async () => {
    // The equivalence was checked against all 66,065 localities in the dev
    // store before the swap (no disagreements, identical 4,100-row output).
    // This keeps the old predicate in the repository so the next edit to the
    // token list has something to disagree with — an alternation is exactly
    // where "each token stands alone between spaces" quietly stops holding.
    const corpus = [
      "Sparta Road Vista", "Bend Twin Bridges Rd", "Alice Street", "Mosier St Park",
      "St Helens", "Corvallis SW Orchard Ave", "Rdmnd Flcn Cr Drive", "McMinnville NE Elaine Dr",
      "Corvallis NE Circle Blvd", "Thunderbird Ct", "Williams Bonlinda Lane",
      "Corvallis NE Smith Ln", "Jefferson County", "County Hwy 5-13B", "Lane County",
      "Drain", "Avery Park", "Strawberry Mountain", "Moses Lake", "Canyon City",
      "Sims Corner", "Chinook Pass", "Groundhog Mountain", "Olympic NP", "Painted Hills",
      "Klamath Falls Ashley Ct.", "Steens Mt. Loop Rd.", "Deschutes Rvr. St. Rec.",
    ];
    const values = corpus.map((l) => `('${l.replaceAll("'", "''")}')`).join(", ");
    await conn.run(`CREATE TEMP TABLE corpus(locality TEXT)`);
    await conn.run(`INSERT INTO corpus VALUES ${values}`);
    const norm = "concat(' ', replace(replace(lower(locality), ',', ' '), '.', ' '), ' ')";
    const disagreements = await rows(
      conn,
      `SELECT locality FROM (SELECT locality, ${norm} AS n FROM corpus)
       WHERE (n LIKE '% road %' OR n LIKE '% rd %'
              OR n LIKE '% street %' OR n LIKE '% str %' OR n LIKE '% st %'
              OR n LIKE '% avenue %' OR n LIKE '% ave %' OR n LIKE '% av %'
              OR n LIKE '% drive %' OR n LIKE '% dr %'
              OR n LIKE '% boulevard %' OR n LIKE '% blvd %'
              OR n LIKE '% court %' OR n LIKE '% ct %'
              OR n LIKE '% lane %' OR n LIKE '% ln %'
              OR n LIKE '% county %')
         <> regexp_matches(n, ' (road|rd|street|str|st|avenue|ave|av|drive|dr|boulevard|blvd|court|ct|lane|ln|county) ')`,
    );
    expect(disagreements).toEqual([]);
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
