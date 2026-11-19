import type { DuckDBConnection } from "@duckdb/node-api";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { kyselyReader } from "../person-change.js";
import { withPrintRunLock } from "../print-run.js";
import { recordSampleChanges } from "../sample-change.js";
import { numberTaken, trapCountOf } from "../trap-sample.js";
import { refusalSentence, type AnyFailure } from "./api-corrections.js";
import { localityReasonFor, specimenCountProblemFor, trapCountProblemFor } from "./correction-reasons.js";
import { NO_POINT_TO_TAKE_AWAY } from "./locality-override.js";
import type { Messages } from "./messages/index.js";
import { fromOldRecords, setSampleMethod } from "./sample-method.js";
import {
  setCollectors,
  setCoordinates,
  setPlace,
  setSamplePlace,
  setSpecimenCount,
  setTrapCount,
  type Actor,
  type CorrectionDeps,
} from "./sample-corrections.js";
import { setStaffCollectors } from "./sample-collectors.js";
import { followsItsPoint, heldByUnprintedRun } from "./sample-place.js";
import { onSample } from "./sample-queue.js";

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
    }
  | { unit: "trap_count"; /** Blank takes the count away. */ count: string }
  | { unit: "specimen_count"; count: string }
  /** The people the names came to, in order, the first being the primary. */
  | { unit: "collectors"; ids: number[] }
  | { unit: "coordinates"; latitude: string; longitude: string; uncertainty: string; remove: boolean }
  /** `values` are the fields that differ, and `file` is what the file says of all three. */
  | { unit: "area"; values: Partial<AreaValues>; file: AreaValues }
  | { unit: "place"; locality: string };

