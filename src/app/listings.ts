import { sql, type Kysely } from "kysely";
import { PROGRAM_MEMBERSHIP, type Database, type DeterminationQualifier, type SampleKind } from "../model.js";
import { labelName } from "../person-name.js";

/**
 * Browsing the collection: the query layer behind /samples and /specimens.
 *
 * The QC home answers "what needs my attention"; these listings answer
 * "what is there" — for a volunteer, everything they collected; for staff
 * helping someone, an atlas or the whole program. Scope, filters, and page
 * all live in the query string, so a filtered listing is a URL a staff
 * member can paste into an email (beeline-2c3.21).
 *
 * Coordinates ride along. They are the collector's own — recorded on their
 * own observation, printed on their own labels — and CONTEXT.md's stance is
 * that anyone trusted with this store is trusted with them; the open per-atlas
 * question (docs/questions.md) is about revealing taxon-obscured coordinates
 * *downstream*, on labels and in Ecdysis/GBIF exports, not about showing a
 * participant their own data. What a row carries travels with it: a record
 * whose coordinates are obscured upstream says so in its own columns, so
 * nothing is republished in ignorance.
 *
 * The one thing this module does not do is decide who may use which scope —
 * that gate is the caller's, applied at parse time.
 */

/** Rows per page. Big enough to scan, small enough to render fast. */
export const PAGE_SIZE = 50;
/**
 * The cap on the People download, which is built in one piece: a roster is
 * hundreds of rows, so this is a guard rather than a limit anyone meets. The
 * samples and specimens downloads stream the whole selection (csvStream).
 */
export const CSV_ROW_LIMIT = 20_000;

const exportStampParts = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "America/Los_Angeles",
});

/**
 * A download's file name, stamped with when it was taken (GitHub #106):
 * `beeline-samples-2026-09-28-140507.csv`. Two exports of one listing are two
 * versions of it, and a browser saving both as `beeline-samples (1).csv`
 * leaves nobody able to say which is newer. Pacific time, as every instant
 * the app shows is, and to the second; year first so the names sort in the
 * order they were taken; no colons, which Windows refuses in a file name.
 */
export function exportFilename(base: string, at: Date): string {
  const p = Object.fromEntries(exportStampParts.formatToParts(at).map((x) => [x.type, x.value]));
  return `${base}-${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}${p.second}.csv`;
}

/** The scope every volunteer has, and the only one they have. */
export const MINE = "mine";
/** Every atlas at once — the staff escape hatch for cross-atlas questions. */
export const ALL = "all";
/**
 * Collected somewhere no member atlas covers: Nevada, Kansas, the Yukon —
 * 632 samples that are real Master Melittologist records and were reachable
 * only through ALL (beeline-lcl). A scope, not a membership: most of them are
 * atlas members travelling, which is why `member` is a separate control.
 */
export const OUTSIDE = "outside";

/**
 * Whose records, by where their collector belongs — the other axis, and it
 * genuinely is a second one. Scope asks where a sample was collected; this
 * asks who collected it, and the two disagree for every OBA volunteer's
 * Nevada trip. Staff-only, like the collector box, and for the same reason.
 */
export type MemberFilter = string;
/** Nobody has recorded where this collector belongs — not "no atlas applies". */
export const MEMBER_UNRECORDED = "unrecorded";
/** Any membership: the filter off. */
export const MEMBER_ANY = "";

/**
 * QC status as a filter: the three buckets a row's chip can show, and they
 * are disjoint. "warning" means warnings *and no blocking finding*, which
 * is the question a person actually asks ("what is only a heads-up?").
 */
export type QcStatus = "any" | "flagged" | "blocking" | "warning" | "clean";
export const QC_STATUSES = ["any", "flagged", "blocking", "warning", "clean"] as const;

/**
 * Whether a specimen has been determined. A taxon name only ever finds
 * determined specimens, so the gap — "what is still waiting for a name?" —
 * needs its own control (Peter, 2026-08-23).
 */
export type DeterminationState = "any" | "determined" | "undetermined";
export const DETERMINATION_STATES = ["any", "determined", "undetermined"] as const;

/**
 * What a listing is ordered by. Every column that can be sorted names its
 * key here, and a key means the same thing on both listings where both have
 * the column. The default — newest first, then the collector's own numbering
 * — is `date` descending, and stays out of the URL.
 */
export type SortKey =
  | "date"
  | "number"
  | "field"
  | "collector"
  | "place"
  | "host"
  | "specimens"
  | "flags"
  | "atlas"
  | "determination"
  | "determiner"
  | "determined";
export const SORT_KEYS = [
  "date",
  "number",
  "field",
  "collector",
  "place",
  "host",
  "specimens",
  "flags",
  "atlas",
  "determination",
  "determiner",
  "determined",
] as const;
export type SortDirection = "asc" | "desc";
export const DEFAULT_SORT: SortKey = "date";
/** Newest first is the default for dates; everything else reads A–Z or smallest first. */
export const defaultDirection = (key: SortKey): SortDirection =>
  key === "date" || key === "determined" ? "desc" : "asc";

