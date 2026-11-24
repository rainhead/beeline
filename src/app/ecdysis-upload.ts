import { mkdtemp, readdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { programDataHref } from "./programs.js";
import { cachedArchivePath, ECDYSIS_COLLECTIONS, readMarkerOf, type EcdysisCollection, type ReadMarker } from "../fetch-ecdysis.js";
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
  observationGone,
  STAFF_READER,
  type SpecimenRow,
} from "./listings.js";
import type { CsvTiming } from "./request-timing.js";

/**
 * The two files a person uploads to Ecdysis by hand (beeline-8dx9.12, Peter,
 * 2026-11-20): a Darwin Core archive of the specimens Ecdysis does not hold,
 * and a CSV of associations (the iNaturalist observation and the host plant)
 * for Symbiota's "Extended Data Import" page. What Symbiota does with them is
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
 *   plant the bee was collected from nor the observer's own observation is
 *   obscured on iNaturalist (the judgment is the taxonomist's, made before
 *   upload: Peter, 2026-10-23), and whose sample's
 *   geoprivacy flags are not out of date.
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
  /**
   * The collection years a file is offered for: a setting, in code, and not a
   * rule worked out from the store. British Columbia offers 2026 only, by
   * Peter's decision (2026-11-21): its older years wait on beeline-2afe, and
   * adding a year is a change here, made when that is settled. A year that has
   * specimens waiting and is not listed is shown on the page as not offered.
   */
  years: number[];
}
export const UPLOAD_CONSTANTS: Record<string, CollectionConstants> = {
  // Washington is read as a dataset, so no file is offered for it yet (see readsWholeCollection); its years wait on GitHub #420.
  WaBA: { lifeStage: "adult", preparations: "pinned", individualCount: 1, labelProject: "Washington Bee Atlas", years: [] },
  BC: { lifeStage: "adult", preparations: "pinned", individualCount: 1, years: [2026] },
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
  /** The last read reloaded the archive Beeline kept because the probe said nothing moved, and did not download one. */
  | { reason: "reloaded"; readAt: Date }
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
  // The probe's "nothing moved" counts records and records modified since the last download, so a second change to
  // a record already modified leaves both as they were. A file made from a reloaded archive could rest on a stale
  // copy; one made from a download rests on what Ecdysis said at the read.
  if (marker.source !== "downloaded") return { ok: false, reason: "reloaded", readAt };
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

/** The cached archive was replaced while it was being read, or is not the file the read marker describes. */
export class ArchiveChanged extends Error {
  constructor(path: string) {
    super(`${path} is not the file the last read loaded, or changed while it was read`);
  }
}

/** What the cached archive holds: its distinct catalog numbers, and how many occurrence rows it has. */
export interface ArchiveContents {
  held: Set<string>;
  rows: number;
}

const heldCache = new Map<string, { key: string; contents: ArchiveContents }>();
/** An unpack in progress, by archive, so two first views share one. */
const heldInFlight = new Map<string, Promise<ArchiveContents>>();
/** The unpack most recently asked for, whatever it is for. */
let unpacking: Promise<unknown> = Promise.resolve();

/**
 * Every catalog number in the archive Beeline last downloaded from Ecdysis,
 * the ones it matched to a specimen and the ones it could not, and the number
 * of its rows. The store keeps only the matched ones (`specimen_catalog_number`:
 * the loader counts the rest and keeps five as a sample), so the archive itself
 * is read, with DuckDB as the loader reads it. It is unpacked into a folder of
 * its own under `workDir`, which the store may read (`storeFiles`), and
 * removed; folders left by an unpack that was cut short are removed first.
 * Unpacks run one at a time: each is chained, when it is asked for, onto the
 * one before it, so clearing the leftovers of an earlier one can never clear a
 * folder another is using. Read once per download: the result is kept while the
 * file's size and time stay the same, and two requests that arrive together
 * share one unpack.
 */
export async function catalogNumbersInArchive(
  db: Kysely<Database>,
  archivePath: string,
  workDir: string,
  expected?: { bytes: number; modifiedAt: string },
): Promise<ArchiveContents> {
  const st = await stat(archivePath);
  // The file must be the marker's before a kept or in-flight answer is returned, as well as around a fresh read.
  if (expected !== undefined && (st.size !== expected.bytes || st.mtime.toISOString() !== expected.modifiedAt)) throw new ArchiveChanged(archivePath);
  const key = `${st.size}:${st.mtimeMs}`;
  const kept = heldCache.get(archivePath);
  if (kept?.key === key) return kept.contents;
  const flightKey = `${archivePath}:${key}`;
  const running = heldInFlight.get(flightKey);
  if (running !== undefined) return running;
  /** The file's size and time now, which must be the marker's both before the bytes are read and after. */
  const matches = async () => {
    if (expected === undefined) return true;
    const now = await stat(archivePath);
    return now.size === expected.bytes && now.mtime.toISOString() === expected.modifiedAt;
  };
  const unpack = async (): Promise<ArchiveContents> => {
    if (!(await matches())) throw new ArchiveChanged(archivePath);
    for (const leftover of await readdir(workDir)) if (/^upload-/.test(leftover)) await rm(join(workDir, leftover), { recursive: true, force: true });
    const bytes = new Uint8Array(await readFile(archivePath));
    if (!(await matches())) throw new ArchiveChanged(archivePath);
    const files = unzipSync(bytes, { filter: (f) => /^occurrences\.(tab|csv|txt)$/i.test(f.name) });
    const [name, data] = Object.entries(files)[0] ?? [];
    if (name === undefined || data === undefined) throw new Error(`${archivePath} has no occurrences file: it is not an Ecdysis archive`);
    const folder = await mkdtemp(join(workDir, "upload-"));
    try {
      const path = join(folder, name);
      await writeFile(path, data);
      const result = await sql<{ catalog_number: string | null; rows: number | bigint }>`
        SELECT nullif(trim("catalogNumber"), '') AS catalog_number, count(*) OVER () AS rows
        FROM read_csv(${sql.lit(path)}, header = true, all_varchar = true)`.execute(db);
      const contents = {
        held: new Set(result.rows.flatMap((r) => (r.catalog_number === null ? [] : [catalogKey(r.catalog_number)]))),
        rows: result.rows.length === 0 ? 0 : Number(result.rows[0]!.rows),
      };
      heldCache.set(archivePath, { key, contents });
      return contents;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };
  // Chained now, before anything is awaited, so the next call sees this one.
  const job = unpacking.catch(() => undefined).then(unpack).finally(() => heldInFlight.delete(flightKey));
  unpacking = job;
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
  /** The sample's copy of its observation's geoprivacy disagrees with the observation's (`sample_geoprivacy_stale`): which flags are true is not known. */
  geoprivacy_stale: boolean;
  /** The specimen was collected from a plant whose location iNaturalist obscures (a protected plant; `sample.taxon_geoprivacy`): the observation is of the plant the bee was collected from, and iNaturalist obscures or hides where that plant is. */
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
/** A specimen as an archive wrote it: its id and the catalog number it was written under. */
export interface WrittenSpecimen {
  id: number;
  catalogNumber: string;
}

export const included = (e: Pick<Eligible, "taxonObscured" | "observerObscured">, include: Include): boolean =>
  (!e.taxonObscured || include.taxonObscured) && (!e.observerObscured || include.observerObscured);

/** What the file for one collection year holds, and what was left out of it and why. */
export interface UploadYear {
  year: number;
  /** A file is offered for this year: it is one of the collection's `years`. */
  offered: boolean;
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
  /** The sample's geoprivacy flags are out of date with its observation's, so whether it is obscured is not known. */
  geoprivacyStale: number;
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
async function candidatesOf(db: Kysely<Database>, scope: string, ids?: readonly number[]): Promise<Candidate[]> {
  const asked = { ...EMPTY_QUERY, scope, labels: "printed" as const, ecdysis: "not" as const };
  // No quality filter is asked, so the flag roll-up is not joined.
  const base = await filteredSpecimens(db, asked, 0, STAFF_READER, undefined, {}, false, ids);
  const found = await base
    .select([
      "sp.entity_id as specimen_id",
      "sp.field_number",
      sql<number>`CAST(extract(year FROM s.date_start) AS INTEGER)`.as("year"),
      sql<boolean>`EXISTS (SELECT 1 FROM specimen twin WHERE twin.field_number = sp.field_number AND twin.entity_id <> sp.entity_id)`.as("label_number_shared"),
      sql<boolean>`NOT regexp_full_match(coalesce(sp.field_number, ''), '[0-9]+')`.as("label_not_digits"),
      sql<boolean>`EXISTS (SELECT 1 FROM specimen_disposition md WHERE md.specimen_id = sp.entity_id AND md.disposition IS DISTINCT FROM 'in collection')`.as("disposition_held"),
      sql<boolean>`EXISTS (SELECT 1 FROM sample_geoprivacy_stale gs WHERE gs.sample_id = s.entity_id)`.as("geoprivacy_stale"),
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
type Verdict = { kind: "skip" } | { kind: "left-out"; reason: "labelNotDigits" | "dispositionHeld" | "unusable" | "geoprivacyStale" } | { kind: "eligible"; taxonObscured: boolean; observerObscured: boolean };

function judge(c: Candidate, collection: EcdysisCollection, held: ReadonlySet<string>): Verdict {
  // No label number: nothing to make a catalog number from.
  if (c.field_number === null || c.field_number === "") return { kind: "skip" };
  const catalogNumber = catalogNumberOf(collection, c.field_number);
  // Ecdysis already has it, matched to a specimen or not.
  if (held.has(catalogKey(catalogNumber))) return { kind: "skip" };
  if (c.label_not_digits) return { kind: "left-out", reason: "labelNotDigits" };
  if (c.label_number_shared || catalogNumber.length > CATALOG_NUMBER_LIMIT) return { kind: "left-out", reason: "unusable" };
  if (c.disposition_held) return { kind: "left-out", reason: "dispositionHeld" };
  // Whether the coordinates are obscured is not settled, so the downloader's choice about them cannot be applied.
  if (c.geoprivacy_stale) return { kind: "left-out", reason: "geoprivacyStale" };
  return { kind: "eligible", taxonObscured: Boolean(c.taxon_obscured), observerObscured: Boolean(c.observer_obscured) };
}

/**
 * What goes in the file for each year of the collection, and what does not and
 * why. A specimen is eligible on its own account: the rules above, and nothing
 * about its year or about what else of that year Ecdysis holds. Which years are
 * offered is the collection's setting (`UploadYear.offered`).
 */
export async function planUpload(
  db: Kysely<Database>,
  collection: EcdysisCollection,
  read: { readAt: Date; held: ReadonlySet<string> },
): Promise<UploadPlan> {
  const scope = await scopeOf(db, collection);
  const found = await candidatesOf(db, scope);
  const offeredYears = constantsOf(collection).years;
  const byYear = new Map<number, UploadYear>();
  const unspelled = new Set<string>();
  for (const c of found) {
    const verdict = judge(c, collection, read.held);
    if (verdict.kind === "skip") continue;
    const year = Number(c.year);
    const entry =
      byYear.get(year) ??
      ({ year, offered: offeredYears.includes(year), eligible: [], taxonObscured: 0, observerObscured: 0, labelNotDigits: 0, dispositionHeld: 0, unusable: 0, geoprivacyStale: 0 } satisfies UploadYear);
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
  return { collection, readAt: read.readAt, years: [...byYear.values()].sort((a, b) => b.year - a.year), unspelled: [...unspelled].sort() };
}

/**
 * Which of these specimens may still go in a file, asked again as the rows are
 * written: a specimen can become obscured, marked missing or held in Ecdysis
 * between the plan and the file, and nothing may go that the rules now refuse.
 * Returned in id order.
 */
export async function eligibleNow(db: Kysely<Database>, collection: EcdysisCollection, ids: readonly number[], rules: UploadRules): Promise<number[]> {
  if (ids.length === 0) return [];
  // The year is asked again too: a sample whose date was corrected to another year since the plan belongs to
  // another year's archive.
  const found = await candidatesOf(db, await scopeOf(db, collection), ids);
  const out: number[] = [];
  for (const c of found) {
    if (rules.year !== undefined && Number(c.year) !== rules.year) continue;
    const verdict = judge(c, collection, rules.held);
    if (verdict.kind === "eligible" && included(verdict, rules.include)) out.push(Number(c.specimen_id));
  }
  return out;
}

/** What a download is for: the rules both the plan and the writers apply. */
export interface UploadRules {
  held: ReadonlySet<string>;
  include: Include;
  /** The collection year the archive is for, asked again as each page is written. */
  year?: number;
}

// --- Downloads, recorded -----------------------------------------------------

/** How long a download that has not finished is taken to be still being written. */
export const BEING_WRITTEN_MINUTES = 15;

/** A recorded download of an archive. */
export interface DownloadRecord {
  id: number;
  collection: string;
  year: number;
  include: Include;
  planned: number;
  readAt: Date;
  personId: number | null;
  /** Who, by name, where the person is known. */
  by: string | null;
  startedAt: Date;
  /** Null for a download that has not finished: being written, abandoned or failed. */
  completedAt: Date | null;
  /** How many specimens it held, once it has finished. */
  specimens: number | null;
}

const asDate = (value: unknown): Date => new Date(value as string | Date);

const selectDownloads = (db: Kysely<Database>) =>
  db
    .selectFrom("ecdysis_upload_download as d")
    .leftJoin("ecdysis_upload_download_completed as c", "c.download_id", "d.entity_id")
    .leftJoin("person as p", "p.entity_id", "d.person_id")
    .select([
      "d.entity_id",
      "d.collection",
      "d.year",
      "d.include_taxon_obscured",
      "d.include_observer_obscured",
      "d.planned_specimens",
      "d.read_at",
      "d.person_id",
      "p.display_name",
      "d.started_at",
      "c.completed_at",
      "c.specimens",
    ]);

const toRecord = (r: Awaited<ReturnType<ReturnType<typeof selectDownloads>["execute"]>>[number]): DownloadRecord => ({
  id: Number(r.entity_id),
  collection: r.collection,
  year: Number(r.year),
  include: { taxonObscured: Boolean(r.include_taxon_obscured), observerObscured: Boolean(r.include_observer_obscured) },
  planned: Number(r.planned_specimens),
  readAt: asDate(r.read_at),
  personId: r.person_id === null ? null : Number(r.person_id),
  by: r.display_name,
  startedAt: asDate(r.started_at),
  completedAt: r.completed_at === null ? null : asDate(r.completed_at),
  specimens: r.specimens === null ? null : Number(r.specimens),
});

/** Every recorded download for the collection, newest first, with who took it and whether it finished. */
export async function downloadsOf(db: Kysely<Database>, collection: EcdysisCollection, limit = 50): Promise<DownloadRecord[]> {
  return (await selectDownloads(db).where("d.collection", "=", collection.program).orderBy("d.entity_id", "desc").limit(limit).execute()).map(toRecord);
}

/** A download, by its id, with who took it and whether it finished; null where there is none. One query. */
export async function downloadById(db: Kysely<Database>, id: number): Promise<DownloadRecord | null> {
  const found = await selectDownloads(db).where("d.entity_id", "=", id).execute();
  return found.length === 0 ? null : toRecord(found[0]!);
}

/** Whether a download that began after the last read is on record, which means no second archive: the one still being written, or the one taken. */
export const blocking = (downloads: readonly DownloadRecord[], readAt: Date): DownloadRecord | null =>
  downloads.find((d) => d.startedAt.getTime() > readAt.getTime()) ?? null;

/** Whether a download without a completion began recently enough to be still going. */
export const beingWritten = (d: DownloadRecord, now: Date = new Date()): boolean =>
  d.completedAt === null && now.getTime() - d.startedAt.getTime() < BEING_WRITTEN_MINUTES * 60_000;

/**
 * Decides that an archive may be written and records its start, in one
 * transaction. The decision reads the downloads on record; two requests that
 * arrive together can each see none, because DuckDB's transactions work on
 * snapshots and a check followed by an insert is not exclusive. What makes one
 * of them fail is the table's `UNIQUE (collection, read_at)`: DuckDB refuses the
 * second row with the same key, and that refusal is taken here as "another
 * archive was just started". Any other error is the caller's.
 */
export async function startDownload(
  db: Kysely<Database>,
  d: { collection: EcdysisCollection; year: number; include: Include; planned: number; readAt: Date; personId: number | null },
): Promise<{ ok: true; id: number } | { ok: false; because: DownloadRecord | null }> {
  try {
    return await db.transaction().execute(async (trx) => {
      const already = blocking(await downloadsOf(trx, d.collection, 20), d.readAt);
      if (already !== null) return { ok: false as const, because: already };
      const { entity_id } = await trx
        .insertInto("ecdysis_upload_download")
        .values({
          collection: d.collection.program,
          year: d.year,
          include_taxon_obscured: d.include.taxonObscured,
          include_observer_obscured: d.include.observerObscured,
          planned_specimens: d.planned,
          read_at: d.readAt.toISOString(),
          person_id: d.personId,
        })
        .returning("entity_id")
        .executeTakeFirstOrThrow();
      return { ok: true as const, id: Number(entity_id) };
    });
  } catch (err) {
    // A request that lost the race fails on the unique key, and DuckDB has by then rolled its transaction back, so
    // Kysely's own rollback may fail too and hide the cause. Whatever the message, what decides is whether another
    // download for this read is now on record; the other transaction may take a moment to commit.
    for (let tries = 0; tries < 20; tries++) {
      const already = blocking(await downloadsOf(db, d.collection, 20), d.readAt);
      if (already !== null) return { ok: false, because: already };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw err;
  }
}

/**
 * Records that an archive has been prepared: its completion, with the number of
 * specimens actually written, and the specimens themselves with the catalog
 * number each was written under, in one transaction.
 */
export async function completeDownload(db: Kysely<Database>, id: number, written: readonly WrittenSpecimen[]): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("ecdysis_upload_download_completed").values({ download_id: id, specimens: written.length }).execute();
    for (let from = 0; from < written.length; from += 2_000) {
      await trx
        .insertInto("ecdysis_upload_download_specimen")
        .values(written.slice(from, from + 2_000).map((w) => ({ download_id: id, specimen_id: w.id, catalog_number: w.catalogNumber })))
        .execute();
    }
  });
}

/** The specimens a completed download held, with the catalog number each was written under, in id order. */
export async function downloadSpecimens(db: Kysely<Database>, id: number): Promise<WrittenSpecimen[]> {
  const found = await db.selectFrom("ecdysis_upload_download_specimen").where("download_id", "=", id).orderBy("specimen_id").select(["specimen_id", "catalog_number"]).execute();
  return found.map((r) => ({ id: Number(r.specimen_id), catalogNumber: r.catalog_number }));
}

/** A finished download as the page shows it. */
export interface DownloadView extends DownloadRecord {
  /** How many of its recorded specimens are not known to be in Ecdysis; null for a download that did not finish, whose specimens are not recorded. */
  notKnown: number | null;
  /** Whether absence from Ecdysis could be established: only with the cached archive of a recent read in hand. Otherwise a specimen not in the store is "not known", not "not in Ecdysis yet". */
  established: boolean;
}

/** How many finished downloads the page lists besides those with specimens still not known to be in Ecdysis. */
export const RECENT_DOWNLOADS = 10;

/**
 * The downloads the page lists for a collection, newest first: the most recent
 * ten finished ones, and any finished one beyond them with specimens not
 * known to be in Ecdysis, since that is what a person might still upload; and
 * an unfinished one while it blocks a second archive. A recorded specimen is
 * in Ecdysis when the catalog number it was written under is that of a
 * `specimen_catalog_number` row of the specimen as it is now, or (where the
 * cached archive is in hand) is in the cached collection. One that no longer
 * exists counts as not known, never as held. The counting is one SQL statement
 * grouped by download; the cached archive's catalog numbers go into a
 * temporary table for it, on the transaction's own connection, since a
 * Kysely connection is not kept between statements. The list is not cut before
 * the outstanding ones are found.
 */
export async function downloadViewsOf(
  db: Kysely<Database>,
  collection: EcdysisCollection,
  held: ReadonlySet<string> | null,
  readAt: Date | null,
  now: Date = new Date(),
): Promise<DownloadView[]> {
  const all = await downloadsOf(db, collection, 100_000);
  const missing = new Map<number, number>();
  if (all.some((d) => d.completedAt !== null)) {
    const counted = await db.transaction().execute(async (trx) => {
      await sql`CREATE OR REPLACE TEMP TABLE ecdysis_held (catalog_number TEXT)`.execute(trx);
      const keys = held === null ? [] : [...held];
      for (let from = 0; from < keys.length; from += 1_000) {
        await sql`INSERT INTO ecdysis_held VALUES ${sql.join(keys.slice(from, from + 1_000).map((k) => sql`(${k})`))}`.execute(trx);
      }
      const result = await sql<{ download_id: number | bigint; not_known: number | bigint }>`
        SELECT ds.download_id, count(*) FILTER (WHERE sp.entity_id IS NULL OR NOT (
                 EXISTS (SELECT 1 FROM specimen_catalog_number c WHERE c.specimen_id = sp.entity_id AND lower(c.catalog_number) = lower(ds.catalog_number))
                 OR EXISTS (SELECT 1 FROM ecdysis_held h WHERE h.catalog_number = lower(ds.catalog_number)))) AS not_known
        FROM ecdysis_upload_download_specimen ds
        JOIN ecdysis_upload_download d ON d.entity_id = ds.download_id AND d.collection = ${collection.program}
        LEFT JOIN specimen sp ON sp.entity_id = ds.specimen_id
        GROUP BY ds.download_id`.execute(trx);
      await sql`DROP TABLE ecdysis_held`.execute(trx);
      return result.rows;
    });
    for (const r of counted) missing.set(Number(r.download_id), Number(r.not_known));
  }
  const out: DownloadView[] = [];
  let recent = 0;
  for (const d of all) {
    if (d.completedAt === null) {
      // No specimens are recorded for it: shown while it blocks, which is after the last read began (or, with no read on record, for a day).
      const blocks = readAt === null ? now.getTime() - d.startedAt.getTime() < 86_400_000 : d.startedAt.getTime() > readAt.getTime();
      if (blocks) out.push({ ...d, notKnown: null, established: held !== null });
      continue;
    }
    const notKnown = missing.get(d.id) ?? 0;
    if (recent < RECENT_DOWNLOADS || notKnown > 0) {
      out.push({ ...d, notKnown, established: held !== null });
      recent++;
    }
  }
  return out;
}

// --- The state of a collection -----------------------------------------------

/** What the Data tab and the files' routes ask: the plan for a collection, or why there is none. */
export type UploadState =
  | {
      ok: true;
      plan: UploadPlan;
      read: Extract<EcdysisRead, { ok: true }>;
      held: ReadonlySet<string>;
      /** The download that began after the read, which means no second archive; null where there is none. */
      blocking: DownloadRecord | null;
    }
  | ({ ok: false } & UploadRefusal);

/**
 * The catalog numbers loaded at this read that the archive does not hold. The
 * loader writes `specimen_catalog_number.loaded_at` for every matched specimen
 * with the read's own start time, so each of these was in the archive the read
 * loaded: one missing from the zip means the zip is not that one. A specimen
 * whose Ecdysis record has since been deleted keeps an older `loaded_at` (the
 * loader never removes a row, src/load-ecdysis.ts), so it never counts.
 */
async function loadedButNotHeld(db: Kysely<Database>, collection: EcdysisCollection, readAt: Date, held: ReadonlySet<string>): Promise<number> {
  const { rows } = await sql<{ catalog_number: string }>`
    SELECT catalog_number FROM specimen_catalog_number
    WHERE starts_with(lower(catalog_number), ${collection.catalogPrefix.toLowerCase()})
      AND loaded_at >= ${readAt.toISOString()}::TIMESTAMPTZ`.execute(db);
  return rows.filter((r) => !held.has(catalogKey(r.catalog_number))).length;
}

/** The read of Ecdysis, then the plan built from it, and the downloads on record: one question, answered the same on the page and in the routes. */
export async function uploadStateOf(
  db: Kysely<Database>,
  collection: EcdysisCollection,
  opts: { ecdysisDir: string; now?: Date },
): Promise<UploadState> {
  const read = await ecdysisRead(collection, opts);
  if (!read.ok) return read;
  let contents: ArchiveContents;
  try {
    contents = await catalogNumbersInArchive(db, read.archivePath, opts.ecdysisDir, { bytes: read.marker.zipBytes, modifiedAt: read.marker.zipModifiedAt });
  } catch (err) {
    if (err instanceof ArchiveChanged) return { ok: false, reason: "changed", readAt: read.readAt };
    console.error(`The cached Ecdysis archive for ${collection.program} could not be read: ${(err as Error).message}`);
    return { ok: false, reason: "unreadable", readAt: read.readAt };
  }
  // The zip must be the one the read loaded: as many occurrences as the marker says, and every catalog number loaded at that read.
  if (contents.rows !== read.marker.records || (await loadedButNotHeld(db, collection, read.readAt, contents.held)) > 0) {
    return { ok: false, reason: "incomplete", readAt: read.readAt };
  }
  const downloads = await downloadsOf(db, collection, 20);
  return {
    ok: true,
    plan: await planUpload(db, collection, { readAt: read.readAt, held: contents.held }),
    read,
    held: contents.held,
    blocking: blocking(downloads, read.readAt),
  };
}

// --- The archive ---------------------------------------------------------------

/**
 * occurrence.tsv's columns after the id, each with the term meta.xml gives it
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
 * identification.tsv's columns after the specimen's id. `identificationIsCurrent`
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
 * can be short of a full one without being the last. `written`, when given,
 * collects the ids of the specimens actually written, which is what a
 * completed download records; `pageSize` lets a test make pages small enough
 * to have several; `beforePage` runs before each page and may throw to stop.
 */
export function uploadArchiveStream(
  db: Kysely<Database>,
  collection: EcdysisCollection,
  specimenIds: readonly number[],
  rules: UploadRules,
  opts: { timing?: CsvTiming; written?: WrittenSpecimen[]; pageSize?: number; beforePage?: () => Promise<void> } = {},
): ReadableStream<Uint8Array> {
  const hostNames = hostNamesOnce(db);
  let cursor = 0;
  return specimenArchiveStream(
    async (limit) => {
      await opts.beforePage?.();
      const slice = specimenIds.slice(cursor, cursor + Math.min(limit, opts.pageSize ?? limit));
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
      opts.written?.push(...page.rows.map((r) => ({ id: r.specimen_id, catalogNumber: catalogNumberOf(collection, r.field_number ?? "") })));
      return { ...page, last: cursor >= specimenIds.length };
    },
    { layout: uploadArchiveLayout(collection), timing: opts.timing },
  );
}

/** The archive would be larger than `ARCHIVE_LIMIT_BYTES`: it is built in memory, and British Columbia's is about 145 KB. */
export class ArchiveTooLarge extends Error {
  constructor(bytes: number) {
    super(`The archive is more than ${bytes} bytes, which is more than Beeline builds in memory`);
  }
}

/** The read of Ecdysis the archive rested on has been replaced by a newer one while the archive was being written. */
export class ReadSuperseded extends Error {
  constructor() {
    super("Ecdysis was read again while the archive was being written");
  }
}

/** A generous bound on an archive built in memory. */
export const ARCHIVE_LIMIT_BYTES = 50 * 1024 * 1024;

/**
 * The whole archive, built in memory before anything is answered: the person
 * may have the file from the moment it is sent, so "completed" has to mean
 * "Beeline finished writing it", and the file name can carry the number of
 * specimens actually written. `stillCurrent` is asked before each page and
 * once more at the end; when the read marker on disk is no longer the one the
 * plan rested on it ends the build, with nothing to record.
 */
export async function buildArchive(
  db: Kysely<Database>,
  collection: EcdysisCollection,
  specimenIds: readonly number[],
  rules: UploadRules,
  opts: { stillCurrent: () => Promise<boolean>; pageSize?: number; limit?: number; timing?: CsvTiming },
): Promise<{ bytes: Uint8Array; written: WrittenSpecimen[] }> {
  const written: WrittenSpecimen[] = [];
  const limit = opts.limit ?? ARCHIVE_LIMIT_BYTES;
  const stream = uploadArchiveStream(db, collection, specimenIds, rules, {
    written,
    pageSize: opts.pageSize,
    timing: opts.timing,
    beforePage: async () => {
      if (!(await opts.stillCurrent())) throw new ReadSuperseded();
    },
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ArchiveTooLarge(limit);
    }
    chunks.push(value);
  }
  if (!(await opts.stillCurrent())) throw new ReadSuperseded();
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { bytes, written };
}

// --- The associations file -----------------------------------------------------

/**
 * The headers Symbiota's "Extended Data Import" page maps by name for an
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
 * The associations file for the specimens a completed download held: exactly
 * those, with no rule applied again, so the file matches the archive that was
 * uploaded, and each named by the catalog number it was written under, not one
 * made again from the specimen's label number as it is now. One row for each
 * whose sample has an iNaturalist observation that still exists. The host is
 * named as the observation named it, at whatever rank Beeline holds, and left
 * empty where there is none. This file is the only place the host reaches
 * Ecdysis: the specimens file carries no `associatedTaxa` column, because
 * loading this file again can correct an association but never the text on a
 * specimen record, so the two would disagree after a plant is renamed (Peter
 * decided, 2026-11-22). A trap sample has no row at all, and a trap sample is
 * one whose method is a trap (`method.is_trap`, as the archives and
 * downloads decide). A sample with no method has no row either, because nothing says whether its plant is a host or near a trap. Kind is the method's
 * (stage three of beeline-ni5m.15), and this reads the method. Symbiota applies one relationship, `hasHost`, to
 * the whole file, and the plant near a trap is not a host. UTF-8 with no byte order mark and no formula guard. The
 * program's CSV downloads have both for the sake of spreadsheets; this file is
 * read by Symbiota, which loaded it the same with and without a mark (tried
 * 2026-11-20), so the headers are left as exact bytes, and a guard would write
 * an apostrophe into a name that begins with `-`, `=`, `+` or `@`. Read in one
 * transaction.
 */
export async function associationsCsv(db: Kysely<Database>, recorded: readonly WrittenSpecimen[]): Promise<string> {
  const lines = [csvExactLine(ASSOCIATION_HEADER)];
  const catalogNumbers = new Map(recorded.map((w) => [w.id, w.catalogNumber]));
  await db.transaction().execute(async (trx) => {
    for (let from = 0; from < recorded.length; from += ASSOCIATION_PAGE) {
      const found = await trx
        .selectFrom("specimen as sp")
        .innerJoin("sample as s", "s.entity_id", "sp.sample_id")
        .where("sp.entity_id", "in", recorded.slice(from, from + ASSOCIATION_PAGE).map((w) => w.id))
        .where("s.inat_observation_id", "is not", null)
        .where(sql<boolean>`NOT ${observationGone}`)
        // An inner join: a sample with no method is left out, since a wrong association cannot easily be taken back.
        .innerJoin("sample_method as smt", "smt.sample_id", "s.entity_id")
        .innerJoin("method as mth", "mth.code", "smt.method_code")
        .select(["sp.entity_id as specimen_id", "s.inat_observation_id", "s.host_name_as_observed", "mth.is_trap as near_trap"])
        .orderBy("sp.entity_id")
        .execute();
      for (const r of found) {
        if (r.inat_observation_id === null || r.near_trap) continue;
        lines.push(csvExactLine([catalogNumbers.get(Number(r.specimen_id)), observationUrl(r.inat_observation_id), r.host_name_as_observed]));
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

/** Where an archive is asked for: `/programs/BC/data/ecdysis/2026-upload.zip`; the download is given its own, stamped, name in the response. */
export const archiveHref = (collection: EcdysisCollection, year: number): string => `${programDataHref(collection.program)}/ecdysis/${year}-upload.zip`;

/** Where the associations file for a completed download is asked for. */
export const associationsHref = (collection: EcdysisCollection, downloadId: number): string =>
  `${programDataHref(collection.program)}/ecdysis/downloads/${downloadId}/associations.csv`;

/** Where the check of Ecdysis is started from the program's Data tab. */
export const checkHref = (collection: EcdysisCollection): string => `${programDataHref(collection.program)}/check-ecdysis`;

/** The jobs that read Ecdysis: the button's, and the nightly one. Only one job runs at a time. */
export const ECDYSIS_READ_JOBS = ["ecdysis-read-now", "ecdysis-fetch"] as const;

/**
 * The least time between two checks started from a program's Data tab. The job reads every collection and replaces
 * every collection's marker, so a check pressed again at once would restart another program's specimens file being
 * made, and download Ecdysis's whole collections each time (beeline-q8di).
 */
export const ECDYSIS_CHECK_MIN_INTERVAL_MS = 5 * 60_000;

/** The job the "Check Ecdysis now" button starts. */
export const ECDYSIS_CHECK_JOB = "ecdysis-read-now";

/**
 * Whether Ecdysis is being checked, or how the last check ended, for the
 * tab's sentence about it. `runningJob` is the job running now (the
 * scheduler's `running`), read from the job registry; the last check is the
 * latest finished run of either job that reads Ecdysis. Its failure detail is
 * not returned: the tab says only that it failed.
 */
export type EcdysisCheck = { state: "running" } | { state: "finished"; at: Date } | { state: "failed"; at: Date } | null;

export async function ecdysisCheckOf(db: Kysely<Database>, runningJob: string | null): Promise<EcdysisCheck> {
  if (runningJob !== null && (ECDYSIS_READ_JOBS as readonly string[]).includes(runningJob)) return { state: "running" };
  const last = await db
    .selectFrom("job_run")
    .select(["completed_at", "outcome"])
    .where("job_name", "in", [...ECDYSIS_READ_JOBS])
    .where("completed_at", "is not", null)
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (last === undefined || last.completed_at === null) return null;
  return { state: last.outcome === "succeeded" ? "finished" : "failed", at: asDate(last.completed_at) };
}

export const collectionOf = (program: string): EcdysisCollection | undefined => ECDYSIS_COLLECTIONS.find((c) => c.program === program);
