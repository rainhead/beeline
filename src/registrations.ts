import { sql, type Kysely } from "kysely";
import type { Database, RegistrationEvidence } from "./model.js";
import type { Registrant } from "./ideal-logic.js";
import { fingerprintEmail } from "./email-fingerprint.js";

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
 * a message: `Registrant.address` is not read in this file at all, and
 * `Registrant.email` only to be fingerprinted (`recordEmailFingerprints`),
 * after which the address is dropped. `linkBySignInEmail` takes the address
 * iNaturalist reported for a person signing in, fingerprints it the same
 * way, and does not keep it either.
 */

/**
 * A name reduced to its letters and digits, the fold person identity already
 * uses (AGENTS.md): typography cannot then split one human in two.
 */
export const foldName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Whether a folded name is enough of a name to agree with another. The fold
 * keeps ASCII letters and digits only, so two names written wholly in another
 * script both fold to nothing, and would "agree".
 */
export const MIN_FOLDED_NAME = 3;
export const namesAgree = (a: string, b: string): boolean => {
  const folded = foldName(a);
  return folded.length >= MIN_FOLDED_NAME && folded === foldName(b);
};

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
 * atlas or an iNaturalist handle, one whose name is a person's, or one
 * Beeline already has a row for. On 2026-11-18 that left out 386 of 826:
 * people who registered for something and have no relation to Beeline, whose
 * names have no business in every backup. A row is never dropped for ceasing
 * to qualify, so `last_seen_at` falling behind means one thing only: Ideal
 * Logic no longer returns the registration.
 *
 * **What is linked without asking.** A person, when exactly one registration
 * has their login as its typed handle and their full name as its name, that
 * login is held by nobody else, and nobody has decided anything about that
 * person's registration before. The name must agree because the handle is
 * typed and nobody checks it; a household sharing one login is why it must be
 * the full name and not the family name. A person with two such
 * registrations is not linked to the first: which one holds the address the
 * labels should go to is for staff to say. A person staff have unlinked, or
 * have said has no registration, is left alone. A registration that is
 * already linked to somebody is never linked to a second person by the job;
 * staff can still do that through `decideRegistration`, since a household
 * shares one registration.
 *
 * **What is never done.** A link on a name alone. A registrant who shares a
 * collector's name is not thereby the collector, and a wrong link mails that
 * collector's labels to a stranger's home.
 *
 * Two transactions. The first records the registrants, which is hundreds of
 * statements on the first night. The second links, and reads who has already
 * been decided about at its own start: a decision staff made through the API
 * while the first was running is seen and respected. A decision made in the
 * moment the second is open is not, and the job's link, being later, would
 * stand over it; that moment is a few statements long, at 1am.
 */
