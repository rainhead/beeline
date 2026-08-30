import { mkdir, readFile, rename, stat, writeFile, appendFile, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseCsv } from "./corrections.js";
import type { StateReader, ChangeSource } from "./person-change.js";
import { DEFAULT_DB } from "./person-change.js";

/**
 * What happened to a sample, in order (beeline-ewl).
 *
 * The second instance of ADR 0007, beside `src/person-change.ts`, and a
 * deliberate variation on it: the person log carries its own baseline —
 * 2,590 entries for 580 people, read and folded on every request — and the
 * same trick over 67,887 samples × twenty fields is a million rows in a file
 * the record page reads. So the baseline lives in a SNAPSHOT beside the log
 * (`data/sample-state.csv`): one current row per sample, restated wholesale
 * by every recording pass, exactly the shape the overlays already have. The
 * log gets only differences. "What the log last said" is the snapshot; the
 * ADR's semantics are unchanged, and its "no snapshot" line was about
 * snapshots living in the store, which a rebuild erases — this one is a file
 * and survives `pnpm db:build` the same way the log does.
 *
 * The reference is derived, never stored (Peter, 2026-08-29): the collector
 * named the way the person overlay names them, the sample number, and the
 * start date — the same facts promotion's reconcile re-identifies a sample
 * by on every run, measured unique and total across all 67,887 samples.
 * Three columns in both files rather than an encoded key, because a sample
 * number is free text and no separator survives it.
 *
 * Every writer is covered the ADR's way: entries are produced by comparing
 * the store against the snapshot, through one function reading one query, so
 * a writer that forgets is caught by the next pass and attributed to that
 * pass — which is what `source` says and `author` deliberately does not.
 */

/**
 * The fields a change can be about: the sample's STATE, as the store says it.
 * Elevation is deliberately absent — it is derived, carries its own
 * provenance (elevation_source), and self-heals on a moved coordinate
 * (beeline-x5c); logging it would record the derive job doing its job.
 *
 * The last three are the components of the reference itself, and their order
 * here is load-bearing — see MOVERS.
 */
export const SAMPLE_FIELDS = [
  "kind",
  "date_end",
  "specimen_count",
  "observation",
  "location",
  "location_source",
  "geoprivacy",
  "taxon_geoprivacy",
  "country",
  "state_province",
  "county",
  "locality",
  "protocol",
  "sampling_effort",
  "host",
  "atlas",
  "atlas_assigned_by",
  "co_collectors",
  "collector",
  "sample_number",
  "date_start",
] as const;
export type SampleField = (typeof SAMPLE_FIELDS)[number];

/**
 * The fields that ARE the reference. A change to one moves it, and the log
 * follows — forward only, in file order, never onto a triple it already
 * knows a sample by (ADR 0007's rename rule, ported).
 *
 * Where the person log has one moving field and simply says it last, this
 * has three, and emitting them all under the pre-pass triple would strand
 * every mover after the first: the fold moves the record on the first one
 * and the second, still filed under the old triple, would start a fresh
 * half-empty sample. So the WRITER files each mover under the triple as
 * already moved by the movers before it, in this order, and the fold stays
 * as simple as the person one: look the entry's triple up, apply, move on.
 */
export const MOVERS: readonly SampleField[] = ["collector", "sample_number", "date_start"];

const NON_MOVERS: readonly SampleField[] = SAMPLE_FIELDS.filter((f) => !MOVERS.includes(f));

/** The value a field has when there is nothing to say. */
const ABSENT = "";

export interface SampleChange {
  /** ISO-8601 UTC, so the file sorts by string as well as by time. */
  at: string;
  /** The reference: the person overlay's vocabulary for the primary collector. */
  collector: string;
  sample_number: string;
  date_start: string;
  field: SampleField;
  old_value: string;
  new_value: string;
  /** iNat login of whoever decided, or empty where nobody did. */
  author: string;
  source: ChangeSource;
  reason: string;
}

const LOG_COLUMNS = [
  "at",
  "collector",
  "sample_number",
  "date_start",
  "field",
  "old_value",
  "new_value",
  "author",
  "source",
  "reason",
] as const;
const LOG_HEADER = LOG_COLUMNS.join(",");

