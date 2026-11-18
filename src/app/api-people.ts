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

export interface PeopleDeps {
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
}
