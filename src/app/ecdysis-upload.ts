import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { cachedArchivePath, detailSaysRead, ECDYSIS_COLLECTIONS, type EcdysisCollection } from "../fetch-ecdysis.js";
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
 * collection at a time. Its rows are specimens that
 * - belong to the collection's program,
 * - have a label on paper (`specimen_on_paper`) and a label number,
 * - are not marked missing,
 * - have no catalog number from Ecdysis (`specimen_catalog_number`), and whose
 *   would-be catalog number, the collection's prefix and the label number, is
 *   not in the archive Beeline last downloaded from Ecdysis either, which
 *   also holds the records Beeline could not match to a specimen, and
 * - do not have an obscured taxon (their program has not said whether true
 *   coordinates may leave Beeline, beeline-1kb.7.1).
 * Nothing is built from a read of Ecdysis that is more than 36 hours old,
 * because Symbiota replaces a record it matches by catalog number whole, and
 * a file made from a stale read could do that to a record created since.
 */

/** How old the last read of Ecdysis may be before no file is written: a missed night, and a little more. */
export const UPLOAD_FRESH_HOURS = 36;

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

// --- What Beeline last read from Ecdysis -----------------------------------

/** Why no file is offered for a collection. */
export type UploadRefusal =
  /** No run of the nightly read has succeeded for this collection. */
  | { reason: "never"; readAt: null }
  /** The last read is older than `UPLOAD_FRESH_HOURS`. */
  | { reason: "stale"; readAt: Date }
  /** A read succeeded but the archive it downloaded is not on disk. */
  | { reason: "no-archive"; readAt: Date }
  /** The archive is on disk and could not be read as an Ecdysis archive. */
  | { reason: "unreadable"; readAt: Date };

export type EcdysisRead = { ok: true; readAt: Date; archivePath: string } | ({ ok: false } & UploadRefusal);

/**
 * When Ecdysis was last read for a collection, and whether that is recent
 * enough to build from. The source is the nightly `ecdysis-fetch` job's
 * history (`job_run`), because it is the only record of a read that found
 * nothing new: the cached archive's file and its probe baseline are rewritten
 * only when an archive is downloaded, so on a quiet week they are a week old
 * while every night's read succeeded. A run counts for a collection when its
 * detail names that collection as downloaded or reloaded (`detailSaysRead`),
 * so a night on which another collection failed still counts for this one.
 * The time is when the run started, the earlier of its two ends, so a file is
 * never trusted for longer than it should be. The archive the run loaded must
 * also still be on disk: its catalog numbers are what "Ecdysis does not hold
 * it" is judged against.
 */
export async function ecdysisRead(
  db: Kysely<Database>,
  collection: EcdysisCollection,
  opts: { ecdysisDir: string; now?: Date },
): Promise<EcdysisRead> {
  const now = opts.now ?? new Date();
  const runs = await db
    .selectFrom("job_run")
    .where("job_name", "=", "ecdysis-fetch")
    .where("outcome", "is not", null)
    .select(["started_at", "detail"])
    .orderBy("started_at", "desc")
    .limit(30)
    .execute();
  const run = runs.find((r) => detailSaysRead(r.detail, collection));
  if (run === undefined) return { ok: false, reason: "never", readAt: null };
  const readAt = new Date(run.started_at as unknown as string | Date);
  if (now.getTime() - readAt.getTime() > UPLOAD_FRESH_HOURS * 3_600_000) return { ok: false, reason: "stale", readAt };
  const archivePath = cachedArchivePath(opts.ecdysisDir, collection);
  try {
    await stat(archivePath);
  } catch {
    return { ok: false, reason: "no-archive", readAt };
  }
  return { ok: true, readAt, archivePath };
}

/** Catalog numbers are compared the way Symbiota's database compares them: without regard to case. */
export const catalogKey = (catalogNumber: string): string => catalogNumber.trim().toLowerCase();

const heldCache = new Map<string, { key: string; held: Set<string> }>();

/**
 * Every catalog number in the archive Beeline last downloaded from Ecdysis,
 * the ones it matched to a specimen and the ones it could not. The store keeps
 * only the matched ones (`specimen_catalog_number`: the loader counts the rest
 * and keeps five as a sample), so the archive itself is read, with DuckDB as
 * the loader reads it. It is unpacked into a folder of its own under
 * `workDir`, which the store may read (`storeFiles`), and removed. Read once
 * per download: the result is kept while the file's size and time stay the same.
 */