/** Snapshot columns: the reference, then every field the log can speak about. */
const STATE_COLUMNS = ["collector", "sample_number", "date_start", ...NON_MOVERS] as const;
const STATE_HEADER = STATE_COLUMNS.join(",");

export const SAMPLE_CHANGE_LOG = "data/sample-change.csv";
export const SAMPLE_STATE_SNAPSHOT = "data/sample-state.csv";

export interface SampleLogPaths {
  log: string;
  state: string;
}

/**
 * The log a CLI run should write, given the database it was pointed at, or
 * null for a database whose history this environment does not keep — the
 * same rule, for the same reason, as changeLogFor (person-change.ts):
 * promoting a scratch copy must not diff one corpus against another's
 * history.
 */
export function sampleLogFor(dbPath: string, env: Record<string, string | undefined>): SampleLogPaths | null {
  if (resolve(dbPath) !== resolve(env.BEELINE_DB ?? DEFAULT_DB)) return null;
  return {
    log: env.BEELINE_SAMPLE_CHANGES ?? SAMPLE_CHANGE_LOG,
    state: env.BEELINE_SAMPLE_STATE ?? SAMPLE_STATE_SNAPSHOT,
  };
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

/** Internal composite key for a triple; U+001F cannot survive a CSV cell
 * written by this codebase, so it cannot collide with field content. */
const SEP = "\u001f";
const keyOf = (collector: string, number: string, date: string) =>
  `${collector}${SEP}${number}${SEP}${date}`;

export interface SampleState {
  collector: string;
  sample_number: string;
  date_start: string;
  fields: Record<SampleField, string>;
}

const stateKey = (s: { collector: string; sample_number: string; date_start: string }) =>
  keyOf(s.collector, s.sample_number, s.date_start);

/**
 * The sample's state, one row per sample, every value a string. One query,
 * every producer — a difference in the log is a difference in the store,
 * never in how two writers spelled the same fact (ADR 0007).
 *
 * The collector reference is computed the way the person overlay names a
 * person: their display name where it is theirs alone, their iNat account
 * otherwise, nothing where neither serves — an `entity_id` is a per-store
 * sequence draw a rebuild redraws (beeline-ten).
 */
export const SAMPLE_STATE_SQL = `
  WITH person_ref AS (
    SELECT p.entity_id,
           CASE WHEN (SELECT count(*) FROM person q WHERE q.display_name = p.display_name) = 1
                THEN concat('name:', p.display_name)
                WHEN a.inat_user_id IS NOT NULL
                THEN concat('inat:', CAST(a.inat_user_id AS VARCHAR))
                ELSE NULL END AS ref
    FROM person p
    LEFT JOIN inat_account a ON a.person_id = p.entity_id
  )
  SELECT pr.ref AS collector,
         s.sample_number,
         CAST(s.date_start AS VARCHAR) AS date_start,
         CAST(s.date_end AS VARCHAR) AS date_end,
         s.kind,
         CAST(s.specimen_count AS VARCHAR) AS specimen_count,
         coalesce(CAST(s.inat_observation_id AS VARCHAR), '') AS observation,
         CASE WHEN loc.sample_id IS NULL THEN ''
              ELSE concat(CAST(loc.latitude AS VARCHAR), ',', CAST(loc.longitude AS VARCHAR),
                          CASE WHEN loc.coordinate_uncertainty_m IS NULL THEN ''
                               ELSE concat(' ±', CAST(loc.coordinate_uncertainty_m AS VARCHAR), ' m') END)
         END AS location,
         coalesce(loc.source, '') AS location_source,
         coalesce(s.geoprivacy, '') AS geoprivacy,
         coalesce(s.taxon_geoprivacy, '') AS taxon_geoprivacy,
         coalesce(s.country, '') AS country,
         coalesce(s.state_province, '') AS state_province,
         coalesce(s.county, '') AS county,
         coalesce(s.locality, '') AS locality,
         coalesce(s.protocol, '') AS protocol,
         coalesce(s.sampling_effort, '') AS sampling_effort,
         CASE WHEN sa.sample_id IS NULL THEN ''
              WHEN sa.atlas_id IS NULL THEN 'none'
              ELSE coalesce(atl.code, '') END AS atlas,
         coalesce(apr.ref, '') AS atlas_assigned_by,
         coalesce((SELECT string_agg(coalesce(cpr.ref, '?'), ';' ORDER BY sc.position)
                   FROM sample_collector sc
                   LEFT JOIN person_ref cpr ON cpr.entity_id = sc.person_id
                   WHERE sc.sample_id = s.entity_id AND sc.position > 1), '') AS co_collectors,
         concat_ws(' ', CAST(s.host_inat_taxon_id AS VARCHAR), s.host_name_as_observed) AS host
  FROM sample s
  JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
  JOIN person_ref pr ON pr.entity_id = pc.person_id
  LEFT JOIN sample_location loc ON loc.sample_id = s.entity_id
  LEFT JOIN sample_atlas sa ON sa.sample_id = s.entity_id
  LEFT JOIN atlas atl ON atl.entity_id = sa.atlas_id
  LEFT JOIN person_ref apr ON apr.entity_id = sa.assigned_by`;

export interface SampleStates {
  /** Keyed by triple. */
  states: Map<string, SampleState>;
  /**
   * What the pass cannot speak for, so the snapshot must keep saying what it
   * last said: the triples of colliding samples, and the observation links
   * of every suppressed sample. Without the carry-forward, a full
   * restatement drops the rows — and the pass after the duplicate or the
   * namesake is RESOLVED then records every field as a spurious arrival,
   * permanently (CodeRabbit and the adversarial review of PR #32). A sample
   * that truly vanished is in neither set and still loses its row.
   *
   * Deliberately NOT carried: rows reached only by a (number, date) pair.
   * An earlier revision kept them for unlinked unreferenceable samples, and
   * that kept a vanished collector's row alive for exactly the claim the
   * matcher's liveness gate cannot refuse — the collector being gone is the
   * gate's pass condition — so an unrelated sample sharing the pair could
   * inherit the row's history permanently (CodeRabbit on PR #33). The cost
   * of not carrying is a spurious re-arrival when an UNLINKED
   * unreferenceable sample is resolved: noise, filed under the right
   * sample, against a fabricated inheritance filed under the wrong one.
   */
  suppressedKeys: Set<string>;
  suppressedObservations: Set<string>;
    /** Samples whose collector no reference names: unrecordable, so counted. */
  unreferenceable: number;
  /**
   * Samples sharing one triple — a live duplicate_sample_number. The
   * reference was measured unique across the corpus, but nothing stops a
   * correction creating a collision, and two samples one reference names are
   * indistinguishable from here: recording either under it would hand one
   * sample the other's history. Both are recorded as nothing and counted,
   * until the duplicate is resolved (ADR 0007: what cannot be attributed is
   * recorded as nothing).
   */
  colliding: number;
}

export async function readSampleStates(read: StateReader, where = ""): Promise<SampleStates> {
  const rows = await read(where === "" ? SAMPLE_STATE_SQL : `${SAMPLE_STATE_SQL}\n  WHERE ${where}`);
  const states = new Map<string, SampleState>();
  const suppressedKeys = new Set<string>();
  const suppressedObservations = new Set<string>();
  let unreferenceable = 0;
  for (const row of rows) {
    const text = (k: string) => String(row[k] ?? "");
    const collector = row.collector == null ? "" : String(row.collector);
    if (collector === "") {
      unreferenceable++;
      if (text("observation") !== "") suppressedObservations.add(text("observation"));
      continue;
    }
    const state: SampleState = {
      collector,
      sample_number: text("sample_number"),
      date_start: text("date_start"),
      fields: Object.fromEntries(SAMPLE_FIELDS.map((f) => [f, text(f)])) as Record<SampleField, string>,
    };
    state.fields.collector = collector;
    const key = stateKey(state);
    if (states.has(key) || suppressedKeys.has(key)) {
      // Both colliding samples are suppressed: their observations mark the
      // snapshot rows each may have moved OFF of, which the carry-forward
      // must also keep for the day the duplicate is resolved.
      const other = states.get(key);
      if (other !== undefined && other.fields.observation !== "") {
        suppressedObservations.add(other.fields.observation);
      }
      if (state.fields.observation !== "") suppressedObservations.add(state.fields.observation);
      suppressedKeys.add(key);
      states.delete(key);
      continue;
    }
    states.set(key, state);
  }
  // Count the samples, not the keys: a collision is at least two of them.
  let colliding = 0;
  for (const row of rows) {
    const collector = row.collector == null ? "" : String(row.collector);
    if (collector === "") continue;
    if (suppressedKeys.has(keyOf(collector, String(row.sample_number ?? ""), String(row.date_start ?? "")))) colliding++;
  }
  return { states, suppressedKeys, suppressedObservations, unreferenceable, colliding };
}

// ── The snapshot ─────────────────────────────────────────────────────────

/**
 * Read the snapshot; missing reads as "first pass" (null, not empty).
 *
 * A header this code did not write reads as first pass TOO, and loudly:
 * STATE_COLUMNS is derived from SAMPLE_FIELDS, so the pass after a field is
 * added would find every existing row the wrong width, count all 67,887
 * malformed behind one warning, and — with an empty-but-non-null map — append
 * a million spurious arrivals to a file that cannot be un-appended
 * (adversarial review of PR #32). Re-baselining costs the changes made since
 * the last pass, which is bounded and visible; the arrivals are neither.
 */
export async function readSnapshot(path: string): Promise<Map<string, SampleState> | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const headerEnd = text.indexOf("\n");
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
  if (header.replace(/\r$/, "") !== STATE_HEADER) {
    console.warn(
      `${path}: snapshot header does not match this code's columns — re-baselining ` +
        `(changes since the last pass will not be recorded)`,
    );
    return null;
  }
  const records = parseCsv(text);
  const states = new Map<string, SampleState>();
  let malformed = 0;
  for (const r of records.slice(1)) {
    if (r.length !== STATE_COLUMNS.length) {
      malformed++;
      continue;
    }
    const row = Object.fromEntries(STATE_COLUMNS.map((c, j) => [c, r[j]!])) as Record<string, string>;
    const fields = Object.fromEntries(SAMPLE_FIELDS.map((f) => [f, row[f] ?? ""])) as Record<SampleField, string>;
    fields.collector = row.collector!;
    fields.sample_number = row.sample_number!;
    fields.date_start = row.date_start!;
    const state: SampleState = {
      collector: row.collector!,
      sample_number: row.sample_number!,
      date_start: row.date_start!,
      fields,
    };
    states.set(stateKey(state), state);
  }
  // Lenient like the log: the snapshot is restated by every pass, so a
  // dropped row costs one sample one spurious arrival, not its history.
  if (malformed > 0) console.warn(`${path}: skipped ${malformed} unreadable snapshot row(s)`);
  return states;
}

