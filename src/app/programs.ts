import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { PROGRAM_MEMBERSHIP } from "../model.js";
import { describeScope, ECDYSIS_COLLECTIONS } from "../fetch-ecdysis.js";
import type { ProgramContact, ProgramContacts } from "../program-contacts.js";
import { OUTSIDE } from "./listings.js";
import { personHandle } from "./roster.js";

/**
 * The programs, as a listing and a page each (beeline-rrit): what Beeline
 * knows about a program, which until now was said in a dozen places — its
 * leads, how many people belong to it, its records by season, who prints its
 * labels, where its expert determinations come back from, and how to reach
 * it.
 *
 * Read by everyone signed in, like the taxonomy: it shows totals, the names
 * of the program's own leads, and nobody's records. The links into records
 * and people are staff's, because the listings and the roster they land on
 * are.
 *
 * A program is addressed by its code, which the overlay already names it by
 * and a rebuild does not redraw.
 *
 * Which records are a program's follows the archives' rule
 * (src/app/program-archives.ts): an atlas's are those collected on its
 * ground, Master Melittology's those no atlas covers, and the BLM surveys
 * have none by geography — their samples will arrive through their own field
 * entry and belong to them by the collecting event, never by where they
 * fell. A season is sample_season's: the calendar year of a sample's first
 * day. The page's glance is the current season, so in January it starts
 * again from nothing; last season stays in the table of every season.
 */

/** The program whose records are those no atlas covers (CONTEXT.md). */
const CATCH_ALL_PROGRAM = "MM";

export interface ProgramLead {
  name: string;
  /** Their address on /people (personHandle). */
  handle: string;
}

export interface SeasonCounts {
  season: number;
  samples: number;
  specimens: number;
  /** People who collected at least one of the season's samples, a pair counting as two. */
  collectors: number;
}

export interface ProgramSummary {
  code: string;
  /** As people abbreviate it (program_abbreviation): WABA where the code is WaBA. */
  abbreviation: string;
  name: string;
  /** The atlas this program is; null for Master Melittology and the BLM surveys. */
  atlasCode: string | null;
  /** The listings' scope that holds its records: its atlas's code, `outside`, or null where geography gives it none. */
  scope: string | null;
  leads: ProgramLead[];
  /** How many people belong to it; null where membership cannot name it (the BLM surveys). */
  members: number | null;
  /** The roster's `member` filter for those people, where there is one. */
  memberFilter: string | null;
  /** The current season, and the program's records in it (zeros where it has none yet). */
  currentSeason: SeasonCounts;
  /** Every season's specimens together. */
  specimens: number;
}

export interface ProgramDetail extends ProgramSummary {
  /** Every season it has records in, newest first. */
  seasons: SeasonCounts[];
  /** Who prints its labels: itself, in runs scoped to it, or the program's runs; null where it has no records to print. */
  printing: "own" | "program" | null;
  /** The address it gives people for questions, as staff last set it; null where none is set. */
  email: ProgramContact | null;
  /** The Ecdysis collections its expert determinations are read back from. */
  /** Each Ecdysis collection its determinations come back from, as "dataset 44" or "collection 196". */
  ecdysis: string[];
}

interface ProgramRow {
  program_id: number;
  code: string;
  abbreviation: string;
  name: string;
  atlas_id: number | null;
  atlas_code: string | null;
}

const scopeOf = (p: { code: string; atlas_code: string | null }) =>
  p.atlas_code ?? (p.code === CATCH_ALL_PROGRAM ? OUTSIDE : null);

const emptySeason = (season: number): SeasonCounts => ({ season, samples: 0, specimens: 0, collectors: 0 });

async function programRows(db: Kysely<Database>, code?: string): Promise<ProgramRow[]> {
  const where = code === undefined ? sql`` : sql`WHERE lower(p.code) = lower(${code})`;
  // A program's records by geography are the samples on the states
  // atlas_region assigns it (schema/010); a program with none has no ground,
  // and its scope is decided below. atlas_id and atlas_code are the program's
  // own where it has ground, which is what the rest of this file reads.
  const { rows } = await sql<ProgramRow>`
    SELECT p.entity_id AS program_id, p.code, coalesce(ab.abbreviation, p.code) AS abbreviation, p.name,
           CASE WHEN g.atlas_id IS NOT NULL THEN p.entity_id END AS atlas_id,
           CASE WHEN g.atlas_id IS NOT NULL THEN p.code END AS atlas_code
    FROM program p
    LEFT JOIN program_abbreviation ab ON ab.program_id = p.entity_id
    LEFT JOIN (SELECT DISTINCT atlas_id FROM atlas_region WHERE atlas_id IS NOT NULL) g ON g.atlas_id = p.entity_id
    ${where}
    -- The programs with ground first, then the rest, each by name.
    ORDER BY g.atlas_id IS NULL, p.name`.execute(db);
  return rows;
}

