import { sql, type Kysely } from "kysely";
import { PROGRAM_MEMBERSHIP, type Database, type SampleKind } from "../model.js";
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
/** A CSV is one query, not a crawl: past this the export says it was cut. */
export const CSV_ROW_LIMIT = 20_000;

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
 * Which seasons to show. The dashboard settles earlier ones (beeline-2c3.24)
 * and then has to be able to point at exactly what it settled, so "earlier
 * seasons" is a filter here rather than a set only the dashboard can name.
 */
export type SeasonState = "any" | "open" | "settled";
export const SEASON_STATES = ["any", "open", "settled"] as const;

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
  /**
   * On specimens, whether this specimen carries a determination of record. On
   * samples, whether every specimen does: "undetermined" is a sample with at
   * least one specimen still waiting for a name.
   */
  det: DeterminationState;
  season: SeasonState;
  qc: QcStatus;
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
  det: "any",
  season: "any",
  qc: "any",
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
  const season = params.get("season") ?? "";
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
    det: (DETERMINATION_STATES as readonly string[]).includes(det) ? (det as DeterminationState) : "any",
    season: (SEASON_STATES as readonly string[]).includes(season) ? (season as SeasonState) : "any",
    qc: (QC_STATUSES as readonly string[]).includes(qc) ? (qc as QcStatus) : "any",
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, 10_000) : 1,
  };
}

/** The listing's own URL, with some parts changed — paging, scope, reset. */
export function listingHref(path: string, query: ListingQuery, overrides: Partial<ListingQuery> = {}): string {
  const merged = { ...query, ...overrides };
  const params = new URLSearchParams();
  // Defaults stay out of the URL, so the plain path is the plain listing.
  if (merged.scope !== MINE) params.set("scope", merged.scope);
  if (merged.q !== "") params.set("q", merged.q);
  if (merged.from !== null) params.set("from", merged.from);
  if (merged.to !== null) params.set("to", merged.to);
  if (merged.place !== "") params.set("place", merged.place);
  if (merged.collector !== "") params.set("collector", merged.collector);
  if (merged.member !== MEMBER_ANY) params.set("member", merged.member);
  if (merged.taxon !== "") params.set("taxon", merged.taxon);
  if (merged.det !== "any") params.set("det", merged.det);
  if (merged.season !== "any") params.set("season", merged.season);
  if (merged.qc !== "any") params.set("qc", merged.qc);
  if (merged.page > 1) params.set("page", String(merged.page));
  const search = params.toString();
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
  q.det !== "any" ||
  q.season !== "any" ||
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
  specimen_count: number;
  inat_observation_id: bigint | null;
  atlas_code: string | null;
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
  sample_id: number;
  sample_number: string;
  date_start: Date;
  locality: string | null;
  county: string | null;
  state_province: string | null;
  atlas_code: string | null;
  taxon_rank: string | null;
  scientific_name: string | null;
  authorship: string | null;
  sex: string | null;
  is_expert: boolean | null;
  determiner: string | null;
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
 * Whoever ran this sample, by display name or iNat login. Anyone on the
 * collector list counts: asking "show me Michael's samples" and getting only
 * the ones he numbered would be the same mistake the list exists to fix.
 */
/** Settled seasons, or the open one — the same view the dashboard reads. */
const inSeason = (state: SeasonState) =>
  state === "any"
    ? null
    : sql<boolean>`${state === "settled" ? sql`` : sql`NOT `}EXISTS (
        SELECT 1 FROM settled_sample st WHERE st.sample_id = s.entity_id
      )`;

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
    .leftJoin("atlas as a", "a.entity_id", "s.atlas_id")
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
    base = base.where("s.atlas_id", "is", null);
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
  const season = inSeason(query.season);
  if (season !== null) base = base.where(season);
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
        "s.specimen_count",
        "s.inat_observation_id",
        "a.code as atlas_code",
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
      .orderBy("s.date_start", "desc")
      .orderBy(BY_SAMPLE_NUMBER)
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
    .leftJoin("atlas as a", "a.entity_id", "s.atlas_id")
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
    base = base.where("s.atlas_id", "is", null);
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
  const season = inSeason(query.season);
  if (season !== null) base = base.where(season);
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
        "s.entity_id as sample_id",
        "s.sample_number",
        "s.date_start",
        "s.locality",
        "s.county",
        "s.state_province",
        "a.code as atlas_code",
        "an.rank as taxon_rank",
        "an.scientific_name",
        "an.authorship",
        "d.sex",
        "d.is_expert",
        "loc.latitude",
        "loc.longitude",
        "loc.coordinate_uncertainty_m",
        "loc.elevation_m",
        "loc.source as location_source",
        "s.geoprivacy",
        "s.taxon_geoprivacy",
        sql<string | null>`coalesce(det.display_name, d.determiner_name)`.as("determiner"),
      ])
      .orderBy("s.date_start", "desc")
      .orderBy(BY_SAMPLE_NUMBER)
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
 * Headers are stable machine names, not the table's column labels: a CSV is
 * read by a spreadsheet and by whatever script comes after it, so renaming a
 * screen must not rename a column. Coordinates are in it, with the provenance
 * and geoprivacy of the record beside them, so a row carries what a reader
 * needs to judge it.
 */