/**
 * Restate the snapshot — whole file, temp-and-rename, so a crash leaves the
 * previous statement rather than half of one. Sorted by triple so that two
 * identical states produce byte-identical files.
 */
let tmpCounter = 0;

export async function writeSnapshot(path: string, states: Iterable<SampleState>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const rows = [...states].sort((a, b) => (stateKey(a) < stateKey(b) ? -1 : 1));
  const lines = rows.map((s) => STATE_COLUMNS.map((c) => cell(s.fields[c as SampleField] ?? "")).join(","));
  // Unique per write: passes are serialized within this process, but a CLI
  // and the app pointed at one store (against ADR 0005) can still race. The
  // unique name means they can never splice two restatements into one file;
  // what a lost restatement costs is honest duplicates — the winner's
  // snapshot lags the loser's log entries, and the next pass re-derives and
  // re-appends them, attributed to itself. Appending first and restating
  // second errs the same way on a crash between the two, and deliberately:
  // a duplicate in a log is legible where a lost row is not (the appender's
  // own rule).
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  await writeFile(tmp, `${STATE_HEADER}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`);
  await rename(tmp, path);
}

// ── The log ──────────────────────────────────────────────────────────────

export function formatSampleChanges(rows: readonly SampleChange[]): string {
  return rows.map((r) => LOG_COLUMNS.map((c) => cell(r[c])).join(",")).join("\n");
}

