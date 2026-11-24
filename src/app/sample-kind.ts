import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { oldSampleKindSql } from "../old-sample-kind.js";
import { fromOldRecords } from "./sample-method.js";
import { isWriteConflict } from "../write-conflict.js";

/**
 * Staff have Beeline work out again, from a sample's old records, what kind
 * of sample it is (beeline-lmlh). The rule is src/old-sample-kind.ts's, the
 * one promotion used; this reads the sample's records through the corrections
 * (`legacy_parsed`) as a rebuild would, and writes the answer to `sample.kind`
 * and nowhere else. Nothing is written to the old records: an old record with
 * an end date on its start day is the same date written another way
 * (ingest/legacy-export-rulings.csv), so the repair is not a correction of it.
 *
 * Only a trap is corrected to a net (Peter, 2026-11-23). Where the rule gives trap for a sample stored as net, nothing is
 * done: a rebuild would not make that sample as this would, since promotion sets a trap's date range and refuses
 * some rows this reads. Rows are read through the corrections (`legacy_parsed`), as a rebuild reads them, so a
 * correction staff made to an old record's method or end date changes the answer.
 *
 * The caller never gives the kind. That is deliberate: a route that took a
 * kind would let a sample be made a trap or a net against what its records
 * say, which nothing else in Beeline lets staff do.
 */

export type KindResult =
  | { outcome: "saved" | "unchanged" | "would_save"; from: "net" | "trap"; to: "net" | "trap" }
  | { outcome: "not_found" }
  /** The sample was entered in Beeline: it has no old records, and a trap sample entered here stays one. */
  | { outcome: "entered" }
  | { outcome: "no_old_records" }
  /** The records give trap for a sample stored as net: this corrects a trap to a net and nothing else. */
  | { outcome: "rule_says_trap" }
  | { outcome: "not_applied" };

/**
 * What the sample's old records say its kind is, or null when it has none or some of its rows cannot be read.
 * The aggregate has no GROUP BY, so with no joined rows it would still give one row and call it a net.
 */
export async function kindFromOldRecords(db: Kysely<Database>, sampleId: number): Promise<"net" | "trap" | null> {
  if (!(await fromOldRecords(db, sampleId))) return null;
  const read = await sql<{ kind: "net" | "trap" | null; joined: bigint; tied: bigint }>`
    SELECT ${sql.raw(oldSampleKindSql({ end: "k.p_date_end", start: "k.p_date_start", method: 'k."samplingProtocol"' }))} AS kind,
           count(*) AS joined,
           (SELECT count(*) FROM legacy_specimen_number WHERE sample_id = ${sampleId}) AS tied
    FROM legacy_specimen_number n
    JOIN legacy_parsed k ON k._id = n._id
    WHERE n.sample_id = ${sampleId}`.execute(db);
  const row = read.rows[0];
  if (row === undefined || Number(row.joined) === 0 || Number(row.joined) !== Number(row.tied)) return null;
  return row.kind;
}

/**
 * Callers run it inside `onSample` (src/app/sample-queue.ts) and the print
 * runs' lock, check what holds the sample, and record the change in its
 * history after it. With `dryRun` nothing is written.
 */
export async function setKindFromOldRecords(
  db: Kysely<Database>,
  sampleId: number,
  { dryRun }: { dryRun: boolean },
): Promise<KindResult> {
  const sample = await db.selectFrom("sample").where("entity_id", "=", sampleId).select("kind").executeTakeFirst();
  if (sample === undefined) return { outcome: "not_found" };
  const entered = (await db.selectFrom("sample_entry").where("sample_id", "=", sampleId).select("sample_id").executeTakeFirst()) !== undefined;
  if (entered) return { outcome: "entered" };
  const derived = await kindFromOldRecords(db, sampleId);
  if (derived === null) return { outcome: "no_old_records" };
  if (derived === sample.kind) return { outcome: "unchanged", from: sample.kind, to: derived };
  if (derived === "trap") return { outcome: "rule_says_trap" };
  if (dryRun) return { outcome: "would_save", from: sample.kind, to: derived };
  try {
    await db.updateTable("sample").set({ kind: derived }).where("entity_id", "=", sampleId).execute();
  } catch (err) {
    if (isWriteConflict(err)) return { outcome: "not_applied" };
    throw err;
  }
  return { outcome: "saved", from: sample.kind, to: derived };
}
