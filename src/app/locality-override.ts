import type { DuckDBConnection } from "@duckdb/node-api";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import {
  applySampleOverlay,
  applyStaffPoint,
  refreshWaivers,
  currentLocationOf,
  personOfLogin,
  observationLocalityOf,
  resolveObservationSample,
} from "../apply-sample-overlay.js";
import {
  formatPoint,
  legacyRecordRef,
  observationRef,
  parsePoint,
  parseSampleRef,
  readSampleOverlay,
  sampleValueProblem,
  upsertSampleOverlay,
  type SampleOverlayRow,
} from "../sample-overlay.js";
import { withPrintRunLock } from "../print-run.js";
import { isWriteConflict } from "../write-conflict.js";
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
  /**
   * The connection a staff point's transaction runs on, behind the print
   * runs' lock (src/trap-sample.ts does the same). The app's own `conn` is
   * shared by every request, so a BEGIN on it would take other requests'
   * statements into the transaction, and a ROLLBACK would undo them. Every
   * writer on the print connection takes the lock, so nothing else can be
   * in a transaction there. Absent in an instance with no separate print
   * connection, which then runs the transaction on `conn` under the lock.
   */
  printWriter?: DuckDBConnection;
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
  /** A point cannot be changed while an unprinted print run holds the sample. */
  | { outcome: "in_print_run" }
  /** The store write lost a write conflict, and nothing was recorded anywhere (an entered sample has no file row). */
  | { outcome: "conflict" }
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
 * What a staff point on this sample is kept against, so that it survives a
 * rebuild and the nightly's replay of the overlay (beeline-kgyd.4.2):
 *
 * - `ref`: the overlay row's key. The observation where there is one, else
 *   an old record of the sample: the one a row already standing in the file
 *   names, so the sample never has two rows for its point, and failing that
 *   its first (lowest id, whose values the sample took). An old sample's
 *   corrections are events on those records, but a point cannot be one: the
 *   legacy-format export writes the sample's own point only once its source
 *   is staff_entry, and a rebuilt store would give an event's point back as
 *   legacy_import, with no override row to carry the source, county, state,
 *   atlas and elevation with it.
 * - `entered`: a sample entered in Beeline. Nothing a file could name it by
 *   survives a rebuild, and Beeline is its only record, so its point is
 *   written to the store directly, with the same override row.
 * - null: a sample none of these describes; there is nothing to keep a point against.
 */
async function pointAnchor(
  deps: Pick<StaffLocalityDeps, "db" | "sampleOverlayPath">,
  sample: StaffLocalityTarget,
): Promise<{ kind: "ref"; ref: string } | { kind: "entered" } | null> {
  const table = await sql<{ n: bigint }>`
    SELECT count(*) AS n FROM duckdb_tables() WHERE table_name = 'legacy_specimen_number' AND NOT temporary`.execute(deps.db);
  if (Number(table.rows[0]?.n ?? 0) > 0) {
    const records = await sql<{ id: string }>`
      SELECT _id AS id FROM legacy_specimen_number WHERE sample_id = ${sample.entity_id} ORDER BY _id`.execute(deps.db);
    const ids = new Set(records.rows.map((r) => r.id));
    const standing = (await readSampleOverlay(deps.sampleOverlayPath)).find((r) => {
      const ref = parseSampleRef(r.sample_ref);
      return r.field === "coordinates" && ref !== null && "legacy_id" in ref && ids.has(ref.legacy_id);
    });
    // Whatever the sample has now: a row standing under an old record's key
    // stays its key after an observation is linked, so a second save does not
    // add a second row and a removal replaces the one row.
    if (standing !== undefined) return { kind: "ref", ref: standing.sample_ref };
    const first = records.rows[0]?.id;
    if (first !== undefined && sample.inat_observation_id === null) return { kind: "ref", ref: legacyRecordRef(first) };
  }
  if (sample.inat_observation_id !== null) return { kind: "ref", ref: observationRef(sample.inat_observation_id) };
  const entered = await sql<{ e: boolean }>`SELECT EXISTS (SELECT 1 FROM sample_entry WHERE sample_id = ${sample.entity_id}) AS e`.execute(deps.db);
  return entered.rows[0]?.e ? { kind: "entered" } : null;
}

/** Whether a staff point can be kept against this sample at all: it has an observation, old records, or was entered. */
export async function mayHoldStaffPoint(deps: Pick<StaffLocalityDeps, "db" | "sampleOverlayPath">, sample: StaffLocalityTarget): Promise<boolean> {
  return (await pointAnchor(deps, sample)) !== null;
}

/**
 * Whether labels for this sample are in a print run that has not printed,
 * as the trap form asks before it edits (loadTrapSample) and the place
 * stamp before it writes a county (src/derive-area.ts): the run holds the
 * point it froze, so a point set now would disagree with the labels about to
 * print. Asked inside the print runs' lock, which a run is prepared under.
 */
async function heldByUnprintedRun(conn: DuckDBConnection, sampleId: number): Promise<boolean> {
  const found = (await (
    await conn.run(
      `SELECT 1 FROM sample_label_in_progress WHERE sample_id = $1 AND printing_count > 0`,
      [sampleId] as never,
    )
  ).getRows()) as unknown[][];
  return found.length > 0;
}

