import { appendFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sql, type Kysely } from "kysely";
import type { DuckDBConnection } from "@duckdb/node-api";
import { parseCsv } from "./corrections.js";
import type { Database } from "./model.js";

/**
 * What happened to a person, in order (beeline-o22).
 *
 * The overlay next door records the same decisions and cannot answer this.
 * It is one CURRENT row per (person_ref, field) — a later edit replaces the
 * earlier one — so it says who last changed a thing and why, and never when,
 * what it was before, that it changed twice, or who changed it the first
 * time. That shape is right for what the overlay is (a set of decisions to
 * replay, ADR 0004) and wrong for history, so this is a second artifact
 * rather than a column added to the first.
 *
 * The shape is the one the project already settled for corrections to a
 * determination (schema/040): authored changes are append-only events. A row
 * here is never rewritten, which is why this file is read leniently where
 * both overlays are read strictly — refusing a malformed row protects a file
 * that gets rewritten wholesale, and nothing here ever is.
 *
 * WHY A CSV, and not a table. It has to survive `pnpm db:build`, which is the
 * same reason both overlays are files: a history the blow-away erases answers
 * "who changed this" with "nobody, we rebuilt it", which is the answer the
 * bead exists to stop giving. That constraint dies at cutover (December
 * 2026), and a table is the natural home then.
 *
 * WHAT IT COVERS. Every writer that can change a person, not only the roster
 * screen: promotion mints people and binds accounts wholesale, and observation
 * promotion rewrites a login whenever iNaturalist renames an account. Those
 * used to leave no trace but the code that did it — which is exactly the class
 * of change that silently bound three people to the wrong account
 * (beeline-eft). So every entry is produced the same way, by comparing the
 * store against what this log last said, and any writer that forgets to record
 * is caught by the next pass over it (recordPersonChanges).
 *
 * WHAT IT CANNOT DO. A reference is a name or an account, and neither is an
 * identity. Two people whose names swap, or one who is corrected into a name
 * another has vacated, are told apart by nothing here — the overlay resolves
 * `name:X` to whoever holds X now for the same reason. What is guaranteed is
 * that the log settles rather than churning, and that a *fabrication* is
 * refused wherever the evidence to refuse it exists: see matchKnown.
 */

/**
 * The fields a change can be about. This is the person's STATE — what the
 * store says about them — not the overlay's vocabulary, which is a set of
 * instructions and spells two of these differently (`home_atlas` for
 * membership, `inat_user_id` for a binding that also carries the login).
 *
 * Recording state rather than instructions is what keeps the two producers
 * agreeing. The roster screen writes `inat_user_id` = '429964' where a rebuild
 * would compute '429964 amelathopoulos'; if entries were minted from what a
 * writer intended, the next pass would find a difference nobody made and
 * record a change that never happened. Both sides read the same query instead
 * (PERSON_STATE_SQL), so a difference in the log is a difference in the store.
 */
export const CHANGE_FIELDS = [
  "display_name",
  "given_name",
  "family_name",
  "label_name",
  "inat_user_id",
  "login",
  "membership",
  "admin",
  "acts_for",
] as const;
export type ChangeField = (typeof CHANGE_FIELDS)[number];

/**
 * The order a pass emits one person's fields in, and the reason it is not
 * simply CHANGE_FIELDS: **the rename goes last.**
 *
 * Everything a pass records about somebody is filed under the reference that
 * named them when it started, the rename included — and a reader folding the
 * file has to move them to the new name when it reaches it. Anything written
 * under the old name *after* that point belongs to a person the fold has
 * already moved on from, so it starts a second, half-empty record of them,
 * which the next pass then re-reports in full, and the next, and the next.
 * Saying the rename last means nothing ever follows it.
 */
const FIELD_ORDER: readonly ChangeField[] = [
  ...CHANGE_FIELDS.filter((f) => f !== "display_name"),
  "display_name",
];

