import { readFile } from "node:fs/promises";
import { parseCsv } from "./corrections.js";

/**
 * How to reach a program: the addresses it publishes for people to write to,
 * and its own website (beeline-rrit). Shown on the program's page.
 *
 * Curated in git beside the licence and privacy-policy decisions, because a
 * program's contact is something the program has published, written down by
 * whoever saw it, and every row says where it was seen. It holds a program's
 * own addresses and never a person's: a lead's email is personal data, and the
 * legacy register's email column is deliberately never brought into the store.
 * The leads themselves are named on the page from program_lead.
 *
 * The loader transcribes; it never presumes. The file starts empty, and a
 * program with no row says it has none recorded.
 */

export const PROGRAM_CONTACTS = "ingest/program-contacts.csv";

/** What a contact is: somewhere to write, or the program's own site. */
export const CONTACT_KINDS = ["email", "website"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

const COLUMNS = ["program", "kind", "value", "label", "source", "recorded_by", "recorded_on"] as const;

export interface ProgramContact {
  program: string;
  kind: ContactKind;
  /** An email address, or an http(s) URL. */
  value: string;
  /** What it is for, where the program says ("Volunteer coordinator"); empty where it does not. */
  label: string;
  /** Where it was seen: the program's page, an email, a meeting. */
  source: string;
  recordedBy: string;
  recordedOn: string;
}

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

function problem(row: Record<(typeof COLUMNS)[number], string>): string | null {
  if (!/^[A-Za-z0-9]+$/.test(row.program)) return `program '${row.program}' is not a program code`;
  if (!(CONTACT_KINDS as readonly string[]).includes(row.kind)) {
    return `kind '${row.kind}' is not one of ${CONTACT_KINDS.join(", ")}`;
  }
  if (row.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.value)) return `'${row.value}' is not an email address`;
  // A link drawn on a page: http(s) only, since escaping does not stop a
  // javascript: scheme from being a scheme.
  if (row.kind === "website" && !/^https?:\/\/\S+$/.test(row.value)) return `'${row.value}' is not a web address`;
  if (row.source.trim() === "") return "every row says where it was seen";
  if (row.recorded_by.trim() === "") return "every row names who recorded it";
  if (!isDate(row.recorded_on)) return `recorded_on '${row.recorded_on}' is not a date (YYYY-MM-DD)`;
  return null;
}

export function parseProgramContacts(text: string, where: string): ProgramContact[] {
  const records = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ""));
  if (records.length === 0) return [];
  const header = COLUMNS.join(",");
  if (records[0]!.join(",") !== header) throw new Error(`${where}: header is '${records[0]!.join(",")}', expected '${header}'`);
  const seen = new Set<string>();
  return records.slice(1).map((r, i) => {
    const line = i + 2;
    if (r.length !== COLUMNS.length) throw new Error(`${where} line ${line}: ${r.length} fields, expected ${COLUMNS.length}`);
    const row = Object.fromEntries(COLUMNS.map((c, j) => [c, r[j]!])) as Record<(typeof COLUMNS)[number], string>;
    const bad = problem(row);
    if (bad !== null) throw new Error(`${where} line ${line}: ${bad}`);
    const key = `${row.program} ${row.value}`;
    if (seen.has(key)) throw new Error(`${where} line ${line}: ${row.value} is listed twice for ${row.program}`);
    seen.add(key);
    return {
      program: row.program,
      kind: row.kind as ContactKind,
      value: row.value,
      label: row.label,
      source: row.source,
      recordedBy: row.recorded_by,
      recordedOn: row.recorded_on,
    };
  });
}

/** The file, read fresh: a contact merged in git shows from the next read. */
export async function readProgramContacts(path: string = PROGRAM_CONTACTS): Promise<ProgramContact[]> {
  try {
    return parseProgramContacts(await readFile(path, "utf8"), path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