/**
 * A staff member setting a sample's coordinates (beeline-942): the twin of
 * setStaffLocality. Kept in the sample overlay, applied at once, and
 * replayed by every promotion, under the observation's key where the sample
 * has one and an old record's where it does not (pointAnchor says why not
 * the corrections overlay).
 *
 * A removal is for a sample with an observation only: it hands back what
 * the sample held and follows the observation again. A sample with none has
 * no observation to follow, and reconstructing what an imported or entered
 * sample held was found to need more of the past than the store keeps, so
 * staff correct a wrong point by setting the right one (Peter, 2026-11-18).
 *
 * The point is written in one transaction on the print connection, behind
 * the print runs' lock, as the trap form's writes are: the app's own `conn`
 * is shared by every request, so a BEGIN there would take other requests'
 * statements into the transaction. Only the write is under the lock; the
 * waivers are refreshed after it. A change, a removal included, is refused
 * while an unprinted run holds the sample.
 */
export async function setStaffCoordinates(
  deps: StaffLocalityDeps,
  sample: StaffLocalityTarget,
  input: StaffCoordinatesInput,
): Promise<StaffLocalityResult> {
  const anchor = await pointAnchor(deps, sample);
  if (anchor === null) return { outcome: "unchanged" };
  if (input.remove && sample.inat_observation_id === null) {
    return { outcome: "invalid", problem: "a sample with no iNaturalist observation has no point to take away: set the right one instead" };
  }
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
  const outcome = input.remove ? "removed" : "saved";
  const conn = deps.conn;
  if (conn === undefined) {
    // An instance that only writes the file (a test app); nothing to apply.
    if (anchor.kind === "ref") {
      await upsertSampleOverlay(deps.sampleOverlayPath, [{ sample_ref: anchor.ref, field: "coordinates", base_value: "", value, author: input.author, reason }]);
    }
    return { outcome };
  }
  if (sample.inat_observation_id !== null) {
    const resolved = await resolveObservationSample(conn, sample.inat_observation_id);
    if ("problem" in resolved) return { outcome: "unresolved", reason: resolved.problem };
    if (resolved.sampleId !== sample.entity_id) {
      return { outcome: "unresolved", reason: `observation ${sample.inat_observation_id} is on another sample` };
    }
  }
  const base = await currentLocationOf(conn, sample.entity_id);
  const setBy = await personOfLogin(conn, input.author);
  const writer = deps.printWriter ?? conn;
  const row = { base_value: base, value, reason };
  const written = await withPrintRunLock(async (): Promise<{ frozen: true } | { conflict: true } | { problem: string } | null> => {
    if (await heldByUnprintedRun(writer, sample.entity_id)) return { frozen: true };
    // Durability before immediacy: if the file write fails, nothing applied.
    if (anchor.kind === "ref") {
      await upsertSampleOverlay(deps.sampleOverlayPath, [{ sample_ref: anchor.ref, field: "coordinates", author: input.author, ...row }]);
    }
    let problem: string | null;
    try {
      problem = await applyStaffPoint(writer, sample.entity_id, row, setBy, { transactional: true, settleFinding: true });
    } catch (err) {
      // An entered sample has no file row: a lost conflict recorded nothing,
      // and the caller is told so rather than that it was recorded.
      if (anchor.kind === "entered" && isWriteConflict(err)) return { conflict: true };
      throw err;
    }
    return problem === null ? null : { problem };
  });
  if (written !== null && "frozen" in written) return { outcome: "in_print_run" };
  if (written !== null && "conflict" in written) return { outcome: "conflict" };
  if (written !== null) return { outcome: "unresolved", reason: written.problem };
  // Slow, and a point's own write does not need it: the flags a waiver was
  // made against may have changed with the point.
  await refreshWaivers(conn);
  return { outcome };
}

/**
 * A staff member taking the observation's location for a sample Beeline has
 * printed, after the collector moved the pin on iNaturalist
 * (beeline-1kb.17.1, GitHub #298): the staff coordinates write above, with
 * the observation's point as the value, so promotion leaves it alone and the
 * page says who chose it. The point is read from the store as it stands,
 * never from the form, and refused unless the sample is in
 * sample_location_label_diverged now: the page may be older than the store.
 * The county, state and country follow the point, as for any point staff
 * set (src/derive-area.ts); the caller runs that step at once. The labels on
 * paper are untouched; a reprint is asked for as any other.
 */
export async function takeObservationLocation(
  deps: StaffLocalityDeps & { conn: DuckDBConnection },
  sample: StaffLocalityTarget,
  input: { reason: string; author: string },
): Promise<StaffLocalityResult> {
  const found = (await (
    await deps.conn.run(
      `SELECT observation_latitude, observation_longitude, observation_uncertainty_m
       FROM sample_location_label_diverged WHERE sample_id = $1`,
      [sample.entity_id] as never,
    )
  ).getRows()) as unknown[][];
  const d = found[0];
  if (d === undefined) return { outcome: "unchanged" };
  return setStaffCoordinates(deps, sample, {
    latitude: String(d[0]),
    longitude: String(d[1]),
    uncertainty: d[2] === null ? "" : String(d[2]),
    remove: false,
    note: input.reason,
    author: input.author,
  });
}

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
