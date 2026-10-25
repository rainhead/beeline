import type { DuckDBConnection } from "@duckdb/node-api";
import { applySampleOverlay, resolveObservationSample, waiverProblem } from "../apply-sample-overlay.js";
import { HELD, observationRef, upsertSampleOverlay, WAIVED, waivedRule, waiverField, type SampleOverlayRow } from "../sample-overlay.js";

/**
 * Staff holding a sample back from printing (beeline-plu) and waiving a
 * blocking flag they judge fine (beeline-1kb.9), from the sample page. Both
 * are rows in the sample overlay, keyed by the sample's observation, applied
 * at once and again by every promotion — the locality override's route
 * (src/app/locality-override.ts), so a rebuild cannot release a held sample
 * or re-block a waived one.
 *
 * Only a sample with an observation can take either: the overlay names a
 * sample by its observation, and every sample still waiting to print has
 * one, since imported samples arrived printed.
 */

export interface QcDecisionDeps {
  conn: DuckDBConnection;
  sampleOverlayPath: string;
}

export interface QcDecisionTarget {
  entity_id: number;
  inat_observation_id: bigint | null;
}

export type QcDecisionResult =
  | { outcome: "saved" }
  | { outcome: "removed" }
  | { outcome: "invalid"; problem: string }
  /** The sample has no observation, so the overlay cannot name it. */
  | { outcome: "no_observation" }
  /** The overlay row named no sample, or two. */
  | { outcome: "unresolved"; reason: string };

const rows = async (conn: DuckDBConnection, sql: string, params: unknown[] = []) =>
  (await (await conn.run(sql, params as never)).getRows()) as unknown[][];

/**
 * What a flag says on this sample now, in the form a waiver records and
 * sample_qc_finding compares (schema/130); null where the flag does not
 * fire. Read from qc_finding rather than the roll-up, which leaves a waived
 * finding out.
 */
export async function findingText(conn: DuckDBConnection, sampleId: number, ruleName: string): Promise<string | null> {
  const found = await rows(
    conn,
    `SELECT concat_ws(' ', f.details, f.detail_taxon_name)
     FROM qc_finding f
     LEFT JOIN specimen sp ON sp.entity_id = f.specimen_id
     WHERE coalesce(f.sample_id, sp.sample_id) = $1 AND f.rule_name = $2`,
    [sampleId, ruleName],
  );
  const v = found[0]?.[0];
  return v === undefined || v === null ? null : String(v);
}

async function record(deps: QcDecisionDeps, sample: QcDecisionTarget, row: Omit<SampleOverlayRow, "sample_ref">): Promise<QcDecisionResult> {
  if (sample.inat_observation_id === null) return { outcome: "no_observation" };
  // Refused at the form rather than written as a row every pass reports and
  // never applies (the locality override's reasoning, CodeRabbit on PR #94).
  const resolved = await resolveObservationSample(deps.conn, sample.inat_observation_id);
  if ("problem" in resolved) return { outcome: "unresolved", reason: resolved.problem };
  if (resolved.sampleId !== sample.entity_id) {
    return { outcome: "unresolved", reason: `observation ${sample.inat_observation_id} is on another sample` };
  }
  const full: SampleOverlayRow = { sample_ref: observationRef(sample.inat_observation_id), ...row };
  // Durability before immediacy: if the file write fails, nothing applied.
  await upsertSampleOverlay(deps.sampleOverlayPath, [full]);
  const applied = await applySampleOverlay(deps.conn, [full]);
  const first = applied.unresolved[0];
  if (first !== undefined) return { outcome: "unresolved", reason: first.reason };
  return { outcome: row.value === "" ? "removed" : "saved" };
}

/** Hold a sample back from printing, or lift the hold that stands. */
export async function setHold(
  deps: QcDecisionDeps,
  sample: QcDecisionTarget,
  input: { lift: boolean; note: string; author: string },
): Promise<QcDecisionResult> {
  const reason = input.note.trim();
  if (!input.lift && reason === "") return { outcome: "invalid", problem: "a hold needs a reason" };
  return record(deps, sample, { field: "hold", base_value: "", value: input.lift ? "" : HELD, author: input.author, reason });
}

/**
 * Waive one blocking flag on a sample, or remove the waiver. The waiver
 * records what the flag says now, so it stops applying when that changes.
 */
export async function setWaiver(
  deps: QcDecisionDeps,
  sample: QcDecisionTarget,
  input: { rule: string; remove: boolean; note: string; author: string },
): Promise<QcDecisionResult> {
  const reason = input.note.trim();
  // Before anything reaches the file: a malformed name would be a field the
  // overlay cannot parse, and every later save would fail on it.
  if (waivedRule(waiverField(input.rule)) === null) return { outcome: "invalid", problem: `'${input.rule}' is not a flag` };
  let finding = "";
  if (!input.remove) {
    const problem = await waiverProblem(deps.conn, input.rule, reason);
    if (problem !== null) return { outcome: "invalid", problem };
    const text = await findingText(deps.conn, sample.entity_id, input.rule);
    if (text === null) return { outcome: "invalid", problem: `'${input.rule}' does not fire on this sample` };
    finding = text;
  }
  return record(deps, sample, {
    field: waiverField(input.rule),
    base_value: finding,
    value: input.remove ? "" : WAIVED,
    author: input.author,
    reason,
  });
}
