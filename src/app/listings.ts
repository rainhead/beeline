import { createHash } from "node:crypto";
import { sql, type Kysely, type RawBuilder, type SelectQueryBuilder } from "kysely";
import { REPRINT_BLOCKER, type ReprintBlocker } from "../print-run.js";
import { reportError } from "./error-reporting.js";
import type { CsvTiming } from "./request-timing.js";
import { PROGRAM_MEMBERSHIP, type AreaKind, type Database, type DeterminationQualifier, type SampleKind } from "../model.js";
import { labelName } from "../person-name.js";
import { orcidUrl } from "../orcid.js";
import { ECDYSIS_COLLECTIONS } from "../fetch-ecdysis.js";
import { plantRelationship } from "../trap-method.js";
import { xlsxWriter, type XlsxWriterOptions } from "./xlsx.js";

/**
 * Browsing the collection: the query layer behind /samples and /specimens.
 *
 * The QC home answers "what needs my attention"; these listings answer
 * "what is there" — their own collecting by default, and an atlas or the
 * whole program for anyone who asks, volunteers included: a volunteer can
 * see every record, at minimum what iNaturalist already shows them (Peter,
 * 2026-10-23, beeline-20w3). Scope, filters, and page all live in the query
 * string, so a filtered listing is a URL anyone can paste into an email
 * (beeline-2c3.21).
 *
 * Coordinates ride along, with one exception, which is what iNaturalist
 * itself withholds. Where a sample's observation is obscured or private
 * there — the observer's own geoprivacy, or a host plant iNaturalist treats
 * as rare — somebody who is neither staff nor one of its collectors gets no
 * location for it: no coordinates, uncertainty or elevation, no locality,
 * and for a private observation no county. iNaturalist's own shifted point
 * is not offered in their place; nobody has a use for it yet. The rule is
 * applied in the query (`withheld`), not in the view, so the place filter
 * and the place sort read the hidden values too and a search cannot find a
 * record by a locality it would not show. What a row carries otherwise
 * travels with it: a record whose coordinates are obscured upstream says so
 * in its own columns, so nothing is republished in ignorance.
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
export function exportFilename(base: string, at: Date, extension = "csv"): string {
  const p = Object.fromEntries(exportStampParts.formatToParts(at).map((x) => [x.type, x.value]));
  return `${base}-${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}${p.second}.${extension}`;
}

/** The viewer's own collecting: where a listing starts. */
export const MINE = "mine";
/** Every atlas at once. */
export const ALL = "all";
/**
 * Collected somewhere no member atlas covers: Nevada, Kansas, the Yukon —
 * 632 samples that are real Master Melittologist records and were reachable
 * only through ALL (beeline-lcl). A scope, not a membership: most of them are
 * atlas members travelling, which is why `member` is a separate control.
 */
export const OUTSIDE = "outside";
/**
 * The National Wildlife Refuges program (beeline-t0rh). Not an atlas, so no
 * state assigns a sample to it: a sample is its program's when its true point
 * lies inside a refuge area (schema/038), the one fact that identifies it
 * until the program is linked to its refuges (beeline-8zlh). Also an atlas's
 * sample by state, and both choices find it.
 */
export const REFUGES = "NWR";
/** Master Melittology, the catch-all program: today exactly the samples no atlas covers, as OUTSIDE finds. */
export const CATCH_ALL = "MM";

/**
 * Whose records, by where their collector belongs — the other axis, and it
 * genuinely is a second one. Scope asks where a sample was collected; this
 * asks who collected it, and the two disagree for every OBA volunteer's
 * Nevada trip.
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
export type QcStatus = "any" | "flagged" | "blocking" | "warning" | "clean" | "locality";

/**
 * Every QC rule, for the Flags column's "kind of flag" filter (beeline-ik0d).
 * The schema is the authority (qc_rule, schema/050); a test holds this list
 * to it, as it holds the message catalog's keys.
 */
export const QC_RULE_NAMES = [
  "missing_required_field",
  "missing_recommended_field",
  "obscured_no_true_coordinates",
  "locality_format",
  "place_unabbreviated",
  "place_unrecognised",
  "coordinate_uncertainty",
  "coordinate_out_of_region",
  "non_tracheophyte_host",
  "duplicate_sample_number",
  "count_mismatch",
  "count_below_printed",
  "within_sample_disagreement",
  "observation_missing_upstream",
  "staff_hold",
] as const;
export type QcRuleName = (typeof QC_RULE_NAMES)[number];
export const QC_STATUSES = ["any", "flagged", "blocking", "warning", "clean", "locality"] as const;

/**
 * Whether a specimen has been determined. A taxon name only ever finds
 * determined specimens, so the gap — "what is still waiting for a name?" —
 * needs its own control (Peter, 2026-08-23).
 */
export type DeterminationState = (typeof DETERMINATION_STATES)[number];
/**
 * How far a specimen's determination of record goes (beeline-o9rd). `determined`
 * and `undetermined` are the original two and keep their meaning. The rest
 * split the determined by rank, read off `animal_rank.ordinal` (schema/020):
 * `coarse` is named only above genus (family, order, ...), `genus` is genus or
 * subgenus and nothing finer, `species` is species or subspecies, and
 * `from_genus` is genus or anything finer, which is what a volunteer means by
 * "named".
 */
export const DETERMINATION_STATES = ["any", "determined", "undetermined", "coarse", "genus", "species", "from_genus"] as const;

/** The ordinals the bands break at; the ranks themselves are in schema/020, and a test pins them. */
export const GENUS_ORDINAL = 180;
export const SPECIES_ORDINAL = 220;

/**
 * The ordinal test for a naming band, or null for a state that is not one.
 * Nothing lies between subgenus (190) and species (220) today; a rank put
 * there would read as genus level, the nearer reading of "genus or finer".
 */
export function rankBand(det: DeterminationState): string | null {
  switch (det) {
    case "coarse":
      return `ordinal < ${GENUS_ORDINAL}`;
    case "genus":
      return `ordinal >= ${GENUS_ORDINAL} AND ordinal < ${SPECIES_ORDINAL}`;
    case "species":
      return `ordinal >= ${SPECIES_ORDINAL}`;
    case "from_genus":
      return `ordinal >= ${GENUS_ORDINAL}`;
    default:
      return null;
  }
}

/** A predicate over a rank column: it is in the band. Null where the state is not a band. */
export function inRankBand(det: DeterminationState, rankColumn: string) {
  const band = rankBand(det);
  return band === null ? null : sql<boolean>`${sql.raw(rankColumn)} IN (SELECT rank FROM animal_rank WHERE ${sql.raw(band)})`;
}

/**
 * Whether labels are on paper (beeline-3v33, Peter 2026-11-04): what is still
 * waiting for labels, held back or not, against what has printed. On a
 * sample, "waiting" is any specimen of an active season without a label on
 * paper (sample_labels_waiting) and "printed" is all of them on paper; on a
 * specimen, its own label (specimen_on_paper).
 */
export type LabelFilter = "any" | "waiting" | "printed";
export const LABEL_FILTERS = ["any", "waiting", "printed"] as const;

/**
 * Whether Ecdysis holds the specimen (beeline-8dx9.11, Peter, 2026-11-20).
 * "in" is a specimen with a catalog number Ecdysis reported
 * (specimen_catalog_number) and "not" one without. "expected" is the part of
 * "not" that Ecdysis should hold by now: the specimen's label is on paper (specimen_on_paper, as the labels filter reads it: a number from a run not yet printed does not count, and an imported specimen printed before numbering does),
 * its program has a collection in ECDYSIS_COLLECTIONS, it is not marked
 * missing, and Ecdysis already holds a specimen of the same program collected
 * in the same year, which shows that year's upload has happened. "In Ecdysis"
 * means in what Beeline last read from it, which for Washington is dataset 44
 * and not the whole museum collection. On samples each means the sample has a
 * specimen that is so.
 */
export type EcdysisFilter = "any" | "in" | "not" | "expected";
export const ECDYSIS_FILTERS = ["any", "in", "not", "expected"] as const;

/**
 * The part of a specimen listing's query that asks about Ecdysis, for the
 * specimen aliased `spec`, its sample `samp` and its program's code
 * `programCode`. The programs and years Ecdysis already holds are one
 * uncorrelated subquery, a few pairs read once and hashed by the planner, so
 * no row costs a scan. A specimen's program is the one its sample's atlas
 * names (sample_atlas), as the listing's scope reads it.
 */
function ecdysisPredicate(choice: Exclude<EcdysisFilter, "any">, spec: string, samp: string, programCode: string): RawBuilder<boolean> {
  const sp = sql.raw(spec);
  const s = sql.raw(samp);
  const program = sql.raw(programCode);
  const absent = sql`NOT EXISTS (SELECT 1 FROM specimen_catalog_number ec WHERE ec.specimen_id = ${sp}.entity_id)`;
  if (choice === "in") return sql<boolean>`EXISTS (SELECT 1 FROM specimen_catalog_number ec WHERE ec.specimen_id = ${sp}.entity_id)`;
  if (choice === "not") return sql<boolean>`${absent}`;
  const programs = sql.join(ECDYSIS_COLLECTIONS.map((c) => sql`${c.program}`));
  return sql<boolean>`${absent}
    AND EXISTS (SELECT 1 FROM specimen_on_paper op WHERE op.specimen_id = ${sp}.entity_id)
    AND ${program} IN (${programs})
    AND NOT EXISTS (SELECT 1 FROM specimen_disposition ed WHERE ed.specimen_id = ${sp}.entity_id AND ed.disposition = 'missing')
    AND (${program}, CAST(extract(year FROM ${s}.date_start) AS INTEGER)) IN (
      SELECT ep.code, ess.season
      FROM specimen_catalog_number ec2
      JOIN specimen esp ON esp.entity_id = ec2.specimen_id
      JOIN sample_season ess ON ess.sample_id = esp.sample_id
      JOIN sample_atlas esa ON esa.sample_id = esp.sample_id
      JOIN program ep ON ep.entity_id = esa.atlas_id
      WHERE ep.code IN (${programs}))`;
}

/** How the sample was collected: netted, or the contents of a trap. */
export type KindFilter = "any" | SampleKind;
export const KIND_FILTERS = ["any", "net", "trap"] as const;

/**
 * An action the reader has chosen to take on rows of the specimens listing
 * (beeline-1kb.23): bulk actions are chosen first, and the listing then
 * shows which rows the action can take and holds its form at the foot of the
 * page. In the query, so paging, sorting and filtering keep the mode; ""
 * is the plain listing. Only staff have one so far, and the route clears it
 * for anyone else.
 */
export type ListingAction = "" | "reprint";
export const LISTING_ACTIONS = ["reprint"] as const;

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
/**
 * The sorts each listing has a column for (`sampleOrder` and `specimenOrder`
 * below). A sort the listing lacks falls back to the default order on the
 * page, where a URL is sometimes typed by hand; the API refuses it, since a
 * program that asked for an order and silently got another has no way to
 * know.
 */
export const SAMPLE_SORT_KEYS = ["date", "number", "collector", "place", "host", "specimens", "flags", "atlas"] as const satisfies readonly SortKey[];
export const SPECIMEN_SORT_KEYS = [
  "date",
  "field",
  "number",
  "collector",
  "place",
  "host",
  "determination",
  "determiner",
  "determined",
  "atlas",
] as const satisfies readonly SortKey[];
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
  /** Matches any of locality, county, state/province, country, or an area the point lies inside (a wilderness, county or ecoregion). */
  place: string;
  /**
   * One area the sample's point lies inside, as `<source>:<source_id>`
   * (areaKey): what the Areas page links a count by (beeline-9jd4). Exact,
   * where the place filter matches words. "" for none.
   */
  area: string;
  /**
   * A collector's name or iNat login. Matches anyone on the sample, not just
   * its primary (beeline-77j).
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
  /**
   * One collection year, the calendar year of a sample's first day (the
   * season, as the Identify page says "collection year"); null for any.
   * Beside the from and to dates, which it does not replace.
   */
  year: number | null;
  /** Whether the labels are on paper yet (LabelFilter). */
  labels: LabelFilter;
  /** Whether Ecdysis holds the specimen (EcdysisFilter); on samples, a specimen of the sample. */
  ecdysis: EcdysisFilter;
  /** Net or trap; on specimens, the kind of the sample each came from. */
  kind: KindFilter;
  qc: QcStatus;
  /** One kind of flag (a QC rule's name), or "" for any; on specimens, their sample's. */
  flag: QcRuleName | "";
  sort: SortKey;
  dir: SortDirection;
  /** 1-based. */
  page: number;
  /** The bulk action being taken, if any (ListingAction). */
  act: ListingAction;
}