/** RFC 4180 quoting, plus the leading-punctuation guard spreadsheets need. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let cell = value instanceof Date ? isoDate(value) : String(value);
  // A cell starting with =, +, -, or @ is a formula to Excel and Sheets.
  if (/^[=+\-@]/.test(cell)) cell = `'${cell}`;
  return /[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  const lines = [header.join(","), ...rows.map((row) => row.map(csvCell).join(","))];
  // A file that stopped short must say so inside itself: the page's warning
  // does not travel with a bookmarked download.
  if (rows.length >= CSV_ROW_LIMIT) {
    lines.push(csvCell(`truncated at ${CSV_ROW_LIMIT} rows — narrow the filters for the rest`));
  }
  return lines.join("\r\n");
}

/** Dates go out as ISO, whatever shape the driver handed back. */
function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

const qcLabel = (row: { blocking: number; warning: number }) =>
  row.blocking > 0 ? "blocking" : row.warning > 0 ? "warning" : "clean";

export function sampleCsv(page: Page<SampleRow>): string {
  return toCsv(
    [
      "sample_number",
      "kind",
      "date_start",
      "date_end",
      "collectors",
      "locality",
      "county",
      "state_province",
      "country",
      "specimen_count",
      "atlas",
      "latitude",
      "longitude",
      "coordinate_uncertainty_m",
      "elevation_m",
      "location_source",
      "geoprivacy",
      "taxon_geoprivacy",
      "qc_status",
      "inat_observation_id",
    ],
    page.rows.map((r) => [
      r.sample_number,
      r.kind,
      isoDate(r.date_start),
      isoDate(r.date_end),
      (page.collectors.get(r.sample_id) ?? []).map((c) => c.display).join(" | "),
      r.locality,
      r.county,
      r.state_province,
      r.country,
      r.specimen_count,
      r.atlas_code,
      r.latitude,
      r.longitude,
      r.coordinate_uncertainty_m,
      r.elevation_m,
      r.location_source,
      r.geoprivacy,
      r.taxon_geoprivacy,
      qcLabel(r),
      r.inat_observation_id,
    ]),
  );
}

export function specimenCsv(page: Page<SpecimenRow>): string {
  return toCsv(
    [
      "field_number",
      "specimen_number",
      "sample_number",
      "date_start",
      "collectors",
      "locality",
      "county",
      "state_province",
      "atlas",
      "latitude",
      "longitude",
      "coordinate_uncertainty_m",
      "elevation_m",
      "location_source",
      "geoprivacy",
      "taxon_geoprivacy",
      "scientific_name",
      "rank",
      "authorship",
      "sex",
      "determined_by",
      "expert_determination",
    ],
    page.rows.map((r) => [
      r.field_number,
      r.specimen_number,
      r.sample_number,
      isoDate(r.date_start),
      (page.collectors.get(r.sample_id) ?? []).map((c) => c.display).join(" | "),
      r.locality,
      r.county,
      r.state_province,
      r.atlas_code,
      r.latitude,
      r.longitude,
      r.coordinate_uncertainty_m,
      r.elevation_m,
      r.location_source,
      r.geoprivacy,
      r.taxon_geoprivacy,
      r.scientific_name,
      r.taxon_rank,
      r.authorship,
      r.sex,
      r.determiner,
      r.is_expert === null ? "" : String(r.is_expert),
    ]),
  );
}
