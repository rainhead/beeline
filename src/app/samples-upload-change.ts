import type { DuckDBConnection } from "@duckdb/node-api";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { numberTaken, trapCountOf, trapEffort } from "../trap-sample.js";
import { refusalSentence, type AnyFailure } from "./api-corrections.js";
import { localityReasonFor, specimenCountProblemFor, trapCountProblemFor } from "./correction-reasons.js";
import { NO_POINT_TO_TAKE_AWAY } from "./locality-override.js";
import type { Messages } from "./messages/index.js";
import { fromOldRecords } from "./sample-method.js";
import {
  setCollectors,
  setCoordinates,
  setMethod,
  setPlace,
  setSamplePlace,
  setSpecimenCount,
  setTrapCount,
  type Actor,
  type CorrectionDeps,
} from "./sample-corrections.js";
import { setStaffCollectors } from "./sample-collectors.js";
import { followsItsPoint, heldByUnprintedRun } from "./sample-place.js";

/**
 * Changing an existing sample from a row of an uploaded samples file (beeline-kgyd.4.11): what each kind of change is
 * as it is queued, how the preview predicts that a correction will refuse it, and how the job applies it. The job
 * applies each through the correction the pages and the API use, so every rule and every record is theirs, with the
 * uploader as the actor and a note naming the upload. See docs/architecture/loading-an-edited-download.md.
 */

/**
 * The order the kinds of change are applied to one sample, which is not the order the page lists them in. The method
 * and dates come first because the kind of sample they leave decides whether the counts can be set; the counts come
 * before the collectors, whose checks read the number and dates; the point comes before the country, state and county,
 * which follow it; the locality is independent of the rest and goes last.
 */
export const APPLY_ORDER = ["method_dates", "trap_count", "specimen_count", "collectors", "coordinates", "area", "place"] as const;
export type ChangeUnit = (typeof APPLY_ORDER)[number];

/** A place as the store keeps it: the country as its three letters, the state as its code, the county's name or blank. */
export interface AreaValues {
  country: string;
  state_province: string;
  county: string;
}

/** What one kind of change would write, worked out when the file was read, so that applying writes exactly this. */
export type UnitChange =
  | {
      unit: "method_dates";
      /** The method in the file's words. */
      protocol: string;
      /** The days the file says, a single day having `end` equal to `start`. */
      start: string;
      end: string;
      single: boolean;
      protocolDiffers: boolean;
      startDiffers: boolean;
      /** The method before, which an old sample's effort text names. */
      wasProtocol: string;
      /** What Beeline said when the file was downloaded, as the method page's form would show it: the bases a correction refuses a change against. */
      bases: { protocol: string; start: string; end: string };
      /**
       * For a sample built from old records whose effort text is exactly its trap count and its old method: the text
       * it becomes, since `setSampleMethod` does not rewrite it there and the job does after the method is applied.
       * Null where nothing is rewritten.
       */
      effortBecomes: string | null;
    }
  | { unit: "trap_count"; /** Blank takes the count away. */ count: string }
  | { unit: "specimen_count"; count: string }
  /** The people the names came to, in order, the first being the primary. */
  | { unit: "collectors"; ids: number[] }
  | { unit: "coordinates"; latitude: string; longitude: string; uncertainty: string; remove: boolean }
  /** `values` are the fields that differ, and `file` is what the file says of all three. */
  | { unit: "area"; values: Partial<AreaValues>; file: AreaValues }
  | { unit: "place"; locality: string };

/**
 * What is stored with a queued change: the change, and every cell of its kind that the file has, with what Beeline said
 * when the file was downloaded (`was`). Each change is compared with what Beeline holds right before it is made.
 */
export interface QueuedUnit {
  change: UnitChange;
  cells: Array<{ column: string; was: string; fileSays: string; differs: boolean }>;
}