export interface ListingQuery {
  /** MINE, ALL, or an atlas code. */
  scope: string;
  /** Free text: sample number, collector name, field number. */
  q: string;
  /** Inclusive ISO dates bounding the collecting window; null = unbounded. */
  from: string | null;
  to: string | null;
  /** Matches any of locality, county, state/province, country. */
  place: string;
  /**
   * A collector's name or iNat login — staff only, because a volunteer's
   * listing is already one collector's. Matches anyone on the sample, not
   * just its primary (beeline-77j).
   */
  collector: string;
  /**
   * An atlas code, PROGRAM_MEMBERSHIP, MEMBER_UNRECORDED, or MEMBER_ANY —
   * matching any collector on the sample, as the collector filter does.
   */
  member: MemberFilter;
  /** A taxon name; anything below it in the taxonomy matches too. */
  taxon: string;
  /** The floral host, as the observation named it. */
  host: string;
  /**
   * On specimens, whether this specimen carries a determination of record. On
   * samples, whether every specimen does: "undetermined" is a sample with at
   * least one specimen still waiting for a name.
   */
  det: DeterminationState;
  qc: QcStatus;
  sort: SortKey;
  dir: SortDirection;
  /** 1-based. */
  page: number;
}

export const EMPTY_QUERY: ListingQuery = {
  scope: MINE,
  q: "",
  from: null,
  to: null,
  place: "",
  collector: "",
  member: MEMBER_ANY,
  taxon: "",
  host: "",
  det: "any",
  qc: "any",
  sort: DEFAULT_SORT,
  dir: defaultDirection(DEFAULT_SORT),
  page: 1,
};

/** A real calendar date in ISO form — shape alone would admit 2026-13-99. */
function isoDay(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  // Round-tripping catches the impossible days a regex cannot: Feb 31st
  // parses to March, and month 13 does not parse at all.
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}
/** Free-text fields are trimmed and bounded — a filter is not an essay. */
const text = (value: string | null) => (value ?? "").trim().slice(0, 100);

/**
 * Query string → a query, with the scope gate applied here rather than in
 * the route: a parsed query is already one this session is allowed to run.
 * `preferred` is the scope this person last chose (remembered in a cookie),
 * used only when the URL doesn't say.
 */
export function parseListingQuery(
  params: URLSearchParams,
  opts: { admin: boolean; atlasCodes: readonly string[]; preferred?: string | null },
): ListingQuery {
  const requested = params.get("scope") ?? opts.preferred ?? MINE;
  const permitted =
    opts.admin && (requested === ALL || requested === OUTSIDE || opts.atlasCodes.includes(requested));
  const member = params.get("member") ?? "";
  const memberPermitted =
    opts.admin &&
    (member === PROGRAM_MEMBERSHIP || member === MEMBER_UNRECORDED || opts.atlasCodes.includes(member));
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const qc = params.get("qc") ?? "";
  const det = params.get("det") ?? "";
  const sortParam = params.get("sort") ?? "";
  const sort = (SORT_KEYS as readonly string[]).includes(sortParam) ? (sortParam as SortKey) : DEFAULT_SORT;
  const dirParam = params.get("dir");
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  return {
    scope: permitted ? requested : MINE,
    q: text(params.get("q")),
    from: isoDay(from),
    to: isoDay(to),
    place: text(params.get("place")),
    // Scoped like the scope control: only staff read beyond themselves.
    collector: opts.admin ? text(params.get("collector")) : "",
    member: memberPermitted ? member : MEMBER_ANY,
    taxon: text(params.get("taxon")),
    host: text(params.get("host")),
    det: (DETERMINATION_STATES as readonly string[]).includes(det) ? (det as DeterminationState) : "any",
    sort,
    dir: dirParam === "asc" || dirParam === "desc" ? dirParam : defaultDirection(sort),
    qc: (QC_STATUSES as readonly string[]).includes(qc) ? (qc as QcStatus) : "any",
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, 10_000) : 1,
  };
}

/**
 * The query as URL parameters, with some parts changed — paging, scope,
 * reset. One function, because a column menu's form has to carry the rest
 * of the query as hidden inputs and a link has to carry it in its href, and
 * the two must agree about what a default looks like.
 */
export function listingParams(query: ListingQuery, overrides: Partial<ListingQuery> = {}): URLSearchParams {
  const merged = { ...query, ...overrides };
  const params = new URLSearchParams();
  // Defaults stay out of the URL, so the plain path is the plain listing —
  // with one exception, because scope has no single default. MINE is the
  // default for a volunteer, who cannot reach anything else; for staff,
  // parseListingQuery falls back to the remembered scope cookie, so a link
  // that omits scope resolves to whatever that person last browsed. Dropping
  // an explicitly requested MINE therefore turned the QC home's "1 older
  // sample of yours still carries a flag / Show them" into a link to
  // everybody's, the count and the destination disagreeing about whose
  // samples they were (beeline-3kl).
  //
  // So naming scope in `overrides` is a statement, and it is honoured even
  // when the value is the default. A caller that passes no scope keeps the
  // old rule and stays out of the URL.
  if (overrides.scope !== undefined || merged.scope !== MINE) params.set("scope", merged.scope);
  if (merged.q !== "") params.set("q", merged.q);
  if (merged.from !== null) params.set("from", merged.from);
  if (merged.to !== null) params.set("to", merged.to);
  if (merged.place !== "") params.set("place", merged.place);
  if (merged.collector !== "") params.set("collector", merged.collector);
  if (merged.member !== MEMBER_ANY) params.set("member", merged.member);
  if (merged.taxon !== "") params.set("taxon", merged.taxon);
  if (merged.host !== "") params.set("host", merged.host);
  if (merged.det !== "any") params.set("det", merged.det);
  if (merged.qc !== "any") params.set("qc", merged.qc);
  // The sort is in the URL only when it is not the default, and the
  // direction only when it is not the key's own default — so a link that
  // sorts by date newest-first is the plain listing.
  if (merged.sort !== DEFAULT_SORT) params.set("sort", merged.sort);
  if (merged.dir !== defaultDirection(merged.sort)) params.set("dir", merged.dir);
  if (merged.page > 1) params.set("page", String(merged.page));
  return params;
}

