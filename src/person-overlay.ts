import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseCsv } from "./corrections.js";
import { parseOrcid } from "./orcid.js";

/**
 * Staff decisions about people, in the same shape and spirit as the legacy
 * correction overlay (ADR 0004): app-written rows live outside the blow-away
 * path, promotion reads them union a git-curated file, and app rows win.
 *
 * What differs is the key, and it is the whole design problem. A correction
 * names a staging row by its Mongo `_id`, which the source keeps stable.
 * A person has no such id: `entity_id` is a draw from `entity_id_seq` at
 * promotion time, so the same human is 356 in one store and 21 in another —
 * exactly the trap that made migration 0008 key on `inat_user_id` instead.
 * Writing entity_ids here would produce a file that silently reattaches
 * every decision to the wrong people on the next rebuild.
 *
 * So a person is named by something promotion reproduces:
 *
 *   name:Andony Melathopoulos   the display_name legacy promotion derives
 *                               from recordedBy — the natural key of
 *                               legacy_person_name
 *   inat:429964                 the iNat user id, for people who reached the
 *                               store through observations rather than legacy
 *
 * References resolve against the *promoted* state, before any overlay row is
 * applied. A row that renames someone therefore does not move the target of
 * `name:` references to them: the old name still names them, which is what
 * makes a rename replayable rather than self-erasing.
 *
 * A reference that matches nobody is reported, never guessed at — the same
 * stance the whole ingest takes. Legacy data changing under a curated file is
 * a thing staff must see, not a thing the loader should paper over.
 */

/**
 * The fields an overlay row may set. Anything else is refused on read.
 *
 * `create` is the odd one: every other field is something to set ON a person,
 * while this one asserts that the person exists. Staff who never collect —
 * an intern, a coordinator — reach the store no other way, since promotion
 * only ever mints people from records (beeline-2c3.32).
 *
 * `home_atlas` keeps its name even though it now records more than an atlas —
 * its value is an atlas code or PROGRAM_MEMBERSHIP (beeline-lcl). Renaming it
 * would refuse every row already written under the old name into a deployed
 * store's own overlay, which is not a trade a spelling is worth.
 */
export const OVERLAY_FIELDS = [
  "create",
  "inat_user_id",
  "admin",
  "acts_for",
  "leads",
  "home_atlas",
  "display_name",
  "given_name",
  "family_name",
  "label_name",
  "orcid",
] as const;
export type OverlayField = (typeof OVERLAY_FIELDS)[number];

export interface PersonOverlayRow {
  /** `name:<display_name>` or `inat:<user_id>`. */
  person_ref: string;
  field: OverlayField;
  /** Empty string clears: no account, no home atlas, derived label name. */
  value: string;
  /** iNat login of whoever decided, or 'seed'. */
  author: string;
  /** Why — the part a future reader needs and cannot reconstruct. */
  reason: string;
}

/**
 * The git-curated file, named once. Decisions live in two places (ADR 0004),
 * and anything that asks "has a person decided this?" has to read both — a
 * reader that sees only the app-written half answers a different question
 * than it thinks it is answering.
 */
export const CURATED_OVERLAY = "ingest/person-overlay.csv";

const COLUMNS = ["person_ref", "field", "value", "author", "reason"] as const;
const HEADER = COLUMNS.join(",");

export const rowKey = (r: { person_ref: string; field: string }) => `${r.person_ref}\u0000${r.field}`;

/** The refs in an `acts_for` value: `name:A;name:B` → ['name:A', 'name:B']. */
export const splitRefs = (value: string): string[] =>
  value.split(";").map((r) => r.trim()).filter((r) => r !== "");

/** The program codes in a `leads` value: `WaBA;MM` → ['WaBA', 'MM']. The same separator as acts_for. */
export const splitCodes = splitRefs;

/** `name:Ada Collector` → {kind: 'name', key: 'Ada Collector'}; null if malformed. */
export function parseRef(ref: string): { kind: "name" | "inat"; key: string } | null {
  const at = ref.indexOf(":");
  if (at < 1) return null;
  const kind = ref.slice(0, at);
  const key = ref.slice(at + 1);
  if (key === "") return null;
  if (kind === "name") return { kind, key };
  if (kind === "inat") return /^\d+$/.test(key) ? { kind, key } : null;
  return null;
}

/**
 * Refuse, don't repair — every save rewrites the whole file, so a row dropped
 * for being unparseable would be erased for good (the lesson of beeline-3xw).
 * `where` names the file in the error, because by the time anyone reads it
 * they are looking at two of them.
 */
