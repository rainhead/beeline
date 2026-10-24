import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseCsv } from "./corrections.js";

/**
 * How to reach a program: the email address it gives people for questions
 * (beeline-rrit), set by staff on the program's page.
 *
 * Kept in a file the app writes under `data/`, beside the overlays, because a
 * program's contact is a staff decision that no rebuild can reconstruct, and
 * because staff set it on a screen rather than in a file. Each save is one
 * line appended — when, which program, which field, the value, who — and the
 * latest line for a program and field is what stands, an empty value meaning
 * it was cleared. So the file is also the history of who set what and when,
 * the shape ADR 0007 gives authored changes, and the nightly backup carries it.
 *
 * The address is the one the program publishes for questions, which may be a
 * staff member's work address (the refuge project gives August Jackson's).
 * Never an address taken from the legacy register, whose email column is
 * deliberately never brought into the store.
 *
 * Read leniently: a line that does not parse is skipped, not fatal, since the
 * file is only ever appended to and its order is the order things were saved.
 */

export const PROGRAM_CONTACT_FIELDS = ["email"] as const;
export type ProgramContactField = (typeof PROGRAM_CONTACT_FIELDS)[number];

const COLUMNS = ["recorded_at", "program", "field", "value", "author"] as const;
const HEADER = COLUMNS.join(",");

export interface ProgramContact {
  value: string;
  author: string;
  recordedAt: Date;
}

/** What stands for each program, by program code and field. Cleared fields are absent. */
export type ProgramContacts = Map<string, Partial<Record<ProgramContactField, ProgramContact>>>;

export function programContactProblem(field: ProgramContactField, value: string): string | null {
  if (value === "") return null;
  // No ? # or &, as BEELINE_FEEDBACK_EMAIL refuses them: the page builds a
  // mailto: link from the value, and `a@b.org?bcc=x@y.org` would add a
  // recipient nobody sees.
  if (field === "email" && !/^[^\s@,;<>"?#&]+@[^\s@,;<>"?#&]+\.[^\s@,;<>"?#&]+$/.test(value)) {
    return `'${value}' is not an email address`;
  }
  return null;
}

/** Created at first boot, header only, so the backup finds it before anyone has saved anything. */
export async function ensureProgramContactsFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${HEADER}\n`, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

export function parseProgramContacts(text: string): ProgramContacts {
  const contacts: ProgramContacts = new Map();
  const records = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ""));
  for (const r of records.slice(records[0]?.join(",") === HEADER ? 1 : 0)) {
    if (r.length !== COLUMNS.length) continue;
    const [recordedAt, program, field, value, author] = r as [string, string, string, string, string];
    const when = new Date(recordedAt);
    if (Number.isNaN(when.getTime())) continue;
    if (!(PROGRAM_CONTACT_FIELDS as readonly string[]).includes(field)) continue;
    const f = field as ProgramContactField;
    if (programContactProblem(f, value) !== null) continue;
    const entry = contacts.get(program) ?? {};
    if (value === "") delete entry[f];
    else entry[f] = { value, author, recordedAt: when };
    contacts.set(program, entry);
  }
  return contacts;
}

export async function readProgramContacts(path: string): Promise<ProgramContacts> {
  try {
    return parseProgramContacts(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

/** Whether the file ends in a newline, so an append starts a line of its own. */
async function terminated(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

// One writer per path, as with the overlays: saves take their turn, so two
// at once cannot interleave their lines.
const queues = new Map<string, Promise<unknown>>();

export async function recordProgramContact(
  path: string,
  entry: { program: string; field: ProgramContactField; value: string; author: string; now?: Date },
): Promise<void> {
  const value = entry.value.trim();
  const problem = programContactProblem(entry.field, value);
  if (problem !== null) throw new Error(problem);
  const line = [(entry.now ?? new Date()).toISOString(), entry.program, entry.field, value, entry.author].map(cell).join(",");
  const turn = (queues.get(path) ?? Promise.resolve()).then(async () => {
    await ensureProgramContactsFile(path);
    await appendFile(path, `${(await terminated(path)) ? "" : "\n"}${line}\n`);
  });
  queues.set(path, turn.catch(() => undefined));
  await turn;
}