/** The listing's own URL, with some parts changed — paging, scope, reset. */
export function listingHref(path: string, query: ListingQuery, overrides: Partial<ListingQuery> = {}): string {
  const search = listingParams(query, overrides).toString();
  return search === "" ? path : `${path}?${search}`;
}

/** Whether any filter (scope aside) is narrowing the listing. */
export const isFiltered = (q: ListingQuery) =>
  q.q !== "" ||
  q.from !== null ||
  q.to !== null ||
  q.place !== "" ||
  q.collector !== "" ||
  q.member !== MEMBER_ANY ||
  q.taxon !== "" ||
  q.host !== "" ||
  q.det !== "any" ||
  q.qc !== "any";

export interface AtlasOption {
  code: string;
  name: string;
}

export async function atlasOptions(db: Kysely<Database>): Promise<AtlasOption[]> {
  return db.selectFrom("atlas").select(["code", "name"]).orderBy("name").execute();
}

/**
 * The taxa a taxon filter names: everything whose name starts with the term,
 * plus everything below them. Resolved to ids in one small query rather than
 * a correlated recursive subquery, because `animal` is thousands of rows and
 * the listing is tens of thousands — the expansion belongs on the small side.
 * A genus term also matches its species directly (names are binomials), but
 * the descent is what makes a family or an order work.
 */
export async function taxonIds(db: Kysely<Database>, term: string): Promise<number[]> {
  const prefix = `${term.toLowerCase()}%`;
  const result = await sql<{ entity_id: number }>`
    WITH RECURSIVE matched(entity_id) AS (
      SELECT entity_id FROM animal WHERE lower(scientific_name) LIKE ${prefix}
      UNION
      SELECT child.entity_id FROM animal child JOIN matched ON child.parent_id = matched.entity_id
    )
    SELECT entity_id FROM matched
  `.execute(db);
  return result.rows.map((row) => Number(row.entity_id));
}

export interface SampleRow {
  sample_id: number;
  sample_number: string;
  kind: SampleKind;
  date_start: Date;
  date_end: Date;
  locality: string | null;
  county: string | null;
  state_province: string | null;
  country: string | null;
  protocol: string | null;
  specimen_count: number;
  inat_observation_id: bigint | null;
  atlas_code: string | null;
  host_name: string | null;
  host_rank: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinate_uncertainty_m: number | null;
  elevation_m: number | null;
  location_source: string | null;
  geoprivacy: string | null;
  taxon_geoprivacy: string | null;
  blocking: number;
  warning: number;
  /** Whether the viewer is one of this sample's collectors. */
  mine: boolean;
}

export interface SpecimenRow {
  specimen_id: number;
  specimen_number: number;
  field_number: string | null;
  /**
   * No number, but a label: minted in a run that was then canceled, which
   * burned the number, and waiting for the next freeze to number it again.
   * Distinguishes that from an imported specimen whose label predates field
   * numbering, which the cell used to call both (beeline-1kb.21).
   */
  awaiting_number: boolean;
  sample_id: number;
  sample_number: string;
  date_start: Date;
  date_end: Date;
  locality: string | null;
  county: string | null;
  state_province: string | null;
  country: string | null;
  protocol: string | null;
  /** The specimen's persistent identity downstream (ADR 0008); null for an imported specimen until one is minted. */
  occurrence_id: string | null;
  atlas_code: string | null;
  /** The sample's floral host, as the observation named it — a column here as on the samples listing. */
  host_name: string | null;
  host_rank: string | null;
  taxon_rank: string | null;
  scientific_name: string | null;
  authorship: string | null;
  qualifier: DeterminationQualifier | null;
  verbatim_identification: string | null;
  sex: string | null;
  is_expert: boolean | null;
  determiner: string | null;
  /** When the determination of record was made; null where its source did not say. */
  determined_on: Date | null;
  /** How much of that date the source stated; null is the day (beeline-9ut). */
  determined_on_precision: "month" | "year" | null;
  latitude: number | null;
  longitude: number | null;
  coordinate_uncertainty_m: number | null;
  elevation_m: number | null;
  location_source: string | null;
  geoprivacy: string | null;
  taxon_geoprivacy: string | null;
}

/**
 * A collector, in both forms the app needs: the full name a screen and a
 * Darwin Core export use, and the label form a 3pt label has room for
 * (src/person-name.ts). A listing shows the label form, because the question
 * a listing answers about a collector is whose name is going to be printed.
 */
export interface ListedCollector {
  display: string;
  label: string;
}

export interface Page<Row> {
  rows: Row[];
  /** Rows the filters select in total, not the page's length. */
  total: number;
  /** sample_id → everyone who collected it, in recordedBy order. */
  collectors: Map<number, ListedCollector[]>;
}

const like = (term: string) => `%${term.toLowerCase()}%`;
/** An ISO date from the query string, compared as a DATE rather than text. */
const asDate = (iso: string) => sql<Date>`CAST(${iso} AS DATE)`;

/**
 * Newest first, and within a day the collector's own numbering — descending,
 * so the last sample of the day is the first one you see. Sample numbers are
 * text ('3', 'OBAS-00657'), so length comes first: for the digit strings a
 * collector actually types that is natural order (12 before 9, not after
 * it), and for a fixed-width trap series it changes nothing. Ordering by the
 * entity id instead would order by upload, and a day's samples reach
 * iNaturalist in whatever order they were photographed (Peter, 2026-08-23).
 */
