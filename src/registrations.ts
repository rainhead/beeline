import { sql, type Kysely } from "kysely";
import type { Database, RegistrationEvidence } from "./model.js";
import type { Registrant } from "./ideal-logic.js";

/**
 * What Beeline keeps of Ideal Logic's registrations, and which registration
 * is whose (beeline-w8ab.1; the tables are schema/014).
 *
 * Two writers. `recordRegistrants` is the nightly job's: it takes the whole
 * list as fetched, keeps the part Beeline has a use for, and links a person
 * to a registration where the evidence is strong. `decideRegistration` is one
 * decision about one person, made by staff or loaded through the API.
 *
 * Neither writes an email address or a home address, and neither puts one in
 * a message: the fields `Registrant.email` and `Registrant.address` are not
 * read in this file at all.
 */

/**
 * A name reduced to its letters and digits, the fold person identity already
 * uses (AGENTS.md): typography cannot then split one human in two.
 */
export const foldName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A login as iNaturalist compares them: without regard to case. */
const foldLogin = (login: string): string => login.trim().toLowerCase();

export interface RegistrantsRecorded {
  /** Registrations in the fetch. */
  seen: number;
  /** Of those, the ones Beeline keeps a row for. */
  kept: number;
  /** Kept registrations this fetch was the first to return. */
  firstSeen: number;
  /** People linked to a registration by this run. */
  linked: number;
  /** Kept registrations that no person is linked to: the ones staff have still to place. */
  unlinked: number;
}

interface PersonRow {
  entity_id: number;
  display_name: string;
  login: string | null;
}

/**
 * Record a night's fetch.
 *
 * **What is kept.** A registration linked to a person, one that names an
 * atlas or an iNaturalist handle, or one whose name is a person's. On
 * 2026-11-18 that left out 386 of 826: people who registered for something
 * and have no relation to Beeline, whose names have no business in every
 * backup.
 *
 * **What is linked without asking.** A registration whose typed handle is the
 * login of exactly one person, where the registration's full name is that
 * person's, and nobody has decided anything about that person's registration
 * before. The name must agree because the handle is typed and nobody checks
 * it; a household sharing one login is why it must be the full name and not
 * the family name. A person staff have unlinked is left unlinked. Anything
 * weaker is for staff: on 2026-11-18 the rule linked 20 people beyond the 259
 * the old register's email addresses reach (`src/link-register-emails.ts`).
 *
 * **What is never done.** A link on a name alone. A registrant who shares a
 * collector's name is not thereby the collector, and a wrong link mails that
 * collector's labels to a stranger's home.
 */
