import { sql, type Kysely } from "kysely";
import type {
  Database,
  DeterminationChannel,
  DeterminationQualifier,
  Geoprivacy,
  LocationSource,
  QcSeverity,
  SampleKind,
} from "../model.js";
import { labelName } from "../person-name.js";
import type { ListedCollector } from "./listings.js";
import { readSampleChanges, sampleHistory, SAMPLE_STATE_SQL, type SampleChange } from "../sample-change.js";

/**
 * One record: the query layer behind /samples/:id and /specimens/:id.
 *
 * The listings answer "what is there" across many rows; these two pages
 * answer everything about one. That is not a nicety — `determination` is
 * append-only and `determination_of_record` is a view, so a correction is a
 * newer event and an expert never overwrites a volunteer (schema/040). The
 * specimen listing gives that history one cell, which shows the conclusion
 * and none of the argument: not that an expert overrode a volunteer, not
 * when, not through which channel, not what the volunteer had said
 * (beeline-2c3.34). This is where the events are readable.
 *
 * The two grains split the way the data does. QC findings are keyed to the
 * sample, so "why will this not print" is a question about a sample and is
 * answered on the sample's page; a determination is an assertion about one
 * insect, so the history is on the specimen's. Each page carries enough of
 * the other to be read alone — a specimen without where and when it was
 * collected is not a record of anything.
 *
 * Reachability is the listings' rule with no filters left: a volunteer
 * reaches their own records and nothing else, staff reach everything, and
 * "their own" follows the acting-for switch because the caller passes the
 * effective person (src/app/acting.ts). Unreachable and non-existent are the
 * same answer — null, rendered as a 404 — so a URL cannot be probed to learn
 * that a record exists.
 */

/**
 * Addressing. A record is named by its `entity_id`, which the blow-away era
 * redraws on every rebuild — the same objection `personHandle` answers with
 * a login (src/app/roster.ts). There is no better handle here: a field
 * number is nullable and, across the four historical identifier eras, not
 * unique either (schema/030), so it cannot be the key. A pasted record URL
 * is therefore stable only until the next rebuild, and permanently from
 * cutover, which is also when the numbers it names stop moving.
 *
 * Cost. `recordFindings` reads `sample_qc_finding`, whose filter does not
 * push through the union underneath it, so a record page scans the whole
 * thing whatever the sample — ~25 ms on the dev store, down from ~440 before
 * the observation projection was stored (beeline-2c3.36) and the locality
 * rule stopped being nineteen LIKE passes (beeline-2c3.37). That is the same
 * scan the QC home and both listings already pay per page, and reading
 * anything else would be a second definition of "what is wrong with this
 * sample", which is exactly what beeline-2c3.29 collapsed into one.
 */

/** Rows of the sample page's specimen list. The largest trap sample in the
 * corpus holds 2,252, so this page is paged like a listing. */
export const SPECIMEN_PAGE_SIZE = 50;

/** A person on a determination or a collector list, in both name forms. */
export type { ListedCollector };

export interface SampleDetail {
  sample_id: number;
  kind: SampleKind;
  sample_number: string;
  date_start: Date;
  date_end: Date;
  specimen_count: number;
  locality: string | null;
  county: string | null;
  state_province: string | null;
  country: string | null;
  protocol: string | null;
  sampling_effort: string | null;
  inat_observation_id: bigint | null;
  host_inat_taxon_id: bigint | null;
  host_name_as_observed: string | null;
  geoprivacy: Geoprivacy | null;
  taxon_geoprivacy: Geoprivacy | null;
  atlas_code: string | null;
  atlas_name: string | null;
  /** Believed-true coordinates; null together when there is no location row. */
  latitude: number | null;
  longitude: number | null;
  coordinate_uncertainty_m: number | null;
  location_source: LocationSource | null;
  elevation_m: number | null;
  /** Provenance of the elevation: which DEM tile, or the legacy import. */
  elevation_source: string | null;
  elevation_file: string | null;
  /** Whether the elevation still describes the coordinates (schema/170). */
  elevation_stale: boolean;
  /** Whether the viewer is one of this sample's collectors. */
  mine: boolean;
  /** Everyone who collected it, in recordedBy order (beeline-77j). */
  collectors: ListedCollector[];
}

