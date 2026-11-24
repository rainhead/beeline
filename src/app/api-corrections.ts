import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isWriteConflict } from "../write-conflict.js";
import { apiError, type ApiEnv } from "./api.js";
import { hostProblemFor, localityReasonFor, specimenCountProblemFor, takeLocationDefaultReason, trapCountProblemFor } from "./correction-reasons.js";
import type { Messages } from "./messages/index.js";
import { EDITABLE_FIELDS, type EditableFieldName } from "./sample-edit.js";
import { PLACE_FIELDS, type PlaceField } from "./sample-place.js";
import {
  actorFor,
  editSample,
  holdSample,
  releaseLabels,
  setCollectors,
  setCoordinates,
  setHost,
  setKindFromOldRecordsCorrection,
  setPlace,
  setSamplePlace,
  setSpecimenCount,
  setTrapCount,
  takeLocation,
  unreachable,
  waiveFlag,
  type Actor,
  type AdoptLocalityResult,
  type CollectorsCorrectionInput,
  type CollectorsCorrectionResult,
  type CorrectionDeps,
  type EditSampleInput,
  type EditSampleResult,
  type KindFromOldRecordsInput,
  type KindFromOldRecordsResult,
  type QcDecisionCorrectionResult,
  type ReleaseLabelsInput,
  type ReleaseLabelsResult,
  type SamplePlaceResult,
  type StaffHostCorrectionResult,
  type SetPlaceResult,
  type SpecimenCountResult,
  type StaffCoordinatesCorrectionResult,
  type TakeObservationLocationCorrectionResult,
  type TrapCountResult,
} from "./sample-corrections.js";

/**
 * The sample corrections of the API (beeline-pnqr.6): the ones the pages
 * already allow, made by calling the same functions in
 * src/app/sample-corrections.ts, so every rule, the overlay each one writes
 * and the history entry are the page's. This file reads and checks the JSON
 * body, says who is acting, and turns the function's answer into a status.
 *
 * What a key reaches follows from its scope: `read` corrects nothing, `edit`
 * acts as its person and so reaches that person's own samples, and `staff`
 * acts as staff for as long as its person is staff (the gate in api.ts works
 * that out and leaves it in the request's `staff` variable). A key never acts
 * for somebody else and never impersonates, so those refusals cannot happen.
 */

/** The largest request body any of these endpoints reads. Enough for every field with room to spare. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * The refusals that carry no detail of their own, each with the status and the
 * sentence it is answered with. All of the sentences are here, so a reader sees
 * what a program is told in one place. `invalid` and `unresolved` carry the
 * writer's own words and are answered below.
 */