export async function recordRegistrants(
  db: Kysely<Database>,
  registrants: readonly Registrant[],
  opts: { decidedBy: string },
): Promise<RegistrantsRecorded> {
  return db.transaction().execute(async (trx) => {
    const people: PersonRow[] = await trx
      .selectFrom("person")
      .leftJoin("inat_account", "inat_account.person_id", "person.entity_id")
      .select(["person.entity_id", "person.display_name", "inat_account.login"])
      .execute();
    const byName = new Map<string, PersonRow[]>();
    const byLogin = new Map<string, PersonRow[]>();
    const push = (m: Map<string, PersonRow[]>, k: string, p: PersonRow) => {
      const at = m.get(k);
      if (at) at.push(p);
      else m.set(k, [p]);
    };
    for (const p of people) {
      push(byName, foldName(p.display_name), p);
      if (p.login !== null) push(byLogin, foldLogin(p.login), p);
    }

    const linkedIds = new Set(
      (await trx.selectFrom("person_registration").select("ideal_logic_id").execute()).map((r) => r.ideal_logic_id),
    );
    // Anybody a decision has been made about, a later unlinking included.
    const decided = new Set(
      (await trx.selectFrom("person_registration_event").select("person_id").distinct().execute()).map((r) => r.person_id),
    );
    const before = new Map(
      (await trx.selectFrom("ideal_logic_registrant").selectAll().execute()).map((r) => [r.ideal_logic_id, r]),
    );

    const out: RegistrantsRecorded = { seen: registrants.length, kept: 0, firstSeen: 0, linked: 0, unlinked: 0 };
    const keptIds: string[] = [];

    for (const r of registrants) {
      const name = foldName(`${r.givenName}${r.familyName}`);
      const namesakes = byName.get(name) ?? [];

      // The handle rule. The same registration may link more than one person
      // only by a later decision of staff: a typed handle names one account.
      const holders = r.inatHandle === null ? [] : (byLogin.get(foldLogin(r.inatHandle)) ?? []);
      const holder = holders.length === 1 ? holders[0]! : null;
      if (holder !== null && foldName(holder.display_name) === name && !decided.has(holder.entity_id)) {
        await trx
          .insertInto("person_registration_event")
          .values({ person_id: holder.entity_id, ideal_logic_id: r.id, evidence: "handle", decided_by: opts.decidedBy, reference: null })
          .execute();
        decided.add(holder.entity_id);
        linkedIds.add(r.id);
        out.linked += 1;
      }

      const linked = linkedIds.has(r.id);
      if (!linked && r.atlases.length === 0 && r.inatHandle === null && namesakes.length === 0) continue;

      const row = {
        given_name: r.givenName,
        family_name: r.familyName,
        atlases: r.atlases.length > 0 ? r.atlases.join(";") : null,
        inat_handle: r.inatHandle,
      };
      const was = before.get(r.id);
      if (was === undefined) {
        await trx.insertInto("ideal_logic_registrant").values({ ideal_logic_id: r.id, ...row }).execute();
        out.firstSeen += 1;
      } else if (
        was.given_name !== row.given_name ||
        was.family_name !== row.family_name ||
        was.atlases !== row.atlases ||
        was.inat_handle !== row.inat_handle
      ) {
        await trx.updateTable("ideal_logic_registrant").set(row).where("ideal_logic_id", "=", r.id).execute();
      }
      keptIds.push(r.id);
      out.kept += 1;
      if (!linked) out.unlinked += 1;
    }

    // One statement for the date every kept registration shares. A row this
    // fetch did not return keeps its earlier date, which is how a
    // registration that has left Ideal Logic is told.
    if (keptIds.length > 0) {
      await trx
        .updateTable("ideal_logic_registrant")
        .set({ last_seen_at: sql`current_timestamp` })
        .where("ideal_logic_id", "in", keptIds)
        .execute();
    }
    return out;
  });
}

/** What the nightly job's run says it did, for `job_run.detail`. Counts only. */
export function describeRegistrants(r: RegistrantsRecorded): string {
  const parts = [`${r.seen} registrations in Ideal Logic`, `${r.kept} kept`];
  if (r.firstSeen > 0) parts.push(`${r.firstSeen} seen for the first time`);
  if (r.linked > 0) parts.push(`${r.linked} linked to a person by handle and name`);
  parts.push(`${r.unlinked} linked to nobody`);
  return parts.join("; ");
}

export type RegistrationDecision =
  | { ok: true; outcome: "saved" | "unchanged"; was: string | null }
  | { ok: false; refusal: "unknown_person" };

/**
 * Record that a person's registration is the one named, or with `null` that
 * they have none. The latest decision is the answer, so a second one
 * replaces the first without erasing it. Saying what is already so records
 * nothing.
 *
 * The registration need not be one Beeline has a row for: a link loaded from
 * the old register's email addresses can name a registration the nightly job
 * has had no reason to keep, and the job keeps it from then on.
 */
export async function decideRegistration(
  db: Kysely<Database>,
  input: { personId: number; idealLogicId: string | null; evidence: RegistrationEvidence; decidedBy: string; reference?: string | null },
): Promise<RegistrationDecision> {
  return db.transaction().execute(async (trx) => {
    const person = await trx.selectFrom("person").select("entity_id").where("entity_id", "=", input.personId).executeTakeFirst();
    if (person === undefined) return { ok: false, refusal: "unknown_person" } as const;
    const now = await trx
      .selectFrom("person_registration")
      .select("ideal_logic_id")
      .where("person_id", "=", input.personId)
      .executeTakeFirst();
    const was = now?.ideal_logic_id ?? null;
    if (was === input.idealLogicId) return { ok: true, outcome: "unchanged", was } as const;
    await trx
      .insertInto("person_registration_event")
      .values({
        person_id: input.personId,
        ideal_logic_id: input.idealLogicId,
        evidence: input.evidence,
        decided_by: input.decidedBy,
        reference: input.reference ?? null,
      })
      .execute();
    return { ok: true, outcome: "saved", was } as const;
  });
}

/** How an Ideal Logic id is written: letters and digits in groups joined by hyphens, such as `QNN6-MX8`. */
export const IDEAL_LOGIC_ID = /^[A-Za-z0-9]{2,12}(-[A-Za-z0-9]{2,12}){0,3}$/;
