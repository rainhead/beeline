import { mkdtemp, readdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { cachedArchivePath, ECDYSIS_COLLECTIONS, readMarkerOf, type EcdysisCollection, type ReadMarker } from "../fetch-ecdysis.js";
import { methodNamesTrap } from "../trap-method.js";
import {
  archiveDescriptor,
  csvCellsOf,
  DWC,
  identificationsOf,
  programArchives,
  specimenArchiveStream,
  SYMBIOTA,
  type ArchiveLayout,
  type ArchivePage,
  type IdentificationRow,
} from "./dwc-archive.js";
import {
  ALL,
  csvExactLine,
  dateIdentified,
  EMPTY_QUERY,
  exportFilename,
  filteredSpecimens,
  hostNamesOnce,
  isoDate,
  listSpecimens,
  needsRollup,
  observationGone,
  STAFF_READER,
  type ListingQuery,
  type SpecimenRow,
} from "./listings.js";
import type { CsvTiming } from "./request-timing.js";

/**
 * The two files a person uploads to Ecdysis by hand (beeline-8dx9.12, Peter,
 * 2026-11-20): a Darwin Core archive of the specimens Ecdysis does not hold,
 * and a CSV of associations (the iNaturalist observation and the host plant)
 * for Symbiota's "Import extended data" page. What Symbiota does with them is
 * measured in docs/research/symbiota-import-test-2026-11-20.md; the reasons
 * for each choice below are in docs/architecture/the-upload-to-ecdysis.md.
 *
 * The archive is written the way the program archives are (src/app/dwc-archive.ts
 * shares its stream and cell functions) with a column list of its own, one
 * collection at a time, and only for a collection Beeline reads whole (an
 * Ecdysis collection, not a dataset of one: Symbiota matches a catalog number
 * across the whole collection, and an upload adds no record to a dataset).
 * Its rows are specimens that
 * - belong to the collection's program,
 * - have a label on paper (`specimen_on_paper`) and a label number of digits,
 * - carry no disposition other than "in collection" (a missing pin, or a
 *   remark that old Beeline recorded the specimen twice),
 * - have no catalog number from Ecdysis (`specimen_catalog_number`), and whose
 *   would-be catalog number, the collection's prefix and the label number, is
 *   not in the archive Beeline last downloaded from Ecdysis either, which
 *   also holds the records Beeline could not match to a specimen, and
 * - unless the downloader chooses otherwise, are not obscured: neither the
 *   taxon (their program has not said whether true coordinates may leave
 *   Beeline, beeline-1kb.7.1) nor the observer's own observation.
 * Nothing is built from a read of Ecdysis more than two hours old, because
 * Symbiota replaces a record it matches by catalog number whole. The rules are
 * applied again, row by row, when the rows are written.
 */

/** How old the last read of Ecdysis may be before no file is written. */
export const UPLOAD_FRESH_HOURS = 2;

/** Symbiota's `omoccurrences.catalogNumber` is `varchar(32)`. */
export const CATALOG_NUMBER_LIMIT = 32;

/**
 * The countries and states or provinces the collections' programs can
 * produce, spelled out as Ecdysis spells them (Joel Gardner's files do the
 * same: ecdysis-upload-files.md, rows 9 and 10). The store keeps ISO alpha-3
 * and the postal abbreviation. A value not in a table is written as the store
 * has it and reported (`UploadPlan.unspelled`).
 */
export const COUNTRY_NAMES: Readonly<Record<string, string>> = { USA: "United States", CAN: "Canada" };
export const STATE_NAMES: Readonly<Record<string, string>> = { WA: "Washington", BC: "British Columbia" };

/**
 * The fixed values a collection's records carry, by the program whose
 * collection it is. `labelProject` is what a collection's existing records
 * carry in Symbiota's `labelProject` column (Joel's Washington files say
 * "Washington Bee Atlas"); British Columbia's is left out until BC says what
 * its records carry. A collection with no entry is offered no file.
 */
export interface CollectionConstants {
  lifeStage: string;
  preparations: string;
  individualCount: number;
  labelProject?: string;
}
export const UPLOAD_CONSTANTS: Readonly<Record<string, CollectionConstants>> = {
  WaBA: { lifeStage: "adult", preparations: "pinned", individualCount: 1, labelProject: "Washington Bee Atlas" },
  BC: { lifeStage: "adult", preparations: "pinned", individualCount: 1 },
};
const constantsOf = (collection: EcdysisCollection): CollectionConstants => {
  const found = UPLOAD_CONSTANTS[collection.program];
  if (found === undefined) throw new Error(`The collection of ${collection.program} declares no fixed values for an upload`);
  return found;
};

/** Whether Beeline reads the whole Ecdysis collection, which a file for it needs; a dataset is a part of one. */
export const readsWholeCollection = (collection: EcdysisCollection): boolean => collection.collectionId !== undefined;

// --- What Beeline last read from Ecdysis -----------------------------------

/** Why no file is offered for a collection. */
export type UploadRefusal =
  /** Beeline reads only a dataset of this collection, not all of it. */
  | { reason: "dataset"; readAt: null }
  /** No successful read has left its marker. */
  | { reason: "never"; readAt: null }
  /** The last read is older than `UPLOAD_FRESH_HOURS`. */
  | { reason: "stale"; readAt: Date }
  /** A read succeeded but the archive it loaded is not on disk. */
  | { reason: "no-archive"; readAt: Date }
  /** The archive on disk is not the one the read loaded: its size or time differs from the marker's. */
  | { reason: "changed"; readAt: Date }
  /** The archive is on disk and could not be read as an Ecdysis archive. */
  | { reason: "unreadable"; readAt: Date }
  /** The archive holds fewer catalog numbers than Beeline has recorded from Ecdysis for the collection. */
  | { reason: "incomplete"; readAt: Date };

export type EcdysisRead = { ok: true; readAt: Date; archivePath: string; marker: ReadMarker } | ({ ok: false } & UploadRefusal);

/**
 * When Ecdysis was last read for a collection, and whether that is recent
 * enough to build from. The source is the marker the fetch writes beside the
 * cached archive after every successful read, downloaded or found unchanged
 * (`readMarkerOf`): the archive's own file time and the probe baseline change
 * only when an archive is downloaded, so on a quiet week they are a week old
 * while every night's read succeeded, and the job's history says only in prose
 * which collection it read. The marker also says which zip the read loaded, so
 * a zip changed or replaced since is refused, because "Ecdysis does not hold
 * it" is judged against that zip's catalog numbers.
 */
export async function ecdysisRead(collection: EcdysisCollection, opts: { ecdysisDir: string; now?: Date }): Promise<EcdysisRead> {
  const now = opts.now ?? new Date();
  if (!readsWholeCollection(collection)) return { ok: false, reason: "dataset", readAt: null };
  const marker = await readMarkerOf(opts.ecdysisDir, collection);
  if (marker === null) return { ok: false, reason: "never", readAt: null };
  const readAt = new Date(marker.readAt);
  if (now.getTime() - readAt.getTime() > UPLOAD_FRESH_HOURS * 3_600_000) return { ok: false, reason: "stale", readAt };
  const archivePath = cachedArchivePath(opts.ecdysisDir, collection);
  let st;
  try {
    st = await stat(archivePath);
  } catch {
    return { ok: false, reason: "no-archive", readAt };
  }
  if (st.size !== marker.zipBytes || st.mtime.toISOString() !== marker.zipModifiedAt) return { ok: false, reason: "changed", readAt };
  return { ok: true, readAt, archivePath, marker };
}

/** Catalog numbers are compared the way Symbiota's database compares them: without regard to case. */
export const catalogKey = (catalogNumber: string): string => catalogNumber.trim().toLowerCase();

const heldCache = new Map<string, { key: string; held: Set<string> }>();
/** An unpack in progress, by archive, so two first views share one. */
const heldInFlight = new Map<string, Promise<Set<string>>>();
/** Unpacks run one at a time, so that clearing the leftovers of an earlier one cannot clear a folder another is using. */
let unpacking: Promise<unknown> = Promise.resolve();

/**
 * Every catalog number in the archive Beeline last downloaded from Ecdysis,
 * the ones it matched to a specimen and the ones it could not. The store keeps
 * only the matched ones (`specimen_catalog_number`: the loader counts the rest
 * and keeps five as a sample), so the archive itself is read, with DuckDB as
 * the loader reads it. It is unpacked into a folder of its own under
 * `workDir`, which the store may read (`storeFiles`), and removed; folders
 * left by an unpack that was cut short are removed first. Read once per
 * download: the result is kept while the file's size and time stay the same,
 * and two requests that arrive together share one unpack.
 */
export async function catalogNumbersInArchive(db: Kysely<Database>, archivePath: string, workDir: string): Promise<Set<string>> {
  const st = await stat(archivePath);
  const key = `${st.size}:${st.mtimeMs}`;
  const kept = heldCache.get(archivePath);
  if (kept?.key === key) return kept.held;
  const flightKey = `${archivePath}:${key}`;
  const running = heldInFlight.get(flightKey);
  if (running !== undefined) return running;
  const job = (async () => {
    await unpacking.catch(() => undefined);
    const mine = (async () => {
      for (const leftover of await readdir(workDir)) if (/^upload-/.test(leftover)) await rm(join(workDir, leftover), { recursive: true, force: true });
      const files = unzipSync(new Uint8Array(await readFile(archivePath)), { filter: (f) => /^occurrences\.(tab|csv|txt)$/i.test(f.name) });
      const [name, data] = Object.entries(files)[0] ?? [];
      if (name === undefined || data === undefined) throw new Error(`${archivePath} has no occurrences file: it is not an Ecdysis archive`);
      const folder = await mkdtemp(join(workDir, "upload-"));
      try {
        const path = join(folder, name);
        await writeFile(path, data);
        const result = await sql<{ catalog_number: string }>`
          SELECT DISTINCT trim("catalogNumber") AS catalog_number
          FROM read_csv(${sql.lit(path)}, header = true, all_varchar = true)
          WHERE nullif(trim("catalogNumber"), '') IS NOT NULL`.execute(db);
        const held = new Set(result.rows.map((r) => catalogKey(r.catalog_number)));
        heldCache.set(archivePath, { key, held });
        return held;
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    })();
    unpacking = mine;
    return mine;
  })().finally(() => heldInFlight.delete(flightKey));
  heldInFlight.set(flightKey, job);
  return job;
}

// --- Which specimens ---------------------------------------------------------

/** A specimen that could be in a file, before the rules that need Ecdysis's catalog numbers. */
interface Candidate {
  specimen_id: number;
  field_number: string | null;
  year: number;
  /** The label number is on another specimen too: two records would get one catalog number. */
  label_number_shared: boolean;
  /** The label number is not digits only: a collector's name with a number, say. */
  label_not_digits: boolean;
  /** A disposition other than "in collection" is recorded: missing, or a remark that old Beeline recorded it twice. */
  disposition_held: boolean;
  /** The taxon is obscured or private (`sample.taxon_geoprivacy`). */
  taxon_obscured: boolean;
  /** The observer obscured or hid their own observation (`sample.geoprivacy`). */
  observer_obscured: boolean;
  country: string | null;
  state_province: string | null;
}

/** What the downloader chose about specimens whose coordinates are obscured: true coordinates go public in Ecdysis with them. */
export interface Include {
  taxonObscured: boolean;
  observerObscured: boolean;
}
export const INCLUDE_NONE: Include = { taxonObscured: false, observerObscured: false };

/** A specimen that passes every rule except the downloader's choice about obscured coordinates. */
export interface Eligible {
  id: number;
  taxonObscured: boolean;
  observerObscured: boolean;
}
export const included = (e: Pick<Eligible, "taxonObscured" | "observerObscured">, include: Include): boolean =>
  (!e.taxonObscured || include.taxonObscured) && (!e.observerObscured || include.observerObscured);

/** What the file for one collection year holds, and what was left out of it and why. */
export interface UploadYear {
  year: number;
  /** A file is offered for this year. */
  offered: boolean;
  /** Why not, for a year with specimens waiting: it is older than the seasons Beeline offers, or Ecdysis already holds specimens of the program from it. */
  notOffered: "older" | "held" | null;
  /** Every specimen that passes the rules, with whether each is obscured. */
  eligible: Eligible[];
  /** Counts of what was left out, each under a plain heading on the page. */
  taxonObscured: number;
  observerObscured: number;
  /** The label number is not digits only. Never shown, only counted. */
  labelNotDigits: number;
  /** A disposition other than "in collection". */
  dispositionHeld: number;
  /** The catalog number would be unusable in Ecdysis: shared with another specimen, or longer than Ecdysis allows. */
  unusable: number;
}

export const idsOf = (year: UploadYear, include: Include): number[] => year.eligible.filter((e) => included(e, include)).map((e) => e.id);

export interface UploadPlan {
  collection: EcdysisCollection;
  /** When Ecdysis was read. */
  readAt: Date;
  /** Newest year first. */
  years: UploadYear[];
  /** Country and state or province values that went out as the store has them, not spelled out. */
  unspelled: string[];
}

export const catalogNumberOf = (collection: EcdysisCollection, labelNumber: string): string => `${collection.catalogPrefix}${labelNumber}`;

/** The collection's program scope in the listings, or an error if the program has none. */
async function scopeOf(db: Kysely<Database>, collection: EcdysisCollection): Promise<string> {
  const program = (await programArchives(db)).find((p) => p.code === collection.program);
  if (program?.scope == null) throw new Error(`The program ${collection.program} has no specimens to select by`);
  return program.scope;
}

/**
 * The specimens that might go in a file, with what the rules need to know of
 * each. `query` is the Specimens listing's own filters; its scope, labels and
 * Ecdysis filters are replaced by this selection's own rules, since they are
 * the rules and not choices. The listing's own predicates are used, so "a
 * label on paper" and "has a catalog number from Ecdysis" mean here what they
 * mean on the Specimens page. `ids`, when given, asks about those specimens
 * only: the writers ask again about the rows they are about to write.
 */
async function candidatesOf(db: Kysely<Database>, scope: string, query: ListingQuery, ids?: readonly number[]): Promise<Candidate[]> {
  const asked = { ...query, scope, labels: "printed" as const, ecdysis: "not" as const };
  // The flag roll-up is joined only for a quality filter that reads it; the listing's own rule says which.
  const base = await filteredSpecimens(db, asked, 0, STAFF_READER, undefined, {}, needsRollup(asked), ids);
  const found = await base
    .select([
      "sp.entity_id as specimen_id",
      "sp.field_number",
      sql<number>`CAST(extract(year FROM s.date_start) AS INTEGER)`.as("year"),
      sql<boolean>`EXISTS (SELECT 1 FROM specimen twin WHERE twin.field_number = sp.field_number AND twin.entity_id <> sp.entity_id)`.as("label_number_shared"),
      sql<boolean>`NOT regexp_full_match(coalesce(sp.field_number, ''), '[0-9]+')`.as("label_not_digits"),
      sql<boolean>`EXISTS (SELECT 1 FROM specimen_disposition md WHERE md.specimen_id = sp.entity_id AND md.disposition IS DISTINCT FROM 'in collection')`.as("disposition_held"),
      // As the views read it: 'open' is a value, not a null.
      sql<boolean>`nullif(s.taxon_geoprivacy, 'open') IS NOT NULL`.as("taxon_obscured"),
      sql<boolean>`nullif(s.geoprivacy, 'open') IS NOT NULL`.as("observer_obscured"),
      "s.country",
      "s.state_province",
    ])
    .orderBy("sp.entity_id")
    .execute();
  return found as unknown as Candidate[];
}

/** What one candidate is to the rules: not a candidate at all, left out for a reason that is counted, or eligible. */
type Verdict = { kind: "skip" } | { kind: "left-out"; reason: "labelNotDigits" | "dispositionHeld" | "unusable" } | { kind: "eligible"; taxonObscured: boolean; observerObscured: boolean };

function judge(c: Candidate, collection: EcdysisCollection, held: ReadonlySet<string>): Verdict {
  // No label number: nothing to make a catalog number from.
  if (c.field_number === null || c.field_number === "") return { kind: "skip" };
  const catalogNumber = catalogNumberOf(collection, c.field_number);
  // Ecdysis already has it, matched to a specimen or not.
  if (held.has(catalogKey(catalogNumber))) return { kind: "skip" };
  if (c.label_not_digits) return { kind: "left-out", reason: "labelNotDigits" };
  if (c.label_number_shared || catalogNumber.length > CATALOG_NUMBER_LIMIT) return { kind: "left-out", reason: "unusable" };
  if (c.disposition_held) return { kind: "left-out", reason: "dispositionHeld" };
  return { kind: "eligible", taxonObscured: Boolean(c.taxon_obscured), observerObscured: Boolean(c.observer_obscured) };
}

/**
 * The seasons a file is offered for: the active seasons and the one that
 * settled most recently, by the store's own season line (schema/102). Older
 * years wait (Peter, 2026-11-20; GitHub #420 for Washington, beeline-2afe for
 * British Columbia).
 */
async function offeredSeasons(db: Kysely<Database>): Promise<{ from: number; to: number }> {
  const { rows } = await sql<{ current_season: number; first_active: number }>`
    SELECT current_season, CAST(extract(year FROM active_since) AS INTEGER) AS first_active FROM season`.execute(db);
  const season = rows[0]!;
  return { from: Number(season.first_active) - 1, to: Number(season.current_season) };
}

/** The years in which Ecdysis already holds a specimen of the program, as Beeline last read it. */
async function yearsEcdysisHolds(db: Kysely<Database>, collection: EcdysisCollection): Promise<Set<number>> {
  const { rows } = await sql<{ y: number }>`
    SELECT DISTINCT CAST(extract(year FROM s.date_start) AS INTEGER) AS y
    FROM specimen_catalog_number c
    JOIN specimen sp ON sp.entity_id = c.specimen_id
    JOIN sample s ON s.entity_id = sp.sample_id
    JOIN sample_atlas sa ON sa.sample_id = s.entity_id
    JOIN program p ON p.entity_id = sa.atlas_id
    WHERE p.code = ${collection.program}`.execute(db);
  return new Set(rows.map((r) => Number(r.y)));
}

/** What goes in the file for each year of the collection, and what does not and why. */
export async function planUpload(
  db: Kysely<Database>,
  collection: EcdysisCollection,
  read: { readAt: Date; held: ReadonlySet<string> },
  query: ListingQuery = EMPTY_QUERY,
): Promise<UploadPlan> {
  const scope = await scopeOf(db, collection);
  const [found, seasons, holds] = await Promise.all([candidatesOf(db, scope, query), offeredSeasons(db), yearsEcdysisHolds(db, collection)]);
  const byYear = new Map<number, UploadYear>();
  const unspelled = new Set<string>();
  for (const c of found) {
    const verdict = judge(c, collection, read.held);
    if (verdict.kind === "skip") continue;
    const year = Number(c.year);
    const entry =
      byYear.get(year) ??
      ({ year, offered: false, notOffered: null, eligible: [], taxonObscured: 0, observerObscured: 0, labelNotDigits: 0, dispositionHeld: 0, unusable: 0 } satisfies UploadYear);
    byYear.set(year, entry);
    if (verdict.kind === "left-out") {
      entry[verdict.reason]++;
      continue;
    }
    entry.eligible.push({ id: Number(c.specimen_id), taxonObscured: verdict.taxonObscured, observerObscured: verdict.observerObscured });
    if (verdict.taxonObscured) entry.taxonObscured++;
    if (verdict.observerObscured) entry.observerObscured++;
    if (c.country !== null && COUNTRY_NAMES[c.country] === undefined) unspelled.add(c.country);
    if (c.state_province !== null && STATE_NAMES[c.state_province] === undefined) unspelled.add(c.state_province);
  }
  for (const y of byYear.values()) {
    y.notOffered = y.year < seasons.from || y.year > seasons.to ? "older" : holds.has(y.year) ? "held" : null;
    y.offered = y.notOffered === null;
  }
  return { collection, readAt: read.readAt, years: [...byYear.values()].sort((a, b) => b.year - a.year), unspelled: [...unspelled].sort() };
}

/**
 * Which of these specimens may still go in a file, asked again as the rows are
 * written: a specimen can become obscured, marked missing or held in Ecdysis
 * between the plan and the file, and nothing may go that the rules now refuse.
 * Returned in id order.
 */
export async function eligibleNow(
  db: Kysely<Database>,
  collection: EcdysisCollection,
  ids: readonly number[],
  rules: { held: ReadonlySet<string>; include: Include },
): Promise<number[]> {
  if (ids.length === 0) return [];
  const found = await candidatesOf(db, await scopeOf(db, collection), EMPTY_QUERY, ids);
  const out: number[] = [];
  for (const c of found) {
    const verdict = judge(c, collection, rules.held);
    if (verdict.kind === "eligible" && included(verdict, rules.include)) out.push(Number(c.specimen_id));
  }
  return out;
}

/** What a download is for: the rules both the plan and the writers apply. */
export interface UploadRules {
  held: ReadonlySet<string>;
  include: Include;
}

// --- Downloads, recorded -----------------------------------------------------

/** A recorded download of an archive. */
export interface DownloadRecord {
  collection: string;
  year: number;
  filters: string;
  include: Include;
  specimens: number;
  readAt: Date;
  personId: number | null;
  /** Who, by name, where the person is known. */
  by: string | null;
  at: Date;
}

/** The latest recorded download of an archive for the collection, with who took it. */
export async function latestDownload(db: Kysely<Database>, collection: EcdysisCollection): Promise<DownloadRecord | null> {
  const row = await db
    .selectFrom("ecdysis_upload_download as d")
    .leftJoin("person as p", "p.entity_id", "d.person_id")
    .where("d.collection", "=", collection.program)
    .orderBy("d.entity_id", "desc")
    .limit(1)
    .select(["d.collection", "d.year", "d.filters", "d.include_taxon_obscured", "d.include_observer_obscured", "d.specimens", "d.read_at", "d.person_id", "p.display_name", "d.downloaded_at"])
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    collection: row.collection,
    year: Number(row.year),
    filters: row.filters,
    include: { taxonObscured: Boolean(row.include_taxon_obscured), observerObscured: Boolean(row.include_observer_obscured) },
    specimens: Number(row.specimens),
    readAt: new Date(row.read_at as unknown as string | Date),
    personId: row.person_id === null ? null : Number(row.person_id),
    by: row.display_name,
    at: new Date(row.downloaded_at as unknown as string | Date),
  };
}

/** Writes the record of a download that finished. */
export async function recordDownload(
  db: Kysely<Database>,
  d: { collection: EcdysisCollection; year: number; filters: string; include: Include; specimens: number; readAt: Date; personId: number | null },
): Promise<void> {
  await db
    .insertInto("ecdysis_upload_download")
    .values({
      collection: d.collection.program,
      year: d.year,
      filters: d.filters,
      include_taxon_obscured: d.include.taxonObscured,
      include_observer_obscured: d.include.observerObscured,
      specimens: d.specimens,
      read_at: d.readAt.toISOString(),
      person_id: d.personId,
    })
    .execute();
}

const downloadsInFlight = new Set<string>();

/** Claims a collection's archive for one download at a time; false when another is being written now. */
export const claimDownload = (collection: EcdysisCollection): boolean => {
  if (downloadsInFlight.has(collection.program)) return false;
  downloadsInFlight.add(collection.program);
  return true;
};
export const releaseDownload = (collection: EcdysisCollection): void => void downloadsInFlight.delete(collection.program);

/**
 * The stream, with `onComplete` run when the last byte has been handed on and
 * `release` run however it ends. A download the person abandons (the stream is
 * cancelled) or one that fails calls only `release`, so nothing is recorded for
 * it: a partial zip is not a file anyone can upload, and the person may ask
 * again. A download is recorded when the server has written the whole file,
 * which is the nearest it can know; the browser may still be receiving the
 * last of it.
 */
export function recordWhenComplete(source: ReadableStream<Uint8Array>, onComplete: () => Promise<void>, release: () => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await onComplete();
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
}

// --- The state of a collection -----------------------------------------------

/** What the Exports page and the files' routes ask: the plan for a collection, or why there is none. */
export type UploadState =
  | { ok: true; plan: UploadPlan; read: Extract<EcdysisRead, { ok: true }>; held: ReadonlySet<string>; download: DownloadRecord | null }
  | ({ ok: false } & UploadRefusal);

/** How many catalog numbers Beeline has recorded from Ecdysis for the collection's specimens, which an archive must at least hold. */
async function recordedCatalogNumbers(db: Kysely<Database>, collection: EcdysisCollection): Promise<number> {
  const { rows } = await sql<{ n: number | bigint }>`
    SELECT count(DISTINCT lower(catalog_number)) AS n FROM specimen_catalog_number
    WHERE starts_with(lower(catalog_number), ${collection.catalogPrefix.toLowerCase()})`.execute(db);
  return Number(rows[0]!.n);
}

/** The read of Ecdysis, then the plan built from it, and the download recorded since: one question, answered the same on the page and in the routes. */
export async function uploadStateOf(
  db: Kysely<Database>,
  collection: EcdysisCollection,
  opts: { ecdysisDir: string; now?: Date; query?: ListingQuery },
): Promise<UploadState> {
  const read = await ecdysisRead(collection, opts);
  if (!read.ok) return read;
  let held: Set<string>;
  try {
    held = await catalogNumbersInArchive(db, read.archivePath, opts.ecdysisDir);
  } catch (err) {
    console.error(`The cached Ecdysis archive for ${collection.program} could not be read: ${(err as Error).message}`);
    return { ok: false, reason: "unreadable", readAt: read.readAt };
  }
  // An archive with fewer catalog numbers than Beeline has recorded from Ecdysis is not the whole of what Ecdysis held.
  if (held.size < (await recordedCatalogNumbers(db, collection))) return { ok: false, reason: "incomplete", readAt: read.readAt };
  const latest = await latestDownload(db, collection);
  return {
    ok: true,
    plan: await planUpload(db, collection, { readAt: read.readAt, held }, opts.query),
    read,
    held,
    download: latest !== null && latest.at.getTime() > read.readAt.getTime() ? latest : null,
  };
}

// --- The archive ---------------------------------------------------------------

/**
 * occurrence.txt's columns after the id, each with the term meta.xml gives it
 * and the Symbiota field it lands in (checked against Symbiota's source and by
 * importing the archive; the table is in
 * docs/architecture/the-upload-to-ecdysis.md). Constants are real columns, not
 * `default` attributes in meta.xml, because whether Symbiota honours a default
 * has not been tested. The fixed values are each collection's own
 * (`UPLOAD_CONSTANTS`), and `labelProject` is a column only for a collection
 * that declares one. Beeline's own undeclared columns are left out: this file
 * is for a machine. There is no occurrenceID: Washington's collection makes
 * its own and ignores an uploaded one.
 */
const OCCURRENCE_COLUMNS = [
  ["catalogNumber", `${DWC}catalogNumber`],
  ["basisOfRecord", `${DWC}basisOfRecord`],
  ["fieldNumber", `${DWC}fieldNumber`],
  ["recordNumber", `${DWC}recordNumber`],
  ["eventDate", `${DWC}eventDate`],
  // Symbiota keeps only the first day of a range in eventDate and reads the end from its own term.
  ["eventDate2", `${SYMBIOTA}eventDate2`],
  ["samplingProtocol", `${DWC}samplingProtocol`],
  ["recordedBy", `${DWC}recordedBy`],
  ["country", `${DWC}country`],
  ["stateProvince", `${DWC}stateProvince`],
  ["county", `${DWC}county`],
  ["locality", `${DWC}locality`],
  // Ecdysis has no verbatimLocality, so Washington keeps the label's text here (ecdysis-upload-files.md, row 15).
  ["verbatimCoordinates", `${DWC}verbatimCoordinates`],
  ["decimalLatitude", `${DWC}decimalLatitude`],
  ["decimalLongitude", `${DWC}decimalLongitude`],
  ["geodeticDatum", `${DWC}geodeticDatum`],
  ["coordinateUncertaintyInMeters", `${DWC}coordinateUncertaintyInMeters`],
  ["minimumElevationInMeters", `${DWC}minimumElevationInMeters`],
  ["lifeStage", `${DWC}lifeStage`],
  ["preparations", `${DWC}preparations`],
  ["individualCount", `${DWC}individualCount`],
  ["associatedTaxa", `${DWC}associatedTaxa`],
  ["disposition", `${DWC}disposition`],
  ["occurrenceRemarks", `${DWC}occurrenceRemarks`],
  // Only where the determination of record is an expert's.
  ["scientificName", `${DWC}scientificName`],
  ["scientificNameAuthorship", `${DWC}scientificNameAuthorship`],
  ["identificationQualifier", `${DWC}identificationQualifier`],
  ["identifiedBy", `${DWC}identifiedBy`],
  ["dateIdentified", `${DWC}dateIdentified`],
  ["sex", `${DWC}sex`],
  // Symbiota has no caste column; British Columbia already keeps it here.
  ["reproductiveCondition", `${DWC}reproductiveCondition`],
] as const satisfies readonly (readonly [string, string])[];

/** The label project column, which only a collection that declares one writes. Symbiota's own column, by name. */
const LABEL_PROJECT = ["labelProject", `${SYMBIOTA}labelProject`] as const;

/** The occurrence columns of a collection's archive, with the term of each. */
export const uploadOccurrenceColumns = (collection: EcdysisCollection): readonly (readonly [string, string])[] =>
  constantsOf(collection).labelProject === undefined ? OCCURRENCE_COLUMNS : [...OCCURRENCE_COLUMNS, LABEL_PROJECT];

/**
 * identification.txt's columns after the specimen's id. `identificationIsCurrent`
 * is Symbiota's own term. `sourceIdentifier` is the header Symbiota's importer
 * maps to the identification's `sourceIdentifier` column: an identification
 * already on the record with the same one is updated in place, not added again
 * (SpecUploadBase.php 1405-1418). Darwin Core's own `identificationID` would be
 * the better term, but the importer does not map it.
 */
export const UPLOAD_IDENTIFICATION_COLUMNS = [
  ["scientificName", `${DWC}scientificName`],
  ["scientificNameAuthorship", `${DWC}scientificNameAuthorship`],
  ["identificationQualifier", `${DWC}identificationQualifier`],
  ["identifiedBy", `${DWC}identifiedBy`],
  ["dateIdentified", `${DWC}dateIdentified`],
  ["identificationIsCurrent", `${SYMBIOTA}identificationIsCurrent`],
  ["sourceIdentifier", `${SYMBIOTA}sourceIdentifier`],
] as const satisfies readonly (readonly [string, string])[];

/** One occurrence row, starting with the specimen's id; the cells follow `uploadOccurrenceColumns`. */
export function uploadOccurrenceRow(r: SpecimenRow, page: ArchivePage, collection: EcdysisCollection): unknown[] {
  const cell = csvCellsOf(r, page);
  const fixed = constantsOf(collection);
  // The determination of record names the specimen only where it is an expert's. A volunteer's goes as history
  // alone, so that Ecdysis's own experts are the ones who name a new record.
  const expert = r.determination_id !== null && r.is_expert === true;
  const own: Record<string, unknown> = {
    catalogNumber: r.field_number === null ? null : catalogNumberOf(collection, r.field_number),
    basisOfRecord: "PreservedSpecimen",
    fieldNumber: r.sample_number,
    recordNumber: `${r.sample_number}.${r.specimen_number}`,
    // The first day only; the last day has its own column.
    eventDate: isoDate(r.date_start),
    eventDate2: isoDate(r.date_end) === isoDate(r.date_start) ? null : isoDate(r.date_end),
    samplingProtocol: cell("samplingProtocol"),
    recordedBy: cell("recordedBy"),
    country: r.country === null ? null : (COUNTRY_NAMES[r.country] ?? r.country),
    stateProvince: r.state_province === null ? null : (STATE_NAMES[r.state_province] ?? r.state_province),
    county: cell("county"),
    locality: cell("locality"),
    verbatimCoordinates: cell("locality"),
    decimalLatitude: cell("decimalLatitude"),
    decimalLongitude: cell("decimalLongitude"),
    geodeticDatum: cell("geodeticDatum"),
    coordinateUncertaintyInMeters: cell("coordinateUncertaintyInMeters"),
    minimumElevationInMeters: cell("minimumElevationInMeters"),
    lifeStage: fixed.lifeStage,
    preparations: fixed.preparations,
    individualCount: fixed.individualCount,
    associatedTaxa: cell("associatedTaxa"),
    disposition: cell("disposition"),
    occurrenceRemarks: cell("occurrenceRemarks"),
    scientificName: expert ? r.scientific_name : null,
    scientificNameAuthorship: expert ? r.authorship : null,
    identificationQualifier: expert ? r.qualifier : null,
    identifiedBy: expert ? r.determiner : null,
    dateIdentified: expert ? dateIdentified(r.determined_on, r.determined_on_precision) : null,
    sex: expert ? r.sex : null,
    reproductiveCondition: expert ? r.caste : null,
    labelProject: fixed.labelProject,
  };
  return [r.specimen_id, ...uploadOccurrenceColumns(collection).map(([header]) => own[header])];
}

/**
 * How Symbiota compares two cells of its unique key: without regard to case or
 * accents, with runs of white space as one (its columns are `utf8_general_ci`
 * and it collapses white space on the way in), so "Pérez  Cruz" and "perez cruz"
 * are one determiner.
 */
export const symbiotaKey = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The identification rows of a page: every determination of each specimen,
 * as history, current only on the determination of record when an expert made
 * it. Symbiota keeps one row for each (record, date identified, identified by,
 * scientific name) and silently drops the second of two that agree, whatever
 * their flags, so determinations of one specimen that have the same name,
 * determiner and date (or the lack of one) by `symbiotaKey` are written as one,
 * current if any of them is, with the current one's other cells and id.
 */
export function uploadIdentificationRows(identifications: readonly IdentificationRow[]): unknown[][] {
  const merged = new Map<string, { row: IdentificationRow; current: boolean }>();
  for (const d of identifications) {
    const key = [d.specimen_id, d.scientific_name, d.determiner ?? "", dateIdentified(d.determined_on, d.determined_on_precision) ?? ""]
      .map((part) => symbiotaKey(String(part)))
      .join("\u0000");
    const current = d.of_record && d.is_expert;
    const seen = merged.get(key);
    if (seen === undefined) merged.set(key, { row: d, current });
    else if (current && !seen.current) merged.set(key, { row: d, current });
  }
  return [...merged.values()].map(({ row: d, current }) => [
    d.specimen_id,
    d.scientific_name,
    d.authorship,
    d.qualifier,
    d.determiner,
    dateIdentified(d.determined_on, d.determined_on_precision),
    current ? 1 : 0,
    d.determination_id,
  ]);
}

/** The upload archive's layout for a collection. */
export function uploadArchiveLayout(collection: EcdysisCollection): ArchiveLayout {
  const columns = uploadOccurrenceColumns(collection);
  return {
    meta: archiveDescriptor(
      columns.map(([, term]) => term),
      UPLOAD_IDENTIFICATION_COLUMNS.map(([, term]) => term),
    ),
    occurrenceHeader: ["id", ...columns.map(([header]) => header)],
    occurrenceRows: (page) => page.rows.map((r) => uploadOccurrenceRow(r, page, collection)),
    identificationHeader: ["coreid", ...UPLOAD_IDENTIFICATION_COLUMNS.map(([header]) => header)],
    identificationRows: (page) => uploadIdentificationRows(page.identifications),
  };
}

/**
 * The upload archive of these specimens, streamed a page of them at a time.
 * Each page asks again which of its specimens the rules still allow
 * (`eligibleNow`) and reads the specimens and their identifications in one
 * transaction, so a page is one moment of the store and a specimen that has
 * become obscured, marked missing or held in Ecdysis since the plan is not
 * written. The stream is told it has ended by the page's `last`, since a page
 * can be short of a full one without being the last.
 */
export function uploadArchiveStream(
  db: Kysely<Database>,
  collection: EcdysisCollection,
  specimenIds: readonly number[],
  rules: UploadRules,
  timing?: CsvTiming,
): ReadableStream<Uint8Array> {
  const hostNames = hostNamesOnce(db);
  let cursor = 0;
  return specimenArchiveStream(
    async (limit) => {
      const slice = specimenIds.slice(cursor, cursor + limit);
      cursor += slice.length;
      const names = await hostNames();
      const page = await db.transaction().execute(async (trx) => {
        const ids = await eligibleNow(trx, collection, slice, rules);
        const listed = await listSpecimens(trx, { ...EMPTY_QUERY, scope: ALL }, 0, STAFF_READER, {
          ids,
          limit: ids.length,
          offset: 0,
          withTotal: false,
          hostNames: names,
        });
        return { ...listed, identifications: await identificationsOf(trx, listed.rows.map((r) => r.specimen_id)) };
      });
      return { ...page, last: cursor >= specimenIds.length };
    },
    { layout: uploadArchiveLayout(collection), timing },
  );
}

// --- The associations file -----------------------------------------------------

/**
 * The headers Symbiota's "Import extended data" page maps by name for an
 * external link: the subject by catalog number, the iNaturalist observation as
 * the resource's address, and the host plant as a name (OccurrenceImport.php
 * 440-485). There is no objectID, so Symbiota's own export gives the address
 * as the related resource, and no occurrenceID, so the subject is found by
 * catalog number alone.
 */
export const ASSOCIATION_HEADER = ["subject identifier: catalogNumber", "resourceUrl", "verbatimSciname"] as const;

export const observationUrl = (observationId: number | bigint): string => `https://www.inaturalist.org/observations/${observationId}`;

const ASSOCIATION_PAGE = 5_000;

/**
 * The associations file for these specimens: one row for each whose sample has
 * an iNaturalist observation that still exists. The host is named as the
 * observation named it, at whatever rank Beeline holds, as `associatedTaxa`
 * does, and left empty where there is none, and where the sample's method names
 * a trap: the plant near a trap is not a host (`plantRelationship` makes the
 * same distinction, "near" and not "visits flowers of"). The rules are applied
 * again as the rows are read, in one transaction, as the archive's are.
 * UTF-8 with no byte order mark and no formula guard. The program's CSV
 * downloads have both for the sake of spreadsheets; this file is read by
 * Symbiota, which loaded it the same with and without a mark (tried
 * 2026-11-20), so the headers are left as exact bytes, and a guard would write
 * an apostrophe into a name that begins with `-`, `=`, `+` or `@`.
 */
export async function associationsCsv(
  db: Kysely<Database>,
  collection: EcdysisCollection,
  specimenIds: readonly number[],
  rules: UploadRules,
): Promise<string> {
  const lines = [csvExactLine(ASSOCIATION_HEADER)];
  await db.transaction().execute(async (trx) => {
    for (let from = 0; from < specimenIds.length; from += ASSOCIATION_PAGE) {
      const ids = await eligibleNow(trx, collection, specimenIds.slice(from, from + ASSOCIATION_PAGE), rules);
      if (ids.length === 0) continue;
      const found = await trx
        .selectFrom("specimen as sp")
        .innerJoin("sample as s", "s.entity_id", "sp.sample_id")
        .where("sp.entity_id", "in", ids)
        .where("s.inat_observation_id", "is not", null)
        .where(sql<boolean>`NOT ${observationGone}`)
        .select(["sp.entity_id as specimen_id", "sp.field_number", "s.inat_observation_id", "s.host_name_as_observed", "s.protocol"])
        .orderBy("sp.entity_id")
        .execute();
      for (const r of found) {
        if (r.field_number === null || r.inat_observation_id === null) continue;
        const host = methodNamesTrap(r.protocol) ? null : r.host_name_as_observed;
        lines.push(csvExactLine([catalogNumberOf(collection, r.field_number), observationUrl(r.inat_observation_id), host]));
      }
    }
  });
  return lines.join("");
}

// --- File names -------------------------------------------------------------

/**
 * `ecdysis-upload-BC-2026-8100-specimens-2026-11-21-120507.zip`: the
 * collection's program, the collection year, how many specimens, then the day
 * and time written, Pacific, as every download's name is stamped
 * (`exportFilename`). The stamp lets whoever uploads see that a file is from
 * today, and the count is the one the pre-transfer report must show as new.
 */
export const uploadFileName = (collection: EcdysisCollection, year: number, written: Date, kind: "archive" | "associations", specimens: number): string =>
  exportFilename(`ecdysis-${kind === "archive" ? "upload" : "associations"}-${collection.program}-${year}-${specimens}-specimens`, written, kind === "archive" ? "zip" : "csv");

/** Where a file is served: `/exports/ecdysis/BC-2026-upload.zip`; the download is given its own, stamped, name in the response. */
export const ecdysisFileHref = (collection: EcdysisCollection, year: number, kind: "archive" | "associations"): string =>
  `/exports/ecdysis/${collection.program}-${year}-${kind === "archive" ? "upload.zip" : "associations.csv"}`;

export const collectionOf = (program: string): EcdysisCollection | undefined => ECDYSIS_COLLECTIONS.find((c) => c.program === program);