const REFUSALS = {
  impersonating: { status: 403, error: "forbidden", message: "A key cannot act for somebody else." },
  not_found: { status: 404, error: "not found", message: "No such sample, or it is not one this key may correct." },
  not_editable: {
    status: 404,
    error: "not found",
    message: "No such sample, or it is not one this key may edit: the edit is for the key's own samples that have no iNaturalist observation.",
  },
  not_admin: { status: 403, error: "forbidden", message: "This needs a staff key held by someone who is staff." },
  printed: { status: 409, error: "printed", message: "Labels were printed for this sample, so its locality no longer changes here. Staff correct it." },
  set_by_other: {
    status: 409,
    error: "set_by_other",
    message: "Someone else set this sample's locality, and it stands until they change it. Staff may replace it.",
  },
  not_yours: { status: 409, error: "not_yours", message: "Someone else set this sample's locality, so only they or staff may take it away." },
  only_offered: {
    status: 409,
    error: "only_offered",
    message: "Only one of the names Beeline offers for this sample's point can be chosen. Any other name is for staff.",
  },
  changed: { status: 409, error: "changed", message: "That name is no longer one of the names offered for this sample's point." },
  busy: {
    status: 409,
    error: "busy",
    message: "The nightly run or the weekly sweep is running, and it rewrites samples, so no correction is taken until it ends. Nothing was done. Try again later.",
  },
  not_moved: {
    status: 409,
    error: "not_moved",
    message: "iNaturalist no longer puts this sample anywhere else, so there is nothing to take.",
  },
  no_staging: { status: 409, error: "no_staging", message: "No old Beeline record backs this sample, so a correction has nothing to be kept against." },
  no_observation: {
    status: 409,
    error: "no_observation",
    message: "This sample has no iNaturalist observation, and this correction is kept against one. (A point can also be kept against old Beeline records or an entry in Beeline; this sample has neither.)",
  },
  in_print_run: {
    status: 409,
    error: "in_print_run",
    message:
      "Labels for this sample are in a print run that has not printed yet, which holds the point and place it froze. Wait for the run to print or cancel it, then make the correction.",
  },
  follows_point: {
    status: 409,
    error: "follows_point",
    message:
      "This sample's country, state and county follow its coordinates: Beeline writes them from the point each night, so a correction here would not last. Correct the coordinates instead.",
  },
  not_applied: {
    status: 409,
    error: "recorded_not_applied",
    message:
      "Your change is recorded against the sample's old Beeline records, but Beeline could not finish applying it to the sample because another write to the store got there first. Nothing applies it later on its own: send the same request again, which applies it now and does not record it twice. Like any correction, it replaces what the sample holds at that moment, so if someone else may have corrected the same thing since, check before you send it again.",
  },
  number_taken: {
    status: 409,
    error: "number_taken",
    message:
      "The new first collector already has a sample with this number on this day, and a sample's number is its first collector's for the day. Nothing was done. Correct one of the two samples' numbers first.",
  },
  observation_tied: {
    status: 409,
    error: "observation_tied",
    message:
      "An iNaturalist observation is tied to this sample through its first collector, so Beeline cannot change who that is yet: another observation of theirs could be made into a second sample and its bees labelled twice. Nothing was done. Collectors after the first can still be added, removed and reordered.",
  },
  conflict: {
    status: 409,
    error: "conflict",
    message: "The sample's collectors changed while this request was being worked out. Nothing was done. Read the sample again and send the list you mean.",
  },
  count_follows_observation: {
    status: 409,
    error: "count_follows_observation",
    message:
      "This sample's specimen count comes from its iNaturalist observation, and a past season's count copied from iNaturalist is not printed. Nothing was done.",
  },
  labels_in_run: {
    status: 409,
    error: "labels_in_run",
    message:
      "This sample's labels are in a print run that has not printed, which would keep them. Cancel the run first, or let it print. Nothing was done.",
  },
  no_host_key: {
    status: 409,
    error: "no_host_key",
    message:
      "This sample is not linked to an iNaturalist observation or to old Beeline records. Samples entered in Beeline are trap samples, and a trap's plant is not a floral host.",
  },
  inat_unreachable: {
    status: 503,
    error: "inat_unreachable",
    message: "Beeline could not reach iNaturalist to check that plant. Nothing was done. Try again in a minute.",
  },
  entered_in_beeline: {
    status: 409,
    error: "entered_in_beeline",
    message: "This sample was entered in Beeline, so there are no old records to work its kind out from, and a trap sample entered here stays one. Nothing was done.",
  },
  rule_says_trap: {
    status: 409,
    error: "rule_says_trap",
    message:
      "This sample's old records give trap, and this route only corrects a trap sample to a net sample. Nothing was changed.",
  },
  unavailable: { status: 503, error: "unavailable", message: "This Beeline cannot make this correction." },
} as const satisfies Record<string, { status: ContentfulStatusCode; error: string; message: string }>;

