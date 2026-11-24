import { createHash } from "node:crypto";
import type { DuckDBConnection } from "@duckdb/node-api";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { oregonToday } from "../oregon-today.js";
import { checkTrapSample, createTrapSample, findLookalikes, numberTakenProblem, seriesNumberHeldProblem, seriesNumberHolder, seriesNumberProblem, type TrapSampleForm } from "../trap-sample.js";
import { JobInterrupted } from "./jobs/framework.js";
import { STAFF_READER } from "./listings.js";
import { en } from "./messages/en.js";
import type { Messages } from "./messages/index.js";
import type { Actor, CorrectionDeps } from "./sample-corrections.js";
import { recordTrapChange } from "./sample-corrections.js";
import { fromOldRecords } from "./sample-method.js";
import { onSample } from "./sample-queue.js";
import { APPLY_ORDER, applyUnit, readQueuedUnit, type QueuedUnit } from "./samples-upload-change.js";
import { isHeld, readNow, type NewRowCreate, type SampleRowResult, type SampleUnitDifference as SamplesUnitDifference, type SamplesPlan } from "./samples-upload-plan.js";

/**
 * Applying a staff member's samples file (beeline-kgyd.4.10): what the page offers, what the claim writes, and the
 * job that works through the rows. See docs/architecture/loading-an-edited-download.md.
 *
 * Applying is two steps. The request works the plan out again, checks it is the plan the page showed, and in one
 * transaction claims the upload (`upload_applied`) and queues one `pending` row in `upload_sample_outcome` for each
 * row to do, with exactly what to write. Then the `apply-uploads` job works through the pending rows in file order,
 * one row at a time, and records each outcome. Everything the job needs is in the queued rows, so it does not read
 * the file, and a restart finds what is left to do. A new row is one unit, `row`; a changed existing sample is one
 * unit for each kind of change, applied through the correction the pages use (src/app/samples-upload-change.ts).
 */

/** The job's name, in the registry and on the Jobs page. */
export const APPLY_JOB = "apply-uploads";

/** The unit of a whole new row. An existing sample's units are named for the kind of change (`APPLY_ORDER`). */
export const ROW_UNIT = "row";

/** What is stored for a queued row: everything the job writes, so that it does not depend on the file. */
export interface QueuedRow {
  form: TrapSampleForm;
  /** The look-alike was ticked "create anyway", so the job does not look for one again. */
  anyway: boolean;
}

/** The rows of a plan that applying would act on: the new ones with nothing wrong that are not held for a tick. */
export function rowsToApply(plan: SamplesPlan): Array<SampleRowResult & { create: NewRowCreate }> {
  return plan.rows.filter((r): r is SampleRowResult & { create: NewRowCreate } => r.create !== null && !isHeld(r.create));
}

/** The rows with nothing wrong that wait for a tick that was not given: not created, and said so. */
export function rowsHeld(plan: SamplesPlan): Array<SampleRowResult & { create: NewRowCreate }> {
  return plan.rows.filter((r): r is SampleRowResult & { create: NewRowCreate } => r.create !== null && isHeld(r.create));
}

/** The changes to existing samples that applying queues, by row: every one whose kind is ticked. A predicted refusal does not leave one out: the correction decides. */
export function unitsToApply(plan: SamplesPlan): Array<{ row: SampleRowResult; unit: SamplesUnitDifference }> {
  return plan.rows.flatMap((row) => row.differences.filter((d) => d.chosen).map((unit) => ({ row, unit })));
}

/**
 * A digest of what the page offered: every new row that could be made, its row number and every value making it
 * would write (the person ids its collectors came to included), and for a held row the sample it looks like. A tick
 * is the person's own answer and is not in it: the page's form carries this, and applying refuses if the plan worked
 * out again gives another. For an existing sample, every change that could be queued, whether or not its kind is ticked
 * (so the ticks, which are posted with the button, need not be in it): its row and unit, what it would write and the
 * people its collectors came to, the version the file says, and for a method change the effort text it would rewrite.
 * Predicted refusals are not in it: they depend on the ticks, and are shown and not enforced.
 */
