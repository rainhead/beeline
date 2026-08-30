import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { ACTING_COOKIE } from "../src/app/acting.js";
import { determinationHistory } from "../src/app/record.js";
import { createMemoryDb, insertCleanSample } from "./helpers.js";

/**
 * The record pages (beeline-2c3.34).
 *
 * `determination` is append-only and `determination_of_record` is a view, so
 * the thing worth testing is not that a name renders — the listing already
 * did that — but that the *history* survives the trip to the screen: three
 * events all present, the record marked, and the record marked correctly
 * when it is not the newest, which is the case the flattened read cannot
 * express and the one a volunteer will actually meet.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const person = async (conn: Awaited<ReturnType<typeof createMemoryDb>>["conn"], name: string) => {
  const [given, family] = name.split(" ");
  const [[id]] = (await (
    await conn.run(
      `INSERT INTO person (display_name, given_name, family_name)
       VALUES ('${name}', '${given}', '${family}') RETURNING entity_id`,
    )
  ).getRows()) as [[number]];
  return id;
};

const firstId = async (conn: Awaited<ReturnType<typeof createMemoryDb>>["conn"], sql: string) => {
  const [[id]] = (await (await conn.run(sql)).getRows()) as [[number]];
  return id;
};

/**
 * One specimen with an argument behind it: a volunteer's genus, an expert's
 * species two years later, and a volunteer's third opinion after that. The
 * record is the middle one — latest expert, else latest of any kind — which
 * is exactly the state a single determination cell cannot show.
 */
