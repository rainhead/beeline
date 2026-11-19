import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { Kysely } from "kysely";
import { createKysely } from "../src/db.js";
import type { Database } from "../src/model.js";
import { duckdbReader } from "../src/person-change.js";
import { readSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { setSpecimenCount, type Actor, type CorrectionDeps } from "../src/app/sample-corrections.js";
import { currentSeasonDate, insertCleanSample, rows, scratchPaths } from "./helpers.js";
import { promotedStore } from "./promoted-store.js";

/**
 * Staff correct how many specimens a trap sample holds (beeline-kgyd.4.4).
 * The old-record fixture's trap sample OBAS-00657 holds one imported specimen,
 * number 1, and is printed and settled; a trap sample entered in Beeline this
 * season stands for one still to print.
 */

async function setup() {
  const paths = await scratchPaths();
  const { instance, conn } = await promotedStore("occurrences");
  const [[sam]] = (await rows(conn, `INSERT INTO person (display_name) VALUES ('Sam Staff') RETURNING entity_id`)) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${sam}, 3, 'samstaff')`);
  const entered = await insertCleanSample(conn, {
    kind: "'trap'",
    sample_number: "'OBAS-09999'",
    date_start: `DATE '${currentSeasonDate(6, 1)}'`,
    date_end: `DATE '${currentSeasonDate(6, 8)}'`,
    specimen_count: "0",
    protocol: "'blue vane trap'",
  });
  await conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${entered})`);
  await recordSampleChanges(duckdbReader(conn), { log: paths.sampleChangesPath, state: paths.sampleStatePath }, { source: "observation_promotion" });
  const deps: CorrectionDeps = {
    db: createKysely(instance),
    conn,
    correctionsPath: paths.correctionsPath,
    sampleOverlayPath: paths.sampleOverlayPath,
    samplePaths: { log: paths.sampleChangesPath, state: paths.sampleStatePath },
    syncJobRunning: () => false,
  };
  const staff: Actor = { personId: Number(sam), signedInPersonId: Number(sam), login: "samstaff", staff: true, impersonating: false, via: "api" };
  const [[old]] = (await rows(conn, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00657'`)) as [[number]];
  return { conn, deps, paths, staff, old: Number(old), entered };
}

const countOf = async (conn: DuckDBConnection, id: number) =>
  Number(((await rows(conn, `SELECT specimen_count FROM sample WHERE entity_id = ${id}`)) as [number][])[0]![0]);
const pending = async (conn: DuckDBConnection, id: number) =>
  (await rows(conn, `SELECT pending_count FROM pending_print_sample WHERE sample_id = ${id}`)).map((r) => Number(r[0]));

describe("staff correcting a trap sample's specimen count", { timeout: 60_000 }, () => {
  it("raises the count of a sample still to print, so the next print run numbers the extra specimens", async () => {
    const s = await setup();
    expect(await pending(s.conn, s.entered)).toEqual([]);
    const result = await setSpecimenCount(s.deps, s.staff, s.entered, { count: "12", note: "pinned and counted" });
    expect(result).toEqual({
      ok: true,
      outcome: "saved",
      specimen_count: 12,
      numbered: 0,
      unnumbered: 12,
      season_settled: false,
      count_mismatch: null,
    });
    expect(await pending(s.conn, s.entered)).toEqual([12]);
    const history = (await readSampleChanges(s.paths.sampleChangesPath)).filter((c) => c.sample_number === "OBAS-09999" && c.source === "api");
    expect(history.map((c) => [c.field, c.new_value, c.author, c.reason])).toEqual([["specimen_count", "12", "samstaff", "pinned and counted"]]);
    expect(await setSpecimenCount(s.deps, s.staff, s.entered, { count: 12, note: "" })).toMatchObject({ ok: true, outcome: "unchanged" });
  });

  it("raises the count of a printed sample, and says a settled season numbers nothing", async () => {
    const s = await setup();
    const result = await setSpecimenCount(s.deps, s.staff, s.old, { count: 4, note: "" });
    expect(result).toEqual({ ok: true, outcome: "saved", specimen_count: 4, numbered: 1, unnumbered: 3, season_settled: true, count_mismatch: null });
    expect(await pending(s.conn, s.old)).toEqual([]);
  });

  it("refuses a count below a specimen that already has its field number, and allows one down to it", async () => {
    const s = await setup();
    await setSpecimenCount(s.deps, s.staff, s.old, { count: 4, note: "" });
    expect(await setSpecimenCount(s.deps, s.staff, s.old, { count: 0, note: "" })).toEqual({
      ok: false,
      refusal: "invalid",
      problem: "Specimen 1 of this sample already has its field number, so the count cannot go below 1.",
    });
    expect(await countOf(s.conn, s.old)).toBe(4);
    expect(await setSpecimenCount(s.deps, s.staff, s.old, { count: 1, note: "" })).toMatchObject({ ok: true, outcome: "saved", unnumbered: 0 });
  });

  it("leaves the observation's disagreement standing on a printed sample with one, and says so", async () => {
    const s = await setup();
    await s.conn.run(`UPDATE sample SET inat_observation_id = 777001 WHERE entity_id = ${s.old}`);
    await s.conn.run(
      `INSERT INTO observation_field (inat_id, observed_on, sample_number_raw, specimen_count_raw) VALUES (777001, DATE '2025-07-01', 'OBAS-00657', '1')`,
    );
    const result = await setSpecimenCount(s.deps, s.staff, s.old, { count: 3, note: "" });
    expect(result).toMatchObject({ ok: true, outcome: "saved", specimen_count: 3, count_mismatch: "observation says 1 but sample count is 3" });
  });

  it("refuses a count that follows its observation, a net sample, and a count that is not a whole number", async () => {
    const s = await setup();
    const unprinted = await insertCleanSample(s.conn, { kind: "'trap'", sample_number: "'T-1'", inat_observation_id: "777002" });
    await s.conn.run(`INSERT INTO observation_field (inat_id, observed_on, sample_number_raw, specimen_count_raw) VALUES (777002, DATE '${currentSeasonDate(7, 14)}', 'T-1', '3')`);
    expect(await setSpecimenCount(s.deps, s.staff, unprinted, { count: 5, note: "" })).toEqual({ ok: false, refusal: "follows_observation" });
    const net = await insertCleanSample(s.conn, { sample_number: "'N-1'" });
    expect(await setSpecimenCount(s.deps, s.staff, net, { count: 5, note: "" })).toMatchObject({ ok: false, refusal: "invalid", problem: expect.stringMatching(/net sample/) });
    for (const bad of ["-1", "2.5", "x", "", "10000"]) {
      expect(await setSpecimenCount(s.deps, s.staff, s.entered, { count: bad, note: "" })).toMatchObject({ ok: false, refusal: "invalid" });
    }
    expect(await countOf(s.conn, s.entered)).toBe(0);
  });

  it("is staff's alone, refused while impersonating, and says not found for no sample", async () => {
    const s = await setup();
    const input = { count: 5, note: "" };
    expect(await setSpecimenCount(s.deps, { ...s.staff, staff: false }, s.entered, input)).toEqual({ ok: false, refusal: "not_admin" });
    expect(await setSpecimenCount(s.deps, { ...s.staff, staff: false, impersonating: true }, s.entered, input)).toEqual({ ok: false, refusal: "impersonating" });
    expect(await setSpecimenCount(s.deps, s.staff, 999_999, input)).toEqual({ ok: false, refusal: "not_found" });
    expect(await setSpecimenCount({ ...s.deps, syncJobRunning: () => true }, s.staff, s.entered, input)).toEqual({ ok: false, refusal: "busy" });
    expect(await countOf(s.conn, s.entered)).toBe(0);
  });

  it("says nothing was done when the write loses a write conflict", async () => {
    const s = await setup();
    const db = new Proxy(s.deps.db, {
      get(target, prop) {
        if (prop === "updateTable") {
          return () => ({
            set: () => ({
              where: () => ({
                execute: async () => {
                  throw new Error("TransactionContext Error: Conflict on update!");
                },
              }),
            }),
          });
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Kysely<Database>;
    expect(await setSpecimenCount({ ...s.deps, db }, s.staff, s.entered, { count: 5, note: "" })).toEqual({ ok: false, refusal: "busy" });
    expect(await countOf(s.conn, s.entered)).toBe(0);
  });
});