export function digestOf(plan: SamplesPlan): string {
  const hash = createHash("sha256");
  for (const r of plan.rows) {
    if (r.kind === "existing") {
      for (const d of r.differences) hash.update(JSON.stringify([r.row, "unit", d.unit, d.change, r.fileVersion]));
      continue;
    }
    if (r.create === null) continue;
    // Held rows too, in full: a change to one between the preview and Apply refuses.
    // The form carries the number a blank row is given, so the numbering is in it.
    hash.update(JSON.stringify([r.row, r.create.form, r.create.lookalike?.sampleId ?? null, r.create.lookalike?.fileRow ?? null]));
  }
  return hash.digest("hex").slice(0, 32);
}

/**
 * The sentence for a row left alone because it looks like an existing sample, said once the file is applied, when
 * nothing can be ticked any more: the row can be uploaded again, or entered on the trap form.
 */
export const lookalikeSentence = (sampleNumber: string, fileRow?: number) =>
  fileRow !== undefined
    ? `It looks like row ${fileRow}${sampleNumber === "" ? "" : ` (${sampleNumber})`} of this file: the same first collector, overlapping days and a point within 100 metres, so it was not created. If it is a different trap, upload the row again and tick create anyway, or enter it on the trap form.`
    : `It looks like ${sampleNumber === "" ? "a sample Beeline already has" : `sample ${sampleNumber}`}: the same first collector, overlapping days and a point within 100 metres, so it was not created. To change that sample instead, edit its row in a fresh download, which carries its sampleId, sampleVersion and fieldNumber, and upload that. To make a new sample anyway, upload the row again and tick create anyway, or enter it on the trap form.`;

/** The sentence for a row left alone because its number is in the OBAS series and the numbers were not confirmed. */
export const obasSentence =
  "Its number is in the OBAS series, or blank so that it would be given the next one, and a person has to confirm the series' numbers: the box \"I've checked these OBAS numbers\" was not ticked, so it was not created. To make it, upload the file again and tick the box.";

/** Why a held row was left alone, in the sentences of each tick it was waiting for. */
const heldSentence = (create: NewRowCreate): string =>
  [create.lookalike !== null && !create.anyway ? lookalikeSentence(create.lookalike.sampleNumber, create.lookalike.fileRow) : null, create.obas && !create.obasChecked ? obasSentence : null].filter((x) => x !== null).join(" ");

/**
 * Claim the upload and queue its rows, in one transaction. False if the upload was claimed already, which its key
 * decides: two submissions of one page cannot both queue the rows.
 *
 * A new row is one unit. For an existing sample, each change is a unit named for its kind of change: `pending` when
 * its kind was ticked, `skipped` when it was not (the person chose to leave it). A predicted refusal is not recorded
 * here: it is shown and not enforced, and the job asks the correction itself.
 */
export async function claimUpload(
  db: Kysely<Database>,
  claim: { uploadId: number; appliedBy: number; plan: SamplesPlan; now: Date; messages?: Messages },
): Promise<{ queued: number; held: number } | null> {
  const todo = rowsToApply(claim.plan);
  const held = rowsHeld(claim.plan);
  const changes = unitsToApply(claim.plan);
  const m = claim.messages ?? en;
  const at = claim.now.toISOString();
  type Insert = { row: number; unit: string; outcome: "pending" | "skipped" | "refused"; sampleId: number | null; number: string | null; payload: string | null; detail: string | null };
  const inserts: Insert[] = [
    ...todo.map((r): Insert => ({ row: r.row, unit: ROW_UNIT, outcome: "pending", sampleId: null, number: r.create.form.sample_number, payload: JSON.stringify({ form: r.create.form, anyway: r.create.anyway } satisfies QueuedRow), detail: null })),
    ...held.map((r): Insert => ({ row: r.row, unit: ROW_UNIT, outcome: "skipped", sampleId: null, number: r.create.form.sample_number, payload: null, detail: heldSentence(r.create) })),
  ];
  for (const r of claim.plan.rows) {
    for (const d of r.differences) {
      const base = { row: r.row, unit: d.unit, sampleId: r.sampleId, number: r.sampleNumber };
      if (!d.chosen) inserts.push({ ...base, outcome: "skipped", payload: null, detail: m.uploads.changes.notChosen });
      else {
        const queued: QueuedUnit = { change: d.change, cells: d.compare };
        inserts.push({ ...base, outcome: "pending", payload: JSON.stringify(queued), detail: null });
      }
    }
  }
  const queuedCount = todo.length + changes.length;
  try {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("upload_applied")
        .values({ upload_id: claim.uploadId, applied_by: claim.appliedBy, applied_at: at, draft_count: queuedCount })
        .execute();
      for (const i of inserts) {
        await trx
          .insertInto("upload_sample_outcome")
          .values({
            upload_id: claim.uploadId,
            row_number: i.row,
            unit: i.unit,
            outcome: i.outcome,
            sample_id: i.sampleId,
            sample_number: i.number,
            payload: i.payload,
            detail: i.detail,
            recorded_at: at,
          })
          .execute();
      }
    });
  } catch (err) {
    // The key: somebody else's submission of this page got there first.
    if (await db.selectFrom("upload_applied").select("upload_id").where("upload_id", "=", claim.uploadId).executeTakeFirst()) return null;
    throw err;
  }
  return { queued: queuedCount, held: held.length };
}

