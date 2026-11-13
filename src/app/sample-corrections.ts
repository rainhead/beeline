import type { DuckDBConnection } from "@duckdb/node-api";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { kyselyReader } from "../person-change.js";
import { recordSampleChanges } from "../sample-change.js";
import { loadTrapSample, mayEditTrapSample, setTrapSampleLocality } from "../trap-sample.js";
import { deriveForObserver } from "./inat-check.js";
import { STAFF_READER, type Reader } from "./listings.js";
import {
  adoptSuggestedLocality,
  setStaffCoordinates,
  setStaffLocality,
  standingLocalityAuthor,
  takeObservationLocation,
  type StaffLocalityResult,
} from "./locality-override.js";
import { withPromotionLock } from "./promotion-lock.js";
import { setHold, setWaiver, type QcDecisionResult } from "./qc-decisions.js";
import { loadSample, type LocalitySuggestion } from "./record.js";
import { applySampleEdit, loadEditableSample, type EditableFieldName } from "./sample-edit.js";
import { onSample } from "./sample-queue.js";

/**
 * The corrections a person may make to a sample, each as one function that
 * holds its rules: who may make it, what else happens when it is made, and
 * how the change is recorded under its author (beeline-pnqr.8). The writes
 * themselves are in the modules these call (sample-edit, locality-override,
 * qc-decisions). The pages in `server.tsx` only read the form, call one of
 * these and turn the result into a response; an API can call the same ones.
 *
 * Every function returns `{ ok: true, ... }` or `{ ok: false, refusal, ... }`
 * naming why nothing was written. The refusals are the ones the pages have
 * always made, in the order they are checked.
 */

/** Who is acting, as the routes read it off the request. */
export interface Actor {
  /** Whose records "mine" means: the person acted for, or the signed-in one. */
  personId: number;
  /** The signed-in person. Differs from `personId` while acting for someone. */
  signedInPersonId: number;
  /** iNat login of the signed-in person: the author of whatever is written, never the person acted for. */
  login: string;
  /** Staff, and not impersonating (impersonation switches staff powers off). */
  staff: boolean;
  /** Viewing as somebody else: reading is allowed, changing is not. */
  impersonating: boolean;
}

/**
 * The one way to make an Actor. Impersonation switches staff powers off, so
 * an actor who is impersonating is never staff, whatever the caller says.
 */
export function actorFor(who: Actor): Actor {
  return { ...who, staff: who.staff && !who.impersonating };
}

/**
 * A correction's input, as a value or as a function that reads it. A page
 * passes a function that parses the form, so the body is read only once the
 * rules that do not depend on it have passed, as it always was; an API
 * passes a value.
 */
export type Input<T> = T | (() => Promise<T>);

async function resolveInput<T>(input: Input<T>): Promise<T> {
  return typeof input === "function" ? (input as () => Promise<T>)() : input;
}

/**
 * The shape every correction runs in (beeline-4ksk).
 *
 *  1. `gates` is asked first, before the form is read: the rules that do not
 *     depend on the form, so a request that will be refused is refused
 *     without reading what it sent.
 *  2. The form is read. That can take a while, and it happens outside the
 *     sample's queue, so a slow upload does not hold up anyone else's save of
 *     the sample.
 *  3. Then one turn of the sample's queue (src/app/sample-queue.ts): `gates`
 *     is asked again, of the sample as it stands now, and `act` checks what
 *     depends on the form, writes, and records the change in the sample's
 *     history.
 *
 * The second asking is the one the write relies on; the first only saves
 * reading a form. Everything from the reload to the history entry is one
 * turn, so two corrections to one sample cannot interleave: neither can
 * write between the other's check and its write, and each one's history
 * entry is taken before the next begins, under its own author. Before this,
 * only the collector's edit and the place editor took a turn, and the others
 * could replace each other's value or be recorded under each other's name.
 */
