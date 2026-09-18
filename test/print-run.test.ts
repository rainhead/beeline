import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approveRun,
  cancelRun,
  markMailed,
  markPrinted,
  nextFieldNumber,
  prepareRun,
  PrintRunRefused,
  PrintRunTransitionError,
} from "../src/print-run.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

// A run prepared in the 2026 season: the year floor is 26000001, and the
// fixtures below carry no imported numbers, so that is where minting starts.
const NOW = new Date("2026-09-21T16:00:00Z");
const LATER = new Date("2026-09-21T17:00:00Z");

let conn: DuckDBConnection;
let ash: number;
let birch: number;

async function person(display: string, given: string, family: string): Promise<number> {
  const [[id]] = (await rows(
    conn,
    `INSERT INTO person (display_name, given_name, family_name) VALUES ('${display}', '${given}', '${family}') RETURNING entity_id`,
  )) as [[number]];
  return id;
}

const count = async (sql: string): Promise<number> => Number(((await rows(conn, sql)) as [[bigint]])[0][0]);

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  ash = await person("Ada Ash", "Ada", "Ash");
  birch = await person("Bo Birch", "Bo", "Birch");
});

describe("preparing a run", () => {
  it("freezes pending samples into specimens with consecutive numbers in sheet order", async () => {
    const ashSample = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "3" });
    const birchSample = await insertCleanSample(conn, {
      collector_id: String(birch),
      specimen_count: "1",
      sample_number: "'2'",
    });
    expect(await count("SELECT count(*) FROM pending_print_sample")).toBe(2);

    const result = await prepareRun(conn, { atlasId: null, personId: ash, now: NOW });
    expect(result).toMatchObject({ labels: 4, samples: 2, sheets: 1 });

    const labels = await rows(
      conn,
      `SELECT sp.sample_id, sp.specimen_number, sp.field_number, pl.sheet, pl.cell, pl.collector_text, pl.date_text
       FROM printed_label pl JOIN specimen sp ON sp.entity_id = pl.specimen_id
       WHERE pl.print_run_id = ${result!.printRunId} ORDER BY pl.cell`,
    );
    expect(labels).toEqual([
      [ashSample, 1, "26000001", 1, 0, "A.Ash", "14.VII2026-1.1"],
      [ashSample, 2, "26000002", 1, 1, "A.Ash", "14.VII2026-1.2"],
      [ashSample, 3, "26000003", 1, 2, "A.Ash", "14.VII2026-1.3"],
      // Cell 3 is the blank between collectors.
      [birchSample, 1, "26000004", 1, 4, "B.Birch", "14.VII2026-2.1"],
    ]);
    expect(await count("SELECT count(*) FROM pending_print_sample")).toBe(0);
    expect(await count("SELECT count(*) FROM minted_field_number")).toBe(4);
    expect(await count("SELECT count(*) FROM specimen WHERE occurrence_id IS NULL")).toBe(0);
    expect(await rows(conn, "SELECT * FROM specimen_field_number_stale")).toEqual([]);
    expect(await rows(conn, "SELECT * FROM minted_field_number_collision")).toEqual([]);
    expect(await rows(conn, `SELECT state, label_count, sample_count, collector_count, sheet_count FROM print_run_state`)).toEqual([
      ["prepared", 4, 2, 2, 1],
    ]);
  });

  it("writes nothing when nothing is pending", async () => {
    expect(await prepareRun(conn, { atlasId: null, personId: ash, now: NOW })).toBeNull();
    expect(await count("SELECT count(*) FROM print_run")).toBe(0);
  });

  it("spills onto a second sheet, with the collector break landing at the boundary", async () => {
    await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "249" });
    await insertCleanSample(conn, { collector_id: String(birch), specimen_count: "5" });
    const result = await prepareRun(conn, { atlasId: null, personId: ash, now: NOW });
    expect(result).toMatchObject({ labels: 254, sheets: 2 });
    expect(
      await rows(
        conn,
        `SELECT sheet, min(cell), max(cell), count(*) FROM printed_label GROUP BY sheet ORDER BY sheet`,
      ),
    ).toEqual([
      [1, 0, 248, 249n],
      [2, 0, 4, 5n],
    ]);
    expect(await rows(conn, `SELECT collector_text FROM printed_label WHERE sheet = 2 AND cell = 0`)).toEqual([
      ["B.Birch"],
    ]);
  });

  it("seeds past the imported ceiling, not from the year alone", async () => {
    const printed = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "1" });
    await conn.run(
      `INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${printed}, 1, '26072091')`,
    );
    // The E-prefixed and name-based eras never count.
    await conn.run(
      `INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${printed}, 2, 'E2332481')`,
    );
    expect(await nextFieldNumber(conn, NOW)).toBe(26072092);
    await insertCleanSample(conn, { collector_id: String(birch), specimen_count: "1" });
    await prepareRun(conn, { atlasId: null, personId: ash, now: NOW });
    expect(await rows(conn, `SELECT field_number FROM minted_field_number`)).toEqual([["26072092"]]);
    expect(await rows(conn, "SELECT * FROM minted_field_number_collision")).toEqual([]);
  });

  it("floors at the year when the store is behind it", async () => {
    await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "1" });
    expect(await nextFieldNumber(conn, new Date("2027-04-01T12:00:00Z"))).toBe(27000001);
  });

  it("mints only the new specimen numbers when a count was raised after an earlier run", async () => {
    const sample = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "2" });
    const first = await prepareRun(conn, { atlasId: null, personId: ash, now: NOW });
    await conn.run(`UPDATE sample SET specimen_count = 4 WHERE entity_id = ${sample}`);
    expect(await rows(conn, `SELECT pending_count FROM pending_print_sample`)).toEqual([[2]]);
    const second = await prepareRun(conn, { atlasId: null, personId: ash, now: NOW });
    expect(second).toMatchObject({ labels: 2, samples: 1 });
    expect(
      await rows(
        conn,
        `SELECT pl.print_run_id, sp.specimen_number, sp.field_number FROM printed_label pl
         JOIN specimen sp ON sp.entity_id = pl.specimen_id ORDER BY sp.specimen_number`,
      ),
    ).toEqual([
      [first!.printRunId, 1, "26000001"],
      [first!.printRunId, 2, "26000002"],
      [second!.printRunId, 3, "26000003"],
      [second!.printRunId, 4, "26000004"],
    ]);
  });

  it("scopes an unscoped run to atlases that do not print their own, plus the outside", async () => {
    const [[oba], [waba]] = (await rows(
      conn,
      `SELECT entity_id FROM atlas WHERE code IN ('OBA', 'WaBA') ORDER BY code`,
    )) as [[number], [number]];
    await conn.run(`INSERT INTO atlas_printing (atlas_id) VALUES (${waba})`);
    const inOregon = await insertCleanSample(conn, { collector_id: String(ash), atlas_id: String(oba) });
    const inWashington = await insertCleanSample(conn, {
      collector_id: String(ash),
      atlas_id: String(waba),
      sample_number: "'2'",
    });
    const outside = await insertCleanSample(conn, { collector_id: String(ash), sample_number: "'3'" });

    expect(await rows(conn, `SELECT sample_id FROM print_scope_sample ORDER BY sample_id`)).toEqual([
      [inOregon],
      [outside],
    ]);
    const program = await prepareRun(conn, { atlasId: null, personId: ash, now: NOW });
    expect(program).toMatchObject({ samples: 2 });
    expect(await rows(conn, `SELECT sample_id FROM pending_print_sample`)).toEqual([[inWashington]]);

    const washington = await prepareRun(conn, { atlasId: waba, personId: ash, now: NOW });
    expect(washington).toMatchObject({ samples: 1 });
    expect(await count("SELECT count(*) FROM pending_print_sample")).toBe(0);
  });

  it("stops rather than skipping a pending sample whose collector list has no head", async () => {
    const sample = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "1" });
    await conn.run(`UPDATE sample_collector SET position = 2 WHERE sample_id = ${sample}`);
    const refused = await prepareRun(conn, { atlasId: null, personId: ash, now: NOW }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(PrintRunRefused);
    expect((refused as PrintRunRefused).refusal).toEqual({ code: "no_primary_collector", sampleId: sample });
    expect(await count("SELECT count(*) FROM print_run")).toBe(0);
    expect(await count("SELECT count(*) FROM specimen")).toBe(0);
  });

  it("lets one prepare through at a time: the second finds nothing", async () => {
    await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "3" });
    const [a, b] = await Promise.all([
      prepareRun(conn, { atlasId: null, personId: ash, now: NOW }),
      prepareRun(conn, { atlasId: null, personId: birch, now: NOW }),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect(await count("SELECT count(*) FROM print_run")).toBe(1);
    expect(await count("SELECT count(*) FROM minted_field_number")).toBe(3);
  });
});