/** An ORDER BY expression that puts a row's units in the order they are applied, a new row's own unit first. */
const UNIT_ORDER_SQL = (column: string) => `CASE ${column} WHEN 'row' THEN 0 ${APPLY_ORDER.map((u, i) => `WHEN '${u}' THEN ${i + 1}`).join(" ")} ELSE 99 END`;

export interface OutcomeRow {
  row_number: number;
  unit: string;
  outcome: "pending" | "created" | "applied" | "unchanged" | "refused" | "skipped";
  sample_id: number | null;
  sample_number: string | null;
  detail: string | null;
  /** What was queued, as JSON: for a change to an existing sample, the cells it came from, which its note says. Null for a new row, whose payload the page does not need. */
  payload: string | null;
  /** The claim queued it for the job (it holds a payload), as against settling it itself: a row that was held, or a change not ticked. */
  queued: boolean;
  /** The sample was made and has since been deleted (`sample_deletion`). */
  deleted: boolean;
  /** Whether the sample the change is to is in a season still active or one that has settled, as every count is split. */
  season: "active" | "settled" | "unplaced";
}

/** What applying did to each row of an upload so far, in file order. */
export async function readOutcomes(db: Kysely<Database>, uploadId: number): Promise<OutcomeRow[]> {
  const found = await sql<OutcomeRow>`
    SELECT o.row_number, o.unit, o.outcome, o.sample_id, o.sample_number, o.detail, CASE WHEN o.unit = 'row' THEN NULL ELSE o.payload END AS payload, o.payload IS NOT NULL AS queued,
           CASE WHEN o.sample_id IS NULL THEN 'unplaced'
                WHEN EXISTS (SELECT 1 FROM settled_sample ss WHERE ss.sample_id = o.sample_id) THEN 'settled'
                WHEN EXISTS (SELECT 1 FROM sample s WHERE s.entity_id = o.sample_id) THEN 'active'
                ELSE 'unplaced' END AS season,
           (o.outcome = 'created'
            AND NOT EXISTS (SELECT 1 FROM sample s WHERE s.entity_id = o.sample_id)
            AND EXISTS (SELECT 1 FROM sample_deletion d WHERE d.sample_id = o.sample_id)) AS deleted
    FROM upload_sample_outcome o
    WHERE o.upload_id = ${uploadId}
    ORDER BY o.row_number, ${sql.raw(UNIT_ORDER_SQL("o.unit"))}`.execute(db);
  return found.rows;
}

/**
 * Whether any upload has a row still to do, and is not stopped: what makes the scheduler start the job, and starts it
 * again after a deploy. An upload the job stopped on (`stopped_at`) waits for staff to choose Try again.
 */
export async function applyWaiting(db: Kysely<Database>): Promise<boolean> {
  const found = await sql<{ n: number }>`
    SELECT count(*)::INTEGER AS n FROM (
      SELECT 1 FROM upload_sample_outcome o JOIN upload_applied a ON a.upload_id = o.upload_id
      WHERE o.outcome = 'pending' AND a.stopped_at IS NULL LIMIT 1)`.execute(db);
  return Number(found.rows[0]?.n ?? 0) > 0;
}

/** Mark an upload as stopped at a row: the job leaves it alone until staff choose Try again. No error text is kept. */
async function stopUpload(db: Kysely<Database>, uploadId: number, row: number): Promise<void> {
  const changed = await db.updateTable("upload_applied").set({ stopped_at: new Date().toISOString(), stopped_row: row }).where("upload_id", "=", uploadId).where("stopped_at", "is", null).executeTakeFirst();
  if (Number(changed.numUpdatedRows) !== 1) throw new Error(`upload ${uploadId} could not be marked stopped`);
}