export const EMPTY_QUERY: ListingQuery = {
  scope: MINE,
  q: "",
  from: null,
  to: null,
  place: "",
  area: "",
  collector: "",
  member: MEMBER_ANY,
  taxon: "",
  host: "",
  det: "any",
  year: null,
  labels: "any",
  ecdysis: "any",
  kind: "any",
  qc: "any",
  flag: "",
  sort: DEFAULT_SORT,
  dir: defaultDirection(DEFAULT_SORT),
  page: 1,
  act: "",
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
 * Query string → a query. Every scope is open to everyone; what a scope
 * cannot show somebody is decided row by row, by `withheld`. `preferred` is
 * the scope this person last chose (remembered in a cookie), used only when
 * the URL doesn't say.
 */
export function parseListingQuery(
  params: URLSearchParams,
  opts: { atlasCodes: readonly string[]; programCodes?: readonly string[]; preferred?: string | null },
): ListingQuery {
  const requested = params.get("scope") ?? opts.preferred ?? MINE;
  const permitted =
    requested === ALL ||
    requested === OUTSIDE ||
    requested === CATCH_ALL ||
    opts.atlasCodes.includes(requested) ||
    (opts.programCodes ?? []).includes(requested);
  const member = params.get("member") ?? "";
  const memberPermitted =
    member === PROGRAM_MEMBERSHIP || member === MEMBER_UNRECORDED || opts.atlasCodes.includes(member);
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const qc = params.get("qc") ?? "";
  const flag = params.get("flag") ?? "";
  const det = params.get("det") ?? "";
  const year = params.get("year") ?? "";
  const labels = params.get("labels") ?? "";
  const ecdysis = params.get("ecdysis") ?? "";
  const kind = params.get("kind") ?? "";
  const sortParam = params.get("sort") ?? "";
  const sort = (SORT_KEYS as readonly string[]).includes(sortParam) ? (sortParam as SortKey) : DEFAULT_SORT;
  const dirParam = params.get("dir");
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  const act = params.get("act") ?? "";
  return {
    scope: permitted ? requested : MINE,
    q: text(params.get("q")),
    from: isoDay(from),
    to: isoDay(to),
    place: text(params.get("place")),
    area: parseAreaKey(text(params.get("area"))) === null ? "" : text(params.get("area")),
    collector: text(params.get("collector")),
    member: memberPermitted ? member : MEMBER_ANY,
    taxon: text(params.get("taxon")),
    host: text(params.get("host")),
    det: (DETERMINATION_STATES as readonly string[]).includes(det) ? (det as DeterminationState) : "any",
    year: /^\d{4}$/.test(year) && Number(year) >= 1900 ? Number(year) : null,
    labels: (LABEL_FILTERS as readonly string[]).includes(labels) ? (labels as LabelFilter) : "any",
    ecdysis: (ECDYSIS_FILTERS as readonly string[]).includes(ecdysis) ? (ecdysis as EcdysisFilter) : "any",
    kind: (KIND_FILTERS as readonly string[]).includes(kind) ? (kind as KindFilter) : "any",
    sort,
    dir: dirParam === "asc" || dirParam === "desc" ? dirParam : defaultDirection(sort),
    qc: (QC_STATUSES as readonly string[]).includes(qc) ? (qc as QcStatus) : "any",
    flag: (QC_RULE_NAMES as readonly string[]).includes(flag) ? (flag as QcRuleName) : "",
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, 10_000) : 1,
    act: (LISTING_ACTIONS as readonly string[]).includes(act) ? (act as ListingAction) : "",
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
  // default for somebody who has never chosen; after that,
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
  if (merged.area !== "") params.set("area", merged.area);
  if (merged.collector !== "") params.set("collector", merged.collector);
  if (merged.member !== MEMBER_ANY) params.set("member", merged.member);
  if (merged.taxon !== "") params.set("taxon", merged.taxon);
  if (merged.host !== "") params.set("host", merged.host);
  if (merged.det !== "any") params.set("det", merged.det);
  if (merged.year !== null) params.set("year", String(merged.year));
  if (merged.labels !== "any") params.set("labels", merged.labels);
  if (merged.ecdysis !== "any") params.set("ecdysis", merged.ecdysis);
  if (merged.kind !== "any") params.set("kind", merged.kind);
  if (merged.qc !== "any") params.set("qc", merged.qc);
  if (merged.flag !== "") params.set("flag", merged.flag);
  // The sort is in the URL only when it is not the default, and the
  // direction only when it is not the key's own default — so a link that
  // sorts by date newest-first is the plain listing.
  if (merged.sort !== DEFAULT_SORT) params.set("sort", merged.sort);
  if (merged.dir !== defaultDirection(merged.sort)) params.set("dir", merged.dir);
  if (merged.page > 1) params.set("page", String(merged.page));
  if (merged.act !== "") params.set("act", merged.act);
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
  q.area !== "" ||
  q.collector !== "" ||
  q.member !== MEMBER_ANY ||
  q.taxon !== "" ||
  q.host !== "" ||
  q.det !== "any" ||
  q.year !== null ||
  q.labels !== "any" ||
  q.ecdysis !== "any" ||
  q.kind !== "any" ||
  q.qc !== "any" ||
  q.flag !== "";

export interface AtlasOption {
  code: string;
  name: string;
}

/**
 * Every program a listing can be scoped to: the atlases, and the programs
 * that are not one, the National Wildlife Refuges and the BLM surveys. Master
 * Melittology is left out: its samples are the ones the "At large" choice
 * finds.
 */
export async function scopePrograms(db: Kysely<Database>): Promise<AtlasOption[]> {
  const { rows } = await sql<AtlasOption>`
    SELECT p.code, p.name FROM program p WHERE p.code <> ${CATCH_ALL} ORDER BY p.name`.execute(db);
  return rows;
}

export async function atlasOptions(db: Kysely<Database>): Promise<AtlasOption[]> {
  // The programs a sample can be filed under by where it fell: those
  // atlas_region assigns states or provinces to (schema/010). That is what a
  // listing scope is, so this is a fact about atlas_region and not a named
  // kind of program.
  const { rows } = await sql<AtlasOption>`
    SELECT p.code, p.name FROM program p
    WHERE EXISTS (SELECT 1 FROM atlas_region r WHERE r.atlas_id = p.entity_id)
    ORDER BY p.name`.execute(db);
  return rows;
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
  /** The effort as the old records wrote it ('6 vane traps'); null for most net samples. The samples file's trapCount is read from it. */
  sampling_effort: string | null;
  specimen_count: number;
  inat_observation_id: bigint | null;
  /** iNaturalist no longer has the observation (`observationGone`): nothing to link to. */
  observation_gone: boolean;
  /** The atlas as people abbreviate it (program_abbreviation): WABA, OBA. Shown, never used as a key. */
  atlas_abbreviation: string | null;
  host_name: string | null;
  host_rank: string | null;
  host_inat_taxon_id: bigint | null;
  /** For a host with no id, the taxon its name comes to (host_name_taxon_cache); never published. */
  host_name_taxon_id: bigint | null;
  /** What iNaturalist calls the host now, its family and its common name (HostNames); null where it has none. */
  host_current_name: string | null;
  host_family: string | null;
  host_common_name: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinate_uncertainty_m: number | null;
  elevation_m: number | null;
  location_source: string | null;
  geoprivacy: string | null;
  taxon_geoprivacy: string | null;
  /** The location is somebody else's to see (`withheld`): the place and coordinates here are what is left. */
  location_withheld: boolean;
  blocking: number;
  warning: number;
  /** Whether the viewer is one of this sample's collectors. */
  mine: boolean;
  /**
   * For the Place cell's editor (beeline-7ywr). Whether a label is on paper,
   * after which the locality no longer changes; the names Beeline offers for
   * the point, best first, one 'name<TAB>basis' per line (null where there are none or the
   * location is withheld); what the observation itself yields, for an
   * iNat-linked sample (likewise withheld); and whether a locality somebody
   * other than the viewer set stands on the sample, which a collector may
   * not replace.
   */
  printed: boolean;
  /** Specimens with no label on paper yet, in an active season (sample_labels_waiting); 0 otherwise. */
  labels_waiting: number;
  locality_choices: string | null;
  observed_locality: string | null;
  locality_set_by_other: boolean;
  /**
   * Whether the sample was entered in Beeline (beeline-3vs.2), and whether
   * the viewer entered it: such a sample is edited on its own form and its
   * locality written directly, not as a correction to an old Beeline record.
   */
  entered: boolean;
  entered_by_me: boolean;
  /** An entered sample whose season has settled: its form closes to its collectors other than whoever entered it (Peter, 2026-11-19). */
  entered_settled: boolean;
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
  /** Someone has asked for this label again and no run has taken it yet (gh-218). */
  reprint_requested: boolean;
  /**
   * While the reprint action is chosen (query.act), why this row cannot be
   * marked, or null when it can; always null otherwise, so the CSV and the
   * plain listing pay nothing for it (beeline-1kb.23).
   */
  reprint_blocker: ReprintBlocker | null;
  sample_id: number;
  sample_number: string;
  date_start: Date;
  date_end: Date;
  locality: string | null;
  county: string | null;
  state_province: string | null;
  country: string | null;
  protocol: string | null;
  /** How the sample was collected, as the sample says: netted, or the contents of a trap. Unlike `protocol`, which is free text. */
  sample_kind: SampleKind;
  /** The museum's catalog number, as Ecdysis reports it; null where no museum has said (gh-98). */
  catalog_number: string | null;
  /** What became of the pin, where a staff inventory has said (specimen_disposition, beeline-fud5). */
  disposition: string | null;
  occurrence_remarks: string | null;
  /** The atlas as people abbreviate it (program_abbreviation): WABA, OBA. Shown, never used as a key. */
  atlas_abbreviation: string | null;
  /** The sample's floral host, as the observation named it — a column here as on the samples listing. */
  host_name: string | null;
  host_rank: string | null;
  host_inat_taxon_id: bigint | null;
  host_name_taxon_id: bigint | null;
  host_current_name: string | null;
  host_family: string | null;
  host_common_name: string | null;
  /** The animal the determination of record names; null for a specimen nobody has determined. */
  animal_id: number | null;
  taxon_rank: string | null;
  scientific_name: string | null;
  authorship: string | null;
  qualifier: DeterminationQualifier | null;
  verbatim_identification: string | null;
  sex: string | null;
  caste: string | null;
  /** The determination of record's own id; null for a specimen nobody has determined. */
  determination_id: number | null;
  is_expert: boolean | null;
  determiner: string | null;
  /** The ORCID iD crediting the determiner, bare; null for one with none or known only by name. */
  determiner_orcid: string | null;
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
  /** As on SampleRow. */
  location_withheld: boolean;
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
  /** The ORCID iD that credits them (person_orcid_of_record), bare; null for most people. */
  orcid: string | null;
}

/**
 * Exact lookups, which the API offers beside the filters because the search
 * box (`q`) matches part of a number: searching for "1" finds every sample
 * number and field number with a 1 in it. Each is a whole-value match, ignoring
 * case, and they combine with each other and with the filters. Not part of a
 * page's query string.
 */
export interface ExactLookup {
  sample_number?: string;
  /** A specimen's field number; on samples, the samples that have such a specimen. */
  field_number?: string;
  /** A specimen's catalogue number (Ecdysis's). */
  catalog_number?: string;
  inat_observation_id?: bigint;
}

export interface ListingPageOptions {
  /** Whole-value lookups (ExactLookup). */
  exact?: ExactLookup;
  limit?: number;
  offset?: number;
  /** False skips counting the whole selection; `total` is then 0. */
  withTotal?: boolean;
  /**
   * False skips reading the findings whose words make a Flags chip
   * (findingWords): a download shows no chips. The kinds of flag are still
   * listed, since they come free with the counts.
   */
  withFlagWords?: boolean;
  /**
   * True reads the names offered for each sample's point (`locality_choices`, nameLocalityChoices) for the page's
   * samples; they are null otherwise. Only the Samples page shows them, for the Place cell's editor: the downloads,
   * the API's rows and the samples upload's comparison never read the column, and asking costs a statement by up to
   * 5,000 ids a page.
   */
  withLocalityChoices?: boolean;
  /**
   * How to read a host's names (nameHosts). `all`, the default, reads the
   * current name, family and common name of the hosts on the page from the
   * view; `common`, for the pages, only the common name, which is cheaper;
   * and a map from {@link readHostNames}, for a download, which reads the view
   * once for every page of the file.
   */
  hostNames?: "common" | "all" | HostNameMap;
  /**
   * Only samples collected in this calendar year, judged on their first day
   * (no sample on the dev store spans New Year). Not a listing filter — the
   * listings have none, by design — but the grain the program archives are
   * written at (src/app/program-archives.ts), which is the taxonomists' year
   * and, since beeline-rxn8, the season.
   */
  year?: number;
  /**
   * Only these specimens (or, for `listSamples`, these samples), by their entity ids. Not a listing filter either:
   * loading an edited copy of the download asks what the download would say
   * now about the specimens or samples a file names (src/app/upload-plan.ts,
   * src/app/samples-upload-plan.ts, beeline-kgyd). An empty list selects nothing.
   */
  ids?: readonly number[];
}

export interface Page<Row> {
  rows: Row[];
  /** Rows the filters select in total, not the page's length. */
  total: number;
  /** sample_id → everyone who collected it, in recordedBy order. */
  collectors: Map<number, ListedCollector[]>;
  /** sample_id → its flags, for the samples listing's Flags column; absent on specimens. */
  findings?: Map<number, ListedFlag[]>;
  /** The area the `area` filter names, for its pill; null where the reader is shown nothing in it or the store holds no such area, absent with no filter. */
  area?: ListedArea | null;
}

/** An area as a listing names it in a filter's pill. */
export interface ListedArea {
  kind: AreaKind;
  /** As the source writes it; a page shows it through areaDisplayName. */
  name: string;
}

/** How the `area` filter names an area: its source and the source's own id, which is the area's key (schema/038). */
export const areaKey = (source: string, sourceId: string) => `${source}:${sourceId}`;

/** The two halves of an area key, or null where the text is not one. A source has no colon; an id may. */
export function parseAreaKey(key: string): { source: string; sourceId: string } | null {
  const at = key.indexOf(":");
  if (at <= 0 || at === key.length - 1) return null;
  return { source: key.slice(0, at), sourceId: key.slice(at + 1) };
}

/**
 * The area an `area` filter names, for its pill, where the reader may be
 * told the store holds it. The store holds an area only once a sample lies
 * inside it, so naming one says that somebody collected there. Staff are
 * told; anyone else is told only when the filter showed them a sample
 * there, which already says so. Otherwise a volunteer could ask about any
 * park by its public id and learn of a sample whose location is withheld
 * from them (Fable's review of beeline-9jd4).
 */
async function listedArea(
  db: Kysely<Database>,
  key: string,
  reader: Reader,
  found: number,
): Promise<ListedArea | null | undefined> {
  if (key === "") return undefined;
  const parsed = parseAreaKey(key);
  if (parsed === null) return null;
  if (!reader.staff && found === 0) return null;
  const { rows } = await sql<ListedArea>`
    SELECT kind, name FROM area WHERE source = ${parsed.source} AND source_id = ${parsed.sourceId}`.execute(db);
  return rows[0] ?? null;
}

const like = (term: string) => `%${term.toLowerCase()}%`;

/**
 * Whether a sample's floral host answers to a name typed in the host box
 * (beeline-rfkj.4): the name as the observation gave it, which every sample
 * with a host has, or what iNaturalist calls the host now, or its common name,
 * each in part and in either case. The last two are read through
 * inat_taxon_current_named, once for the whole query, as the set of stored
 * taxon ids they belong to, so that a host that was replaced is found by the
 * name it has now and by its current taxon's common name. A split, retired or
 * pending host has neither, and so is found only by the name as observed,
 * which is why that one stays in the filter and is not replaced by them. A
 * host with a name and no id answers through the taxon its name comes to
 * (the host name join, below), as it does on the page.
 */
const hostMatches = (term: string) =>
  sql<boolean>`(lower(s.host_name_as_observed) LIKE ${like(term)}
    OR coalesce(s.host_inat_taxon_id, hnt.inat_taxon_id) IN (SELECT h.inat_taxon_id FROM inat_taxon_current_named h
                                WHERE lower(h.current_name) LIKE ${like(term)} OR lower(h.common_name) LIKE ${like(term)}))`;

// THE HOST NAME JOIN (beeline-rfkj.5). For a sample with a host name and no
// host id, the taxon its name comes to: both listings' queries (listSamples,
// listSpecimens) join host_name_taxon_cache as `hnt` on the name exactly as
// the sample holds it, only for a sample with no id, whose id would otherwise
// be its host. A join on the copy's key, so it adds no row; written as a
// correlated subquery instead it cost the host filter 70 to 85 milliseconds
// (pnpm bench:pages, 2026-11-15). The taxon is carried beside the id
// (host_name_taxon_id), never in place of it: hostInatTaxonId in the
// downloads is the id the sample holds, its identification on iNaturalist,
// so a host found by name has none there, and only its current name, family
// and common name are filled.

/** What a listing says about a row's host beyond the name as observed. */
interface HostNames {
  host_inat_taxon_id: bigint | null;
  host_name_taxon_id: bigint | null;
  host_current_name: string | null;
  host_family: string | null;
  host_common_name: string | null;
}

/** What iNaturalist now calls a cached host taxon, its family and its common name; each null where it has none. */
interface NamedHost {
  name: string | null;
  family: string | null;
  common: string | null;
}

/**
 * Every cached taxon's current name, family and common name, read once.
 * A download reads this once and gives it to every page of the file
 * ({@link HostNameMap}), so the whole file is one snapshot of the names and
 * does not pay for the view again with each page.
 */
export type HostNameMap = Map<bigint, NamedHost>;
export async function readHostNames(db: Kysely<Database>): Promise<HostNameMap> {
  const found = await db
    .selectFrom("inat_taxon_current_named as h")
    .select(["h.inat_taxon_id", "h.current_name", "h.family_name", "h.common_name"])
    .execute();
  return new Map(found.map((h) => [BigInt(h.inat_taxon_id), { name: h.current_name, family: h.family_name, common: h.common_name }]));
}

/**
 * A function that reads the host names the first time it is called and gives
 * the same map afterwards: for a download, whose pages are separate calls.
 */
export const hostNamesOnce = (db: Kysely<Database>): (() => Promise<HostNameMap>) => {
  let names: Promise<HostNameMap> | undefined;
  return () => (names ??= readHostNames(db));
};

/**
 * Fill in each row's host current name, family and common name, in reads for
 * the hosts on the page, not in a join of the page's own query (which would
 * resolve the whole cache for every row it sorts). A host the cache has not
 * read has none of them and its row keeps only the name as observed.
 *
 * `common` is for the pages, which show only the common name. A host that
 * iNaturalist has not retired, and has not said is absent, is its own current
 * taxon (inat_taxon_current: standing `current` is exactly that), so its name
 * is one lookup in plant_common_name_cache, about 2 milliseconds for a page.
 * Only a host that is retired or absent goes through inat_taxon_current_named,
 * which resolves the whole cache whatever it is asked for (about 19
 * milliseconds); a page rarely has one. `all` is for the API, which also gives
 * the current name and family, and reads the view for the hosts on the page.
 * A host with no id is named through the taxon its name comes to
 * (host_name_taxon_id) in each case, as the record page names it.
 * A {@link HostNameMap} is for a download: no read at all, the names having
 * been read once for the whole file.
 */
/** The taxon a row's host is read through: its id, or, with none, the taxon its name comes to. */
const hostTaxon = (r: HostNames): bigint | null => {
  const id = r.host_inat_taxon_id ?? r.host_name_taxon_id;
  return id === null ? null : BigInt(id);
};

async function nameHosts(db: Kysely<Database>, rows: HostNames[], detail: "common" | "all" | HostNameMap): Promise<void> {
  let byId: HostNameMap;
  if (detail instanceof Map) {
    byId = detail;
  } else {
    byId = new Map();
    const ids = [...new Set(rows.flatMap((r) => (hostTaxon(r) === null ? [] : [hostTaxon(r)!])))];
    if (ids.length > 0) {
      let viaView = ids;
      if (detail === "common") {
        const direct = await db
          .selectFrom("inat_taxon as t")
          .leftJoin("plant_common_name_cache as n", "n.inat_taxon_id", "t.inat_taxon_id")
          .where("t.inat_taxon_id", "in", ids)
          .where("t.is_active", "=", true)
          .where(({ not, exists, selectFrom }) =>
            not(exists(selectFrom("inat_taxon_absent as a").select("a.inat_taxon_id").whereRef("a.inat_taxon_id", "=", "t.inat_taxon_id"))),
          )
          .select(["t.inat_taxon_id", "n.common_name"])
          .execute();
        for (const d of direct) byId.set(BigInt(d.inat_taxon_id), { name: null, family: null, common: d.common_name });
        // What is left is retired or absent, whose current taxon needs working out. A taxon the cache does not
        // hold has no row in the view, so asking for it finds nothing.
        viaView = ids.filter((id) => !byId.has(id));
      }
      if (viaView.length > 0) {
        const found = await db
          .selectFrom("inat_taxon_current_named as h")
          .where("h.inat_taxon_id", "in", viaView)
          .select(["h.inat_taxon_id", "h.current_name", "h.family_name", "h.common_name"])
          .execute();
        for (const h of found) byId.set(BigInt(h.inat_taxon_id), { name: h.current_name, family: h.family_name, common: h.common_name });
      }
    }
  }
  for (const r of rows) {
    const id = hostTaxon(r);
    const h = id === null ? undefined : byId.get(id);
    r.host_current_name = h?.name ?? null;
    r.host_family = h?.family ?? null;
    r.host_common_name = h?.common ?? null;
  }
}
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
export function sampleOrder(query: ListingQuery, p: PlaceColumns) {
  const dir = query.dir === "desc" ? sql`DESC` : sql`ASC`;
  const nulls = sql`NULLS LAST`;
  const byDate = sql`s.date_start ${dir}, ${sampleNumber(query.dir)}`;
  switch (query.sort) {
    case "number":
      return sql`${sampleNumber(query.dir)}, s.date_start DESC`;
    case "collector":
      return sql`${PRIMARY_COLLECTOR_SORT} ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "place":
      return sql`lower(${p.locality}) ${dir} ${nulls}, lower(${p.county}) ${dir} ${nulls}, s.state_province ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "host":
      return sql`lower(s.host_name_as_observed) ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "specimens":
      return sql`s.specimen_count ${dir}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "flags":
      // Blocking outranks a warning outranks clean, whichever way it runs.
      return sql`${blockingCount} ${dir}, ${warningCount} ${dir}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "atlas":
      return sql`coalesce(pab.abbreviation, a.code) ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    default:
      return byDate;
  }
}

/** The specimens' sorts that read the name of record or who gave it, which a page's choice of rows must then join. */
export const sortsOnDetermination = (query: ListingQuery) =>
  query.sort === "determination" || query.sort === "determiner" || query.sort === "determined";

/** The specimens' filters that read the name of record: a taxon, and any state of being named. */
export const filtersOnDetermination = (query: ListingQuery) => query.taxon !== "" || query.det !== "any";

export function specimenOrder(query: ListingQuery, p: PlaceColumns) {
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
      return sql`lower(${p.locality}) ${dir} ${nulls}, lower(${p.county}) ${dir} ${nulls}, s.state_province ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "host":
      return sql`lower(s.host_name_as_observed) ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "determination":
      return sql`an.scientific_name ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "determiner":
      return sql`lower(coalesce(det.display_name, d.determiner_name)) ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "determined":
      return sql`d.determined_on ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
    case "atlas":
      return sql`coalesce(pab.abbreviation, a.code) ${dir} ${nulls}, s.date_start DESC, ${BY_SAMPLE_NUMBER}`;
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
          JOIN program ma ON ma.entity_id = mm.program_id
          WHERE mc.sample_id = s.entity_id AND ma.code = 'MM'
        )`
      : sql<boolean>`EXISTS (
          SELECT 1 FROM sample_collector mc
          JOIN person_membership mm ON mm.person_id = mc.person_id
          JOIN program ma ON ma.entity_id = mm.program_id
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

/**
 * Which kinds of flag each sample carries, for the Flags column
 * (beeline-ik0d), gathered in the pass that counts them: as rule names it
 * costs nothing more, measured on production's store. What the findings say
 * costs more than it is worth here. Gathered in this pass, it adds about a
 * third to every samples page, since every sample's details are built to be
 * aggregated; asked for afterwards by the page's ids, the union of rules is
 * built again over every sample, the ids not reaching inside it, which cost
 * the same. So only the two chips whose words come from a finding read
 * their rule's own view, for the page's samples (findingWords), and the rest
 * leave their details to the sample page. "rule:severity", comma-separated.
 */
const FLAG_LIST = sql<string | null>`string_agg(DISTINCT concat(f.rule_name, ':', r.severity), ',')`.as("flag_list");

/** The sample (alias `s`) carries this kind of flag: the Flags column's filter. */
const flaggedWith = (rule: QcRuleName) =>
  sql<boolean>`EXISTS (SELECT 1 FROM sample_qc_finding kf WHERE kf.sample_id = s.entity_id AND kf.rule_name = ${rule})`;

/** The kinds of flag a sample carries, blocking first, then by rule. */
function parseFlags(list: string | null): ListedFlag[] {
  return (list ?? "")
    .split(",")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [rule, severity] = entry.split(":") as [QcRuleName, "blocking" | "warning"];
      return { rule, severity, details: [] as string[] };
    })
    .sort((a, b) => (a.severity === b.severity ? a.rule.localeCompare(b.rule) : a.severity === "blocking" ? -1 : 1));
}

/**
 * The findings whose words make their chip — which fields are missing, and a
 * hold's reason — for one page of samples, each from its rule's own view,
 * which is cheap where the union is not (about 8 ms for a page of 50).
 */
async function findingWords(db: Kysely<Database>, sampleIds: number[]) {
  if (sampleIds.length === 0) return [];
  const ids = sql.join(sampleIds);
  return (
    await sql<{ sample_id: number; rule_name: QcRuleName; details: string | null }>`
      SELECT sample_id, rule_name, details FROM qc_rule_missing_required_field WHERE sample_id IN (${ids})
      UNION ALL
      SELECT sample_id, rule_name, details FROM qc_rule_staff_hold WHERE sample_id IN (${ids})`.execute(db)
  ).rows;
}

/** The place columns as one haystack: a person types a place, not a column. */
/**
 * Who is reading, as far as the location rule cares: staff, or whose
 * collecting is theirs — the signed-in person, and the person they act for
 * when the switch is on, since a delegate reads a household's records as the
 * household does. Impersonation passes only the person impersonated, so the
 * view stays theirs.
 */
export interface Reader {
  staff: boolean;
  personIds: readonly number[];
}

/** Staff: everything, every location. For the program archives and the jobs, which are staff's. */
export const STAFF_READER: Reader = { staff: true, personIds: [] };

/**
 * Whether this sample's location is not the reader's to see: iNaturalist
 * obscures or hides it from everyone but its observer — or it cites an
 * observation Beeline has never read, so nobody here knows whether it does —
 * and the reader is neither staff nor one of its collectors. The second case
 * is the legacy import's: 1,537 samples on the dev store cite an observation
 * no sync has fetched, their geoprivacy columns blank because nothing wrote
 * them, and at the corpus's rate a dozen or more of them are protected on
 * iNaturalist. A sample citing no observation has no setting to know.
 *
 * Reads `own`, the reader's own samples, and `seen`, the observation's
 * stored projection, which every query that uses it joins first
 * (`ownSamples`, and `observation_field` as `seen`).
 */
export function withheld(reader: Reader) {
  return reader.staff
    ? sql<boolean>`FALSE`
    : sql<boolean>`((s.geoprivacy IS NOT NULL OR s.taxon_geoprivacy IS NOT NULL
                     OR (s.inat_observation_id IS NOT NULL AND seen.inat_id IS NULL))
                    AND own.sample_id IS NULL)`;
}

/**
 * The sample cites an observation iNaturalist has never given Beeline and,
 * asked for it by id, answered without it (schema/060 observation_absent,
 * beeline-wcc6): deleted upstream, so there is no page to send anyone to and
 * nothing to read. Correlated on `s`, for a query that has `s` in scope. The
 * same two conditions as the missing-upstream flag's second branch
 * (schema/120).
 */
export const observationGone = sql<boolean>`EXISTS (
  SELECT 1 FROM observation_absent ab
  WHERE ab.inat_id = s.inat_observation_id
    AND NOT EXISTS (SELECT 1 FROM observation_field gf WHERE gf.inat_id = s.inat_observation_id))`;

/** The reader's own samples, as SQL to join as `own`, for a query written in SQL. */
export const ownSamplesSql = (reader: Reader) =>
  sql`(SELECT DISTINCT oc.sample_id FROM sample_collector oc
       WHERE oc.person_id IN (${sql.join((reader.personIds.length === 0 ? [-1] : reader.personIds).map((id) => sql`${id}`))}))`;

/** The reader's own samples, one row each, joined as `own`. */
const ownSamples = (db: Kysely<Database>, reader: Reader) =>
  db
    .selectFrom("sample_collector as oc")
    .where("oc.person_id", "in", reader.personIds.length === 0 ? [-1] : [...reader.personIds])
    .select("oc.sample_id")
    .distinct()
    .as("own");

/**
 * The place a reader may see: a withheld sample keeps its state and country,
 * as iNaturalist's public view of an obscured observation does, and its
 * county unless the observation is private, where iNaturalist shows nothing.
 */
export interface PlaceColumns {
  locality: RawBuilder<string | null>;
  county: RawBuilder<string | null>;
  /**
   * The names of the areas the point lies inside (beeline-9jd4), so the place
   * filter finds a sample by the wilderness it was collected in (Peter,
   * 2026-10-26). Withheld with the locality, since a name says where the
   * point is.
   */
  areas: RawBuilder<string | null>;
}

export function placeColumns(reader: Reader): PlaceColumns {
  const hidden = withheld(reader);
  return {
    locality: sql<string | null>`CASE WHEN ${hidden} THEN NULL ELSE s.locality END`,
    county: sql<string | null>`CASE WHEN ${hidden} AND (s.geoprivacy = 'private' OR s.taxon_geoprivacy = 'private')
                                    THEN NULL ELSE s.county END`,
    areas: sql<string | null>`CASE WHEN ${hidden} THEN NULL ELSE
      (SELECT string_agg(sac.name, ' ') FROM sample_area_current sac WHERE sac.sample_id = s.entity_id) END`,
  };
}

/** A location column as the reader may see it: nothing, where the location is withheld. */
const located = <T>(hidden: RawBuilder<boolean>, column: RawBuilder<T>) =>
  sql<T | null>`CASE WHEN ${hidden} THEN NULL ELSE ${column} END`;

const placeHaystack = (p: PlaceColumns) =>
  sql<string>`lower(concat_ws(' ', ${p.locality}, ${p.county}, s.state_province, s.country, ${p.areas}))`;

/**
 * Words that only say what kind of place the next one is. A county is stored
 * as its bare name (`countyName` strips iNaturalist's suffix), so "King county"
 * would otherwise find nothing. Bare "co" stays: it is also Colorado's code.
 */
const PLACE_KIND_WORDS = new Set(["county", "co."]);

/**
 * The place filter's words, each to be found somewhere in the haystack, so
 * "King, WA" matches a sample whose county is King and state WA though the
 * haystack never holds that string (beeline-ky5e). A search that is nothing
 * but kind words is kept whole rather than matching everything.
 */
export function placeWords(term: string): string[] {
  const words = term.toLowerCase().split(/[\s,]+/).filter((w) => w !== "");
  const named = words.filter((w) => !PLACE_KIND_WORDS.has(w));
  return named.length > 0 ? named : words;
}

function placeMatches(term: string, p: PlaceColumns) {
  const words = placeWords(term);
  // A search of only commas names no place; it narrows nothing.
  if (words.length === 0) return sql<boolean>`TRUE`;
  return sql<boolean>`(${sql.join(
    words.map((w) => sql`${placeHaystack(p)} LIKE ${like(w)}`),
    sql` AND `,
  )})`;
}

/**
 * The sample (alias `s`) lies inside this one area, for a reader who may see
 * where it is: an area says where the point is, as its name in the place
 * filter does, so a sample whose location is withheld is never found by it.
 */
function insideArea(key: string, reader: Reader) {
  const parsed = parseAreaKey(key);
  if (parsed === null) return sql<boolean>`FALSE`;
  return sql<boolean>`(NOT ${withheld(reader)} AND EXISTS (
    SELECT 1 FROM sample_area_current sac
    WHERE sac.sample_id = s.entity_id AND sac.source = ${parsed.source} AND sac.source_id = ${parsed.sourceId}))`;
}

/**
 * The sample (alias `s`) lies inside a national wildlife refuge, for a reader
 * who may see where it is: as with `insideArea`, a withheld location is never
 * found by where it is.
 */
function inRefuge(reader: Reader) {
  return sql<boolean>`(NOT ${withheld(reader)} AND EXISTS (
    SELECT 1 FROM sample_area_current sac WHERE sac.sample_id = s.entity_id AND sac.kind = 'refuge'))`;
}

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
    // Bracketed: Kysely ANDs a raw predicate onto the other filters as it
    // stands, so a bare OR let any heads-up anywhere past scope and dates
    // (beeline-ryd2).
    case "flagged":
      return sql<boolean>`(${blockingCount} > 0 OR ${warningCount} > 0)`;
    case "blocking":
      return sql<boolean>`${blockingCount} > 0`;
    case "warning":
      return sql<boolean>`${blockingCount} = 0 AND ${warningCount} > 0`;
    case "clean":
      return sql<boolean>`${blockingCount} = 0 AND ${warningCount} = 0`;
    // A locality that will not do for a label, or none: what the Place
    // cell's editor fixes (beeline-7ywr). The same two findings the front
    // page offers a suggested locality on.
    case "locality":
      return sql<boolean>`EXISTS (
        SELECT 1 FROM sample_qc_finding lf
        WHERE lf.sample_id = s.entity_id
          AND (lf.rule_name = 'locality_format'
               OR (lf.rule_name = 'missing_required_field' AND lf.details LIKE '%locality%')))`;
    case "any":
      return null;
  }
}

/**
 * The samples a query selects, as this reader may see them: every filter and
 * the scope applied, nothing selected yet. One definition for the page, the
 * download, and the API's counts and groupings, so a count cannot be made
 * from a second copy of the filters and disagree with the listing.
 */
export async function filteredSamples(
  db: Kysely<Database>,
  query: ListingQuery,
  personId: number,
  reader: Reader,
  exact: ExactLookup = {},
  rollup = true,
  ids?: readonly number[],
) {
  const animals = query.taxon === "" ? null : await taxonIds(db, query.taxon);
  const place = placeColumns(reader);
  let base = db
    .selectFrom("sample as s")
    .leftJoin("host_name_taxon_cache as hnt", (join) =>
      join.onRef("hnt.host_name", "=", "s.host_name_as_observed").on("s.host_inat_taxon_id", "is", null),
    )
    .leftJoin("sample_atlas as sa", "sa.sample_id", "s.entity_id")
    .leftJoin("program as a", "a.entity_id", "sa.atlas_id")
    .leftJoin("program_abbreviation as pab", "pab.program_id", "a.entity_id")
    // Only `withheld` reads these, and for staff it reads nothing.
    .$if(!reader.staff, (qb) =>
      qb
        .leftJoin(ownSamples(db, reader), (join) => join.onRef("own.sample_id", "=", "s.entity_id"))
        .leftJoin("observation_field as seen", "seen.inat_id", "s.inat_observation_id"),
    )
    // `sample_location` is not joined here: no filter or sort reads it. The page's rows join it in listSamples,
    // whole and blanked in the select (`located`): a condition in the ON that reads `own` cost a volunteer's
    // listing 7.5 s against 0.1 s.
    //
    // THE JOINS BELOW ARE WRITTEN TWICE: here, for what a filter or the order reads, and in listSamples, for the
    // page's rows. A change to a join's condition must be made in both.
    // The flag roll-up: the listing selects it, and a count needs it only for a status filter.
    .$if(rollup, (qb) =>
      qb.leftJoin(
        (eb) =>
          eb
            .selectFrom("sample_qc_finding as f")
            .innerJoin("qc_rule as r", "r.name", "f.rule_name")
            .where("f.sample_id", "is not", null)
            .groupBy("f.sample_id")
            .select(["f.sample_id as sample_id", ...QC_COUNT_SELECTIONS, FLAG_LIST])
            .as("qc"),
        (join) => join.onRef("qc.sample_id", "=", "s.entity_id"),
      ),
    );

  if (ids !== undefined) base = base.where("s.entity_id", "in", ids.length === 0 ? [-1] : [...ids]);
  if (query.scope === MINE) {
    base = base.where(({ exists, selectFrom }) =>
      exists(
        selectFrom("sample_collector as mine")
          .select("mine.sample_id")
          .whereRef("mine.sample_id", "=", "s.entity_id")
          .where("mine.person_id", "=", personId),
      ),
    );
  } else if (query.scope === OUTSIDE || query.scope === CATCH_ALL) {
    // Outside = no atlas, whether geography said so (no sample_atlas row —
    // the LEFT JOIN gives a NULL) or a human did (a row with a NULL atlas).
    base = base.where("sa.atlas_id", "is", null);
  } else if (query.scope === REFUGES) {
    base = base.where(inRefuge(reader));
  } else if (query.scope !== ALL) {
    base = base.where("a.code", "=", query.scope);
  }
  // Overlap, not containment: a trap sample that was out across the window's
  // start belongs in a window that names its end.
  if (query.from !== null) base = base.where("s.date_end", ">=", asDate(query.from));
  if (query.to !== null) base = base.where("s.date_start", "<=", asDate(query.to));
  if (query.place !== "") base = base.where(placeMatches(query.place, place));
  if (query.area !== "") base = base.where(insideArea(query.area, reader));
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
  // A naming band on a sample: at least one of its specimens is named that far,
  // as the taxon filter finds a sample by any one specimen.
  const band = inRankBand(query.det, "an.rank");
  if (band !== null) {
    base = base.where(({ exists, selectFrom }) =>
      exists(
        selectFrom("specimen as sp")
          .innerJoin("determination_of_record as d", "d.specimen_id", "sp.entity_id")
          .innerJoin("animal as an", "an.entity_id", "d.animal_id")
          .select("sp.entity_id")
          .whereRef("sp.sample_id", "=", "s.entity_id")
          .where(band),
      ),
    );
  }
  if (query.year !== null) base = base.where(sql<number>`extract(year from s.date_start)`, "=", query.year);
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
  if (query.host !== "") base = base.where(hostMatches(query.host));
  if (query.kind !== "any") base = base.where("s.kind", "=", query.kind);
  if (exact.sample_number !== undefined) base = base.where(sql<boolean>`lower(s.sample_number) = ${exact.sample_number.toLowerCase()}`);
  if (exact.inat_observation_id !== undefined) base = base.where("s.inat_observation_id", "=", exact.inat_observation_id);
  if (exact.field_number !== undefined) {
    base = base.where(sql<boolean>`EXISTS (SELECT 1 FROM specimen xs WHERE xs.sample_id = s.entity_id AND lower(xs.field_number) = ${exact.field_number.toLowerCase()})`);
  }
  if (exact.catalog_number !== undefined) {
    base = base.where(sql<boolean>`EXISTS (SELECT 1 FROM specimen xs JOIN specimen_catalog_number xc ON xc.specimen_id = xs.entity_id
                                           WHERE xs.sample_id = s.entity_id AND lower(xc.catalog_number) = ${exact.catalog_number.toLowerCase()})`);
  }
  // "Printed" is every label on paper, counted against the specimen count in
  // any season: a settled sample printed only in part is not waiting unless
  // staff released it, since a settled sample staff have not released never
  // prints, and is not all printed either (CodeRabbit). A settled sample that
  // never printed and was not released is neither.
  if (query.labels === "waiting") {
    base = base.where(sql<boolean>`EXISTS (SELECT 1 FROM sample_labels_waiting w WHERE w.sample_id = s.entity_id)`);
  } else if (query.labels === "printed") {
    base = base.where(
      sql<boolean>`s.specimen_count > 0
                   AND (SELECT count(*) FROM specimen_on_paper op
                        WHERE op.sample_id = s.entity_id AND op.specimen_number <= s.specimen_count) >= s.specimen_count`,
    );
  }
  if (query.ecdysis !== "any") {
    const asked = ecdysisPredicate(query.ecdysis, "xsp", "s", "a.code");
    base = base.where(sql<boolean>`EXISTS (SELECT 1 FROM specimen xsp WHERE xsp.sample_id = s.entity_id AND ${asked})`);
  }
  const qc = qcPredicate(query.qc);
  if (qc !== null) base = base.where(qc);
  if (query.flag !== "") base = base.where(flaggedWith(query.flag));

  return base;
}

/**
 * The names Beeline offers for each sample's point, for the page's samples alone: one 'name<TAB>basis' per line,
 * best first (`SampleRow.locality_choices`), and null where there are none or the location is withheld from this
 * reader. Asked for after the page is chosen, by the page's ids: as a column of the rows statement it was a
 * string_agg over every sample's candidates, 113 to 231 ms, against 6.5 ms for fifty ids (beeline-amdt.4).
 */
export async function nameLocalityChoices(db: Kysely<Database>, rows: Array<Pick<SampleRow, "sample_id" | "location_withheld" | "locality_choices">>) {
  // A row that does not say its location is withheld is treated as withheld: the rows are cast to their type, so a renamed column would not be noticed.
  const ids = rows.filter((r) => r.location_withheld === false).map((r) => r.sample_id);
  const found = new Map<number, string | null>();
  if (ids.length > 0) {
    const choices = await sql<{ sample_id: number; choices: string | null }>`
      SELECT g.sample_id, string_agg(concat(g.locality, chr(9), g.basis), chr(10) ORDER BY g.rank) AS choices
      FROM sample_locality_candidate_current g WHERE g.sample_id IN (${sql.join(ids)}) GROUP BY g.sample_id`.execute(db);
    for (const c of choices.rows) found.set(Number(c.sample_id), c.choices);
  }
  for (const r of rows) r.locality_choices = found.get(r.sample_id) ?? null;
}

export async function listSamples(
  db: Kysely<Database>,
  query: ListingQuery,
  personId: number,
  reader: Reader,
  opts: ListingPageOptions = {},
): Promise<Page<SampleRow>> {
  const hidden = withheld(reader);
  const place = placeColumns(reader);
  // The flag roll-up is read to choose the page only by a status filter and by the Flags sort. When it was, the page
  // carries the three columns it gave and the rows take them from there, rather than computing it a second time.
  const rolled = needsRollup(query) || query.sort === "flags";
  const base = await filteredSamples(db, query, personId, reader, opts.exact, rolled, opts.ids);
  const countQuery = opts.withTotal === false ? undefined : await samplesCountQuery(db, query, personId, reader, opts, base);

  const limit = opts.limit ?? PAGE_SIZE;
  const offset = opts.offset ?? (query.page - 1) * PAGE_SIZE;
  // The page is chosen first, from the samples' own keys and whatever the filters and the order read, and only then
  // are the rest of each row's columns looked up, for those rows alone: every per-row subquery and joined view was
  // computed for every sample in the store before the sort took its fifty (beeline-amdt.6). A new column goes in the
  // outer query below, unless a filter or a sort reads it, which puts it here.
  const pageKeys = base
    .select([
      "s.entity_id as sample_id",
      rolled ? sql<number | null>`qc.blocking`.as("blocking") : sql<number | null>`CAST(NULL AS INTEGER)`.as("blocking"),
      rolled ? sql<number | null>`qc.warning`.as("warning") : sql<number | null>`CAST(NULL AS INTEGER)`.as("warning"),
      rolled ? sql<string | null>`qc.flag_list`.as("flag_list") : sql<string | null>`CAST(NULL AS TEXT)`.as("flag_list"),
    ])
    .orderBy(sampleOrder(query, place))
    .orderBy("s.entity_id")
    .limit(limit)
    .offset(offset);
  const [rows, count] = await Promise.all([
    db
      .with("pg", () => pageKeys)
      .selectFrom("pg")
      .innerJoin("sample as s", "s.entity_id", "pg.sample_id")
      // These joins repeat filteredSamples's: a change to a join's condition must be made in both.
      .leftJoin("host_name_taxon_cache as hnt", (join) =>
        join.onRef("hnt.host_name", "=", "s.host_name_as_observed").on("s.host_inat_taxon_id", "is", null),
      )
      .leftJoin("sample_atlas as sa", "sa.sample_id", "s.entity_id")
      .leftJoin("program as a", "a.entity_id", "sa.atlas_id")
      .leftJoin("program_abbreviation as pab", "pab.program_id", "a.entity_id")
      .$if(!reader.staff, (qb) =>
        qb
          .leftJoin(ownSamples(db, reader), (join) => join.onRef("own.sample_id", "=", "s.entity_id"))
          .leftJoin("observation_field as seen", "seen.inat_id", "s.inat_observation_id"),
      )
      .leftJoin("sample_location as loc", "loc.sample_id", "s.entity_id")
      // The flag roll-up, as `qc`: the page's own copy of it where the page was chosen by it, else computed here.
      .$if(rolled, (qb) => qb.leftJoin("pg as qc", "qc.sample_id", "s.entity_id"))
      .$if(!rolled, (qb) =>
        qb.leftJoin(
          (eb) =>
            eb
              .selectFrom("sample_qc_finding as f")
              .innerJoin("qc_rule as r", "r.name", "f.rule_name")
              .where("f.sample_id", "is not", null)
              .groupBy("f.sample_id")
              .select(["f.sample_id as sample_id", ...QC_COUNT_SELECTIONS, FLAG_LIST])
              .as("qc"),
          (join) => join.onRef("qc.sample_id", "=", "s.entity_id"),
        ),
      )
      .select([
        "s.entity_id as sample_id",
        "s.sample_number",
        "s.kind",
        "s.date_start",
        "s.date_end",
        place.locality.as("locality"),
        place.county.as("county"),
        "s.state_province",
        "s.country",
        "s.protocol",
        "s.sampling_effort",
        "s.specimen_count",
        "s.inat_observation_id",
        observationGone.as("observation_gone"),
        sql<string | null>`coalesce(pab.abbreviation, a.code)`.as("atlas_abbreviation"),
        "s.host_name_as_observed as host_name",
        "s.host_rank",
        "s.host_inat_taxon_id",
        "hnt.inat_taxon_id as host_name_taxon_id",
        located(hidden, sql<number | null>`loc.latitude`).as("latitude"),
        located(hidden, sql<number | null>`loc.longitude`).as("longitude"),
        located(hidden, sql<number | null>`loc.coordinate_uncertainty_m`).as("coordinate_uncertainty_m"),
        located(hidden, sql<number | null>`loc.elevation_m`).as("elevation_m"),
        located(hidden, sql<string | null>`loc.source`).as("location_source"),
        "s.geoprivacy",
        "s.taxon_geoprivacy",
        hidden.as("location_withheld"),
        blockingCount.as("blocking"),
        warningCount.as("warning"),
        sql<string | null>`qc.flag_list`.as("flag_list"),
        sql<boolean>`EXISTS (SELECT 1 FROM sample_collector mine
                             WHERE mine.sample_id = s.entity_id AND mine.person_id = ${personId})`.as("mine"),
        sql<boolean>`EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)`.as("printed"),
        sql<number>`coalesce((SELECT w.waiting FROM sample_labels_waiting w WHERE w.sample_id = s.entity_id), 0)`.as(
          "labels_waiting",
        ),
        located(
          hidden,
          sql<string | null>`(SELECT ol.locality FROM observation_locality ol WHERE ol.inat_id = s.inat_observation_id)`,
        ).as("observed_locality"),
        sql<boolean>`EXISTS (SELECT 1 FROM sample_locality_override lo
                             WHERE lo.sample_id = s.entity_id AND lo.set_by IS DISTINCT FROM ${personId})`.as(
          "locality_set_by_other",
        ),
        sql<boolean>`EXISTS (SELECT 1 FROM sample_entry e WHERE e.sample_id = s.entity_id)`.as("entered"),
        sql<boolean>`EXISTS (SELECT 1 FROM sample_entry e WHERE e.sample_id = s.entity_id AND e.entered_by = ${personId})`.as(
          "entered_by_me",
        ),
        sql<boolean>`EXISTS (SELECT 1 FROM sample_entry e JOIN settled_sample ss ON ss.sample_id = e.sample_id WHERE e.sample_id = s.entity_id)`.as("entered_settled"),
      ])
      // The chosen rows in the order they were chosen in: the same total order, over fifty rows.
      .orderBy(sampleOrder(query, place))
      .orderBy("s.entity_id")
      .execute(),
    // A streamed download pages through everything and never shows a total.
    countQuery === undefined ? Promise.resolve(undefined) : countQuery.executeTakeFirst(),
  ]);
  const sampleRows = rows as unknown as Array<SampleRow & { flag_list: string | null }>;
  await nameHosts(db, sampleRows, opts.hostNames ?? "all");
  const ids = sampleRows.map((r) => r.sample_id);
  if (opts.withLocalityChoices === true) await nameLocalityChoices(db, sampleRows);
  else for (const r of sampleRows) r.locality_choices = null;
  const findings = new Map(sampleRows.map((r) => [r.sample_id, parseFlags(r.flag_list)] as const));
  // Where the location is withheld from this reader, a finding's words go,
  // as on the sample page (visibleFindings, src/app/record.ts): a hold's
  // note can say where the sample was (CodeRabbit).
  const wordsFor = sampleRows.filter((r) => !r.location_withheld).map((r) => r.sample_id);
  const [collectors, words] = await Promise.all([
    collectorsOf(db, ids),
    opts.withFlagWords === false ? Promise.resolve([]) : findingWords(db, wordsFor),
  ]);
  for (const w of words) {
    const flag = findings.get(Number(w.sample_id))?.find((x) => x.rule === w.rule_name);
    if (flag !== undefined && w.details !== null && w.details !== "") flag.details.push(w.details);
  }
  return {
    rows: sampleRows,
    total: Number(count?.n ?? 0),
    collectors,
    findings,
    area: await listedArea(db, query.area, reader, Math.max(sampleRows.length, Number(count?.n ?? 0))),
  };
}

/**
 * The query for a samples page's total: the page's own filters ({@link filteredSamples}),
 * joined to the flag roll-up only when {@link needsRollup} says a filter reads it. The page's
 * rows select the roll-up for their Flags column, so they are given `rowsBase`, which has it;
 * when a status filter needs it the count reuses that base, and otherwise builds one without.
 */
export async function samplesCountQuery(
  db: Kysely<Database>,
  query: ListingQuery,
  personId: number,
  reader: Reader,
  opts: ListingPageOptions,
  rowsBase?: Awaited<ReturnType<typeof filteredSamples>>,
) {
  const base =
    rowsBase !== undefined && needsRollup(query)
      ? rowsBase
      : await filteredSamples(db, query, personId, reader, opts.exact, needsRollup(query), opts.ids);
  return base.select(({ fn }) => fn.countAll().as("n"));
}

/**
 * One kind of flag on a sample, as the Flags column shows it (beeline-ik0d):
 * the rule, whether it blocks printing, and, for the two rules whose chip is
 * made from them (findingWords), what its findings say.
 */
export interface ListedFlag {
  rule: QcRuleName;
  severity: "blocking" | "warning";
  details: string[];
}

/**
 * Which of the given samples a listing scoped to `scope` finds: the listing's own
 * meaning of "this program's records" (an atlas by where the sample fell, Master
 * Melittology as the samples no atlas covers, the refuges by where the point
 * lies), asked of it rather than worked out a second time. Staff's reader by
 * default, since this is a fact about the store and shows nobody a location.
 */
export async function sampleIdsInScope(db: Kysely<Database>, scope: string, ids: readonly number[], reader: Reader = STAFF_READER): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const found = await (await filteredSamples(db, { ...EMPTY_QUERY, scope }, 0, reader, {}, false, ids)).select("s.entity_id as sample_id").execute();
  return new Set(found.map((r) => Number(r.sample_id)));
}

/** Which of the determination's joins a {@link filteredSpecimens} caller reads: the name (`d`, `an`), the determiner (`det`), the ORCID iD. */
export interface SpecimenJoins {
  name: boolean;
  determiner: boolean;
  orcid: boolean;
}
const ALL_SPECIMEN_JOINS: SpecimenJoins = { name: true, determiner: true, orcid: true };
const NO_SPECIMEN_JOINS: SpecimenJoins = { name: false, determiner: false, orcid: false };

/** The specimens a query selects, as this reader may see them; see {@link filteredSamples}. */
export async function filteredSpecimens(
  db: Kysely<Database>,
  query: ListingQuery,
  personId: number,
  reader: Reader,
  year?: number,
  exact: ExactLookup = {},
  rollup = true,
  ids?: readonly number[],
  joins: SpecimenJoins = ALL_SPECIMEN_JOINS,
  /** The taxon filter's animals where the caller has already worked them out (listSpecimens calls this twice). */
  taxa?: readonly number[] | null,
) {
  const animals = taxa !== undefined ? taxa : query.taxon === "" ? null : await taxonIds(db, query.taxon);
  const place = placeColumns(reader);
  const core = db
    .selectFrom("specimen as sp")
    .innerJoin("sample as s", "s.entity_id", "sp.sample_id")
    .leftJoin("host_name_taxon_cache as hnt", (join) =>
      join.onRef("hnt.host_name", "=", "s.host_name_as_observed").on("s.host_inat_taxon_id", "is", null),
    )
    .leftJoin("sample_atlas as sa", "sa.sample_id", "s.entity_id")
    .leftJoin("program as a", "a.entity_id", "sa.atlas_id")
    .leftJoin("program_abbreviation as pab", "pab.program_id", "a.entity_id")
    // Only `withheld` reads these, and for staff it reads nothing.
    .$if(!reader.staff, (qb) =>
      qb
        .leftJoin(ownSamples(db, reader), (join) => join.onRef("own.sample_id", "=", "s.entity_id"))
        .leftJoin("observation_field as seen", "seen.inat_id", "s.inat_observation_id"),
    )
    // `sample_location` is not joined here either: only the page's rows read it (listSpecimens).
    //
    // THE JOINS BELOW ARE WRITTEN TWICE: here, for what a filter or the order reads, and in listSpecimens, for the
    // page's rows. A change to a join's condition must be made in both.
    // The flag roll-up: the listing selects it, and a count needs it only for a status filter.
    .$if(rollup, (qb) =>
      qb.leftJoin(
        (eb) =>
          eb
            .selectFrom("sample_qc_finding as f")
            .innerJoin("qc_rule as r", "r.name", "f.rule_name")
            .where("f.sample_id", "is not", null)
            .groupBy("f.sample_id")
            .select(["f.sample_id as sample_id", ...QC_COUNT_SELECTIONS])
            .as("qc"),
        (join) => join.onRef("qc.sample_id", "=", "s.entity_id"),
      ),
    );
  const withName = core
    .leftJoin("determination_of_record as d", "d.specimen_id", "sp.entity_id")
    .leftJoin("animal as an", "an.entity_id", "d.animal_id");
  const withDeterminer = withName.leftJoin("person as det", "det.entity_id", "d.determiner_id");
  const withOrcid = withDeterminer.leftJoin("person_orcid_of_record as det_orcid", "det_orcid.person_id", "d.determiner_id");
  // The name of record (`d`, `an`), who gave it (`det`) and their ORCID iD: the page's rows select them, and the
  // choice of the page needs only what a filter or the order reads (`filtersOnDetermination`, `sortsOnDetermination`),
  // so a caller says which it selects and does not pay for the window that finds each specimen's name of record
  // when it selects none. A query whose filters read the name of record gets it whatever the caller says, so a
  // caller cannot leave out one a filter needs.
  const chosen = joins.orcid
    ? withOrcid
    : joins.determiner
      ? withDeterminer
      : joins.name || filtersOnDetermination(query)
        ? withName
        : core;
  let base = chosen as unknown as typeof withOrcid;

  if (query.scope === MINE) {
    base = base.where(({ exists, selectFrom }) =>
      exists(
        selectFrom("sample_collector as mine")
          .select("mine.sample_id")
          .whereRef("mine.sample_id", "=", "s.entity_id")
          .where("mine.person_id", "=", personId),
      ),
    );
  } else if (query.scope === OUTSIDE || query.scope === CATCH_ALL) {
    // Outside = no atlas, whether geography said so (no sample_atlas row —
    // the LEFT JOIN gives a NULL) or a human did (a row with a NULL atlas).
    base = base.where("sa.atlas_id", "is", null);
  } else if (query.scope === REFUGES) {
    base = base.where(inRefuge(reader));
  } else if (query.scope !== ALL) {
    base = base.where("a.code", "=", query.scope);
  }
  if (query.from !== null) base = base.where("s.date_end", ">=", asDate(query.from));
  if (query.to !== null) base = base.where("s.date_start", "<=", asDate(query.to));
  if (query.place !== "") base = base.where(placeMatches(query.place, place));
  if (query.area !== "") base = base.where(insideArea(query.area, reader));
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
  const specimenBand = inRankBand(query.det, "an.rank");
  if (specimenBand !== null) base = base.where(specimenBand);
  if (query.year !== null) base = base.where(sql<number>`extract(year from s.date_start)`, "=", query.year);
  if (query.host !== "") base = base.where(hostMatches(query.host));
  if (query.kind !== "any") base = base.where("s.kind", "=", query.kind);
  if (exact.sample_number !== undefined) base = base.where(sql<boolean>`lower(s.sample_number) = ${exact.sample_number.toLowerCase()}`);
  if (exact.inat_observation_id !== undefined) base = base.where("s.inat_observation_id", "=", exact.inat_observation_id);
  if (exact.field_number !== undefined) base = base.where(sql<boolean>`lower(sp.field_number) = ${exact.field_number.toLowerCase()}`);
  if (exact.catalog_number !== undefined) {
    base = base.where(sql<boolean>`EXISTS (SELECT 1 FROM specimen_catalog_number xc WHERE xc.specimen_id = sp.entity_id AND lower(xc.catalog_number) = ${exact.catalog_number.toLowerCase()})`);
  }
  // A specimen's own label: in a run not yet printed, or numbered by a run
  // since canceled, it is waiting; printed or imported, it is on paper.
  if (query.labels === "waiting") {
    base = base.where(sql<boolean>`NOT EXISTS (SELECT 1 FROM specimen_on_paper op WHERE op.specimen_id = sp.entity_id)`);
  } else if (query.labels === "printed") {
    base = base.where(sql<boolean>`EXISTS (SELECT 1 FROM specimen_on_paper op WHERE op.specimen_id = sp.entity_id)`);
  }
  if (query.ecdysis !== "any") base = base.where(ecdysisPredicate(query.ecdysis, "sp", "s", "a.code"));
  const qc = qcPredicate(query.qc);
  if (qc !== null) base = base.where(qc);
  // By the sample's flags, as the severity filter above narrows specimens: a
  // link to /specimens?flag= must not name a filter it does not apply.
  if (query.flag !== "") base = base.where(flaggedWith(query.flag));
  if (year !== undefined) base = base.where(sql<number>`extract(year from s.date_start)`, "=", year);
  if (ids !== undefined) base = base.where("sp.entity_id", "in", ids.length === 0 ? [-1] : [...ids]);

  return base;
}

/**
 * The specimens a page and its total are both read from. The rows select nothing from the
 * flag roll-up, so it is joined only when a status filter reads it ({@link needsRollup}).
 */
export async function specimenListingBase(
  db: Kysely<Database>,
  query: ListingQuery,
  personId: number,
  reader: Reader,
  opts: ListingPageOptions,
  taxa?: readonly number[] | null,
) {
  // The total reads no column of the name of record, only the filters that do (which join it themselves).
  return filteredSpecimens(db, query, personId, reader, opts.year, opts.exact, needsRollup(query), opts.ids, NO_SPECIMEN_JOINS, taxa);
}

export async function listSpecimens(
  db: Kysely<Database>,
  query: ListingQuery,
  personId: number,
  reader: Reader,
  opts: ListingPageOptions = {},
): Promise<Page<SpecimenRow>> {
  const hidden = withheld(reader);
  const place = placeColumns(reader);
  const taxa = query.taxon === "" ? null : await taxonIds(db, query.taxon);
  const base = await specimenListingBase(db, query, personId, reader, opts, taxa);

  const limit = opts.limit ?? PAGE_SIZE;
  const offset = opts.offset ?? (query.page - 1) * PAGE_SIZE;
  // The page is chosen first, from the specimens' own keys and whatever the filters and the order read, and only
  // then are the rest of each row's columns looked up, for those rows alone: the five subqueries and the name
  // of record were computed for every specimen in the store before the sort took its fifty (beeline-amdt.5).
  // A new column goes in the outer query below, unless a filter or a sort reads it, which puts it here.
  const pageKeys = (
    await filteredSpecimens(
      db,
      query,
      personId,
      reader,
      opts.year,
      opts.exact,
      needsRollup(query),
      opts.ids,
      { name: sortsOnDetermination(query), determiner: query.sort === "determiner", orcid: false },
      taxa,
    )
  )
    .select("sp.entity_id as specimen_id")
    .orderBy(specimenOrder(query, place))
    .orderBy("sp.sample_id")
    .orderBy("sp.specimen_number")
    .limit(limit)
    .offset(offset);
  const [rows, count] = await Promise.all([
    db
      .selectFrom(pageKeys.as("pg"))
      .innerJoin("specimen as sp", "sp.entity_id", "pg.specimen_id")
      .innerJoin("sample as s", "s.entity_id", "sp.sample_id")
      // These joins repeat filteredSpecimens's: a change to a join's condition must be made in both.
      .leftJoin("host_name_taxon_cache as hnt", (join) =>
        join.onRef("hnt.host_name", "=", "s.host_name_as_observed").on("s.host_inat_taxon_id", "is", null),
      )
      .leftJoin("sample_atlas as sa", "sa.sample_id", "s.entity_id")
      .leftJoin("program as a", "a.entity_id", "sa.atlas_id")
      .leftJoin("program_abbreviation as pab", "pab.program_id", "a.entity_id")
      .$if(!reader.staff, (qb) =>
        qb
          .leftJoin(ownSamples(db, reader), (join) => join.onRef("own.sample_id", "=", "s.entity_id"))
          .leftJoin("observation_field as seen", "seen.inat_id", "s.inat_observation_id"),
      )
      .leftJoin("sample_location as loc", "loc.sample_id", "s.entity_id")
      .leftJoin("determination_of_record as d", "d.specimen_id", "sp.entity_id")
      .leftJoin("animal as an", "an.entity_id", "d.animal_id")
      .leftJoin("person as det", "det.entity_id", "d.determiner_id")
      .leftJoin("person_orcid_of_record as det_orcid", "det_orcid.person_id", "d.determiner_id")
      .select([
        "sp.entity_id as specimen_id",
        "sp.specimen_number",
        "sp.field_number",
        sql<boolean>`sp.field_number IS NULL AND EXISTS (SELECT 1 FROM printed_label pl WHERE pl.specimen_id = sp.entity_id)`.as(
          "awaiting_number",
        ),
        sql<boolean>`EXISTS (SELECT 1 FROM pending_reprint pr WHERE pr.specimen_id = sp.entity_id)`.as("reprint_requested"),
        sql<ReprintBlocker | null>`${query.act === "reprint" ? sql.raw(REPRINT_BLOCKER) : sql`CAST(NULL AS TEXT)`}`.as(
          "reprint_blocker",
        ),
        "s.entity_id as sample_id",
        "s.sample_number",
        "s.date_start",
        "s.date_end",
        place.locality.as("locality"),
        place.county.as("county"),
        "s.state_province",
        "s.country",
        "s.protocol",
        "s.kind as sample_kind",
        sql<string | null>`(SELECT c.catalog_number FROM specimen_catalog_number c WHERE c.specimen_id = sp.entity_id)`.as(
          "catalog_number",
        ),
        sql<string | null>`(SELECT sd.disposition FROM specimen_disposition sd WHERE sd.specimen_id = sp.entity_id)`.as("disposition"),
        sql<string | null>`(SELECT sd.remarks FROM specimen_disposition sd WHERE sd.specimen_id = sp.entity_id)`.as(
          "occurrence_remarks",
        ),
        sql<string | null>`coalesce(pab.abbreviation, a.code)`.as("atlas_abbreviation"),
        "s.host_name_as_observed as host_name",
        "s.host_rank",
        "s.host_inat_taxon_id",
        "hnt.inat_taxon_id as host_name_taxon_id",
        "an.entity_id as animal_id",
        "an.rank as taxon_rank",
        "an.scientific_name",
        "an.authorship",
        "d.qualifier",
        "d.verbatim_identification",
        "d.sex",
        "d.caste",
        "d.entity_id as determination_id",
        "d.is_expert",
        "d.determined_on",
        "d.determined_on_precision",
        located(hidden, sql<number | null>`loc.latitude`).as("latitude"),
        located(hidden, sql<number | null>`loc.longitude`).as("longitude"),
        located(hidden, sql<number | null>`loc.coordinate_uncertainty_m`).as("coordinate_uncertainty_m"),
        located(hidden, sql<number | null>`loc.elevation_m`).as("elevation_m"),
        located(hidden, sql<string | null>`loc.source`).as("location_source"),
        "s.geoprivacy",
        "s.taxon_geoprivacy",
        hidden.as("location_withheld"),
        sql<string | null>`coalesce(det.display_name, d.determiner_name)`.as("determiner"),
        "det_orcid.orcid as determiner_orcid",
      ])
      // The chosen rows in the order they were chosen in: the same total order, over fifty rows.
      .orderBy(specimenOrder(query, place))
      .orderBy("sp.sample_id")
      .orderBy("sp.specimen_number")
      .execute(),
    // A streamed download pages through everything and never shows a total.
    opts.withTotal === false ? Promise.resolve(undefined) : base.select(({ fn }) => fn.countAll().as("n")).executeTakeFirst(),
  ]);
  const specimenRows = rows as unknown as SpecimenRow[];
  await nameHosts(db, specimenRows, opts.hostNames ?? "all");
  return {
    rows: specimenRows,
    total: Number(count?.n ?? 0),
    collectors: await collectorsOf(db, specimenRows.map((r) => r.sample_id)),
    area: await listedArea(db, query.area, reader, Math.max(specimenRows.length, Number(count?.n ?? 0))),
  };
}

/**
 * What a count may be grouped by: the same three for samples and specimens.
 * `season` is the calendar year of the sample's first day (CONTEXT.md,
 * Season; `sample_season`, schema/102), `atlas` the code of the atlas the
 * sample was collected in (none for a sample outside every atlas), and `kind`
 * net or trap. Each is a column of the sample that every row has or lacks
 * outright, so grouping by it reveals nothing a reader's withheld location
 * would.
 */
export const COUNT_GROUPS = ["season", "atlas", "kind"] as const;
export type CountGroup = (typeof COUNT_GROUPS)[number];

/** How many a query selects, and optionally how they divide, without fetching any rows. */
export interface Counted {
  total: number;
  groups: Array<{ key: string | number | null; total: number }>;
}

const groupExpression = (group: CountGroup): RawBuilder<string | number | null> =>
  group === "season"
    ? sql<number>`CAST(extract(year FROM s.date_start) AS INTEGER)`
    : group === "atlas"
      ? sql<string | null>`a.code`
      : sql<string>`s.kind`;

/**
 * Whether a status filter reads the flag roll-up. A count joins the roll-up
 * only then: it was most of the 130 ms a count took on a 60,000-sample store
 * against 1 ms for a bare count, and the roll-up is one of two joins the page's
 * rows need and a count does not.
 */
export const needsRollup = (query: ListingQuery) => query.qc !== "any" && query.qc !== "locality";

// The two selections are different query builders over the same sample
// columns, which the grouping reads as `s` and `a`; the builder's own type
// cannot say that, so it is left open here and the callers are the check.
// A grouped count is one query: the selection's group key as a subquery,
// grouped outside it (grouping the selection's own joins by an expression made
// DuckDB fail to bind a column), and the total is the sum of the groups.
async function countSelection(
  db: Kysely<Database>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  base: SelectQueryBuilder<any, any, any>,
  group: CountGroup | undefined,
): Promise<Counted> {
  if (group === undefined) {
    const total = await base.select(({ fn }) => fn.countAll().as("n")).executeTakeFirst();
    return { total: Number(total?.n ?? 0), groups: [] };
  }
  const rows = await db
    .selectFrom(base.select(groupExpression(group).as("group_key")).as("g"))
    .select(["g.group_key as key", sql<number>`count(*)`.as("n")])
    .groupBy("g.group_key")
    .orderBy("g.group_key")
    .execute();
  const groups = rows.map((r) => ({ key: r.key as string | number | null, total: Number(r.n) }));
  return { total: groups.reduce((n, g) => n + g.total, 0), groups };
}

/** How many samples a query selects, from the same filters as {@link listSamples}. */
export async function countSamples(
  db: Kysely<Database>,
  query: ListingQuery,
  personId: number,
  reader: Reader,
  group?: CountGroup,
  exact?: ExactLookup,
): Promise<Counted> {
  return countSelection(db, await filteredSamples(db, query, personId, reader, exact, needsRollup(query)), group);
}

/** How many specimens a query selects, from the same filters as {@link listSpecimens}. */
export async function countSpecimens(
  db: Kysely<Database>,
  query: ListingQuery,
  personId: number,
  reader: Reader,
  group?: CountGroup,
  exact?: ExactLookup,
): Promise<Counted> {
  return countSelection(db, await filteredSpecimens(db, query, personId, reader, undefined, exact, needsRollup(query)), group);
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
    .leftJoin("person_orcid_of_record as o", "o.person_id", "c.person_id")
    .where("c.sample_id", "in", [...new Set(sampleIds)])
    .select(["c.sample_id", "p.display_name", "p.given_name", "p.family_name", "p.label_name", "c.position", "o.orcid"])
    .orderBy("c.position")
    .execute();
  for (const row of rows) {
    const list = names.get(row.sample_id) ?? [];
    list.push({ display: row.display_name, label: labelName(row), orcid: row.orcid });
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
 * legacy system, which has its own export, src/legacy-export.ts). The
 * numbers follow what the museums asked for (Andony, gh-98, 2026-10-21): the
 * field number printed on the pin is Beeline's, so it is `fieldNumber`, and
 * `catalogNumber` is the museum's, filled only where Ecdysis has told us one
 * and never derived from the field number. On the samples download, one
 * collecting event per row, `fieldNumber` is the sample number, which is what
 * Darwin Core means by it; on the specimens download that slot holds the
 * pin's number and the sample number is `sampleNumber`, a column of our own.
 * A column Darwin Core has no term for keeps a plain lowerCamelCase name of
 * our own.
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
  // A text cell starting with =, +, -, @, a tab or a carriage return is a
  // formula to Excel and Sheets (OWASP's CSV-injection list); one that is only
  // a number written as text is data like any other.
  if (/^[=+\-@\t\r]/.test(cell) && !/^[+-]?\d+(\.\d+)?$/.test(cell)) cell = `'${cell}`;
  return /[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/**
 * A cell as the text a program is to read exactly: RFC 4180 quoting and no
 * formula guard, since the guard writes an apostrophe into the value. For a
 * file that is loaded into another system and not opened in a spreadsheet
 * (the associations file for Ecdysis, src/app/ecdysis-upload.ts).
 */
export const csvExactLine = (row: readonly unknown[]) =>
  `${row
    .map((value) => {
      if (value === null || value === undefined) return "";
      const cell = String(value);
      return /[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
    })
    .join(",")}\n`;

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

/** A listing as a CSV stream: the header, then every row the filters select. */
export function csvStream<Row>(
  header: readonly string[],
  fetch: (limit: number, offset: number) => Promise<Page<Row>>,
  toRow: (row: Row, page: Page<Row>) => readonly unknown[],
  timing?: CsvTiming,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return pagedStream(
    header[0] ?? "csv",
    fetch,
    {
      head: () => [encoder.encode(CSV_BOM + csvLine(header))],
      page: (page) => [encoder.encode(page.rows.map((r) => csvLine(toRow(r, page))).join(""))],
      tail: () => [],
    },
    timing,
  );
}

/**
 * A value as the text of a spreadsheet cell, or null for none. The same text
 * the CSV writes, without its formula guard: a text cell is never evaluated,
 * so a leading `=` is just a character, and the guard would change what the
 * person sees and what the upload compares (docs/architecture/loading-an-edited-download.md).
 */
export function textCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? isoDate(value) : String(value);
}

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A listing as an Excel file, one sheet with the header in row 1 and every cell text: the same pages and rows as csvStream. */
export function xlsxStream<Row>(
  sheetName: string,
  header: readonly string[],
  fetch: (limit: number, offset: number) => Promise<Page<Row>>,
  toRow: (row: Row, page: Page<Row>) => readonly unknown[],
  timing?: CsvTiming,
  /** What the workbook offers beyond the rows: choices, extra sheets, shading (xlsxWriter's options). */
  options?: Pick<XlsxWriterOptions, "sheets" | "choices" | "shadedColumns" | "boldHeadings" | "widths" | "wrappedColumns">,
): ReadableStream<Uint8Array> {
  const writer = xlsxWriter({ sheetName, header, ...options });
  return pagedStream(
    header[0] ?? "xlsx",
    fetch,
    {
      head: () => writer.head(),
      page: (page) => writer.rows(page.rows.map((r) => toRow(r, page).map(textCell))),
      tail: () => writer.tail(),
    },
    timing,
  );
}

/** What a paged download writes: before the first page, for each page, and after the last. */
export interface PagedWriter<P> {
  head(): Uint8Array[];
  page(page: P): Uint8Array[];
  tail(): Uint8Array[];
}

/**
 * A whole selection as a stream: whatever the writer puts first, then page
 * after page until the store has none left, then whatever it puts last. The
 * listing queries end in a unique tie-breaker, so paging by offset neither
 * skips nor repeats a row.
 *
 * `timing`, when given, hears once how long the pages spent in the store and
 * how the download ended: the response has gone before any page is fetched,
 * so the request's own duration sees none of this (src/app/request-timing.ts).
 * `name` says which download failed, in the log and in Sentry.
 */
export function pagedStream<P extends { rows: readonly unknown[]; last?: boolean }>(
  name: string,
  fetch: (limit: number, offset: number) => Promise<P>,
  writer: PagedWriter<P>,
  timing?: CsvTiming,
): ReadableStream<Uint8Array> {
  let offset = 0;
  let started = false;
  let storeMs = 0;
  /** When the page being fetched now was asked for; null between fetches. */
  let fetchingSince: number | null = null;
  /** The client cancelled while a page was being fetched: report when it settles. */
  let cancelled = false;
  let reported = false;
  const report = (outcome: "complete" | "failed" | "cancelled") => {
    if (reported || timing === undefined) return;
    reported = true;
    timing(storeMs, offset, outcome);
  };
  /**
   * One step: the header, or one page. True when the stream was given
   * something, was closed, or ended; false when the page wrote nothing yet (a
   * compressor holds a short page's bytes back), in which case a stream that
   * simply returned would never be asked for the next page.
   */
  const step = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<boolean> => {
      if (!started) {
        started = true;
        let any = false;
        for (const chunk of writer.head()) {
          controller.enqueue(chunk);
          any = true;
        }
        return any;
      }
      let page: P;
      let chunks: Uint8Array[];
      const t0 = performance.now();
      fetchingSince = t0;
      let fetched = false;
      try {
        page = await fetch(CSV_PAGE_SIZE, offset);
        storeMs += performance.now() - t0;
        fetchingSince = null;
        fetched = true;
        chunks = writer.page(page);
        if (page.last ?? page.rows.length < CSV_PAGE_SIZE) chunks.push(...writer.tail());
      } catch (err) {
        if (!fetched) storeMs += performance.now() - t0;
        fetchingSince = null;
        // The 200 and the header went out with the first page, so the app's
        // error handler never sees this: the client gets a cut-off transfer
        // and nothing else would record why (Fable's review of #110). A row
        // that will not convert ends the download the same way.
        reportError(err, { download: name, rowsWritten: String(offset) });
        console.error(`Download of ${name} failed after ${offset} rows: ${(err as Error).stack ?? String(err)}`);
        if (cancelled) {
          report("cancelled"); // nobody is reading any more; there is no stream to fail
          return true;
        }
        report("failed");
        controller.error(err);
        return true;
      }
      if (cancelled) {
        report("cancelled");
        return true;
      }
      let any = false;
      for (const chunk of chunks) {
        if (chunk.byteLength > 0) {
          controller.enqueue(chunk);
          any = true;
        }
      }
      offset += page.rows.length;
      if (page.last ?? page.rows.length < CSV_PAGE_SIZE) {
        report("complete");
        controller.close();
        return true;
      }
      return any;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!(await step(controller))) {
        // Nothing was written: fetch the next page rather than wait to be asked.
      }
    },
    // The client went away before the end: what was fetched still cost what
    // it cost. A page still being fetched reports when it settles, so its
    // whole time is counted.
    cancel() {
      if (fetchingSince !== null) cancelled = true;
      else report("cancelled");
    },
  });
}

