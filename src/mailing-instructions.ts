import type { Kysely } from "kysely";
import type { Database, MailingInstruction } from "./model.js";

/**
 * Whether a person's printed labels are mailed or kept in the lab
 * (beeline-w8ab.4; the table is schema/014, the view schema/105).
 *
 * The owner's rule is that an address or an email address is never stored in
 * Beeline. "Keep these in the lab" is an instruction to staff and not an
 * address, so it may be (Peter, 2026-11-18). The one thing that could carry an
 * address in is the optional note, which is free text, so `checkNote` refuses
 * a note that looks like one. It is the only way a note reaches the table.
 */

export const MAX_NOTE_LENGTH = 200;

/**
 * Why a note cannot be stored, or null when it can. An "@" is an email
 * address, or a handle, and a run of five digits is a postal code or a house
 * number. Neither has a place in a note such as "ENT 499, picked up in class".
 * The note is never repeated in the answer: what was typed by mistake may be
 * the very address this exists to keep out.
 */
export function checkNote(note: string): "too_long" | "has_at_sign" | "has_long_number" | null {
  if (note.length > MAX_NOTE_LENGTH) return "too_long";
  if (note.includes("@")) return "has_at_sign";
  if (/\d{5,}/.test(note)) return "has_long_number";
  return null;
}

export type MailingDecision =
  | { ok: true; outcome: "saved" | "unchanged"; was: MailingInstruction }
  | { ok: false; refusal: "unknown_person" }
  | { ok: false; refusal: "bad_note"; why: "too_long" | "has_at_sign" | "has_long_number" };

/**
 * Record that a person's labels are mailed or kept in the lab. The latest
 * decision is the answer, so a second one replaces the first without erasing
 * it.
 *
 * Mailing is the default, so saying `mail` for a person who is not kept in
 * the lab records nothing. Saying what is already so, the same instruction
 * with the same note, records nothing either. A note belongs to keeping in
 * the lab, and is dropped from `mail`.
 */
export async function decideMailing(
  db: Kysely<Database>,
  input: {
    personId: number;
    instruction: MailingInstruction;
    note?: string | null;
    decidedBy: string;
    reference?: string | null;
  },
): Promise<MailingDecision> {
  const note = input.instruction === "mail" ? null : (input.note?.trim() ?? "") || null;
  if (note !== null) {
    const why = checkNote(note);
    if (why !== null) return { ok: false, refusal: "bad_note", why };
  }
  return db.transaction().execute(async (trx) => {
    const person = await trx.selectFrom("person").select("entity_id").where("entity_id", "=", input.personId).executeTakeFirst();
    if (person === undefined) return { ok: false, refusal: "unknown_person" } as const;

    const now = await trx
      .selectFrom("person_mailing_instruction")
      .select(["instruction", "note"])
      .where("person_id", "=", input.personId)
      .executeTakeFirst();
    const was: MailingInstruction = now?.instruction ?? "mail";
    if (was === input.instruction && (now?.note ?? null) === note) return { ok: true, outcome: "unchanged", was } as const;

    await trx
      .insertInto("person_mailing_event")
      .values({
        person_id: input.personId,
        instruction: input.instruction,
        note,
        decided_by: input.decidedBy,
        reference: input.reference ?? null,
      })
      .execute();
    return { ok: true, outcome: "saved", was } as const;
  });
}