export async function recordRegistrants(
  db: Kysely<Database>,
  registrants: readonly Registrant[],
  opts: { decidedBy: string },
): Promise<RegistrantsRecorded> {
  // Ideal Logic's ids are distinct; were one ever repeated, the second would
  // fail the primary key, and the job would fail the same way at every retry.
  const fetched = [...new Map(registrants.map((r) => [r.id, r])).values()];
  const out: RegistrantsRecorded = { seen: registrants.length, kept: 0, firstSeen: 0, linked: 0, unlinked: 0 };

  // person id → the registrations that qualify for the handle rule.
  const candidates = new Map<number, string[]>();
  const keptIds: string[] = [];

  await db.transaction().execute(async (trx) => {
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
    const before = new Map(
      (await trx.selectFrom("ideal_logic_registrant").selectAll().execute()).map((r) => [r.ideal_logic_id, r]),
    );

    for (const r of fetched) {
      const name = `${r.givenName}${r.familyName}`;
      const namesakes = foldName(name).length >= MIN_FOLDED_NAME ? (byName.get(foldName(name)) ?? []) : [];

      const holders = r.inatHandle === null ? [] : (byLogin.get(foldLogin(r.inatHandle)) ?? []);
      if (holders.length === 1 && namesAgree(holders[0]!.display_name, name)) {
        const at = candidates.get(holders[0]!.entity_id);
        if (at) at.push(r.id);
        else candidates.set(holders[0]!.entity_id, [r.id]);
      }

      const was = before.get(r.id);
      const wanted = linkedIds.has(r.id) || r.atlases.length > 0 || r.inatHandle !== null || namesakes.length > 0;
      if (!wanted && was === undefined) continue;

      const row = {
        given_name: r.givenName,
        family_name: r.familyName,
        atlases: r.atlases.length > 0 ? r.atlases.join(";") : null,
        inat_handle: r.inatHandle,
      };
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
  });
  out.kept = keptIds.length;

  await db.transaction().execute(async (trx) => {
    // Anybody a decision has been made about: a link, an unlinking, or a
    // statement that they have no registration.
    const decided = new Set(
      (await trx.selectFrom("person_registration_event").select("person_id").distinct().execute()).map((r) => r.person_id),
    );
    // Registrations already linked to anyone, read now so that a link staff
    // made while the first transaction ran is seen.
    const taken = new Set(
      (await trx.selectFrom("person_registration").select("ideal_logic_id").execute()).map((r) => r.ideal_logic_id),
    );
    for (const [personId, ids] of candidates) {
      if (ids.length !== 1 || decided.has(personId) || taken.has(ids[0]!)) continue;
      await trx
        .insertInto("person_registration_event")
        .values({ person_id: personId, ideal_logic_id: ids[0]!, evidence: "handle", decided_by: opts.decidedBy, reference: null })
        .execute();
      out.linked += 1;
    }
    const linkedNow = new Set(
      (await trx.selectFrom("person_registration").select("ideal_logic_id").execute()).map((r) => r.ideal_logic_id),
    );
    out.unlinked = keptIds.filter((id) => !linkedNow.has(id)).length;
  });
  return out;
}

/**
 * Replace the whole table of email fingerprints with this fetch's
 * (beeline-w8ab.7), in one transaction, and say how many rows it holds. One
 * row for every registration in the fetch, not only the ones
 * `recordRegistrants` keeps: a person who registered with no atlas and no
 * handle must still be found when they sign in. Replaced whole because the
 * fetch is the whole list: a registration that left Ideal Logic loses its
 * fingerprint, and a changed key takes effect at the next fetch.
 *
 * Only the fingerprint is written. A registration with a blank email address
 * has none and gets no row.
 */
export async function recordEmailFingerprints(
  db: Kysely<Database>,
  registrants: readonly Registrant[],
  key: Buffer,
): Promise<number> {
  const rows = [
    ...new Map(
      registrants
        .filter((r) => r.email.trim() !== "")
        .map((r) => [r.id, { ideal_logic_id: r.id, fingerprint: fingerprintEmail(key, r.email) }]),
    ).values(),
  ];
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("ideal_logic_email_fingerprint").execute();
    for (let i = 0; i < rows.length; i += 200) {
      await trx.insertInto("ideal_logic_email_fingerprint").values(rows.slice(i, i + 200)).execute();
    }
  });
  return rows.length;
}

/**
 * Delete every email fingerprint, and say how many there were. Run by the
 * nightly job where `REGISTRATION_EMAIL_KEY` is not set: a fingerprint made
 * under a key that has been removed can never be matched again, and the table
 * is documented as empty without a key.
 */
export async function clearEmailFingerprints(db: Kysely<Database>): Promise<number> {
  const gone = await db.deleteFrom("ideal_logic_email_fingerprint").executeTakeFirst();
  return Number(gone.numDeletedRows);
}

/**
 * `linkBySignInEmail` for whoever holds an iNaturalist account now. Sign-in
 * knows the account, not who holds it when its turn in the queue comes, since
 * staff may move the account to another person in between; so the holder is
 * read here, inside the turn. Does nothing where nobody holds the account.
 */
export async function linkAccountHolderBySignInEmail(
  db: Kysely<Database>,
  input: { inatUserId: number; email: string | null; emailConfirmed: boolean; key: Buffer | null },
): Promise<string | null> {
  const holder = await db
    .selectFrom("inat_account")
    .select("person_id")
    .where("inat_user_id", "=", BigInt(input.inatUserId))
    .executeTakeFirst();
  if (holder === undefined) return null;
  return linkBySignInEmail(db, {
    personId: Number(holder.person_id),
    email: input.email,
    emailConfirmed: input.emailConfirmed,
    key: input.key,
  });
}

