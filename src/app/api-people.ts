import type { Hono } from "hono";
import { isWriteConflict } from "../write-conflict.js";
import { apiError, type ApiEnv } from "./api.js";
import { BadBody, check, parseObject, referenceOf, smallBody } from "./api-corrections.js";

/**
 * Decisions about people, for a program (beeline-4rta). One so far: where a
 * person belongs, which staff set on the person's page. The decision is made
 * by the function that page's form calls (`setMembership` in
 * src/app/server.tsx), so it is written to the person overlay first, applied
 * to the store, and entered in the person's history, credited to the key's
 * person. Staff keys only, as the page is staff only.
 */

/** What a person belongs to, as the API writes it: a program's code, or "" where nothing is recorded. */
export type BelongsTo = string;

export type SetMembershipResult =
  | { ok: true; outcome: "saved" | "unchanged" | "recorded_not_applied"; person_id: number; was: BelongsTo; belongs_to: BelongsTo }
  | { ok: false; refusal: "not_found" }
  | { ok: false; refusal: "invalid" | "unresolved"; problem: string };

export type SetRegistrationResult =
  | { ok: true; outcome: "saved" | "unchanged"; person_id: number; was: string; ideal_logic_id: string; registrant: string }
  | { ok: false; refusal: "not_found" }
  | { ok: false; refusal: "invalid"; problem: string };

export type SetMailingResult =
  | { ok: true; outcome: "saved" | "unchanged"; person_id: number; was: "mail" | "keep_in_lab"; instruction: "mail" | "keep_in_lab" }
  | { ok: false; refusal: "not_found" }
  | { ok: false; refusal: "invalid"; problem: string };

export interface PeopleDeps {
  /**
   * Record whether the person's printed labels are mailed or kept in the lab
   * (src/mailing-instructions.ts). The note is free text: it is refused if it
   * could hold an address, and never repeated back.
   */
  setMailing(input: {
    handle: string;
    instruction: string;
    note: string;
    author: string;
    reference: string | null;
  }): Promise<SetMailingResult>;
  /**
   * Record which Ideal Logic registration is the person's, or with an empty
   * `idealLogicId` that none is (src/registrations.ts). `evidence` is one of
   * the kinds `person_registration_event.evidence` allows a person to give:
   * `staff` or `register_email`.
   */
  setRegistration(input: {
    handle: string;
    idealLogicId: string;
    evidence: string;
    author: string;
    reference: string | null;
  }): Promise<SetRegistrationResult>;
  /**
   * Set where the person a handle names belongs. The handle is the one the
   * person's page is at: an iNaturalist login or the person's id.
   * `belongsTo` is a program code, `MM` for Master Melittology itself, or ""
   * to go back to nothing recorded.
   */
  setMembership(input: { handle: string; belongsTo: BelongsTo; author: string; reason: string }): Promise<SetMembershipResult>;
}

