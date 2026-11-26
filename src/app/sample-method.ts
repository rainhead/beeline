import { sql, type Kysely } from "kysely";
import { correctionKey, readCorrectionRows, restoreCorrections, upsertCorrections, type CorrectionEvent } from "../corrections.js";
import type { Database } from "../model.js";
import { mirrorCorrections } from "./correction-store.js";
import { methodCodesSql } from "../trap-sample.js";
import { liveEndOf } from "../live-end.js";
import { setSampleMethodRow } from "../sample-method-row.js";
import { isWriteConflict } from "../write-conflict.js";

/**
 * Staff correcting how a sample was collected, from the Method row of its
 * page (beeline-p8y1): the method's words and the day collecting ended.
 *
 * For a sample built from the old Beeline's records, whether or not it has an
 * iNaturalist observation. Those records are what the correction names, as
 * the collector's own edit does (src/app/sample-edit.ts, ADR 0004): one event
 * per record and field, written to the corrections overlay before the live
 * sample changes. The nightly iNaturalist sync never rewrites a printed
 * sample's dates or any linked sample's method, so the change stays.
 *
 * The case it was made for: the old Beeline printed some trap samples twice,
 * once from the iNaturalist observation with its default "aerial net", and
 * promotion kept that copy, so Beeline published Pat Wheeler's six trap
 * samples of 2021 as netted on one day (beeline-iuva).
 *
 * The method is chosen from the list (`method`, schema/031): the code is what is written, as the method as written (for
 * a sample from old records, as the corrected text of every record) and as the sample's method (`sample_method`), in
 * the same transaction. The sample's kind follows the method (`setSampleMethodRow`), and the dates are the dates: an end
 * is a date range whatever the method, and a blank end means one day, for every sample (beeline-ni5m.15, stage three).
 * Each old record is written only where the new value differs from its own, so a one-day sample whose records state no
 * end gains none.
 *
 * The start date is editable where iNaturalist does not hold it: on a sample
 * with no observation (Peter, 2026-11-15, beeline-0wbq), and on one whose
 * labels are printed (beeline-qu2c). Until they print, a one-day sample's
 * date follows its observation (ingest/mint-samples.sql), so a correction
 * made here would be undone by the next nightly, and it is refused with a
 * sentence saying to correct the date on iNaturalist. A printed sample's date
 * never follows, and an observation edited after printing may describe
 * another sample, so staff may correct the date and the labels printed with
 * the old one are reprinted as for any corrected field. Promotion groups
 * old records into samples by their start date, so a corrected start moves
 * every record of the sample together, and a development store rebuilt from
 * the corrections makes the same sample, or merges it into another of the
 * collector's with that number and day, which is then what the records say.
 * Production is never promoted again (ADR 0006).
 *
 * A trap sample entered in Beeline has no old records to name. It is edited
 * on its own form (src/trap-sample.ts) until its labels print or are frozen
 * into a run; after that, this form changes its method and dates on the
 * sample directly, and it stays a trap sample whatever the end date.
 */

export interface MethodInput {
  /**
   * The method as it stands in the form: the code of a listed method ("pan trap"), or, for a sample whose method as
   * written is not a code, that text unchanged ("pantrap"), which is not a change. A different text must be the code of
   * a listed method, and for a sample entered in Beeline of a method that is a trap (beeline-ni5m.15).
   */
  protocol: string;
  /** The day collecting ended, YYYY-MM-DD; blank for a net sample collected on one day. */
  dateEnd: string;
  /** The day collecting started, YYYY-MM-DD; absent where the form did not offer it. */
  dateStart?: string;
  note: string;
  /** iNat login of whoever is signed in — never the person acted for. */
  author: string;
  /** Today, YYYY-MM-DD, where the program is: an end date cannot be later. */
  today: string;
  /**
   * The values the form showed (hidden base:* fields). A field submitted as
   * it was shown was not touched, so a form left open cannot put back what
   * someone saved since; a touched field whose base is no longer the
   * sample's is refused rather than written over the newer correction
   * (beeline-0br, as on the collector's form).
   */
  bases?: { protocol?: string; dateEnd?: string; dateStart?: string };
}

