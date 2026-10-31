import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approveRun,
  cancelRun,
  markPrinted,
  prepareRun,
  PrintRunRefused,
  requestReprint,
  withdrawReprint,
} from "../src/print-run.js";
import { createMemoryDb, insertCleanSample, CURRENT_SEASON, SETTLED_SEASON, rows } from "./helpers.js";

// Reprints (gh-218): a staff member asks for a specimen's label again, and
// the next run prints it under the number it already carries, after the new
// labels. The clock is print-run.test.ts's: fixed in 2026 so field numbers
// start at 26000001, while the samples are dated in the open season.
const NOW = new Date("2026-09-21T16:00:00Z");
const LATER = new Date("2026-09-21T17:00:00Z");
const NEXT_DAY = new Date("2026-09-22T16:00:00Z");
const DAY_AFTER = new Date("2026-09-23T16:00:00Z");

let conn: DuckDBConnection;
let ash: number;
let birch: number;
let ashSample: number;
let firstRun: number;

async function person(display: string, given: string, family: string): Promise<number> {
  const [[id]] = (await rows(
    conn,
    `INSERT INTO person (display_name, given_name, family_name) VALUES ('${display}', '${given}', '${family}') RETURNING entity_id`,
  )) as [[number]];
  return id;
}

const count = async (sql: string): Promise<number> => Number(((await rows(conn, sql)) as [[bigint]])[0][0]);
const specimenOf = async (sampleId: number, n: number): Promise<number> =>
  ((await rows(conn, `SELECT entity_id FROM specimen WHERE sample_id = ${sampleId} AND specimen_number = ${n}`)) as [[number]])[0][0];
const by = (now: Date) => ({ personId: ash, now });

/** Ash's sample of two, printed in the first run. */
beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  ash = await person("Ada Ash", "Ada", "Ash");
  birch = await person("Bo Birch", "Bo", "Birch");
  ashSample = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "2" });
  firstRun = (await prepareRun(conn, { atlasId: null, personId: ash, now: NOW }))!.printRunId;
  await approveRun(conn, firstRun, by(NOW));
  await markPrinted(conn, firstRun, by(LATER));
});