export const BY_SAMPLE_NUMBER = sql`length(s.sample_number) DESC, s.sample_number DESC`;

/**
 * The same numbering rule in either direction: length first, then the
 * string, so digit strings read in natural order whichever way they run.
 */
const sampleNumber = (dir: SortDirection) =>
  dir === "desc" ? BY_SAMPLE_NUMBER : sql`length(s.sample_number) ASC, s.sample_number ASC`;

/** The primary collector's name as it sorts: family name, then given — whose series the number is. */
const PRIMARY_COLLECTOR_SORT = sql`(SELECT concat_ws(' ', p.family_name, p.given_name, p.display_name)
  FROM sample_primary_collector pc JOIN person p ON p.entity_id = pc.person_id
  WHERE pc.sample_id = s.entity_id)`;

/**
 * A column's ORDER BY. Every key ends in the default order so paging is
 * stable across equal values, and a key a listing does not have falls back
 * to the default rather than erroring — the URL is typed by hand sometimes.
 */
export function sampleOrder(query: ListingQuery) {
  const dir = query.dir === "desc" ? sql`DESC` : sql`ASC`;
  const nulls = sql`NULLS LAST`;
  const byDate = sql`s.date_start ${dir}, ${sampleNumber(query.dir)}`;
  switch (query.sort) {
    case "number":
      return sql`${sampleNumber(query.dir)}, s.date_start DESC`;
    case "collector":
      return sql`${PRIMARY_COLLECTOR_SORT} ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "place":
      return sql`lower(s.locality) ${dir} ${nulls}, lower(s.county) ${dir} ${nulls}, s.state_province ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "host":
      return sql`lower(s.host_name_as_observed) ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "specimens":
      return sql`s.specimen_count ${dir}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "flags":
      // Blocking outranks a warning outranks clean, whichever way it runs.
      return sql`${blockingCount} ${dir}, ${warningCount} ${dir}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "atlas":
      return sql`a.code ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    default:
      return byDate;
  }
}