/** Lenient, like the person log and for its reason: appending cannot erase,
 * so a bad row can only cost itself, and refusing would take the record page
 * down with it. */
export function parseSampleChanges(text: string): { changes: SampleChange[]; malformed: number } {
  const records = parseCsv(text);
  if (records.length === 0) return { changes: [], malformed: 0 };
  const changes: SampleChange[] = [];
  let malformed = 0;
  for (const r of records.slice(1)) {
    if (r.length !== LOG_COLUMNS.length) {
      malformed++;
      continue;
    }
    const row = Object.fromEntries(LOG_COLUMNS.map((c, j) => [c, r[j]!])) as unknown as SampleChange;
    if (!(SAMPLE_FIELDS as readonly string[]).includes(row.field)) {
      malformed++;
      continue;
    }
    changes.push(row);
  }
  return { changes, malformed };
}

// The record page folds the whole log per request, which the person page's
// precedent licensed at 248 KB and this log will outgrow. Cache the parse and
// fold on the file's identity; appends change both mtime and size.
const readCache = new Map<string, { mtimeMs: number; size: number; changes: SampleChange[] }>();

export async function readSampleChanges(path: string): Promise<SampleChange[]> {
  try {
    const s = await stat(path);
    const hit = readCache.get(path);
    if (hit !== undefined && hit.mtimeMs === s.mtimeMs && hit.size === s.size) return hit.changes;
    const changes = await readSampleChangesUncached(path);
    readCache.set(path, { mtimeMs: s.mtimeMs, size: s.size, changes });
    return changes;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function readSampleChangesUncached(path: string): Promise<SampleChange[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const { changes, malformed } = parseSampleChanges(text);
  if (malformed > 0) console.warn(`${path}: skipped ${malformed} unreadable row(s)`);
  return changes;
}

const writeQueues = new Map<string, Promise<void>>();

/** Append, never restate — repairing an unterminated last line first, as the
 * person log does and for its reason. */
export async function appendSampleChanges(path: string, rows: readonly SampleChange[]): Promise<void> {
  if (rows.length === 0) return;
  const queued = (writeQueues.get(path) ?? Promise.resolve()).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, `${LOG_HEADER}\n`, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
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
    await appendFile(path, `${terminated ? "" : "\n"}${formatSampleChanges(rows)}\n`);
  });
  writeQueues.set(path, queued.catch(() => {}));
  return queued;
}