export function registerPeopleRoutes(api: Hono<ApiEnv>, people: PeopleDeps | undefined): void {
  api.post("/people/:id/membership", smallBody, async (c) => {
    // Part of the route, not a check ahead of it, so a refusal is recorded under this route.
    if (!c.get("staff")) {
      c.set("outcome", "forbidden");
      return apiError(c, 403, "forbidden", "This needs a staff key held by someone who is staff.");
    }
    if (people === undefined) {
      c.set("outcome", "unavailable");
      return apiError(c, 503, "unavailable", "This Beeline cannot record decisions about people.");
    }
    let belongsTo: string;
    let note: string;
    try {
      const body = check(parseObject(await c.req.text()), { belongs_to: "string", note: "string", reference: "string" }, ["belongs_to"]);
      belongsTo = (body.belongs_to as string).trim();
      note = typeof body.note === "string" ? body.note.trim() : "";
      // Recorded with the request and passed no further, a refusal included.
      c.set("reference", referenceOf(body));
    } catch (err) {
      if (!(err instanceof BadBody)) throw err;
      c.set("outcome", "invalid_request");
      return apiError(c, 400, "invalid_request", err.message);
    }
    let result: SetMembershipResult;
    try {
      result = await people.setMembership({ handle: c.req.param("id"), belongsTo, author: c.get("key").login, reason: note });
    } catch (err) {
      // The decision is written to the overlay before the store, so by now
      // the file holds it and sending the request again applies it.
      if (isWriteConflict(err)) {
        c.set("outcome", "recorded_not_applied");
        return apiError(
          c,
          409,
          "recorded_not_applied",
          "Your change is recorded, but Beeline could not finish applying it because another write to the store got there first. Sending the same request again applies it and does not record it twice.",
        );
      }
      throw err;
    }
    if (!result.ok) {
      c.set("outcome", result.refusal);
      if (result.refusal === "not_found") return apiError(c, 404, "not found", "No such person.");
      return result.refusal === "invalid" ? apiError(c, 422, "invalid", result.problem) : apiError(c, 409, "unresolved", result.problem);
    }
    c.set("outcome", result.outcome);
    return c.json({ person_id: result.person_id, outcome: result.outcome, was: result.was, belongs_to: result.belongs_to });
  });

  // Whether a person's labels are mailed or kept in the lab (beeline-w8ab.4).
  // An instruction and a note; never an address or an email address.
  api.post("/people/:id/mailing", smallBody, async (c) => {
    if (!c.get("staff")) {
      c.set("outcome", "forbidden");
      return apiError(c, 403, "forbidden", "This needs a staff key held by someone who is staff.");
    }
    if (people === undefined) {
      c.set("outcome", "unavailable");
      return apiError(c, 503, "unavailable", "This Beeline cannot record decisions about people.");
    }
    let instruction: string;
    let note: string;
    let reference: string | undefined;
    try {
      const body = check(parseObject(await c.req.text()), { instruction: "string", note: "string", reference: "string" }, ["instruction"]);
      instruction = (body.instruction as string).trim();
      note = typeof body.note === "string" ? body.note.trim() : "";
      reference = referenceOf(body);
      c.set("reference", reference);
    } catch (err) {
      if (!(err instanceof BadBody)) throw err;
      c.set("outcome", "invalid_request");
      return apiError(c, 400, "invalid_request", err.message);
    }
    let result: SetMailingResult;
    try {
      result = await people.setMailing({ handle: c.req.param("id"), instruction, note, author: c.get("key").login, reference: reference ?? null });
    } catch (err) {
      if (isWriteConflict(err)) {
        c.set("outcome", "busy");
        return apiError(c, 409, "busy", "Another write to the store got there first, and nothing was recorded. Send the same request again.");
      }
      throw err;
    }
    if (!result.ok) {
      c.set("outcome", result.refusal);
      return result.refusal === "not_found"
        ? apiError(c, 404, "not found", "No such person.")
        : apiError(c, 422, "invalid", result.problem);
    }
    c.set("outcome", result.outcome);
    return c.json({ person_id: result.person_id, outcome: result.outcome, was: result.was, instruction: result.instruction });
  });

  // Which Ideal Logic registration is a person's (beeline-w8ab.1). The body
  // names the registration by Ideal Logic's id and says on what evidence;
  // an empty id unlinks the person. No address and no email address is ever
  // sent here: the evidence is its kind, never the value.
  api.post("/people/:id/registration", smallBody, async (c) => {
    if (!c.get("staff")) {
      c.set("outcome", "forbidden");
      return apiError(c, 403, "forbidden", "This needs a staff key held by someone who is staff.");
    }
    if (people === undefined) {
      c.set("outcome", "unavailable");
      return apiError(c, 503, "unavailable", "This Beeline cannot record decisions about people.");
    }
    let idealLogicId: string;
    let evidence: string;
    let reference: string | undefined;
    try {
      const body = check(
        parseObject(await c.req.text()),
        { ideal_logic_id: "string", evidence: "string", reference: "string" },
        ["ideal_logic_id"],
      );
      idealLogicId = (body.ideal_logic_id as string).trim();
      evidence = typeof body.evidence === "string" ? body.evidence.trim() : "staff";
      reference = referenceOf(body);
      c.set("reference", reference);
    } catch (err) {
      if (!(err instanceof BadBody)) throw err;
      c.set("outcome", "invalid_request");
      return apiError(c, 400, "invalid_request", err.message);
    }
    let result: SetRegistrationResult;
    try {
      result = await people.setRegistration({
        handle: c.req.param("id"),
        idealLogicId,
        evidence,
        author: c.get("key").login,
        reference: reference ?? null,
      });
    } catch (err) {
      // DuckDB has no row locks: a write that meets another fails. Nothing
      // was recorded, since the decision is one transaction.
      if (isWriteConflict(err)) {
        c.set("outcome", "busy");
        return apiError(c, 409, "busy", "Another write to the store got there first, and nothing was recorded. Send the same request again.");
      }
      throw err;
    }
    if (!result.ok) {
      c.set("outcome", result.refusal);
      return result.refusal === "not_found"
        ? apiError(c, 404, "not found", "No such person.")
        : apiError(c, 422, "invalid", result.problem);
    }
    c.set("outcome", result.outcome);
    return c.json({
      person_id: result.person_id,
      outcome: result.outcome,
      was: result.was,
      ideal_logic_id: result.ideal_logic_id,
      registrant: result.registrant,
    });
  });
}