export function specimenOrder(query: ListingQuery) {
  const dir = query.dir === "desc" ? sql`DESC` : sql`ASC`;
  const nulls = sql`NULLS LAST`;
  const byDate = sql`s.date_start ${dir}, ${sampleNumber(query.dir)}`;
  switch (query.sort) {
    case "field":
      return sql`length(sp.field_number) ${dir} ${nulls}, sp.field_number ${dir} ${nulls}`;
    case "number":
      return sql`${sampleNumber(query.dir)}, s.date_start DESC`;
    case "collector":
      return sql`${PRIMARY_COLLECTOR_SORT} ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "place":
      return sql`lower(s.locality) ${dir} ${nulls}, lower(s.county) ${dir} ${nulls}, s.state_province ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "host":
      return sql`lower(s.host_name_as_observed) ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "determination":
      return sql`an.scientific_name ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "determiner":
      return sql`lower(coalesce(det.display_name, d.determiner_name)) ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "determined":
      return sql`d.determined_on ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "atlas":
      return sql`a.code ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    default:
      return byDate;
  }
}

/**
 * Whoever ran this sample, by display name or iNat login. Anyone on the
 * collector list counts: asking "show me Michael's samples" and getting only
 * the ones he numbered would be the same mistake the list exists to fix.
 */
const collectedBy = (term: string) => sql<boolean>`EXISTS (
  SELECT 1 FROM sample_collector c
  JOIN person p ON p.entity_id = c.person_id
  LEFT JOIN inat_account a ON a.person_id = p.entity_id
  WHERE c.sample_id = s.entity_id
    AND (lower(p.display_name) LIKE ${like(term)} OR lower(a.login) LIKE ${like(term)})
)`;

/**
 * Samples one of whose collectors belongs where the filter says. Any collector
 * on the sample, not only the primary — the same reach as the collector box,
 * because a pair collects together (beeline-77j).
 *
 * MEMBER_UNRECORDED is the absence, and it has to be an anti-join over the
 * whole collector list rather than a NULL test: a sample collected by a WaBA
 * member and someone nobody has asked about is not an unrecorded sample.
 */
const collectedByMember = (member: MemberFilter) =>
  member === MEMBER_UNRECORDED
    ? sql<boolean>`NOT EXISTS (
        SELECT 1 FROM sample_collector mc
        JOIN person_membership mm ON mm.person_id = mc.person_id
        WHERE mc.sample_id = s.entity_id
      )`
    : member === PROGRAM_MEMBERSHIP
      ? sql<boolean>`EXISTS (
          SELECT 1 FROM sample_collector mc
          JOIN person_membership mm ON mm.person_id = mc.person_id
          WHERE mc.sample_id = s.entity_id AND mm.kind = 'program'
        )`
      : sql<boolean>`EXISTS (
          SELECT 1 FROM sample_collector mc
          JOIN person_membership mm ON mm.person_id = mc.person_id
          JOIN atlas ma ON ma.entity_id = mm.atlas_id
          WHERE mc.sample_id = s.entity_id AND ma.code = ${member}
        )`;

/**
 * Blocking and warning counts per sample, joined in as one pass over
 * sample_qc_finding rather than an EXISTS per row. Reading the roll-up rather
 * than qc_finding directly is what keeps a chip and printability agreeing once
 * a specimen-level rule exists: a finding on a specimen is a flag on its
 * sample, and both sides now learn that from the same view (beeline-2c3.29).
 *
 * Spelled inline in both listings rather than hoisted: Kysely types a joined
 * subquery against the query it lands in, and the two listings have
 * different shapes.
 */
const QC_COUNT_SELECTIONS = [
  sql<number>`CAST(sum(CASE WHEN r.severity = 'blocking' THEN 1 ELSE 0 END) AS INTEGER)`.as("blocking"),
  sql<number>`CAST(sum(CASE WHEN r.severity = 'warning' THEN 1 ELSE 0 END) AS INTEGER)`.as("warning"),
] as const;

/** The place columns as one haystack: a person types a place, not a column. */
const placeHaystack = sql<string>`lower(concat_ws(' ', s.locality, s.county, s.state_province, s.country))`;

const blockingCount = sql<number>`coalesce(qc.blocking, 0)`;
const warningCount = sql<number>`coalesce(qc.warning, 0)`;

/**
 * The QC filter as a predicate over the joined counts — null for "any", so
 * the default listing adds no condition at all.
 */
function qcPredicate(status: QcStatus) {
  switch (status) {
    // Everything carrying a flag of either severity — where the dashboard
    // sends you for the seasons it has stopped asking about (beeline-2c3.24).
    case "flagged":
      return sql<boolean>`${blockingCount} > 0 OR ${warningCount} > 0`;
    case "blocking":
      return sql<boolean>`${blockingCount} > 0`;
    case "warning":
      return sql<boolean>`${blockingCount} = 0 AND ${warningCount} > 0`;
    case "clean":
      return sql<boolean>`${blockingCount} = 0 AND ${warningCount} = 0`;
    case "any":
      return null;
  }
}

export async function listSamples(
  db: Kysely<Database>,
  query: ListingQuery,
  personId: number,
  opts: { limit?: number; offset?: number } = {},
): Promise<Page<SampleRow>> {
  const animals = query.taxon === "" ? null : await taxonIds(db, query.taxon);
  let base = db
    .selectFrom("sample as s")
    .leftJoin("sample_atlas as sa", "sa.sample_id", "s.entity_id")
    .leftJoin("atlas as a", "a.entity_id", "sa.atlas_id")
    // One row per sample (it is the PK), so this cannot fan the listing out.
    .leftJoin("sample_location as loc", "loc.sample_id", "s.entity_id")
    .leftJoin(
      (eb) =>
        eb
          .selectFrom("sample_qc_finding as f")
          .innerJoin("qc_rule as r", "r.name", "f.rule_name")
          .where("f.sample_id", "is not", null)
          .groupBy("f.sample_id")
          .select(["f.sample_id as sample_id", ...QC_COUNT_SELECTIONS])
          .as("qc"),
      (join) => join.onRef("qc.sample_id", "=", "s.entity_id"),
    );

  if (query.scope === MINE) {
    base = base.where(({ exists, selectFrom }) =>
      exists(
        selectFrom("sample_collector as mine")
          .select("mine.sample_id")
          .whereRef("mine.sample_id", "=", "s.entity_id")
          .where("mine.person_id", "=", personId),
      ),
    );
  } else if (query.scope === OUTSIDE) {
    // Outside = no atlas, whether geography said so (no sample_atlas row —
    // the LEFT JOIN gives a NULL) or a human did (a row with a NULL atlas).
    base = base.where("sa.atlas_id", "is", null);
  } else if (query.scope !== ALL) {
    base = base.where("a.code", "=", query.scope);
  }
  // Overlap, not containment: a trap sample that was out across the window's
  // start belongs in a window that names its end.
  if (query.from !== null) base = base.where("s.date_end", ">=", asDate(query.from));
  if (query.to !== null) base = base.where("s.date_start", "<=", asDate(query.to));
  if (query.place !== "") base = base.where(sql<boolean>`${placeHaystack} LIKE ${like(query.place)}`);
  if (query.collector !== "") base = base.where(collectedBy(query.collector));
  if (query.member !== MEMBER_ANY) base = base.where(collectedByMember(query.member));
  if (query.q !== "") {
    const needle = like(query.q);
    base = base.where(({ eb, or, exists, selectFrom }) =>
      or([
        eb(sql<string>`lower(s.sample_number)`, "like", needle),
        // The same match the collector filter makes, so one name behaves the
        // same way in both boxes.
        collectedBy(query.q),
        exists(
          selectFrom("specimen as sp")
            .select("sp.entity_id")
            .whereRef("sp.sample_id", "=", "s.entity_id")
            .where(sql<string>`lower(sp.field_number)`, "like", needle),
        ),
      ]),
    );
  }
  if (animals !== null) {
    base = base.where(({ exists, selectFrom }) =>
      exists(
        selectFrom("determination_of_record as d")
          .innerJoin("specimen as sp", "sp.entity_id", "d.specimen_id")
          .select("d.entity_id")
          .whereRef("sp.sample_id", "=", "s.entity_id")
          .where("d.animal_id", "in", animals.length === 0 ? [-1] : animals),
      ),
    );
  }
  // "Undetermined" on a sample means at least one of its specimens is still
  // waiting for a name; "determined" means none is, and there is something to
  // determine. A sample with no specimens yet is neither.
  if (query.det === "undetermined") {
    base = base.where(({ exists, selectFrom }) =>
      exists(
        selectFrom("specimen as sp")
          .leftJoin("determination_of_record as d", "d.specimen_id", "sp.entity_id")
          .select("sp.entity_id")
          .whereRef("sp.sample_id", "=", "s.entity_id")
          .where("d.specimen_id", "is", null),
      ),
    );
  } else if (query.det === "determined") {
    base = base
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("specimen as sp")
              .leftJoin("determination_of_record as d", "d.specimen_id", "sp.entity_id")
              .select("sp.entity_id")
              .whereRef("sp.sample_id", "=", "s.entity_id")
              .where("d.specimen_id", "is", null),
          ),
        ),
      )
      // ...and something to have determined: an unprinted sample is neither.
      .where(({ exists, selectFrom }) =>
        exists(selectFrom("specimen as sp").select("sp.entity_id").whereRef("sp.sample_id", "=", "s.entity_id")),
      );
  }
  if (query.host !== "") base = base.where(sql<boolean>`lower(s.host_name_as_observed) LIKE ${like(query.host)}`);
  const qc = qcPredicate(query.qc);
  if (qc !== null) base = base.where(qc);

  const limit = opts.limit ?? PAGE_SIZE;
  const offset = opts.offset ?? (query.page - 1) * PAGE_SIZE;
  const [rows, count] = await Promise.all([
    base
      .select([
        "s.entity_id as sample_id",
        "s.sample_number",
        "s.kind",
        "s.date_start",
        "s.date_end",
        "s.locality",
        "s.county",
        "s.state_province",
        "s.country",
        "s.protocol",
        "s.specimen_count",
        "s.inat_observation_id",
        "a.code as atlas_code",
        "s.host_name_as_observed as host_name",
        "s.host_rank",
        "loc.latitude",
        "loc.longitude",
        "loc.coordinate_uncertainty_m",
        "loc.elevation_m",
        "loc.source as location_source",
        "s.geoprivacy",
        "s.taxon_geoprivacy",
        blockingCount.as("blocking"),
        warningCount.as("warning"),
        sql<boolean>`EXISTS (SELECT 1 FROM sample_collector mine
                             WHERE mine.sample_id = s.entity_id AND mine.person_id = ${personId})`.as("mine"),
      ])
      .orderBy(sampleOrder(query))
      .orderBy("s.entity_id")
      .limit(limit)
      .offset(offset)
      .execute(),
    base.select(({ fn }) => fn.countAll().as("n")).executeTakeFirst(),
  ]);
  const sampleRows = rows as unknown as SampleRow[];
  return {
    rows: sampleRows,
    total: Number(count?.n ?? 0),
    collectors: await collectorsOf(db, sampleRows.map((r) => r.sample_id)),
  };
}

export async function listSpecimens(
  db: Kysely<Database>,
  query: ListingQuery,
  personId: number,
  opts: { limit?: number; offset?: number } = {},
): Promise<Page<SpecimenRow>> {
  const animals = query.taxon === "" ? null : await taxonIds(db, query.taxon);
  let base = db
    .selectFrom("specimen as sp")
    .innerJoin("sample as s", "s.entity_id", "sp.sample_id")
    .leftJoin("sample_atlas as sa", "sa.sample_id", "s.entity_id")
    .leftJoin("atlas as a", "a.entity_id", "sa.atlas_id")
    .leftJoin("sample_location as loc", "loc.sample_id", "s.entity_id")
    .leftJoin(
      (eb) =>
        eb
          .selectFrom("sample_qc_finding as f")
          .innerJoin("qc_rule as r", "r.name", "f.rule_name")
          .where("f.sample_id", "is not", null)
          .groupBy("f.sample_id")
          .select(["f.sample_id as sample_id", ...QC_COUNT_SELECTIONS])
          .as("qc"),
      (join) => join.onRef("qc.sample_id", "=", "s.entity_id"),
    )
    .leftJoin("determination_of_record as d", "d.specimen_id", "sp.entity_id")
    .leftJoin("animal as an", "an.entity_id", "d.animal_id")
    .leftJoin("person as det", "det.entity_id", "d.determiner_id");

  if (query.scope === MINE) {
    base = base.where(({ exists, selectFrom }) =>
      exists(
        selectFrom("sample_collector as mine")
          .select("mine.sample_id")
          .whereRef("mine.sample_id", "=", "s.entity_id")
          .where("mine.person_id", "=", personId),
      ),
    );
  } else if (query.scope === OUTSIDE) {
    // Outside = no atlas, whether geography said so (no sample_atlas row —
    // the LEFT JOIN gives a NULL) or a human did (a row with a NULL atlas).
    base = base.where("sa.atlas_id", "is", null);
  } else if (query.scope !== ALL) {
    base = base.where("a.code", "=", query.scope);
  }
  if (query.from !== null) base = base.where("s.date_end", ">=", asDate(query.from));
  if (query.to !== null) base = base.where("s.date_start", "<=", asDate(query.to));
  if (query.place !== "") base = base.where(sql<boolean>`${placeHaystack} LIKE ${like(query.place)}`);
  if (query.collector !== "") base = base.where(collectedBy(query.collector));
  if (query.member !== MEMBER_ANY) base = base.where(collectedByMember(query.member));
  if (query.q !== "") {
    const needle = like(query.q);
    base = base.where(({ eb, or, exists, selectFrom }) =>
      or([
        eb(sql<string>`lower(sp.field_number)`, "like", needle),
        eb(sql<string>`lower(s.sample_number)`, "like", needle),
        // The same match the collector filter makes, so one name behaves the
        // same way in both boxes.
        collectedBy(query.q),
      ]),
    );
  }
  // On a specimen listing the taxon filter is about *this* specimen's
  // determination, not its sample's — two specimens from one sample are
  // routinely different bees.
  if (animals !== null) base = base.where("d.animal_id", "in", animals.length === 0 ? [-1] : animals);
  if (query.det === "undetermined") base = base.where("d.specimen_id", "is", null);
  if (query.det === "determined") base = base.where("d.specimen_id", "is not", null);
  if (query.host !== "") base = base.where(sql<boolean>`lower(s.host_name_as_observed) LIKE ${like(query.host)}`);
  const qc = qcPredicate(query.qc);
  if (qc !== null) base = base.where(qc);

  const limit = opts.limit ?? PAGE_SIZE;
  const offset = opts.offset ?? (query.page - 1) * PAGE_SIZE;
  const [rows, count] = await Promise.all([
    base
      .select([
        "sp.entity_id as specimen_id",
        "sp.specimen_number",
        "sp.field_number",
        sql<boolean>`sp.field_number IS NULL AND EXISTS (SELECT 1 FROM printed_label pl WHERE pl.specimen_id = sp.entity_id)`.as(
          "awaiting_number",
        ),
        "s.entity_id as sample_id",
        "s.sample_number",
        "s.date_start",
        "s.date_end",
        "s.locality",
        "s.county",
        "s.state_province",
        "s.country",
        "s.protocol",
        "sp.occurrence_id",
        "a.code as atlas_code",
        "s.host_name_as_observed as host_name",
        "s.host_rank",
        "an.rank as taxon_rank",
        "an.scientific_name",
        "an.authorship",
        "d.qualifier",
        "d.verbatim_identification",
        "d.sex",
        "d.is_expert",
        "d.determined_on",
        "d.determined_on_precision",
        "loc.latitude",
        "loc.longitude",
        "loc.coordinate_uncertainty_m",
        "loc.elevation_m",
        "loc.source as location_source",
        "s.geoprivacy",
        "s.taxon_geoprivacy",
        sql<string | null>`coalesce(det.display_name, d.determiner_name)`.as("determiner"),
      ])
      .orderBy(specimenOrder(query))
      .orderBy("sp.sample_id")
      .orderBy("sp.specimen_number")
      .limit(limit)
      .offset(offset)
      .execute(),
    base.select(({ fn }) => fn.countAll().as("n")).executeTakeFirst(),
  ]);
  const specimenRows = rows as unknown as SpecimenRow[];
  return {
    rows: specimenRows,
    total: Number(count?.n ?? 0),
    collectors: await collectorsOf(db, specimenRows.map((r) => r.sample_id)),
  };
}

/**
 * Everyone who collected these samples, in recordedBy order. A second
 * collector is not a spectator (beeline-77j), so every listing names the
 * whole list, not sample.collector_id.
 */
export async function collectorsOf(
  db: Kysely<Database>,
  sampleIds: number[],
): Promise<Map<number, ListedCollector[]>> {
  const names = new Map<number, ListedCollector[]>();
  if (sampleIds.length === 0) return names;
  const rows = await db
    .selectFrom("sample_collector as c")
    .innerJoin("person as p", "p.entity_id", "c.person_id")
    .where("c.sample_id", "in", [...new Set(sampleIds)])
    .select(["c.sample_id", "p.display_name", "p.given_name", "p.family_name", "p.label_name", "c.position"])
    .orderBy("c.position")
    .execute();
  for (const row of rows) {
    const list = names.get(row.sample_id) ?? [];
    list.push({ display: row.display_name, label: labelName(row) });
    names.set(row.sample_id, list);
  }
  return names;
}

/**
 * CSV export.
 *
 * Headers are Darwin Core terms wherever one exists, because these files go
 * on to taxonomists, Ecdysis and GBIF, all of which read Darwin Core (Peter,
 * 2026-09-28: adherence to Darwin Core matters more here than matching the
 * legacy system, which has its own export, src/legacy-export.ts). Two follow
 * ADR 0008: the field number printed on the pin is the collection's number
 * for the specimen, so it is `catalogNumber`; `fieldNumber` is Darwin Core's
 * identifier of the collecting event, which is our sample number. A column
 * Darwin Core has no term for keeps a plain lowerCamelCase name of our own.
 * Coordinates are in it, with their provenance and geoprivacy beside them,
 * so a row carries what a reader needs to judge it.
 *
 * The format is the plain one: UTF-8 with a byte order mark (without it
 * Excel reads an accented name as mojibake), "\n" after every record, a
 * field quoted only when it must be. The whole selection is written, a page
 * at a time, so there is no cap and no line in the file that is not a record.
 */

/** RFC 4180 quoting, plus the leading-punctuation guard spreadsheets need. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  // A number is data, and a negative one is most of our longitudes.
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  let cell = value instanceof Date ? isoDate(value) : String(value);
  // A text cell starting with =, +, -, or @ is a formula to Excel and Sheets;
  // one that is only a number written as text is data like any other.
  if (/^[=+\-@]/.test(cell) && !/^[+-]?\d+(\.\d+)?$/.test(cell)) cell = `'${cell}`;
  return /[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/** One record, with its terminator. */
export const csvLine = (row: readonly unknown[]) => `${row.map(csvCell).join(",")}\n`;

/** UTF-8 byte order mark, first in every file. */
export const CSV_BOM = "﻿";

/** A whole file, for the small exports that are built in one piece. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  return CSV_BOM + csvLine(header) + rows.map(csvLine).join("");
}

/** How many rows each round trip to the store fetches while a download streams. */
export const CSV_PAGE_SIZE = 5_000;

/**
 * A whole selection as a stream: the header, then page after page until the
 * store has none left. The listing queries end in a unique tie-breaker, so
 * paging by offset neither skips nor repeats a row.
 */
export function csvStream<Row>(
  header: readonly string[],
  fetch: (limit: number, offset: number) => Promise<Page<Row>>,
  toRow: (row: Row, page: Page<Row>) => readonly unknown[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let offset = 0;
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(CSV_BOM + csvLine(header)));
        return;
      }
      const page = await fetch(CSV_PAGE_SIZE, offset);
      if (page.rows.length > 0) controller.enqueue(encoder.encode(page.rows.map((r) => csvLine(toRow(r, page))).join("")));
      offset += page.rows.length;
      if (page.rows.length < CSV_PAGE_SIZE) controller.close();
    },
  });
}