// ── Matching a store sample to a snapshot row ────────────────────────────

/** value → the one row last recorded carrying it, or null where two did. */
function valueIndex(rows: Iterable<SampleState>, value: (s: SampleState) => string): Map<string, SampleState | null> {
  const by = new Map<string, SampleState | null>();
  for (const row of rows) {
    const v = value(row);
    if (v === "") continue;
    by.set(v, by.has(v) ? null : row);
  }
  return by;
}

export interface SampleMatching {
  /** store triple key → the snapshot row that is the same sample. */
  matched: Map<string, SampleState>;
  /** Store samples reaching a history the pass could not attribute: recorded
   * as nothing, and counted (ADR 0007). */
  contested: Set<string>;
  /** The snapshot rows those samples were reaching for. The restatement must
   * carry these unchanged: writing the claimants' CURRENT state instead
   * buries the contest — the next pass direct-matches the fresh rows, finds
   * no difference, and the unattributable transition is never recorded by
   * any pass (adversarial review of PR #32). */
  contestedRows: Set<string>;
}

/**
 * Which snapshot row each store sample is, where the evidence says. In order
 * of how much the evidence is worth, every claim proposed before any is
 * granted (ADR 0007 — deciding one at a time is a different, wrong problem):
 *
 *   the triple itself      the ordinary case — nothing moved.
 *   the observation link   the reference moved around a stable link: a staff
 *                          correction to the number or date, a collector
 *                          whose person_ref changed when an account was
 *                          bound or a namesake arrived. The link is the
 *                          identity once made (beeline-oyq), which is what
 *                          licenses this tier.
 *   number and date        an unlinked sample whose collector reference
 *                          moved. Weakest, so it is refused outright when
 *                          the snapshot row records an observation link some
 *                          OTHER store sample now carries — that sample is
 *                          the better heir, and granting the weaker claim
 *                          would hand it a history the link disputes.
 *
 * Two claimants on one row, and neither claims: iteration order deciding who
 * inherits a history is not an answer.
 */