/** Staff chose Try again: the mark is cleared, and the upload's pending rows wait for the job once more. False if the upload was not stopped. */
export async function clearStopped(db: Kysely<Database>, uploadId: number): Promise<boolean> {
  const changed = await db.updateTable("upload_applied").set({ stopped_at: null, stopped_row: null }).where("upload_id", "=", uploadId).where("stopped_at", "is not", null).executeTakeFirst();
  return Number(changed.numUpdatedRows) === 1;
}

/**
 * The upload is being undone: its rows still waiting are left alone, so that nothing more is created, and a stop is
 * cleared, since there is nothing left to try again. In one transaction and in that order, so the job cannot pick the
 * upload up between the stop being cleared and its rows being settled. A change that stopped as recorded in the
 * corrections file and not applied keeps that in its note: the file holds a change the store never got.
 */
export async function settleUndone(db: Kysely<Database>, uploadId: number): Promise<void> {
  const w = en.uploads.changes;
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("upload_sample_outcome")
      .set({
        outcome: "skipped",
        detail: sql<string>`CASE WHEN unit = 'row' THEN 'The upload was undone, so this row was not created.'
          WHEN detail = ${w.notAppliedPending} THEN ${`The upload was undone, so this change was not made. ${w.notAppliedUndone}`}
          ELSE 'The upload was undone, so this change was not made.' END`,
        recorded_at: new Date().toISOString(),
      })
      .where("upload_id", "=", uploadId)
      .where("outcome", "=", "pending")
      .execute();
    await trx.updateTable("upload_applied").set({ stopped_at: null, stopped_row: null }).where("upload_id", "=", uploadId).execute();
  });
}

export interface ApplyDeps {
  db: Kysely<Database>;
  /** Reads the store, and applies the sample overlay. */
  conn: DuckDBConnection;
  /** The print runs' connection, which every write of a trap sample goes through (src/trap-sample.ts). */
  printWriter: DuckDBConnection;
  samplePaths: CorrectionDeps["samplePaths"];
  /** Where the corrections to old records and the staff's overlay of samples are kept, which the corrections write. */
  correctionsPath: string;
  sampleOverlayPath: string;
  /** The files that derive elevation and areas for a point that moved. */
  derivePaths?: CorrectionDeps["derivePaths"];
  /** The connection that derives them; the job's own when absent. */
  mintConn?: DuckDBConnection;
  /**
   * Whether the nightly or the weekly sweep is running. The apply job is one job at a time with them, so it is never
   * true here; a test says so to see how a change that meets one is left.
   */
  syncJobRunning?: () => boolean;
  /** The catalogue the sentences come from; English. */
  messages?: Messages;
  /** Oregon's today, for the date rules of a change of dates; the clock's when absent. */
  today?: () => string;
  /** Whether a person is staff now: the job does not apply a file for somebody who has stopped being. The person_admin roster when absent. */
  isStaff?: (personId: number) => Promise<boolean>;
  /**
   * The job's abort signal: set when the process is being stopped. No creation begins once it is, and an error met
   * with it set is the stop and not a fault of the row.
   */
  signal?: AbortSignal;
  /** Runs one unit of work as a step of the job (the framework's), so a shutdown stops the job between rows. */
  step?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  /** Tests only: the bounds of a run (APPLY_ROW_LIMIT, APPLY_TIME_LIMIT_MS), and the clock they are measured on. */
  limits?: { rows?: number; ms?: number; now?: () => number };
  /** Tests only: told after each row is done. */
  afterRow?: (row: { uploadId: number; row: number }) => void | Promise<void>;
}

interface Pending {
  upload_id: number;
  row_number: number;
  unit: string;
  sample_id: number | null;
  sample_number: string | null;
  payload: string | null;
  applied_by: number;
  login: string | null;
}

async function nextPending(db: Kysely<Database>): Promise<Pending | undefined> {
  const found = await sql<Pending>`
    SELECT o.upload_id, o.row_number, o.unit, o.sample_id, o.sample_number, o.payload, a.applied_by,
           (SELECT min(i.login) FROM inat_account i WHERE i.person_id = a.applied_by) AS login
    FROM upload_sample_outcome o
    JOIN upload_applied a ON a.upload_id = o.upload_id
    WHERE o.outcome = 'pending' AND a.stopped_at IS NULL
    ORDER BY o.upload_id, o.row_number, ${sql.raw(UNIT_ORDER_SQL("o.unit"))}
    LIMIT 1`.execute(db);
  return found.rows[0];
}