/** Dates go out as ISO, whatever shape the driver handed back. */
function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

/** dwc:eventDate: the day, or the ISO 8601 interval a trap sample spans. */
const eventDate = (start: Date | string, end: Date | string) => {
  const [a, b] = [isoDate(start), isoDate(end)];
  return a === b ? a : `${a}/${b}`;
};

/** dwc:countryCode is ISO 3166-1 alpha-2; the store keeps alpha-3. */
const ALPHA2: Record<string, string> = { USA: "US", CAN: "CA", MEX: "MX", NZL: "NZ" };
const countryCode = (country: string | null) => (country === null ? null : (ALPHA2[country] ?? country));

/** dwc:associatedTaxa: the floral host, with the relationship the legacy records also used. */
const associatedTaxa = (host: string | null) => (host === null || host === "" ? null : `visits flowers of: ${host}`);

/** Where a coordinate is stated, its datum is: iNaturalist's, and every GPS's, is WGS84. */
const datum = (latitude: number | null) => (latitude === null ? null : "WGS84");

const qcLabel = (row: { blocking: number; warning: number }) =>
  row.blocking > 0 ? "blocking" : row.warning > 0 ? "warning" : "clean";

const recordedBy = <Row>(page: Page<Row>, sampleId: number) =>
  (page.collectors.get(sampleId) ?? []).map((c) => c.display).join(" | ");

