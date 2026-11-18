import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseCsv } from "./corrections.js";
import { createIdealLogicClient, IdealLogicError, type Registrant } from "./ideal-logic.js";
import { foldName } from "./registrations.js";

/**
 * CLI: pnpm ideal-logic:link-register --people <people.json> [--register <usernames.csv>] [--apply --origin <url>]
 *
 * Link people to their Ideal Logic registrations through the old Beeline's
 * register (beeline-w8ab.1). Run once, on a machine that holds the register,
 * which production's store does not: the register's email addresses were
 * never staged (AGENTS.md). It is not part of the nightly job, because the
 * register is a frozen file that no new registrant will ever be in, and one
 * that holds addresses, which Beeline's machine should not keep.
 *
 * The rule, all three parts required:
 *
 * 1. The registration's email address is in the register against exactly one
 *    iNaturalist login.
 * 2. Exactly one person in the store holds that login.
 * 3. The registration's full name, folded to letters and digits, is that
 *    person's display name.
 *
 * The third is what keeps a household apart: two people who registered
 * separately can both be in the register against the one login they share,
 * and only one of them holds it. On 2026-11-18 the rule linked 259 of 593
 * people and left 30 for staff because the name differed (a nickname, a
 * middle initial, the other member of a household).
 *
 * Without --apply it prints what it would do. With it, each link is sent to
 * `POST /api/v1/people/<id>/registration` with evidence `register_email`,
 * which records who sent it; the key is `BEELINE_API_KEY`. Email addresses
 * are compared in memory and never printed, sent or written.
 *
 * `people.json` is the answer to this, from `pnpm store:query --json --rows 50000`:
 *
 *   SELECT p.entity_id, p.display_name, a.login
 *   FROM person p LEFT JOIN inat_account a ON a.person_id = p.entity_id
 */

export interface StorePerson {
  entity_id: number;
  display_name: string;
  login: string | null;
}

export interface RegisterMatch {
  links: Array<{ personId: number; displayName: string; idealLogicId: string }>;
  /** Registrations the register reaches but the rule does not link, by why. Counts only. */
  toStaff: { loginAmbiguous: number; loginUnheld: number; nameDiffers: number; alreadyMatched: number };
}

/**
 * Which registrations the register's email addresses link, by the rule at the
 * head of this file. `register` is the register's rows as (email, login).
 */
export function matchByRegisterEmail(
  registrants: readonly Registrant[],
  register: ReadonlyArray<{ email: string; login: string }>,
  people: readonly StorePerson[],
): RegisterMatch {
  const fold = (s: string) => s.trim().toLowerCase();
  const loginsByEmail = new Map<string, Set<string>>();
  for (const row of register) {
    const email = fold(row.email);
    const login = fold(row.login);
    if (email === "" || login === "") continue;
    const at = loginsByEmail.get(email);
    if (at) at.add(login);
    else loginsByEmail.set(email, new Set([login]));
  }
  const holders = new Map<string, StorePerson[]>();
  for (const p of people) {
    if (p.login === null) continue;
    const login = fold(p.login);
    const at = holders.get(login);
    if (at) at.push(p);
    else holders.set(login, [p]);
  }

  const out: RegisterMatch = { links: [], toStaff: { loginAmbiguous: 0, loginUnheld: 0, nameDiffers: 0, alreadyMatched: 0 } };
  const taken = new Set<number>();
  for (const r of registrants) {
    const logins = loginsByEmail.get(fold(r.email));
    if (logins === undefined) continue;
    if (logins.size !== 1) {
      out.toStaff.loginAmbiguous += 1;
      continue;
    }
    const held = holders.get([...logins][0]!) ?? [];
    if (held.length !== 1) {
      out.toStaff.loginUnheld += 1;
      continue;
    }
    const person = held[0]!;
    if (foldName(person.display_name) !== foldName(`${r.givenName}${r.familyName}`)) {
      out.toStaff.nameDiffers += 1;
      continue;
    }
    // A person who registered twice: the second is for staff to choose between.
    if (taken.has(person.entity_id)) {
      out.toStaff.alreadyMatched += 1;
      continue;
    }
    taken.add(person.entity_id);
    out.links.push({ personId: person.entity_id, displayName: person.display_name, idealLogicId: r.id });
  }
  return out;
}

/** The register's (email, login) pairs, from the text of `usernames.csv`. */
export function readRegister(text: string): Array<{ email: string; login: string }> {
  const records = parseCsv(text.replace(/^﻿/, ""));
  const header = records[0] ?? [];
  const email = header.indexOf("email");
  const login = header.indexOf("userLogin");
  if (email < 0 || login < 0) throw new Error("the register has no email or userLogin column");
  return records.slice(1).map((r) => ({ email: r[email] ?? "", login: r[login] ?? "" }));
}