export type MethodResult =
  | { outcome: "saved" }
  | { outcome: "unchanged" }
  | {
      outcome: "invalid";
      problem: "date" | "start_date" | "before_start" | "future" | "start_future" | "start_observation" | "method_required" | "unlisted_method";
      /** For `unlisted_method`: the codes of the methods that may be chosen. */
      methods?: string[];
    }
  /** Someone changed a field this form touched since it was opened. */
  | { outcome: "conflict" }
  /** No old record behind this sample: nothing durable to name. */
  | { outcome: "no_old_records" }
  /**
   * The store write lost a write conflict. The file rows this save wrote are put back, so nothing was kept anywhere
   * (a sample entered in Beeline is written directly, with no events), and the change is applied only by saving it
   * again. If putting them back fails too, the file still holds them and the failure is logged.
   */
  | { outcome: "not_applied" };

interface Member {
  _id: string;
  samplingProtocol: string | null;
  day: string | null;
  month: string | null;
  year: string | null;
  day2: string | null;
  month2: string | null;
  year2: string | null;
}

/** The codes of the methods that may be chosen: all, or with `trapOnly` those whose device is set out and collected later. */
export async function readMethodCodes(db: Kysely<Database>, { trapOnly = false }: { trapOnly?: boolean } = {}): Promise<string[]> {
  const found = await sql<{ code: string }>`${sql.raw(methodCodesSql(trapOnly))}`.execute(db);
  return found.rows.map((r) => r.code);
}

/**
 * Change a sample's method to `code`, in the caller's transaction. The sample's trap count (`sample_method.trap_count`)
 * stays where the new method is a trap and goes where it is not; a sample with no method row gets one with no count.
 * The caller writes `sample.protocol`. `setSampleMethodRow` does the writing, and the old effort column with it.
 */
export async function changeSampleMethod(trx: Kysely<Database>, sampleId: number, code: string): Promise<void> {
  const row = await trx.selectFrom("sample_method").where("sample_id", "=", sampleId).select("trap_count").executeTakeFirst();
  await setSampleMethodRow(trx, sampleId, code, row?.trap_count ?? null);
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);


/**
 * Whether the sample was built from the old Beeline's records. The table that
 * says so is legacy promotion's (ingest/promote-legacy.sql), not the schema's,
 * so a store nothing was ever promoted into has none, and the answer is no.
 */
export async function fromOldRecords(db: Kysely<Database>, sampleId: number): Promise<boolean> {
  const table = await sql<{ n: bigint }>`
    SELECT count(*) AS n FROM duckdb_tables() WHERE table_name = 'legacy_specimen_number' AND NOT temporary`.execute(db);
  if (Number(table.rows[0]?.n ?? 0) === 0) return false;
  const found = await sql<{ e: boolean }>`
    SELECT EXISTS (SELECT 1 FROM legacy_specimen_number WHERE sample_id = ${sampleId}) AS e`.execute(db);
  return Boolean(found.rows[0]?.e);
}

/** Whether a label of the sample is on paper (`printed_sample`, schema/101). */
export async function isPrinted(db: Kysely<Database>, sampleId: number): Promise<boolean> {
  const found = await sql<{ e: boolean }>`SELECT EXISTS (SELECT 1 FROM printed_sample WHERE sample_id = ${sampleId}) AS e`.execute(db);
  return Boolean(found.rows[0]?.e);
}

/**
 * Whether the nightly would put this sample's start date back to its observation's: a sample of one day, not printed,
 * whose observation no other sample cites and that is not one of several claiming the
 * sample (the conditions of the date follow in ingest/mint-samples.sql). Where it is true a staff correction would be
 * undone, so it is refused (beeline-qu2c); where it is false the nightly leaves the date alone and staff may correct it.
 * The one place the gate, the sample page and the samples upload ask.
 */