/** What is stored with a queued change: the file's version of the sample, the change, and the cells it came from, for the notes. */
export interface QueuedUnit {
  /** The sample's `sampleVersion` in the file, which the sample must still have when its row is first worked on. */
  version: string;
  change: UnitChange;
  cells: Array<{ column: string; was: string; fileSays: string }>;
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

// --- Predicting refusals ---------------------------------------------------

/** What the preview knows of a sample before anything changes it. */
export interface SampleFacts {
  id: number;
  number: string;
  kind: "net" | "trap";
  protocol: string;
  hasObservation: boolean;
  /** It was entered in Beeline. */
  entered: boolean;
}

export interface PredictEnv {
  db: Kysely<Database>;
  conn: DuckDBConnection;
  messages: Messages;
}

const isPrinted = async (db: Kysely<Database>, id: number): Promise<boolean> =>
  Boolean((await sql<{ e: boolean }>`SELECT EXISTS (SELECT 1 FROM printed_sample WHERE sample_id = ${id}) AS e`.execute(db)).rows[0]?.e);

const failure = (refusal: string): string => refusalSentence({ ok: false, refusal } as AnyFailure);

/**
 * What the corrections would say to each change of a row, where that can be known without making it: the same
 * predicates they ask, in the order the job applies the row. A change a correction would refuse is not queued, and its
 * sentence is shown. What depends on a write that has not happened (the collectors after new dates, the place after a
 * new point) is left to the job, which asks again as it goes. The method and the kind of sample a method change would
 * leave are carried along, since a trap count is refused on a net sample unless the dates make it a trap sample.
 */
export async function predictRefusals(env: PredictEnv, facts: SampleFacts, changes: readonly UnitChange[]): Promise<Map<ChangeUnit, string | null>> {
  const { db, conn, messages } = env;
  const out = new Map<ChangeUnit, string | null>();
  let kind = facts.kind;
  let protocol = facts.protocol;
  const byUnit = new Map(changes.map((c) => [c.unit, c]));
  const inRun = () => heldByUnprintedRun(db, facts.id);
  for (const unit of APPLY_ORDER) {
    const change = byUnit.get(unit);
    if (change === undefined) continue;
    let refusal: string | null = null;
    switch (change.unit) {
      case "method_dates": {
        const problems = messages.record.sample.methodEdit.problems;
        const oldRecords = facts.entered ? false : await fromOldRecords(db, facts.id);
        if (!facts.entered && !oldRecords) refusal = messages.record.sample.methodEdit.noOldRecords;
        else if (change.startDiffers && facts.hasObservation) refusal = problems.start_observation;
        else if (facts.entered && change.protocol.trim() === "") refusal = problems.method_required;
        else if (await inRun()) refusal = messages.uploads.changes.methodInPrintRun;
        else if (!facts.entered && kind === "net" && kindAfterMethod(kind, facts.entered, change) === "trap" && (await numberTaken(conn, facts.number, facts.id))) {
          refusal = messages.uploads.changes.becomesTrapNumberTaken(facts.number);
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
        else if (planned.outcome === "in_print_run" || planned.outcome === "number_taken" || planned.outcome === "observation_tied") refusal = failure(planned.outcome);
        break;
      }
      case "coordinates": {
        // A point is kept against an observation, old records or an entry in Beeline, and a sample with none has nothing to keep it against.
        if (!facts.hasObservation && !facts.entered && !(await fromOldRecords(db, facts.id))) refusal = failure("no_observation");
        else if (change.remove && !facts.hasObservation) refusal = NO_POINT_TO_TAKE_AWAY;
        else if (await inRun()) refusal = failure("in_print_run");
        break;
      }
      case "area": {
        // Where the point changes too, the place follows the new point and the job says so; it is not asked here.
        if (byUnit.has("coordinates") && out.get("coordinates") === null) break;
        if (await inRun()) refusal = failure("in_print_run");
        else if (await followsItsPoint(db, facts.id)) refusal = failure("follows_point");
        break;
      }
      case "place": {
        if (facts.entered && ((await inRun()) || (await isPrinted(db, facts.id)))) refusal = failure("printed");
        break;
      }
    }
    out.set(unit, refusal);
  }
  return out;
}

// --- Applying one change ---------------------------------------------------

/** What happened to a change: made, nothing to do, refused with a sentence, left alone with one, or the run must stop. */
export type UnitResult =
  | { outcome: "applied" | "unchanged" }
  | { outcome: "refused" | "skipped"; detail: string }
  /** A lost write conflict or a running sync job: not a refusal. The change stays pending and the upload stops there. */
  | { outcome: "stop"; why: string };

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
function fromCorrection(result: { ok: true; outcome: string } | { ok: false; refusal: string }): UnitResult {
  if (result.ok) return { outcome: result.outcome === "unchanged" ? "unchanged" : "applied" };
  if (result.refusal === "busy" || result.refusal === "not_applied") return { outcome: "stop", why: result.refusal };
  return { outcome: "refused", detail: refusalSentence(result as AnyFailure) };
}

const placeText = (p: { country: string | null; state_province: string | null; county: string | null }, m: Messages) =>
  m.uploads.changes.placeName((p.country ?? "").trim(), (p.state_province ?? "").trim(), (p.county ?? "").trim());

/** The method and dates, in the sample's turn and behind the print runs' lock, with the history entry taken before the turn ends. */
async function applyMethod(env: ApplyEnv, ctx: UnitContext, change: Extract<UnitChange, { unit: "method_dates" }>): Promise<UnitResult> {
  const { db, correctionsPath, samplePaths } = env.corrective;
  const id = ctx.sampleId;
  const m = env.messages;
  return onSample(id, () =>
    withPrintRunLock(async (): Promise<UnitResult> => {
      const now = await db.selectFrom("sample").where("entity_id", "=", id).select(["kind", "sample_number"]).executeTakeFirst();
      if (now === undefined) return { outcome: "refused", detail: m.uploads.changes.sampleGone };
      // setSampleMethod asks neither: a method change is refused while a run that has not printed holds the sample.
      if (await heldByUnprintedRun(db, id)) return { outcome: "refused", detail: m.uploads.changes.methodInPrintRun };
      const entered = (await db.selectFrom("sample_entry").where("sample_id", "=", id).select("sample_id").executeTakeFirst()) !== undefined;
      const kind = now.kind === "trap" ? "trap" : "net";
      // A single day on a trap sample is sent as start and end both, so it stays a trap sample: a blank end makes a net sample.
      const stays = entered || kind === "trap" || !change.single;
      // A net sample that the dates make a trap sample must not take a trap sample's number.
      const writer = env.corrective.printWriter ?? env.corrective.conn;
      if (writer === undefined) throw new Error("applying a change of method needs a connection");
      if (!entered && kind === "net" && stays && (await numberTaken(writer, now.sample_number, id))) {
        return { outcome: "refused", detail: m.uploads.changes.becomesTrapNumberTaken(now.sample_number) };
      }
      const saved = await setSampleMethod(db, correctionsPath, id, {
        protocol: change.protocol,
        dateStart: change.start,
        dateEnd: stays ? change.end : "",
        note: ctx.note,
        author: ctx.actor.login,
        today: env.today,
      });
      switch (saved.outcome) {
        case "saved":
          try {
            await recordSampleChanges(kyselyReader(db), samplePaths, { source: "upload", author: ctx.actor.login, reason: ctx.note, where: `s.entity_id = ${id}` });
          } catch (err) {
            console.warn(`could not record the method change: ${(err as Error).message}`);
          }
          return { outcome: "applied" };
        case "unchanged":
          return { outcome: "unchanged" };
        case "invalid":
          return { outcome: "refused", detail: m.record.sample.methodEdit.problems[saved.problem] };
        case "no_old_records":
          return { outcome: "refused", detail: m.record.sample.methodEdit.noOldRecords };
        case "conflict":
          return { outcome: "refused", detail: m.record.sample.methodEdit.conflict };
        case "not_applied":
          return { outcome: "stop", why: "not_applied" };
      }
    }),
  );
}

/**
 * Apply one queued change through its correction, from outside any turn of the sample's queue (the corrections take
 * their own, and the queue does not nest). The method is the exception that is given a turn here, as its route does.
 */
export async function applyUnit(env: ApplyEnv, ctx: UnitContext, change: UnitChange): Promise<UnitResult> {
  const deps = env.corrective;
  const id = ctx.sampleId;
  const m = env.messages;
  switch (change.unit) {
    case "method_dates": {
      const result = await applyMethod(env, ctx, change);
      if (result.outcome !== "applied" && result.outcome !== "unchanged") return result;
      // An old sample's effort is not rewritten by a method change: write the count again so that its words name the new method.
      if (change.protocolDiffers && (await fromOldRecords(deps.db, id))) {
        const effort = (await deps.db.selectFrom("sample").where("entity_id", "=", id).select("sampling_effort").executeTakeFirst())?.sampling_effort ?? null;
        const count = trapCountOf(effort);
        if (count !== null) {
          const again = await setTrapCount(deps, ctx.actor, id, { count: String(count), note: ctx.note, problemFor: trapCountProblemFor(m) });
          // Best effort: a refusal (a net sample has no count) leaves the effort as it was; a conflict stops the upload as any does.
          if (!again.ok && again.refusal === "busy") return { outcome: "stop", why: "busy" };
        }
      }
      return result;
    }
    case "trap_count":
      return fromCorrection(await setTrapCount(deps, ctx.actor, id, { count: change.count, note: ctx.note, problemFor: trapCountProblemFor(m) }));
    case "specimen_count":
      return fromCorrection(await setSpecimenCount(deps, ctx.actor, id, { count: change.count, note: ctx.note, problemFor: specimenCountProblemFor(m) }));
    case "collectors":
      return fromCorrection(await setCollectors(deps, ctx.actor, id, { collectors: change.ids.map(String), note: ctx.note }));
    case "coordinates":
      return fromCorrection(
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
      return fromCorrection(await setSamplePlace(deps, ctx.actor, id, { values: change.values, note: ctx.note }));
    }
    case "place":
      return fromCorrection(await setPlace(deps, ctx.actor, id, { locality: change.locality, reasonFor: localityReasonFor(m), note: ctx.note }));
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
  if (typeof q?.version !== "string" || q.version === "") return { unreadable: "no version" };
  const change = q.change as { unit?: unknown } | undefined;
  if (typeof change !== "object" || change === null || !(APPLY_ORDER as readonly unknown[]).includes(change.unit)) return { unreadable: "no change" };
  if (!Array.isArray(q.cells)) return { unreadable: "no cells" };
  return q as QueuedUnit;
}
