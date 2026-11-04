import type { DuckDBConnection } from "@duckdb/node-api";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import {
  applySampleOverlay,
  currentLocationOf,
  observationLocalityOf,
  resolveObservationSample,
} from "../apply-sample-overlay.js";
import {
  formatPoint,
  observationRef,
  parsePoint,
  readSampleOverlay,
  sampleValueProblem,
  upsertSampleOverlay,
  type SampleOverlayRow,
} from "../sample-overlay.js";
import { applySampleEdit, loadSampleForStaff } from "./sample-edit.js";

/**
 * A staff member setting a sample's locality from its page (beeline-649).
 *
 * One form, two durable stores, because the two kinds of sample are named by
 * different things a rebuild reproduces. A sample with an observation is
 * written to the sample overlay, keyed by that observation, and the row
 * becomes a `sample_locality_override` the follow rule respects. A sample
 * with none — imported, never linked — goes through the corrections overlay
 * exactly as the collector's own edit would, keyed by its staging rows; there
 * is no override to remove on that path, since a correction is undone by
 * writing the staged value back as a new correction. The screen does not
 * show the split: staff are fixing a place name, not choosing a mechanism.
 */

export interface StaffLocalityDeps {
  db: Kysely<Database>;
  /** For the overlay applier; absent in a test app that only writes the file. */
  conn?: DuckDBConnection;
  sampleOverlayPath: string;
  correctionsPath: string;
}

export interface StaffLocalityTarget {
  entity_id: number;
  inat_observation_id: bigint | null;
  locality: string | null;
}

export interface StaffCoordinatesInput {
  latitude: string;
  longitude: string;
  /** Metres; blank for unknown. */
  uncertainty: string;
  remove: boolean;
  note: string;
  author: string;
}

export interface StaffLocalityInput {
  /** The locality to set; ignored when `remove` is set. */
  value: string;
  remove: boolean;
  note: string;
  /** iNat login of whoever is signed in — never the person acted for. */
  author: string;
}

export type StaffLocalityResult =
  | { outcome: "saved" }
  | { outcome: "removed" }
  | { outcome: "unchanged" }
  | { outcome: "invalid"; problem: string }
  /** No staging rows back this non-iNat sample — nothing durable to anchor on. */
  | { outcome: "no_staging" }
  /** The overlay row was written but named no sample, or two. */
  | { outcome: "unresolved"; reason: string };

export async function setStaffLocality(
  deps: StaffLocalityDeps,
  sample: StaffLocalityTarget,
  input: StaffLocalityInput,
): Promise<StaffLocalityResult> {
  const value = input.value.trim();
  const reason = input.note.trim();

  if (sample.inat_observation_id === null) {
    if (input.remove) return { outcome: "unchanged" };
    const problem = sampleValueProblem("locality", value);
    if (problem !== null) return { outcome: "invalid", problem };
    const editable = await loadSampleForStaff(deps.db, sample.entity_id);
    if (editable === undefined) return { outcome: "unchanged" };
    const result = await applySampleEdit(deps.db, deps.correctionsPath, editable, {
      values: { locality: value },
      bases: {},
      note: reason,
      author: input.author,
    });
    if (result.outcome === "no_staging") return { outcome: "no_staging" };
    return result.outcome === "saved" ? { outcome: "saved" } : { outcome: "unchanged" };
  }

  if (!input.remove) {
    const problem = sampleValueProblem("locality", value);
    if (problem !== null) return { outcome: "invalid", problem };
    if (value === "") return { outcome: "invalid", problem: "locality cannot be blank" };
  }
  // Before anything durable: the row will name the sample by its
  // observation, and that has to name exactly this sample. Two samples on
  // one observation is a shape the store admits, and a row written for it
  // would be refused by every pass and reported by every nightly, never
  // applied (CodeRabbit on PR #94). Refused at the form instead.
  if (deps.conn !== undefined) {
    const resolved = await resolveObservationSample(deps.conn, sample.inat_observation_id);
    if ("problem" in resolved) return { outcome: "unresolved", reason: resolved.problem };
    if (resolved.sampleId !== sample.entity_id) {
      return { outcome: "unresolved", reason: `observation ${sample.inat_observation_id} is on another sample` };
    }
  }
  // The merge base: what the observation yields as the staffer looks at it,
  // so a later upstream move is tellable from the one they already saw
  // (ADR 0004). Read before the write, on the connection that will apply it.
  const base = deps.conn === undefined ? null : await observationLocalityOf(deps.conn, sample.entity_id);
  const row: SampleOverlayRow = {
    sample_ref: observationRef(sample.inat_observation_id),
    field: "locality",
    base_value: base ?? "",
    value: input.remove ? "" : value,
    author: input.author,
    reason,
  };
  // Durability before immediacy: if the file write fails, nothing applied.
  await upsertSampleOverlay(deps.sampleOverlayPath, [row]);
  if (deps.conn !== undefined) {
    const applied = await applySampleOverlay(deps.conn, [row]);
    const first = applied.unresolved[0];
    if (first !== undefined) return { outcome: "unresolved", reason: first.reason };
  }
  return { outcome: input.remove ? "removed" : "saved" };
}