/** Record how a queued row or change ended, when no sample is made with it. */
async function settle(db: Kysely<Database>, p: Pick<Pending, "upload_id" | "row_number" | "unit">, outcome: "refused" | "skipped" | "unchanged" | "applied", detail: string | null): Promise<void> {
  await db
    .updateTable("upload_sample_outcome")
    .set({ outcome, detail, recorded_at: new Date().toISOString() })
    .where("upload_id", "=", p.upload_id)
    .where("row_number", "=", p.row_number)
    .where("unit", "=", p.unit)
    .where("outcome", "=", "pending")
    .execute();
}

/** The reason a sample made from an upload carries in its history, so the history names the upload. */
export const historyReason = (uploadId: number) => `From upload ${uploadId}`;

/** What was queued for a row, if it is the shape the job writes from; otherwise why not. */
function readQueued(payload: string | null): QueuedRow | { unreadable: string } {
  if (payload === null) return { unreadable: "nothing is stored" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    return { unreadable: `not JSON: ${(err as Error).message}` };
  }
  const q = parsed as { form?: Record<string, unknown>; anyway?: unknown } | null;
  const form = q?.form;
  if (typeof form !== "object" || form === null) return { unreadable: "no form" };
  for (const key of ["sample_number", "date_start", "date_end", "method", "trap_count", "specimen_count", "latitude", "longitude", "uncertainty", "country", "state_province", "county", "locality"]) {
    if (typeof form[key] !== "string") return { unreadable: `${key} is not text` };
  }
  if (form.sample_number === "") return { unreadable: "the number is blank" };
  if (!Array.isArray(form.collectors) || !form.collectors.every((c) => typeof c === "string")) return { unreadable: "collectors is not a list of text" };
  if (typeof q?.anyway !== "boolean") return { unreadable: "anyway is not true or false" };
  return q as unknown as QueuedRow;
}

/** A look-alike found inside the creating transaction, which aborts it. */
class LookalikeFound extends Error {
  constructor(readonly sampleNumber: string) {
    super(`looks like sample ${sampleNumber}`);
  }
}

/** What one row's work came to, in units: a new row is one. */
type Counts = Partial<Record<"created" | "refused" | "skipped" | "applied" | "unchanged" | "stopped" | "notApplied", number>>;

