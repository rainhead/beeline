import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { PROGRAM_MEMBERSHIP } from "../model.js";
import { ECDYSIS_COLLECTIONS, type EcdysisCollection } from "../fetch-ecdysis.js";
import type { ProgramContact } from "../program-contacts.js";
import type { ProgramGovernance, ProgramLicense, ProgramPrivacyPolicy } from "../program-governance.js";
import { OUTSIDE } from "./listings.js";
import { personHandle } from "./roster.js";

/**
 * The programs, as a listing and a page each (beeline-rrit): what Beeline
 * knows about a program, which until now was said in a dozen places — its
 * leads, how many people belong to it, its records by season, who prints its
 * labels, its answer on taxon-obscured coordinates, the licence and privacy
 * policy its records leave under, where its expert determinations come back
 * from, and how to reach it.
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
 * fell. A season is sample_season's, which turns on 1 March.
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
  /** The open season, and the program's records in it (zeros where it has none yet). */
  openSeason: SeasonCounts;
  /** Every season's specimens together. */
  specimens: number;
}

export interface TaxonObscuredAnswer {
  decidedBy: string;
  decidedOn: Date;
  source: string;
}

export interface ProgramDetail extends ProgramSummary {
  /** Every season it has records in, newest first. */
  seasons: SeasonCounts[];
  /** Who prints its labels: itself, in runs scoped to it, or the program's runs; null where it has no records to print. */
  printing: "own" | "program" | null;
  /**
   * Its answer on printing a taxon-obscured record's true point: the answer,
   * `unanswered` for an atlas that has not given one, or `none` where no atlas
   * can answer — Master Melittology's records fall outside every atlas, and
   * the surveys have none by geography.
   */
  taxonObscured: TaxonObscuredAnswer | "unanswered" | "none";
  contacts: ProgramContact[];
  licenses: ProgramLicense[];
  policies: ProgramPrivacyPolicy[];
  /** The Ecdysis collections its expert determinations are read back from. */
  ecdysis: EcdysisCollection[];
}

interface ProgramRow {
  program_id: number;
  code: string;
  name: string;
  atlas_id: number | null;
  atlas_code: string | null;
}

const scopeOf = (p: { code: string; atlas_code: string | null }) =>
  p.atlas_code ?? (p.code === CATCH_ALL_PROGRAM ? OUTSIDE : null);

const emptySeason = (season: number): SeasonCounts => ({ season, samples: 0, specimens: 0, collectors: 0 });

async function programRows(db: Kysely<Database>, code?: string): Promise<ProgramRow[]> {
  const where = code === undefined ? sql`` : sql`WHERE lower(p.code) = lower(${code})`;
  const { rows } = await sql<ProgramRow>`
    SELECT p.entity_id AS program_id, p.code, p.name, p.atlas_id, a.code AS atlas_code
    FROM program p LEFT JOIN atlas a ON a.entity_id = p.atlas_id
    ${where}
    -- The atlases first, then the programs that are not one, each by name.
    ORDER BY p.atlas_id IS NULL, p.name`.execute(db);
  return rows;
}

async function openSeason(db: Kysely<Database>): Promise<number> {
  const { rows } = await sql<{ year: number }>`SELECT CAST(EXTRACT(YEAR FROM started_on) AS INTEGER) AS year FROM season`.execute(db);
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
      LEFT JOIN atlas a ON a.entity_id = sa.atlas_id
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

/** People who belong to each program, by program code: an atlas's members, and Master Melittology's with no atlas. */
async function memberCounts(db: Kysely<Database>): Promise<Map<string, number>> {
  const { rows } = await sql<{ code: string; n: number }>`
    SELECT coalesce(a.code, ${CATCH_ALL_PROGRAM}) AS code, count(*) AS n
    FROM person_membership m LEFT JOIN atlas a ON a.entity_id = m.atlas_id
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
    name: p.name,
    atlasCode: p.atlas_code,
    scope,
    leads: leads.get(p.program_id) ?? [],
    members: isMember ? (members.get(p.atlas_code ?? CATCH_ALL_PROGRAM) ?? 0) : null,
    memberFilter: p.atlas_code ?? (p.code === CATCH_ALL_PROGRAM ? PROGRAM_MEMBERSHIP : null),
    openSeason: seasons.find((s) => s.season === season) ?? emptySeason(season),
    specimens: seasons.reduce((total, s) => total + s.specimens, 0),
    seasons,
  };
}

export async function listPrograms(db: Kysely<Database>): Promise<ProgramSummary[]> {
  const [programs, season, counts, members, leads] = await Promise.all([
    programRows(db),
    openSeason(db),
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
  { governance, contacts }: { governance: ProgramGovernance; contacts: readonly ProgramContact[] },
): Promise<ProgramDetail | null> {
  const [p] = await programRows(db, code);
  if (p === undefined) return null;
  const [season, counts, members, leads] = await Promise.all([openSeason(db), seasonCounts(db), memberCounts(db), leadsByProgram(db)]);
  const summary = summarize(p, season, counts, members, leads);
  let printing: ProgramDetail["printing"] = null;
  let taxonObscured: ProgramDetail["taxonObscured"] = "none";
  if (p.atlas_id !== null) {
    const { rows: own } = await sql<{ n: number }>`SELECT count(*) AS n FROM atlas_printing WHERE atlas_id = ${p.atlas_id}`.execute(db);
    printing = Number(own[0]!.n) > 0 ? "own" : "program";
    const { rows: answers } = await sql<{ decided_by: string; decided_on: Date; source: string }>`
      SELECT decided_by, decided_on, source FROM atlas_taxon_obscured_printing WHERE atlas_id = ${p.atlas_id}`.execute(db);
    const answer = answers[0];
    taxonObscured =
      answer === undefined
        ? "unanswered"
        : { decidedBy: answer.decided_by, decidedOn: new Date(answer.decided_on), source: answer.source };
  } else if (summary.scope !== null) {
    // Master Melittology's are the samples outside every atlas, which the
    // program's own runs print.
    printing = "program";
  }
  const byProgram = <T extends { program: string }>(rows: readonly T[]) => rows.filter((r) => r.program === p.code);
  return {
    ...summary,
    printing,
    taxonObscured,
    contacts: byProgram(contacts),
    licenses: byProgram(governance.licenses).sort((a, b) => a.fromSeason - b.fromSeason),
    policies: byProgram(governance.policies).sort((a, b) => a.fromSeason - b.fromSeason),
    ecdysis: ECDYSIS_COLLECTIONS.filter((c) => c.program === p.code),
  };
}

export const programHref = (code: string): string => `/programs/${encodeURIComponent(code)}`;
