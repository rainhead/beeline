import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseCsv } from "./corrections.js";

/**
 * Staff decisions about samples, in the shape of the person overlay
 * (src/person-overlay.ts): app-written rows outside the blow-away path, one
 * current row per (sample_ref, field), latest wins, replayed onto a rebuilt
 * store at the end of observation promotion (src/apply-sample-overlay.ts).
 * The first field is `locality` (beeline-649); a coordinate override
 * (beeline-942) is the next.
 *
 * The key is the design problem again. A sample's `entity_id` is a per-store
 * draw a rebuild redraws (beeline-ten), and the legacy corrections' Mongo
 * `_id` names a staging row, which a sample minted from iNaturalist does not
 * have. What a rebuild reproduces for those is the observation link:
 * `sample.inat_observation_id` is set by minting and by the free link, and
 * once set it is the sample's identity (ingest/mint-samples.sql). So
 *
 *   inat:301985221   the sample carrying that observation id
 *
 * is the only reference this file admits. A sample with no observation is
 * edited through the corrections overlay instead (src/app/sample-edit.ts),
 * which already knows how to name it; the staff screen hides the split.
 *
 * Unlike the person overlay a row carries a `base_value`, because these
 * decisions author over UPSTREAM data (CONTEXT.md, Data handling): the
 * observation can move underneath them, and ADR 0004's three-way merge
 * needs to know what the staffer saw to tell a convergence from a conflict.
 *
 * References resolve against the promoted state. One that matches no
 * sample, or two, is reported and never guessed at.
 */

export const SAMPLE_OVERLAY_FIELDS = ["locality"] as const;
export type SampleOverlayField = (typeof SAMPLE_OVERLAY_FIELDS)[number];

export interface SampleOverlayRow {
  /** `inat:<observation id>`. */
  sample_ref: string;
  field: SampleOverlayField;
  /** What the observation yielded when the decision was made. */
  base_value: string;
  /** Empty string removes the override: the field follows upstream again. */
  value: string;
  /** iNat login of whoever decided. */
  author: string;
  /** Why — the part a future reader needs and cannot reconstruct. */
  reason: string;
}

const COLUMNS = ["sample_ref", "field", "base_value", "value", "author", "reason"] as const;
const HEADER = COLUMNS.join(",");

export const sampleRowKey = (r: { sample_ref: string; field: string }) => `${r.sample_ref} ${r.field}`;

/** The reference for a sample carrying this observation. */
export const observationRef = (inatObservationId: bigint | number | string) => `inat:${inatObservationId}`;

/** `inat:301985221` → the observation id; null if malformed. */
export function parseSampleRef(ref: string): { inat_observation_id: string } | null {
  const m = /^inat:(\d+)$/.exec(ref);
  return m === null ? null : { inat_observation_id: m[1]! };
}

/** Why this value cannot be stored for this field, or null if it can. */
export function sampleValueProblem(field: SampleOverlayField, value: string): string | null {
  if (field === "locality") {
    // Empty removes; anything else must be a place name. Whitespace-only is
    // refused rather than trimmed, since a save that stored '' by accident
    // would silently become a removal.
    if (value !== "" && value.trim() === "") return "locality cannot be blank";
    if (value !== value.trim()) return "locality has leading or trailing whitespace";
  }
  return null;
}

/**
 * Refuse, don't repair — every save rewrites the whole file, so a row dropped
 * for being unparseable would be erased for good (beeline-3xw).
 */
export function parseSampleOverlay(text: string, where: string): SampleOverlayRow[] {
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
    const row = Object.fromEntries(COLUMNS.map((c, j) => [c, r[j]!])) as unknown as SampleOverlayRow;
    if (parseSampleRef(row.sample_ref) === null) {
      throw new Error(`${where} line ${line}: '${row.sample_ref}' is not a sample reference (inat:…)`);
    }
    if (!(SAMPLE_OVERLAY_FIELDS as readonly string[]).includes(row.field)) {
      throw new Error(`${where} line ${line}: '${row.field}' is not a sample overlay field`);
    }
    const bad = sampleValueProblem(row.field, row.value);
    if (bad !== null) throw new Error(`${where} line ${line}: ${bad}`);
    return row;
  });
}

/** Create with a header if missing; never touch an existing file. */
export async function ensureSampleOverlayFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${HEADER}\n`, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

export function formatSampleOverlay(rows: readonly SampleOverlayRow[]): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const body = rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(","));
  return `${[HEADER, ...body].join("\n")}\n`;
}

// One writer per path, as with the other overlays: the app owns the file
// while it runs (ADR 0005), so a promise chain is the whole of the locking.
const writeQueues = new Map<string, Promise<void>>();

/**
 * Record decisions: a row for a (sample_ref, field) already present is
 * replaced, others append. Written to a temp file and renamed, so a crash
 * never leaves half a file behind.
 */
export async function upsertSampleOverlay(path: string, rows: readonly SampleOverlayRow[]): Promise<void> {
  if (rows.length === 0) return;
  const queued = (writeQueues.get(path) ?? Promise.resolve()).then(async () => {
    await ensureSampleOverlayFile(path);
    const current = parseSampleOverlay(await readFile(path, "utf8"), path);
    const replaced = new Map(rows.map((r) => [sampleRowKey(r), r]));
    const kept = current.filter((r) => !replaced.has(sampleRowKey(r)));
    const tmp = `${path}.tmp`;
    await writeFile(tmp, formatSampleOverlay([...kept, ...rows]));
    await rename(tmp, path);
  });
  writeQueues.set(path, queued.catch(() => {}));
  return queued;
}

/** Read a file that may not exist yet; missing reads as empty. */
export async function readSampleOverlay(path: string): Promise<SampleOverlayRow[]> {
  try {
    return parseSampleOverlay(await readFile(path, "utf8"), path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