/** Make one trap sample from a queued row, or say why not. */
async function createRow(deps: ApplyDeps, p: Pending): Promise<{ outcome: "created"; id: number } | { outcome: "refused" | "skipped" }> {
  const queued = readQueued(p.payload);
  if ("unreadable" in queued) {
    await settle(deps.db, p, "refused", `What was queued for this row cannot be read (${queued.unreadable}), so it was not created.`);
    return { outcome: "refused" };
  }
  // The trap form's own check, again, with the ids the collectors came to. The number is the one the preview showed:
  // a blank row was given its number when the file was applied, and is not renumbered here.
  const checked = await checkTrapSample(deps.conn, queued.form, null);
  if ("problems" in checked) {
    await settle(deps.db, p, "refused", Object.values(checked.problems).join(" "));
    return { outcome: "refused" };
  }
  const sample = checked.sample;
  const wrong = seriesNumberProblem(sample.sample_number);
  if (wrong !== null) {
    await settle(deps.db, p, "refused", wrong);
    return { outcome: "refused" };
  }
  // No creation begins once the process is stopping: its transaction is on the print connection, which a stop does not
  // interrupt, since a print run shares it.
  if (deps.signal?.aborted) throw new JobInterrupted(`making ${sample.sample_number}`);
  // The outcome is written in the sample's own transaction, so a crash cannot leave a sample that no row names. Under the
  // print runs' lock a look-alike is looked for (not the samples this same upload has made: its rows were held against
  // each other in the preview), so a trap form entry committed meanwhile is caught.
  // No `staff` option, so no print release is written, whoever applied the file. A sample from an active season prints
  // without one; a sample from a settled season entered through a file waits for staff to release it from its own
  // page, because a file of old bottles may include ones already labelled (beeline-3vs.3).
  const made = await createTrapSample(
    deps.printWriter,
    sample,
    p.applied_by,
    async (id) => {
      if (!queued.anyway) {
        const [like] = await findLookalikes(
          deps.printWriter,
          { firstCollectorId: sample.collector_ids[0]!, dateStart: sample.date_start, dateEnd: sample.date_end, latitude: sample.latitude, longitude: sample.longitude },
          { sampleId: id, uploadId: p.upload_id },
        );
        if (like !== undefined) throw new LookalikeFound(like.sampleNumber);
      }
      const updated = await deps.printWriter.run(
        `UPDATE upload_sample_outcome SET outcome = 'created', sample_id = $1, detail = NULL, recorded_at = now()
         WHERE upload_id = $2 AND row_number = $3 AND unit = $4 AND outcome = 'pending'`,
        [id, p.upload_id, p.row_number, p.unit] as never,
      );
      if (updated.rowsChanged !== 1) throw new Error(`upload ${p.upload_id} row ${p.row_number} was not pending when its sample was made`);
    },
    { anyKind: true },
  ).catch(async (err: unknown) => {
    if (err instanceof LookalikeFound) {
      await settle(deps.db, p, "skipped", lookalikeSentence(err.sampleNumber));
      return "skipped" as const;
    }
    throw err;
  });
  if (made === "skipped") return { outcome: "skipped" };
  if (made === "taken") {
    const holder = await seriesNumberHolder(deps.conn, sample.sample_number);
    await settle(deps.db, p, "refused", holder === null ? numberTakenProblem(sample.sample_number) : seriesNumberHeldProblem(sample.sample_number, holder));
    return { outcome: "refused" };
  }
  // Entered in the sample's history as arriving, under whoever applied the file, in its own turn of the queue, as the trap form does.
  await onSample(made, () => recordTrapChange(deps, p.login ?? "", made, { source: "upload", created: true, reason: historyReason(p.upload_id) }));
  return { outcome: "created", id: made };
}

/** A change that was neither made nor refused: the run stops on it, and Try again sends it again. Its message names no values. */
class UnitNotDone extends Error {}

const staffNow = async (deps: ApplyDeps, personId: number): Promise<boolean> =>
  deps.isStaff !== undefined ? deps.isStaff(personId) : (await deps.db.selectFrom("person_admin").where("person_id", "=", personId).select("person_id").executeTakeFirst()) !== undefined;

/** Set what a change's note says without settling it: for a change still pending, or to add to what an applied one says. */
async function noteOn(db: Kysely<Database>, key: Pick<Pending, "upload_id" | "row_number" | "unit">, detail: string): Promise<void> {
  await db
    .updateTable("upload_sample_outcome")
    .set({ detail })
    .where("upload_id", "=", key.upload_id)
    .where("row_number", "=", key.row_number)
    .where("unit", "=", key.unit)
    .execute();
}

/**
 * Apply the pending changes of one existing sample's row, each through its correction, in `APPLY_ORDER`. Right before
 * each change, the cells it came from are compared with what Beeline holds now, as the uploader's reader (staff, who see
 * what the download showed): a difference refuses that change as changed in Beeline since the file was downloaded. That
 * replaces a check of the whole row's version, which could not tell a resumed row's own earlier writes from somebody
 * else's and refused every change of the row for one it did not use. A small window remains between this read and the
 * correction's own turn, since most corrections take no expected value; the method's takes its bases.
 */