async function correct<Ready, Form, Result extends { ok: boolean }, Refusal extends { ok: false }>(
  sampleId: number,
  input: Input<Form>,
  gates: () => Promise<{ ready: Ready } | Refusal>,
  act: (ready: Ready, form: Form) => Promise<Result>,
): Promise<Result | Refusal> {
  const early = await gates();
  if (!("ready" in early)) return early;
  const form = await resolveInput(input);
  return onSample(sampleId, async (): Promise<Result | Refusal> => {
    const now = await gates();
    if (!("ready" in now)) return now;
    return act(now.ready, form);
  });
}

/** Ends a switch over every refusal: a refusal left unhandled is a type error. */
export function unreachable(x: never): never {
  throw new Error(`unhandled refusal: ${JSON.stringify(x)}`);
}

/**
 * Who is reading, for the location rule (src/app/listings.ts `withheld`):
 * staff, or whose collecting is theirs. A delegate reads the household's
 * records as the household does, so both people count; impersonation is the
 * volunteer's view, so only the volunteer does.
 */
export function readerFor(actor: Actor): Reader {
  return {
    staff: actor.staff,
    personIds:
      actor.impersonating || actor.personId === actor.signedInPersonId ? [actor.personId] : [actor.personId, actor.signedInPersonId],
  };
}

export interface CorrectionDeps {
  db: Kysely<Database>;
  /** The connection that applies the sample overlay; absent in an instance that cannot. */
  conn?: DuckDBConnection;
  /** The connection that writes trap samples entered in Beeline. */
  printWriter?: DuckDBConnection;
  /** The connection that derives elevation and areas; falls back to `conn`. */
  mintConn?: DuckDBConnection;
  correctionsPath: string;
  sampleOverlayPath: string;
  samplePaths: { log: string; state: string };
  derivePaths?: { demDir?: string; gazetteerPath?: string };
  /** True while the nightly pipeline or the weekly sweep runs, the two jobs that rewrite samples wholesale. */
  syncJobRunning: () => boolean;
}

// Distributes over the union, so each refusal is its own member and a switch on `refusal` narrows the result.
type Refused<Why extends string> = Why extends string ? { ok: false; refusal: Why } : never;
type Invalid = Refused<"invalid"> & { problem: string };
type Unresolved = Refused<"unresolved"> & { reason: string };

/** The refusals every write shares. */
type Common = Refused<"impersonating" | "not_found">;
type StaffOnly = Refused<"not_admin">;

const refused = <Why extends string>(refusal: Why): Refused<Why> => ({ ok: false, refusal }) as Refused<Why>;

/** The sample's own overlay or corrections write, as it answers, reduced to what a caller needs. */
function overlayRefusal(result: StaffLocalityResult | QcDecisionResult): Invalid | Unresolved | null {
  if (result.outcome === "invalid") return { ok: false, refusal: "invalid", problem: result.problem };
  if (result.outcome === "unresolved") return { ok: false, refusal: "unresolved", reason: result.reason };
  return null;
}

/**
 * Record what just changed, credited to whoever made it — the fact a later
 * pass over the store could never recover (ADR 0007). Narrowed to this sample.
 * A failure is reported and left for the next pass; the log records and never
 * gates the change.
 */
async function recordChange(
  deps: CorrectionDeps,
  sampleId: number,
  author: string,
  reason: string | undefined,
  what: string,
): Promise<void> {
  try {
    await recordSampleChanges(kyselyReader(deps.db), deps.samplePaths, {
      source: "app",
      author,
      reason,
      where: `s.entity_id = ${sampleId}`,
    });
  } catch (err) {
    console.warn(`could not record the ${what}: ${(err as Error).message}`);
  }
}

