import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { foldName, MIN_FOLDED_NAME, namesAgree } from "../registrations.js";

/**
 * The staff screen for registrations (beeline-w8ab.2): which collectors have
 * no registration decided, which registrant might be each one, and the
 * registrants nobody is linked to.
 *
 * Reads only what Beeline keeps. A registration's email address and home
 * address are not in the store, and nothing here fetches them.
 */

/** Why a registrant is suggested for a person. Several can hold at once. */
export type RegistrationReason = "full_name" | "family_name" | "handle";

export interface RegistrantSuggestion {
  ideal_logic_id: string;
  given_name: string;
  family_name: string;
  atlases: string[];
  inat_handle: string | null;
  reasons: RegistrationReason[];
  /** Other people already linked to this registration: a household shares one. */
  linked_to: string[];
}

export interface UndecidedCollector {
  person_id: number;
  display_name: string;
  login: string | null;
  /** "atlas" (see atlas_abbreviation), "program", or null where nobody has been asked. */
  membership: "atlas" | "program" | null;
  atlas_abbreviation: string | null;
  /** Samples they are the primary collector of. */
  samples: number;
  last_sample: Date;
  /** Samples of theirs with labels still to be printed. */
  waiting: number;
  /** Labels of theirs in a run that has not been mailed (and is not canceled). */
  in_unmailed_run: number;
  suggestions: RegistrantSuggestion[];
}

export interface UnplacedRegistrant {
  ideal_logic_id: string;
  given_name: string;
  family_name: string;
  atlases: string[];
  inat_handle: string | null;
  first_seen_at: Date;
  /** The observer on /unclaimed whose login is this handle, if there is one. */
  unclaimed_user_id: number | null;
}

export interface RegistrationsListing {
  collectors: UndecidedCollector[];
  registrants: UnplacedRegistrant[];
}

const foldLogin = (s: string) => s.trim().toLowerCase();
const atlasList = (s: string | null): string[] => (s === null ? [] : s.split(";").filter((x) => x !== ""));

/**
 * Every person with a sample as primary collector and no decision at all
 * about their registration, most pressing first: labels waiting to be
 * printed, then labels in a run that has not been mailed, then the rest by
 * their latest sample.
 */
async function undecidedCollectors(db: Kysely<Database>) {
  const found = await sql<{
    person_id: number;
    display_name: string;
    family_name: string | null;
    login: string | null;
    membership: "atlas" | "program" | null;
    atlas_abbreviation: string | null;
    samples: number | bigint;
    last_sample: Date;
    waiting: number | bigint;
    in_unmailed_run: number | bigint;
  }>`
    WITH mine AS (
      SELECT pc.person_id, pc.sample_id, s.date_start
      FROM sample_primary_collector pc
      JOIN sample s ON s.entity_id = pc.sample_id
      WHERE NOT EXISTS (SELECT 1 FROM person_registration_event e WHERE e.person_id = pc.person_id)
    ),
    unmailed AS (
      SELECT sp.sample_id, count(*) AS labels
      FROM printed_label pl
      JOIN print_run_state st ON st.print_run_id = pl.print_run_id
      JOIN specimen sp ON sp.entity_id = pl.specimen_id
      WHERE st.state IN ('prepared', 'approved', 'printed')
      GROUP BY sp.sample_id
    ),
    totals AS (
      SELECT m.person_id,
             count(*) AS samples,
             max(m.date_start) AS last_sample,
             count(pp.sample_id) AS waiting,
             coalesce(sum(u.labels), 0) AS in_unmailed_run
      FROM mine m
      LEFT JOIN pending_print_sample pp ON pp.sample_id = m.sample_id
      LEFT JOIN unmailed u ON u.sample_id = m.sample_id
      GROUP BY m.person_id
    )
    SELECT p.entity_id AS person_id, p.display_name, p.family_name, a.login,
           CASE WHEN pm.person_id IS NULL THEN NULL WHEN atl.code = 'MM' THEN 'program' ELSE 'atlas' END AS membership,
           CASE WHEN atl.code <> 'MM' THEN coalesce(atlab.abbreviation, atl.code) END AS atlas_abbreviation,
           t.samples, t.last_sample, t.waiting, t.in_unmailed_run
    FROM totals t
    JOIN person p ON p.entity_id = t.person_id
    LEFT JOIN inat_account a ON a.person_id = p.entity_id
    LEFT JOIN person_membership pm ON pm.person_id = p.entity_id
    LEFT JOIN program atl ON atl.entity_id = pm.program_id
    LEFT JOIN program_abbreviation atlab ON atlab.program_id = atl.entity_id
    ORDER BY (t.waiting > 0) DESC, (t.in_unmailed_run > 0) DESC, t.last_sample DESC, p.display_name, p.entity_id`.execute(db);
  return found.rows;
}

/**
 * The observers listed on /unclaimed, by the login the list shows
 * (listUnclaimed takes the login of the observer's newest record), folded to
 * lower case. Where two observers fold alike, the lower user id wins, so the
 * choice is stable.
 */
async function unclaimedByLogin(db: Kysely<Database>): Promise<Map<string, number>> {
  const found = await sql<{ user_id: number | bigint; login: string }>`
    SELECT user_id, arg_max(user_login, inat_id) AS login
    FROM unclaimed_record
    WHERE user_id IS NOT NULL
    GROUP BY user_id
    ORDER BY user_id DESC`.execute(db);
  const out = new Map<string, number>();
  for (const r of found.rows) out.set(foldLogin(r.login), Number(r.user_id));
  return out;
}

