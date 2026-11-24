import { en } from "./messages/en.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { kyselyReader } from "../person-change.js";
import { recordSampleChanges, type SampleChangeSource } from "../sample-change.js";
import { setSampleMethodRow } from "../sample-method-row.js";
import { loadTrapSample, mayEditTrapSample, setTrapSampleLocality, startMoveHolder } from "../trap-sample.js";
import { deriveForObserver } from "./inat-check.js";
import { STAFF_READER, type Reader } from "./listings.js";
import {
  adoptSuggestedLocality,
  mayHoldStaffPoint,
  setStaffCoordinates,
  setStaffLocality,
  standingLocalityAuthor,
  takeObservationLocation,
  type StaffPointResult,
} from "./locality-override.js";
import { hostAnchor, inatHostTaxonReader, judgeHostTaxon, parseTaxonRef, setStaffHost, type HostChoice, type HostProblem, type HostTaxon, type HostTaxonReader } from "./host-override.js";
import { withPrintRunLock } from "../print-run.js";
import { isWriteConflict } from "../write-conflict.js";
import { withPromotionLock } from "./promotion-lock.js";
import { setHold, setWaiver, type QcDecisionResult } from "./qc-decisions.js";
import { loadSample, type LocalitySuggestion } from "./record.js";
import { applySampleEdit, loadEditableSample, planSampleEdit, type EditableFieldName, type EditableSample } from "./sample-edit.js";
import { setStaffCollectors, type CollectorLine } from "./sample-collectors.js";
import { heldByUnprintedRun, setStaffPlace, type PlaceChange, type PlaceField } from "./sample-place.js";
import { setSampleMethod, type MethodInput, type MethodResult } from "./sample-method.js";
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
  /**
   * The door the request came through. It is recorded as the `source` of the
   * history entries the correction makes. Absent means a page.
   */
  via?: "page" | "api" | "upload";
}

/** The `source` a correction's history entries carry: `app` for a page, `api` for the API, `upload` for an uploaded samples file. */
const sourceOf = (actor: Actor): SampleChangeSource => (actor.via === "api" ? "api" : actor.via === "upload" ? "upload" : "app");

/**
 * What a correction did, as the writer reported it: it wrote a value, took one
 * away, or found nothing to change. An API says it so that a program need not
 * read the sample again to find out.
 */
export type Outcome = "saved" | "removed" | "unchanged";

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
 *
 * A caller that already holds the input (an API, which has parsed its
 * request) skips steps 1 and 2: there is no form to save reading, and the
 * correction takes its turn at once, in the same tick it was called. That
 * matters for order. A turn is taken when the form is in hand, so two page
 * requests that arrive within a few tens of milliseconds of each other may
 * be applied in either order, as two requests racing over a network may
 * anyway; but a program that sends one correction and then another, without
 * waiting, has them applied in the order it sent them.
 */
