import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { withPrintRunLock } from "../print-run.js";
import { isWriteConflict } from "../write-conflict.js";

/**
 * Staff correcting how many specimens a trap sample holds (beeline-kgyd.4.4),
 * for the samples upload (beeline-kgyd.4) and the API. No page offers it yet
 * (Peter, 2026-11-18).
 *
 * Any trap sample, printed or not (Peter, 2026-11-18: "Allow it everywhere").
 * The count is how many labels a print run makes for the sample: the freeze
 * numbers every place from 1 to the count that no specimen holds yet
 * (src/print-run.ts, pending_print_sample in schema/150). So a raised count
 * makes the next run number the extra bees, if the sample still prints: a
 * sample from a settled season never does, whatever its count. A count lowered
 * below a specimen that already has its place is refused, since that specimen
 * would be left above the count (qc_rule_count_below_printed).
 *
 * Refused too where the count follows its observation: a sample with an
 * observation whose labels are not on paper takes the observation's count on
 * every promotion (ingest/mint-samples.sql), so a correction would be gone by
 * morning. On a sample whose observation says another count, a corrected
 * count leaves `count_mismatch` standing, and the answer says so.
 *
 * No overlay file: the count has no field of an old record to be kept against
 * (promotion counted the records), and production is never promoted again
 * (ADR 0006), so a development store rebuilt from the old records loses it, as
 * it loses the trap count.
 *
 * The check and the write are behind the print runs' lock, which every freeze
 * takes, so a run cannot number a specimen between them. The write is one
 * statement through Kysely, which takes a connection of its own for it, so it
 * shares nothing with the app's connection. Callers run it inside the
 * sample's queue turn and record the history after it.
 */

/** The sample's count as printing sees it, after the correction. */
export interface CountState {
  specimen_count: number;
  /** Specimens that hold a place in the count: imported ones, and ones a print run that was not canceled numbered. */
  numbered: number;
  /** Places from 1 to the count that no numbered specimen holds: what the next print run would number, if the sample still prints. */
  unnumbered: number;
  /** From a settled season, which no print run takes: a raised count numbers nothing. */
  season_settled: boolean;
  /** What count_mismatch says where the observation's count differs from the sample's; null where it does not. */
  count_mismatch: string | null;
}

export type SpecimenCountWrite =
  | { outcome: "saved" | "unchanged"; state: CountState }
  | { outcome: "not_found" }
  | { outcome: "not_trap" }
  | { outcome: "follows_observation" }
  /** The highest specimen number that already holds its place, which the count may not go below. */
  | { outcome: "below_numbered"; highest: number }
  /** The write lost a write conflict; nothing was recorded anywhere. */
  | { outcome: "conflict" };

async function stateOf(db: Kysely<Database>, sampleId: number): Promise<CountState> {
  const found = await sql<{
    specimen_count: number;
    numbered: bigint;
    held: bigint;
    season_settled: boolean;
    count_mismatch: string | null;
  }>`
    SELECT s.specimen_count,
           (SELECT count(*) FROM individuated_specimen i WHERE i.sample_id = s.entity_id) AS numbered,
           (SELECT count(*) FROM individuated_specimen i WHERE i.sample_id = s.entity_id AND i.specimen_number <= s.specimen_count) AS held,
           EXISTS (SELECT 1 FROM settled_sample ss WHERE ss.sample_id = s.entity_id) AS season_settled,
           (SELECT any_value(m.details) FROM qc_rule_count_mismatch m WHERE m.sample_id = s.entity_id) AS count_mismatch
    FROM sample s WHERE s.entity_id = ${sampleId}`.execute(db);
  const r = found.rows[0]!;
  const count = Number(r.specimen_count);
  return {
    specimen_count: count,
    numbered: Number(r.numbered),
    unnumbered: Math.max(0, count - Number(r.held)),
    season_settled: Boolean(r.season_settled),
    count_mismatch: r.count_mismatch ?? null,
  };
}

export function setTrapSpecimenCount(db: Kysely<Database>, sampleId: number, count: number): Promise<SpecimenCountWrite> {
  return withPrintRunLock(async (): Promise<SpecimenCountWrite> => {
    const found = await sql<{ kind: string; specimen_count: number; follows: boolean; highest: number | null }>`
      SELECT s.kind, s.specimen_count,
             (EXISTS (SELECT 1 FROM observation_sample_candidate c WHERE c.inat_id = s.inat_observation_id)
              AND NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)) AS follows,
             (SELECT max(i.specimen_number) FROM individuated_specimen i WHERE i.sample_id = s.entity_id) AS highest
      FROM sample s WHERE s.entity_id = ${sampleId}`.execute(db);
    const sample = found.rows[0];
    if (sample === undefined) return { outcome: "not_found" };
    if (sample.kind !== "trap") return { outcome: "not_trap" };
    if (sample.follows) return { outcome: "follows_observation" };
    if (count === Number(sample.specimen_count)) return { outcome: "unchanged", state: await stateOf(db, sampleId) };
    const highest = sample.highest === null ? 0 : Number(sample.highest);
    if (count < highest) return { outcome: "below_numbered", highest };
    try {
      await db.updateTable("sample").set({ specimen_count: count }).where("entity_id", "=", sampleId).execute();
    } catch (err) {
      if (isWriteConflict(err)) return { outcome: "conflict" };
      throw err;
    }
    return { outcome: "saved", state: await stateOf(db, sampleId) };
  });
}