export async function catalogNumbersInArchive(db: Kysely<Database>, archivePath: string, workDir: string): Promise<Set<string>> {
  const st = await stat(archivePath);
  const key = `${st.size}:${st.mtimeMs}`;
  const kept = heldCache.get(archivePath);
  if (kept?.key === key) return kept.held;
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
}

// --- Which specimens ---------------------------------------------------------

/** A specimen that could be in a file, before the rules that need Ecdysis's catalog numbers. */
interface Candidate {
  specimen_id: number;
  field_number: string | null;
  year: number;
  /** The label number is on another specimen too: two records would get one catalog number. */
  label_number_shared: boolean;
  obscured: boolean;
  country: string | null;
  state_province: string | null;
}

/** What the file for one collection year holds, and what was left out of it and why. */
export interface UploadYear {
  year: number;
  /** The specimens in the file, by id. */
  specimenIds: number[];
  /** Left out: the taxon is obscured, so the program has not said true coordinates may go (beeline-1kb.7.1). */
  obscured: number;
  /** Left out: the catalog number would be unusable in Ecdysis, being shared with another specimen or longer than Ecdysis allows. */
  unusable: number;
}

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
 * What goes in the file for each year of the collection. `query` is the
 * Specimens listing's own filters, read by `parseListingQuery`, which narrow
 * the selection further; its scope, labels and Ecdysis filters are replaced
 * by this selection's own rules, since they are the rules and not choices. The
 * listing's own predicates are used, so "a label on paper" and "has a catalog
 * number from Ecdysis" mean here what they mean on the Specimens page.
 */