export function parseOverlay(text: string, where: string): PersonOverlayRow[] {
  const records = parseCsv(text);
  if (records.length === 0) return [];
  const header = records[0]!;
  if (header.join(",") !== HEADER) {
    throw new Error(`${where}: header is '${header.join(",")}', expected '${HEADER}'`);
  }
  return records.slice(1).map((r, i) => {
    const line = i + 2;
    if (r.length !== COLUMNS.length) {
      throw new Error(`${where} line ${line}: ${r.length} fields, expected ${COLUMNS.length}`);
    }
    const row = Object.fromEntries(COLUMNS.map((c, j) => [c, r[j]!])) as unknown as PersonOverlayRow;
    if (parseRef(row.person_ref) === null) {
      throw new Error(`${where} line ${line}: '${row.person_ref}' is not a person reference (name:… or inat:…)`);
    }
    if (!(OVERLAY_FIELDS as readonly string[]).includes(row.field)) {
      throw new Error(`${where} line ${line}: '${row.field}' is not an overlay field`);
    }
    const bad = valueProblem(row.field, row.value);
    if (bad !== null) throw new Error(`${where} line ${line}: ${bad}`);
    return row;
  });
}

/** Why this value cannot be stored for this field, or null if it can. */
export function valueProblem(field: OverlayField, value: string): string | null {
  if (field === "inat_user_id") {
    // '429964' or '429964 amelathopoulos'. The id is the binding; the login
    // rides along because whoever set this had just confirmed it against the
    // iNat API, and a file recording only the number is unreadable in a diff
    // — which is how a lookalike account survived review once already.
    return value === "" || /^\d+( \S+)?$/.test(value) ? null : `'${value}' is not an iNat user id (optionally 'id login')`;
  }
  if (field === "admin") {
    return value === "yes" || value === "no" ? null : `admin is '${value}', expected yes or no`;
  }
  if (field === "create") {
    // No 'no'. Deleting a person is not the inverse of admitting one — their
    // records would have to go somewhere — and a field that looked reversible
    // would promise otherwise.
    return value === "yes" ? null : `create is '${value}', expected yes`;
  }
  if (field === "acts_for") {
    // The whole set, not one grant: latest-wins on a single row per
    // (person_ref, field) means the value has to say who this person may act
    // for in full, or a second household member could never be added without
    // erasing the first. Empty clears. Semicolons rather than commas so the
    // CSV never has to quote it and a diff stays readable.
    if (value === "") return null;
    for (const ref of splitRefs(value)) {
      if (parseRef(ref) === null) return `'${ref}' is not a person reference (name:… or inat:…)`;
    }
    return null;
  }
  if (field === "leads") {
    // The whole set, for acts_for's reason: one row per (person_ref, field),
    // latest wins, so a second program could never be added unless the value
    // names the first one too. Codes, never ids — the overlay is replayed
    // onto stores whose ids are not drawn yet. Whether each code names a
    // program is the apply step's question, as home_atlas's atlas code is.
    for (const code of splitCodes(value)) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(code)) return `'${code}' is not a program code`;
    }
    return null;
  }
  if (field === "orcid") {
    // The bare iD, exactly: the file is read in diffs, and one spelling per
    // iD is what lets a reader see that two rows name the same researcher.
    // Empty clears. Whoever writes a row normalises first (parseOrcid).
    return value === "" || parseOrcid(value) === value ? null : `'${value}' is not an ORCID iD (0000-0002-1825-0097)`;
  }
  if (field === "display_name" && value.trim() === "") return "display_name cannot be blank";
  return null;
}

/** Create with a header if missing; never touch an existing file. */
export async function ensureOverlayFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${HEADER}\n`, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

export function formatOverlay(rows: readonly PersonOverlayRow[]): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const body = rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(","));
  return `${[HEADER, ...body].join("\n")}\n`;
}

// One writer per path, as with corrections: the app owns the file while it
// runs (ADR 0005), so a promise chain is the whole of the locking.
const writeQueues = new Map<string, Promise<void>>();

/**
 * Record decisions: a row for a (person_ref, field) already present is
 * replaced, others append. Written to a temp file and renamed, so a crash
 * never leaves half a file behind.
 */
export async function upsertOverlay(path: string, rows: readonly PersonOverlayRow[]): Promise<void> {
  if (rows.length === 0) return;
  const queued = (writeQueues.get(path) ?? Promise.resolve()).then(async () => {
    await ensureOverlayFile(path);
    const current = parseOverlay(await readFile(path, "utf8"), path);
    const replaced = new Map(rows.map((r) => [rowKey(r), r]));
    const kept = current.filter((r) => !replaced.has(rowKey(r)));
    const tmp = `${path}.tmp`;
    await writeFile(tmp, formatOverlay([...kept, ...rows]));
    await rename(tmp, path);
  });
  writeQueues.set(path, queued.catch(() => {}));
  return queued;
}

/** Read a file that may not exist yet; missing reads as empty. */
export async function readOverlay(path: string): Promise<PersonOverlayRow[]> {
  try {
    return parseOverlay(await readFile(path, "utf8"), path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * The git-curated file first, app rows on top — app wins, matching ADR 0004.
 * Staff graduate settled rows into git and delete them from the app file.
 */
export function mergeOverlays(
  curated: readonly PersonOverlayRow[],
  app: readonly PersonOverlayRow[],
): PersonOverlayRow[] {
  const by = new Map<string, PersonOverlayRow>();
  for (const r of [...curated, ...app]) by.set(rowKey(r), r);
  return [...by.values()];
}
