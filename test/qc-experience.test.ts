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
  // Bob: his own problem sample, invisible to Alice.
  await insertCleanSample(conn, { collector_id: String(bob), sample_number: "'B-9'", locality: "NULL" });
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
    expect(body).toContain("1 sample needs attention");
    expect(body).toContain("blocks printing");
    expect(body).toContain("A field the label needs is empty");
    // Blocking finding renders before the warning within the card.
    expect(body.indexOf("blocks printing")).toBeLessThan(body.indexOf("heads-up"));
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

  it("congratulates a clean record", async () => {
    const { app, conn, alice, bob } = await qcApp();
    // Repair Alice's sample; Bob's stays broken and must not spoil her all-clear.
    await conn.run(`UPDATE sample SET locality = 'Corvallis', county = 'BentonCo'
                    WHERE collector_id = ${alice}`);
    expect(await rows(conn, `SELECT * FROM qc_finding f JOIN sample s ON s.entity_id = f.sample_id
                             WHERE s.collector_id = ${alice}`)).toHaveLength(0);
    void bob;
    const body = await (await app.request("/")).text();
    expect(body).toContain("All clear");
    expect(body).toContain("every one of your samples is clean");
  });
});