export async function dateFollowsObservation(db: Kysely<Database>, sampleId: number): Promise<boolean> {
  const found = await sql<{ e: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM sample s
      WHERE s.entity_id = ${sampleId}
        AND s.inat_observation_id IS NOT NULL
        AND s.date_end = s.date_start
        AND NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)
        AND NOT EXISTS (SELECT 1 FROM sample o WHERE o.inat_observation_id = s.inat_observation_id AND o.entity_id <> s.entity_id)
        AND NOT EXISTS (SELECT 1 FROM sample_several_observations m WHERE m.sample_id = s.entity_id)) AS e`.execute(db);
  return Boolean(found.rows[0]?.e);
}

/**
 * Whether a save that writes `start` and `end` to the sample would be undone by the nightly, so that it is refused
 * (beeline-qu2c). Judged on the dates being written, not the ones stored: a range saved as one day becomes a sample the
 * nightly follows. It is undone when the resulting state is a single day of an unprinted sample whose observation no
 * other sample cites and that `sample_several_observations` does not list, unless that day is the observation's own
 * (then nothing reverts it). A save that leaves the dates as they are writes none, so loses nothing.
 */
export async function datesWouldBeReverted(db: Kysely<Database>, sampleId: number, start: string, end: string): Promise<boolean> {
  // A date that does not read as one is refused elsewhere.
  if (end !== start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return false;
  const found = await sql<{ e: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM sample s
      WHERE s.entity_id = ${sampleId}
        AND s.inat_observation_id IS NOT NULL
        AND (s.date_start <> TRY_CAST(${start} AS DATE) OR s.date_end <> TRY_CAST(${end} AS DATE))
        AND NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)
        AND NOT EXISTS (SELECT 1 FROM sample o WHERE o.inat_observation_id = s.inat_observation_id AND o.entity_id <> s.entity_id)
        AND NOT EXISTS (SELECT 1 FROM sample_several_observations m WHERE m.sample_id = s.entity_id)
        AND NOT EXISTS (SELECT 1 FROM observation_sample_candidate c
                        WHERE c.inat_id = s.inat_observation_id AND c.observed_on = TRY_CAST(${start} AS DATE))) AS e`.execute(db);
  return Boolean(found.rows[0]?.e);
}

/**
 * Whether a sample with an observation and no old records or entry is written directly: once its labels are printed,
 * or while its date does not follow the observation. The one definition the save and the samples upload's preview ask.
 */
export async function editsDirectly(db: Kysely<Database>, sampleId: number): Promise<boolean> {
  return (await isPrinted(db, sampleId)) || !(await dateFollowsObservation(db, sampleId));
}

