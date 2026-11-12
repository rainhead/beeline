import { sql, type Kysely } from "kysely";
import { upsertCorrections, type CorrectionEvent } from "../corrections.js";
import type { Database } from "../model.js";

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
 * The kind is not a field of its own. Promotion makes a sample a trap sample
 * exactly when its records give an end date (CONTEXT.md, *Trap sample*), so
 * an end date given here makes it one, and none makes it a net sample
 * collected on its start day, which is what a rebuild would make of the
 * corrected records. The start date is not editable: promotion groups records
 * into samples by it, so a corrected start could move records between
 * samples on a rebuild.
 */

export interface MethodInput {
  /** The method in words, as the old records write it ("pan traps"); blank for none. */
  protocol: string;
  /** The day collecting ended, YYYY-MM-DD; blank for a net sample collected on one day. */
  dateEnd: string;
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
  bases?: { protocol?: string; dateEnd?: string };
}

export type MethodResult =
  | { outcome: "saved" }
  | { outcome: "unchanged" }
  | { outcome: "invalid"; problem: "date" | "before_start" | "future" }
  /** Someone changed a field this form touched since it was opened. */
  | { outcome: "conflict" }
  /** No old record behind this sample: nothing durable to name. */
  | { outcome: "no_old_records" };

interface Member {
  _id: string;
  samplingProtocol: string | null;
  day2: string | null;
  month2: string | null;
  year2: string | null;
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

/**
 * One save at a time for a sample, from reading it to writing it: two saves
 * interleaving could leave the live sample with one's value and the
 * corrections file with the other's, which a rebuild would then act on
 * (CodeRabbit on PR #314). The app is the one process that writes either.
 */
const queues = new Map<number, Promise<unknown>>();

export function setSampleMethod(
  db: Kysely<Database>,
  correctionsPath: string,
  sampleId: number,
  input: MethodInput,
): Promise<MethodResult> {
  const run = (queues.get(sampleId) ?? Promise.resolve())
    .catch(() => {})
    .then(() => setSampleMethodNow(db, correctionsPath, sampleId, input));
  queues.set(sampleId, run);
  void run.finally(() => {
    if (queues.get(sampleId) === run) queues.delete(sampleId);
  }).catch(() => {});
  return run;
}

async function setSampleMethodNow(
  db: Kysely<Database>,
  correctionsPath: string,
  sampleId: number,
  input: MethodInput,
): Promise<MethodResult> {
  const sample = await db
    .selectFrom("sample")
    .where("entity_id", "=", sampleId)
    .select(["entity_id", "kind", "protocol", "date_start", "date_end"])
    .executeTakeFirst();
  if (sample === undefined) return { outcome: "no_old_records" };

  const start = isoDate(sample.date_start);
  // What the form would show for this sample now.
  const liveProtocol = sample.protocol ?? "";
  const liveEnd = sample.kind === "trap" ? isoDate(sample.date_end) : "";
  const touched = (submitted: string, base: string | undefined, live: string) =>
    base === undefined ? submitted !== live : submitted !== base.trim();
  const protocolIn = input.protocol.trim();
  const endIn = input.dateEnd.trim();
  const protocolTouched = touched(protocolIn, input.bases?.protocol, liveProtocol);
  const endTouched = touched(endIn, input.bases?.dateEnd, liveEnd);
  if (
    (protocolTouched && input.bases?.protocol !== undefined && input.bases.protocol.trim() !== liveProtocol) ||
    (endTouched && input.bases?.dateEnd !== undefined && input.bases.dateEnd.trim() !== liveEnd)
  ) {
    return { outcome: "conflict" };
  }
  const dateEnd = endTouched ? endIn : liveEnd;
  if (dateEnd !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(dateEnd)) return { outcome: "invalid", problem: "date" };
  // A date that does not read back as written does not exist (30 February).
  if (dateEnd !== "") {
    const parsed = new Date(`${dateEnd}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateEnd) return { outcome: "invalid", problem: "date" };
  }
  if (dateEnd !== "" && dateEnd < start) return { outcome: "invalid", problem: "before_start" };
  if (dateEnd !== "" && dateEnd > input.today) return { outcome: "invalid", problem: "future" };

  const protocol = protocolTouched ? protocolIn : liveProtocol;
  const kind = dateEnd === "" ? "net" : "trap";
  const end = dateEnd === "" ? start : dateEnd;
  const protocolChanged = protocol !== (sample.protocol ?? "");
  const datesChanged = kind !== sample.kind || end !== isoDate(sample.date_end);
  if (!protocolChanged && !datesChanged) return { outcome: "unchanged" };

  if (!(await fromOldRecords(db, sampleId))) return { outcome: "no_old_records" };
  const members = (
    await sql<Member>`
      SELECT o._id, o."samplingProtocol" AS "samplingProtocol", o.day2, o.month2, o.year2
      FROM legacy_specimen_number n
      JOIN legacy_occurrence o ON o._id = n._id
      WHERE n.sample_id = ${sampleId}
    `.execute(db)
  ).rows;
  if (members.length === 0) return { outcome: "no_old_records" };

  // The old records write a date as three columns, without leading zeros.
  const [y, mo, d] = dateEnd === "" ? ["", "", ""] : dateEnd.split("-").map((p) => String(Number(p)));
  const reason = input.note.trim() !== "" ? input.note.trim() : "edited in Beeline";
  const events: CorrectionEvent[] = [];
  for (const member of members) {
    const event = (field: keyof Member, value: string) =>
      events.push({ _id: member._id, field, base_value: member[field] ?? "", new_value: value, author: input.author, reason });
    if (protocolChanged) event("samplingProtocol", protocol);
    if (datesChanged) {
      event("day2", d!);
      event("month2", mo!);
      event("year2", y!);
    }
  }
  // Durability before immediacy: if the event write fails, nothing applied.
  await upsertCorrections(correctionsPath, events);

  await db
    .updateTable("sample")
    .set({
      ...(protocolChanged ? { protocol: protocol === "" ? null : protocol } : {}),
      ...(datesChanged ? { kind, date_end: end } : {}),
    })
    .where("entity_id", "=", sampleId)
    .execute();

  // A disagreement among the records over the method is settled by the edit,
  // as on the collector's form.
  if (protocolChanged) {
    await db
      .deleteFrom("sample_promotion_finding")
      .where("sample_id", "=", sampleId)
      .where("rule_name", "=", "within_sample_disagreement")
      .where("details", "like", "protocol: %")
      .execute();
  }
  return { outcome: "saved" };
}