// Every refusal a correction can make. `adoptLocality` has no endpoint of its
// own, since `setPlace` adopts an offered name; it is listed so that the
// switch below also covers its refusals, `changed` among them.
export type AnyFailure = Extract<
  | AdoptLocalityResult
  | EditSampleResult
  | SetPlaceResult
  | StaffCoordinatesCorrectionResult
  | SamplePlaceResult
  | CollectorsCorrectionResult
  | TrapCountResult
  | SpecimenCountResult
  | ReleaseLabelsResult
  | TakeObservationLocationCorrectionResult
  | QcDecisionCorrectionResult
  | StaffHostCorrectionResult
  | KindFromOldRecordsResult,
  { ok: false }
>;

/** A refused correction as the API answers it. The switch ends in `unreachable`, so a new refusal fails the typecheck. */
function refusalResponse(c: Context<ApiEnv>, failure: AnyFailure) {
  // A change recorded and not applied is recorded under the name its answer gives, as the thrown conflict's is.
  c.set("outcome", failure.refusal === "not_applied" ? "recorded_not_applied" : failure.refusal);
  switch (failure.refusal) {
    case "invalid":
      return apiError(c, 422, "invalid", failure.problem);
    case "unresolved":
      return apiError(c, 409, "unresolved", failure.reason);
    case "impersonating":
    case "not_found":
    case "not_editable":
    case "not_admin":
    case "printed":
    case "set_by_other":
    case "not_yours":
    case "only_offered":
    case "changed":
    case "busy":
    case "not_moved":
    case "no_staging":
    case "no_observation":
    case "in_print_run":
    case "follows_point":
    case "not_applied":
    case "number_taken":
    case "observation_tied":
    case "conflict":
    case "count_follows_observation":
    case "labels_in_run":
    case "no_host_key":
    case "entered_in_beeline":
    case "rule_says_trap":
    case "inat_unreachable":
    case "unavailable": {
      const r = REFUSALS[failure.refusal];
      return apiError(c, r.status, r.error, "says" in failure && typeof failure.says === "string" ? failure.says : r.message);
    }
    default:
      return unreachable(failure);
  }
}

/**
 * The sentence for a refused correction, as the API words it: the writer's own words for `invalid` and `unresolved`,
 * and the table's for every other refusal. The samples upload records these beside a change it could not apply, so a
 * person reads in a note what a program is told.
 */
export function refusalSentence(failure: AnyFailure): string {
  switch (failure.refusal) {
    case "invalid":
      return failure.problem;
    case "unresolved":
      return failure.reason;
    default:
      return "says" in failure && typeof failure.says === "string" ? failure.says : REFUSALS[failure.refusal].message;
  }
}

// --- Reading the body ------------------------------------------------------

type Body = Record<string, unknown>;
type Field = "string" | "boolean" | "text_or_number" | "strings" | "string_list";

/** The most entries a list may have: more collectors than any sample has had, with room to spare. */
const MAX_LIST_ENTRIES = 20;

export class BadBody extends Error {}

/** Parse the JSON body as an object, or say why not. Read only after the rules that need no body have passed. */
async function readBody(c: Context): Promise<Body> {
  return parseObject(await c.req.text());
}