/**
 * The value a field has when there is nothing to say. Empty for all but
 * admin, which is a grant that is either held or not: without this a person's
 * arrival would record 'admin: → no', an event in which nothing happened.
 */
const ABSENT: Record<ChangeField, string> = {
  display_name: "",
  given_name: "",
  family_name: "",
  label_name: "",
  inat_user_id: "",
  login: "",
  membership: "",
  admin: "no",
  acts_for: "",
};

/**
 * Who noticed. Not who decided — that is `author`, and half of these have
 * nobody to name. The distinction is the honest one: `app` means a staffer
 * did this and said why, and everything else means a pass over the store
 * found a difference and cannot say who made it.
 */
export const CHANGE_SOURCES = ["app", "legacy_promotion", "observation_promotion", "reconcile"] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

export interface PersonChange {
  /** ISO-8601 UTC, so the file sorts by string as well as by time. */
  at: string;
  /** `name:<display_name>` or `inat:<user_id>` — the overlay's vocabulary. */
  person_ref: string;
  field: ChangeField;
  old_value: string;
  new_value: string;
  /** iNat login of whoever decided, or empty where nobody did. */
  author: string;
  source: ChangeSource;
  /** Why, where a person gave a reason. Empty for everything else. */
  reason: string;
}

const COLUMNS = ["at", "person_ref", "field", "old_value", "new_value", "author", "source", "reason"] as const;
const HEADER = COLUMNS.join(",");

/** The app-written log; promotion and the roster screen both append here. */
export const CHANGE_LOG = "data/person-change.csv";

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

export function formatChanges(rows: readonly PersonChange[]): string {
  return rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(",")).join("\n");
}

/**
 * Skip what cannot be read, and say how many. The overlays refuse instead,
 * because a save there rewrites the whole file and a dropped row would be
 * erased for good (beeline-3xw). Appending cannot erase anything, so the
 * damage a bad row can do is bounded to itself — and refusing would take
 * every screen that reads history down with it.
 */
export function parseChanges(text: string): { changes: PersonChange[]; malformed: number } {
  const records = parseCsv(text);
  if (records.length === 0) return { changes: [], malformed: 0 };
  const changes: PersonChange[] = [];
  let malformed = 0;
  for (const r of records.slice(1)) {
    if (r.length !== COLUMNS.length) {
      malformed++;
      continue;
    }
    const row = Object.fromEntries(COLUMNS.map((c, j) => [c, r[j]!])) as unknown as PersonChange;
    if (!(CHANGE_FIELDS as readonly string[]).includes(row.field)) {
      malformed++;
      continue;
    }
    changes.push(row);
  }
  return { changes, malformed };
}

