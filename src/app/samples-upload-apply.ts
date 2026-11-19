import { createHash } from "node:crypto";
import type { DuckDBConnection } from "@duckdb/node-api";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { AUTO_NUMBER_PLACEHOLDER, checkTrapSample, createTrapSample, findLookalikes, numberTakenProblem, seriesNumberHeldProblem, seriesNumberHolder, seriesNumberProblem, type TrapSampleForm } from "../trap-sample.js";
import { JobInterrupted } from "./jobs/framework.js";
import type { CorrectionDeps } from "./sample-corrections.js";
import { recordTrapChanges } from "./sample-corrections.js";
import { onSample } from "./sample-queue.js";
import { isHeld, type NewRowCreate, type SampleRowResult, type SamplesPlan } from "./samples-upload-plan.js";

/**
 * Applying a staff member's samples file (beeline-kgyd.4.10): what the page offers, what the claim writes, and the
 * job that works through the rows. See docs/architecture/loading-an-edited-download.md.
 *
 * Applying is two steps. The request works the plan out again, checks it is the plan the page showed, and in one
 * transaction claims the upload (`upload_applied`) and queues one `pending` row in `upload_sample_outcome` for each
 * row to do, with exactly what to write. Then the `apply-uploads` job works through the pending rows in file order,
 * one row at a time, and records each outcome. Everything the job needs is in the queued rows, so it does not read
 * the file, and a restart finds what is left to do. Only whole new rows exist so far (unit `row`); the changes to
 * an existing sample's groups of cells are queued as further units, which the job dispatches on.
 */

/** The job's name, in the registry and on the Jobs page. */
export const APPLY_JOB = "apply-uploads";

/** The unit of a whole new row. A group of cells of an existing sample is queued under the name of its group. */
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

/**
 * A digest of what the page offered: every new row that could be made, its row number and every value making it
 * would write (the person ids its collectors came to included), and for a held row the sample it looks like. A tick
 * is the person's own answer and is not in it: the page's form carries this, and applying refuses if the plan worked
 * out again gives another.
 */
export function digestOf(plan: SamplesPlan): string {
  const hash = createHash("sha256");
  for (const r of plan.rows) {
    if (r.create === null) continue;
    // Held rows too, in full: a change to one between the preview and Apply refuses.
    hash.update(JSON.stringify([r.row, r.create.form, r.create.lookalike?.sampleId ?? null]));
  }
  return hash.digest("hex").slice(0, 32);
}

/**
 * The sentence for a row left alone because it looks like an existing sample, said once the file is applied, when
 * nothing can be ticked any more: the row can be uploaded again, or entered on the trap form.
 */
export const lookalikeSentence = (sampleNumber: string) =>
  `It looks like ${sampleNumber === "" ? "a sample Beeline already has" : `sample ${sampleNumber}`}: the same first collector, overlapping days and a point within 100 metres, so it was not created. To compare it with that sample, put its sampleId in the file and upload the file again (changes to existing samples are not applied yet). To make a new sample anyway, upload the row again and tick create anyway, or enter it on the trap form.`;

/** The sentence for a row left alone because its number is in the OBAS series and the numbers were not confirmed. */
export const obasSentence =
  "Its number is in the OBAS series, or blank so that it would be given the next one, and a person has to confirm the series' numbers: the box \"I've checked these OBAS numbers\" was not ticked, so it was not created. To make it, upload the file again and tick the box.";

/** Why a held row was left alone, in the sentences of each tick it was waiting for. */
const heldSentence = (create: NewRowCreate): string =>
  [create.lookalike !== null && !create.anyway ? lookalikeSentence(create.lookalike.sampleNumber) : null, create.obas && !create.obasChecked ? obasSentence : null].filter((x) => x !== null).join(" ");

/**
 * Claim the upload and queue its rows, in one transaction. False if the upload was claimed already, which its key
 * decides: two submissions of one page cannot both queue the rows.
 */