/** Parse text as a JSON object, or say why not. */
export function parseObject(text: string): Body {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadBody("The request body must be JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BadBody("The request body must be a JSON object.");
  return parsed as Body;
}

/**
 * The caller's reference for the request, if it gave one: the message that
 * asked for the change, or a link to the issue. One to 500 characters once
 * trimmed, and an empty one is none. It is recorded with the request
 * (`api_key_use.reference`) and goes no further: the correction never sees it.
 */
export function referenceOf(body: Body): string | undefined {
  const value = Object.hasOwn(body, "reference") ? body.reference : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The most characters a value of each kind may have: what a label can hold, and room for a note. */
const MAX_VALUE_CHARS = 500;
const MAX_NOTE_CHARS = 2000;
/** Control characters, which have no place on a printed label: everything below U+0020, and U+007F. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Check one string a program sent. Text sent here ends up on printed labels
 * and in the history, so a control character is refused, and each kind of
 * text has a longest length. The answer names the field.
 */
function checkText(label: string, value: string, max: number, counted: string = value): void {
  if (CONTROL.test(value)) throw new BadBody(`${label} must not contain control characters, such as a line break or a tab.`);
  if (counted.length > max) throw new BadBody(`${label} may be at most ${max} characters.`);
}

/**
 * Check a body against the fields an endpoint takes: no other field, and each
 * of the right type. A misspelt field is refused by name, and is never read as
 * absent. The fields are the endpoint's own, not whatever an object inherits,
 * so `toString` and `__proto__` are unknown fields like any other. `dry_run`
 * gets its own sentence, since a program that sends it to an endpoint without
 * a dry run would otherwise think it had not written.
 */
export function check(body: Body, fields: Record<string, Field>, required: string[] = []): Body {
  const takes = (name: string) => Object.hasOwn(fields, name);
  for (const name of Object.keys(body)) {
    if (name === "dry_run" && !takes("dry_run")) throw new BadBody("Dry runs exist only for edit, collectors, host and kind-from-old-records. Nothing was done.");
    if (!takes(name)) throw new BadBody(`${JSON.stringify(name)} is not a field of this request.`);
  }
  for (const name of required) if (!Object.hasOwn(body, name)) throw new BadBody(`${JSON.stringify(name)} is required.`);
  for (const [name, kind] of Object.entries(fields)) {
    const value = Object.hasOwn(body, name) ? body[name] : undefined;
    if (value === undefined) continue;
    const ok =
      kind === "string"
        ? typeof value === "string"
        : kind === "boolean"
          ? typeof value === "boolean"
          : kind === "text_or_number"
            ? typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
            : kind === "string_list"
              ? Array.isArray(value) && value.every((x) => typeof x === "string")
              : isStringMap(value);
    if (!ok) {
      const wants = {
        string: "a string",
        boolean: "true or false",
        text_or_number: "a string or a number",
        strings: "an object whose values are strings",
        string_list: "a list of strings",
      }[kind];
      throw new BadBody(`${JSON.stringify(name)} must be ${wants}.`);
    }
    // Text is held to the same limits wherever it sits: a note is longer than a name.
    const limit = name === "note" ? MAX_NOTE_CHARS : MAX_VALUE_CHARS;
    // A reference is counted once trimmed, since an empty one is none.
    if (typeof value === "string") checkText(JSON.stringify(name), value, limit, name === "reference" ? value.trim() : value);
    else if (typeof value === "number") continue;
    else if (kind === "string_list") {
      const list = value as string[];
      if (list.length > MAX_LIST_ENTRIES) throw new BadBody(`${JSON.stringify(name)} may have at most ${MAX_LIST_ENTRIES} entries.`);
      list.forEach((text, i) => checkText(`Entry ${i + 1} of ${JSON.stringify(name)}`, text, limit));
    }
    else if (kind === "strings") {
      for (const [field, text] of Object.entries(value as Record<string, string>)) checkText(`${JSON.stringify(field)} in ${name}`, text, limit);
    }
  }
  return body;
}

const isStringMap = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

const EDITABLE = EDITABLE_FIELDS.map((f) => f.name) as readonly string[];

/** The fields of a collector's edit: only the five a sample may be edited by, never another name. */
function editableFields(map: Record<string, string>): Partial<Record<EditableFieldName, string>> {
  const out: Partial<Record<EditableFieldName, string>> = {};
  for (const [field, value] of Object.entries(map)) {
    if (!EDITABLE.includes(field)) {
      throw new BadBody(`${JSON.stringify(field)} in values is not a field that can be edited. They are: ${EDITABLE.join(", ")}.`);
    }
    out[field as EditableFieldName] = value;
  }
  return out;
}

const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** The body-size cap every endpoint that reads a body has. */
export const smallBody: MiddlewareHandler<ApiEnv> = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => {
    c.set("outcome", "too_large");
    return apiError(c, 413, "too large", `The request body may be at most ${MAX_BODY_BYTES / 1024} KB.`);
  },
});