describe("moving a run through its states", () => {
  let runId: number;
  beforeEach(async () => {
    await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "2" });
    runId = (await prepareRun(conn, { atlasId: null, personId: ash, now: NOW }))!.printRunId;
  });

  const state = () => rows(conn, `SELECT state FROM print_run_state WHERE print_run_id = ${runId}`);

  it("goes prepared → approved → printed → mailed, refusing a skipped step", async () => {
    const by = { personId: ash, now: LATER };
    await expect(markPrinted(conn, runId, by)).rejects.toBeInstanceOf(PrintRunTransitionError);
    await approveRun(conn, runId, { ...by, note: "looks right" });
    expect(await state()).toEqual([["approved"]]);
    await expect(approveRun(conn, runId, by)).rejects.toBeInstanceOf(PrintRunTransitionError);
    await markPrinted(conn, runId, by);
    expect(await state()).toEqual([["printed"]]);
    await expect(cancelRun(conn, runId, by)).rejects.toBeInstanceOf(PrintRunTransitionError);
    await markMailed(conn, runId, by);
    expect(await state()).toEqual([["mailed"]]);
    expect(await rows(conn, `SELECT note, approved_by, printed_by, mailed_by FROM print_run`)).toEqual([
      ["looks right", ash, ash, ash],
    ]);
  });

  it("locks a sample only once its run has printed", async () => {
    expect(await rows(conn, `SELECT sample_id FROM printed_sample`)).toEqual([]);
    await approveRun(conn, runId, { personId: ash, now: LATER });
    expect(await rows(conn, `SELECT sample_id FROM printed_sample`)).toEqual([]);
    await markPrinted(conn, runId, { personId: ash, now: LATER });
    expect(await count(`SELECT count(*) FROM printed_sample`)).toBe(1);
  });

  it("treats an imported specimen, which no run holds, as printed", async () => {
    const legacy = await insertCleanSample(conn, { collector_id: String(birch), specimen_count: "1" });
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${legacy}, 1, '25000001')`);
    expect(await rows(conn, `SELECT sample_id FROM printed_sample`)).toEqual([[legacy]]);
  });

  it("cancels an unprinted run: numbers burned, samples pending again, nothing deleted, rows re-adopted", async () => {
    const before = (await rows(conn, `SELECT entity_id, occurrence_id FROM specimen ORDER BY specimen_number`)) as [
      number,
      string,
    ][];
    await cancelRun(conn, runId, { personId: birch, now: LATER, note: "wrong week" });
    expect(await state()).toEqual([["canceled"]]);
    // Nothing destroyed: the labels are the record of what was prepared, the
    // specimens keep their rows and their occurrenceIDs, only the number goes.
    expect(await count("SELECT count(*) FROM printed_label")).toBe(2);
    expect(await rows(conn, `SELECT field_number FROM specimen`)).toEqual([[null], [null]]);
    expect(await rows(conn, `SELECT field_number, specimen_id FROM minted_field_number ORDER BY 1`)).toEqual([
      ["26000001", null],
      ["26000002", null],
    ]);
    expect(await rows(conn, `SELECT * FROM individuated_specimen`)).toEqual([]);
    expect(await rows(conn, `SELECT pending_count FROM pending_print_sample`)).toEqual([[2]]);
    expect(await rows(conn, `SELECT sample_id FROM printed_sample`)).toEqual([]);
    expect(await rows(conn, `SELECT * FROM qc_rule_count_below_printed`)).toEqual([]);
    expect(await rows(conn, `SELECT state, label_count FROM print_run_state`)).toEqual([["canceled", 2]]);

    // The next run takes the same rows back, under fresh numbers.
    const again = await prepareRun(conn, { atlasId: null, personId: ash, now: LATER });
    expect(again).toMatchObject({ labels: 2, samples: 1 });
    expect(await count("SELECT count(*) FROM specimen")).toBe(2);
    expect(await rows(conn, `SELECT entity_id, occurrence_id FROM specimen ORDER BY specimen_number`)).toEqual(before);
    expect(await rows(conn, `SELECT field_number FROM specimen ORDER BY specimen_number`)).toEqual([
      ["26000003"],
      ["26000004"],
    ]);
    expect(await rows(conn, `SELECT field_number FROM minted_field_number WHERE specimen_id IS NOT NULL ORDER BY 1`)).toEqual([
      ["26000003"],
      ["26000004"],
    ]);
    expect(await rows(conn, "SELECT * FROM specimen_field_number_stale")).toEqual([]);
    expect(await count("SELECT count(*) FROM pending_print_sample")).toBe(0);
    expect(await count("SELECT count(*) FROM individuated_specimen")).toBe(2);
    expect(
      await rows(conn, `SELECT state, count(*) FROM specimen_label GROUP BY state ORDER BY state`),
    ).toEqual([
      ["canceled", 2n],
      ["prepared", 2n],
    ]);
  });

  it("refuses to cancel a run whose specimen has been determined", async () => {
    const [[specimenId]] = (await rows(conn, `SELECT min(entity_id) FROM specimen`)) as [[number]];
    const [[animal]] = (await rows(
      conn,
      `INSERT INTO animal (rank, scientific_name) VALUES ('genus', 'Bombus') RETURNING entity_id`,
    )) as [[number]];
    await conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, verbatim_identification)
       VALUES (${specimenId}, ${animal}, false, 'in_app', 'Bombus')`,
    );
    const refused = await cancelRun(conn, runId, { personId: ash }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(PrintRunRefused);
    expect((refused as PrintRunRefused).refusal).toEqual({ code: "determined", printRunId: runId, specimens: 1 });
    expect(await state()).toEqual([["prepared"]]);
    expect(await count("SELECT count(*) FROM specimen")).toBe(2);
  });
});