/** A QC finding on a sample, with the copy that says what to do about it. */
export interface RecordFinding {
  rule_name: string;
  details: string | null;
  severity: QcSeverity;
  /** Set when the finding is about one specimen rather than the sample. */
  specimen_id: number | null;
  field_number: string | null;
}

/** One determination event, as recorded — never a flattened current state. */
export interface DeterminationEvent {
  entity_id: number;
  rank: string;
  scientific_name: string;
  authorship: string | null;
  qualifier: DeterminationQualifier | null;
  verbatim_identification: string | null;
  sex: string | null;
  caste: string | null;
  /** The determiner's name, resolved to a person where we could resolve it. */
  determiner: string | null;
  is_expert: boolean;
  channel: DeterminationChannel;
  determined_on: Date | null;
  recorded_at: Date;
  notes: string | null;
  /** Whether determination_of_record picks this event out of the history. */
  of_record: boolean;
}

export interface SpecimenDetail {
  specimen_id: number;
  specimen_number: number;
  field_number: string | null;
  sample: SampleDetail;
}

/** A row of the sample page's specimen list: its number and its conclusion. */
export interface SampleSpecimenRow {
  specimen_id: number;
  specimen_number: number;
  field_number: string | null;
  rank: string | null;
  scientific_name: string | null;
  authorship: string | null;
  qualifier: DeterminationQualifier | null;
  sex: string | null;
  determiner: string | null;
  is_expert: boolean | null;
}

/**
 * The reachability gate, spelled once. A volunteer reaches a sample they
 * collected — any position on the list, not only the numbering it files
 * under (beeline-77j) — and staff reach every sample, which is the scope
 * control's `all` with nothing else to choose. Applied in the query rather
 * than after it, so an unreachable sample is indistinguishable from one that
 * does not exist.
 */
const reachable = (personId: number, admin: boolean) =>
  admin
    ? sql<boolean>`TRUE`
    : sql<boolean>`EXISTS (SELECT 1 FROM sample_collector rc
                           WHERE rc.sample_id = s.entity_id AND rc.person_id = ${personId})`;

/** Whether the viewer collected it — the gate for editing, asked separately
 * because an admin reaches a sample without being on it. */
const isMine = (personId: number) => sql<boolean>`EXISTS (
  SELECT 1 FROM sample_collector mine
  WHERE mine.sample_id = s.entity_id AND mine.person_id = ${personId})`;

/** The columns every sample block shows, at either grain. */
const sampleColumns = (personId: number) => sql`
  s.entity_id AS sample_id,
  s.kind, s.sample_number, s.date_start, s.date_end, s.specimen_count,
  s.locality, s.county, s.state_province, s.country,
  s.protocol, s.sampling_effort,
  s.inat_observation_id, s.host_inat_taxon_id, s.host_name_as_observed,
  s.geoprivacy, s.taxon_geoprivacy,
  a.code AS atlas_code, a.name AS atlas_name,
  loc.latitude, loc.longitude, loc.coordinate_uncertainty_m,
  loc.source AS location_source, loc.elevation_m,
  es.description AS elevation_source, es.file_name AS elevation_file,
  EXISTS (SELECT 1 FROM sample_elevation_stale st WHERE st.sample_id = s.entity_id) AS elevation_stale,
  ${isMine(personId)} AS mine`;

const SAMPLE_JOINS = sql`
  FROM sample s
  LEFT JOIN sample_atlas sa ON sa.sample_id = s.entity_id
  LEFT JOIN atlas a ON a.entity_id = sa.atlas_id
  LEFT JOIN sample_location loc ON loc.sample_id = s.entity_id
  LEFT JOIN elevation_source es ON es.entity_id = loc.elevation_source_id`;

/** Numbers arrive from DuckDB as bigint or string depending on the column. */
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

type RawSample = Omit<SampleDetail, "collectors">;

async function hydrate(db: Kysely<Database>, row: RawSample): Promise<SampleDetail> {
  return {
    ...row,
    sample_id: Number(row.sample_id),
    specimen_count: Number(row.specimen_count),
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    coordinate_uncertainty_m: num(row.coordinate_uncertainty_m),
    elevation_m: num(row.elevation_m),
    elevation_stale: Boolean(row.elevation_stale),
    mine: Boolean(row.mine),
    collectors: await collectorsOfSample(db, Number(row.sample_id)),
  };
}