/**
 * Link a person to the registration whose email address is the one
 * iNaturalist says is theirs, as they sign in (beeline-w8ab.7). Both ends
 * are proven: iNaturalist confirmed the address, and Ideal Logic holds it.
 * Returns the id it linked, or null where it did nothing.
 *
 * Does nothing unless the key is set, iNaturalist has confirmed the address
 * and it is not blank; nor where anything has been decided about this person
 * before (a link, an unlinking, or "no registration"), so a decision by staff
 * always wins; nor unless exactly one registration has the fingerprint, since
 * two registrations can share an address and then nobody can say which is
 * the person's. The registration need not have a row in
 * `ideal_logic_registrant`: the person may be one the nightly job did not
 * keep, and `recordRegistrants` keeps a linked registration from the next
 * night on.
 *
 * The address is fingerprinted at once and is neither stored nor put in a
 * message. The caller is to run this in the queue of decisions about people.
 */
export async function linkBySignInEmail(
  db: Kysely<Database>,
  input: { personId: number; email: string | null; emailConfirmed: boolean; key: Buffer | null },
): Promise<string | null> {
  if (input.key === null || !input.emailConfirmed || input.email === null || input.email.trim() === "") return null;
  const fingerprint = fingerprintEmail(input.key, input.email);
  return db.transaction().execute(async (trx) => {
    const decided = await trx
      .selectFrom("person_registration_event")
      .select("entity_id")
      .where("person_id", "=", input.personId)
      .limit(1)
      .executeTakeFirst();
    if (decided !== undefined) return null;
    const matches = await trx
      .selectFrom("ideal_logic_email_fingerprint")
      .select("ideal_logic_id")
      .where("fingerprint", "=", fingerprint)
      .limit(2)
      .execute();
    if (matches.length !== 1) return null;
    const idealLogicId = matches[0]!.ideal_logic_id;
    await trx
      .insertInto("person_registration_event")
      .values({ person_id: input.personId, ideal_logic_id: idealLogicId, evidence: "sign_in_email", decided_by: "sign-in", reference: null })
      .execute();
    return idealLogicId;
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
  | { ok: true; outcome: "saved" | "unchanged"; was: string | null; registrant: string | null }
  | { ok: false; refusal: "unknown_person" | "unknown_registration" | "name_differs" };

/**
 * Record that a person's registration is the one named, or with `null` that
 * they have none. The latest decision is the answer, so a second one
 * replaces the first without erasing it.
 *
 * Saying what is already so records nothing, with one exception: `null` for
 * a person nobody has decided about is recorded. Without that row there is
 * no way to say "this person has no registration", and the nightly job
 * would link them as soon as a handle and a name agreed.
 *
 * The registration must be one Beeline has a row for, so that a mistyped id,
 * or another registrant's, is refused and not stored. The answer carries the
 * registrant's name, for the caller to see who was linked. So the nightly
 * job has to have run before a link can be made.
 */
export async function decideRegistration(
  db: Kysely<Database>,
  input: { personId: number; idealLogicId: string | null; evidence: RegistrationEvidence; decidedBy: string; reference?: string | null },
): Promise<RegistrationDecision> {
  return db.transaction().execute(async (trx) => {
    const person = await trx
      .selectFrom("person")
      .select(["entity_id", "display_name"])
      .where("entity_id", "=", input.personId)
      .executeTakeFirst();
    if (person === undefined) return { ok: false, refusal: "unknown_person" } as const;

    let registrant: string | null = null;
    if (input.idealLogicId !== null) {
      const row = await trx
        .selectFrom("ideal_logic_registrant")
        .select(["given_name", "family_name"])
        .where("ideal_logic_id", "=", input.idealLogicId)
        .executeTakeFirst();
      if (row === undefined) return { ok: false, refusal: "unknown_registration" } as const;
      // The caller that matched on names did so from an exported file; a login
      // may have moved to another person since, so the names are compared again
      // here against what Beeline holds now.
      if (input.evidence === "register_email" && !namesAgree(person.display_name, `${row.given_name}${row.family_name}`)) {
        return { ok: false, refusal: "name_differs" } as const;
      }
      registrant = `${row.given_name} ${row.family_name}`;
    }

    const now = await trx
      .selectFrom("person_registration")
      .select("ideal_logic_id")
      .where("person_id", "=", input.personId)
      .executeTakeFirst();
    const was = now?.ideal_logic_id ?? null;
    if (was === input.idealLogicId) {
      const everDecided =
        was !== null ||
        (await trx.selectFrom("person_registration_event").select("entity_id").where("person_id", "=", input.personId).limit(1).executeTakeFirst()) !==
          undefined;
      if (everDecided) return { ok: true, outcome: "unchanged", was, registrant } as const;
    }
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
    return { ok: true, outcome: "saved", was, registrant } as const;
  });
}
