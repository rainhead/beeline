import { readFile } from "node:fs/promises";
import { parseCsv } from "./corrections.js";

/**
 * What a program has said about its records leaving it: the licence they go
 * out under, and the privacy policy that governs what is shown (beeline-rvun).
 * Each is a fact about the program with a range of seasons it holds for, so a
 * program can change its licence without restating what it published before.
 *
 * A row says "from this season on": it holds until the program's next row,
 * and the latest holds from then on. That is Peter's presumption made into
 * the rule (2026-10-10) — a program continues with the licence it most
 * recently used — and it means ranges cannot overlap or leave a gap between
 * two rows. A season before a program's first row has no licence, or no
 * policy, and Beeline exports nothing for it.
 *
 * Both files are curated in git, beside the taxon decisions: they are a
 * program's decisions, written down by whoever was told them, and every row
 * says who decided and why. The loader transcribes; it never presumes.
 *
 * A policy row records only that a program has established one, and where to
 * read it. Nothing in it is applied to the archive yet: what a policy must
 * answer before Beeline could apply it — which records are sensitive, how far
 * they are generalised, which other fields go with the coordinates, whether
 * names go out — is docs/research/program-governance-for-exports.md §2.
 */

export const PROGRAM_LICENSES = "ingest/program-licenses.csv";
export const PROGRAM_PRIVACY_POLICIES = "ingest/program-privacy-policies.csv";

/**
 * The three licences GBIF accepts for occurrence data, by their SPDX
 * identifiers, with the legal-code URL GBIF records for each.
 */
export const LICENSES = {
  "CC0-1.0": { name: "CC0 1.0", url: "http://creativecommons.org/publicdomain/zero/1.0/legalcode" },
  "CC-BY-4.0": { name: "CC BY 4.0", url: "http://creativecommons.org/licenses/by/4.0/legalcode" },
  "CC-BY-NC-4.0": { name: "CC BY-NC 4.0", url: "http://creativecommons.org/licenses/by-nc/4.0/legalcode" },
} as const;
export type LicenseId = keyof typeof LICENSES;

const LICENSE_COLUMNS = ["program", "from_season", "license", "decided_by", "decided_on", "source", "reason"] as const;
const POLICY_COLUMNS = ["program", "from_season", "url", "decided_by", "decided_on", "reason"] as const;

export interface ProgramLicense {
  program: string;
  fromSeason: number;
  license: LicenseId;
  decidedBy: string;
  decidedOn: string;
  /** Where the licence was seen or stated: a GBIF dataset, an email, a meeting. */
  source: string;
  reason: string;
}

export interface ProgramPrivacyPolicy {
  program: string;
  fromSeason: number;
  /** The policy as published, where it has a page of its own; empty where it does not yet. */
  url: string;
  decidedBy: string;
  decidedOn: string;
  reason: string;
}

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/** The fields shared by both files, checked the same way. */
function commonProblem(row: Record<string, string>): string | null {
  if (!/^[A-Za-z0-9]+$/.test(row.program!)) return `program '${row.program}' is not a program code`;
  if (!/^\d{4}$/.test(row.from_season!)) return `from_season '${row.from_season}' is not a season (the year it began)`;
  if (row.decided_by!.trim() === "") return "every row names who decided";
  if (!isDate(row.decided_on!)) return `decided_on '${row.decided_on}' is not a date (YYYY-MM-DD)`;
  if (row.reason!.trim() === "") return "every row says why";
  return null;
}

function parseRows<C extends readonly string[]>(
  text: string,
  where: string,
  columns: C,
  problem: (row: Record<C[number], string>) => string | null,
): Record<C[number], string>[] {
  const records = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ""));
  if (records.length === 0) return [];
  const header = columns.join(",");
  if (records[0]!.join(",") !== header) throw new Error(`${where}: header is '${records[0]!.join(",")}', expected '${header}'`);
  const seen = new Set<string>();
  return records.slice(1).map((r, i) => {
    const line = i + 2;
    if (r.length !== columns.length) throw new Error(`${where} line ${line}: ${r.length} fields, expected ${columns.length}`);
    const row = Object.fromEntries(columns.map((c, j) => [c, r[j]!])) as Record<C[number], string>;
    const bad = commonProblem(row) ?? problem(row);
    if (bad !== null) throw new Error(`${where} line ${line}: ${bad}`);
    const key = `${(row as Record<string, string>).program}/${(row as Record<string, string>).from_season}`;
    if (seen.has(key)) throw new Error(`${where} line ${line}: ${key.replace("/", " from ")} is stated twice`);
    seen.add(key);
    return row;
  });
}

export function parseProgramLicenses(text: string, where: string): ProgramLicense[] {
  return parseRows(text, where, LICENSE_COLUMNS, (r) => {
    if (!(r.license in LICENSES)) return `license '${r.license}' is not one GBIF accepts (${Object.keys(LICENSES).join(", ")})`;
    if (r.source.trim() === "") return "every licence says where it was seen or stated";
    return null;
  }).map((r) => ({
    program: r.program,
    fromSeason: Number(r.from_season),
    license: r.license as LicenseId,
    decidedBy: r.decided_by,
    decidedOn: r.decided_on,
    source: r.source,
    reason: r.reason,
  }));
}

export function parseProgramPrivacyPolicies(text: string, where: string): ProgramPrivacyPolicy[] {
  return parseRows(text, where, POLICY_COLUMNS, (r) =>
    r.url === "" || /^https?:\/\/\S+$/.test(r.url) ? null : `url '${r.url}' is not a web address`,
  ).map((r) => ({
    program: r.program,
    fromSeason: Number(r.from_season),
    url: r.url,
    decidedBy: r.decided_by,
    decidedOn: r.decided_on,
    reason: r.reason,
  }));
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export interface ProgramGovernance {
  licenses: ProgramLicense[];
  policies: ProgramPrivacyPolicy[];
}

export interface GovernancePaths {
  licenses?: string;
  policies?: string;
}

/** Both files, read fresh: a decision merged in git holds from the next read. */
export async function readProgramGovernance(paths: GovernancePaths = {}): Promise<ProgramGovernance> {
  const licensesPath = paths.licenses ?? PROGRAM_LICENSES;
  const policiesPath = paths.policies ?? PROGRAM_PRIVACY_POLICIES;
  return {
    licenses: parseProgramLicenses(await readOrEmpty(licensesPath), licensesPath),
    policies: parseProgramPrivacyPolicies(await readOrEmpty(policiesPath), policiesPath),
  };
}

/** The row in force for a program's season: its latest row from that season or before. */
export function inForce<T extends { program: string; fromSeason: number }>(
  rows: readonly T[],
  program: string,
  season: number,
): T | null {
  let found: T | null = null;
  for (const row of rows) {
    if (row.program !== program || row.fromSeason > season) continue;
    if (found === null || row.fromSeason > found.fromSeason) found = row;
  }
  return found;
}

/** What one program-season may do: exported only with both a licence and a privacy policy. */
export interface SeasonGovernance {
  license: ProgramLicense | null;
  policy: ProgramPrivacyPolicy | null;
}

export function governanceFor(g: ProgramGovernance, program: string, season: number): SeasonGovernance {
  return { license: inForce(g.licenses, program, season), policy: inForce(g.policies, program, season) };
}