export function matchSamples(
  snapshot: ReadonlyMap<string, SampleState>,
  states: ReadonlyMap<string, SampleState>,
  { directOnly = false } = {},
): SampleMatching {
  const rows = [...snapshot.values()];
  const byObservation = valueIndex(rows, (s) => s.fields.observation);
  const byNumberDate = valueIndex(rows, (s) => `${s.sample_number}${SEP}${s.date_start}`);
  // Which store sample holds each observation now — the store's answer, not
  // the snapshot's, because the snapshot keeps whatever a sample last held.
  const holder = new Map<string, SampleState>();
  const liveCollectors = new Set<string>();
  for (const state of states.values()) {
    if (state.fields.observation !== "") holder.set(state.fields.observation, state);
    liveCollectors.add(state.collector);
  }

  const proposed = new Map<SampleState, SampleState>();
  for (const state of states.values()) {
    const direct = snapshot.get(stateKey(state));
    if (direct !== undefined) {
      proposed.set(state, direct);
      continue;
    }
    // The weaker tiers exist only for a FULL pass. Their guards — one
    // observation holder per link, two claimants record nothing — are built
    // from the whole store, and a pass narrowed to one sample has an empty
    // holder index and can never see a second claimant, so it would grant a
    // weak match a full pass refuses and then delete a live sibling's
    // snapshot row (adversarial review of PR #32). A narrowed miss records
    // nothing and defers to the next full pass.
    if (directOnly) continue;
    const byObs = state.fields.observation === "" ? null : byObservation.get(state.fields.observation);
    if (byObs != null) {
      proposed.set(state, byObs);
      continue;
    }
    const byPair = byNumberDate.get(`${state.sample_number}${SEP}${state.date_start}`);
    if (byPair == null) continue;
    // The refusal described above: the row's own link points at somebody else.
    const linkedTo = byPair.fields.observation === "" ? undefined : holder.get(byPair.fields.observation);
    if (linkedTo !== undefined && linkedTo !== state) continue;
    // The person log's gate, ported: a collector reference the store still
    // answers to means that collector is still here, and their row is not
    // somebody else's to claim on a number-and-date coincidence — however
    // unique the pair happens to be. Only a row whose collector nobody
    // answers to any more can be recognised this way, which is the
    // ref-moved case this tier exists for (CodeRabbit on PR #33).
    if (byPair.collector !== state.collector && liveCollectors.has(byPair.collector)) continue;
    proposed.set(state, byPair);
  }

  const claimants = new Map<SampleState, number>();
  for (const row of proposed.values()) claimants.set(row, (claimants.get(row) ?? 0) + 1);
  const matched = new Map<string, SampleState>();
  const contested = new Set<string>();
  const contestedRows = new Set<string>();
  for (const [state, row] of proposed) {
    if ((claimants.get(row) ?? 0) > 1) {
      contested.add(stateKey(state));
      contestedRows.add(stateKey(row));
    } else matched.set(stateKey(state), row);
  }
  return { matched, contested, contestedRows };
}

// ── Recording ────────────────────────────────────────────────────────────

export interface SampleRecordOptions {
  source: ChangeSource;
  author?: string;
  reason?: string;
  /** The instant recorded on every entry; defaulted so tests can pin it. */
  at?: string;
  /**
   * Narrow the pass to some samples — `s.entity_id = 42` from the edit
   * screen, so its author is credited with its edit and nothing else. The
   * snapshot is then patched for those samples and restated; everything else
   * keeps what the last full pass said.
   */
  where?: string;
}

