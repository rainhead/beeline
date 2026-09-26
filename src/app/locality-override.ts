import type { DuckDBConnection } from "@duckdb/node-api";
import type { Kysely } from "kysely";
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
 * is no override to remove on that path, since a correction is retired by
 * writing the staged value back. The screen does not show the split: staff
 * are fixing a place name, not choosing a mechanism.
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