/** Everyone who collected one sample, in recordedBy order. */
async function collectorsOfSample(db: Kysely<Database>, sampleId: number): Promise<ListedCollector[]> {
  const rows = await db
    .selectFrom("sample_collector as c")
    .innerJoin("person as p", "p.entity_id", "c.person_id")
    .where("c.sample_id", "=", sampleId)
    .select(["p.display_name", "p.given_name", "p.family_name", "p.label_name"])
    .orderBy("c.position")
    .execute();
  return rows.map((r) => ({ display: r.display_name, label: labelName(r) }));
}

/** One sample, or null when this person cannot reach it (or it isn't there). */
export async function loadSample(
  db: Kysely<Database>,
  sampleId: number,
  personId: number,
  admin: boolean,
): Promise<SampleDetail | null> {
  if (!Number.isSafeInteger(sampleId) || sampleId <= 0) return null;
  const found = await sql<RawSample>`
    SELECT ${sampleColumns(personId)} ${SAMPLE_JOINS}
    WHERE s.entity_id = ${sampleId} AND ${reachable(personId, admin)}`.execute(db);
  const row = found.rows[0];
  return row === undefined ? null : hydrate(db, row);
}

/** One specimen and the sample it came out of, under the same gate. */
export async function loadSpecimen(
  db: Kysely<Database>,
  specimenId: number,
  personId: number,
  admin: boolean,
): Promise<SpecimenDetail | null> {
  if (!Number.isSafeInteger(specimenId) || specimenId <= 0) return null;
  const found = await sql<RawSample & { specimen_id: number; specimen_number: number; field_number: string | null }>`
    SELECT sp.entity_id AS specimen_id, sp.specimen_number, sp.field_number,
           ${sampleColumns(personId)}
    ${SAMPLE_JOINS}
    JOIN specimen sp ON sp.sample_id = s.entity_id
    WHERE sp.entity_id = ${specimenId} AND ${reachable(personId, admin)}`.execute(db);
  const row = found.rows[0];
  if (row === undefined) return null;
  return {
    specimen_id: Number(row.specimen_id),
    specimen_number: Number(row.specimen_number),
    field_number: row.field_number,
    sample: await hydrate(db, row),
  };
}

/**
 * Every determination ever recorded for a specimen, newest event first, with
 * the one `determination_of_record` picks marked.
 *
 * Newest first and *not* record first: the page is a history, and putting the
 * conclusion at the top would restate the flattened read this exists to
 * replace. The record is frequently not the newest — the rule is latest
 * expert, else latest volunteer — so it is marked rather than positioned, and
 * the view says out loud when the two differ.
 */
export async function determinationHistory(
  db: Kysely<Database>,
  specimenId: number,
): Promise<DeterminationEvent[]> {
  const found = await sql<DeterminationEvent>`
    SELECT d.entity_id, an.rank, an.scientific_name, an.authorship,
           d.qualifier, d.verbatim_identification, d.sex, d.caste,
           coalesce(p.display_name, d.determiner_name) AS determiner,
           d.is_expert, d.channel, d.determined_on, d.recorded_at, d.notes,
           (dor.entity_id IS NOT NULL) AS of_record
    FROM determination d
    JOIN animal an ON an.entity_id = d.animal_id
    LEFT JOIN person p ON p.entity_id = d.determiner_id
    LEFT JOIN determination_of_record dor ON dor.entity_id = d.entity_id
    WHERE d.specimen_id = ${specimenId}
    ORDER BY d.recorded_at DESC, d.entity_id DESC`.execute(db);
  return found.rows.map((r) => ({
    ...r,
    entity_id: Number(r.entity_id),
    is_expert: Boolean(r.is_expert),
    of_record: Boolean(r.of_record),
  }));
}

/**
 * What is wrong with this sample, in the words a volunteer can act on.
 *
 * Read through `sample_qc_finding`, the roll-up the listings' chips and
 * printability both read (schema/130, beeline-2c3.29), so this page cannot
 * disagree with the chip that sent someone here. A finding keyed to one
 * specimen keeps its specimen, because "which of my 2,252 is it" is the first
 * question that finding raises.
 */