// --- The routes ------------------------------------------------------------

/** What the API says of a correction that was made, besides the refusals. */
const done = (c: Context, sampleId: number, body: Record<string, unknown>) => c.json({ sample_id: sampleId, ...body });

/**
 * `messages` is the catalogue the stored reasons are built from. It is passed
 * in and not imported, because the catalogue imports the old Beeline's address
 * from src/app/old-beeline.ts, which imports this API: a cycle that left the
 * address undefined where the catalogue was read first.
 */
export function registerCorrectionRoutes(api: Hono<ApiEnv>, corrections: { deps: CorrectionDeps; messages: Messages } | undefined): void {
  const deps = corrections?.deps;
  const key = (c: Context<ApiEnv>) => c.get("key");
  /** Who is acting: the key's person, staff only as far as the gate found, never impersonating. */
  const actorOf = (c: Context<ApiEnv>): Actor =>
    actorFor({
      personId: key(c).personId,
      signedInPersonId: key(c).personId,
      login: key(c).login,
      staff: c.get("staff"),
      impersonating: false,
      via: "api",
    });

  /**
   * A key that may only read corrects nothing. Asked before the body is read
   * and before any sample is loaded, so it costs the store nothing. It is part
   * of each route, and not a check ahead of them, so a refusal is recorded
   * under the route it was for.
   */
  const mayCorrect: MiddlewareHandler<ApiEnv> = async (c, next) => {
    if (key(c).scope === "read") {
      c.set("outcome", "forbidden");
      return apiError(c, 403, "forbidden", "This key may only read. Make a key that may edit to correct a sample.");
    }
    await next();
  };
  /**
   * One correction endpoint: the sample's id, the body read and checked, the
   * correction called with the input as a value (never a function, so it takes
   * its turn of the sample's queue at once), and a refusal or a conflict turned
   * into an answer. Requests sent together may be applied in either order; a
   * program that needs one correction after another waits for the first answer.
   */
  const endpoint = <Input, Result extends { ok: boolean; outcome?: string }>(
    path: string,
    read: (body: Body) => Input,
    fields: Record<string, Field>,
    required: string[],
    call: (deps: CorrectionDeps, actor: Actor, id: number, input: Input) => Promise<Result>,
    answer: (result: Extract<Result, { ok: true }>, input: Input) => Record<string, unknown>,
  ) =>
    api.post(`/samples/:id/${path}`, mayCorrect, smallBody, async (c) => {
      const raw = c.req.param("id");
      if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2_147_483_647) {
        c.set("outcome", "not_found");
        return apiError(c, 404, "not found", "No such sample.");
      }
      const id = Number(raw);
      if (deps === undefined) {
        c.set("outcome", "unavailable");
        return apiError(c, 503, "unavailable", REFUSALS.unavailable.message);
      }
      let input: Input;
      try {
        const body = check(await readBody(c), { ...fields, reference: "string" }, required);
        input = read(body);
        // Recorded with the request and passed no further, a refusal included.
        c.set("reference", referenceOf(body));
      } catch (err) {
        if (err instanceof BadBody) {
          c.set("outcome", "invalid_request");
          return apiError(c, 400, "invalid_request", err.message);
        }
        throw err;
      }
      // Asked here and not in the functions, so the pages are as they were.
      // The nightly run and the weekly sweep rewrite samples wholesale and are
      // the main source of write conflicts, so while one runs the API takes
      // no correction at all.
      if (deps.syncJobRunning()) return refusalResponse(c, { ok: false, refusal: "busy" });
      let result: Result;
      try {
        result = await call(deps, actorOf(c), id, input);
      } catch (err) {
        // A save does not retry on a write conflict (docs/architecture/ingestion-jobs-and-elevation.md),
        // so the caller is told and may send it again.
        // What reaches here is the sample overlay (locality, coordinates, hold and
        // waiver on a sample with an observation), which the nightly does apply, so
        // the message below is true for it. A writer of the corrections file answers
        // its own conflict as `not_applied` instead: nothing reads that file again on
        // production, so the nightly would never apply its change.
        if (isWriteConflict(err)) {
          c.set("outcome", "recorded_not_applied");
          return apiError(
            c,
            409,
            "recorded_not_applied",
            "Your change is recorded, but Beeline could not finish applying it because another write to the store got there first. It will be applied the next time Beeline brings its records up to date, which is nightly, so it may not be visible yet. Sending the same request again applies it now and does not record it twice. Like any correction, it replaces what the sample holds at that moment, so if someone else may have corrected the same thing since, check before you send it again.",
          );
        }
        throw err;
      }
      if (!result.ok) return refusalResponse(c, result as unknown as AnyFailure);
      c.set("outcome", (result as { outcome?: string }).outcome);
      return done(c, id, answer(result as Extract<Result, { ok: true }>, input));
    });

  // The collector's edit. A field sent equal to what the sample holds now is
  // not a change. (The page's `bases`, which tell a touched field from a stale
  // prefill, are not offered: a program sends what it means to change.)
  endpoint(
    "edit",
    (b): EditSampleInput => ({
      values: editableFields(b.values as Record<string, string>),
      // A program sends only what it means to change, so there is no stale form
      // to tell from: with no bases, a field equal to what the sample holds now
      // is not a change.
      bases: {},
      note: b.note as string | undefined,
      dryRun: b.dry_run === true,
    }),
    { values: "strings", note: "string", dry_run: "boolean" },
    ["values"],
    editSample,
    (r, input) => ({ outcome: r.outcome, dry_run: input.dryRun === true, changes: r.changes }),
  );

  // The place editor: one name, and what the name is decides what is written.
  endpoint(
    "locality",
    (b) => ({ locality: b.locality as string, reasonFor: localityReasonFor(corrections!.messages) }),
    { locality: "string" },
    ["locality"],
    setPlace,
    (r) => ({ outcome: r.outcome }),
  );

  endpoint(
    "coordinates",
    (b) => ({
      latitude: text(b.latitude),
      longitude: text(b.longitude),
      uncertainty: text(b.uncertainty),
      remove: b.remove === true,
      note: (b.note as string | undefined) ?? "",
    }),
    { latitude: "text_or_number", longitude: "text_or_number", uncertainty: "text_or_number", remove: "boolean", note: "string" },
    [],
    setCoordinates,
    (r) => ({ outcome: r.outcome, settled: r.settled }),
  );

  // The country, state and county: staff only, any sample whose place does not follow its point.
  endpoint(
    "country-state-county",
    (b): { values: Partial<Record<PlaceField, string>>; note: string } => ({
      values: Object.fromEntries(PLACE_FIELDS.filter((f) => b[f] !== undefined).map((f) => [f, b[f] as string])),
      note: (b.note as string | undefined) ?? "",
    }),
    { country: "string", state_province: "string", county: "string", note: "string" },
    [],
    setSamplePlace,
    (r) => ({ outcome: r.outcome, changes: r.changes }),
  );

  // Who collected the sample, in order: staff only, the first collector included.
  endpoint(
    "collectors",
    (b): CollectorsCorrectionInput => ({
      collectors: b.collectors as string[],
      note: (b.note as string | undefined) ?? "",
      dryRun: b.dry_run === true,
    }),
    { collectors: "string_list", note: "string", dry_run: "boolean" },
    ["collectors"],
    setCollectors,
    (r) => ({
      outcome: r.outcome,
      dry_run: r.dry_run,
      collectors: r.collectors.map((c) => ({ position: c.position, person_id: c.person_id, name: c.name })),
      first_changed: r.first_changed,
      reprint_needed: r.reprint_needed,
      warnings: r.warnings,
    }),
  );

  endpoint(
    "trap-count",
    (b) => ({ count: b.count === undefined ? "" : text(b.count), note: (b.note as string | undefined) ?? "", problemFor: trapCountProblemFor(corrections!.messages) }),
    { count: "text_or_number", note: "string" },
    ["count"],
    setTrapCount,
    (r) => ({ outcome: r.outcome, effort: r.effort }),
  );

  endpoint(
    "specimen-count",
    (b) => ({ count: b.count === undefined ? "" : text(b.count), note: (b.note as string | undefined) ?? "", problemFor: specimenCountProblemFor(corrections!.messages) }),
    { count: "text_or_number", note: "string" },
    ["count"],
    setSpecimenCount,
    (r) => ({ outcome: r.outcome, specimen_count: r.specimen_count, pending: r.pending, released: r.released, awaiting_place: r.awaiting_place }),
  );

  // Staff release a settled season's sample for printing, or withdraw the release (beeline-3vs.7).
  endpoint(
    "release-labels",
    (b): ReleaseLabelsInput => ({ note: (b.note as string | undefined) ?? "", withdraw: b.withdraw === true }),
    { note: "string", withdraw: "boolean" },
    [],
    releaseLabels,
    (r) => ({ outcome: r.outcome, pending: r.pending, released: r.released, awaiting_place: r.awaiting_place }),
  );

  endpoint(
    "take-observation-location",
    (b) => ({ note: (b.note as string | undefined) ?? "", defaultReason: takeLocationDefaultReason(corrections!.messages) }),
    { note: "string" },
    [],
    takeLocation,
    (r) => ({ outcome: r.outcome, settled: r.settled }),
  );

  // The floral host (beeline-hlay): a plant given as an iNaturalist taxon page address or number, or no floral host,
  // with the reason that is required; `remove` goes back to following iNaturalist and needs none.
  endpoint(
    "host",
    (b) => {
      // As the page refuses a plant together with no host: one thing at a time.
      if (b.remove === true && ((b.taxon !== undefined && text(b.taxon).trim() !== "") || b.none === true)) {
        throw new BadBody('"remove" cannot be sent with "taxon" or "none". Remove the host, or set one, in separate requests.');
      }
      return {
      taxon: b.taxon === undefined ? "" : text(b.taxon),
      none: b.none === true,
      remove: b.remove === true,
      note: (b.note as string | undefined) ?? "",
      dryRun: b.dry_run === true,
      problemFor: hostProblemFor(corrections!.messages),
      };
    },
    { taxon: "text_or_number", none: "boolean", remove: "boolean", note: "string", dry_run: "boolean" },
    [],
    setHost,
    (r, input) => ({
      outcome: r.outcome,
      dry_run: input.dryRun === true,
      host: r.host === null ? null : { inat_taxon_id: r.host.id, name: r.host.name, rank: r.host.rank },
    }),
  );

  // A sample's kind worked out again from its old records, by the rule promotion uses (beeline-lmlh). It takes no kind.
  endpoint(
    "kind-from-old-records",
    (b): KindFromOldRecordsInput => ({ note: b.note as string, dryRun: b.dry_run === true }),
    { note: "string", dry_run: "boolean" },
    ["note"],
    setKindFromOldRecordsCorrection,
    (r, input) => ({
      outcome: r.outcome,
      dry_run: input.dryRun === true,
      from: r.from,
      to: r.to,
      ...(r.history_recorded === undefined ? {} : { history_recorded: r.history_recorded }),
    }),
  );

  endpoint(
    "hold",
    (b) => ({ lift: b.lift === true, note: (b.note as string | undefined) ?? "" }),
    { lift: "boolean", note: "string" },
    [],
    holdSample,
    (r) => ({ outcome: r.outcome }),
  );

  endpoint(
    "waiver",
    (b) => ({ rule: b.rule as string, remove: b.remove === true, note: (b.note as string | undefined) ?? "" }),
    { rule: "string", remove: "boolean", note: "string" },
    ["rule"],
    waiveFlag,
    (r) => ({ outcome: r.outcome }),
  );
}