async function correct<Ready, Form, Result extends { ok: boolean }, Refusal extends { ok: false }>(
  sampleId: number,
  input: Input<Form>,
  gates: () => Promise<{ ready: Ready } | Refusal>,
  act: (ready: Ready, form: Form) => Promise<Result>,
): Promise<Result | Refusal> {
  const turn = (form: Form) =>
    onSample(sampleId, async (): Promise<Result | Refusal> => {
      const now = await gates();
      if (!("ready" in now)) return now;
      return act(now.ready, form);
    });
  // No await before the turn is taken, or call order would not be turn order.
  if (typeof input !== "function") return turn(input);
  const early = await gates();
  if (!("ready" in early)) return early;
  return turn(await resolveInput(input));
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
  /** Reads one taxon from iNaturalist for a floral host being set; iNaturalist's API unless a test injects one. */
  hostTaxon?: HostTaxonReader;
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
function overlayRefusal(result: StaffPointResult | QcDecisionResult): Invalid | Unresolved | null {
  if (result.outcome === "invalid") return { ok: false, refusal: "invalid", problem: result.problem };
  if (result.outcome === "unresolved") return { ok: false, refusal: "unresolved", reason: result.reason };
  return null;
}

/** What a write that was not refused did. Call it only after `overlayRefusal` and the other refusals have been handled. */
const outcomeOf = (result: StaffPointResult | QcDecisionResult): Outcome =>
  result.outcome === "saved" || result.outcome === "removed" ? result.outcome : "unchanged";

/**
 * Record what just changed, credited to whoever made it — the fact a later
 * pass over the store could never recover (ADR 0007). Narrowed to this sample.
 * A failure is reported and left for the next pass; the log records and never
 * gates the change.
 */
async function recordChange(
  deps: CorrectionDeps,
  sampleId: number,
  actor: Actor,
  reason: string | undefined,
  what: string,
): Promise<boolean> {
  try {
    await recordSampleChanges(kyselyReader(deps.db), deps.samplePaths, {
      source: sourceOf(actor),
      author: actor.login,
      reason,
      where: `s.entity_id = ${sampleId}`,
    });
    return true;
  } catch (err) {
    console.warn(`could not record the ${what}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * The change log entry for a trap sample entered in Beeline. `created` is for
 * the save that made the sample: it is then entered in its history as
 * arriving, under whoever entered it, where the pass would otherwise leave a
 * sample it has no record of to the nightly (beeline-7r0g).
 */
export async function recordTrapChange(
  deps: Pick<CorrectionDeps, "db" | "samplePaths">,
  login: string,
  sampleId: number,
  { source = "app", created = false, reason }: { source?: SampleChangeSource; created?: boolean; reason?: string } = {},
): Promise<void> {
  try {
    await recordSampleChanges(kyselyReader(deps.db), deps.samplePaths, {
      source,
      author: login,
      reason,
      where: `s.entity_id = ${sampleId}`,
      created,
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
  /**
   * Work out what the edit would change, through the same rules and in the
   * same turn of the sample's queue, and write nothing: no overlay row, no
   * change to the sample, no history entry (beeline-pnqr.6). Only an API
   * asks for it.
   */
  dryRun?: boolean;
  /** The sentence for a method that is not on the list, naming the methods that are (the catalogue's `unlistedMethod`). */
  unlistedMethodProblem: (methods: readonly string[]) => string;
}

/** One field an edit changes: its value now, and the value after. A cleared field is null. */
export interface FieldChange {
  field: EditableFieldName;
  from: string | null;
  to: string | null;
}

export type EditSampleResult =
  | {
      ok: true;
      /** `would_save` is the answer to a dry run that found something to change. */
      outcome: "saved" | "unchanged" | "would_save";
      /** The fields changed, or that a dry run would change. */
      changes: FieldChange[];
    }
  | Refused<"impersonating" | "not_editable" | "no_staging" | "not_applied">
  | Invalid;

/** The changes an edit makes to these fields, as the plan and the writer both trim them. */
function fieldChanges(sample: EditableSample, fields: EditableFieldName[], values: EditSampleInput["values"]): FieldChange[] {
  return fields.map((field) => {
    const submitted = (values[field] ?? "").trim();
    return { field, from: sample[field], to: submitted === "" ? null : submitted };
  });
}

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
    const edit = { values: form.values, bases: form.bases, note: form.note ?? "", author: actor.login };
    if (form.dryRun === true) {
      const plan = await planSampleEdit(deps.db, sample, edit);
      if (plan.outcome === "no_staging") return refused("no_staging");
      if (plan.outcome === "unlisted_method") return { ok: false, refusal: "invalid", problem: form.unlistedMethodProblem(plan.methods) };
      if (plan.outcome === "unchanged") return { ok: true, outcome: "unchanged", changes: [] };
      return { ok: true, outcome: "would_save", changes: fieldChanges(sample, plan.changed, form.values) };
    }
    let result;
    try {
      result = await applySampleEdit(deps.db, deps.correctionsPath, sample, edit);
    } catch (err) {
      // The sample has old records, so the corrections file already holds the change and nothing applies it later.
      if (isWriteConflict(err)) return refused("not_applied");
      throw err;
    }
    if (result.outcome === "no_staging") return refused("no_staging");
    if (result.outcome === "unlisted_method") return { ok: false, refusal: "invalid", problem: form.unlistedMethodProblem(result.methods) };
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
          source: sourceOf(actor),
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
    return {
      ok: true,
      outcome: result.outcome,
      changes: result.outcome === "saved" ? fieldChanges(sample, result.changed, form.values) : [],
    };
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
  | { ok: true; outcome: Outcome; reason: string }
  | Common
  | Refused<"printed" | "set_by_other" | "changed" | "no_staging" | "not_applied">
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
    if (result.outcome === "not_applied") return refused("not_applied");
    const bad = overlayRefusal(result);
    if (bad !== null) return bad;
    if (result.outcome === "no_staging") return refused("no_staging");
    if (result.outcome === "saved" || result.outcome === "removed") {
      await recordChange(deps, sample.sample_id, actor, reason, "locality change");
    }
    return { ok: true, outcome: outcomeOf(result), reason };
  });
}

export interface SetPlaceInput {
  /** What the place editor's one combobox holds. */
  locality: string;
  reasonFor: (basis: LocalitySuggestion["basis"]) => string;
  /**
   * Why, where the caller says (the samples upload names itself): kept with a locality that is written in, and as the
   * history's reason where the writer has none of its own. The pages and the API give none, so their records are as before.
   */
  note?: string;
}

export type SetPlaceResult =
  | { ok: true; outcome: Outcome }
  | Common
  | Refused<"printed" | "not_yours" | "set_by_other" | "only_offered" | "no_staging" | "not_applied">
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
    // A sample entered in Beeline has no old Beeline record to correct: its
    // locality is written directly, by whoever may edit it, any name they
    // like, as on its own form (beeline-3vs.5). Who may edit it does not
    // depend on the form, so that refusal is made before the form is read.
    // It comes before the printed check: a person who may not edit the sample
    // is told it is not found, and "printed" would say that it exists.
    const trap = enteredHere && conn !== undefined && printWriter !== undefined;
    if (trap && !(await mayEditTrapSample(conn, sample.sample_id, actor.personId, admin))) return refused("not_found");
    // A printed sample's locality is what its labels say, so only staff
    // change it, correcting the record before a reprint, as the staff
    // locality form let them (beeline-649). A sample entered in Beeline is
    // refused below whoever asks: its own form refuses it too.
    if (sample.printed && !admin) return refused("printed");
    return { ready: { sample, trap } };
  };
  return correct(sampleId, input, gates, async ({ sample, trap }, form): Promise<SetPlaceResult> => {
    if (trap && printWriter !== undefined) {
      const name = form.locality.trim();
      // Blank clears it, as on the form.
      if (name === (sample.locality ?? "")) return { ok: true, outcome: "unchanged" };
      if ((await setTrapSampleLocality(printWriter, sample.sample_id, name)) === "printed") return refused("printed");
      await recordTrapChange(deps, actor.login, sample.sample_id, { source: sourceOf(actor), reason: form.note?.trim() || undefined });
      return { ok: true, outcome: "saved" };
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
      if (standing === null) return { ok: true, outcome: "unchanged" };
      if (standing !== actor.login && !admin) return refused("not_yours");
      result = await setStaffLocality(writeDeps, target, { value: "", remove: true, note: "", author: actor.login });
    } else if (name === "" || name === sample.locality) {
      return { ok: true, outcome: "unchanged" };
    } else if (suggestion !== undefined) {
      if (standing !== null && standing !== actor.login && !admin) return refused("set_by_other");
      // The adoption's own reason, with the caller's note beside it where there is one (the samples upload names itself).
      reason = [form.reasonFor(suggestion.basis), form.note?.trim() ? `(${form.note.trim()})` : ""].filter((x) => x !== "").join(" ");
      result = await adoptSuggestedLocality(writeDeps, target, { suggestion: suggestion.locality, reason, author: actor.login });
    } else {
      if (!admin) return refused("only_offered");
      result = await setStaffLocality(writeDeps, target, { value: name, remove: false, note: form.note?.trim() ?? "", author: actor.login });
    }
    if (result.outcome === "not_applied") return refused("not_applied");
    const bad = overlayRefusal(result);
    if (bad !== null) return bad;
    if (result.outcome === "no_staging") return refused("no_staging");
    if (result.outcome === "saved" || result.outcome === "removed") {
      await recordChange(deps, sample.sample_id, actor, reason ?? (form.note?.trim() || undefined), "locality change");
    }
    return { ok: true, outcome: outcomeOf(result) };
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
      outcome: Outcome;
      /** False when the county and state are not yet the point's. */
      settled: boolean;
    }
  | Common
  | StaffOnly
  | Refused<"no_observation" | "busy" | "in_print_run">
  | Invalid
  | Unresolved;

/**
 * Staff put the true point in, or take it away (beeline-942): where the
 * observation yields none or the wrong one, or on a sample with no
 * observation, one built from old records or entered in Beeline
 * (beeline-kgyd.4.2). Refused for a sample that is none of these, which has
 * nothing to keep a point against. Staff only, refused while impersonating, and refused
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
    if (!(await mayHoldStaffPoint(deps, { entity_id: sample.sample_id, inat_observation_id: sample.inat_observation_id, locality: sample.locality }))) {
      return refused("no_observation");
    }
    if (deps.syncJobRunning()) return refused("busy");
    return { ready: sample };
  };
  return correct(sampleId, input, gates, async (sample, form): Promise<StaffCoordinatesCorrectionResult> => {
    const result = await setStaffCoordinates(
      { db: deps.db, conn: deps.conn, printWriter: deps.printWriter, sampleOverlayPath: deps.sampleOverlayPath, correctionsPath: deps.correctionsPath },
      { entity_id: sample.sample_id, inat_observation_id: sample.inat_observation_id, locality: sample.locality },
      { ...form, author: actor.login },
    );
    if (result.outcome === "in_print_run") return refused("in_print_run");
    // Nothing was recorded anywhere, so nothing was done: say so, as the trap count does.
    if (result.outcome === "conflict") return refused("busy");
    const bad = overlayRefusal(result);
    if (bad !== null) return bad;
    let settled = true;
    if (result.outcome === "saved" || result.outcome === "removed") {
      // Recorded straight after the write, and again after deriving. The
      // derivation waits for "Check iNaturalist now" if one is running, and
      // that check ends with a pass over every sample's history under no
      // author; were this entry left until after, that pass would take the
      // staff point for its own. The second entry credits the elevation and
      // county that follow to the same person, and writes nothing if nothing
      // more changed.
      const note = form.note.trim() || undefined;
      await recordChange(deps, sample.sample_id, actor, note, "coordinate change");
      settled = await deriveMovedPoint(deps, sample.sample_id, "staff coordinates");
      await recordChange(deps, sample.sample_id, actor, note, "coordinate change");
    }
    return { ok: true, outcome: outcomeOf(result), settled };
  });
}

export interface TrapCountInput {
  /** The number of traps, a positive whole number as text or a number; blank takes the count away. */
  count: string | number;
  note: string;
  /** The sentence for each way a count is refused, from the message catalogue (`trapCountProblemFor`). */
  problemFor: (problem: "count" | "net" | "method") => string;
}

export type TrapCountResult =
  | { ok: true; outcome: Outcome; /** The trap count now held; null when none. */ trap_count: number | null }
  | Common
  | StaffOnly
  | Refused<"busy">
  | Invalid;

/**
 * Staff set how many traps a trap sample had, or take the count away: a blank
 * count clears it. A sample with no method, or a method that is not a trap,
 * has no count to set. Any trap sample may be corrected, printed or not, since
 * nothing prints or exports the count. Staff only, and refused while
 * impersonating.
 *
 * It is written straight to `sample_method.trap_count` and recorded in the
 * sample's history, with no overlay file: a count has no old record to be kept
 * against, and production is never promoted again (ADR 0006). A development
 * store rebuilt from the old records loses it.
 */
export function setTrapCount(deps: CorrectionDeps, actor: Actor, sampleId: number, input: Input<TrapCountInput>): Promise<TrapCountResult> {
  const gates = async () => {
    if (actor.impersonating) return refused("impersonating");
    if (!actor.staff) return refused("not_admin");
    const sample = await deps.db
      .selectFrom("sample")
      .where("entity_id", "=", sampleId)
      .select(["kind", "protocol"])
      .executeTakeFirst();
    if (sample === undefined) return refused("not_found");
    return { ready: sample };
  };
  return correct(sampleId, input, gates, async (sample, form): Promise<TrapCountResult> => {
    const invalid = (problem: string): Invalid => ({ ok: false, refusal: "invalid", problem });
    const given = String(form.count).trim();
    const held = await sql<{ method_code: string; is_trap: boolean; trap_count: number | null }>`
      SELECT m.method_code, d.is_trap, m.trap_count FROM sample_method m JOIN method d ON d.code = m.method_code WHERE m.sample_id = ${sampleId}`.execute(deps.db);
    const stored = held.rows[0];
    if (given !== "") {
      if (!/^[1-9]\d{0,5}$/.test(given)) return invalid(form.problemFor("count"));
      // A count is the count of a method's traps: a sample with no method has none to count, and a method that is not a
      // trap takes none.
      if (stored === undefined) return invalid(form.problemFor("method"));
      if (!stored.is_trap) return invalid(form.problemFor("net"));
    }
    const count = given === "" ? null : Number(given);
    // Nothing to take away from a sample with no method row.
    if (stored === undefined || stored.trap_count === count) return { ok: true, outcome: "unchanged", trap_count: stored?.trap_count ?? null };
    try {
      await deps.db.transaction().execute((trx) => setSampleMethodRow(trx, sampleId, stored.method_code, count));
    } catch (err) {
      // Nothing is recorded anywhere else, so a conflict means nothing was done: say so, and let the caller send it again.
      if (isWriteConflict(err)) return refused("busy");
      throw err;
    }
    await recordChange(deps, sampleId, actor, form.note.trim() || undefined, "trap count change");
    return { ok: true, outcome: count === null ? "removed" : "saved", trap_count: count };
  });
}

// ---------------------------------------------------------------------------
// How and when a sample was collected

export type MethodProblem = Extract<MethodResult, { outcome: "invalid" }>["problem"];

export interface SetMethodInput {
  /** The code of the method chosen from the list, or the sample's method as written unchanged (`setSampleMethod`). */
  protocol: string;
  /** The day collecting ended; blank for a net sample collected on one day. */
  dateEnd: string;
  /** The day collecting started; absent where the caller does not offer it. */
  dateStart?: string;
  note: string;
  /** Today where the program is, YYYY-MM-DD. */
  today: string;
  /** What the caller saw, so that a touched field somebody changed since is refused (`setSampleMethod`). */
  bases?: MethodInput["bases"];
  /** The sentence for each way the method or dates are refused as invalid; for an unlisted method, with the codes that may be chosen. */
  problemFor: (problem: MethodProblem, methods: readonly string[]) => string;
}

export type SetMethodResult =
  | { ok: true; outcome: "saved" | "unchanged" }
  | Common
  | StaffOnly
  | Refused<"in_print_run" | "no_old_records" | "conflict" | "not_applied">
  | (Refused<"number_taken"> & { number: string })
  | Invalid;

/**
 * Staff correct how a sample was collected, from the method page or from an uploaded samples file: the method's words
 * and the days. The rules are in src/app/sample-method.ts; what is added here is what its callers each did for
 * themselves: the sample's turn of the queue with the history entry before the turn ends, the print runs' lock, a
 * refusal while a print run that has not printed holds the sample (its labels froze the method and dates), and a
 * refusal when a start day that moves would give the sample's plain number to a day its collector already holds it
 * on. Staff only.
 */
export function setMethod(deps: CorrectionDeps, actor: Actor, sampleId: number, input: Input<SetMethodInput>): Promise<SetMethodResult> {
  const gates = async () => {
    if (actor.impersonating) return refused("impersonating");
    if (!actor.staff) return refused("not_admin");
    const found = await deps.db.selectFrom("sample").where("entity_id", "=", sampleId).select("entity_id").executeTakeFirst();
    if (found === undefined) return refused("not_found");
    return { ready: null };
  };
  return correct(sampleId, input, gates, (_, form): Promise<SetMethodResult> =>
    withPrintRunLock(async (): Promise<SetMethodResult> => {
      const { db } = deps;
      const now = await db.selectFrom("sample").where("entity_id", "=", sampleId).select(["kind", "sample_number", "date_start", "protocol"]).executeTakeFirst();
      if (now === undefined) return refused("not_found");
      if (await heldByUnprintedRun(db, sampleId)) return refused("in_print_run");
      // A start day that moves puts the sample's plain number on another day of its collector, which may already hold it; a series number is held to its program, which a day does not change. A start day the form left as it was is no move (startMoveHolder), and the method decides nothing, so a sample that already shares its number stays editable.
      const writer = deps.printWriter ?? deps.conn;
      const toStart = form.dateStart?.trim() ?? "";
      // Touched as setSampleMethod reads it: against the form's base where it has one, else against the stored day. An untouched day keeps the stored one, whatever the form still shows.
      const baseStart = form.bases?.dateStart?.trim();
      const storedStart = (await sql<{ d: string }>`SELECT strftime(date_start, '%Y-%m-%d') AS d FROM sample WHERE entity_id = ${sampleId}`.execute(db)).rows[0]?.d;
      const startTouched = toStart !== (baseStart ?? storedStart);
      if (startTouched && /^\d{4}-\d{2}-\d{2}$/.test(toStart) && writer !== undefined && (await startMoveHolder(writer, sampleId, toStart)) !== null) {
        return { ok: false, refusal: "number_taken", number: now.sample_number };
      }
      const saved = await setSampleMethod(db, deps.correctionsPath, sampleId, {
        protocol: form.protocol,
        dateStart: form.dateStart,
        dateEnd: form.dateEnd,
        note: form.note,
        author: actor.login,
        today: form.today,
        bases: form.bases,
      });
      switch (saved.outcome) {
        case "saved":
          await recordChange(deps, sampleId, actor, form.note.trim() || undefined, "method change");
          return { ok: true, outcome: "saved" };
        case "unchanged":
          return { ok: true, outcome: "unchanged" };
        case "invalid":
          return { ok: false, refusal: "invalid", problem: form.problemFor(saved.problem, saved.methods ?? []) };
        case "no_old_records":
        case "conflict":
        case "not_applied":
          return refused(saved.outcome);
      }
    }),
  );
}

export interface SamplePlaceInput {
  /** The fields to change, from country, state_province and county; absent ones stay. */
  values: Partial<Record<PlaceField, string>>;
  note: string;
}

export type SamplePlaceResult =
  | { ok: true; outcome: Outcome; /** What changed, the atlas included where a new state moved it. */ changes: PlaceChange[] }
  | Common
  | StaffOnly
  | Refused<"follows_point" | "in_print_run" | "busy" | "not_applied">
  | Invalid;

/**
 * Staff correct the country, state and county a sample was collected in
 * (beeline-kgyd.4.3): any sample, printed or not, except one whose place
 * follows its point, which the nightly would write over, and one whose labels
 * a print run that has not printed holds. Staff only, refused while
 * impersonating. The rules and where the change is kept are in
 * src/app/sample-place.ts.
 */
export function setSamplePlace(deps: CorrectionDeps, actor: Actor, sampleId: number, input: Input<SamplePlaceInput>): Promise<SamplePlaceResult> {
  const gates = async () => {
    if (actor.impersonating) return refused("impersonating");
    if (!actor.staff) return refused("not_admin");
    const found = await deps.db.selectFrom("sample").where("entity_id", "=", sampleId).select("entity_id").executeTakeFirst();
    if (found === undefined) return refused("not_found");
    // Asked again in the queue turn: a job may have started while this waited for it (CodeRabbit).
    if (deps.syncJobRunning()) return refused("busy");
    return { ready: null };
  };
  return correct(sampleId, input, gates, async (_, form): Promise<SamplePlaceResult> => {
    const note = form.note.trim();
    const result = await setStaffPlace(deps.db, deps.correctionsPath, sampleId, { values: form.values, note, author: actor.login });
    switch (result.outcome) {
      case "not_found":
      case "follows_point":
      case "in_print_run":
      case "not_applied":
        return refused(result.outcome);
      // Nothing was recorded anywhere, so nothing was done: say so, as the trap count does.
      case "conflict":
        return refused("busy");
      case "invalid":
        return { ok: false, refusal: "invalid", problem: result.problem };
      case "unchanged":
        return { ok: true, outcome: "unchanged", changes: [] };
      case "saved":
        await recordChange(deps, sampleId, actor, note || undefined, "place change");
        return { ok: true, outcome: "saved", changes: result.changes };
      default:
        return unreachable(result);
    }
  });
}

export interface CollectorsCorrectionInput {
  /** Names or references in order, the first being the primary collector (src/collector-match.ts). */
  collectors: readonly string[];
  note: string;
  /** Answer as a save would, and write nothing. */
  dryRun?: boolean;
}

export type CollectorsCorrectionResult =
  | {
      ok: true;
      /** `would_save` for a dry run that would have saved, as the collector's edit says. */
      outcome: "saved" | "unchanged" | "would_save";
      dry_run: boolean;
      collectors: CollectorLine[];
      first_changed: boolean;
      /** Labels on paper that print the old list; 0 when nothing changed. */
      reprint_needed: number;
      warnings: string[];
    }
  | Common
  | StaffOnly
  | Refused<"in_print_run" | "number_taken" | "observation_tied" | "conflict" | "busy" | "not_applied" | "unavailable">
  | Invalid;

/**
 * Staff correct who collected a sample (beeline-kgyd.4.5): add, remove and
 * reorder its collectors, the first included. Staff only, refused while
 * impersonating. The rules, what the first collector carries and where the
 * change is kept are in src/app/sample-collectors.ts. Nothing is reprinted
 * here: the answer says how many labels on paper print the old list.
 */
export function setCollectors(
  deps: CorrectionDeps,
  actor: Actor,
  sampleId: number,
  input: Input<CollectorsCorrectionInput>,
): Promise<CollectorsCorrectionResult> {
  const gates = async () => {
    if (actor.impersonating) return refused("impersonating");
    if (!actor.staff) return refused("not_admin");
    const found = await deps.db.selectFrom("sample").where("entity_id", "=", sampleId).select("entity_id").executeTakeFirst();
    if (found === undefined) return refused("not_found");
    // Asked again in the queue turn: a job may have started while this waited for it.
    if (deps.syncJobRunning()) return refused("busy");
    return { ready: null };
  };
  return correct(sampleId, input, gates, async (_, form): Promise<CollectorsCorrectionResult> => {
    const note = form.note.trim();
    const dryRun = form.dryRun === true;
    const result = await setStaffCollectors(
      { conn: deps.conn, printWriter: deps.printWriter, correctionsPath: deps.correctionsPath },
      sampleId,
      { collectors: form.collectors, note, author: actor.login, dryRun },
    );
    switch (result.outcome) {
      case "not_found":
      case "unavailable":
      case "in_print_run":
      case "number_taken":
      case "observation_tied":
      case "not_applied":
        return refused(result.outcome);
      case "changed":
        return refused("conflict");
      // Nothing was recorded anywhere, so nothing was done: say so, as the trap count does.
      case "write_conflict":
        return refused("busy");
      case "invalid":
        return { ok: false, refusal: "invalid", problem: result.problem };
      case "unchanged":
        return { ok: true, outcome: "unchanged", dry_run: dryRun, collectors: result.collectors, first_changed: false, reprint_needed: 0, warnings: [] };
      case "planned":
      case "saved": {
        if (result.outcome === "saved") await recordChange(deps, sampleId, actor, note || undefined, "collector change");
        const { outcome, ...rest } = result;
        return { ok: true, outcome: outcome === "planned" ? "would_save" : "saved", dry_run: dryRun, ...rest };
      }
      default:
        return unreachable(result);
    }
  });
}

/**
 * Write a release of a sample for printing, unless one stands
 * (beeline-3vs.7): a row of its own in `sample_print_release_event`, with who,
 * when and the reason staff gave, if any. Written for any sample with no
 * standing release (never released, or its release was withdrawn), in an
 * active season too, where it changes nothing yet: a count staff set prints
 * whatever its season (Peter, 2026-11-19), so it must still print if the
 * sample settles on 1 March before a run takes it. A release already standing
 * writes nothing; says whether a row was written. In the transaction of
 * whatever made it.
 */
async function writeRelease(db: Kysely<Database>, sampleId: number, actor: Actor, reason: string): Promise<boolean> {
  const why = reason.trim() === "" ? null : reason.trim();
  const written = await sql<{ entity_id: number }>`
    INSERT INTO sample_print_release_event (sample_id, action, person_id, reason)
    SELECT s.entity_id, 'release', ${actor.signedInPersonId}, CAST(${why} AS TEXT)
    FROM sample s
    WHERE s.entity_id = ${sampleId} AND NOT EXISTS (SELECT 1 FROM sample_print_release r WHERE r.sample_id = s.entity_id)
    RETURNING entity_id`.execute(db);
  return written.rows.length > 0;
}

export interface SpecimenCountInput {
  /** The number of specimens, a whole number of 0 or more as text or a number. */
  count: string | number;
  note: string;
  /** The sentence for each way a count is refused, from the message catalogue (`specimenCountProblemFor`); `numbered` takes the highest place already numbered. */
  problemFor: (problem: "count" | "net" | "follows" | "numbered", number?: number) => string;
}

export type SpecimenCountResult =
  | {
      ok: true;
      outcome: Exclude<Outcome, "removed">;
      specimen_count: number;
      /** How many labels the next print run would print for this sample. 0 can mean the sample is not released (a settled season's sample prints only once released), is released and waiting for the nightly to place it (`awaiting_place`), or is held back by a flag. */
      pending: number;
      /** A release was written by this request (the count changed on a sample with no standing release). */
      released: boolean;
      /** The sample is released and waits for the nightly update to work out its county and state before it prints. */
      awaiting_place: boolean;
    }
  | Common
  | StaffOnly
  | Refused<"busy">
  | Invalid;

/**
 * Staff correct how many specimens a trap sample holds (`sample.specimen_count`),
 * printed or not. Raising it makes the next print run number the extra bees
 * (the freeze creates specimens for the places in 1..count that no individuated
 * specimen holds, schema/150); lowering it below the highest place already
 * numbered is refused. On a printed sample with an iNaturalist observation the
 * `count_mismatch` flag stands afterwards, which is expected. A sample whose
 * count still follows its observation is refused, because the next promotion
 * would put the observation's count back (ingest/mint-samples.sql): any
 * sample with an observation, until its labels are on paper. Staff
 * only, and refused while impersonating.
 *
 * A count that changes also releases the sample for printing
 * (sample_print_release_event, schema/050; beeline-3vs.7), in any season:
 * staff setting a count is staff saying its bees need labels, a settled
 * season's sample prints only once released, and an active one may settle
 * before a run takes it. The count and the release event are
 * written in one transaction. A count equal to the one it has changes nothing
 * and releases nothing; the release is its own act (`releaseLabels`). A
 * released sample that follows its point is not pending until the nightly has
 * placed it (sample_awaiting_place, schema/150), so there is no place to stamp
 * here.
 *
 * It is written straight to the sample and recorded in its history, with no
 * overlay file: production is never promoted again (ADR 0006), and a
 * development store rebuilt from the old records loses it. The check and the
 * write run behind the print runs' lock, because a run's freeze creates
 * specimens behind it and could otherwise slip between the two.
 */
export function setSpecimenCount(deps: CorrectionDeps, actor: Actor, sampleId: number, input: Input<SpecimenCountInput>): Promise<SpecimenCountResult> {
  const gates = async () => {
    if (actor.impersonating) return refused("impersonating");
    if (!actor.staff) return refused("not_admin");
    const sample = await deps.db.selectFrom("sample").where("entity_id", "=", sampleId).select(["kind"]).executeTakeFirst();
    if (sample === undefined) return refused("not_found");
    return { ready: sample };
  };
  return correct(sampleId, input, gates, async (sample, form): Promise<SpecimenCountResult> => {
    const invalid = (problem: string): Invalid => ({ ok: false, refusal: "invalid", problem });
    const given = String(form.count).trim();
    if (!/^(0|[1-9]\d{0,5})$/.test(given)) return invalid(form.problemFor("count"));
    if (sample.kind !== "trap") return invalid(form.problemFor("net"));
    const count = Number(given);
    // The promotion lock first, then the print runs' lock: promotion can free-link an
    // observation onto the sample (and so make its count follow the observation) between
    // reading whether the count follows one and writing the new count, and the stamp inside
    // a promotion takes the print runs' lock, so the other order could deadlock.
    return withPromotionLock(() => withPrintRunLock(async (): Promise<SpecimenCountResult> => {
      const found = await sql<{ specimen_count: number | null; follows: boolean; highest: number | null }>`
        SELECT s.specimen_count,
               (s.inat_observation_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)) AS follows,
               (SELECT max(i.specimen_number) FROM individuated_specimen i WHERE i.sample_id = s.entity_id) AS highest
        FROM sample s WHERE s.entity_id = ${sampleId}`.execute(deps.db);
      const now = found.rows[0];
      if (now === undefined) return refused("not_found");
      // The next promotion would put the observation's count back, so a count set here would be undone overnight.
      // Any observation, not only one whose count promotion follows today: one with a count of zero or junk
      // is followed again as soon as the volunteer fixes it, and that would undo this write without a word.
      if (now.follows) return invalid(form.problemFor("follows"));
      const highest = now.highest === null ? 0 : Number(now.highest);
      if (count < highest) return invalid(form.problemFor("numbered", highest));
      const answer = async (outcome: "saved" | "unchanged", released: boolean): Promise<SpecimenCountResult> => ({
        ok: true,
        outcome,
        specimen_count: count,
        pending: await pendingNow(deps.db, sampleId),
        released,
        awaiting_place: await awaitingPlace(deps.db, sampleId),
      });
      if (now.specimen_count === count) return answer("unchanged", false);
      let released = false;
      try {
        await deps.db.transaction().execute(async (trx) => {
          await trx.updateTable("sample").set({ specimen_count: count }).where("entity_id", "=", sampleId).execute();
          released = await writeRelease(trx, sampleId, actor, form.note);
        });
      } catch (err) {
        // Nothing is recorded anywhere else, so a conflict means nothing was done: say so, and let the caller send it again.
        if (isWriteConflict(err)) return refused("busy");
        throw err;
      }
      await recordChange(deps, sampleId, actor, form.note.trim() || undefined, "specimen count change");
      return answer("saved", released);
    }));
  });
}

/** How many labels the next print run would print for a sample: 0 when it is not released, is released and waiting for the nightly to place it, or is held back by a flag. */
async function pendingNow(db: Kysely<Database>, sampleId: number): Promise<number> {
  const waiting = await sql<{ pending_count: number }>`SELECT pending_count FROM pending_print_sample WHERE sample_id = ${sampleId}`.execute(db);
  return waiting.rows[0] === undefined ? 0 : Number(waiting.rows[0].pending_count);
}

/** Whether the sample is released and waiting for the nightly's county stamp (sample_awaiting_place, schema/150). */
async function awaitingPlace(db: Kysely<Database>, sampleId: number): Promise<boolean> {
  const found = await sql<{ w: boolean }>`SELECT EXISTS (SELECT 1 FROM sample_awaiting_place w WHERE w.sample_id = ${sampleId}) AS w`.execute(db);
  return Boolean(found.rows[0]?.w);
}

export interface ReleaseLabelsInput {
  /** Why staff released it, or withdrew the release; free text, may be blank. */
  note: string;
  /** Take the release away instead of writing one. */
  withdraw?: boolean;
}

export type ReleaseLabelsResult =
  | {
      ok: true;
      outcome: "saved" | "removed" | "unchanged";
      /** How many labels the next print run would print for this sample; 0 while it waits to be placed (`awaiting_place`), is not released, or is held back by a flag. */
      pending: number;
      /** A release was written by this request. */
      released: boolean;
      /** The sample is released and waits for the nightly update to work out its county and state before it prints. */
      awaiting_place: boolean;
    }
  | Common
  | StaffOnly
  | Refused<"busy" | "count_follows_observation" | "labels_in_run">;

/**
 * Staff say that a sample from a settled season may print its labels, or take
 * that back (beeline-3vs.7, `sample_print_release_event`, schema/050). Trap
 * bottles are pinned years after they were collected, and a settled season's
 * sample prints only once released; changing a trap sample's count, or entering
 * one, releases it as well (`setSpecimenCount`, the trap form), and this is the
 * explicit act for the rest. Staff only, refused while impersonating. It does
 * not refuse while the nightly or the weekly sweep runs, as a staff point does:
 * a release is one new row that no job rewrites, and the API already refuses
 * every correction while one runs.
 *
 * A release is allowed in any season: in January and February last season is
 * still active, and staff may release a sample ahead of 1 March, when it
 * would otherwise stop printing. Releasing one whose count still follows its
 * iNaturalist observation (an observation, and no label on paper, the
 * condition `setSpecimenCount` refuses as `follows`) is refused: a settled
 * season's count copied from iNaturalist does not print (Peter, 2026-11-19),
 * and staff cannot correct that count, so there is nothing for them to vouch
 * for. Releasing a sample already released, and withdrawing one that is not,
 * write nothing and answer `unchanged`.
 *
 * A release is checked and written behind the promotion lock, because
 * observation promotion can free-link an observation onto the sample between
 * the two, which would make its count follow iNaturalist's. Locks are taken
 * in one order everywhere: the sample's turn in the queue, then the promotion
 * lock, then the print runs' lock (a promotion's county stamp takes the last).
 *
 * A release is a plain write. A released sample whose county, state and country
 * follow its point is not pending until the nightly's county stamp has placed
 * it (sample_awaiting_place, schema/150); one that does not follow its point
 * is pending at once. A sample released from the 250 m allowance is held to
 * 100 m like an active one.
 *
 * Withdrawing is allowed at any time but while the sample's labels are in a
 * print run that has not printed, which would keep them (`labels_in_run`):
 * cancel the run first, or let it print. The check and the write are behind
 * the print runs' lock, so a run cannot be prepared between them. Nothing else
 * in this function takes that lock, so there is no re-entrancy to guard.
 *
 * The sample's history tracks no field that a release changes, so it is not a
 * history entry of its own.
 */
export function releaseLabels(deps: CorrectionDeps, actor: Actor, sampleId: number, input: Input<ReleaseLabelsInput>): Promise<ReleaseLabelsResult> {
  const gates = async () => {
    if (actor.impersonating) return refused("impersonating");
    if (!actor.staff) return refused("not_admin");
    const found = await deps.db.selectFrom("sample").where("entity_id", "=", sampleId).select("entity_id").executeTakeFirst();
    if (found === undefined) return refused("not_found");
    return { ready: null };
  };
  return correct(sampleId, input, gates, async (_, form): Promise<ReleaseLabelsResult> => {
    const note = form.note.trim();
    const why = note === "" ? null : note;
    const answer = async (outcome: "saved" | "removed" | "unchanged"): Promise<ReleaseLabelsResult> => ({
      ok: true,
      outcome,
      pending: await pendingNow(deps.db, sampleId),
      released: outcome === "saved",
      awaiting_place: await awaitingPlace(deps.db, sampleId),
    });
    try {
      if (form.withdraw === true) {
        const withdrawn = await withPrintRunLock(async (): Promise<"in_run" | "withdrawn" | "none"> => {
          // No standing release: nothing to withdraw, whatever run holds the labels.
          const standing = await sql<{ n: number }>`
            SELECT count(*)::INTEGER AS n FROM sample_print_release r WHERE r.sample_id = ${sampleId}`.execute(deps.db);
          if (Number(standing.rows[0]?.n ?? 0) === 0) return "none";
          const inRun = await sql<{ n: number | null }>`
            SELECT (SELECT lp.printing_count FROM sample_label_in_progress lp WHERE lp.sample_id = ${sampleId}) AS n`.execute(deps.db);
          if (Number(inRun.rows[0]?.n ?? 0) > 0) return "in_run";
          const written = await sql<{ entity_id: number }>`
            INSERT INTO sample_print_release_event (sample_id, action, person_id, reason)
            SELECT r.sample_id, 'withdraw', ${actor.signedInPersonId}, CAST(${why} AS TEXT)
            FROM sample_print_release r WHERE r.sample_id = ${sampleId}
            RETURNING entity_id`.execute(deps.db);
          return written.rows.length > 0 ? "withdrawn" : "none";
        });
        if (withdrawn === "in_run") return refused("labels_in_run");
        return answer(withdrawn === "withdrawn" ? "removed" : "unchanged");
      }
      // Under the promotion lock, so no promotion can link an observation between the check and the write.
      const written = await withPromotionLock(async (): Promise<"follows" | "written" | "stands"> => {
        const state = await sql<{ follows: boolean }>`
          SELECT (SELECT s.inat_observation_id IS NOT NULL
                         AND NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)
                  FROM sample s WHERE s.entity_id = ${sampleId}) AS follows`.execute(deps.db);
        if (state.rows[0]?.follows === true) return "follows";
        return (await writeRelease(deps.db, sampleId, actor, note)) ? "written" : "stands";
      });
      if (written === "follows") return refused("count_follows_observation");
      if (written === "stands") return answer("unchanged");
    } catch (err) {
      // Nothing is recorded anywhere else, so a conflict means nothing was done: say so, and let the caller send it again.
      if (isWriteConflict(err)) return refused("busy");
      throw err;
    }
    return answer("saved");
  });
}

export interface TakeObservationLocationInput {
  /** Free text; may be blank. */
  note: string;
  /** The reason written when the note is blank. */
  defaultReason: string;
}

export type TakeObservationLocationCorrectionResult =
  | { ok: true; outcome: Outcome; settled: boolean }
  | Common
  | StaffOnly
  | Refused<"unavailable" | "busy" | "not_moved" | "in_print_run">
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
      { db: deps.db, conn, printWriter: deps.printWriter, sampleOverlayPath: deps.sampleOverlayPath, correctionsPath: deps.correctionsPath },
      { entity_id: sample.sample_id, inat_observation_id: sample.inat_observation_id, locality: sample.locality },
      { reason, author: actor.login },
    );
    if (result.outcome === "in_print_run") return refused("in_print_run");
    // Nothing was recorded anywhere, so nothing was done: say so, as the trap count does.
    if (result.outcome === "conflict") return refused("busy");
    const bad = overlayRefusal(result);
    if (bad !== null) return bad;
    if (result.outcome === "unchanged") return refused("not_moved");
    // Recorded before and after deriving, for the reason setCoordinates gives.
    await recordChange(deps, sample.sample_id, actor, reason, "location change");
    const settled = await deriveMovedPoint(deps, sample.sample_id, "take observation location");
    await recordChange(deps, sample.sample_id, actor, reason, "location change");
    return { ok: true, outcome: result.outcome === "removed" ? "removed" : "saved", settled };
  });
}

// ---------------------------------------------------------------------------
// Holds and waivers

export type QcDecisionCorrectionResult =
  | { ok: true; outcome: Outcome }
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
    await recordChange(deps, sample.sample_id, actor, form.note.trim() || undefined, `change to sample ${sample.sample_id}`);
    return { ok: true, outcome: result.outcome };
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

// ---------------------------------------------------------------------------
// The floral host

export interface StaffHostFormInput {
  /** The taxon's iNaturalist page address or its number; blank where `none` or `remove` is. */
  taxon: string;
  /** The sample has no floral host. */
  none: boolean;
  /** Take what staff set away and follow iNaturalist again. */
  remove: boolean;
  /** Why. Required to set a host or say there is none; not to remove. */
  note: string;
  /** Check everything, write nothing. */
  dryRun?: boolean;
  /** The sentence for each way a host is refused, from the message catalogue (`hostProblemFor`). */
  problemFor: (problem: HostProblem, replacedBy?: string[]) => string;
}

export type StaffHostCorrectionResult =
  | {
      ok: true;
      /** `would_save` and `would_remove` are the answers to a dry run that found something to change, as the collector's edit says. */
      outcome: Outcome | "would_save" | "would_remove";
      dry_run: boolean;
      /** The host set, or null where there is none or it was taken away. */
      host: HostTaxon | null;
    }
  | Common
  | StaffOnly
  | Refused<"unavailable" | "no_host_key" | "inat_unreachable" | "busy">
  | Invalid
  | Unresolved;

/**
 * Staff set the sample's floral host, say it has none, or go back to following
 * iNaturalist (beeline-hlay). Staff only, refused while impersonating, and
 * for a sample that has an observation or old Beeline records, which a host
 * can be kept against (`hostAnchor`), and while the nightly run or the weekly
 * sweep runs. Unlike the others it reads from
 * iNaturalist, once the form is in hand and before the sample's turn is
 * taken, so the answer is not waited for inside the queue: a request that
 * carries its input as a value therefore does not take its turn "at once"
 * (`correct`), and a program that sends host corrections without waiting for
 * each answer may have them applied in either order.
 */
export function setHost(deps: CorrectionDeps, actor: Actor, sampleId: number, input: Input<StaffHostFormInput>): Promise<StaffHostCorrectionResult> {
  const gates = async () => {
    if (actor.impersonating) return refused("impersonating");
    if (!actor.staff) return refused("not_admin");
    const conn = deps.conn;
    if (conn === undefined) return refused("unavailable");
    const sample = await loadSample(deps.db, sampleId, actor.personId, STAFF_READER);
    if (sample === null) return refused("not_found");
    const target = { entity_id: sample.sample_id, inat_observation_id: sample.inat_observation_id };
    const anchor = await hostAnchor(deps, target);
    if (anchor === null) return refused("no_host_key");
    // As the point's corrections are: the nightly run and the weekly sweep rewrite samples wholesale.
    if (deps.syncJobRunning()) return refused("busy");
    return { ready: { target, anchor, conn } };
  };
  type Checked = { form: StaffHostFormInput; choice: HostChoice } | { form: StaffHostFormInput; refusal: Invalid | Refused<"inat_unreachable"> };
  // Everything that needs the form and not the sample's turn, the read from iNaturalist included.
  const check = async (): Promise<Checked> => {
    const form = await resolveInput(input);
    const invalid = (problem: HostProblem): Checked => ({ form, refusal: { ok: false, refusal: "invalid", problem: form.problemFor(problem) } });
    if (form.remove) return { form, choice: { kind: "remove" } };
    if (form.note.trim() === "") return invalid("reason");
    if (form.none) return form.taxon.trim() === "" ? { form, choice: { kind: "none" } } : invalid("both");
    if (form.taxon.trim() === "") return invalid("taxon_needed");
    const id = parseTaxonRef(form.taxon);
    if (id === null) return invalid("address");
    const judged = await judgeHostTaxon(deps.db, deps.hostTaxon ?? inatHostTaxonReader, id);
    if (judged.ok) return { form, choice: { kind: "taxon", taxon: judged.taxon } };
    if (judged.problem === "unreachable") return { form, refusal: refused("inat_unreachable") };
    return {
      form,
      refusal: { ok: false, refusal: "invalid", problem: form.problemFor(judged.problem, judged.problem === "inactive" ? judged.replacedBy : undefined) },
    };
  };
  return correct(sampleId, check, gates, async ({ target, anchor, conn }, checked): Promise<StaffHostCorrectionResult> => {
    if ("refusal" in checked) return checked.refusal;
    const { form, choice } = checked;
    const dryRun = form.dryRun === true;
    const result = await setStaffHost({ db: deps.db, conn, printWriter: deps.printWriter, sampleOverlayPath: deps.sampleOverlayPath }, target, anchor, {
      choice,
      note: form.note,
      author: actor.login,
      dryRun,
    });
    if (result.outcome === "invalid") return { ok: false, refusal: "invalid", problem: form.problemFor(result.problem) };
    if (result.outcome === "unresolved") return { ok: false, refusal: "unresolved", reason: result.reason };
    if (result.outcome === "unchanged") return { ok: true, outcome: "unchanged", dry_run: dryRun, host: null };
    if (!dryRun) {
      await recordChange(deps, target.entity_id, actor, form.note.trim() || undefined, "floral host change");
    }
    const outcome = !dryRun ? result.outcome : result.outcome === "saved" ? "would_save" : "would_remove";
    return { ok: true, outcome, dry_run: dryRun, host: result.outcome === "saved" ? result.host : null };
  });
}