export async function listRegistrations(db: Kysely<Database>): Promise<RegistrationsListing> {
  const people = await undecidedCollectors(db);
  const registrants = await db
    .selectFrom("ideal_logic_registrant")
    .select(["ideal_logic_id", "given_name", "family_name", "atlases", "inat_handle", "first_seen_at"])
    .orderBy("ideal_logic_id")
    .execute();

  const holders = new Map<string, string[]>();
  const linked = await sql<{ ideal_logic_id: string; display_name: string }>`
    SELECT r.ideal_logic_id, p.display_name
    FROM person_registration r JOIN person p ON p.entity_id = r.person_id
    ORDER BY p.display_name`.execute(db);
  for (const l of linked.rows) {
    const at = holders.get(l.ideal_logic_id);
    if (at) at.push(l.display_name);
    else holders.set(l.ideal_logic_id, [l.display_name]);
  }

  const collectors: UndecidedCollector[] = people.map((p) => {
    const login = p.login === null ? null : foldLogin(p.login);
    const family = foldName(p.family_name ?? "");
    const suggestions: RegistrantSuggestion[] = [];
    for (const r of registrants) {
      const reasons: RegistrationReason[] = [];
      if (namesAgree(p.display_name, `${r.given_name}${r.family_name}`)) reasons.push("full_name");
      // The whole name agreeing says the family name does too, so it is not said twice.
      if (!reasons.includes("full_name") && family.length >= MIN_FOLDED_NAME && family === foldName(r.family_name)) {
        reasons.push("family_name");
      }
      if (login !== null && login !== "" && r.inat_handle !== null && foldLogin(r.inat_handle) === login) {
        reasons.push("handle");
      }
      if (reasons.length === 0) continue;
      suggestions.push({
        ideal_logic_id: r.ideal_logic_id,
        given_name: r.given_name,
        family_name: r.family_name,
        atlases: atlasList(r.atlases),
        inat_handle: r.inat_handle,
        reasons,
        linked_to: holders.get(r.ideal_logic_id) ?? [],
      });
    }
    // The strongest evidence first: a handle or a whole name before a family name alone.
    const strength = (s: RegistrantSuggestion) => (s.reasons.includes("family_name") && s.reasons.length === 1 ? 1 : 0);
    suggestions.sort((a, b) => strength(a) - strength(b) || b.reasons.length - a.reasons.length);
    return {
      person_id: p.person_id,
      display_name: p.display_name,
      login: p.login,
      membership: p.membership,
      atlas_abbreviation: p.atlas_abbreviation,
      samples: Number(p.samples),
      last_sample: p.last_sample,
      waiting: Number(p.waiting),
      in_unmailed_run: Number(p.in_unmailed_run),
      suggestions,
    };
  });

  const observers = await unclaimedByLogin(db);
  const unplaced = await sql<{
    ideal_logic_id: string;
    given_name: string;
    family_name: string;
    atlases: string | null;
    inat_handle: string | null;
    first_seen_at: Date;
  }>`
    SELECT r.ideal_logic_id, r.given_name, r.family_name, r.atlases, r.inat_handle, r.first_seen_at
    FROM ideal_logic_registrant r
    WHERE (r.atlases IS NOT NULL OR r.inat_handle IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM person_registration pr WHERE pr.ideal_logic_id = r.ideal_logic_id)
    ORDER BY r.first_seen_at DESC, r.family_name, r.given_name, r.ideal_logic_id`.execute(db);

  return {
    collectors,
    registrants: unplaced.rows.map((r) => ({
      ideal_logic_id: r.ideal_logic_id,
      given_name: r.given_name,
      family_name: r.family_name,
      atlases: atlasList(r.atlases),
      inat_handle: r.inat_handle,
      first_seen_at: r.first_seen_at,
      unclaimed_user_id: r.inat_handle === null ? null : (observers.get(foldLogin(r.inat_handle)) ?? null),
    })),
  };
}

/** What a person's page says about their registration. */
export interface PersonRegistration {
  /** The latest decision: null where none has been made. */
  decided: boolean;
  ideal_logic_id: string | null;
  registrant: string | null;
  evidence: string | null;
  decided_by: string | null;
  decided_at: Date | null;
}

export async function registrationOf(db: Kysely<Database>, personId: number): Promise<PersonRegistration> {
  const latest = await db
    .selectFrom("person_registration_event")
    .select(["ideal_logic_id", "evidence", "decided_by", "decided_at"])
    .where("person_id", "=", personId)
    .orderBy("entity_id", "desc")
    .limit(1)
    .executeTakeFirst();
  if (latest === undefined) {
    return { decided: false, ideal_logic_id: null, registrant: null, evidence: null, decided_by: null, decided_at: null };
  }
  const who =
    latest.ideal_logic_id === null
      ? undefined
      : await db
          .selectFrom("ideal_logic_registrant")
          .select(["given_name", "family_name"])
          .where("ideal_logic_id", "=", latest.ideal_logic_id)
          .executeTakeFirst();
  return {
    decided: true,
    ideal_logic_id: latest.ideal_logic_id,
    registrant: who === undefined ? null : `${who.given_name} ${who.family_name}`,
    evidence: latest.evidence,
    decided_by: latest.decided_by,
    decided_at: latest.decided_at,
  };
}