/** The change log entry for a trap sample entered in Beeline. */
export async function recordTrapChange(deps: CorrectionDeps, login: string, sampleId: number): Promise<void> {
  try {
    await recordSampleChanges(kyselyReader(deps.db), deps.samplePaths, {
      source: "app",
      author: login,
      where: `s.entity_id = ${sampleId}`,
    });
  } catch (err) {
    console.warn(`could not record the change to trap sample ${sampleId}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// The collector's edit

export interface EditSampleInput {
  /** Absent fields stay untouched (applySampleEdit's contract). */
  values: Partial<Record<EditableFieldName, string>>;
  /** The values the form was rendered with. */
  bases: Partial<Record<EditableFieldName, string>>;
  /** Free text; may be absent. */
  note: string | undefined;
}

export type EditSampleResult =
  | { ok: true; outcome: "saved" | "unchanged" }
  | Refused<"impersonating" | "not_editable" | "no_staging">;

/**
 * A collector edits a sample with no observation. One at a time for the
 * sample: its corrections and the change log (src/app/sample-queue.ts).
 * Impersonation is a way of looking, not of acting (beeline-jjt). The
 * collector gate follows the person acted for, but the author is whoever
 * actually made the edit (beeline-oyl: reach, never credit). The save does
 * not retry on a write conflict (docs/architecture/ingestion-jobs-and-elevation.md).
 */
export function editSample(deps: CorrectionDeps, actor: Actor, sampleId: number, input: Input<EditSampleInput>): Promise<EditSampleResult> {
  const gates = async () => {
    if (actor.impersonating) return refused("impersonating");
    const sample = await loadEditableSample(deps.db, sampleId, actor.personId);
    if (sample === undefined) return refused("not_editable");
    return { ready: sample };
  };
  return correct(sampleId, input, gates, async (sample, form): Promise<EditSampleResult> => {
    const result = await applySampleEdit(deps.db, deps.correctionsPath, sample, {
      values: form.values,
      bases: form.bases,
      note: form.note ?? "",
      author: actor.login,
    });
    if (result.outcome === "no_staging") return refused("no_staging");
    // Record what just changed, credited to whoever typed it. Narrowed to
    // this sample, so the author is charged with this sample's pending
    // differences and no other sample's; in the rare case another writer
    // changed THIS sample and failed to record, that change rides along
    // under this author's name — the cost of recording state rather than
    // intent, and bounded to one sample by the narrowing. A failure here is
    // reported and left for the next pass, which attributes the edit to
    // itself — the author and reason are not lost with it, because
    // applySampleEdit durably wrote them to the corrections overlay before
    // the store was touched. The log records; it never gates the edit.
    if (result.outcome === "saved") {
      try {
        const recorded = await recordSampleChanges(kyselyReader(deps.db), deps.samplePaths, {
          source: "app",
          author: actor.login,
          reason: form.note?.trim() || undefined,
          where: `s.entity_id = ${sample.entity_id}`,
        });
        // A missing snapshot turns this pass into the baseline, which
        // records the edit as part of "the corpus as it stands" — no entry,
        // no author. Say so: silence here would hide that the one fact no
        // later pass can recover went unrecorded (the corrections overlay
        // still holds it, durably, from applySampleEdit).
        if (recorded.baselined) {
          console.warn(
            `sample edit by '${actor.login}' fell on a missing snapshot and was baselined, not recorded; ` +
              `the corrections overlay carries the attribution`,
          );
        }
      } catch (err) {
        console.warn(`could not record the sample edit: ${(err as Error).message}`);
      }
    }
    return { ok: true, outcome: result.outcome };
  });
}

// ---------------------------------------------------------------------------
// Adopting a suggested locality, and the place editor

export interface AdoptLocalityInput {
  /** The name the reader saw and is adopting. */
  locality: string;
  /** The reason written with the adoption, from how the rule named it. */
  reasonFor: (basis: LocalitySuggestion["basis"]) => string;
}

export type AdoptLocalityResult =
  | { ok: true; reason: string }
  | Common
  | Refused<"printed" | "set_by_other" | "changed" | "no_staging">
  | Invalid
  | Unresolved;

/**
 * A collector makes the locality Beeline names from the sample's coordinates
 * the sample's own in one click (beeline-7i6). Open to the sample's
 * collectors, through whoever they act for, and to staff; refused while
 * impersonating, and on a printed sample. The value comes from the store,
 * never from the form: the form's copy of the name only proves the reader
 * saw what is adopted.
 */
export function adoptLocality(
  deps: CorrectionDeps,
  actor: Actor,
  sampleId: number,
  input: Input<AdoptLocalityInput>,
): Promise<AdoptLocalityResult> {
  const gates = async () => {
    if (actor.impersonating) return refused("impersonating");
    const sample = await loadSample(deps.db, sampleId, actor.personId, readerFor(actor));
    if (sample === null || (!sample.mine && !actor.staff)) return refused("not_found");
    if (sample.printed) return refused("printed");
    // Who set the locality standing over the observation, if anyone: a
    // locality someone else set stands until they change it, so a collector
    // may not replace it. Staff may replace any. Nothing here reads the form.
    const standing =
      sample.inat_observation_id === null ? null : await standingLocalityAuthor(deps.sampleOverlayPath, sample.inat_observation_id);
    if (standing !== null && standing !== actor.login && !actor.staff) return refused("set_by_other");
    return { ready: sample };
  };
  return correct(sampleId, input, gates, async (sample, form): Promise<AdoptLocalityResult> => {
    const writeDeps = { db: deps.db, conn: deps.conn, sampleOverlayPath: deps.sampleOverlayPath, correctionsPath: deps.correctionsPath };
    const target = { entity_id: sample.sample_id, inat_observation_id: sample.inat_observation_id, locality: sample.locality };
    // The suggestion or one of the alternatives (beeline-4hxe), as the
    // store holds them now, read in this turn and not when the request
    // arrived: a name the page showed that is no longer offered is refused
    // rather than adopted unseen.
    const offered = [...(sample.locality_suggestion === null ? [] : [sample.locality_suggestion]), ...sample.locality_alternatives];
    const suggestion = offered.find((o) => o.locality === form.locality);
    if (suggestion === undefined) return refused("changed");
    const reason = form.reasonFor(suggestion.basis);
    const result = await adoptSuggestedLocality(writeDeps, target, { suggestion: suggestion.locality, reason, author: actor.login });
    const bad = overlayRefusal(result);
    if (bad !== null) return bad;
    if (result.outcome === "no_staging") return refused("no_staging");
    if (result.outcome === "saved" || result.outcome === "removed") {
      await recordChange(deps, sample.sample_id, actor.login, reason, "locality change");
    }
    return { ok: true, reason };
  });
}

export interface SetPlaceInput {
  /** What the place editor's one combobox holds. */
  locality: string;
  reasonFor: (basis: LocalitySuggestion["basis"]) => string;
}

export type SetPlaceResult =
  | { ok: true }
  | Common
  | Refused<"printed" | "not_yours" | "set_by_other" | "only_offered" | "no_staging">
  | Invalid
  | Unresolved;

/**
 * The place editor (beeline-7ywr, beeline-8w8n): what the name is decides
 * what is written. Empty, or the name the observation itself yields, follows
 * iNaturalist again; one of the names offered for the point is adopted; the
 * sample's own locality changes nothing; any other name is written in, which
 * is staff's alone. Staff may change any sample, a collector their own, a
 * collector never over a locality somebody else set, and nobody a printed
 * sample. One at a time for the sample: its corrections, where it has no
 * observation, and the change log (src/app/sample-queue.ts).
 */
export function setPlace(deps: CorrectionDeps, actor: Actor, sampleId: number, input: Input<SetPlaceInput>): Promise<SetPlaceResult> {
  const admin = actor.staff;
  const { conn, printWriter, db } = deps;
  const gates = async () => {
    if (actor.impersonating) return refused("impersonating");
    const sample = await loadSample(db, sampleId, actor.personId, admin ? STAFF_READER : readerFor(actor));
    if (sample === null) return refused("not_found");
    const enteredHere = conn !== undefined && (await loadTrapSample(conn, sample.sample_id)) !== null;
    if (!sample.mine && !admin && !enteredHere) return refused("not_found");
    // A printed sample's locality is what its labels say, so only staff
    // change it, correcting the record before a reprint, as the staff
    // locality form let them (beeline-649). A sample entered in Beeline is
    // refused below whoever asks: its own form refuses it too.
    if (sample.printed && !admin) return refused("printed");
    // A sample entered in Beeline has no old Beeline record to correct: its
    // locality is written directly, by whoever may edit it, any name they
    // like, as on its own form (beeline-3vs.5). Who may edit it does not
    // depend on the form, so that refusal is made before the form is read.
    const trap = enteredHere && conn !== undefined && printWriter !== undefined;
    if (trap && !(await mayEditTrapSample(conn, sample.sample_id, actor.personId, admin))) return refused("not_found");
    return { ready: { sample, trap } };
  };
  return correct(sampleId, input, gates, async ({ sample, trap }, form): Promise<SetPlaceResult> => {
    if (trap && printWriter !== undefined) {
      const name = form.locality.trim();
      // Blank clears it, as on the form.
      if (name === (sample.locality ?? "")) return { ok: true };
      if ((await setTrapSampleLocality(printWriter, sample.sample_id, name)) === "printed") return refused("printed");
      await recordTrapChange(deps, actor.login, sample.sample_id);
      return { ok: true };
    }
    const writeDeps = { db, conn, sampleOverlayPath: deps.sampleOverlayPath, correctionsPath: deps.correctionsPath };
    const target = { entity_id: sample.sample_id, inat_observation_id: sample.inat_observation_id, locality: sample.locality };
    const linked = sample.inat_observation_id !== null;
    const standing = linked ? await standingLocalityAuthor(deps.sampleOverlayPath, sample.inat_observation_id!) : null;
    // What the observation itself yields, as promotion would write it.
    const observed = linked
      ? ((
          await sql<{ locality: string | null }>`SELECT loc.locality FROM sample s
              LEFT JOIN observation_locality loc ON loc.inat_id = s.inat_observation_id
              WHERE s.entity_id = ${sample.sample_id}`.execute(db)
        ).rows[0]?.locality ?? null)
      : null;
    const name = form.locality.trim();
    const offered = [...(sample.locality_suggestion === null ? [] : [sample.locality_suggestion]), ...sample.locality_alternatives];
    const suggestion = offered.find((o) => o.locality === name);
    let result;
    let reason: string | undefined;
    if (linked && (name === "" || name === observed)) {
      // Follow iNaturalist again: take away whatever locality stands.
      if (standing === null) return { ok: true };
      if (standing !== actor.login && !admin) return refused("not_yours");
      result = await setStaffLocality(writeDeps, target, { value: "", remove: true, note: "", author: actor.login });
    } else if (name === "" || name === sample.locality) {
      return { ok: true };
    } else if (suggestion !== undefined) {
      if (standing !== null && standing !== actor.login && !admin) return refused("set_by_other");
      reason = form.reasonFor(suggestion.basis);
      result = await adoptSuggestedLocality(writeDeps, target, { suggestion: suggestion.locality, reason, author: actor.login });
    } else {
      if (!admin) return refused("only_offered");
      result = await setStaffLocality(writeDeps, target, { value: name, remove: false, note: "", author: actor.login });
    }
    const bad = overlayRefusal(result);
    if (bad !== null) return bad;
    if (result.outcome === "no_staging") return refused("no_staging");
    if (result.outcome === "saved" || result.outcome === "removed") {
      await recordChange(deps, sample.sample_id, actor.login, reason, "locality change");
    }
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Staff coordinates

/**
 * What the nightly does for a point that moved, done at once for a point
 * staff just set (beeline-1kb.17.1): the elevation, the areas, and the
 * county, state and country from the point, which follow a staff point
 * printed or not (src/derive-area.ts). Run before the change is logged, so
 * the log credits the staffer with all of it rather than crediting the next
 * night with the county. Never fails the request. Says whether the county and
 * state are now the point's; when not, the page says so, since the nightly
 * may not fix it either (a point in no county, or on the shore across a
 * border).
 */
export async function deriveMovedPoint(deps: CorrectionDeps, sampleId: number, logTag: string): Promise<boolean> {
  const connection = deps.mintConn ?? deps.conn;
  if (connection === undefined) return false;
  const [collector] = (
    await sql<{ inat_user_id: bigint | null }>`SELECT a.inat_user_id FROM sample_primary_collector pc
        JOIN inat_account a ON a.person_id = pc.person_id WHERE pc.sample_id = ${sampleId}`.execute(deps.db)
  ).rows;
  const derived = await withPromotionLock(() =>
    deriveForObserver(connection, {
      // For the locality names only; the areas are found for this sample
      // whoever collected it.
      observerUserId: collector?.inat_user_id == null ? null : Number(collector.inat_user_id),
      demDir: deps.derivePaths?.demDir,
      gazetteerPath: deps.derivePaths?.gazetteerPath,
      stampSampleIds: [sampleId],
      // Asked inside the lock: the nightly may have started while this waited.
      jobRunning: deps.syncJobRunning,
      logTag,
    }),
  );
  return derived.placeSettled;
}

export interface StaffCoordinatesFormInput {
  latitude: string;
  longitude: string;
  uncertainty: string;
  remove: boolean;
  note: string;
}

export type StaffCoordinatesCorrectionResult =
  | {
      ok: true;
      /** False when the county and state are not yet the point's. */
      settled: boolean;
    }
  | Common
  | StaffOnly
  | Refused<"no_observation" | "busy">
  | Invalid
  | Unresolved;

/**
 * Staff put the true point in where the observation yields none, or take it
 * away (beeline-942). Staff only, refused while impersonating, and refused
 * while the nightly or the weekly sweep runs, since the job's own area step
 * may already have passed and the county and state would then wait a day
 * with nothing on the page saying so.
 */
export function setCoordinates(
  deps: CorrectionDeps,
  actor: Actor,
  sampleId: number,
  input: Input<StaffCoordinatesFormInput>,
): Promise<StaffCoordinatesCorrectionResult> {
  const gates = async () => {
    if (actor.impersonating) return refused("impersonating");
    if (!actor.staff) return refused("not_admin");
    const sample = await loadSample(deps.db, sampleId, actor.personId, STAFF_READER);
    if (sample === null) return refused("not_found");
    if (sample.inat_observation_id === null) return refused("no_observation");
    if (deps.syncJobRunning()) return refused("busy");
    return { ready: sample };
  };
  return correct(sampleId, input, gates, async (sample, form): Promise<StaffCoordinatesCorrectionResult> => {
    const result = await setStaffCoordinates(
      { db: deps.db, conn: deps.conn, sampleOverlayPath: deps.sampleOverlayPath, correctionsPath: deps.correctionsPath },
      { entity_id: sample.sample_id, inat_observation_id: sample.inat_observation_id, locality: sample.locality },
      { ...form, author: actor.login },
    );
    const bad = overlayRefusal(result);
    if (bad !== null) return bad;
    let settled = true;
    if (result.outcome === "saved" || result.outcome === "removed") {
      settled = await deriveMovedPoint(deps, sample.sample_id, "staff coordinates");
      await recordChange(deps, sample.sample_id, actor.login, form.note.trim() || undefined, "coordinate change");
    }
    return { ok: true, settled };
  });
}

export interface TakeObservationLocationInput {
  /** Free text; may be blank. */
  note: string;
  /** The reason written when the note is blank. */
  defaultReason: string;
}

export type TakeObservationLocationCorrectionResult =
  | { ok: true; settled: boolean }
  | Common
  | StaffOnly
  | Refused<"unavailable" | "busy" | "not_moved">
  | Invalid
  | Unresolved;

/**
 * Staff take the observation's location for a sample Beeline printed, after
 * the collector moved the pin on iNaturalist (beeline-1kb.17.1, GitHub #298):
 * the point, and the country, state and county with it. Then what the nightly
 * would do for the moved point, at once, because a reprint is the next thing
 * staff do and would otherwise print the old point's elevation.
 */
export function takeLocation(
  deps: CorrectionDeps,
  actor: Actor,
  sampleId: number,
  input: Input<TakeObservationLocationInput>,
): Promise<TakeObservationLocationCorrectionResult> {
  const gates = async () => {
    if (actor.impersonating) return refused("impersonating");
    if (!actor.staff) return refused("not_admin");
    const conn = deps.conn;
    if (conn === undefined) return refused("unavailable");
    const sample = await loadSample(deps.db, sampleId, actor.personId, STAFF_READER);
    if (sample === null) return refused("not_found");
    if (deps.syncJobRunning()) return refused("busy");
    return { ready: { sample, conn } };
  };
  return correct(sampleId, input, gates, async ({ sample, conn }, form): Promise<TakeObservationLocationCorrectionResult> => {
    const note = form.note.trim();
    const reason = note === "" ? form.defaultReason : note;
    const result = await takeObservationLocation(
      { db: deps.db, conn, sampleOverlayPath: deps.sampleOverlayPath, correctionsPath: deps.correctionsPath },
      { entity_id: sample.sample_id, inat_observation_id: sample.inat_observation_id, locality: sample.locality },
      { reason, author: actor.login },
    );
    const bad = overlayRefusal(result);
    if (bad !== null) return bad;
    if (result.outcome === "unchanged") return refused("not_moved");
    const settled = await deriveMovedPoint(deps, sample.sample_id, "take observation location");
    await recordChange(deps, sample.sample_id, actor.login, reason, "location change");
    return { ok: true, settled };
  });
}

// ---------------------------------------------------------------------------
// Holds and waivers

export type QcDecisionCorrectionResult =
  | { ok: true }
  | Common
  | StaffOnly
  | Refused<"unavailable" | "no_observation">
  | Invalid
  | Unresolved;

/**
 * Staff hold a sample back from printing, or waive a blocking flag they judge
 * fine (beeline-plu, beeline-1kb.9). Admin-gated, refused while impersonating,
 * kept in the sample overlay and applied at once, and recorded in the
 * sample's history under whoever did it.
 */
function decideQc<Form extends { note: string }>(
  deps: CorrectionDeps,
  actor: Actor,
  sampleId: number,
  input: Input<Form>,
  decide: (
    writeDeps: { conn: DuckDBConnection; sampleOverlayPath: string },
    sample: { entity_id: number; inat_observation_id: bigint | null },
    author: string,
    form: Form,
  ) => Promise<QcDecisionResult>,
): Promise<QcDecisionCorrectionResult> {
  const gates = async () => {
    if (actor.impersonating) return refused("impersonating");
    if (!actor.staff) return refused("not_admin");
    const conn = deps.conn;
    if (conn === undefined) return refused("unavailable");
    const sample = await loadSample(deps.db, sampleId, actor.personId, STAFF_READER);
    if (sample === null) return refused("not_found");
    return { ready: { sample, conn } };
  };
  return correct(sampleId, input, gates, async ({ sample, conn }, form): Promise<QcDecisionCorrectionResult> => {
    const result = await decide(
      { conn, sampleOverlayPath: deps.sampleOverlayPath },
      { entity_id: sample.sample_id, inat_observation_id: sample.inat_observation_id },
      actor.login,
      form,
    );
    if (result.outcome === "invalid") return { ok: false, refusal: "invalid", problem: result.problem };
    if (result.outcome === "no_observation") return refused("no_observation");
    if (result.outcome === "unresolved") return { ok: false, refusal: "unresolved", reason: result.reason };
    await recordChange(deps, sample.sample_id, actor.login, form.note.trim() || undefined, `change to sample ${sample.sample_id}`);
    return { ok: true };
  });
}

export function holdSample(
  deps: CorrectionDeps,
  actor: Actor,
  sampleId: number,
  input: Input<{ lift: boolean; note: string }>,
): Promise<QcDecisionCorrectionResult> {
  return decideQc(deps, actor, sampleId, input, (writeDeps, sample, author, form) =>
    setHold(writeDeps, sample, { lift: form.lift, note: form.note, author }),
  );
}

export function waiveFlag(
  deps: CorrectionDeps,
  actor: Actor,
  sampleId: number,
  input: Input<{ rule: string; remove: boolean; note: string }>,
): Promise<QcDecisionCorrectionResult> {
  return decideQc(deps, actor, sampleId, input, (writeDeps, sample, author, form) =>
    setWaiver(writeDeps, sample, { rule: form.rule, remove: form.remove, note: form.note, author }),
  );
}
