import type { Kysely } from "kysely";
import type { Database, MailingInstruction } from "./model.js";

/**
 * Whether a person's printed labels are mailed or kept in the lab
 * (beeline-w8ab.4; the table is schema/014, the view schema/105).
 *
 * The owner's rule is that an address or an email address is never stored in
 * Beeline. "Keep these in the lab" is an instruction to staff and not an
 * address, so it may be (Peter, 2026-11-18). There is no note beside it: free
 * text could hold an address, and no check can tell a course note from a street.
 */

export type MailingDecision =
  | { ok: true; outcome: "saved" | "unchanged"; was: MailingInstruction }
  | { ok: false; refusal: "unknown_person" };

/**
 * Record that a person's labels are mailed or kept in the lab. The latest
 * decision is the answer, so a second one replaces the first without erasing
 * it.
 *
 * Mailing is the default, so saying `mail` for a person who is not kept in
 * the lab records nothing. Saying what is already so records nothing either.
 */
export async function decideMailing(
  db: Kysely<Database>,
  input: {
    personId: number;
    instruction: MailingInstruction;
    decidedBy: string;
    reference?: string | null;
  },
): Promise<MailingDecision> {
  return db.transaction().execute(async (trx) => {
    const person = await trx.selectFrom("person").select("entity_id").where("entity_id", "=", input.personId).executeTakeFirst();
    if (person === undefined) return { ok: false, refusal: "unknown_person" } as const;

    const now = await trx
      .selectFrom("person_mailing_instruction")
      .select("instruction")
      .where("person_id", "=", input.personId)
      .executeTakeFirst();
    const was: MailingInstruction = now?.instruction ?? "mail";
    if (was === input.instruction) return { ok: true, outcome: "unchanged", was } as const;

    await trx
      .insertInto("person_mailing_event")
      .values({
        person_id: input.personId,
        instruction: input.instruction,
        decided_by: input.decidedBy,
        reference: input.reference ?? null,
      })
      .execute();
    return { ok: true, outcome: "saved", was } as const;
  });
}