/** Callers run it inside `onSample` (src/app/sample-queue.ts), with the change log after it. */
export async function setSampleMethod(
  db: Kysely<Database>,
  correctionsPath: string,
  sampleId: number,
  input: MethodInput,
): Promise<MethodResult> {
  const sample = await db
    .selectFrom("sample")
    .where("entity_id", "=", sampleId)
    .select(["entity_id", "protocol", "date_start", "date_end", "inat_observation_id"])
    .executeTakeFirst();
  if (sample === undefined) return { outcome: "no_old_records" };

  // What the form would show for this sample now.
  // Trimmed, as the form's values are: promotion stores the old records'
  // words as written, and a stray space would refuse every save as stale.
  const liveStart = isoDate(sample.date_start);
  const liveProtocol = (sample.protocol ?? "").trim();
  // A one-day sample shows no end: a blank end means one day, whatever the sample's method.
  const liveEnd = liveEndOf(sample.date_start, sample.date_end);
  const touched = (submitted: string, base: string | undefined, live: string) =>
    base === undefined ? submitted !== live : submitted !== base.trim();
  const stale = (isTouched: boolean, base: string | undefined, live: string) =>
    isTouched && base !== undefined && base.trim() !== live;
  const protocolIn = input.protocol.trim();
  const endIn = input.dateEnd.trim();
  const startIn = input.dateStart?.trim();
  const protocolTouched = touched(protocolIn, input.bases?.protocol, liveProtocol);
  const endTouched = touched(endIn, input.bases?.dateEnd, liveEnd);
  const startTouched = startIn !== undefined && touched(startIn, input.bases?.dateStart, liveStart);
  if (
    stale(protocolTouched, input.bases?.protocol, liveProtocol) ||
    stale(endTouched, input.bases?.dateEnd, liveEnd) ||
    stale(startTouched, input.bases?.dateStart, liveStart)
  ) {
    return { outcome: "conflict" };
  }
  // iNaturalist holds the start of a sample whose date the nightly would put back (ingest/mint-samples.sql). Where it
  // would not (labels printed, a range, a shared or multiply claimed observation) staff may correct it (beeline-qu2c).
  // A date that does not read back as written does not exist (30 February).
  const readable = (d: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const parsed = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
  };
  const start = startTouched ? startIn! : liveStart;
  if (!readable(start)) return { outcome: "invalid", problem: "start_date" };
  if (start > input.today) return { outcome: "invalid", problem: "start_future" };
  const dateEnd = endTouched ? endIn : liveEnd;
  if (dateEnd !== "" && !readable(dateEnd)) return { outcome: "invalid", problem: "date" };
  if (dateEnd !== "" && dateEnd < start) return { outcome: "invalid", problem: "before_start" };
  if (dateEnd !== "" && dateEnd > input.today) return { outcome: "invalid", problem: "future" };

  // iNaturalist holds the dates the nightly would put back (ingest/mint-samples.sql), judged on the dates this save
  // writes: a range saved as one day is followed from the next night, and the correction would be lost. Where the
  // resulting state is one the nightly leaves alone (labels printed, a range, a shared or multiply claimed observation,
  // or the observation's own day) staff may correct it (beeline-qu2c).
  const linked = sample.inat_observation_id !== null;
  if (linked && (await datesWouldBeReverted(db, sampleId, start, dateEnd === "" ? start : dateEnd))) {
    return { outcome: "invalid", problem: "start_observation" };
  }
  const oldRecords = await fromOldRecords(db, sampleId);
  const entered =
    !oldRecords &&
    (await db.selectFrom("sample_entry").where("sample_id", "=", sampleId).select("sample_id").executeTakeFirst()) !== undefined;
  // A sample Beeline made from an observation and printed has neither old records nor an entry. Like an entered one it
  // is written directly: there is nothing older to name, and the change log records the change (beeline-qu2c).
  const direct = entered || (!oldRecords && linked && (await editsDirectly(db, sampleId)));
  if (!oldRecords && !direct) return { outcome: "no_old_records" };

  const protocol = protocolTouched ? protocolIn : liveProtocol;
  // A method that is changed is chosen from the list, whoever the sample was entered by. A sample entered in Beeline
  // stays a trap sample whatever the dates, so it may be given only a method that is a trap; an old sample may be given
  // any, as it could be given any words before. The unchanged text of a sample is never a change, so it is not checked.
  if (protocolTouched) {
    const offered = await readMethodCodes(db, { trapOnly: entered });
    if (!offered.includes(protocol)) return { outcome: "invalid", problem: "unlisted_method", methods: offered };
  }
  // The trap form never makes a trap sample without its method, and the
  // effort it writes holds the trap count beside it, so neither is lost here.
  if (entered && protocol === "") return { outcome: "invalid", problem: "method_required" };
  // The sample's kind is its method's, set by changeSampleMethod: the dates decide nothing but themselves.
  const end = dateEnd === "" ? start : dateEnd;
  const protocolChanged = protocol !== liveProtocol;
  const startChanged = start !== liveStart;
  // One day is decided by the dates, not by a blank input: an end typed equal to the start is one day too.
  const oneDay = end === start;
  const endChanged = end !== isoDate(sample.date_end);
  // A one-day sample's end is its start, so a new start moves it too.
  const datesChanged = startChanged || endChanged;
  if (!protocolChanged && !datesChanged) return { outcome: "unchanged" };
  const update = {
    ...(protocolChanged ? { protocol: protocol === "" ? null : protocol } : {}),
    ...(datesChanged ? { date_start: start, date_end: end } : {}),
  };
  if (direct) {
    try {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("sample").set(update).where("entity_id", "=", sampleId).execute();
        if (protocolChanged) await changeSampleMethod(trx, sampleId, protocol);
      });
    } catch (err) {
      // Nothing was kept anywhere, so saving again is all that is needed.
      if (isWriteConflict(err)) return { outcome: "not_applied" };
      throw err;
    }
    return { outcome: "saved" };
  }

  const members = (
    await sql<Member>`
      SELECT o._id, o."samplingProtocol" AS "samplingProtocol", o.day, o.month, o.year, o.day2, o.month2, o.year2
      FROM legacy_specimen_number n
      JOIN legacy_occurrence o ON o._id = n._id
      WHERE n.sample_id = ${sampleId}
    `.execute(db)
  ).rows;
  if (members.length === 0) return { outcome: "no_old_records" };
  // What each record says now, as the export reads it: its staged value with every correction over it.
  const FIELDS = ["samplingProtocol", "day", "month", "year", "day2", "month2", "year2"] as const;
  const view = (
    await sql<{ table_name: string }>`SELECT view_name AS table_name FROM duckdb_views() WHERE view_name = 'legacy_occurrence_corrected'`.execute(db)
  ).rows.length > 0;
  const stored = view
    ? (
        await sql<Member>`
          SELECT c._id, c."samplingProtocol" AS "samplingProtocol", c.day, c.month, c.year, c.day2, c.month2, c.year2
          FROM legacy_specimen_number n JOIN legacy_occurrence_corrected c ON c._id = n._id
          WHERE n.sample_id = ${sampleId}`.execute(db)
      ).rows
    : members;
  const storeValue = new Map<string, string>();
  for (const r of stored) for (const f of FIELDS) storeValue.set(`${r._id}|${f}`, (r[f] ?? "").toString());

  // The old records write a date as three columns, without leading zeros.
  const parts = (d: string) => d.split("-").map((p) => String(Number(p)));
  const [sy, smo, sd] = parts(start);
  const [ey, emo, ed] = oneDay ? ["", "", ""] : parts(end);
  const reason = input.note.trim() !== "" ? input.note.trim() : "edited in Beeline";
  const events: CorrectionEvent[] = [];
  const writesEnd = endChanged || (startChanged && oneDay);
  // What each field is to hold on every record, where this save sets it.
  const target: Partial<Record<(typeof FIELDS)[number], string>> = {
    ...(protocolChanged ? { samplingProtocol: protocol } : {}),
    ...(startChanged ? { day: sd!, month: smo!, year: sy! } : {}),
    // A one-day sample's end is blank on every record, as a blank end always wrote it (the legacy-format export reads
    // each record's own end), and one that spans days is the end on every record.
    ...(writesEnd ? { day2: ed!, month2: emo!, year2: ey! } : {}),
  };
  // Written only where the record's own value differs, so a record that never stated an end gains none.
  for (const member of members) {
    for (const f of FIELDS) {
      if (target[f] !== undefined && target[f] !== (storeValue.get(`${member._id}|${f}`) ?? "")) {
        events.push({ _id: member._id, field: f, base_value: (member[f] ?? "").toString(), new_value: target[f]!, author: input.author, reason });
      }
    }
  }
  // Durability before immediacy: if the event write fails, nothing applied. Should the store then refuse or fail, the
  // rows this save wrote are put back below. A crash between the file write and the store's commit still leaves the
  // file ahead of the sample, as it always did, which is what a rebuild would apply.
  // The rows the file holds for these keys now, to put back if the store does not take the save.
  const ids = new Set(members.map((m) => m._id));
  const was = new Map<string, CorrectionEvent | null>(events.map((e) => [correctionKey(e), null]));
  for (const row of await readCorrectionRows(correctionsPath, ids)) if (was.has(correctionKey(row))) was.set(correctionKey(row), row);
  await upsertCorrections(correctionsPath, events);
  // Everything in the store at once: the correction tables, the sample, and
  // the settled finding, so neither a failure part-way nor an export reading
  // between two statements sees half a correction (CodeRabbit on #314).
  try {
    await db.transaction().execute(async (trx) => {
      await mirrorCorrections(trx, events);
      if (Object.keys(update).length > 0) await trx.updateTable("sample").set(update).where("entity_id", "=", sampleId).execute();
      if (protocolChanged) await changeSampleMethod(trx, sampleId, protocol);
      // A disagreement among the records over the method is settled by the
      // edit, as on the collector's form.
      if (protocolChanged) {
        await trx
          .deleteFrom("sample_promotion_finding")
          .where("sample_id", "=", sampleId)
          .where("rule_name", "=", "within_sample_disagreement")
          .where("details", "like", "protocol: %")
          .execute();
      }
    });
  } catch (err) {
    // Put back only the rows this save wrote (never the rest of the file, which another sample's save may have written
    // since), through the file's own queue; then say what happened as before.
    try {
      await restoreCorrections(correctionsPath, was);
    } catch (restoreErr) {
      // The user still gets the store's own answer; the file is left ahead, which is said where staff can see it.
      console.error(
        `method save for sample ${sampleId}: the corrections file still holds this save's rows (${[...was.keys()].map((k) => k.replace(" ", ":")).join(", ")}) ` +
          `because they could not be put back: ${(restoreErr as Error).message}`,
      );
    }
    if (isWriteConflict(err)) return { outcome: "not_applied" };
    throw err;
  }
  return { outcome: "saved" };
}
