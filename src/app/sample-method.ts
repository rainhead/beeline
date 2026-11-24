import { readFile } from "node:fs/promises";
import { sql, type Kysely } from "kysely";
import { parseCsv, upsertCorrections, type CorrectionEvent } from "../corrections.js";
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
 * sample changes. The nightly iNaturalist sync never rewrites a linked
 * sample's method or dates, so the change stays.
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
 * with no observation (Peter, 2026-11-15, beeline-0wbq). Promotion groups
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
   * The store write lost a write conflict. For a sample with old records the
   * events are already in the corrections file, which nothing reads again on
   * production (ADR 0006); a sample entered in Beeline is written directly,
   * with no events, so nothing was kept. Either way the change is applied only by saving it
   * again, which does not record it twice (beeline-kgyd.4.8).
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
  // iNaturalist holds the start of a sample with an observation.
  if (startTouched && sample.inat_observation_id !== null) return { outcome: "invalid", problem: "start_observation" };
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

  const oldRecords = await fromOldRecords(db, sampleId);
  const entered =
    !oldRecords &&
    (await db.selectFrom("sample_entry").where("sample_id", "=", sampleId).select("sample_id").executeTakeFirst()) !== undefined;
  if (!oldRecords && !entered) return { outcome: "no_old_records" };

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
  const update = {
    ...(protocolChanged ? { protocol: protocol === "" ? null : protocol } : {}),
    ...(datesChanged ? { date_start: start, date_end: end } : {}),
  };
  if (entered) {
    if (!protocolChanged && !datesChanged) return { outcome: "unchanged" };
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
  const storeValue = new Map<string, string>();
  // Without the view (a store nothing was promoted into) the store's value of a record is not known, so the cleanup of
  // fields this save does not set is skipped: reverting the file to uncorrected records would undo its corrections.
  // Fields the save sets are still written, compared with the staged record.
  const stored = view
    ? (
        await sql<Member>`
          SELECT c._id, c."samplingProtocol" AS "samplingProtocol", c.day, c.month, c.year, c.day2, c.month2, c.year2
          FROM legacy_specimen_number n JOIN legacy_occurrence_corrected c ON c._id = n._id
          WHERE n.sample_id = ${sampleId}`.execute(db)
      ).rows
    : members;
  for (const r of stored) for (const f of FIELDS) storeValue.set(`${r._id}|${f}`, (r[f] ?? "").toString());
  // And what the durable file says, which is newer than the store where a save wrote the file and then lost its store
  // transaction (not_applied). It is read before the sample is judged unchanged: a later save that changes nothing in
  // the sample still finishes or reverts what that save left in the file.
  const inFile = new Map<string, string>();
  try {
    const [head = [], ...body] = parseCsv(await readFile(correctionsPath, "utf8"));
    const col = (name: string) => head.indexOf(name);
    const ids = new Set(members.map((m) => m._id));
    for (const r of body) {
      const field = r[col("field")] ?? "";
      if ((FIELDS as readonly string[]).includes(field) && ids.has(r[col("_id")] ?? "")) inFile.set(`${r[col("_id")]}|${field}`, r[col("new_value")] ?? "");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // The old records write a date as three columns, without leading zeros.
  const parts = (d: string) => d.split("-").map((p) => String(Number(p)));
  const [sy, smo, sd] = parts(start);
  const [ey, emo, ed] = oneDay ? ["", "", ""] : parts(end);
  const reason = input.note.trim() !== "" ? input.note.trim() : "edited in Beeline";
  const events: CorrectionEvent[] = [];
  const writesEnd = endChanged || (startChanged && oneDay);
  // What each field is to hold on every record, where this save sets it; elsewhere each record keeps what the store says.
  const target: Partial<Record<(typeof FIELDS)[number], string>> = {
    ...(protocolChanged ? { samplingProtocol: protocol } : {}),
    ...(startChanged ? { day: sd!, month: smo!, year: sy! } : {}),
    // A one-day sample's end is blank on every record, as a blank end always wrote it (the legacy-format export reads
    // each record's own end), and one that spans days is the end on every record.
    ...(writesEnd ? { day2: ed!, month2: emo!, year2: ey! } : {}),
  };
  // What the sample itself holds of each field, which a file value that the store lacks may match: a correction the
  // collector's form wrote to the file from cutover until #314 without copying it to the tables.
  const [lsy, lsmo, lsd] = parts(liveStart);
  const [ley, lemo, led] = liveEnd === "" ? ["", "", ""] : parts(liveEnd);
  const held: Partial<Record<(typeof FIELDS)[number], string>> = {
    samplingProtocol: liveProtocol, day: lsd!, month: lsmo!, year: lsy!, day2: led!, month2: lemo!, year2: ley!,
  };
  const SETTLED = "restored after a save that was not applied";
  const COPIED = "copied from the corrections file";
  for (const member of members) {
    for (const f of FIELDS) {
      const key = `${member._id}|${f}`;
      const store = storeValue.get(key) ?? "";
      const base = (member[f] ?? "").toString();
      const fileValue = inFile.get(key);
      if (target[f] !== undefined) {
        // Written where the store's value or the file's differs from it, so both end up holding it: a save whose file
        // write succeeded and whose store write failed is finished (or undone) by the next save.
        if (target[f] !== store || target[f] !== (fileValue ?? store)) {
          events.push({ _id: member._id, field: f, base_value: base, new_value: target[f]!, author: input.author, reason });
        }
      } else if (view && fileValue !== undefined && fileValue !== store) {
        // A field this save leaves alone, where the file and the store disagree. A file value that is what the sample
        // holds is a correction the tables lack, so it is kept and copied into them; otherwise it is the leftover of a
        // save that was not applied, and the store's value is put back.
        const keep = fileValue === held[f];
        events.push({ _id: member._id, field: f, base_value: base, new_value: keep ? fileValue : store, author: input.author, reason: keep ? COPIED : SETTLED });
      }
    }
  }
  if (!protocolChanged && !datesChanged && events.length === 0) return { outcome: "unchanged" };
  // Durability before immediacy: if the event write fails, nothing applied.
  // Should a write to the store fail after it, the file is ahead of the
  // sample until the next save, which is what a rebuild would apply.
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
    // The file may hold the change, and the store does not; saving again applies it once.
    if (isWriteConflict(err)) return { outcome: "not_applied" };
    throw err;
  }
  // A save that only settled the file and the tables left the sample as it was: no change to record.
  return { outcome: protocolChanged || datesChanged ? "saved" : "unchanged" };
}