/**
 * A staff member setting a sample's coordinates (beeline-942): the twin of
 * setStaffLocality for samples with an observation. There is no corrections
 * path for a sample without one — the corrections overlay names a staging
 * row and legacy promotion would land the point as legacy_import, which
 * would misstate who said so — so the form is not offered on those. The
 * base recorded is what sample_location held as the staffer looked at it,
 * whatever its source, which is what removal hands back.
 */
export async function setStaffCoordinates(
  deps: StaffLocalityDeps,
  sample: StaffLocalityTarget,
  input: StaffCoordinatesInput,
): Promise<StaffLocalityResult> {
  if (sample.inat_observation_id === null) return { outcome: "unchanged" };
  const reason = input.note.trim();
  let value = "";
  if (!input.remove) {
    const parts = [input.latitude.trim(), input.longitude.trim()];
    if (parts[0] === "" || parts[1] === "") return { outcome: "invalid", problem: "latitude and longitude are both needed" };
    if (input.uncertainty.trim() !== "") parts.push(input.uncertainty.trim());
    const p = parsePoint(parts.join(" "));
    if ("problem" in p) return { outcome: "invalid", problem: p.problem };
    value = formatPoint({ ...p, source: null });
  }
  if (deps.conn !== undefined) {
    const resolved = await resolveObservationSample(deps.conn, sample.inat_observation_id);
    if ("problem" in resolved) return { outcome: "unresolved", reason: resolved.problem };
    if (resolved.sampleId !== sample.entity_id) {
      return { outcome: "unresolved", reason: `observation ${sample.inat_observation_id} is on another sample` };
    }
  }
  const base = deps.conn === undefined ? "" : await currentLocationOf(deps.conn, sample.entity_id);
  const row: SampleOverlayRow = {
    sample_ref: observationRef(sample.inat_observation_id),
    field: "coordinates",
    base_value: base,
    value,
    author: input.author,
    reason,
  };
  await upsertSampleOverlay(deps.sampleOverlayPath, [row]);
  if (deps.conn !== undefined) {
    const applied = await applySampleOverlay(deps.conn, [row]);
    const first = applied.unresolved[0];
    if (first !== undefined) return { outcome: "unresolved", reason: first.reason };
  }
  return { outcome: input.remove ? "removed" : "saved" };
}

/**
 * The name Beeline gives the point of the sample `s` (schema/172), or NULL.
 * As a correlated subquery, so a listing can read it beside its own joins.
 */
export const SUGGESTED_LOCALITY = `(SELECT g.locality FROM sample_locality_suggestion_current g WHERE g.sample_id = s.entity_id)`;

/** Why a sample cannot be given its suggested locality in bulk (LOCALITY_BLOCKER). */
export type LocalityBlocker = "printed" | "printing" | "none" | "same" | "set";

/**
 * Why staff cannot give the sample `s` its suggested locality from the
 * listing (beeline-7ywr), or NULL when they can. The one statement of the
 * rule, read by the listing that offers the tick box and by the route that
 * acts on it, so a box is offered exactly where ticking would work. The
 * first that applies wins:
 *  - printed: its labels are on pins, and say what the locality is;
 *  - printing: a run that has not printed holds its labels, composed
 *    already, so the record would disagree with what is about to print;
 *  - none: nothing in the gazetteer names its point;
 *  - same: it carries the suggestion already;
 *  - set: a person set its locality, the collector or staff, and one at a
 *    time on the sample page is where to overrule them, not in bulk.
 */