/** The samples download: one collecting event per row. */
export const SAMPLE_CSV_HEADER = [
  "fieldNumber",
  "eventDate",
  "samplingProtocol",
  "recordedBy",
  "countryCode",
  "stateProvince",
  "county",
  "locality",
  "decimalLatitude",
  "decimalLongitude",
  "geodeticDatum",
  "coordinateUncertaintyInMeters",
  "minimumElevationInMeters",
  "maximumElevationInMeters",
  "associatedTaxa",
  // Beeline's own, with no Darwin Core term.
  "kind",
  "specimenCount",
  "hostRank",
  "atlas",
  "locationSource",
  "geoprivacy",
  "taxonGeoprivacy",
  "qcStatus",
  "inatObservationId",
] as const;

export const sampleCsvRow = (r: SampleRow, page: Page<SampleRow>): unknown[] => [
  r.sample_number,
  eventDate(r.date_start, r.date_end),
  r.protocol,
  recordedBy(page, r.sample_id),
  countryCode(r.country),
  r.state_province,
  r.county,
  r.locality,
  r.latitude,
  r.longitude,
  datum(r.latitude),
  r.coordinate_uncertainty_m,
  r.elevation_m,
  r.elevation_m,
  associatedTaxa(r.host_name),
  r.kind,
  r.specimen_count,
  r.host_rank,
  r.atlas_code,
  r.location_source,
  r.geoprivacy,
  r.taxon_geoprivacy,
  qcLabel(r),
  r.inat_observation_id,
];