/** Create with a header if missing; never touch an existing file. */
export async function ensureChangeLog(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${HEADER}\n`, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/** Read a log that may not exist yet; missing reads as empty. */
export async function readChanges(path: string): Promise<PersonChange[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const { changes, malformed } = parseChanges(text);
  if (malformed > 0) console.warn(`${path}: skipped ${malformed} unreadable row(s)`);
  return changes;
}

// One writer per path within this process, as with both overlays. Appending
// cannot lose another writer's rows the way restating a file can, but two
// requests diffing the same person at once would still each read the log
// before either appended, and record the same change twice.
const writeQueues = new Map<string, Promise<void>>();

/**
 * Append, never restate. A crash cannot truncate what is already there and a
 * second process cannot erase this one's rows — which is what makes this file
 * safe to share between the app and an ingest CLI in a way the overlays are
 * not. It does not make them safe from duplicating each other's entries;
 * nothing but a lock would, and a duplicate in a log is legible where a lost
 * row is not.
 *
 * A file whose last line has no newline is repaired first. Without that, the
 * append fuses onto the partial row and BOTH are unreadable — the new one
 * comes back on the next pass, but the old one, and the author and reason
 * that no later pass can recover, would be gone for good.
 */
export async function appendChanges(path: string, rows: readonly PersonChange[]): Promise<void> {
  if (rows.length === 0) return;
  const queued = (writeQueues.get(path) ?? Promise.resolve()).then(async () => {
    await ensureChangeLog(path);
    const { size } = await stat(path);
    let terminated = true;
    if (size > 0) {
      const handle = await open(path, "r");
      try {
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, size - 1);
        terminated = tail[0] === 0x0a;
      } finally {
        await handle.close();
      }
    }
    await appendFile(path, `${terminated ? "" : "\n"}${formatChanges(rows)}\n`);
  });
  writeQueues.set(path, queued.catch(() => {}));
  return queued;
}

/**
 * The log a CLI run should write, given the database it was pointed at, or
 * null for a database whose history this environment does not keep.
 *
 * `pnpm legacy:promote scratch.duckdb` is an ordinary thing to do here, and
 * writing its people into the deployed store's history would diff one corpus
 * against another's: every difference between two populations recorded as
 * something that happened to somebody. So a log belongs to exactly one
 * database — the one this environment is configured for — and a run pointed
 * anywhere else records nothing and says so, since a silent one would look
 * like a run that changed nobody.
 */
export const DEFAULT_DB = "beeline.duckdb";

export function changeLogFor(dbPath: string, env: Record<string, string | undefined>): string | null {
  // Resolved, so `./beeline.duckdb` and an absolute path to it are the one
  // database they plainly are.
  if (resolve(dbPath) !== resolve(env.BEELINE_DB ?? DEFAULT_DB)) return null;
  return env.BEELINE_PERSON_CHANGES ?? CHANGE_LOG;
}

/**
 * The person's state, as one row per person and every value a string.
 *
 * One query, run by both producers — see CHANGE_FIELDS on why that matters.
 * `namesakes` is here because it decides how the person is referenced, and
 * asking it per person afterwards would be 580 more queries.
 */
export const PERSON_STATE_SQL = `
  SELECT p.display_name AS display_name,
         coalesce(p.given_name, '') AS given_name,
         coalesce(p.family_name, '') AS family_name,
         coalesce(p.label_name, '') AS label_name,
         coalesce(CAST(a.inat_user_id AS VARCHAR), '') AS inat_user_id,
         coalesce(a.login, '') AS login,
         CASE WHEN pm.kind IS NULL THEN ''
              WHEN pm.kind = 'atlas' THEN coalesce(atl.code, '')
              ELSE pm.kind END AS membership,
         CASE WHEN adm.person_id IS NULL THEN 'no' ELSE 'yes' END AS admin,
         coalesce((SELECT string_agg(concat('name:', p2.display_name), ';' ORDER BY p2.display_name)
                   FROM person_delegate d
                   JOIN person p2 ON p2.entity_id = d.acts_for_id
                   WHERE d.person_id = p.entity_id), '') AS acts_for,
         (SELECT count(*) FROM person q WHERE q.display_name = p.display_name) AS namesakes
  FROM person p
  LEFT JOIN inat_account a ON a.person_id = p.entity_id
  LEFT JOIN person_membership pm ON pm.person_id = p.entity_id
  LEFT JOIN atlas atl ON atl.entity_id = pm.atlas_id
  LEFT JOIN person_admin adm ON adm.person_id = p.entity_id`;

/** How the module reads the store; the two callers hold different handles. */
export type StateReader = (sql: string) => Promise<Record<string, unknown>[]>;

export const duckdbReader =
  (conn: DuckDBConnection): StateReader =>
  async (query) =>
    (await (await conn.run(query)).getRowObjects()) as Record<string, unknown>[];

export const kyselyReader =
  (db: Kysely<Database>): StateReader =>
  async (query) =>
    (await sql<Record<string, unknown>>`${sql.raw(query)}`.execute(db)).rows;

/**
 * How a person is named in the log: their display name where it is theirs
 * alone, and their iNat account otherwise — the overlay's rule (personRef),
 * for the overlay's reason. `entity_id` is a per-store sequence draw that a
 * rebuild redraws, so a log keyed on it would reattach every entry to
 * whoever inherited the number, which is the bug it exists to catch.
 *
 * Null for the one person neither names: a shared display name and no
 * account. They cannot be referenced, which the caller reports rather than
 * guessing at.
 */
export function stateRef(row: { display_name: string; inat_user_id: string; namesakes: number }): string | null {
  if (row.namesakes === 1) return `name:${row.display_name}`;
  return row.inat_user_id === "" ? null : `inat:${row.inat_user_id}`;
}

export interface PersonState {
  ref: string;
  /**
   * The other reference that names them today, or null: the account when a
   * name is the primary, and the name when the account is. It exists because
   * the primary moves without anything happening to the person — a namesake
   * arriving makes `name:Ada Collector` ambiguous and pushes them onto
   * `inat:111`, and a namesake leaving pushes them back — so a lookup that
   * knew only the primary would restart their history twice over nothing.
   *
   * Offered, never trusted on its own: see knownPerson().
   */
  altRef: string | null;
  fields: Record<ChangeField, string>;
}

export interface PersonStates {
  /** Keyed by primary reference. */
  states: Map<string, PersonState>;
  /**
   * Every display name in the store — the whole store, whatever `where`
   * narrowed the states to, and including the people no reference names.
   * What it answers is "is somebody still called this?", which is how an
   * account changing hands is told from a name being respelled.
   */
  names: Set<string>;
  /** People with a shared display name and no account: unnameable, so unrecorded. */
  unreferenceable: number;
}

/** Every person in the store, keyed by reference. */
export async function readPersonStates(read: StateReader, where = ""): Promise<PersonStates> {
  const names = new Set((await read(`SELECT display_name FROM person`)).map((r) => String(r.display_name ?? "")));
  const rows = await read(where === "" ? PERSON_STATE_SQL : `${PERSON_STATE_SQL} WHERE ${where}`);
  const states = new Map<string, PersonState>();
  let unreferenceable = 0;
  for (const row of rows) {
    const text = (k: string) => String(row[k] ?? "");
    const uid = text("inat_user_id");
    const identity = { display_name: text("display_name"), inat_user_id: uid, namesakes: Number(row.namesakes ?? 1) };
    const ref = stateRef(identity);
    if (ref === null) {
      unreferenceable++;
      continue;
    }
    const fields = Object.fromEntries(CHANGE_FIELDS.map((f) => [f, text(f)])) as Record<ChangeField, string>;
    const account = uid === "" ? null : `inat:${uid}`;
    // The name is offered as the alternate even while two people share it —
    // knownPerson() is what makes that safe, and withholding it would lose
    // the history of whoever was called that first.
    states.set(ref, { ref, altRef: ref === account ? `name:${identity.display_name}` : account, fields });
  }
  return { states, names, unreferenceable };
}

export interface KnownPerson {
  /** The reference that names them now — the log's own key for this person. */
  ref: string;
  /** Everything ever recorded about them, in the order it was recorded. */
  entries: PersonChange[];
  fields: Map<ChangeField, string>;
}

export interface LastKnown {
  /** One entry per person, keyed on the reference that names them now. */
  people: Map<string, KnownPerson>;
  /** What the log says about whoever this reference names. */
  of(ref: string | null | undefined): KnownPerson | undefined;
}

/**
 * What the log last said about each person, and the entries it said it in.
 * This is the log's memory of the store, and the thing a pass over the store
 * is compared against — there is no snapshot beside it, because a rebuild
 * would blow away anything that lived in the store.
 *
 * Folded in file order, which is append order, which is the order things were
 * recorded. Not by `at`: the timestamp is a fact stored IN an entry, and
 * sorting on it would let one written with a skewed clock or by hand decide
 * what the store was last known to say — where the file's own order is the
 * one thing nothing can restate after the fact.
 *
 * A rename moves the reference, and this is where the log follows it: an
 * entry is filed under the name being left behind, and from there on the
 * person answers to the new one. Forward only, in order, and never onto a
 * name the log already knows somebody by — the alternative, treating every
 * rename as evidence that two names are one person, merges two people the
 * moment their names swap or a vacated name is reused, and then reports the
 * difference between them forever.
 */
export function lastKnown(changes: readonly PersonChange[]): LastKnown {
  const people = new Map<string, KnownPerson>();
  for (const c of changes) {
    const person: KnownPerson =
      people.get(c.person_ref) ?? { ref: c.person_ref, entries: [], fields: new Map() };
    person.entries.push(c);
    person.fields.set(c.field, c.new_value);
    people.set(c.person_ref, person);
    if (c.field !== "display_name" || c.person_ref !== `name:${c.old_value}` || c.new_value === "") continue;
    const moved = `name:${c.new_value}`;
    if (people.has(moved)) continue;
    people.delete(c.person_ref);
    person.ref = moved;
    people.set(moved, person);
  }
  return { people, of: (ref) => (ref == null ? undefined : people.get(ref)) };
}

/**
 * Whoever the log already knows this person to be, or nothing.
 *
 * Three lookups, each of which the log has direct evidence for, and no fourth
 * — a person the log cannot recognise is a new subject, never the nearest
 * plausible one (the stance the whole ingest takes).
 *
 *   the reference itself      the ordinary case, and a rename the log
 *                             recorded, which lastKnown has already followed.
 *   their account, where the  a namesake arrived and pushed them off their
 *   name still matches        own name. The name is the gate, because an
 *                             account passes from one person to another here
 *                             on purpose: a household's login moving to the
 *                             partner who does not hold it would otherwise
 *                             hand the newcomer the other's whole history and
 *                             record their arrival as a rename.
 *   their name, where the     the same thing undone — the namesake left, and
 *   account still matches     the name is theirs alone again. `inat_user_id`
 *                             is unique, so it tells the two namesakes apart
 *                             even though the name cannot.
 */
function referenced(known: LastKnown, names: ReadonlySet<string>, state: PersonState): KnownPerson | undefined {
  const direct = known.of(state.ref);
  // A `name:` reference matches on the name by construction, and a name does
  // not move to somebody else on its own. An `inat:` one matches on the
  // account, which moves between people here on purpose — so an exact hit on
  // it is not on its own evidence of anything, and gets the same test as the
  // account index: the person it names may not be somebody the store still
  // calls by another name.
  if (direct !== undefined) {
    if (!state.ref.startsWith("inat:")) return direct;
    const was = direct.fields.get("display_name") ?? "";
    if (was === state.fields.display_name || !names.has(was)) return direct;
    return undefined;
  }
  const alt = known.of(state.altRef);
  if (alt === undefined) return undefined;
  const agrees = state.ref.startsWith("name:")
    ? alt.fields.get("display_name") === state.fields.display_name
    : alt.fields.get("inat_user_id") === state.fields.inat_user_id && state.fields.inat_user_id !== "";
  return agrees ? alt : undefined;
}

/** value → the one person the log last recorded carrying it, or null if two did. */
function valueIndex(people: Iterable<KnownPerson>, field: ChangeField): Map<string, KnownPerson | null> {
  const by = new Map<string, KnownPerson | null>();
  for (const person of people) {
    const value = person.fields.get(field) ?? "";
    if (value === "") continue;
    by.set(value, by.has(value) ? null : person);
  }
  return by;
}

/** What the log holds, and who the store still has names for. */
export interface MatchContext {
  known: LastKnown;
  /** Every display name in the store — readPersonStates().names. */
  names: ReadonlySet<string>;
}

/**
 * Which person in the log each person in the store is, where the log can say.
 *
 * A reference moves with nothing happening to the person: a namesake arriving
 * pushes them off their own name and onto their account, and a rebuild that
 * respells a name (`MaryJo` → `Mary Jo` is the project's own example) moves it
 * with no rename recorded anywhere. Matching on references alone would file
 * such a person's whole life again under the new one, every time.
 *
 * So they are recognised by evidence, in order of how much it is worth: the
 * reference itself; then the name the log last recorded, because a name
 * changes only when somebody changes it; then the account.
 *
 * **Every claim is proposed before any is granted**, and that is the whole
 * shape of this function. Deciding one person at a time, refusing or allowing
 * on what is true at that moment, is not a smaller version of this problem —
 * it is a different and wrong one, because whether a claim is safe depends on
 * what the *other* people in the store turn out to be. Three ways it does:
 *
 * - **Two claimants, no answer.** Where two people in the store reach the
 *   same history — by the same name, or one by name and another by the
 *   account it records — the log cannot say which of them it meant, and
 *   letting the database's row order decide who inherits somebody's past is
 *   not an answer. Neither claims, and the pass reports it.
 * - **A history whose account somebody else now holds is not yours.** If the
 *   account a past last recorded belongs, in the store, to a different person
 *   than the one claiming that past, the claim is refused however the names
 *   read — which is what stops two people recorded under each other's names
 *   from being written down as having traded accounts neither touched. It
 *   refuses nothing when that account has simply gone nowhere, so an ordinary
 *   rebinding still records as the rebinding it is: the beeline-eft case,
 *   which this must never miss.
 * - **A name the store still carries means its person is still here**, so an
 *   account may only recognise somebody whose last recorded name nobody
 *   answers to any more. A household's login passing to the partner who does
 *   not hold it would otherwise hand the newcomer the other's entire history
 *   and record it as one human being renamed into another — and the partner
 *   it was taken from may well be unreferenceable by then, so she cannot
 *   defend her own history by claiming it first.
 *
 * What is refused is recorded as nothing at all, and counted. That is the
 * stance the whole ingest takes: a person the log cannot recognise is a new
 * subject, never the nearest plausible one.
 */
export function matchKnown(ctx: MatchContext, states: Iterable<PersonState>): Map<string, KnownPerson> {
  return proposeMatches(ctx, states).matched;
}

export interface Matching {
  matched: Map<string, KnownPerson>;
  /**
   * References the log holds a history for and could not attribute this pass.
   * Nothing is recorded for them at all — not even as new people, since a
   * contested person recorded as an arrival is one whose arrival is re-recorded
   * on every pass forever.
   */
  contested: Set<string>;
}

export function proposeMatches(ctx: MatchContext, states: Iterable<PersonState>): Matching {
  const { known, names } = ctx;
  const all = [...states];
  const people = [...known.people.values()];
  const byName = valueIndex(people, "display_name");
  const byAccount = valueIndex(people, "inat_user_id");
  // Who in the STORE holds each account now. Asked of the store rather than
  // of the log, because the log keeps whatever a person last held forever —
  // it never records a silence — so a history abandoned years ago goes on
  // naming an account somebody else has since been given.
  const holder = new Map<string, PersonState>();
  for (const state of all) {
    if (state.fields.inat_user_id !== "") holder.set(state.fields.inat_user_id, state);
  }

  // What each person in the store reaches, and how. Nothing is granted here.
  const proposed = new Map<PersonState, KnownPerson>();
  for (const state of all) {
    const found =
      referenced(known, names, state) ??
      byName.get(state.fields.display_name) ??
      account(byAccount, names, state);
    if (found != null) proposed.set(state, found);
  }

  const claimants = new Map<KnownPerson, PersonState[]>();
  for (const [state, person] of proposed) {
    claimants.set(person, [...(claimants.get(person) ?? []), state]);
  }
  const matched = new Map<string, KnownPerson>();
  const contested = new Set<string>();
  for (const [state, person] of proposed) {
    if ((claimants.get(person) ?? []).length > 1) {
      contested.add(state.ref);
      continue;
    }
    // A history whose account somebody else now holds is nobody's to claim.
    //
    // The cases this covers are genuinely indistinguishable from one another,
    // which is why the rule is blunt. A newcomer who takes over the name of
    // somebody the last rebuild respelled looks exactly like the person whose
    // account was taken away and who is still here under a name of her own:
    // in both, a history records an account that a different person in the
    // store now holds, and its last name is carried by the claimant. One of
    // those claims would be a fabricated unbinding of a live account and the
    // other a true one, and nothing here can tell which.
    //
    // So neither is recorded, and the pass counts it. The cost is real and
    // one-sided on purpose: an account changing hands leaves the history it
    // came from unclaimable, so an ordinary shuffle records one of its two
    // rebindings and stays silent about the other. Silence in an audit log is
    // a gap somebody can go and look into. A fabricated rebinding is a lie
    // about the one thing this log exists to make visible (beeline-eft).
    const heldBy = holder.get(person.fields.get("inat_user_id") ?? "");
    if (heldBy !== undefined && heldBy !== state) {
      contested.add(state.ref);
      continue;
    }
    matched.set(state.ref, person);
  }
  return { matched, contested };
}

/** An account recognises somebody only once nobody answers to their name. */
function account(
  byAccount: Map<string, KnownPerson | null>,
  names: ReadonlySet<string>,
  state: PersonState,
): KnownPerson | null {
  const uid = state.fields.inat_user_id;
  if (uid === "") return null;
  const found = byAccount.get(uid) ?? null;
  if (found === null) return null;
  return names.has(found.fields.get("display_name") ?? "") ? null : found;
}

/** The same question about one person, whom the caller has in hand. */
export const knownPerson = (ctx: MatchContext, state: PersonState): KnownPerson | undefined =>
  matchKnown(ctx, [state]).get(state.ref);

export interface RecordOptions {
  source: ChangeSource;
  /** iNat login of whoever decided, where anybody did. */
  author?: string;
  reason?: string;
  /** The instant recorded on every entry; defaulted so tests can pin it. */
  at?: string;
}

export interface RecordResult {
  appended: number;
  /** People with a shared display name and no account: unnameable, so unrecorded. */
  unreferenceable: number;
  /**
   * People the log holds a history for and could not tell apart this pass —
   * two of them reaching one past, or one carrying an account another still
   * holds. Recorded as nothing rather than as a guess, and counted here so
   * that "nothing to say" and "could not say" are different answers.
   */
  contested: number;
}

/**
 * Reconcile the log with the store: append an entry for every field whose
 * value differs from what the log last said.
 *
 * Idempotent, which is what makes it safe to call from everywhere — a second
 * run appends nothing. That is also the point: any writer that changes a
 * person without recording it is caught by the next pass, so coverage does
 * not depend on every writer remembering. The cost is that such a change is
 * attributed to the pass that found it rather than to whoever made it, which
 * is what `source` says.
 *
 * **A reference falling silent is never recorded as anything.** It looks like
 * a departure and it is not one: it is equally a person whose name became
 * ambiguous, a rebuild that respelled it, or a store promoted from a smaller
 * corpus — and the version of this that wrote departures made affirmative
 * false statements about people standing right there, up to and including
 * unbinding accounts they still held. What this log asserts is what it
 * observed a reference to say; that a person *left* is not observable from
 * here, and inventing it was worse than not having it.
 */
export async function recordPersonChanges(
  read: StateReader,
  path: string,
  opts: RecordOptions,
): Promise<RecordResult> {
  const { states, names, unreferenceable } = await readPersonStates(read);

  const changes = await readChanges(path);
  const known = lastKnown(changes);
  const at = opts.at ?? new Date().toISOString();
  const entry = (person_ref: string, field: ChangeField, old_value: string, new_value: string): PersonChange => ({
    at,
    person_ref,
    field,
    old_value,
    new_value,
    author: opts.author ?? "",
    source: opts.source,
    reason: opts.reason ?? "",
  });

  const { matched, contested } = proposeMatches({ known, names }, states.values());

  const rows: PersonChange[] = [];
  for (const state of states.values()) {
    // Somebody the log holds a history for and cannot attribute: say nothing.
    if (contested.has(state.ref)) continue;
    const before = matched.get(state.ref);
    // Filed under the reference the LOG knows them by, not the one the store
    // gave: they are the same person, and history that splits every time a
    // namesake comes or goes is not history.
    const ref = before?.ref ?? state.ref;
    for (const field of FIELD_ORDER) {
      const was = before?.fields.get(field) ?? ABSENT[field];
      if (was !== state.fields[field]) rows.push(entry(ref, field, was, state.fields[field]));
    }
  }

  await appendChanges(path, rows);
  return { appended: rows.length, unreferenceable, contested: contested.size };
}

/**
 * The same comparison for one person, whom the caller has just changed and
 * can describe before and after. Used by the roster screen, which knows who
 * decided and why — the facts a later pass over the store could never
 * recover.
 *
 * Filed under the reference the person had BEFORE the change, so a rename is
 * recorded under the name being left behind and refGroups can join the two.
 */
export function diffPerson(
  ref: string,
  before: PersonState | undefined,
  after: PersonState | undefined,
  opts: RecordOptions,
): PersonChange[] {
  const at = opts.at ?? new Date().toISOString();
  const rows: PersonChange[] = [];
  for (const field of FIELD_ORDER) {
    const was = before?.fields[field] ?? ABSENT[field];
    const now = after?.fields[field] ?? ABSENT[field];
    if (was === now) continue;
    rows.push({
      at,
      person_ref: ref,
      field,
      old_value: was,
      new_value: now,
      author: opts.author ?? "",
      source: opts.source,
      reason: opts.reason ?? "",
    });
  }
  return rows;
}

/**
 * One person's history, newest first.
 *
 * Addressed by the reference the STORE gives them (readPersonStates), never
 * by a name the caller happens to hold: two people called Ada Collector are
 * two people, and answering both their pages with the entries filed under
 * that name is misattribution on the one screen staff use to untangle them.
 * The alternate is consulted too, so a name that became ambiguous — or
 * stopped being — does not hide what came before it.
 */
export function historyFor(
  changes: readonly PersonChange[],
  names: ReadonlySet<string>,
  person: PersonState | undefined,
): PersonChange[] {
  if (person === undefined) return [];
  // Through the same gated matcher a pass uses, not a raw two-key lookup: an
  // ungated alternate showed a household's incoming partner the login
  // holder's whole history the moment the account moved, before any pass had
  // recorded anything at all.
  const found = knownPerson({ known: lastKnown(changes), names }, person);
  return found === undefined ? [] : [...found.entries].sort(byNewest);
}

const byNewest = (a: PersonChange, b: PersonChange) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

/**
 * The most recent entries, and the name each one is about now. A reference
 * carries the name a person had when the entry was written, so the roster's
 * recent-changes panel would otherwise link to somebody nobody is called any
 * more; the reference the log has followed them to is who they are today.
 */
export function recentChanges(
  changes: readonly PersonChange[],
  limit: number,
): Array<PersonChange & { current_name: string | null }> {
  const known = lastKnown(changes);
  const currentRef = new Map<PersonChange, string>();
  for (const person of known.people.values()) {
    for (const entry of person.entries) currentRef.set(entry, person.ref);
  }
  return [...changes]
    .sort(byNewest)
    .slice(0, limit)
    .map((c) => {
      const ref = currentRef.get(c) ?? c.person_ref;
      return {
        ...c,
        // Null where the log alone cannot say: an `inat:` reference names an
        // account, not a name. The caller has the store and can ask it.
        current_name: ref.startsWith("name:") ? ref.slice("name:".length) : null,
      };
    });
}