export async function claimUpload(
  db: Kysely<Database>,
  claim: { uploadId: number; appliedBy: number; plan: SamplesPlan; now: Date },
): Promise<{ queued: number; held: number } | null> {
  const todo = rowsToApply(claim.plan);
  const held = rowsHeld(claim.plan);
  const at = claim.now.toISOString();
  try {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("upload_applied")
        .values({ upload_id: claim.uploadId, applied_by: claim.appliedBy, applied_at: at, draft_count: todo.length })
        .execute();
      const rows = [
        ...todo.map((r) => ({ r, outcome: "pending" as const, detail: null as string | null, payload: JSON.stringify({ form: r.create.form, anyway: r.create.anyway } satisfies QueuedRow) })),
        ...held.map((r) => ({ r, outcome: "skipped" as const, detail: heldSentence(r.create), payload: null })),
      ];
      for (const { r, outcome, detail, payload } of rows) {
        await trx
          .insertInto("upload_sample_outcome")
          .values({
            upload_id: claim.uploadId,
            row_number: r.row,
            unit: ROW_UNIT,
            outcome,
            sample_id: null,
            sample_number: r.create.form.sample_number,
            payload,
            detail,
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
  return { queued: todo.length, held: held.length };
}

export interface OutcomeRow {
  row_number: number;
  unit: string;
  outcome: "pending" | "created" | "applied" | "unchanged" | "refused" | "skipped";
  sample_id: number | null;
  sample_number: string | null;
  detail: string | null;
  /** The sample was made and has since been deleted (`sample_deletion`). */
  deleted: boolean;
}

/** What applying did to each row of an upload so far, in file order. */
export async function readOutcomes(db: Kysely<Database>, uploadId: number): Promise<OutcomeRow[]> {
  const found = await sql<Omit<OutcomeRow, "deleted"> & { deleted: boolean }>`
    SELECT o.row_number, o.unit, o.outcome, o.sample_id, o.sample_number, o.detail,
           (o.outcome = 'created'
            AND NOT EXISTS (SELECT 1 FROM sample s WHERE s.entity_id = o.sample_id)
            AND EXISTS (SELECT 1 FROM sample_deletion d WHERE d.sample_id = o.sample_id)) AS deleted
    FROM upload_sample_outcome o
    WHERE o.upload_id = ${uploadId}
    ORDER BY o.row_number, o.unit`.execute(db);
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
  await sql`UPDATE upload_applied SET stopped_at = now(), stopped_row = ${row} WHERE upload_id = ${uploadId}`.execute(db);
}

/** Staff chose Try again: the mark is cleared, and the upload's pending rows wait for the job once more. */
export async function clearStopped(db: Kysely<Database>, uploadId: number): Promise<void> {
  await sql`UPDATE upload_applied SET stopped_at = NULL, stopped_row = NULL WHERE upload_id = ${uploadId}`.execute(db);
}

export interface ApplyDeps {
  db: Kysely<Database>;
  /** Reads the store. */
  conn: DuckDBConnection;
  /** The print runs' connection, which every write of a trap sample goes through (src/trap-sample.ts). */
  printWriter: DuckDBConnection;
  samplePaths: CorrectionDeps["samplePaths"];
  /**
   * The job's abort signal: set when the process is being stopped. No creation begins once it is, and an error met
   * with it set is the stop and not a fault of the row.
   */
  signal?: AbortSignal;
  /** Runs one unit of work as a step of the job (the framework's), so a shutdown stops the job between rows. */
  step?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  /** Tests only: told after each row is done. */
  afterRow?: (row: { uploadId: number; row: number }) => void | Promise<void>;
}

interface Pending {
  upload_id: number;
  row_number: number;
  unit: string;
  sample_number: string | null;
  payload: string | null;
  applied_by: number;
  login: string | null;
}

async function nextPending(db: Kysely<Database>): Promise<Pending | undefined> {
  const found = await sql<Pending>`
    SELECT o.upload_id, o.row_number, o.unit, o.sample_number, o.payload, a.applied_by,
           (SELECT min(i.login) FROM inat_account i WHERE i.person_id = a.applied_by) AS login
    FROM upload_sample_outcome o
    JOIN upload_applied a ON a.upload_id = o.upload_id
    WHERE o.outcome = 'pending' AND a.stopped_at IS NULL
    ORDER BY o.upload_id, o.row_number, o.unit
    LIMIT 1`.execute(db);
  return found.rows[0];
}

/** Record how a queued row ended, when no sample is made with it. */
async function settle(db: Kysely<Database>, p: Pending, outcome: "refused" | "skipped" | "unchanged", detail: string): Promise<void> {
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

/** Samples made and not yet entered in the history, which are entered together under one author and reason. */
interface Unrecorded {
  uploadId: number;
  login: string;
  ids: number[];
  /** Each new sample's queue turn is held from its creation until it is in the history: these let them go. */
  releases: Array<() => void>;
}

/**
 * How many samples are entered in the history in one pass. A pass over one sample rewrites the whole snapshot file,
 * which on a copy of production (11 MB) took 0.67 s of the 0.7 s a row took; twenty-five at a time it is shared.
 * A crash loses the entry of at most this many samples, which the next full pass writes under `reconcile` instead,
 * without the author and the reason.
 */
export const HISTORY_BATCH = 25;

/**
 * Enter the samples made so far in the history, in one pass. Each sample's queue turn has been held since it was
 * made (createRow), so no edit of it can have been made, or recorded, in the gap before this pass reads it: an edit
 * waits for its turn and is recorded under its own author after this entry. The turns are let go when the pass ends,
 * whether or not it wrote.
 */
async function recordMade(deps: ApplyDeps, pending: Unrecorded | null): Promise<void> {
  if (pending === null || pending.ids.length === 0) return;
  const ids = [...pending.ids];
  const releases = [...pending.releases];
  pending.ids.length = 0;
  pending.releases.length = 0;
  try {
    await recordTrapChanges(deps, pending.login, ids, { source: "upload", created: true, reason: historyReason(pending.uploadId) });
  } finally {
    for (const release of releases) release();
  }
}

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

/** Make one trap sample from a queued row, or say why not. */
async function createRow(deps: ApplyDeps, p: Pending): Promise<{ outcome: "created"; id: number; release: () => void } | { outcome: "refused" | "skipped" }> {
  const queued = readQueued(p.payload);
  if ("unreadable" in queued) {
    await settle(deps.db, p, "refused", `What was queued for this row cannot be read (${queued.unreadable}), so it was not created.`);
    return { outcome: "refused" };
  }
  // A blank number is given the next in the series under the print runs' lock when the sample is made, so the form's own
  // checks run with a stand-in.
  const auto = queued.form.sample_number === "";
  // The trap form's own check, again, with the ids the collectors came to.
  const checked = await checkTrapSample(deps.conn, auto ? { ...queued.form, sample_number: AUTO_NUMBER_PLACEHOLDER } : queued.form, null);
  if ("problems" in checked) {
    await settle(deps.db, p, "refused", Object.values(checked.problems).join(" "));
    return { outcome: "refused" };
  }
  const sample = checked.sample;
  // The number's shape, and a series number any other sample has (of any kind), again: the store may have changed.
  if (!auto) {
    const holder = await seriesNumberHolder(deps.conn, sample.sample_number);
    const wrong = seriesNumberProblem(sample.sample_number) ?? (holder === null ? null : seriesNumberHeldProblem(sample.sample_number, holder));
    if (wrong !== null) {
      await settle(deps.db, p, "refused", wrong);
      return { outcome: "refused" };
    }
  }
  // Not the samples this same upload has made: its rows are the file's own, and two traps at one site on the same days
  // are two samples. Asked now to skip the row cheaply, and again in the creating transaction, under the print runs'
  // lock, where a trap form entry committed meanwhile is caught.
  const lookalike = async (conn: DuckDBConnection, except?: number) => {
    const [found] = await findLookalikes(
      conn,
      {
        firstCollectorId: sample.collector_ids[0]!,
        dateStart: sample.date_start,
        dateEnd: sample.date_end,
        latitude: sample.latitude,
        longitude: sample.longitude,
      },
      { sampleId: except, uploadId: p.upload_id },
    );
    return found;
  };
  if (!queued.anyway) {
    const like = await lookalike(deps.conn);
    if (like !== undefined) {
      await settle(deps.db, p, "skipped", lookalikeSentence(like.sampleNumber));
      return { outcome: "skipped" };
    }
  }
  // No creation begins once the process is stopping: its transaction is on the print connection, which a stop does not
  // interrupt, since a print run shares it.
  if (deps.signal?.aborted) throw new JobInterrupted(`making ${sample.sample_number}`);
  // The outcome is written in the sample's own transaction, so a crash cannot leave a sample that no row names.
  // Its queue turn is taken here, before the sample is visible to anyone, and held until the history pass has read it.
  let release: (() => void) | undefined;
  const made = await createTrapSample(deps.printWriter, sample, p.applied_by, async (id, number) => {
    // The sample is in this transaction already, so it is not its own look-alike. One found aborts the transaction.
    if (!queued.anyway) {
      const like = await lookalike(deps.printWriter, id);
      if (like !== undefined) throw new LookalikeFound(like.sampleNumber);
    }
    const gate = new Promise<void>((resolve) => (release = resolve));
    void onSample(id, () => gate);
    await deps.printWriter.run(
      `UPDATE upload_sample_outcome SET outcome = 'created', sample_id = $1, sample_number = $5, detail = NULL, recorded_at = now()
       WHERE upload_id = $2 AND row_number = $3 AND unit = $4`,
      [id, p.upload_id, p.row_number, p.unit, number] as never,
    );
  }, { autoNumber: auto, anyKind: true }).catch(async (err: unknown) => {
    // The transaction was rolled back, so the sample does not exist; its turn is let go.
    release?.();
    if (err instanceof LookalikeFound) {
      await settle(deps.db, p, "skipped", lookalikeSentence(err.sampleNumber));
      return "skipped" as const;
    }
    throw err;
  });
  if (made === "skipped") return { outcome: "skipped" };
  if (made === "taken") {
    const holder = auto ? null : await seriesNumberHolder(deps.conn, sample.sample_number);
    await settle(deps.db, p, "refused", auto ? "The next number in the series was taken while it was being given, so the row was not created." : holder === null ? numberTakenProblem(sample.sample_number) : seriesNumberHeldProblem(sample.sample_number, holder));
    return { outcome: "refused" };
  }
  return { outcome: "created", id: made, release: release! };
}

export interface ApplyResult {
  created: number;
  refused: number;
  skipped: number;
  /** Rows the job stopped on, one for each upload stopped. */
  stopped: number;
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
  let unrecorded: Unrecorded | null = null;
  let failure: unknown;
  try {
    for (;;) {
      const next = await nextPending(deps.db);
      // The samples made so far are entered before the work changes hands to another upload or author.
      if (unrecorded !== null && (next === undefined || next.upload_id !== unrecorded.uploadId)) {
        await recordMade(deps, unrecorded);
        unrecorded = null;
      }
      if (next === undefined) {
        if (failure !== undefined) throw failure;
        return result;
      }
      const done = await step(`upload ${next.upload_id} row ${next.row_number}`, async (): Promise<Awaited<ReturnType<typeof createRow>> | { outcome: "stopped" }> => {
        try {
          if (next.unit === ROW_UNIT) return await createRow(deps, next);
          await settle(deps.db, next, "refused", `Beeline does not apply a ${next.unit} change yet.`);
          return { outcome: "refused" };
        } catch (err) {
          // A shutdown is the signal being set, or the framework's own interruption: the row stays pending and unmarked.
          if (deps.signal?.aborted || err instanceof JobInterrupted) throw err;
          console.error(`[apply-uploads] upload ${next.upload_id} row ${next.row_number} failed, so this upload is stopped: ${(err as Error).stack ?? String(err)}`);
          await stopUpload(deps.db, next.upload_id, next.row_number);
          failure ??= err;
          return { outcome: "stopped" };
        }
      });
      result[done.outcome]++;
      if (done.outcome === "created") {
        unrecorded ??= { uploadId: next.upload_id, login: next.login ?? "", ids: [], releases: [] };
        unrecorded.ids.push(done.id);
        unrecorded.releases.push(done.release);
        if (unrecorded.ids.length >= HISTORY_BATCH) await recordMade(deps, unrecorded);
      }
      await deps.afterRow?.({ uploadId: next.upload_id, row: next.row_number });
    }
  } finally {
    // Also when the job is stopped between rows: what was made is entered before it ends.
    await recordMade(deps, unrecorded);
  }
}

/** What the job says it did, for the run's detail. */
export const describeApply = (r: ApplyResult) =>
  r.created + r.refused + r.skipped + r.stopped === 0
    ? "nothing was waiting"
    : `${r.created} trap sample(s) created, ${r.refused} row(s) refused, ${r.skipped} left alone`;