/** The people in the answer `pnpm store:query --json` gave to the query at the head of this file. */
export function readPeople(text: string): StorePerson[] {
  const parsed = JSON.parse(text) as { columns: Array<{ name: string }>; rows: unknown[][] };
  const at = (name: string) => {
    const i = parsed.columns.findIndex((c) => c.name === name);
    if (i < 0) throw new Error(`the people file has no ${name} column`);
    return i;
  };
  const [id, name, login] = [at("entity_id"), at("display_name"), at("login")];
  return parsed.rows.map((r) => ({
    entity_id: Number(r[id]),
    display_name: String(r[name]),
    login: r[login] === null ? null : String(r[login]),
  }));
}

const USAGE = `usage: pnpm ideal-logic:link-register --people <people.json> [--register <usernames.csv>] [--apply --origin <url>] [--reference <text>]

  --people <file>     the people in the store, from pnpm store:query --json (the query is at the head of src/link-register-emails.ts)
  --register <file>   the old Beeline's register (default data/legacy/usernames.csv)
  --apply             send each link to the API; without it, only say what would be sent
  --origin <url>      the Beeline to send to, such as https://melittologist.org (needed with --apply)
  --reference <text>  who asked for the load: a message id or an issue link

IDEAL_LOGIC_KEY must be set, and BEELINE_API_KEY with --apply (a staff key).`;

type Io = { env: NodeJS.ProcessEnv; out: (text: string) => void; err: (text: string) => void; fetchImpl?: typeof fetch };

export async function linkRegisterEmails(argv: readonly string[], io: Io): Promise<number> {
  let peoplePath: string | null = null;
  let registerPath = "data/legacy/usernames.csv";
  let apply = false;
  let origin: string | null = null;
  let reference: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--apply") apply = true;
    else if (a === "--people") peoplePath = argv[++i] ?? null;
    else if (a === "--register") registerPath = argv[++i] ?? registerPath;
    else if (a === "--origin") origin = argv[++i] ?? null;
    else if (a === "--reference") reference = argv[++i] ?? null;
    else {
      io.err(`${USAGE}\n`);
      return 2;
    }
  }
  const idealLogicKey = io.env.IDEAL_LOGIC_KEY?.trim();
  const apiKey = io.env.BEELINE_API_KEY?.trim();
  if (peoplePath === null || !idealLogicKey || (apply && (origin === null || !apiKey))) {
    io.err(`${USAGE}\n`);
    return 2;
  }

  const people = readPeople(await readFile(peoplePath, "utf8"));
  const register = readRegister(await readFile(registerPath, "utf8"));
  let registrants: Registrant[];
  try {
    registrants = await createIdealLogicClient({ key: idealLogicKey }).fetchRegistrants();
  } catch (e) {
    if (!(e instanceof IdealLogicError)) throw e;
    io.err(`${e.message}\n`);
    return 1;
  }

  const match = matchByRegisterEmail(registrants, register, people);
  const s = match.toStaff;
  io.err(
    `${registrants.length} registrations, ${people.length} people: ${match.links.length} to link; left for staff: ` +
      `${s.nameDiffers} whose name differs, ${s.loginUnheld} whose login nobody here holds, ` +
      `${s.loginAmbiguous} whose email address the register lists under several logins, ${s.alreadyMatched} second registrations\n`,
  );
  if (!apply) {
    for (const l of match.links) io.out(`${l.personId}\t${l.displayName}\t${l.idealLogicId}\n`);
    io.err("Nothing was sent. Run again with --apply --origin <url> to send these.\n");
    return 0;
  }

  const fetchImpl = io.fetchImpl ?? fetch;
  const counts = new Map<string, number>();
  let failed = 0;
  for (const l of match.links) {
    const res = await fetchImpl(`${origin}/api/v1/people/${l.personId}/registration`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ ideal_logic_id: l.idealLogicId, evidence: "register_email", ...(reference ? { reference } : {}) }),
    });
    if (res.status !== 200) {
      failed += 1;
      io.out(`${l.personId}\t${l.displayName}\tHTTP ${res.status}\n`);
      continue;
    }
    const outcome = String(((await res.json()) as { outcome?: unknown }).outcome);
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  io.err(`${[...counts].map(([k, n]) => `${n} ${k}`).join(", ") || "none sent"}${failed > 0 ? `, ${failed} refused (listed above)` : ""}\n`);
  return failed > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await linkRegisterEmails(process.argv.slice(2), {
    env: process.env,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