export const LOCALITY_BLOCKER = `CASE
  WHEN EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id) THEN 'printed'
  WHEN EXISTS (SELECT 1 FROM printed_label pl JOIN specimen lsp ON lsp.entity_id = pl.specimen_id
               JOIN print_run r ON r.entity_id = pl.print_run_id
               WHERE lsp.sample_id = s.entity_id AND r.canceled_at IS NULL AND r.printed_at IS NULL) THEN 'printing'
  WHEN ${SUGGESTED_LOCALITY} IS NULL THEN 'none'
  WHEN s.locality IS NOT DISTINCT FROM ${SUGGESTED_LOCALITY} THEN 'same'
  WHEN EXISTS (SELECT 1 FROM sample_locality_override o WHERE o.sample_id = s.entity_id) THEN 'set'
END`;

/**
 * A collector adopting the locality Beeline names from the sample's
 * coordinates (beeline-7i6), in one click: the staff locality write above,
 * credited to the volunteer, with the suggestion as the value. So it lands
 * where a staff-set locality does and behaves the same way: applied at once,
 * standing over the observation on every sync until removed, and replayed
 * onto a rebuilt store. The name is fixed once adopted; a later gazetteer
 * that names the point differently changes the suggestion, not this.
 */
export async function adoptSuggestedLocality(
  deps: StaffLocalityDeps,
  sample: StaffLocalityTarget,
  input: { suggestion: string; reason: string; author: string },
): Promise<StaffLocalityResult> {
  return setStaffLocality(deps, sample, { value: input.suggestion, remove: false, note: input.reason, author: input.author });
}

/**
 * Who set the locality standing over this observation, by iNat login, or
 * null where none stands. A volunteer may take back a locality they adopted
 * themselves, and only that one: one a staff member set is a staff decision.
 */
export async function standingLocalityAuthor(sampleOverlayPath: string, inatObservationId: bigint): Promise<string | null> {
  const ref = observationRef(inatObservationId);
  const row = (await readSampleOverlay(sampleOverlayPath)).find((r) => r.sample_ref === ref && r.field === "locality");
  return row === undefined || row.value === "" ? null : row.author;
}

/**
 * Staff giving many samples their suggested locality at once, from the
 * samples listing (beeline-7ywr): for each sample LOCALITY_BLOCKER lets
 * through as it stands now, the same write as one press of "Use this
 * locality", credited to `author`, with the suggestion read from the store
 * rather than the form, so a name that changed after the page was drawn is
 * the one taken. A sample that can no longer take one is left as it is and
 * counted out. Returns the samples changed, of how many asked for.
 */
export async function adoptSuggestedLocalities(
  deps: StaffLocalityDeps,
  sampleIds: readonly number[],
  input: { author: string; reason: (basis: string) => string },
): Promise<{ changed: number[]; of: number }> {
  const ids = [...new Set(sampleIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) return { changed: [], of: 0 };
  const { rows } = await sql<{
    entity_id: number;
    inat_observation_id: string | null;
    locality: string | null;
    suggestion: string;
    basis: string;
  }>`SELECT s.entity_id, CAST(s.inat_observation_id AS TEXT) AS inat_observation_id, s.locality,
            g.locality AS suggestion, g.basis
     FROM sample s
     JOIN sample_locality_suggestion_current g ON g.sample_id = s.entity_id
     WHERE CAST(s.entity_id AS TEXT) IN (SELECT unnest(string_split(${ids.join(",")}, ',')))
       AND (${sql.raw(LOCALITY_BLOCKER)}) IS NULL
     ORDER BY s.entity_id`.execute(deps.db);
  const changed: number[] = [];
  for (const r of rows) {
    const target = {
      entity_id: Number(r.entity_id),
      inat_observation_id: r.inat_observation_id === null ? null : BigInt(r.inat_observation_id),
      locality: r.locality,
    };
    const result = await adoptSuggestedLocality(deps, target, {
      suggestion: r.suggestion,
      reason: input.reason(r.basis),
      author: input.author,
    });
    if (result.outcome === "saved") changed.push(Number(r.entity_id));
  }
  return { changed, of: ids.length };
}