async function changeRow(deps: ApplyDeps, p: Pending): Promise<Counts> {
  const m = deps.messages ?? en;
  const w = m.uploads.changes;
  const counts: Counts = {};
  const count = (k: keyof Counts) => (counts[k] = (counts[k] ?? 0) + 1);
  const all = (
    await sql<{ unit: string; outcome: string; payload: string | null; detail: string | null }>`
      SELECT unit, outcome, payload, detail FROM upload_sample_outcome WHERE upload_id = ${p.upload_id} AND row_number = ${p.row_number}
      ORDER BY ${sql.raw(UNIT_ORDER_SQL("unit"))}`.execute(deps.db)
  ).rows;
  const pending = all.filter((u) => u.outcome === "pending");
  /** Settle every change of the row still pending with one sentence, as the row cannot be worked on at all. */
  const refuseRow = async (detail: string) => {
    for (const u of pending) {
      await settle(deps.db, { upload_id: p.upload_id, row_number: p.row_number, unit: u.unit }, "refused", detail);
      count("notApplied");
    }
  };
  const sampleId = p.sample_id;
  if (sampleId === null) {
    await refuseRow(w.sampleGone);
    return counts;
  }
  if (!(await staffNow(deps, p.applied_by))) {
    await refuseRow(w.noLongerStaff);
    return counts;
  }
  const actor: Actor = { personId: p.applied_by, signedInPersonId: p.applied_by, login: p.login ?? "", staff: true, impersonating: false, via: "upload" };
  const corrective: CorrectionDeps = {
    db: deps.db,
    conn: deps.conn,
    printWriter: deps.printWriter,
    mintConn: deps.mintConn ?? deps.conn,
    correctionsPath: deps.correctionsPath,
    sampleOverlayPath: deps.sampleOverlayPath,
    samplePaths: deps.samplePaths,
    derivePaths: deps.derivePaths,
    syncJobRunning: deps.syncJobRunning ?? (() => false),
  };
  const settled = new Map(all.filter((u) => u.outcome !== "pending").map((u) => [u.unit, u.outcome]));
  // The point was saved in an earlier run, and its place was not worked out then.
  let pointDeferred = all.find((u) => u.unit === "coordinates")?.detail === w.pointDeferred;
  for (const u of pending) {
    const key = { upload_id: p.upload_id, row_number: p.row_number, unit: u.unit };
    const refuse = async (detail: string) => {
      await settle(deps.db, key, "refused", detail);
      settled.set(u.unit, "refused");
      count("notApplied");
    };
    const queued = readQueuedUnit(u.payload);
    if ("unreadable" in queued) {
      await refuse(w.rowUnreadable(queued.unreadable));
      continue;
    }
    // A change begun is not cut off, but none begins once the process is stopping.
    if (deps.signal?.aborted) throw new JobInterrupted(`upload ${p.upload_id} row ${p.row_number}`);
    // The place follows a point just set, so what the point wrote there is not somebody else's change: that change is skipped below.
    if (!(u.unit === "area" && settled.get("coordinates") === "applied")) {
      const now = (await readNow(deps.db, [sampleId], STAFF_READER)).get(sampleId);
      if (now === undefined) {
        await refuse(w.sampleGone);
        continue;
      }
      const differs = queued.cells.find((c) => (now.cells.get(c.column) ?? "") !== c.was);
      // Already as the file says (the correction committed and its outcome was lost, or staff made the same change by hand): nothing to do.
      if (differs !== undefined && queued.cells.every((c) => (now.cells.get(c.column) ?? "").toLowerCase() === c.fileSays.toLowerCase())) {
        await settle(deps.db, key, "unchanged", null);
        settled.set(u.unit, "unchanged");
        count("unchanged");
        continue;
      }
      if (differs !== undefined) {
        // A change that stopped as recorded and not applied, and then found the sample changed: the file holds an event the store never got.
        const earlier = u.detail === w.notAppliedPending ? ` ${w.notAppliedRefused}` : "";
        await refuse(w.changedSince(differs.column, now.cells.get(differs.column) ?? "") + earlier);
        continue;
      }
    }
    const result = await applyUnit({ corrective, messages: m, today: deps.today?.() ?? oregonToday() }, { sampleId, note: historyReason(p.upload_id), actor, settled, pointDeferred }, queued.change);
    if (result.outcome === "stop") {
      // For a sample with old records, the corrections file holds the change and the store does not, except for the
      // Method form's change, which puts its file rows back (src/app/sample-method.ts): nothing was kept.
      if (result.why === "not_applied") await noteOn(deps.db, key, u.unit !== "method_dates" && (await fromOldRecords(deps.db, sampleId)) ? w.notAppliedPending : w.notAppliedNothingKept);
      throw new UnitNotDone(`upload ${p.upload_id} row ${p.row_number} ${u.unit} was not done: ${result.why}`);
    }
    // Settled as made before anything that follows it, so a follow-up that fails cannot leave a change half done.
    await settle(deps.db, key, result.outcome, "detail" in result ? (result.detail ?? null) : null);
    settled.set(u.unit, result.outcome);
    if (result.outcome === "applied" && u.unit === "coordinates") pointDeferred = result.deferred === true;
    count(result.outcome === "refused" ? "notApplied" : result.outcome);
    if (result.outcome === "applied" && result.followUp !== undefined) {
      const said = await result.followUp();
      if (said !== null) await noteOn(deps.db, key, [result.detail, said].filter((x) => x !== undefined && x !== "").join(" "));
    }
  }
  return counts;
}

