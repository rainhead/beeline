import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

async function qcApp() {
  const { instance, conn } = await createMemoryDb();
  const [[alice]] = (await (
    await conn.run(`INSERT INTO person (display_name) VALUES ('Alice') RETURNING entity_id`)
  ).getRows()) as [[number]];
  const [[bob]] = (await (
    await conn.run(`INSERT INTO person (display_name) VALUES ('Bob') RETURNING entity_id`)
  ).getRows()) as [[number]];

  // Alice: one sample missing its locality (blocking) and county (warning).
  await insertCleanSample(conn, {
    collector_id: String(alice),
    sample_number: "'A-7'",
    locality: "NULL",
    county: "NULL",
    inat_observation_id: "123456",
  });
  // Alice again: clean, four specimens, never printed — waiting on labels.
  await insertCleanSample(conn, {
    collector_id: String(alice),
    sample_number: "'A-8'",
    specimen_count: "4",
    locality: "'Finley NWR'",
  });
  // Bob: his own problem sample, invisible to Alice.
  await insertCleanSample(conn, { collector_id: String(bob), sample_number: "'B-9'", locality: "NULL" });
  // Bob again: clean and waiting, and equally invisible to Alice.
  await insertCleanSample(conn, { collector_id: String(bob), sample_number: "'B-10'" });
  // Alice, two seasons ago: flagged, but settled — the dashboard has stopped
  // asking about it (beeline-2c3.24).
  await insertCleanSample(conn, {
    collector_id: String(alice),
    sample_number: "'A-2'",
    locality: "NULL",
    date_start: "DATE '2024-07-14'",
    date_end: "DATE '2024-07-14'",
  });
  // Bob's trap line, which Alice ran with him: his numbering, her sample too
  // (beeline-77j). One clean, one with a finding.
  const together = await insertCleanSample(conn, {
    collector_id: String(bob),
    sample_number: "'B-11'",
    specimen_count: "2",
  });
  const togetherBroken = await insertCleanSample(conn, {
    collector_id: String(bob),
    sample_number: "'B-12'",
    locality: "NULL",
  });
  for (const id of [together, togetherBroken]) {
    await conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${id}, ${alice}, 2)`);
  }
  await conn.run(
    `INSERT INTO sync_run (source, authenticated, started_at, completed_at)
     VALUES ('18521', true, TIMESTAMP '2026-08-20 03:00:00', TIMESTAMP '2026-08-20 03:10:00')`,
  );

  const db = createKysely(instance);
  const app = createApp({
    db,
    config: { environment: "development" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: alice, login: "alice", iconUrl: null }),
  });
  return { app, conn, alice, bob };
}

describe("the front page", () => {
  it("opens with the brand and what the site is, not a worklist title", async () => {
    const { app } = await qcApp();
    const body = await (await app.request("/")).text();
    expect(body).toContain("<h1>Beeline</h1>");
    expect(body).toContain("Beeline follows the bees you collect");
    expect(body).not.toContain("Samples needing attention");
  });

  it("carries the mark of the atlas the person belongs to, and none without one", async () => {
    const { app, conn, alice } = await qcApp();
    // Nobody has asked where Alice belongs: the program acts as itself.
    expect(await (await app.request("/")).text()).not.toContain('class="atlas-mark"');
    await conn.run(
      `INSERT INTO person_membership (person_id, kind, atlas_id)
       SELECT ${alice}, 'atlas', entity_id FROM atlas WHERE code = 'WaBA'`,
    );
    // Belonging is what counts, not where her samples fell (they are in Oregon).
    const body = await (await app.request("/")).text();
    expect(body).toContain('<img class="atlas-mark" src="/static/atlas/WaBA.jpg" alt="Washington Bee Atlas"');
    await conn.run(`UPDATE person_membership SET kind = 'program', atlas_id = NULL WHERE person_id = ${alice}`);
    expect(await (await app.request("/")).text()).not.toContain('class="atlas-mark"');
  });

  it("lists the signed-in collector's flagged samples in one table, blocking first", async () => {
    const { app } = await qcApp();
    const body = await (await app.request("/")).text();
    expect(body).toContain("Sample A-7");
    // The summary is a heading: it is what the volunteer came for.
    expect(body).toContain("<h2>2 samples need attention (2 cannot print until fixed)");
    expect(body).toContain("blocks printing");
    expect(body).toContain("A field the label needs is empty");
    // The flag is a full-width line under its row, and the missing locality
    // marks the place cell.
    expect(body).toContain('<tr class="flag"><td colspan="5">');
    expect(body).toContain('<td class="flagged blocking">BentonCo, OR</td>');
  });

  it("marks the cell a flag is about", async () => {
    const { app, conn, alice } = await qcApp();
    // A-8 is clean; give it a locality the label cannot carry.
    await conn.run(`UPDATE sample SET locality = '5th St, Corvallis' WHERE sample_number = 'A-8'`);
    void alice;
    const body = await (await app.request("/")).text();
    expect(body).toContain('<td class="flagged blocking">5th St, Corvallis, BentonCo, OR</td>');
    expect(body).toContain("The locality must be a short place name");
  });

  it("never leaves a value cell empty", async () => {
    const { app, conn } = await qcApp();
    await conn.run(`UPDATE sample SET locality = NULL, county = NULL, state_province = NULL`);
    const body = await (await app.request("/")).text();
    expect(body).not.toMatch(/<td><\/td>|<td class="flagged [a-z]+"><\/td>/);
    expect(body).toContain(`<span class="visually-hidden">not recorded</span>`);
  });

  it("never says sync, and states the schedule instead of a timestamp", async () => {
    const { app } = await qcApp();
    const body = await (await app.request("/")).text();
    expect(body).toContain("every morning at 2am Pacific");
    expect(body).not.toContain("Data last synced");
    expect(body).not.toMatch(/\bsync\b/i);
  });

  it("stops asking about seasons that have settled, but says they are there", async () => {
    const { app, conn } = await qcApp();
    const body = await (await app.request("/")).text();
    // A-2 is Alice's, flagged, and from 2024: settled (beeline-2c3.24).
    expect(body).not.toContain("Sample A-2");
    // Settled is not silent — the count is on the page, with a way to them.
    expect(body).toContain("1 older sample of yours still carries a flag");
    // Exactly what settling removed: this person's own, earlier seasons,
    // flagged — not every flagged sample, and not a remembered staff scope.
    // scope=mine is named rather than left implicit: it is the default only
    // for a volunteer, and for staff parseListingQuery falls back to the
    // remembered scope cookie, so leaving it out sent this link to everyone's
    // flagged samples while the sentence above it said "of yours"
    // (beeline-3kl).
    // A date rather than a season, since the listing has no season control
    // (Peter, 2026-09-16): the last day before this season started.
    const [[through]] = (await rows(conn, "SELECT CAST(started_on - 1 AS TEXT) FROM season")) as [[string]];
    expect(body).toContain(`href="/samples?scope=mine&amp;to=${through}&amp;qc=flagged"`);
    // And the current season is untouched.
    expect(body).toContain("Sample A-7");
  });

  it("never shows another collector's findings", async () => {
    const { app } = await qcApp();
    const body = await (await app.request("/")).text();
    expect(body).not.toContain("B-9");
  });

  it("links to the observation where one exists", async () => {
    const { app } = await qcApp();
    const body = await (await app.request("/")).text();
    expect(body).toContain("https://www.inaturalist.org/observations/123456");
    expect(body).toContain("Fix on iNaturalist");
  });

  it("lists the collector's clean samples as waiting on labels, in the same table", async () => {
    const { app } = await qcApp();
    const body = await (await app.request("/")).text();
    expect(body).toContain("Sample A-8");
    expect(body).toContain("Finley NWR");
    expect(body).toContain("4 labels to print");
    // A-7 is blocked (no locality); B-10 is Bob's.
    expect(body).not.toContain("B-10");
    expect(body).toContain("2 are waiting on labels");
  });

  it("counts a printed sample out of the table", async () => {
    const { app, conn, alice } = await qcApp();
    const [[id]] = (await rows(
      conn,
      `SELECT s.entity_id FROM sample s
       JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
       WHERE pc.person_id = ${alice} AND s.sample_number = 'A-8'`,
    )) as [[number]];
    await conn.run(
      `INSERT INTO specimen (sample_id, specimen_number) VALUES (${id}, 1), (${id}, 2), (${id}, 3), (${id}, 4)`,
    );
    const body = await (await app.request("/")).text();
    expect(body).not.toContain("Sample A-8");
  });

  it("keeps a count that fell below the printed labels off the page", async () => {
    const { app, conn, alice } = await qcApp();
    const [[id]] = (await rows(
      conn,
      `SELECT s.entity_id FROM sample s
       JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
       WHERE pc.person_id = ${alice} AND s.sample_number = 'A-8'`,
    )) as [[number]];
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${id}, 1), (${id}, 2), (${id}, 3), (${id}, 4)`);
    await conn.run(`UPDATE sample SET specimen_count = 2 WHERE entity_id = ${id}`);
    expect(await rows(conn, `SELECT 1 FROM qc_finding WHERE sample_id = ${id} AND rule_name = 'count_below_printed'`)).toHaveLength(1);
    const body = await (await app.request("/")).text();
    // The volunteer gets two labels to discard, which is not a job (Peter, 2026-09-16).
    expect(body).not.toContain("Sample A-8");
  });

  it("shows samples someone else numbered but you also collected", async () => {
    const { app } = await qcApp();
    const body = await (await app.request("/")).text();
    // The clean one is waiting on labels; the broken one needs attention.
    expect(body).toContain("Sample B-11");
    expect(body).toContain("Sample B-12");
    // And says whose series the number belongs to, in both places.
    expect(body.match(/collected with Bob/g)?.length).toBe(2);
    // Bob's solo samples stay his.
    expect(body).not.toContain("B-9");
    expect(body).not.toContain("B-10");
  });

  it("shows an observation numbered and left at zero as a placeholder", async () => {
    const { app, conn, alice } = await qcApp();
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${alice}, 501, 'alice')`);
    // Alice's, this season, numbered, still 0 — not a sample, and on the page for that reason.
    await conn.run(
      `INSERT INTO observation_field (inat_id, observed_on, latitude, longitude, positional_accuracy, user_id, user_login,
                                      place_guess, sample_number_raw, specimen_count_raw)
       VALUES (777001, DATE '2026-08-30', 44.5646, -123.262, 8, 501, 'alice', 'Finley NWR, Benton County, OR', '12', '0')`,
    );
    // Somebody else's zero stays theirs.
    await conn.run(
      `INSERT INTO observation_field (inat_id, observed_on, user_id, user_login, sample_number_raw, specimen_count_raw)
       VALUES (777002, DATE '2026-08-30', 502, 'bob', '99', '0')`,
    );
    // Last season's zero has settled.
    await conn.run(
      `INSERT INTO observation_field (inat_id, observed_on, user_id, user_login, sample_number_raw, specimen_count_raw)
       VALUES (777003, DATE '2024-08-30', 501, 'alice', '4', '0')`,
    );
    const body = await (await app.request("/")).text();
    expect(body).toContain("Sample 12");
    expect(body).toContain("https://www.inaturalist.org/observations/777001");
    expect(body).toContain("still says 0 specimens");
    expect(body).toContain("1 observation still says 0 specimens");
    expect(body).toContain('<td class="flagged warning">0</td>');
    // Its coordinates are true (nothing obscures them), so they show.
    expect(body).toContain("44.5646, -123.2620");
    expect(body).not.toContain("Sample 99");
    expect(body).not.toContain("Sample 4 ");
  });

  it("thanks a clean record and still links onward", async () => {
    const { app, conn, alice, bob } = await qcApp();
    // Repair Alice's sample; Bob's stays broken and must not spoil her all-clear.
    await conn.run(`UPDATE sample SET locality = 'Corvallis', county = 'BentonCo'
                    WHERE entity_id IN (SELECT sample_id FROM sample_collector WHERE person_id = ${alice})`);
    expect(await rows(conn, `SELECT * FROM qc_finding f
                             JOIN sample_primary_collector pc ON pc.sample_id = f.sample_id
                             WHERE pc.person_id = ${alice}`)).toHaveLength(0);
    void bob;
    const body = await (await app.request("/")).text();
    // Nothing flagged — but the repaired sample is now waiting, so the table stays.
    expect(body).toContain("Sample A-7");
    expect(body).toContain("waiting on labels");
    // Print everything and the table goes, with thanks.
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number)
                    SELECT s.entity_id, 1 FROM sample s JOIN sample_collector c ON c.sample_id = s.entity_id WHERE c.person_id = ${alice}`);
    await conn.run(`UPDATE sample SET specimen_count = 1 WHERE entity_id IN (SELECT sample_id FROM sample_collector WHERE person_id = ${alice})`);
    const clean = await (await app.request("/")).text();
    expect(clean).toContain("Nothing needs your attention this season");
    expect(clean).not.toContain("<table>");
  });
});