/** Dates go out as ISO, whatever shape the driver handed back. */
export function isoDate(value: Date | string): string {
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
/** The store's alpha-3 for an alpha-2 code the download writes, the inverse of the table above; undefined for a code the download never writes. */
export const alpha3Of = (alpha2: string): string | undefined => Object.entries(ALPHA2).find(([, two]) => two === alpha2)?.[0];

/**
 * dwc:associatedTaxa: the floral host, in the term's own quoted form
 * ("host":"Quercus alba"), with the relationship the legacy records used; or,
 * where the method names a trap, the plant near the trap ("near":"Ceanothus"),
 * since a trap does not say which flower its bees visited (beeline-vjqy).
 */
const associatedTaxa = (host: string | null, method: string | null) => associatedTaxaFor(host, plantRelationship(method));

/** The same term with the relationship given: the upload to Ecdysis decides it by the sample's kind, not by words in its method. */
export const associatedTaxaFor = (host: string | null, relationship: "near" | "visits flowers of") =>
  host === null || host === "" ? null : `"${relationship}":"${host.replaceAll('"', "'")}"`;

/**
 * dwc:geodeticDatum: WGS84 for every point there is. iNaturalist stores
 * nothing else, and the imported and staff-entered points came from
 * iNaturalist or a phone. Darwin Core also allows
 * "unknown", which this wrote for imported and staff-entered points until
 * beeline-8dx9.8, but GBIF's parser rejects it and assumes WGS84 in its
 * place, so saying so is no loss and spares every record a warning.
 */
const datum = (latitude: number | null) => (latitude === null ? null : "WGS84");

const qcLabel = (row: { blocking: number; warning: number }) =>
  row.blocking > 0 ? "blocking" : row.warning > 0 ? "warning" : "clean";

const recordedBy = <Row>(page: Page<Row>, sampleId: number) =>
  (page.collectors.get(sampleId) ?? []).map((c) => c.display).join(" | ");

/**
 * dwc:recordedByID: the ORCID iDs of whichever collectors have one, in
 * recordedBy order and separated as recordedBy is (beeline-0544). Darwin
 * Core gives the order of this list no meaning, so a collector with no iD is
 * simply absent from it rather than held open by a blank.
 */
const recordedByID = <Row>(page: Page<Row>, sampleId: number) =>
  (page.collectors.get(sampleId) ?? [])
    .flatMap((c) => (c.orcid === null ? [] : [orcidUrl(c.orcid)]))
    .join(" | ");

/** dwc:identifiedByID: the determiner's ORCID iD, where they have one. */
export const identifiedByID = (orcid: string | null) => (orcid === null ? null : orcidUrl(orcid));

/** The samples download: one collecting event per row. */
export const SAMPLE_CSV_HEADER = [
  "fieldNumber",
  "eventDate",
  "samplingProtocol",
  "recordedBy",
  "recordedByID",
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
  // Added last, so a reader that finds the columns above by position still does (beeline-rfkj.4).
  "hostInatTaxonId",
  "hostCurrentName",
  "hostFamily",
  "hostCommonName",
] as const;

export const sampleCsvRow = (r: SampleRow, page: Page<SampleRow>): unknown[] => [
  r.sample_number,
  eventDate(r.date_start, r.date_end),
  r.protocol,
  recordedBy(page, r.sample_id),
  recordedByID(page, r.sample_id),
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
  associatedTaxa(r.host_name, r.protocol),
  r.kind,
  r.specimen_count,
  r.host_rank,
  r.atlas_abbreviation,
  r.location_source,
  r.geoprivacy,
  r.taxon_geoprivacy,
  qcLabel(r),
  r.inat_observation_id,
  r.host_inat_taxon_id,
  r.host_current_name,
  r.host_family,
  r.host_common_name,
];

/** dwc:dateIdentified, as Darwin Core would have it: a year-only date is the year, not January 1st. */
export const dateIdentified = (on: Date | string | null, precision: "month" | "year" | null) =>
  on === null
    ? null
    : precision === "year"
      ? isoDate(on).slice(0, 4)
      : precision === "month"
        ? isoDate(on).slice(0, 7)
        : isoDate(on);

/**
 * The specimens download: one occurrence per row, a preserved specimen. The
 * Darwin Core columns come first and Beeline's own after them, kept apart
 * because the Darwin Core archive declares only the first.
 */
export const SPECIMEN_DWC_COLUMNS = [
  "occurrenceID",
  "basisOfRecord",
  "catalogNumber",
  "fieldNumber",
  "disposition",
  "occurrenceRemarks",
  "eventDate",
  "samplingProtocol",
  "recordedBy",
  "recordedByID",
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
  "identifiedByID",
  "dateIdentified",
] as const;

/** Beeline's own, with no Darwin Core term. */
export const SPECIMEN_OWN_COLUMNS = [
  "sampleNumber",
  "specimenNumber",
  "atlas",
  "hostRank",
  "locationSource",
  "geoprivacy",
  "taxonGeoprivacy",
  "identifiedByExpert",
  // Added last, so a reader that finds the columns above by position still does (beeline-rfkj.4).
  "hostInatTaxonId",
  "hostCurrentName",
  "hostFamily",
  "hostCommonName",
  // Added last again (beeline-kgyd): what loading an edited copy of this file
  // back into Beeline reads. See ROUND_TRIP_COLUMNS.
  "caste",
  "specimenId",
  "specimenVersion",
  "sampleVersion",
] as const;

/**
 * The columns that exist so that an edited copy of the download can be loaded
 * back (beeline-kgyd), and that say nothing about the bee to anyone else:
 * - `specimenId` is Beeline's own id for the specimen. A field number is not
 *   unique, may be absent, and is the cell a spreadsheet is likeliest to
 *   damage (a dropped leading zero), so the row is found by this.
 * - `specimenVersion` is a short name for what the specimen's own changeable
 *   cells said when the row was written: see `specimenVersion`. If it is not
 *   the specimen's now when the file comes back, the row was edited against
 *   something Beeline no longer says.
 * - `sampleVersion` does the same for the sample's cells that staff may
 *   change: see `sampleVersion`.
 */
export const ROUND_TRIP_COLUMNS = ["specimenId", "specimenVersion", "sampleVersion"] as const;

/**
 * A short name for what the sample's changeable cells said when the row was
 * written: the collecting dates, the method, the locality and the point, as
 * this reader was given them. Two rows with the same version read the same
 * values, so a file whose version is still the sample's was edited against
 * what Beeline says now. Made from the reader's own values, so that where the
 * location is withheld it says nothing about the true one. It starts with a
 * letter because a spreadsheet reads a run of digits, or digits around an
 * `e`, as a number and rewrites it.
 */
export const sampleVersion = (
  r: Pick<SpecimenRow, "sample_id" | "date_start" | "date_end" | "protocol" | "locality" | "latitude" | "longitude" | "coordinate_uncertainty_m">,
): string =>
  `v${createHash("sha256")
    .update(
      JSON.stringify([
        // The sample's own id, so two samples that say the same things do not share a version, and a file whose
        // rows were shifted onto other samples is seen to be about the wrong ones.
        r.sample_id,
        eventDate(r.date_start, r.date_end),
        r.protocol,
        r.locality,
        r.latitude,
        r.longitude,
        r.coordinate_uncertainty_m,
      ]),
    )
    .digest("hex")
    .slice(0, 12)}`;

/**
 * A short name for what the specimen's own changeable cells said when the row
 * was written: its name, qualifier, sex, caste, determiner and date
 * identified as the row writes them, its disposition and remarks, the id of
 * the determination they were read from, and the specimen's own id (so two
 * specimens that say the same things have different versions). It replaces the determination's
 * id alone, which says nothing when a loader updates a determination in
 * place or a person's or a taxon's name is corrected: the id stays and the
 * cells change. The `s` is there for the reason `sampleVersion` starts with
 * `v`.
 */
export const specimenVersion = (
  r: Pick<
    SpecimenRow,
    | "specimen_id"
    | "scientific_name"
    | "qualifier"
    | "sex"
    | "caste"
    | "determiner"
    | "determined_on"
    | "determined_on_precision"
    | "disposition"
    | "occurrence_remarks"
    | "determination_id"
  >,
): string =>
  `s${createHash("sha256")
    .update(
      JSON.stringify([
        // The specimen's own id: two specimens with no determination and no disposition say the same things, and
        // a file whose specimenId cells were shifted onto other rows must not look current.
        r.specimen_id,
        r.scientific_name,
        r.qualifier,
        r.sex,
        r.caste,
        r.determiner,
        dateIdentified(r.determined_on, r.determined_on_precision),
        r.disposition,
        r.occurrence_remarks,
        r.determination_id,
      ]),
    )
    .digest("hex")
    .slice(0, 12)}`;

export const SPECIMEN_CSV_HEADER = [...SPECIMEN_DWC_COLUMNS, ...SPECIMEN_OWN_COLUMNS] as const;

export const specimenCsvRow = (r: SpecimenRow, page: Page<SpecimenRow>): unknown[] => [
  // occurrenceID: blank. Beeline mints none; a specimen gets one from the
  // museum database its record reaches, and reading it back is optional
  // (ADR 0008, amended 2026-10-23; beeline-9ut.8).
  null,
  "PreservedSpecimen",
  r.catalog_number,
  r.field_number,
  r.disposition,
  r.occurrence_remarks,
  eventDate(r.date_start, r.date_end),
  r.protocol,
  recordedBy(page, r.sample_id),
  recordedByID(page, r.sample_id),
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
  associatedTaxa(r.host_name, r.protocol),
  r.scientific_name,
  r.authorship,
  r.taxon_rank,
  r.qualifier,
  r.verbatim_identification,
  r.sex,
  r.determiner,
  identifiedByID(r.determiner_orcid),
  dateIdentified(r.determined_on, r.determined_on_precision),
  r.sample_number,
  r.specimen_number,
  r.atlas_abbreviation,
  r.host_rank,
  r.location_source,
  r.geoprivacy,
  r.taxon_geoprivacy,
  r.is_expert === null ? null : String(r.is_expert),
  r.host_inat_taxon_id,
  r.host_current_name,
  r.host_family,
  r.host_common_name,
  r.caste,
  r.specimen_id,
  specimenVersion(r),
  sampleVersion(r),
];

/**
 * The collection years there are samples from, newest first, for the listings'
 * year menu. The calendar year of a sample's first day, as `sample_season`
 * says (schema/102), so a year offered here and one filtered on are one thing.
 */
export async function listingYears(db: Kysely<Database>): Promise<number[]> {
  const result = await sql<{ y: number }>`
    SELECT DISTINCT CAST(extract(year FROM date_start) AS INTEGER) AS y FROM sample ORDER BY y DESC`.execute(db);
  return result.rows.map((r) => r.y);
}