/**
 * How much one run does before it ends: this many rows or this long, whichever comes first. The scheduler runs one job at
 * a time, so a run that held it until the queue was empty would keep the nightly, the backup and the exports waiting; the
 * rows left stay pending, and the scheduler's tick resumes them, after any clock job that is due.
 */
export const APPLY_ROW_LIMIT = 200;
export const APPLY_TIME_LIMIT_MS = 5 * 60_000;

export interface ApplyResult {
  created: number;
  refused: number;
  skipped: number;
  /** Rows the job stopped on, one for each upload stopped. */
  stopped: number;
  /**
   * Changes to existing samples that were made, and that were already as the file says. A count of units, kept only
   * once there is one to count, so that a run that only makes trap samples says what it always did.
   */
  applied?: number;
  unchanged?: number;
  /** Changes to existing samples a correction refused or the job found changed since the download, counted apart from the new rows refused (`refused`). */
  notApplied?: number;
}

/**
 * Work through the pending rows, in upload and file order, one row a step, until none is left. The framework stops
 * it at a row boundary when the process is asked to shut down; what is left stays pending and unmarked, and the
 * scheduler starts the job again when the process is back (`applyWaiting`). A row is recorded as refused only for a
 * problem the code recognises (the trap form's checks, a number taken, a look-alike, the number's shape). An error
 * nobody foresaw is not stepped over: it leaves the row pending, marks the upload stopped at that row
 * (`upload_applied.stopped_row`, no error text), logs the upload and row, goes on with other uploads, and at the end
 * throws the error, so the run fails and is reported. The scheduler does not restart a stopped upload: staff choose
 * Try again on its page. Only the abort signal being set, or `JobInterrupted`, is a shutdown.
 */
export async function applyPending(deps: ApplyDeps): Promise<ApplyResult> {
  const step = deps.step ?? ((_label, fn) => fn());
  const result: ApplyResult = { created: 0, refused: 0, skipped: 0, stopped: 0 };
  let failure: unknown;
  const now = deps.limits?.now ?? (() => Date.now());
  const rowLimit = deps.limits?.rows ?? APPLY_ROW_LIMIT;
  const endsAt = now() + (deps.limits?.ms ?? APPLY_TIME_LIMIT_MS);
  let done = 0;
  for (;;) {
    // A bounded run: the rest stays pending for the next.
    const next = done >= rowLimit || now() >= endsAt ? undefined : await nextPending(deps.db);
    if (next === undefined) {
      if (failure !== undefined) throw failure;
      return result;
    }
    const done_ = await step(`upload ${next.upload_id} row ${next.row_number}`, async (): Promise<Counts> => {
      try {
        if (next.unit !== ROW_UNIT) return await changeRow(deps, next);
        const made = await createRow(deps, next);
        return { [made.outcome]: 1 };
      } catch (err) {
        // A shutdown is the signal being set, or the framework's own interruption: the row stays pending and unmarked.
        if (deps.signal?.aborted || err instanceof JobInterrupted) throw err;
        console.error(`[apply-uploads] upload ${next.upload_id} row ${next.row_number} failed, so this upload is stopped: ${(err as Error).stack ?? String(err)}`);
        await stopUpload(deps.db, next.upload_id, next.row_number);
        failure ??= err;
        return { stopped: 1 };
      }
    });
    for (const [kind, n] of Object.entries(done_) as Array<[keyof Counts, number]>) result[kind] = (result[kind] ?? 0) + n;
    done++;
    await deps.afterRow?.({ uploadId: next.upload_id, row: next.row_number });
  }
}

/** What the job says it did, for the run's detail. */
export const describeApply = (r: ApplyResult) => {
  const changed = (r.applied ?? 0) + (r.unchanged ?? 0);
  const notApplied = r.notApplied ?? 0;
  return r.created + r.refused + r.skipped + r.stopped + changed + notApplied === 0
    ? "nothing was waiting"
    : `${r.created} trap sample(s) created, ${changed + notApplied > 0 ? `${r.applied ?? 0} change(s) applied, ${r.unchanged ?? 0} already as the file says, ${notApplied} change(s) not applied, ` : ""}${r.refused} row(s) refused, ${r.skipped} left alone`;
};
