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

describe("self-service QC home", () => {
  it("shows the signed-in collector's samples with findings, blocking first", async () => {
    const { app } = await qcApp();
    const body = await (await app.request("/")).text();
    expect(body).toContain("Sample A-7");
    expect(body).toContain("2 samples need attention");
    expect(body).toContain("blocks printing");
    expect(body).toContain("A field the label needs is empty");
    // Blocking finding renders before the warning within the card.
    expect(body.indexOf("blocks printing")).toBeLessThan(body.indexOf("heads-up"));
  });

  it("stops asking about seasons that have settled, but says they are there", async () => {
    const { app } = await qcApp();
    const body = await (await app.request("/")).text();
    // A-2 is Alice's, flagged, and from 2024: settled (beeline-2c3.24).
    expect(body).not.toContain("Sample A-2");
    // Settled is not silent — the count is on the page, with a way to them.
    expect(body).toContain("1 older sample of yours still carries a flag");
    // Exactly what settling removed: this person's own, earlier seasons,
    // flagged — not every flagged sample, and not a remembered staff scope.
    expect(body).toContain(`href="/samples?season=settled&amp;qc=flagged"`);
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

  it("states when data was last synced and that fixes clear on the next sync", async () => {
    const { app } = await qcApp();
    const body = await (await app.request("/")).text();
    expect(body).toContain("Data last synced from iNaturalist");
    expect(body).toContain("clears on the next sync");
  });

  it("lists the collector's clean samples as waiting on labels", async () => {
    const { app } = await qcApp();
    const body = await (await app.request("/")).text();
    expect(body).toContain("Waiting on labels");
    expect(body).toContain("Sample A-8");
    expect(body).toContain("Finley NWR");
    // A-7 is blocked (no locality); B-10 is Bob's.
    expect(body).not.toContain("B-10");
    // 4 labels on A-8; A-7 contributes none because it cannot print.
    expect(body).toContain("2 samples are clean and waiting — 6 labels still to print");
  });

  it("counts a printed sample out of the waiting list", async () => {
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

  it("congratulates a clean record", async () => {
    const { app, conn, alice, bob } = await qcApp();
    // Repair Alice's sample; Bob's stays broken and must not spoil her all-clear.
    await conn.run(`UPDATE sample SET locality = 'Corvallis', county = 'BentonCo'
                    WHERE entity_id IN (SELECT sample_id FROM sample_collector WHERE person_id = ${alice})`);
    expect(await rows(conn, `SELECT * FROM qc_finding f
                             JOIN sample_primary_collector pc ON pc.sample_id = f.sample_id
                             WHERE pc.person_id = ${alice}`)).toHaveLength(0);
    void bob;
    const body = await (await app.request("/")).text();
    expect(body).toContain("All clear");
    expect(body).toContain("every one of your samples is clean");
    // All clear is not the end of the page: the repaired sample is now waiting.
    expect(body).toContain("Waiting on labels");
    expect(body).toContain("Sample A-7");
  });
});