export interface SampleRecordResult {
  appended: number;
  /** Samples sharing one reference this pass — see SampleStates.colliding. */
  colliding: number;
  /**
   * True on the pass that found no snapshot and wrote one: the whole corpus
   * as it stands, recorded as zero entries. The person log writes its
   * baseline INTO the log and reads it forever; a million-row baseline is
   * why this one lives beside it instead (ADR 0007, beeline-ewl).
   */
  baselined: boolean;
  unreferenceable: number;
  contested: number;
}

/**
 * Reconcile the log with the store: append an entry for every field whose
 * value differs from what the snapshot last said, then restate the snapshot.
 * Idempotent — a second pass appends nothing — which is what lets every
 * producer call it without coordinating, and what catches the writer that
 * forgot.
 *
 * A triple falling silent is recorded as nothing (ADR 0007): it is equally a
 * deleted sample, a reference that moved beyond the evidence above, and a
 * store promoted from a smaller corpus. Its history simply stops, and the
 * snapshot restatement drops the row.
 */
export async function recordSampleChanges(
  read: StateReader,
  paths: SampleLogPaths,
  opts: SampleRecordOptions,
): Promise<SampleRecordResult> {
  // One pass at a time per snapshot: the app records an authored edit per
  // request and the nightly reconciles in the same process, and two passes
  // interleaving their read-diff-restate would re-derive each other's
  // differences into the append-only log (CodeRabbit on PR #32). The same
  // queue shape appendSampleChanges uses.
  const queued = (recordQueues.get(paths.state) ?? Promise.resolve()).then(() =>
    recordPass(read, paths, opts),
  );
  recordQueues.set(
    paths.state,
    queued.then(
      () => {},
      () => {},
    ),
  );
  return queued;
}

const recordQueues = new Map<string, Promise<unknown>>();

async function recordPass(
  read: StateReader,
  paths: SampleLogPaths,
  opts: SampleRecordOptions,
): Promise<SampleRecordResult> {
  const { states, suppressedKeys, suppressedObservations, unreferenceable, colliding } =
    await readSampleStates(read, opts.where ?? "");
  const snapshot = await readSnapshot(paths.state);

  // First pass: the store as it stands is the baseline, and nothing is an
  // event. (A narrowed first pass must not write a one-sample snapshot that
  // erases the baseline's purpose — it baselines the whole store instead.)
  if (snapshot === null) {
    const all = opts.where == null ? states : (await readSampleStates(read)).states;
    await writeSnapshot(paths.state, all.values());
    return { appended: 0, baselined: true, unreferenceable, colliding, contested: 0 };
  }

  const { matched, contested, contestedRows } = matchSamples(snapshot, states, {
    directOnly: opts.where != null,
  });
  const at = opts.at ?? new Date().toISOString();
  const rows: SampleChange[] = [];
  for (const [key, state] of states) {
    if (contested.has(key)) continue;
    const before = matched.get(key);
    // A narrowed pass that cannot match its sample DIRECTLY defers whole:
    // recording it as an arrival would start a second history for a sample
    // the next full pass will recognise through the weak tiers. The full
    // pass records it then, attributed to itself; only the author's name is
    // lost to the log, and the corrections overlay holds that durably.
    if (opts.where != null && before === undefined) continue;
    // Filed under the triple the LOG knows the sample by — and each mover
    // under the triple as moved by the movers before it (see MOVERS).
    const ref = {
      collector: before?.collector ?? state.collector,
      sample_number: before?.sample_number ?? state.sample_number,
      date_start: before?.date_start ?? state.date_start,
    };
    const emit = (field: SampleField) => {
      const was = before?.fields[field] ?? ABSENT;
      if (was === state.fields[field]) return;
      rows.push({
        at,
        collector: ref.collector,
        sample_number: ref.sample_number,
        date_start: ref.date_start,
        field,
        old_value: was,
        new_value: state.fields[field],
        author: opts.author ?? "",
        source: opts.source,
        reason: opts.reason ?? "",
      });
    };
    for (const field of NON_MOVERS) emit(field);
    for (const field of MOVERS) {
      emit(field);
      // The next mover is filed under the reference as moved so far.
      ref[field as "collector" | "sample_number" | "date_start"] = state.fields[field];
    }
  }

  await appendSampleChanges(paths.log, rows);

  // Restate the snapshot. The rule is: **a pass may only restate what it
  // recorded.** A full pass writes the state of every sample it recorded and
  // carries forward, unchanged, the rows of everything it could not speak
  // for — colliding triples, suppressed observation links and number-date
  // pairs, and the rows contested claimants were reaching for. Restating a
  // contested sample's current state would bury the contest: the next pass
  // direct-matches the fresh row, finds no difference, and the transition is
  // never recorded by any pass. A truly vanished sample is in none of those
  // sets and loses its row. A narrowed pass patches: matched rows move to
  // their new triple, new samples arrive, and everything outside the
  // narrowing keeps its row.
  if (opts.where == null) {
    const next = new Map<string, SampleState>();
    for (const [key, state] of states) {
      if (!contested.has(key)) next.set(key, state);
    }
    for (const [key, row] of snapshot) {
      if (next.has(key)) continue;
      if (
        suppressedKeys.has(key) ||
        contestedRows.has(key) ||
        (row.fields.observation !== "" && suppressedObservations.has(row.fields.observation))
      ) {
        next.set(key, row);
      }
    }
    // Nothing recorded and nothing moved: leave the file alone. The
    // restatement is byte-deterministic, so rewriting 11 MB to say the same
    // thing again is pure cost — and it is the steady case (adversarial
    // review of PR #32).
    if (rows.length > 0 || next.size !== snapshot.size || [...next.keys()].some((k) => !snapshot.has(k))) {
      await writeSnapshot(paths.state, next.values());
    }
  } else {
    const next = new Map(snapshot);
    let touched = false;
    for (const [key, state] of states) {
      if (contested.has(key)) continue;
      const before = matched.get(key);
      // The same deferral as the emit loop: an unmatched sample is the next
      // full pass's to place, and patching it in here would pre-empt that.
      if (before === undefined && !snapshot.has(key)) continue;
      if (before !== undefined) next.delete(stateKey(before));
      next.set(key, state);
      touched = true;
    }
    if (touched) await writeSnapshot(paths.state, next.values());
  }
  return { appended: rows.length, baselined: false, unreferenceable, colliding, contested: contested.size };
}