async function currentSeason(db: Kysely<Database>): Promise<number> {
  const { rows } = await sql<{ year: number }>`SELECT current_season AS year FROM season`.execute(db);
  return Number(rows[0]!.year);
}

/**
 * Samples, specimens and collectors per listing scope and season: an atlas
 * code, or `outside` for a sample no atlas covers — whether geography said so
 * (no sample_atlas row) or a person did (a row with no atlas), as the
 * listings read it.
 */
async function seasonCounts(db: Kysely<Database>): Promise<Map<string, SeasonCounts[]>> {
  const { rows } = await sql<{ scope: string; season: number; samples: number; specimens: number; collectors: number }>`
    WITH placed AS (
      SELECT ss.sample_id, coalesce(a.code, ${OUTSIDE}) AS scope, ss.season
      FROM sample_season ss
      LEFT JOIN sample_atlas sa ON sa.sample_id = ss.sample_id
      LEFT JOIN program a ON a.entity_id = sa.atlas_id
    ),
    specimens AS (SELECT sample_id, count(*) AS n FROM specimen GROUP BY sample_id),
    collectors AS (
      SELECT q.scope, q.season, count(DISTINCT sc.person_id) AS n
      FROM placed q JOIN sample_collector sc ON sc.sample_id = q.sample_id
      GROUP BY q.scope, q.season
    )
    SELECT q.scope, q.season, count(*) AS samples, coalesce(sum(sp.n), 0) AS specimens,
           coalesce(any_value(c.n), 0) AS collectors
    FROM placed q
    LEFT JOIN specimens sp ON sp.sample_id = q.sample_id
    LEFT JOIN collectors c ON c.scope = q.scope AND c.season = q.season
    GROUP BY q.scope, q.season`.execute(db);
  const byScope = new Map<string, SeasonCounts[]>();
  for (const r of rows) {
    const list = byScope.get(r.scope) ?? [];
    list.push({ season: Number(r.season), samples: Number(r.samples), specimens: Number(r.specimens), collectors: Number(r.collectors) });
    byScope.set(r.scope, list);
  }
  for (const list of byScope.values()) list.sort((a, b) => b.season - a.season);
  return byScope;
}

/** People who belong to each program, by program code: membership names the program itself (schema/010). */
async function memberCounts(db: Kysely<Database>): Promise<Map<string, number>> {
  const { rows } = await sql<{ code: string; n: number }>`
    SELECT pr.code, count(*) AS n
    FROM person_membership m JOIN program pr ON pr.entity_id = m.program_id
    GROUP BY 1`.execute(db);
  return new Map(rows.map((r) => [r.code, Number(r.n)]));
}

async function leadsByProgram(db: Kysely<Database>): Promise<Map<number, ProgramLead[]>> {
  const { rows } = await sql<{ program_id: number; person_id: number; name: string; login: string | null }>`
    SELECT pl.program_id, p.entity_id AS person_id, p.display_name AS name, ia.login
    FROM program_lead pl
    JOIN person p ON p.entity_id = pl.person_id
    LEFT JOIN inat_account ia ON ia.person_id = p.entity_id
    ORDER BY p.display_name`.execute(db);
  const leads = new Map<number, ProgramLead[]>();
  for (const r of rows) {
    const list = leads.get(r.program_id) ?? [];
    list.push({ name: r.name, handle: personHandle({ person_id: r.person_id, login: r.login }) });
    leads.set(r.program_id, list);
  }
  return leads;
}

function summarize(
  p: ProgramRow,
  season: number,
  counts: Map<string, SeasonCounts[]>,
  members: Map<string, number>,
  leads: Map<number, ProgramLead[]>,
): ProgramSummary & { seasons: SeasonCounts[] } {
  const scope = scopeOf(p);
  const seasons = scope === null ? [] : (counts.get(scope) ?? []);
  const isMember = p.atlas_code !== null || p.code === CATCH_ALL_PROGRAM;
  return {
    code: p.code,
    abbreviation: p.abbreviation,
    name: p.name,
    atlasCode: p.atlas_code,
    scope,
    leads: leads.get(p.program_id) ?? [],
    members: isMember ? (members.get(p.atlas_code ?? CATCH_ALL_PROGRAM) ?? 0) : null,
    memberFilter: p.atlas_code ?? (p.code === CATCH_ALL_PROGRAM ? PROGRAM_MEMBERSHIP : null),
    currentSeason: seasons.find((s) => s.season === season) ?? emptySeason(season),
    specimens: seasons.reduce((total, s) => total + s.specimens, 0),
    seasons,
  };
}