/** The specimens download: one occurrence per row, a preserved specimen. */
export const SPECIMEN_CSV_HEADER = [
  "occurrenceID",
  "basisOfRecord",
  "catalogNumber",
  "fieldNumber",
  "eventDate",
  "samplingProtocol",
  "recordedBy",
  "countryCode",
  "stateProvince",
  "county",
  "locality",
  "decimalLatitude",
  "decimalLongitude",
  "geodeticDatum",
  "coordinateUncertaintyInMeters",
  "minimumElevationInMeters",
  "maximumElevationInMeters",
  "associatedTaxa",
  "scientificName",
  "scientificNameAuthorship",
  "taxonRank",
  "identificationQualifier",
  "verbatimIdentification",
  "sex",
  "identifiedBy",
  "dateIdentified",
  // Beeline's own, with no Darwin Core term.
  "specimenNumber",
  "atlas",
  "hostRank",
  "locationSource",
  "geoprivacy",
  "taxonGeoprivacy",
  "identifiedByExpert",
] as const;

export const specimenCsvRow = (r: SpecimenRow, page: Page<SpecimenRow>): unknown[] => [
  r.occurrence_id,
  "PreservedSpecimen",
  r.field_number,
  r.sample_number,
  eventDate(r.date_start, r.date_end),
  r.protocol,
  recordedBy(page, r.sample_id),
  countryCode(r.country),
  r.state_province,
  r.county,
  r.locality,
  r.latitude,
  r.longitude,
  datum(r.latitude),
  r.coordinate_uncertainty_m,
  r.elevation_m,
  r.elevation_m,
  associatedTaxa(r.host_name),
  r.scientific_name,
  r.authorship,
  r.taxon_rank,
  r.qualifier,
  r.verbatim_identification,
  r.sex,
  r.determiner,
  // As Darwin Core would have it: a year-only date is the year, not January 1st.
  r.determined_on === null
    ? null
    : r.determined_on_precision === "year"
      ? isoDate(r.determined_on).slice(0, 4)
      : r.determined_on_precision === "month"
        ? isoDate(r.determined_on).slice(0, 7)
        : isoDate(r.determined_on),
  r.specimen_number,
  r.atlas_code,
  r.host_rank,
  r.location_source,
  r.geoprivacy,
  r.taxon_geoprivacy,
  r.is_expert === null ? null : String(r.is_expert),
];