// ── Reading one sample's history ─────────────────────────────────────────

/**
 * Fold the log in file order, following moved references — the person log's
 * lastKnown, with the writer's mover discipline making one dumb fold serve
 * three moving fields. Never onto a triple already known: two samples whose
 * keys swap must not merge (ADR 0007).
 */
export function foldSampleChanges(changes: readonly SampleChange[]): Map<string, SampleChange[]> {
  const byKey = new Map<string, SampleChange[]>();
  for (const c of changes) {
    const key = keyOf(c.collector, c.sample_number, c.date_start);
    const entries = byKey.get(key) ?? [];
    entries.push(c);
    byKey.set(key, entries);
    if (!MOVERS.includes(c.field) || c.new_value === "" || c.old_value === c.new_value) continue;
    const moved = {
      collector: c.collector,
      sample_number: c.sample_number,
      date_start: c.date_start,
      [c.field]: c.new_value,
    };
    const movedKey = keyOf(moved.collector, moved.sample_number, moved.date_start);
    if (byKey.has(movedKey)) continue;
    byKey.delete(key);
    byKey.set(movedKey, entries);
  }
  return byKey;
}

/**
 * One sample's history, newest first, addressed by the triple the STORE
 * derives for it — the record page has the sample in hand and asks with its
 * current reference, which the fold has followed every recorded move to.
 *
 * The caller must first ask whether the triple names this sample ALONE
 * (sampleChangeHistory does): during a live duplicate_sample_number two
 * samples derive the same triple, and answering both pages with the carried
 * history would show one sample the other's provenance on the very screen
 * staff would use to untangle them (adversarial review of PR #32).
 */
export function sampleHistory(
  changes: readonly SampleChange[],
  ref: { collector: string; sample_number: string; date_start: string },
): SampleChange[] {
  const folded = foldSampleChanges(changes);
  const entries = folded.get(keyOf(ref.collector, ref.sample_number, ref.date_start)) ?? [];
  return [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