export async function listPrograms(db: Kysely<Database>): Promise<ProgramSummary[]> {
  const [programs, season, counts, members, leads] = await Promise.all([
    programRows(db),
    currentSeason(db),
    seasonCounts(db),
    memberCounts(db),
    leadsByProgram(db),
  ]);
  return programs.map((p) => {
    const { seasons: _seasons, ...summary } = summarize(p, season, counts, members, leads);
    return summary;
  });
}

/** One program by its code, any case; null where there is none. */
export async function loadProgram(
  db: Kysely<Database>,
  code: string,
  { contacts }: { contacts: ProgramContacts },
): Promise<ProgramDetail | null> {
  const [p] = await programRows(db, code);
  if (p === undefined) return null;
  const [season, counts, members, leads] = await Promise.all([currentSeason(db), seasonCounts(db), memberCounts(db), leadsByProgram(db)]);
  const summary = summarize(p, season, counts, members, leads);
  let printing: ProgramDetail["printing"] = null;
  if (p.atlas_id !== null) {
    const { rows: own } = await sql<{ n: number }>`SELECT count(*) AS n FROM atlas_printing WHERE atlas_id = ${p.atlas_id}`.execute(db);
    printing = Number(own[0]!.n) > 0 ? "own" : "program";
  } else if (summary.scope !== null) {
    // Master Melittology's are the samples outside every atlas, which the
    // program's own runs print.
    printing = "program";
  }
  return {
    ...summary,
    printing,
    email: contacts.get(p.code)?.email ?? null,
    ecdysis: ECDYSIS_COLLECTIONS.filter((c) => c.program === p.code).map(describeScope),
  };
}

export const programHref = (code: string): string => `/programs/${encodeURIComponent(code)}`;

/** Where a program's Data tab is, and the routes under it (`/programs/:code/data/...`). */
export const programDataHref = (code: string): string => `${programHref(code)}/data`;

/** A program whose Data tab a person may open, as `programDataAccess` names it. */
export interface ProgramDataAccess {
  /** The program's code as the store spells it, whatever case the address used. */
  code: string;
  name: string;
}

/**
 * Who may open a program's Data tab, and every route under it: the program's
 * nightly Darwin Core archives and the files made for uploading to Ecdysis
 * (Peter, 2026-11-21, beeline-q8di). These hold collectors' names and true
 * coordinates, so they are for the program's leads and for admins, and not
 * for staff generally or for the leads of other programs.
 *
 * The rule: the person is an admin, or is one of this program's leads
 * (`program_lead`). Anyone else gets the app's not-found answer, so that the
 * tab's existence is not revealed.
 *
 * Every route under the tab calls this, and so does the program page that
 * decides whether to draw the link, so the link and the routes cannot
 * disagree. `personId` is the person the page is being drawn for: the
 * signed-in person, or, while an admin is impersonating somebody, the
 * impersonated person, so that the tab is seen as that person would see it.
 * `admin` is the request's `admin` flag, which is already false while
 * impersonating. Delegation (acting for a household member) is not used:
 * it widens whose samples a person reaches, never what they may download.
 * Whether a download or an action is allowed while impersonating is for the
 * route to refuse (the read-only rule), not for this function.
 *
 * Returns the program (its code as stored), or null when there is no such
 * program or the person may not open its tab.
 */
export async function programDataAccess(
  db: Kysely<Database>,
  { code, personId, admin }: { code: string; personId: number | null; admin: boolean },
): Promise<ProgramDataAccess | null> {
  const { rows } = await sql<{ code: string; name: string; lead: boolean }>`
    SELECT p.code, p.name,
           coalesce(${personId} IN (SELECT pl.person_id FROM program_lead pl WHERE pl.program_id = p.entity_id), false) AS lead
    FROM program p
    WHERE lower(p.code) = lower(${code})`.execute(db);
  const program = rows[0];
  if (program === undefined) return null;
  return admin || program.lead ? { code: program.code, name: program.name } : null;
}
