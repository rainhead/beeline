import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isWriteConflict } from "../write-conflict.js";
import { apiError, type ApiEnv } from "./api.js";
import { localityReasonFor, takeLocationDefaultReason } from "./correction-reasons.js";
import type { Messages } from "./messages/index.js";
import { EDITABLE_FIELDS, type EditableFieldName } from "./sample-edit.js";
import {
  actorFor,
  editSample,
  holdSample,
  setCoordinates,
  setPlace,
  takeLocation,
  unreachable,
  waiveFlag,
  type Actor,
  type AdoptLocalityResult,
  type CorrectionDeps,
  type EditSampleInput,
  type EditSampleResult,
  type QcDecisionCorrectionResult,
  type SetPlaceResult,
  type StaffCoordinatesCorrectionResult,
  type TakeObservationLocationCorrectionResult,
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
    message: "This sample has no iNaturalist observation, and this correction is kept against the observation.",
  },
  unavailable: { status: 503, error: "unavailable", message: "This Beeline cannot make this correction." },
} as const satisfies Record<string, { status: ContentfulStatusCode; error: string; message: string }>;

// Every refusal a correction can make. `adoptLocality` has no endpoint of its
// own, since `setPlace` adopts an offered name; it is listed so that the
// switch below also covers its refusals, `changed` among them.
type AnyFailure = Extract<
  | AdoptLocalityResult
  | EditSampleResult
  | SetPlaceResult
  | StaffCoordinatesCorrectionResult
  | TakeObservationLocationCorrectionResult
  | QcDecisionCorrectionResult,
  { ok: false }
>;

/** A refused correction as the API answers it. The switch ends in `unreachable`, so a new refusal fails the typecheck. */
function refusalResponse(c: Context<ApiEnv>, failure: AnyFailure) {
  c.set("outcome", failure.refusal);
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
    case "unavailable": {
      const r = REFUSALS[failure.refusal];
      return apiError(c, r.status, r.error, r.message);
    }
    default:
      return unreachable(failure);
  }
}

// --- Reading the body ------------------------------------------------------

type Body = Record<string, unknown>;
type Field = "string" | "boolean" | "text_or_number" | "strings";

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
function checkText(label: string, value: string, max: number): void {
  if (CONTROL.test(value)) throw new BadBody(`${label} must not contain control characters, such as a line break or a tab.`);
  if (value.length > max) throw new BadBody(`${label} may be at most ${max} characters.`);
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
    if (name === "dry_run" && !takes("dry_run")) throw new BadBody("Dry runs exist only for edit. Nothing was done.");
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
            : isStringMap(value);
    if (!ok) {
      const wants = { string: "a string", boolean: "true or false", text_or_number: "a string or a number", strings: "an object whose values are strings" }[kind];
      throw new BadBody(`${JSON.stringify(name)} must be ${wants}.`);
    }
    // Text is held to the same limits wherever it sits: a note is longer than a name.
    const limit = name === "note" ? MAX_NOTE_CHARS : MAX_VALUE_CHARS;
    // A reference is counted once trimmed, since an empty one is none.
    if (typeof value === "string") checkText(JSON.stringify(name), name === "reference" ? value.trim() : value, limit);
    else if (typeof value === "number") continue;
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
        // The correction writes its file first and then the store, so by now
        // the file holds the change and the next promotion applies it.
        if (isWriteConflict(err)) {
          c.set("outcome", "recorded_not_applied");
          return apiError(
            c,
            409,
            "recorded_not_applied",
            "Your change is recorded, but Beeline could not finish applying it because another write to the store got there first. It will be applied the next time Beeline brings its records up to date, which is nightly, so it may not be visible yet. Sending the same request again is safe, and applies it now.",
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

  endpoint(
    "take-observation-location",
    (b) => ({ note: (b.note as string | undefined) ?? "", defaultReason: takeLocationDefaultReason(corrections!.messages) }),
    { note: "string" },
    [],
    takeLocation,
    (r) => ({ outcome: r.outcome, settled: r.settled }),
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
