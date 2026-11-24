import { sql, type Kysely } from "kysely";
import { upsertCorrections, type CorrectionEvent } from "../corrections.js";
import type { Database } from "../model.js";
import { mirrorCorrections } from "./correction-store.js";
import { trapCountOf, trapEffort } from "../trap-sample.js";
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
 * the same transaction. The sample's kind is untouched by it.
 *
 * The kind is not a field of its own. Promotion makes a sample a trap sample
 * when its records give an end date, unless every end given is that record's
 * start and every record's method is a net (src/old-sample-kind.ts,
 * CONTEXT.md, *Trap sample*), so an end date given here usually makes it one,
 * and none makes it a net sample collected on its start day, which is what a
 * rebuild would make of the corrected records. The save below sets the kind
 * from the end date alone, whatever the method; src/app/sample-kind.ts works
 * it out again by the whole rule, without correcting any old record.
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
  const found = await sql<{ code: string }>`SELECT code FROM method ${sql.raw(trapOnly ? "WHERE is_trap" : "")} ORDER BY code`.execute(db);
  return found.rows.map((r) => r.code);
}

/**
 * The sample's method, set to the code that was written to its method as written, in the same transaction. The trap
 * count stays as it is: a new method does not say how many traps there were (beeline-ni5m.15).
 */
async function writeMethod(trx: Kysely<Database>, sampleId: number, code: string): Promise<void> {
  await sql`INSERT INTO sample_method (sample_id, method_code) VALUES (${sampleId}, ${code})
            ON CONFLICT (sample_id) DO UPDATE SET method_code = excluded.method_code`.execute(trx);
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
    .select(["entity_id", "kind", "protocol", "date_start", "date_end", "inat_observation_id"])
    .executeTakeFirst();
  if (sample === undefined) return { outcome: "no_old_records" };

  // What the form would show for this sample now.
  // Trimmed, as the form's values are: promotion stores the old records'
  // words as written, and a stray space would refuse every save as stale.
  const liveStart = isoDate(sample.date_start);
  const liveProtocol = (sample.protocol ?? "").trim();
  const liveEnd = sample.kind === "trap" ? isoDate(sample.date_end) : "";
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
  // A trap sample entered in Beeline stays one; an old sample's kind follows its end date.
  const kind: "net" | "trap" = entered ? "trap" : dateEnd === "" ? "net" : "trap";
  const end = dateEnd === "" ? start : dateEnd;
  const protocolChanged = protocol !== liveProtocol;
  const startChanged = start !== liveStart;
  const endChanged = kind !== sample.kind || (kind === "trap" ? end !== isoDate(sample.date_end) : false);
  // A net sample's end is its start, so a new start moves it too.
  const datesChanged = startChanged || endChanged;
  if (!protocolChanged && !datesChanged) return { outcome: "unchanged" };

  const update = {
    ...(protocolChanged ? { protocol: protocol === "" ? null : protocol } : {}),
    ...(datesChanged ? { kind, date_start: start, date_end: end } : {}),
  };
  if (entered) {
    // The trap form writes the effort as the count and the trap kind, so a
    // new method rewrites it with the same count (CodeRabbit on this branch).
    let effort = {};
    if (protocolChanged) {
      const current = await db.selectFrom("sample").where("entity_id", "=", sampleId).select("sampling_effort").executeTakeFirst();
      const count = trapCountOf(current?.sampling_effort ?? null);
      if (count !== null) effort = { sampling_effort: trapEffort(count, protocol) };
    }
    try {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("sample").set({ ...update, ...effort }).where("entity_id", "=", sampleId).execute();
        if (protocolChanged) await writeMethod(trx, sampleId, protocol);
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

  // The old records write a date as three columns, without leading zeros.
  const parts = (d: string) => d.split("-").map((p) => String(Number(p)));
  const [sy, smo, sd] = parts(start);
  const [y, mo, d] = dateEnd === "" ? ["", "", ""] : parts(dateEnd);
  const reason = input.note.trim() !== "" ? input.note.trim() : "edited in Beeline";
  const events: CorrectionEvent[] = [];
  for (const member of members) {
    const event = (field: keyof Member, value: string) =>
      events.push({ _id: member._id, field, base_value: member[field] ?? "", new_value: value, author: input.author, reason });
    if (protocolChanged) event("samplingProtocol", protocol);
    if (startChanged) {
      event("day", sd!);
      event("month", smo!);
      event("year", sy!);
    }
    if (endChanged) {
      event("day2", d!);
      event("month2", mo!);
      event("year2", y!);
    }
  }
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
      await trx.updateTable("sample").set(update).where("entity_id", "=", sampleId).execute();
      if (protocolChanged) await writeMethod(trx, sampleId, protocol);
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
  return { outcome: "saved" };
}