export async function planUpload(
  db: Kysely<Database>,
  collection: EcdysisCollection,
  read: { readAt: Date; held: ReadonlySet<string> },
  query: ListingQuery = EMPTY_QUERY,
): Promise<UploadPlan> {
  const scope = await scopeOf(db, collection);
  const base = await filteredSpecimens(db, { ...query, scope, labels: "printed", ecdysis: "not" }, 0, STAFF_READER, undefined, {}, false);
  const found = (await base
    .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM specimen_disposition md WHERE md.specimen_id = sp.entity_id AND md.disposition = 'missing')`)
    .select([
      "sp.entity_id as specimen_id",
      "sp.field_number",
      sql<number>`CAST(extract(year FROM s.date_start) AS INTEGER)`.as("year"),
      sql<boolean>`EXISTS (SELECT 1 FROM specimen twin WHERE twin.field_number = sp.field_number AND twin.entity_id <> sp.entity_id)`.as("label_number_shared"),
      // As the views read it: 'open' is a value, not a null.
      sql<boolean>`nullif(s.taxon_geoprivacy, 'open') IS NOT NULL`.as("obscured"),
      "s.country",
      "s.state_province",
    ])
    .orderBy("sp.entity_id")
    .execute()) as unknown as Candidate[];

  const byYear = new Map<number, UploadYear>();
  const unspelled = new Set<string>();
  for (const c of found) {
    // No label number: nothing to make a catalog number from.
    if (c.field_number === null || c.field_number === "") continue;
    const catalogNumber = catalogNumberOf(collection, c.field_number);
    // Ecdysis already has it, matched to a specimen or not.
    if (read.held.has(catalogKey(catalogNumber))) continue;
    const year = byYear.get(Number(c.year)) ?? { year: Number(c.year), specimenIds: [], obscured: 0, unusable: 0 };
    byYear.set(year.year, year);
    if (c.label_number_shared || catalogNumber.length > CATALOG_NUMBER_LIMIT) year.unusable++;
    else if (c.obscured) year.obscured++;
    else {
      year.specimenIds.push(Number(c.specimen_id));
      if (c.country !== null && COUNTRY_NAMES[c.country] === undefined) unspelled.add(c.country);
      if (c.state_province !== null && STATE_NAMES[c.state_province] === undefined) unspelled.add(c.state_province);
    }
  }
  return { collection, readAt: read.readAt, years: [...byYear.values()].sort((a, b) => b.year - a.year), unspelled: [...unspelled].sort() };
}

/** What the Exports page and the files' routes ask: the plan for a collection, or why there is none. */
export type UploadState = { ok: true; plan: UploadPlan } | ({ ok: false } & UploadRefusal);

/** The read of Ecdysis, then the plan built from it: one question, answered the same on the page and in the routes. */
export async function uploadStateOf(
  db: Kysely<Database>,
  collection: EcdysisCollection,
  opts: { ecdysisDir: string; now?: Date; query?: ListingQuery },
): Promise<UploadState> {
  const read = await ecdysisRead(db, collection, opts);
  if (!read.ok) return read;
  let held: Set<string>;
  try {
    held = await catalogNumbersInArchive(db, read.archivePath, opts.ecdysisDir);
  } catch (err) {
    console.error(`The cached Ecdysis archive for ${collection.program} could not be read: ${(err as Error).message}`);
    return { ok: false, reason: "unreadable", readAt: read.readAt };
  }
  return { ok: true, plan: await planUpload(db, collection, { readAt: read.readAt, held }, opts.query) };
}

// --- The archive -------------------------------------------------------------

/**
 * occurrence.txt's columns after the id, each with the term meta.xml gives it
 * and the Symbiota field it lands in (checked against Symbiota's source and by
 * importing the archive; the table is in
 * docs/architecture/the-upload-to-ecdysis.md). Constants are real columns, not
 * `default` attributes in meta.xml, because whether Symbiota honours a default
 * has not been tested. Beeline's own undeclared columns are left out: this file
 * is for a machine. There is no occurrenceID: Washington's collection makes
 * its own and ignores an uploaded one.
 */
export const UPLOAD_OCCURRENCE_COLUMNS = [
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

/** One occurrence row, starting with the specimen's id; the cells follow `UPLOAD_OCCURRENCE_COLUMNS`. */
export function uploadOccurrenceRow(r: SpecimenRow, page: ArchivePage, collection: EcdysisCollection): unknown[] {
  const cell = csvCellsOf(r, page);
  // The determination of record names the specimen only where it is an expert's. A volunteer's goes as history
  // alone, so that Ecdysis's own experts are the ones who name a new record.
  const expert = r.determination_id !== null && r.is_expert === true;
  const own: Record<(typeof UPLOAD_OCCURRENCE_COLUMNS)[number][0], unknown> = {
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
    lifeStage: "adult",
    preparations: "pinned",
    individualCount: 1,
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
  };
  return [r.specimen_id, ...UPLOAD_OCCURRENCE_COLUMNS.map(([header]) => own[header])];
}

/**
 * The identification rows of a page: every determination of each specimen,
 * as history, current only on the determination of record when an expert made
 * it. Symbiota keeps one row for each (record, date identified, identified by,
 * scientific name) and silently drops the second of two that agree, whatever
 * their flags, so determinations of one specimen that agree on name,
 * determiner and date (or the lack of one) are written as one, current if any
 * of them is. The case-insensitive comparison is Symbiota's: its columns are
 * `utf8_general_ci`.
 */
export function uploadIdentificationRows(identifications: readonly IdentificationRow[]): unknown[][] {
  const merged = new Map<string, { row: IdentificationRow; current: boolean; sourceId: number }>();
  for (const d of identifications) {
    const key = [d.specimen_id, d.scientific_name, d.determiner ?? "", dateIdentified(d.determined_on, d.determined_on_precision) ?? ""]
      .map((part) => String(part).trim().toLowerCase())
      .join("\u0000");
    const current = d.of_record && d.is_expert;
    const seen = merged.get(key);
    if (seen === undefined) merged.set(key, { row: d, current, sourceId: d.determination_id });
    // The current one's other cells (qualifier, authorship) and id are the ones kept.
    else if (current && !seen.current) merged.set(key, { row: d, current, sourceId: d.determination_id });
  }
  return [...merged.values()].map(({ row: d, current, sourceId }) => [
    d.specimen_id,
    d.scientific_name,
    d.authorship,
    d.qualifier,
    d.determiner,
    dateIdentified(d.determined_on, d.determined_on_precision),
    current ? 1 : 0,
    sourceId,
  ]);
}

/** The upload archive's layout for a collection. */
export function uploadArchiveLayout(collection: EcdysisCollection): ArchiveLayout {
  return {
    meta: archiveDescriptor(
      UPLOAD_OCCURRENCE_COLUMNS.map(([, term]) => term),
      UPLOAD_IDENTIFICATION_COLUMNS.map(([, term]) => term),
    ),
    occurrenceHeader: ["id", ...UPLOAD_OCCURRENCE_COLUMNS.map(([header]) => header)],
    occurrenceRows: (page) => page.rows.map((r) => uploadOccurrenceRow(r, page, collection)),
    identificationHeader: ["coreid", ...UPLOAD_IDENTIFICATION_COLUMNS.map(([header]) => header)],
    identificationRows: (page) => uploadIdentificationRows(page.identifications),
  };
}

/** The upload archive of these specimens, streamed a page of them at a time. */
export function uploadArchiveStream(
  db: Kysely<Database>,
  collection: EcdysisCollection,
  specimenIds: readonly number[],
  timing?: CsvTiming,
): ReadableStream<Uint8Array> {
  const hostNames = hostNamesOnce(db);
  return specimenArchiveStream(
    async (limit, offset) => {
      const ids = specimenIds.slice(offset, offset + limit);
      const page = await listSpecimens(db, { ...EMPTY_QUERY, scope: ALL }, 0, STAFF_READER, {
        ids,
        limit: ids.length,
        offset: 0,
        withTotal: false,
        hostNames: await hostNames(),
      });
      return { ...page, identifications: await identificationsOf(db, page.rows.map((r) => r.specimen_id)) };
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
 * does, and left empty where there is none. UTF-8 with no byte order mark and no
 * formula guard. The program's CSV downloads have both for the sake of
 * spreadsheets; this file is read by Symbiota, which loaded it the same with
 * and without a mark (tried 2026-11-20), so the headers are left as exact bytes,
 * and a guard would write an apostrophe into a name that begins with `-`, `=`,
 * `+` or `@`.
 */
export async function associationsCsv(db: Kysely<Database>, collection: EcdysisCollection, specimenIds: readonly number[]): Promise<string> {
  const lines = [csvExactLine(ASSOCIATION_HEADER)];
  for (let from = 0; from < specimenIds.length; from += ASSOCIATION_PAGE) {
    const found = await db
      .selectFrom("specimen as sp")
      .innerJoin("sample as s", "s.entity_id", "sp.sample_id")
      .where("sp.entity_id", "in", specimenIds.slice(from, from + ASSOCIATION_PAGE))
      .where("s.inat_observation_id", "is not", null)
      .where(sql<boolean>`NOT ${observationGone}`)
      .select(["sp.entity_id as specimen_id", "sp.field_number", "s.inat_observation_id", "s.host_name_as_observed"])
      .orderBy("sp.entity_id")
      .execute();
    for (const r of found) {
      if (r.field_number === null || r.inat_observation_id === null) continue;
      lines.push(csvExactLine([catalogNumberOf(collection, r.field_number), observationUrl(r.inat_observation_id), r.host_name_as_observed]));
    }
  }
  return lines.join("");
}

// --- File names -------------------------------------------------------------

/**
 * `ecdysis-upload-WaBA-2026-2026-11-21-140507.zip`: the collection's program,
 * the collection year, then the day and time written, Pacific, as every
 * download's name is stamped (`exportFilename`). The stamp lets whoever
 * uploads see that a file is from today.
 */
export const uploadFileName = (collection: EcdysisCollection, year: number, written: Date, kind: "archive" | "associations"): string =>
  exportFilename(`ecdysis-${kind === "archive" ? "upload" : "associations"}-${collection.program}-${year}`, written, kind === "archive" ? "zip" : "csv");

/** Where a file is served: `/exports/ecdysis/WaBA-2026-upload.zip`, whose name the download is given its own, stamped, in the response. */
export const ecdysisFileHref = (collection: EcdysisCollection, year: number, kind: "archive" | "associations"): string =>
  `/exports/ecdysis/${collection.program}-${year}-${kind === "archive" ? "upload.zip" : "associations.csv"}`;

export const collectionOf = (program: string): EcdysisCollection | undefined => ECDYSIS_COLLECTIONS.find((c) => c.program === program);
