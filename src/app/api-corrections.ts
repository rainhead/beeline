import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isWriteConflict } from "../write-conflict.js";
import { apiError, type ApiEnv } from "./api.js";
import { localityReasonFor, takeLocationDefaultReason } from "./correction-reasons.js";
import { messagesFor } from "./messages/index.js";
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
    message: "The nightly run or the weekly sweep is running, and a point cannot be changed until it ends. Try again later.",
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
function refusalResponse(c: Context, failure: AnyFailure) {
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

class BadBody extends Error {}

/** Parse the JSON body as an object, or say why not. Read only after the rules that need no body have passed. */
async function readBody(c: Context): Promise<Body> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await c.req.text());
  } catch {
    throw new BadBody("The request body must be JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BadBody("The request body must be a JSON object.");
  return parsed as Body;
}

/**
 * Check a body against the fields an endpoint takes: no other field, and each
 * of the right type. A misspelt field is refused by name, and is never read as
 * absent. `dry_run` gets its own sentence, since a program that sends it to an
 * endpoint without a dry run would otherwise think it had not written.
 */
function check(body: Body, fields: Record<string, Field>, required: string[] = []): Body {
  for (const name of Object.keys(body)) {
    if (name === "dry_run" && !("dry_run" in fields)) throw new BadBody("Dry runs exist only for edit. Nothing was done.");
    if (!(name in fields)) throw new BadBody(`${JSON.stringify(name)} is not a field of this request.`);
  }
  for (const name of required) if (!(name in body)) throw new BadBody(`${JSON.stringify(name)} is required.`);
  for (const [name, kind] of Object.entries(fields)) {
    const value = body[name];
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
  }
  return body;
}

const isStringMap = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

const EDITABLE = EDITABLE_FIELDS.map((f) => f.name) as readonly string[];

/** The fields of a collector's edit: only the five a sample may be edited by, never another name. */
function editableFields(name: "values" | "bases", map: Record<string, string> | undefined): Partial<Record<EditableFieldName, string>> {
  const out: Partial<Record<EditableFieldName, string>> = {};
  for (const [field, value] of Object.entries(map ?? {})) {
    if (!EDITABLE.includes(field)) {
      throw new BadBody(`${JSON.stringify(field)} in ${name} is not a field that can be edited. They are: ${EDITABLE.join(", ")}.`);
    }
    out[field as EditableFieldName] = value;
  }
  return out;
}

const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

// --- The routes ------------------------------------------------------------

/** What the API says of a correction that was made, besides the refusals. */
const done = (c: Context, sampleId: number, body: Record<string, unknown>) => c.json({ sample_id: sampleId, ...body });

export function registerCorrectionRoutes(api: Hono<ApiEnv>, deps: CorrectionDeps | undefined): void {
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

  // A key that may only read corrects nothing. Asked before the body is read
  // and before any sample is loaded, so it costs the store nothing.
  api.on("POST", "/samples/*", async (c, next) => {
    if (key(c).scope === "read") {
      return apiError(c, 403, "forbidden", "This key may only read. Make a key that may edit to correct a sample.");
    }
    await next();
  });
  api.on(
    "POST",
    "/samples/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => apiError(c, 413, "too large", `The request body may be at most ${MAX_BODY_BYTES / 1024} KB.`),
    }),
  );

  /**
   * One correction endpoint: the sample's id, the body read and checked, the
   * correction called with the input as a value (never a function, so it takes
   * its turn at once and a program's corrections keep the order they were
   * sent in), and a refusal or a conflict turned into an answer.
   */
  const endpoint = <Input, Result extends { ok: boolean }>(
    path: string,
    read: (body: Body) => Input,
    fields: Record<string, Field>,
    required: string[],
    call: (deps: CorrectionDeps, actor: Actor, id: number, input: Input) => Promise<Result>,
    answer: (result: Extract<Result, { ok: true }>, input: Input) => Record<string, unknown>,
  ) =>
    api.post(`/samples/:id/${path}`, async (c) => {
      const raw = c.req.param("id");
      if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2_147_483_647) return apiError(c, 404, "not found", "No such sample.");
      const id = Number(raw);
      if (deps === undefined) return apiError(c, 503, "unavailable", REFUSALS.unavailable.message);
      let input: Input;
      try {
        input = read(check(await readBody(c), fields, required));
      } catch (err) {
        if (err instanceof BadBody) return apiError(c, 400, "invalid_request", err.message);
        throw err;
      }
      let result: Result;
      try {
        result = await call(deps, actorOf(c), id, input);
      } catch (err) {
        // A save does not retry on a write conflict (docs/architecture/ingestion-jobs-and-elevation.md),
        // so the caller is told and may send it again.
        if (isWriteConflict(err)) {
          return apiError(c, 409, "conflict", "Another write to the store got there first. Beeline did not retry. Send the request again if you still want it.");
        }
        throw err;
      }
      if (!result.ok) return refusalResponse(c, result as unknown as AnyFailure);
      return done(c, id, answer(result as Extract<Result, { ok: true }>, input));
    });

  // The collector's edit. `bases` are the values the caller last saw, as the
  // form's hidden fields are: a field sent equal to its base was never
  // touched, so a program working from an older read cannot undo a newer save.
  // A field with no base is compared with what the sample holds now.
  endpoint(
    "edit",
    (b): EditSampleInput => ({
      values: editableFields("values", b.values as Record<string, string>),
      bases: editableFields("bases", b.bases as Record<string, string> | undefined),
      note: b.note as string | undefined,
      dryRun: b.dry_run === true,
    }),
    { values: "strings", bases: "strings", note: "string", dry_run: "boolean" },
    ["values"],
    editSample,
    (r, input) => ({ outcome: r.outcome, dry_run: input.dryRun === true, changes: r.changes }),
  );

  const messages = messagesFor(null);

  // The place editor: one name, and what the name is decides what is written.
  endpoint(
    "locality",
    (b) => ({ locality: b.locality as string, reasonFor: localityReasonFor(messages) }),
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
    (b) => ({ note: (b.note as string | undefined) ?? "", defaultReason: takeLocationDefaultReason(messages) }),
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