async function recordApp(signedInAs: "alice" | "bob" | "staffer" = "alice") {
  const { instance, conn } = await createMemoryDb();
  const alice = await person(conn, "Alice Adams");
  const bob = await person(conn, "Bob Barnes");
  const staffer = await person(conn, "Sam Staff");
  const ellen = await person(conn, "Ellen Expert");
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staffer})`);

  await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('genus', 'Bombus'), ('genus', 'Andrena')`);
  await conn.run(
    `INSERT INTO animal (rank, scientific_name, parent_id, authorship)
     SELECT 'species', 'Bombus vosnesenskii', entity_id, 'Radoszkowski, 1862'
     FROM animal WHERE scientific_name = 'Bombus'`,
  );

  // Alice's sample: iNat-backed, taxon-obscured upstream but with true
  // coordinates here, and an elevation that knows which tile it came from.
  const aliceSample = await insertCleanSample(conn, {
    collector_id: String(alice),
    atlas_id: `(SELECT entity_id FROM atlas WHERE code = 'OBA')`,
    sample_number: "'A-1'",
    specimen_count: "2",
    inat_observation_id: "998877",
    taxon_geoprivacy: "'obscured'",
    protocol: "'net'",
  });
  // Bob's, with nothing of Alice's in it — the sample she must not reach.
  const bobSample = await insertCleanSample(conn, {
    collector_id: String(bob),
    sample_number: "'B-1'",
    locality: "'Bellingham'",
    state_province: "'WA'",
  });

  await conn.run(
    `INSERT INTO specimen (sample_id, specimen_number, field_number)
     VALUES (${aliceSample}, 1, 'OBA00001'), (${aliceSample}, 2, NULL)`,
  );
  await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${bobSample}, 1, 'WABA0001')`);
  const specimen = await firstId(conn, `SELECT entity_id FROM specimen WHERE field_number = 'OBA00001'`);
  const unnumbered = await firstId(
    conn,
    `SELECT entity_id FROM specimen WHERE sample_id = ${aliceSample} AND specimen_number = 2`,
  );
  const bobSpecimen = await firstId(conn, `SELECT entity_id FROM specimen WHERE field_number = 'WABA0001'`);

  const animal = (name: string) => `(SELECT entity_id FROM animal WHERE scientific_name = '${name}')`;
  await conn.run(
    `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_id,
                                verbatim_identification, recorded_at, determined_on, sex)
     VALUES (${specimen}, ${animal("Bombus")}, false, 'legacy_import', ${alice},
             'Bombus sp.', TIMESTAMPTZ '2024-03-11 09:00:00Z', DATE '2024-03-10', 'female')`,
  );
  await conn.run(
    `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_id,
                                qualifier, verbatim_identification, recorded_at, determined_on, notes)
     VALUES (${specimen}, ${animal("Bombus vosnesenskii")}, true, 'ecdysis_import', ${ellen},
             'cf.', 'Bombus cf. vosnesenskii', TIMESTAMPTZ '2025-05-02 09:00:00Z', DATE '2025-04-28',
             'Wing venation checked under scope.')`,
  );
  // Newest, and deliberately not the record: an expert stands until another
  // expert revises. This is the pair the specimen listing cannot show.
  await conn.run(
    `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_name, recorded_at)
     VALUES (${specimen}, ${animal("Andrena")}, false, 'in_app', 'A Volunteer',
             TIMESTAMPTZ '2026-08-01 09:00:00Z')`,
  );

  const people = { alice, bob, staffer };
  const db = createKysely(instance);
  const app = createApp({
    db,
    // Sandbox, not development: development makes everyone an admin, and the
    // reach gate is half of what these tests are about.
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: people[signedInAs], login: signedInAs, iconUrl: null }),
  });
  return { app, db, conn, aliceSample, bobSample, specimen, unnumbered, bobSpecimen, ...people };
}

const get = async (app: Awaited<ReturnType<typeof recordApp>>["app"], path: string, init?: RequestInit) => {
  const res = await app.request(path, init);
  expect(res.status, path).toBe(200);
  return res.text();
};

describe("the determination history", () => {
  it("keeps every event, newest first, rather than the name in use", async () => {
    const { db, specimen } = await recordApp();
    const events = await determinationHistory(db, specimen);
    expect(events.map((e) => e.scientific_name)).toEqual(["Andrena", "Bombus vosnesenskii", "Bombus"]);
    // The record is the expert's, two years old and one event down.
    expect(events.map((e) => e.of_record)).toEqual([false, true, false]);
    expect(events[1]!.channel).toBe("ecdysis_import");
  });

  it("renders all three on the specimen page, with the record marked", async () => {
    const { app, specimen } = await recordApp();
    const body = await get(app, `/specimens/${specimen}`);
    // TaxonName sets the parts, so the binomial is not one string in the
    // markup — the epithet and its qualifier are.
    expect(body).toContain("<i>vosnesenskii</i>");
    expect(body).toContain("<i>Andrena</i>");
    expect(body).toContain("of record");
    // Who, and through which channel — none of which reaches the listing.
    expect(body).toContain("Ellen Expert");
    expect(body).toContain("imported from Ecdysis");
    expect(body).toContain("entered here");
    expect(body).toContain("Wing venation checked under scope.");
  });

  it("says why the record is not the newest entry", async () => {
    const { app, specimen } = await recordApp();
    const body = await get(app, `/specimens/${specimen}`);
    expect(body).toContain("stands until another expert revises it");
  });

  it("keeps that explanation off a specimen whose newest entry is the record", async () => {
    const { app, conn, specimen } = await recordApp();
    // Retire the third opinion; the expert's is then both newest and record.
    await conn.run(`DELETE FROM determination WHERE specimen_id = ${specimen} AND is_expert = false AND channel = 'in_app'`);
    const body = await get(app, `/specimens/${specimen}`);
    expect(body).toContain("of record");
    expect(body).not.toContain("does not displace it");
  });

  it("shows the name as the source wrote it, which reached no screen before", async () => {
    const { app, specimen } = await recordApp();
    const body = await get(app, `/specimens/${specimen}`);
    // 'Bombus sp.' resolved to the bare genus; the string is the only record
    // of what was actually said once staging is frozen (schema/040).
    expect(body).toContain("Bombus sp.");
  });

  it("says so plainly when nobody has identified the specimen", async () => {
    const { app, unnumbered } = await recordApp();
    const body = await get(app, `/specimens/${unnumbered}`);
    expect(body).toContain("Nobody has identified this specimen yet");
    // And it is still addressable, by its place in the sample.
    expect(body).toContain("Specimen 2 of sample A-1");
  });
});

describe("the sample page", () => {
  it("carries the coordinates with their provenance and the observation's geoprivacy", async () => {
    const { app, aliceSample } = await recordApp();
    const body = await get(app, `/samples/${aliceSample}`);
    expect(body).toContain("44.5646, -123.262");
    expect(body).toContain("which publishes them as they are");
    // Taxon-driven obscuring is not something the observer did, and the copy
    // has to say which it is.
    expect(body).toContain("because of the species identified on it");
    // ...and not as something the observer chose, which is the other reason
    // coordinates get obscured and a different thing to tell someone.
    expect(body).not.toContain("You set this observation");
  });

  it("says what the public sees only where that differs from the true coordinates", async () => {
    // The row used to render on every sample, with an "open" line saying
    // nothing was obscured. Redundant beside Source, which already says
    // iNaturalist publishes them as they are — and nonsense on the 6,365
    // samples that carry coordinates and no observation at all, which were
    // told that nothing about "this observation" was obscured.
    const { app, conn, aliceSample } = await recordApp();
    await conn.run(
      `UPDATE sample SET geoprivacy = NULL, taxon_geoprivacy = NULL WHERE entity_id = ${aliceSample}`,
    );
    const body = await get(app, `/samples/${aliceSample}`);
    expect(body).not.toContain("Public coordinates");
    // The coordinates and where they came from stay: those are facts about
    // the sample rather than about what iNaturalist shows.
    expect(body).toContain("44.5646, -123.262");
    expect(body).toContain("Source");

    // A sample with no observation cannot carry geoprivacy either, so it
    // takes the same path — which is the case that prompted this.
    const { app: legacy, conn: conn2, aliceSample: a2 } = await recordApp();
    await conn2.run(
      `UPDATE sample SET inat_observation_id = NULL, geoprivacy = NULL, taxon_geoprivacy = NULL
       WHERE entity_id = ${a2}`,
    );
    expect(await get(legacy, `/samples/${a2}`)).not.toContain("this observation");
  });

  it("names the tile an elevation was read from", async () => {
    const { app, aliceSample } = await recordApp();
    const body = await get(app, `/samples/${aliceSample}`);
    expect(body).toContain("72 m");
    expect(body).toContain("N44_W124_1arc_v3.tif");
  });

  it("lists its specimens and links each one to its own page", async () => {
    const { app, aliceSample, specimen } = await recordApp();
    const body = await get(app, `/samples/${aliceSample}`);
    expect(body).toContain("OBA00001");
    expect(body).toContain(`/specimens/${specimen}`);
    // The working count and the printed rows agree here; when they do, the
    // page does not explain a discrepancy it does not have.
    expect(body).not.toContain("individuated by printing");
  });

  it("says when the count and the printed specimens disagree", async () => {
    const { app, conn, aliceSample } = await recordApp();
    await conn.run(`UPDATE sample SET specimen_count = 9 WHERE entity_id = ${aliceSample}`);
    const body = await get(app, `/samples/${aliceSample}`);
    expect(body).toContain("individuated by printing");
  });

  it("answers 'why will this not print' with the same words the QC home uses", async () => {
    const { app, conn, aliceSample } = await recordApp();
    await conn.run(`UPDATE sample SET locality = NULL WHERE entity_id = ${aliceSample}`);
    const sampleBody = await get(app, `/samples/${aliceSample}`);
    expect(sampleBody).toContain("A field the label needs is empty");
    // And the specimen page carries its sample's flags too: a determiner
    // asked to name an insect should see that its record cannot print.
    const { app: unflagged, specimen } = await recordApp();
    expect(await get(unflagged, `/specimens/${specimen}`)).toContain("Nothing is flagged on this sample");
    const { app: flagged, conn: conn2, aliceSample: a2, specimen: s2 } = await recordApp();
    await conn2.run(`UPDATE sample SET locality = NULL WHERE entity_id = ${a2}`);
    expect(await get(flagged, `/specimens/${s2}`)).toContain("A field the label needs is empty");
  });
});

describe("reaching a record", () => {
  it("lets a volunteer open their own, at either grain", async () => {
    const { app, aliceSample, specimen } = await recordApp();
    expect(await get(app, `/samples/${aliceSample}`)).toContain("Sample A-1");
    expect(await get(app, `/specimens/${specimen}`)).toContain("Specimen OBA00001");
  });

  it("gives somebody else's record the same answer as one that does not exist", async () => {
    const { app, bobSample, bobSpecimen } = await recordApp();
    for (const path of [`/samples/${bobSample}`, `/specimens/${bobSpecimen}`, "/samples/999999", "/specimens/abc"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe("No such record, or not one you can see.");
    }
  });

  it("lets staff reach any record, and says whose it is not", async () => {
    const { app, bobSample } = await recordApp("staffer");
    const body = await get(app, `/samples/${bobSample}`);
    expect(body).toContain("Sample B-1");
    expect(body).toContain("Staff view: this is not one of your own records");
  });

  it("does not say that to the person who collected it", async () => {
    const { app, aliceSample } = await recordApp();
    expect(await get(app, `/samples/${aliceSample}`)).not.toContain("Staff view");
  });

  it("follows the acting-for switch, because reaching a specimen is reaching its sample", async () => {
    const { app, conn, alice, bob, bobSample } = await recordApp("alice");
    // Bob cannot sign in — a household shares one login (beeline-oyl) — so
    // Alice is granted reach over his records.
    await conn.run(`INSERT INTO person_delegate (person_id, acts_for_id) VALUES (${alice}, ${bob})`);
    const acting = { headers: { cookie: `${ACTING_COOKIE}=${encodeURIComponent("Bob Barnes")}` } };
    expect((await app.request(`/samples/${bobSample}`)).status).toBe(404);
    expect(await get(app, `/samples/${bobSample}`, acting)).toContain("Sample B-1");
  });
});
