import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { loadDashboard } from "../src/app/dashboard.js";
import { en } from "../src/app/messages/en.js";
import { loadRun } from "../src/app/print-runs.js";
import { createApp } from "../src/app/server.js";
import { deriveAreas } from "../src/derive-area.js";
import { prepareRun } from "../src/print-run.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths, SETTLED_SEASON } from "./helpers.js";

/**
 * A settled season's sample prints once staff have released it
 * (beeline-3vs.7): what the sample page offers, what the collector's front
 * page and the run page then say.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};
const t = en.record.sample.printRelease;
const settledDates = { date_start: `DATE '${SETTLED_SEASON}-07-14'`, date_end: `DATE '${SETTLED_SEASON}-07-14'` };

async function person(conn: DuckDBConnection, name: string, login: string, userId: number): Promise<number> {
  const [[id]] = (await (await conn.run(`INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)).getRows()) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${userId}, '${login}')`);
  return Number(id);
}

async function setup() {
  const { instance, conn } = await createMemoryDb();
  const alice = await person(conn, "Alice Adams", "alice", 1);
  const sam = await person(conn, "Sam Staff", "samstaff", 3);
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${sam})`);
  const db = createKysely(instance);
  const sample = (extra: Record<string, string>) =>
    insertCleanSample(conn, { collector_id: String(alice), kind: "'trap'", protocol: "'vane trap'", ...extra });
  const base = await scratchPaths();
  const appFor = (personId: number, login: string) =>
    createApp({
      ...base,
      db,
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId, login, iconUrl: null }),
      conn,
    });
  return { conn, db, alice, sam, sample, staff: appFor(sam, "samstaff"), collector: appFor(alice, "alice") };
}

const post = (app: ReturnType<typeof createApp>, id: number, body: Record<string, string>) =>
  app.request(`/samples/${id}/release-labels`, { method: "POST", body: new URLSearchParams(body) });
const route = (id: number) => `/samples/${id}/release-labels`;

describe("the release on the sample page", () => {
  it("is offered to staff on a settled sample with labels still to print, and to nobody else", async () => {
    const s = await setup();
    const settled = await s.sample({ sample_number: "'T-1'", ...settledDates });
    const page = async (app: typeof s.staff, id: number) => (await app.request(`/samples/${id}`)).text();
    expect(await page(s.staff, settled)).toContain(t.release);
    // It says what staff vouch for and how many labels the next run will print.
    expect(await page(s.staff, settled)).toContain(t.hint(3, true, false).replaceAll("'", "&#39;"));
    expect(await page(s.staff, settled)).toContain(route(settled));
    expect(await page(s.collector, settled)).not.toContain(t.release);
    expect(await page(s.collector, settled)).not.toContain(route(settled));
    // An active season prints without one, and staff may still release it so it keeps printing once it settles.
    const active = await s.sample({ sample_number: "'T-2'" });
    expect(await page(s.staff, active)).toContain(t.release);
    expect(await page(s.staff, active)).toContain(t.hint(3, false, false).replaceAll("'", "&#39;"));
    // A count copied from the observation is not staff's to vouch for: no button, and the route refuses.
    const followed = await s.sample({ sample_number: "'T-4'", inat_observation_id: "990011", ...settledDates });
    expect(await page(s.staff, followed)).not.toContain(t.release);
    const refused = await post(s.staff, followed, {});
    expect([refused.status, await refused.text()]).toEqual([409, t.countFollowsObservation]);
    // A settled sample whose bees all have labels on paper has nothing to release.
    const labelled = await s.sample({ sample_number: "'T-3'", specimen_count: "2", ...settledDates });
    await s.conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${labelled}, 1), (${labelled}, 2)`);
    expect(await page(s.staff, labelled)).not.toContain(t.release);
  });

  it("releases and redirects back, then says who released it and offers to withdraw", async () => {
    const s = await setup();
    const id = await s.sample({ sample_number: "'T-1'", ...settledDates });
    const done = await post(s.staff, id, { note: "bottle is unlabelled" });
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`/samples/${id}`);
    expect(await rows(s.conn, `SELECT released_by, reason FROM sample_print_release WHERE sample_id = ${id}`)).toEqual([[s.sam, "bottle is unlabelled"]]);
    const page = await (await s.staff.request(`/samples/${id}`)).text();
    expect(page).toContain("Released for printing by Sam Staff");
    expect(page).toContain("bottle is unlabelled");
    expect(page).toContain(t.withdraw);
    expect(page).toContain(t.withdrawHint.replaceAll("'", "&#39;"));
    expect(page).toContain(t.releasedHint);
    expect(page).not.toContain(t.release);
    expect(await rows(s.conn, `SELECT pending_count FROM pending_print_sample WHERE sample_id = ${id}`)).toEqual([[3]]);

    const withdrawn = await post(s.staff, id, { withdraw: "1" });
    expect(withdrawn.status).toBe(302);
    // The row stays as the record, and the page says who withdrew it and when, beside the offer to release again.
    expect(await rows(s.conn, `SELECT action, person_id FROM sample_print_release_event WHERE sample_id = ${id} ORDER BY entity_id`)).toEqual([
      ["release", s.sam],
      ["withdraw", s.sam],
    ]);
    const after = await (await s.staff.request(`/samples/${id}`)).text();
    expect(after).toContain("Release withdrawn by Sam Staff");
    expect(after).toContain(t.release);
    expect(after).not.toContain(t.withdraw);
  });

  it("does not say the release is for the next run on an active season's sample that has one", async () => {
    const s = await setup();
    const active = await s.sample({ sample_number: "'T-6'" });
    await s.conn.run(`INSERT INTO sample_print_release_event (sample_id, action) VALUES (${active}, 'release')`);
    const page = await (await s.staff.request(`/samples/${active}`)).text();
    expect(page).toContain(t.withdraw);
    expect(page).not.toContain(t.releasedHint);
  });

  it("refuses a collector, and releases an active season's sample ahead of its settling", async () => {
    const s = await setup();
    const settled = await s.sample({ sample_number: "'T-1'", ...settledDates });
    const active = await s.sample({ sample_number: "'T-2'" });
    expect((await post(s.collector, settled, {})).status).toBe(403);
    expect((await post(s.staff, 999999, {})).status).toBe(404);
    expect(await rows(s.conn, `SELECT count(*) FROM sample_print_release_event`)).toEqual([[0n]]);
    expect((await post(s.staff, active, {})).status).toBe(302);
    expect(await rows(s.conn, `SELECT sample_id FROM sample_print_release`)).toEqual([[active]]);
  });

  it("says one sentence for what a released settled sample waits for", async () => {
    const s = await setup();
    const page = async (id: number) => (await s.staff.request(`/samples/${id}`)).text();
    const release = (id: number) => s.conn.run(`INSERT INTO sample_print_release_event (sample_id, action) VALUES (${id}, 'release')`);
    // Entered in Beeline with a point: its county and state wait for the nightly update.
    const entered = await s.sample({ sample_number: "'T-1'", ...settledDates });
    await s.conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${entered})`);
    await release(entered);
    let text = await page(entered);
    expect(text).toContain(t.awaitingPlace);
    expect(text).not.toContain(t.releasedHint);
    expect(text).not.toContain(t.awaitingCoordinates);
    // No point: the labels wait for coordinates, not for the nightly update.
    const pointless = await s.sample({ sample_number: "'T-2'", ...settledDates });
    await s.conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${pointless})`);
    await s.conn.run(`DELETE FROM sample_location WHERE sample_id = ${pointless}`);
    await release(pointless);
    text = await page(pointless);
    expect(text).toContain(t.awaitingCoordinates);
    expect(text).not.toContain(t.awaitingPlace);
    // Nothing else to wait for: the next print run.
    const oldRecord = await s.sample({ sample_number: "'T-3'", ...settledDates });
    await release(oldRecord);
    text = await page(oldRecord);
    expect(text).toContain(t.releasedHint);
    expect(text).not.toContain(t.awaitingPlace);
    expect(text).not.toContain(t.awaitingCoordinates);
  });
});

describe("the collector's front page", () => {
  it("keeps a released settled sample and shows its flags, and keeps an unreleased one off, counted", async () => {
    const s = await setup();
    const clean = await s.sample({ sample_number: "'T-1'", ...settledDates });
    const flagged = await s.sample({ sample_number: "'T-2'", ...settledDates });
    const unreleased = await s.sample({ sample_number: "'T-3'", ...settledDates });
    await s.conn.run(`UPDATE sample_location SET coordinate_uncertainty_m = 160 WHERE sample_id = ${flagged}`);
    await s.conn.run(`UPDATE sample_location SET coordinate_uncertainty_m = 500 WHERE sample_id = ${unreleased}`);
    await s.conn.run(`INSERT INTO sample_print_release_event (sample_id, action) VALUES (${clean}, 'release'), (${flagged}, 'release')`);

    const dash = await loadDashboard(s.db, s.alice);
    const byId = new Map(dash.rows.map((r) => [r.sample_id, r]));
    expect(byId.get(clean)).toMatchObject({ pending_count: 3 });
    expect(byId.get(clean)!.findings).toEqual([]);
    expect(byId.get(flagged)!.findings.map((f) => f.rule_name)).toEqual(["coordinate_uncertainty"]);
    // Not released: kept off the page, its flag counted.
    expect(byId.has(unreleased)).toBe(false);
    expect(dash.settledFlagged).toBe(1);
  });
});

describe("the Prepare page", () => {
  it("counts released samples that wait for the nightly to place them, so a failing areas step shows", async () => {
    const s = await setup();
    const waiting = await s.sample({ sample_number: "'T-1'", ...settledDates });
    await s.conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${waiting})`);
    await s.conn.run(`INSERT INTO sample_print_release_event (sample_id, action) VALUES (${waiting}, 'release')`);
    const page = async () => (await s.staff.request("/print-runs")).text();
    expect(await page()).toContain(en.printRuns.prepare.awaitingPlace(1));
    // The nightly's areas step finds no gazetteer, so nothing places the sample: it stays out of every run and the page keeps saying so.
    expect(await deriveAreas(s.conn, join(tmpdir(), "no-such-gazetteer.duckdb"), { stampCounties: true })).toMatchObject({ gazetteerBuild: null });
    expect(await rows(s.conn, `SELECT sample_id FROM pending_print_sample WHERE sample_id = ${waiting}`)).toEqual([]);
    expect(await page()).toContain(en.printRuns.prepare.awaitingPlace(1));
    // Withdrawn, it waits for nothing.
    await s.conn.run(`INSERT INTO sample_print_release_event (sample_id, action) VALUES (${waiting}, 'withdraw')`);
    expect(await page()).not.toContain(en.printRuns.prepare.awaitingPlace(1));
  });
});

describe("the run page", () => {
  it("names a hold placed after the run was prepared on a released settled sample and on an active one", async () => {
    const s = await setup();
    const released = await s.sample({ sample_number: "'T-1'", ...settledDates, specimen_count: "1" });
    const active = await s.sample({ sample_number: "'T-3'", specimen_count: "1" });
    // A settled sample that was never released is held out of every run, so its hold is nothing to name.
    const unreleased = await s.sample({ sample_number: "'T-2'", ...settledDates, specimen_count: "1" });
    await s.conn.run(`INSERT INTO sample_print_release_event (sample_id, action) VALUES (${released}, 'release')`);
    expect(await prepareRun(s.conn, { atlasId: null, personId: s.sam, now: new Date() })).toMatchObject({ samples: 2 });
    const [[runId]] = (await rows(s.conn, `SELECT max(entity_id) FROM print_run`)) as [[number]];
    expect((await loadRun(s.db, runId))!.held).toEqual([]);
    await s.conn.run(`INSERT INTO sample_hold (sample_id, reason) VALUES (${released}, 'second thoughts'), (${active}, 'wet'), (${unreleased}, 'ignored')`);
    const held = (await loadRun(s.db, runId))!.held;
    expect(held.map((h) => [h.sample_id, h.reason]).sort()).toEqual([[released, "second thoughts"], [active, "wet"]].sort());
  });
});
