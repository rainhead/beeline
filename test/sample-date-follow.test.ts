import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import { createMemoryDb, insertCleanSample, currentSeasonDate, scratchPaths, SETTLED_SEASON, rows } from "./helpers.js";
import { canonicalJson } from "../src/sync-inat.js";
import { promoteObservations } from "../src/promote-observations.js";
import { approveRun, markPrinted, prepareRun, requestReprint } from "../src/print-run.js";
import { readSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { duckdbReader } from "../src/person-change.js";
import { setSampleMethod } from "../src/app/sample-method.js";

/**
 * A sample's start date follows its observation until its labels print, and
 * staff may correct it after (beeline-qu2c). The first half is
 * ingest/mint-samples.sql; the second is src/app/sample-method.ts, here for a
 * sample Beeline made from an observation and printed, which has neither old
 * records nor an entry. Samples with old records are in
 * test/sample-method.test.ts, with the page.
 */

let conn: DuckDBConnection;
let instance: Awaited<ReturnType<typeof createMemoryDb>>["instance"];
let ada: number;

beforeEach(async () => {
  ({ conn, instance } = await createMemoryDb());
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
  [[ada]] = (await rows(conn, "SELECT min(entity_id) FROM person")) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${ada}, 100, 'adacollects')`);
  for (const [id, name, level] of [[1, "United States", 0], [10, "Oregon", 10], [484, "Benton", 20]] as const) {
    await conn.run(`INSERT INTO inat_place (inat_place_id, name, admin_level) VALUES (${id}, '${name}', ${level})`);
  }
});

/** A moment in the current season, so that a run is prepared after the collection dates in any season. */
const at = (month: number, day: number, hour: number) => new Date(`${currentSeasonDate(month, day)}T${String(hour).padStart(2, "0")}:00:00Z`);
/** A day as the flag writes it: 25 July 2026. */
const words = (iso: string) => `${Number(iso.slice(8))} ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const DAY = currentSeasonDate(7, 14);
const NEXT = currentSeasonDate(7, 15);
const THIRD = currentSeasonDate(7, 16);

function obs(id: number, number: string, observedOn: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    uuid: `uuid-${id}`,
    observed_on: observedOn,
    geojson: { coordinates: [-123.262, 44.5646], type: "Point" },
    positional_accuracy: 30,
    public_positional_accuracy: 30,
    geoprivacy: null,
    taxon_geoprivacy: null,
    place_ids: [1, 10, 484],
    place_guess: "Corvallis, OR, US",
    user: { id: 100, login: "adacollects", name: "Ada Collector" },
    taxon: { id: 47604, name: "Rubus", ancestor_ids: [48460, 47126, 211194, 47604] },
    ofvs: [{ name: "sampleId", value: number }, { name: "numberOfSpecimens", value: "3" }],
    ...extra,
  };
}

async function stage(o: Record<string, unknown>): Promise<void> {
  await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
  await conn.run(
    `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
     VALUES ($1, (SELECT max(entity_id) FROM sync_run), $2, $3)`,
    [Number(o.id), canonicalJson(o), `hash-${o.id}-${o.observed_on}`] as never,
  );
}

const one = async (sql: string) => (await rows(conn, sql))[0];
const datesOf = async (id: number) => one(`SELECT CAST(date_start AS VARCHAR), CAST(date_end AS VARCHAR) FROM sample WHERE entity_id = ${id}`);
/** A sample whose date is the day, linked to an observation, with no label anywhere. */
const unprinted = (id: string, number = "7", extra: Record<string, string> = {}) =>
  insertCleanSample(conn, { inat_observation_id: id, sample_number: `'${number}'`, ...extra });
/** The same, with a specimen no run minted, which is how an imported sample's labels look: on paper. */
async function printedBefore(id: string, number = "7"): Promise<number> {
  const sampleId = await unprinted(id, number);
  await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${sampleId}, 1)`);
  return sampleId;
}

describe("before printing, the date follows the observation", () => {
  test("an unprinted one-day sample takes its redated observation's day, and promoting again changes nothing", async () => {
    const sampleId = await unprinted("7");
    await stage(obs(7, "7", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(sampleId)).toEqual([NEXT, NEXT]);
    await promoteObservations(conn);
    expect(await datesOf(sampleId)).toEqual([NEXT, NEXT]);
  });

  test("a range is not collapsed onto the observation's one day", async () => {
    const trap = await unprinted("7", "7", { kind: "'trap'", date_start: `DATE '${DAY}'`, date_end: `DATE '${THIRD}'` });
    await stage(obs(7, "7", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(trap)).toEqual([DAY, THIRD]);
  });

  test("a printed sample keeps its date", async () => {
    const sampleId = await printedBefore("7");
    await stage(obs(7, "7", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(sampleId)).toEqual([DAY, DAY]);
  });

  test("an observation another sample cites is not followed", async () => {
    const a = await unprinted("7");
    const b = await unprinted("7");
    await stage(obs(7, "7", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(a)).toEqual([DAY, DAY]);
    expect(await datesOf(b)).toEqual([DAY, DAY]);
  });

  test("a sample that several observations claim is not followed", async () => {
    const sampleId = await unprinted("7");
    // The old records of this sample named two observations: both claim it, and no one date is right.
    await conn.run(`INSERT INTO sample_legacy_observation (sample_id, inat_observation_id) VALUES (${sampleId}, 7), (${sampleId}, 8)`);
    await stage(obs(7, "7", NEXT));
    await promoteObservations(conn);
    expect(await rows(conn, `SELECT sample_id FROM sample_several_observations`)).toEqual([[sampleId]]);
    expect(await datesOf(sampleId)).toEqual([DAY, DAY]);
  });

  test("two samples from two observations of one number each follow their own redated observation, which clears the duplicate", async () => {
    // Minted from observations 7 and 8, both numbered 7 on one day: a duplicate the volunteer clears by redating one.
    const a = await unprinted("7");
    const b = await unprinted("8");
    await stage(obs(7, "7", DAY));
    await stage(obs(8, "7", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(a)).toEqual([DAY, DAY]);
    expect(await datesOf(b)).toEqual([NEXT, NEXT]);
    expect(await rows(conn, `SELECT 1 FROM sample_number_conflict`)).toEqual([]);
    expect(await rows(conn, `SELECT 1 FROM qc_finding WHERE rule_name = 'duplicate_sample_number'`)).toEqual([]);
  });

  test("a swap of two samples' days stays where it is, and a chain waits a night per link", async () => {
    const a = await unprinted("7", "3");
    const b = await unprinted("8", "3", { date_start: `DATE '${NEXT}'`, date_end: `DATE '${NEXT}'` });
    await stage(obs(7, "3", NEXT));
    await stage(obs(8, "3", DAY));
    await promoteObservations(conn);
    // Each target day holds the other sample now, so neither moves; duplicate_sample_number is not raised either, since they differ today.
    expect(await datesOf(a)).toEqual([DAY, DAY]);
    expect(await datesOf(b)).toEqual([NEXT, NEXT]);

    // c would move onto the day d is leaving: it waits until d has gone.
    const c = await unprinted("9", "5");
    const d = await unprinted("10", "5", { date_start: `DATE '${NEXT}'`, date_end: `DATE '${NEXT}'` });
    await stage(obs(9, "5", NEXT));
    await stage(obs(10, "5", THIRD));
    await promoteObservations(conn);
    expect(await datesOf(c)).toEqual([DAY, DAY]);
    expect(await datesOf(d)).toEqual([THIRD, THIRD]);
    await promoteObservations(conn);
    expect(await datesOf(c)).toEqual([NEXT, NEXT]);
  });

  test("a sample held back by a third does not let its neighbour move onto it", async () => {
    // A moves onto the day B is on; B would move onto C's day, but C is printed and holds the number there.
    const a = await unprinted("7", "3");
    const b = await unprinted("8", "3", { date_start: `DATE '${NEXT}'`, date_end: `DATE '${NEXT}'` });
    const c = await printedBefore("9", "3");
    await conn.run(`UPDATE sample SET date_start = DATE '${THIRD}', date_end = DATE '${THIRD}' WHERE entity_id = ${c}`);
    await stage(obs(7, "3", NEXT));
    await stage(obs(8, "3", THIRD));
    await stage(obs(9, "3", THIRD));
    await promoteObservations(conn);
    expect(await datesOf(a)).toEqual([DAY, DAY]);
    expect(await datesOf(b)).toEqual([NEXT, NEXT]);
    expect(await rows(conn, `SELECT 1 FROM sample_number_conflict`)).toEqual([]);
  });

  test("a sample whose dates staff set is never moved", async () => {
    const sampleId = await unprinted("7");
    await conn.run(`INSERT INTO sample_date_override (sample_id) VALUES (${sampleId})`);
    await stage(obs(7, "7", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(sampleId)).toEqual([DAY, DAY]);
  });

  test("a released unprinted sample's date follows too, as its number does", async () => {
    const sampleId = await unprinted("7");
    await conn.run(`INSERT INTO sample_print_release_event (sample_id, action) VALUES (${sampleId}, 'release')`);
    await stage(obs(7, "7", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(sampleId)).toEqual([NEXT, NEXT]);
  });

  test("a move onto a day where the collector already has the number is skipped, and the nightly still completes", async () => {
    const mover = await unprinted("7");
    const holder = await insertCleanSample(conn, { sample_number: "'7'", date_start: `DATE '${NEXT}'`, date_end: `DATE '${NEXT}'` });
    await stage(obs(7, "7", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(mover)).toEqual([DAY, DAY]);
    expect(await datesOf(holder)).toEqual([NEXT, NEXT]);
    // A different number on that day is no collision.
    const other = await unprinted("9", "9");
    await stage(obs(9, "9", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(other)).toEqual([NEXT, NEXT]);
  });

  test("two samples of one collector and number redated onto one day in one pass do not both move", async () => {
    const a = await unprinted("7");
    const b = await unprinted("8", "7", { date_start: `DATE '${THIRD}'`, date_end: `DATE '${THIRD}'` });
    await stage(obs(7, "7", NEXT));
    await stage(obs(8, "7", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(a)).toEqual([DAY, DAY]);
    expect(await datesOf(b)).toEqual([THIRD, THIRD]);
    expect(await rows(conn, `SELECT 1 FROM sample_number_conflict`)).toEqual([]);
  });

  test("a sample in a prepared run follows, and the run lists its labels as out of date", async () => {
    const sampleId = await unprinted("7");
    const run = (await prepareRun(conn, { atlasId: null, personId: ada, now: at(9, 21, 16) }))!;
    await stage(obs(7, "7", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(sampleId)).toEqual([NEXT, NEXT]);
    const out = await rows(conn, `SELECT field, on_label, now FROM printed_label_out_of_date WHERE print_run_id = ${run.printRunId} AND field = 'dates'`);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(["dates", `${DAY} – ${DAY}`, `${NEXT} – ${NEXT}`]);
  });

  test("the change log records the new day as an observation promotion's", async () => {
    const sampleId = await unprinted("7");
    const paths = await scratchPaths();
    const log = { log: paths.sampleChangesPath, state: paths.sampleStatePath };
    await recordSampleChanges(duckdbReader(conn), log, { source: "observation_promotion" });
    await stage(obs(7, "7", NEXT));
    await promoteObservations(conn);
    await recordSampleChanges(duckdbReader(conn), log, { source: "observation_promotion" });
    const changes = (await readSampleChanges(paths.sampleChangesPath)).filter((c) => c.field === "date_start");
    expect(changes.map((c) => [c.new_value, c.source])).toEqual([[NEXT, "observation_promotion"]]);
  });

  test("a swap raises the blocking date flag on both samples, staff setting the date clears it, and a printed or matching sample never raises it", async () => {
    const a = await unprinted("7", "3");
    const b = await unprinted("8", "3", { date_start: `DATE '${NEXT}'`, date_end: `DATE '${NEXT}'` });
    await unprinted("9", "4"); // its date matches its observation
    await printedBefore("10", "5"); // printed, so its date is the label's
    await stage(obs(7, "3", NEXT));
    await stage(obs(8, "3", DAY));
    await stage(obs(9, "4", DAY));
    await stage(obs(10, "5", NEXT));
    await promoteObservations(conn);
    const flagged = async () => (await rows(conn, `SELECT sample_id, details FROM qc_finding WHERE rule_name = 'observation_date_differs' ORDER BY sample_id`));
    expect(await flagged()).toEqual([
      [a, `observation: ${words(NEXT)} · sample: ${words(DAY)}`],
      [b, `observation: ${words(DAY)} · sample: ${words(NEXT)}`],
    ]);
    // Blocking: neither is printable while flagged.
    expect(await rows(conn, `SELECT sample_id FROM pending_print_sample WHERE sample_id IN (${a}, ${b})`)).toEqual([]);
    // Staff set one date, which writes the override and clears the flag on it.
    const paths = await scratchPaths();
    await setSampleMethod(createKysely(instance), paths.correctionsPath, a, { protocol: "net", dateEnd: "", dateStart: NEXT, note: "", author: "samstaff", today: currentSeasonDate(12, 31) });
    expect((await flagged()).map(([id]) => id)).toEqual([b]);
  });

  test("a sample moved across the 1 March line changes season with its date", async () => {
    const settled = `${SETTLED_SEASON}-07-14`;
    const sampleId = await unprinted("7");
    await stage(obs(7, "7", settled));
    await promoteObservations(conn);
    expect(await datesOf(sampleId)).toEqual([settled, settled]);
    expect(await rows(conn, `SELECT 1 FROM settled_sample WHERE sample_id = ${sampleId}`)).toHaveLength(1);
    // A settled sample waits for a release, as one minted there would.
    expect(await rows(conn, `SELECT 1 FROM pending_print_sample WHERE sample_id = ${sampleId}`)).toEqual([]);
  });
});

describe("after printing, staff may correct the start date of a sample with an observation", () => {
  const input = (dateStart: string, extra: Record<string, unknown> = {}) => ({
    protocol: "net",
    dateEnd: "",
    dateStart,
    note: "the field book says so",
    author: "samstaff",
    // A day in the season after every fixture date, so that no save is refused as not yet come.
    today: currentSeasonDate(12, 31),
    ...extra,
  });

  const overrideOf = async (id: number) => rows(conn, `SELECT set_by, reason FROM sample_date_override WHERE sample_id = ${id}`);

  test("staff correct an unprinted one-day sample's date: the override row is written and the nightly leaves it", async () => {
    const sampleId = await unprinted("7");
    const paths = await scratchPaths();
    const saved = await setSampleMethod(createKysely(instance), paths.correctionsPath, sampleId, input(THIRD, { setBy: ada }));
    expect(saved).toEqual({ outcome: "saved" });
    expect(await datesOf(sampleId)).toEqual([THIRD, THIRD]);
    expect(await overrideOf(sampleId)).toEqual([[ada, "the field book says so"]]);
    await stage(obs(7, "7", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(sampleId)).toEqual([THIRD, THIRD]);
  });

  test("a second staff save keeps one row and records the latest save", async () => {
    const sampleId = await unprinted("7");
    const paths = await scratchPaths();
    const db = createKysely(instance);
    await setSampleMethod(db, paths.correctionsPath, sampleId, input(NEXT, { setBy: ada, note: "first" }));
    const first = await rows(conn, `SELECT CAST(set_at AS VARCHAR) FROM sample_date_override WHERE sample_id = ${sampleId}`);
    await setSampleMethod(db, paths.correctionsPath, sampleId, input(THIRD, { setBy: ada, note: "second" }));
    expect(await overrideOf(sampleId)).toEqual([[ada, "second"]]);
    const later = await rows(conn, `SELECT CAST(set_at AS VARCHAR) FROM sample_date_override WHERE sample_id = ${sampleId}`);
    expect(later).toHaveLength(1);
    // The row records the latest save: its time moved on.
    expect(String(later[0]![0]) > String(first[0]![0])).toBe(true);
  });

  test("a save of only the method writes no override, and the date still follows", async () => {
    const sampleId = await unprinted("7");
    const paths = await scratchPaths();
    expect(await setSampleMethod(createKysely(instance), paths.correctionsPath, sampleId, input(DAY, { protocol: "vane trap" }))).toEqual({ outcome: "saved" });
    expect(await overrideOf(sampleId)).toEqual([]);
    await stage(obs(7, "7", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(sampleId)).toEqual([NEXT, NEXT]);
  });

  test("a date range of a linked sample can be saved, as a range or as one day", async () => {
    const paths = await scratchPaths();
    const trap = await unprinted("7", "7", { kind: "'trap'", date_start: `DATE '${DAY}'`, date_end: `DATE '${THIRD}'` });
    expect(await setSampleMethod(createKysely(instance), paths.correctionsPath, trap, input(DAY, { protocol: "vane trap" }))).toEqual({ outcome: "saved" });
    expect(await datesOf(trap)).toEqual([DAY, DAY]);
    expect(await overrideOf(trap)).toHaveLength(1);
    await stage(obs(7, "7", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(trap)).toEqual([DAY, DAY]);
  });

  test("a sample made from an observation and printed by Beeline is written directly and the nightly does not undo it", async () => {
    const sampleId = await unprinted("7");
    const run = (await prepareRun(conn, { atlasId: null, personId: ada, now: at(9, 21, 16) }))!;
    const t = at(9, 21, 17);
    await approveRun(conn, run.printRunId, { personId: ada, now: t });
    await markPrinted(conn, run.printRunId, { personId: ada, now: t });
    expect(await rows(conn, `SELECT 1 FROM printed_sample WHERE sample_id = ${sampleId}`)).toHaveLength(1);

    const paths = await scratchPaths();
    const log = { log: paths.sampleChangesPath, state: paths.sampleStatePath };
    await recordSampleChanges(duckdbReader(conn), log, { source: "observation_promotion" });
    const saved = await setSampleMethod(createKysely(instance), paths.correctionsPath, sampleId, input(THIRD));
    expect(saved).toEqual({ outcome: "saved" });
    expect(await datesOf(sampleId)).toEqual([THIRD, THIRD]);
    expect(await overrideOf(sampleId)).toHaveLength(1);

    // The observation still says another day; a printed sample does not follow it.
    await stage(obs(7, "7", NEXT));
    await promoteObservations(conn);
    expect(await datesOf(sampleId)).toEqual([THIRD, THIRD]);

    // The history names the change, and a reprint is composed with the corrected date and says it differs from the label.
    await recordSampleChanges(duckdbReader(conn), log, { source: "app" });
    expect((await readSampleChanges(paths.sampleChangesPath)).some((c) => c.field === "date_start" && c.new_value === THIRD)).toBe(true);
    const specimenId = Number((await one(`SELECT min(entity_id) FROM specimen WHERE sample_id = ${sampleId}`))?.[0]);
    await requestReprint(conn, { specimenId }, { personId: ada, now: at(9, 22, 16), reason: "data_corrected" });
    const second = (await prepareRun(conn, { atlasId: null, personId: ada, now: at(9, 22, 17) }))!;
    expect(await one(`SELECT warnings FROM printed_label WHERE print_run_id = ${second.printRunId}`)?.then((r) => String(r?.[0]))).toContain("date");
  });

  test("the writer leaves the number-taken check to its caller, as for a sample with no observation", async () => {
    // The writer (setSampleMethod) leaves the collision to its caller, as for an unlinked sample (setMethod, startMoveHolder).
    const sampleId = await printedBefore("7");
    const paths = await scratchPaths();
    const saved = await setSampleMethod(createKysely(instance), paths.correctionsPath, sampleId, input(NEXT));
    expect(saved).toEqual({ outcome: "saved" });
  });
});