/** The metres between two points, by the haversine formula. */
export function distanceMetres(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** The kind of sample a method change leaves: a trap sample stays one, a net sample becomes one when the file gives it more than a day. */
export const kindAfterMethod = (kind: "net" | "trap", entered: boolean, change: { single: boolean }): "net" | "trap" =>
  entered || kind === "trap" || !change.single ? "trap" : "net";

/** What the preview knows of a sample before anything changes it. */
export interface SampleFacts {
  id: number;
  number: string;
  kind: "net" | "trap";
  protocol: string;
  hasObservation: boolean;
  /** It was entered in Beeline. */
  entered: boolean;
  /** The effort as the old records wrote it, or null. */
  effort: string | null;
}

// --- Words for refusals ------------------------------------------------------

/** A refusal as a correction gave it. */
export type Refusal = { refusal: string; problem?: string; reason?: string; number?: string };

/**
 * The sentence a person reads for a refusal. The API's table is written for programs ("send the same request again", "this key"),
 * so where it says something untrue to a person, the upload has its own.
 */
export function refusalFor(m: Messages, failure: Refusal, unit: ChangeUnit): string {
  const w = m.uploads.changes;
  switch (failure.refusal) {
    case "invalid":
      return failure.problem ?? "";
    case "unresolved":
      return failure.reason ?? "";
    case "in_print_run":
      return unit === "method_dates" ? m.record.sample.methodEdit.inPrintRun : refusalSentence({ ok: false, refusal: "in_print_run" });
    case "number_taken":
      return failure.number !== undefined ? m.record.sample.methodEdit.numberTaken(failure.number) : refusalSentence({ ok: false, refusal: "number_taken" });
    case "no_old_records":
      return m.record.sample.methodEdit.noOldRecords;
    case "printed":
      return w.localityPrinted;
    case "impersonating":
    case "not_admin":
      return w.noLongerStaff;
    case "not_found":
      return w.sampleGone;
    case "conflict":
      return w.conflict;
    default:
      return refusalSentence({ ok: false, refusal: failure.refusal } as AnyFailure);
  }
}

// --- Predicting refusals ---------------------------------------------------

export interface PredictEnv {
  db: Kysely<Database>;
  conn: DuckDBConnection;
  messages: Messages;
}

/** What the dry run of a collectors change says besides refusing: staff are warned when the first collector changes, and how many labels on paper print the old list. */
export interface CollectorsPreview {
  firstChanged: boolean;
  reprint: number;
  warnings: string[];
}

export interface Prediction {
  /** The sentence a correction would refuse the change with, where that can be known without making it. Shown, never enforced: the job asks the correction itself. */
  refusal: string | null;
  collectors?: CollectorsPreview;
}

const isPrinted = async (db: Kysely<Database>, id: number): Promise<boolean> =>
  Boolean((await sql<{ e: boolean }>`SELECT EXISTS (SELECT 1 FROM printed_sample WHERE sample_id = ${id}) AS e`.execute(db)).rows[0]?.e);

/** The effort text a method change rewrites a sample's to, or null where it rewrites nothing: only an old sample's effort that is exactly its count and its old method. */
export async function effortBecomes(db: Kysely<Database>, facts: SampleFacts, change: Extract<UnitChange, { unit: "method_dates" }>): Promise<string | null> {
  if (facts.entered || !change.protocolDiffers || change.protocol.trim() === "") return null;
  const count = trapCountOf(facts.effort);
  if (count === null || facts.effort !== trapEffort(count, facts.protocol)) return null;
  return (await fromOldRecords(db, facts.id)) ? trapEffort(count, change.protocol.trim()) : null;
}

/**
 * What the corrections would say to each change of a row, where that can be known without making it: the same
 * predicates they ask, in the order the job applies the row, over the kinds that were ticked only (an unticked kind is
 * not made, so it changes nothing for the rest). It is shown to people and never enforced: it ignores the writes of
 * the row that have not happened (collectors are judged against dates a method change of the same row is about to
 * move), and the job asks the correction itself. The kind of sample a method change would leave and the method are
 * carried along, since a trap count is refused on a net sample unless the dates make it a trap sample.
 */
export async function predictRefusals(env: PredictEnv, facts: SampleFacts, changes: readonly UnitChange[], chosen: (unit: ChangeUnit) => boolean): Promise<Map<ChangeUnit, Prediction>> {
  const { db, conn, messages } = env;
  const out = new Map<ChangeUnit, Prediction>();
  let kind = facts.kind;
  let protocol = facts.protocol;
  const byUnit = new Map(changes.map((c) => [c.unit, c]));
  const inRun = () => heldByUnprintedRun(db, facts.id);
  const say = (refusal: string, unit: ChangeUnit) => refusalFor(messages, { refusal }, unit);
  for (const unit of APPLY_ORDER) {
    const change = byUnit.get(unit);
    if (change === undefined) continue;
    if (!chosen(unit)) {
      out.set(unit, { refusal: null });
      continue;
    }
    let refusal: string | null = null;
    let collectors: CollectorsPreview | undefined;
    switch (change.unit) {
      case "method_dates": {
        const problems = messages.record.sample.methodEdit.problems;
        const oldRecords = facts.entered ? false : await fromOldRecords(db, facts.id);
        if (!facts.entered && !oldRecords) refusal = say("no_old_records", unit);
        else if (change.startDiffers && facts.hasObservation) refusal = problems.start_observation;
        else if (facts.entered && change.protocol.trim() === "") refusal = problems.method_required;
        else if (await inRun()) refusal = say("in_print_run", unit);
        else if (!facts.entered && kind === "net" && kindAfterMethod(kind, facts.entered, change) === "trap" && (await numberTaken(conn, facts.number, facts.id))) {
          refusal = messages.record.sample.methodEdit.numberTaken(facts.number);
        }
        if (refusal === null) {
          kind = kindAfterMethod(kind, facts.entered, change);
          protocol = change.protocol.trim();
        }
        break;
      }
      case "trap_count": {
        if (change.count.trim() !== "") {
          if (kind !== "trap") refusal = trapCountProblemFor(messages)("net");
          else if (protocol === "") refusal = trapCountProblemFor(messages)("method");
        }
        break;
      }
      case "specimen_count": {
        if (kind !== "trap") refusal = specimenCountProblemFor(messages)("net");
        else if (facts.hasObservation && !(await isPrinted(db, facts.id))) refusal = specimenCountProblemFor(messages)("follows");
        else {
          const highest = Number((await sql<{ h: number | null }>`SELECT max(specimen_number) AS h FROM individuated_specimen WHERE sample_id = ${facts.id}`.execute(db)).rows[0]?.h ?? 0);
          if (Number(change.count) < highest) refusal = specimenCountProblemFor(messages)("numbered", highest);
        }
        break;
      }
      case "collectors": {
        // The correction's own dry run, on the people the names came to.
        const planned = await setStaffCollectors({ conn, correctionsPath: "" }, facts.id, { collectors: change.ids.map(String), note: "", author: "", dryRun: true });
        if (planned.outcome === "invalid") refusal = planned.problem;
        else if (planned.outcome === "in_print_run" || planned.outcome === "number_taken" || planned.outcome === "observation_tied") refusal = say(planned.outcome, unit);
        else if (planned.outcome === "planned") collectors = { firstChanged: planned.first_changed, reprint: planned.reprint_needed, warnings: planned.warnings };
        break;
      }
      case "coordinates": {
        // A point is kept against an observation, old records or an entry in Beeline, and a sample with none has nothing to keep it against.
        if (!facts.hasObservation && !facts.entered && !(await fromOldRecords(db, facts.id))) refusal = say("no_observation", unit);
        else if (change.remove && !facts.hasObservation) refusal = NO_POINT_TO_TAKE_AWAY;
        else if (await inRun()) refusal = say("in_print_run", unit);
        break;
      }
      case "area": {
        // Where the point changes too, the place follows the new point and the job says so; it is not asked here.
        if (byUnit.has("coordinates") && chosen("coordinates") && out.get("coordinates")?.refusal === null) break;
        if (await inRun()) refusal = say("in_print_run", unit);
        else if (await followsItsPoint(db, facts.id)) refusal = say("follows_point", unit);
        break;
      }
      case "place": {
        if (facts.entered && ((await inRun()) || (await isPrinted(db, facts.id)))) refusal = say("printed", unit);
        break;
      }
    }
    out.set(unit, { refusal, collectors });
  }
  return out;
}

// --- Applying one change ---------------------------------------------------

/** What happened to a change: made, nothing to do, refused with a sentence, left alone with one, or the run must stop. */
export type UnitResult =
  | {
      outcome: "applied";
      /** What the correction said besides saving, for the note (the collectors' warnings). */
      detail?: string;
      /** Work that follows the change once it is recorded as made. It never stops the run: it returns a sentence for the change's note, or null. */
      followUp?: () => Promise<string | null>;
    }
  | { outcome: "unchanged" }
  | { outcome: "refused" | "skipped"; detail: string }
  /** A lost write conflict or a running sync job: not a refusal. The change stays pending and the upload stops there. */
  | { outcome: "stop"; why: "busy" | "not_applied" };

export interface ApplyEnv {
  corrective: CorrectionDeps;
  messages: Messages;
  /** Oregon's today, for the method's date rules. */
  today: string;
}

export interface UnitContext {
  sampleId: number;
  /** The reason every correction is given, which names the upload. */
  note: string;
  actor: Actor;
  /** What the units of this row that are settled came to, by unit: the area waits on the point. */
  settled: ReadonlyMap<string, string>;
}

/** A correction's answer as the outcome of a change. */
function fromCorrection(env: ApplyEnv, unit: ChangeUnit, result: { ok: true; outcome: string } | ({ ok: false } & Refusal)): UnitResult {
  if (result.ok) return { outcome: result.outcome === "unchanged" ? "unchanged" : "applied" };
  if (result.refusal === "busy" || result.refusal === "not_applied") return { outcome: "stop", why: result.refusal };
  return { outcome: "refused", detail: refusalFor(env.messages, result, unit) };
}

const placeText = (p: { country: string | null; state_province: string | null; county: string | null }, m: Messages) =>
  m.uploads.changes.placeName((p.country ?? "").trim(), (p.state_province ?? "").trim(), (p.county ?? "").trim());

/**
 * After a method change on an old sample, write its effort again with the new method, but only where it is exactly its
 * count and its old method (so "45 minutes" is left alone). Called after the method change is recorded as made, and
 * never stops the run: a failure is a sentence in the method change's note.
 */
async function rewriteEffort(env: ApplyEnv, ctx: UnitContext, change: Extract<UnitChange, { unit: "method_dates" }>): Promise<string | null> {
  const deps = env.corrective;
  const m = env.messages;
  try {
    const effort = (await deps.db.selectFrom("sample").where("entity_id", "=", ctx.sampleId).select("sampling_effort").executeTakeFirst())?.sampling_effort ?? null;
    const count = trapCountOf(effort);
    if (count === null || effort !== trapEffort(count, change.wasProtocol) || change.effortBecomes === null) return null;
    const again = await setTrapCount(deps, ctx.actor, ctx.sampleId, { count: String(count), note: ctx.note, problemFor: trapCountProblemFor(m) });
    if (again.ok) return m.uploads.changes.effortRewritten(change.effortBecomes);
    return m.uploads.changes.effortNotRewritten(again.refusal === "busy" ? m.uploads.changes.effortBusy : again.refusal === "invalid" ? again.problem : refusalFor(m, again, "trap_count"));
  } catch {
    return m.uploads.changes.effortNotRewritten(m.uploads.changes.unexpected);
  }
}

/**
 * Apply one queued change through its correction, from outside any turn of the sample's queue (the corrections take
 * their own, and the queue does not nest).
 */
export async function applyUnit(env: ApplyEnv, ctx: UnitContext, change: UnitChange): Promise<UnitResult> {
  const deps = env.corrective;
  const id = ctx.sampleId;
  const m = env.messages;
  switch (change.unit) {
    case "method_dates": {
      const result = await setMethod(deps, ctx.actor, id, {
        protocol: change.protocol,
        dateStart: change.start,
        // One day is a blank end, which keeps a trap sample a trap sample and a net sample a net sample.
        dateEnd: change.single ? "" : change.end,
        keepTrap: true,
        note: ctx.note,
        today: env.today,
        bases: { protocol: change.bases.protocol, dateStart: change.bases.start, dateEnd: change.bases.end },
        problemFor: (problem) => m.record.sample.methodEdit.problems[problem],
      });
      const done = fromCorrection(env, "method_dates", result);
      return done.outcome === "applied" && change.effortBecomes !== null ? { outcome: "applied", followUp: () => rewriteEffort(env, ctx, change) } : done;
    }
    case "trap_count":
      return fromCorrection(env, "trap_count", await setTrapCount(deps, ctx.actor, id, { count: change.count, note: ctx.note, problemFor: trapCountProblemFor(m) }));
    case "specimen_count":
      return fromCorrection(env, "specimen_count", await setSpecimenCount(deps, ctx.actor, id, { count: change.count, note: ctx.note, problemFor: specimenCountProblemFor(m) }));
    case "collectors": {
      const result = await setCollectors(deps, ctx.actor, id, { collectors: change.ids.map(String), note: ctx.note });
      const done = fromCorrection(env, "collectors", result);
      // What the real call said: who is now first and how many labels on paper print the old list.
      return done.outcome === "applied" && result.ok && result.warnings.length > 0 ? { outcome: "applied", detail: result.warnings.join(" ") } : done;
    }
    case "coordinates":
      return fromCorrection(
        env,
        "coordinates",
        await setCoordinates(deps, ctx.actor, id, { latitude: change.latitude, longitude: change.longitude, uncertainty: change.uncertainty, remove: change.remove, note: ctx.note }),
      );
    case "area": {
      if (ctx.settled.get("coordinates") === "applied") {
        // The new point decides the place (the nightly writes it from the point, and the correction would be written over),
        // so the file's is not applied: it is compared with what the point gave, and any difference is said.
        const now = await deps.db.selectFrom("sample").where("entity_id", "=", id).select(["country", "state_province", "county"]).executeTakeFirst();
        if (now === undefined) return { outcome: "refused", detail: m.uploads.changes.sampleGone };
        const same = (a: string | null, b: string) => (a ?? "").trim().toUpperCase() === b.trim().toUpperCase();
        const agrees = same(now.country, change.file.country) && same(now.state_province, change.file.state_province) && same(now.county, change.file.county);
        return { outcome: "skipped", detail: m.uploads.changes.areaFollowsPoint(placeText(now, m), agrees ? "" : placeText(change.file, m)) };
      }
      return fromCorrection(env, "area", await setSamplePlace(deps, ctx.actor, id, { values: change.values, note: ctx.note }));
    }
    case "place":
      return fromCorrection(env, "place", await setPlace(deps, ctx.actor, id, { locality: change.locality, reasonFor: localityReasonFor(m), note: ctx.note }));
  }
}

/** What a stored payload holds, if it is the shape the job writes from; otherwise why not. */
export function readQueuedUnit(payload: string | null): QueuedUnit | { unreadable: string } {
  if (payload === null) return { unreadable: "nothing is stored" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    return { unreadable: `not JSON: ${(err as Error).message}` };
  }
  const q = parsed as Partial<QueuedUnit> | null;
  const change = q?.change as { unit?: unknown } | undefined;
  if (typeof change !== "object" || change === null || !(APPLY_ORDER as readonly unknown[]).includes(change.unit)) return { unreadable: "no change" };
  if (!Array.isArray(q?.cells) || !q.cells.every((c) => typeof c?.column === "string" && typeof c.was === "string" && typeof c.fileSays === "string")) return { unreadable: "no cells" };
  return q as QueuedUnit;
}