describe("asking for a reprint", () => {
  it("puts a printed specimen in the next run under its own number, after the new labels", async () => {
    const second = await specimenOf(ashSample, 2);
    // Birch's sample is new; his name sorts after Ash's, but the new labels
    // come first whatever the names, and the reprints after a blank cell.
    const birchSample = await insertCleanSample(conn, {
      collector_id: String(birch),
      specimen_count: "1",
      sample_number: "'7'",
    });
    expect(await requestReprint(conn, { specimenId: second }, { ...by(NEXT_DAY), reason: "damaged" })).toEqual({
      requested: 1,
      of: 1,
    });
    expect(await rows(conn, `SELECT specimen_id, reason, note FROM pending_reprint`)).toEqual([[second, "damaged", null]]);

    const run = await prepareRun(conn, { atlasId: null, personId: ash, now: DAY_AFTER });
    expect(run).toMatchObject({ labels: 2, reprints: 1, samples: 2, sheets: 1 });
    expect(
      await rows(
        conn,
        `SELECT sp.sample_id, pl.cell, pl.number_text, pl.date_text, pl.warnings
         FROM printed_label pl JOIN specimen sp ON sp.entity_id = pl.specimen_id
         WHERE pl.print_run_id = ${run!.printRunId} ORDER BY pl.cell`,
      ),
    ).toEqual([
      [birchSample, 0, "26000003", `14.VII${CURRENT_SEASON}-7.1`, null],
      // Cell 1 is the blank between the new labels and the reprints.
      [ashSample, 2, "26000002", `14.VII${CURRENT_SEASON}-1.2`, null],
    ]);
    // The reprint minted nothing: the registry holds one row per number, and
    // having none in this run is what makes the label a reprint.
    expect(await rows(conn, `SELECT field_number FROM minted_field_number ORDER BY 1`)).toEqual([
      ["26000001"],
      ["26000002"],
      ["26000003"],
    ]);
    expect(await rows(conn, `SELECT specimen_id FROM printed_label_reprint`)).toEqual([[second]]);
    expect(await rows(conn, `SELECT reprint_count, label_count FROM print_run_state WHERE print_run_id = ${run!.printRunId}`)).toEqual([[1, 2]]);
    expect(await rows(conn, `SELECT reprint FROM specimen_label WHERE specimen_id = ${second} ORDER BY prepared_at`)).toEqual([
      [false],
      [true],
    ]);
    expect(await rows(conn, "SELECT * FROM specimen_field_number_stale")).toEqual([]);
    expect(await count("SELECT count(*) FROM pending_reprint")).toBe(0);
    // Still printed, still counted: nothing about the first label changed.
    expect(await rows(conn, `SELECT sample_id FROM printed_sample WHERE sample_id = ${ashSample}`)).toEqual([[ashSample]]);
    expect(await count(`SELECT count(*) FROM individuated_specimen WHERE sample_id = ${ashSample}`)).toBe(2);
  });

  it("tells the proofer which lines read differently from the last label", async () => {
    const first = await specimenOf(ashSample, 1);
    await conn.run(`UPDATE sample SET locality = 'Philomath' WHERE entity_id = ${ashSample}`);
    await requestReprint(conn, { specimenId: first }, { ...by(NEXT_DAY), reason: "data_corrected" });
    const run = await prepareRun(conn, { atlasId: null, personId: ash, now: DAY_AFTER });
    expect(
      await rows(conn, `SELECT location_text, warnings FROM printed_label WHERE print_run_id = ${run!.printRunId}`),
    ).toEqual([["USA:OR:BentonCoCo Philomath", "reprint differs from its last label: location"]]);
  });

  it("asks for every specimen of a sample, leaving out the ones already asked for", async () => {
    await requestReprint(conn, { specimenId: await specimenOf(ashSample, 1) }, by(NEXT_DAY));
    expect(await requestReprint(conn, { sampleId: ashSample }, { ...by(NEXT_DAY), note: "envelope lost" })).toEqual({
      requested: 1,
      of: 2,
    });
    expect(await rows(conn, `SELECT note FROM pending_reprint ORDER BY specimen_id`)).toEqual([[null], ["envelope lost"]]);
    const run = await prepareRun(conn, { atlasId: null, personId: ash, now: DAY_AFTER });
    expect(run).toMatchObject({ labels: 2, reprints: 2 });
  });

  it("asks for a list of specimens from any samples, as ticked on the specimens listing", async () => {
    const other = await insertCleanSample(conn, { collector_id: String(birch), specimen_count: "1", sample_number: "'6'" });
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${other}, 1, '25000009')`);
    const first = await specimenOf(ashSample, 1);
    const imported = await specimenOf(other, 1);
    await requestReprint(conn, { specimenId: first }, by(NEXT_DAY));
    // The first is already asked for, so two of three are.
    expect(
      await requestReprint(conn, { specimenIds: [first, await specimenOf(ashSample, 2), imported] }, by(NEXT_DAY)),
    ).toEqual({ requested: 2, of: 3 });
    expect(await count("SELECT count(*) FROM pending_reprint")).toBe(3);
    // Only integers reach the store.
    await expect(requestReprint(conn, { specimenIds: [first, -1] }, by(NEXT_DAY))).rejects.toThrow("positive integers");
  });

  it("refuses, writing nothing, when nothing named can be asked for", async () => {
    const first = await specimenOf(ashSample, 1);
    await requestReprint(conn, { specimenId: first }, by(NEXT_DAY));
    const twice = await requestReprint(conn, { specimenId: first }, by(NEXT_DAY)).catch((e: unknown) => e);
    expect((twice as PrintRunRefused).refusal).toEqual({
      code: "reprint_refused",
      specimens: 1,
      unnumbered: 0,
      asked: 1,
      printing: 0,
    });

    // In a run that has not printed: that run is about to print it.
    const fresh = await insertCleanSample(conn, { collector_id: String(birch), specimen_count: "1", sample_number: "'9'" });
    await prepareRun(conn, { atlasId: null, personId: ash, now: DAY_AFTER });
    const printing = await requestReprint(conn, { sampleId: fresh }, by(DAY_AFTER)).catch((e: unknown) => e);
    expect((printing as PrintRunRefused).refusal).toMatchObject({ specimens: 1, printing: 1 });

    // An imported specimen from before field numbers has nothing to print.
    const old = await insertCleanSample(conn, { collector_id: String(birch), specimen_count: "1", sample_number: "'3'" });
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${old}, 1, NULL)`);
    const unnumbered = await requestReprint(conn, { sampleId: old }, by(DAY_AFTER)).catch((e: unknown) => e);
    expect((unnumbered as PrintRunRefused).refusal).toMatchObject({ specimens: 1, unnumbered: 1 });
    expect(await count("SELECT count(*) FROM reprint_request")).toBe(1);
  });

  it("can be withdrawn until a run takes it", async () => {
    const first = await specimenOf(ashSample, 1);
    await requestReprint(conn, { specimenId: first }, by(NEXT_DAY));
    expect(await withdrawReprint(conn, { sampleId: ashSample }, by(NEXT_DAY))).toEqual({ withdrawn: 1 });
    expect(await count("SELECT count(*) FROM pending_reprint")).toBe(0);
    expect(await prepareRun(conn, { atlasId: null, personId: ash, now: DAY_AFTER })).toBeNull();
    expect(await rows(conn, `SELECT withdrawn_by FROM reprint_request`)).toEqual([[ash]]);
  });

  it("comes back when the run that took it is canceled, the number untouched", async () => {
    const first = await specimenOf(ashSample, 1);
    await requestReprint(conn, { specimenId: first }, by(NEXT_DAY));
    const run = await prepareRun(conn, { atlasId: null, personId: ash, now: DAY_AFTER });
    expect(await count("SELECT count(*) FROM pending_reprint")).toBe(0);
    // Taken by a run: withdrawing is no longer the way to stop it.
    expect(await withdrawReprint(conn, { specimenId: first }, by(DAY_AFTER))).toEqual({ withdrawn: 0 });
    await cancelRun(conn, run!.printRunId, by(DAY_AFTER));
    expect(await rows(conn, `SELECT specimen_id FROM pending_reprint`)).toEqual([[first]]);
    expect(await rows(conn, `SELECT field_number FROM specimen WHERE entity_id = ${first}`)).toEqual([["26000001"]]);
    expect(await rows(conn, `SELECT specimen_id FROM minted_field_number WHERE field_number = '26000001'`)).toEqual([[first]]);
    expect(await count(`SELECT count(*) FROM individuated_specimen WHERE sample_id = ${ashSample}`)).toBe(2);
    expect(await count("SELECT count(*) FROM pending_print_sample")).toBe(0);
  });

  it("reprints an imported specimen without unlocking or uncounting it", async () => {
    const legacy = await insertCleanSample(conn, {
      collector_id: String(birch),
      specimen_count: "1",
      sample_number: "'4'",
      date_start: `DATE '${SETTLED_SEASON}-06-02'`,
      date_end: `DATE '${SETTLED_SEASON}-06-02'`,
    });
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${legacy}, 1, '25000001')`);
    const imported = await specimenOf(legacy, 1);
    // A settled season is no bar: a person asked for this label.
    await requestReprint(conn, { specimenId: imported }, { ...by(NEXT_DAY), reason: "never_received" });
    const run = await prepareRun(conn, { atlasId: null, personId: ash, now: DAY_AFTER });
    expect(await rows(conn, `SELECT number_text, date_text, warnings FROM printed_label WHERE print_run_id = ${run!.printRunId}`)).toEqual([
      ["25000001", `2.VI${SETTLED_SEASON}-4.1`, null],
    ]);
    // Waiting in an unprinted run, its labels are still on pins.
    expect(await rows(conn, `SELECT sample_id FROM printed_sample WHERE sample_id = ${legacy}`)).toEqual([[legacy]]);
    await cancelRun(conn, run!.printRunId, by(DAY_AFTER));
    expect(await rows(conn, `SELECT sample_id FROM printed_sample WHERE sample_id = ${legacy}`)).toEqual([[legacy]]);
    expect(await rows(conn, `SELECT specimen_id FROM individuated_specimen WHERE sample_id = ${legacy}`)).toEqual([[imported]]);
    expect(await rows(conn, `SELECT field_number FROM specimen WHERE entity_id = ${imported}`)).toEqual([["25000001"]]);
  });

  it("waits, rather than stopping the run, when its sample has lost its coordinates", async () => {
    await requestReprint(conn, { sampleId: ashSample }, by(NEXT_DAY));
    await conn.run(`DELETE FROM sample_location WHERE sample_id = ${ashSample}`);
    // missing_required_field is unwaivable, so the reprint is not printable;
    // the freeze never reaches its no_location guard.
    expect(await count("SELECT count(*) FROM pending_reprint")).toBe(2);
    expect(await count("SELECT count(*) FROM printable_reprint")).toBe(0);
    const fresh = await insertCleanSample(conn, { collector_id: String(birch), specimen_count: "1", sample_number: "'5'" });
    expect(await prepareRun(conn, { atlasId: null, personId: ash, now: DAY_AFTER })).toMatchObject({ labels: 1, reprints: 0 });
    expect(await count(`SELECT count(*) FROM specimen WHERE sample_id = ${fresh}`)).toBe(1);
  });

  it("waits while staff hold the sample", async () => {
    await requestReprint(conn, { sampleId: ashSample }, by(NEXT_DAY));
    await conn.run(`INSERT INTO sample_hold (sample_id, reason, held_by) VALUES (${ashSample}, 'checking the date', ${ash})`);
    expect(await count("SELECT count(*) FROM pending_reprint")).toBe(2);
    expect(await count("SELECT count(*) FROM printable_reprint")).toBe(0);
    expect(await prepareRun(conn, { atlasId: null, personId: ash, now: DAY_AFTER })).toBeNull();
    await conn.run(`DELETE FROM sample_hold`);
    expect(await prepareRun(conn, { atlasId: null, personId: ash, now: DAY_AFTER })).toMatchObject({ reprints: 2 });
  });
});