export async function recordFindings(db: Kysely<Database>, sampleId: number): Promise<RecordFinding[]> {
  const found = await sql<RecordFinding>`
    SELECT f.rule_name, f.details, r.severity, f.specimen_id, sp.field_number
    FROM sample_qc_finding f
    JOIN qc_rule r ON r.name = f.rule_name
    LEFT JOIN specimen sp ON sp.entity_id = f.specimen_id
    WHERE f.sample_id = ${sampleId}
    ORDER BY r.severity, f.rule_name`.execute(db);
  return found.rows.map((r) => ({ ...r, specimen_id: num(r.specimen_id) }));
}

export interface SampleSpecimenPage {
  rows: SampleSpecimenRow[];
  total: number;
  page: number;
  pages: number;
}

/**
 * The sample's specimens, with each one's determination of record — the
 * conclusion here, because the argument is on the specimen's own page.
 * Paged: the flagship trap sample holds 2,252.
 */
export async function listSampleSpecimens(
  db: Kysely<Database>,
  sampleId: number,
  page: number,
): Promise<SampleSpecimenPage> {
  const counted = await db
    .selectFrom("specimen")
    .where("sample_id", "=", sampleId)
    .select(({ fn }) => fn.countAll().as("n"))
    .executeTakeFirst();
  const total = Number(counted?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / SPECIMEN_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const rows = await db
    .selectFrom("specimen as sp")
    .leftJoin("determination_of_record as d", "d.specimen_id", "sp.entity_id")
    .leftJoin("animal as an", "an.entity_id", "d.animal_id")
    .leftJoin("person as det", "det.entity_id", "d.determiner_id")
    .where("sp.sample_id", "=", sampleId)
    .select([
      "sp.entity_id as specimen_id",
      "sp.specimen_number",
      "sp.field_number",
      "an.rank",
      "an.scientific_name",
      "an.authorship",
      "d.qualifier",
      "d.sex",
      "d.is_expert",
      sql<string | null>`coalesce(det.display_name, d.determiner_name)`.as("determiner"),
    ])
    .orderBy("sp.specimen_number")
    .limit(SPECIMEN_PAGE_SIZE)
    .offset((current - 1) * SPECIMEN_PAGE_SIZE)
    .execute();
  return {
    rows: (rows as unknown as SampleSpecimenRow[]).map((r) => ({
      ...r,
      specimen_id: Number(r.specimen_id),
      specimen_number: Number(r.specimen_number),
      is_expert: r.is_expert === null ? null : Boolean(r.is_expert),
    })),
    total,
    page: current,
    pages,
  };
}

/** `?page=` on a record page — the same bounded parse the listings make. */
export function parsePage(raw: string | undefined): number {
  const page = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(page) && page >= 1 ? Math.min(page, 10_000) : 1;
}

/** The canonical URLs. Written once so nothing composes them by hand. */
export const sampleHref = (sampleId: number, page = 1) =>
  page > 1 ? `/samples/${sampleId}?page=${page}` : `/samples/${sampleId}`;
export const specimenHref = (specimenId: number) => `/specimens/${specimenId}`;

/**
 * What happened to this sample, newest first (beeline-ewl). Addressed by the
 * reference the STORE derives — collector as the overlay names them, number,
 * start date — which the log's fold has followed every recorded move to. A
 * sample whose collector no reference names has no history to ask for, and
 * an unreadable log answers empty rather than taking the page down: the log
 * records the store, it does not gate it.
 */
export async function sampleChangeHistory(
  db: Kysely<Database>,
  changesPath: string,
  sampleId: number,
): Promise<SampleChange[]> {
  try {
    const found = await sql<{ collector: string | null; sample_number: string; date_start: string }>`
      ${sql.raw(SAMPLE_STATE_SQL)}
      WHERE s.entity_id = ${sql.lit(Math.trunc(sampleId))}`.execute(db);
    const row = found.rows[0];
    if (row === undefined || row.collector === null) return [];
    const changes = await readSampleChanges(changesPath);
    return sampleHistory(changes, {
      collector: row.collector,
      sample_number: row.sample_number,
      date_start: String(row.date_start),
    });
  } catch (err) {
    console.warn(`could not read the sample change log: ${(err as Error).message}`);
    return [];
  }
}
