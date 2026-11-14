import type { Context, Hono } from "hono";
import type { Kysely } from "kysely";
import type { Database } from "../model.js";
import { PROGRAM_MEMBERSHIP } from "../model.js";
import { apiError, type ApiEnv } from "./api.js";
import {
  ALL,
  atlasOptions,
  COUNT_GROUPS,
  countSamples,
  countSpecimens,
  DETERMINATION_STATES,
  KIND_FILTERS,
  LABEL_FILTERS,
  listSamples,
  listSpecimens,
  MEMBER_UNRECORDED,
  MINE,
  OUTSIDE,
  PAGE_SIZE,
  parseListingQuery,
  QC_RULE_NAMES,
  QC_STATUSES,
  SAMPLE_CSV_HEADER,
  sampleCsvRow,
  SAMPLE_SORT_KEYS,
  SPECIMEN_SORT_KEYS,
  SPECIMEN_CSV_HEADER,
  specimenCsvRow,
  type CountGroup,
  type ExactLookup,
  type ListingQuery,
  type Reader,
} from "./listings.js";
import type { SampleChange } from "../sample-change.js";
import type { SpecimenLabelRow } from "./print-runs.js";
import {
  gatherSample,
  gatherSpecimen,
  parsePage,
  SPECIMEN_PAGE_SIZE,
  type DeterminationEvent,
  type RecordDeps,
  type RecordFinding,
  type SampleDetail,
  type SampleRecord,
  type SampleSpecimenRow,
  type SpecimenDetail,
  type SpecimenRecord,
} from "./record.js";

/**
 * Reading records through the API (beeline-pnqr.2).
 *
 * A key reads exactly what its person reads on the pages, no more. The
 * queries, the filters, the sort, the withholding of locations and the
 * gathering of a record are the pages' own functions (src/app/listings.ts,
 * src/app/record.ts); this file reads the request, calls them and writes the
 * answer as JSON.
 */

/** What the read endpoints need beyond the database. Absent, they answer 503. */
export interface ReadDeps {
  /** The sample change log, which a record's history is read from. */
  changesPath: string;
  /** The app's public origin, which the `url` of each record is made from. */
  origin: string;
}

/** Rows a listing may return in one answer, and the page's own size when none is asked for. */
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = PAGE_SIZE;

/** The filters and ordering of a listing, as the pages take them in the query string (`act` is the pages' bulk action, which the API has none of). */
export const LISTING_FILTERS = [
  "scope",
  "q",
  "from",
  "to",
  "place",
  "collector",
  "member",
  "taxon",
  "host",
  "det",
  "labels",
  "kind",
  "qc",
  "flag",
] as const;
export const LISTING_ORDER = ["sort", "dir"] as const;
/** Whole-value lookups, which the API has beside the filters. */
export const EXACT_LOOKUPS = ["sample_number", "field_number", "catalog_number", "inat_observation_id"] as const;

/**
 * Which parameters an endpoint takes. Anything else is refused by name: the
 * pages ignore what they do not know, which is right for a person who followed
 * an old link and wrong for a program, whose misspelt filter would otherwise
 * quietly answer with everything.
 */
export const LISTING_PARAMETERS = [...LISTING_FILTERS, ...LISTING_ORDER, "page", "page_size", ...EXACT_LOOKUPS] as const;
export const COUNT_PARAMETERS = [...LISTING_FILTERS, ...EXACT_LOOKUPS, "group_by"] as const;
export const SAMPLE_RECORD_PARAMETERS = ["page"] as const;

/** The longest search text the pages keep (`text` in src/app/listings.ts). */
const MAX_TEXT_CHARS = 100;

/** A problem with a request's parameters, said in a sentence. */
class BadRequest extends Error {}

const refuse = (c: Context<ApiEnv>, err: unknown) => {
  if (!(err instanceof BadRequest)) throw err;
  return apiError(c, 400, "invalid_request", err.message);
};

const isIsoDay = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/**
 * Read the listing parameters of a request, strictly. An unknown parameter, a
 * repeated one, or a value the pages would quietly replace with their default
 * (a scope that is not one, a misspelt sort) is refused with a sentence that
 * names it. The value goes to the pages' own parser afterwards, so a query
 * string copied from a page means the same thing here.
 */
function readQuery(
  params: URLSearchParams,
  allowed: readonly string[],
  atlasCodes: readonly string[],
  /** The sorts this listing has: a sort only the other listing has is refused, not quietly replaced by the default order. */
  sortKeys: readonly string[],
): { query: ListingQuery; exact: ExactLookup } {
  const seen = new Set<string>();
  for (const [name] of params) {
    if (!allowed.includes(name)) {
      throw new BadRequest(`Unknown parameter ${JSON.stringify(name)}. This endpoint takes: ${allowed.join(", ")}.`);
    }
    if (seen.has(name)) throw new BadRequest(`The parameter ${JSON.stringify(name)} was sent more than once.`);
    seen.add(name);
  }
  const oneOf = (name: string, values: readonly string[], blank = true) => {
    const v = params.get(name);
    if (v === null || (blank && v === "")) return;
    if (!values.includes(v)) throw new BadRequest(`${JSON.stringify(v)} is not a ${name}. Use one of: ${values.join(", ")}.`);
  };
  oneOf("scope", [MINE, ALL, OUTSIDE, ...atlasCodes]);
  oneOf("member", [PROGRAM_MEMBERSHIP, MEMBER_UNRECORDED, ...atlasCodes]);
  oneOf("qc", QC_STATUSES);
  oneOf("flag", QC_RULE_NAMES);
  oneOf("det", DETERMINATION_STATES);
  oneOf("labels", LABEL_FILTERS);
  oneOf("kind", KIND_FILTERS);
  oneOf("sort", sortKeys);
  oneOf("dir", ["asc", "desc"]);
  for (const name of ["from", "to"]) {
    const v = params.get(name);
    if (v !== null && v !== "" && !isIsoDay(v)) throw new BadRequest(`${name} must be a date as YYYY-MM-DD.`);
  }
  const page = params.get("page");
  if (page !== null && !/^[1-9]\d{0,3}$|^10000$/.test(page)) throw new BadRequest("page must be a whole number from 1 to 10000.");
  // The pages cut these at 100 characters and carry on. A program is told
  // instead, since a cut search term finds something other than what it asked for.
  for (const name of ["q", "place", "collector", "taxon", "host"]) {
    if ((params.get(name) ?? "").trim().length > MAX_TEXT_CHARS) throw new BadRequest(`${name} may be at most ${MAX_TEXT_CHARS} characters.`);
  }

  const exact: ExactLookup = {};
  for (const name of ["sample_number", "field_number", "catalog_number"] as const) {
    const v = params.get(name);
    if (v === null) continue;
    if (v.trim() === "" || v.length > 100) throw new BadRequest(`${name} must be 1 to 100 characters.`);
    exact[name] = v.trim();
  }
  const observation = params.get("inat_observation_id");
  if (observation !== null) {
    if (!/^[1-9]\d{0,17}$/.test(observation)) throw new BadRequest("inat_observation_id must be a whole number.");
    exact.inat_observation_id = BigInt(observation);
  }
  // The pages' own parser, with no remembered scope (there is no cookie here)
  // and no bulk action. Every value it would replace has been refused above.
  const query = parseListingQuery(params, { atlasCodes });
  return { query: { ...query, act: "" }, exact };
}

function readPageSize(params: URLSearchParams): number {
  const v = params.get("page_size");
  if (v === null) return DEFAULT_PAGE_SIZE;
  if (!/^[1-9]\d{0,2}$/.test(v) || Number(v) > MAX_PAGE_SIZE) {
    throw new BadRequest(`page_size must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return Number(v);
}

function readGroup(params: URLSearchParams): CountGroup | undefined {
  const v = params.get("group_by");
  if (v === null) return undefined;
  if (!(COUNT_GROUPS as readonly string[]).includes(v)) {
    throw new BadRequest(`group_by must be one of: ${COUNT_GROUPS.join(", ")}.`);
  }
  return v as CountGroup;
}

// --- Writing values as JSON ---------------------------------------------------

/** Keys whose value is a calendar day, not a moment. */
const DAY_KEYS = new Set(["date_start", "date_end", "determined_on", "remarks_on", "observation_gone_since"]);

/**
 * A value as JSON: a day as YYYY-MM-DD, a moment as an ISO 8601 string in UTC,
 * a bigint as a number where it is a safe integer and as text where it is not.
 */
export function plain(value: unknown, key = ""): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value instanceof Date) return DAY_KEYS.has(key) ? value.toISOString().slice(0, 10) : value.toISOString();
  if (Array.isArray(value)) return value.map((v) => plain(v, key));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plain(v, k)]));
  }
  return value;
}

/** A listing row: the CSV's columns under the CSV's names, with what the CSV cannot say. */
const rowOf = (header: readonly string[], cells: readonly unknown[]) =>
  Object.fromEntries(header.map((name, i) => [name, plain(cells[i])]));

// --- A record -------------------------------------------------------------------

/**
 * Which fields of a row the API publishes, decided one by one. A column added
 * to what a page reads is not published until someone lists it here as `true`
 * (or as `false`, to say it was considered and kept back): the typecheck fails
 * until every key of the row type has an entry, and the tests hold each
 * object's exact set of keys. Nested objects (the collectors, an override) are
 * published whole.
 */
type Publish<T> = { [K in keyof T]-?: boolean };

const pick = <T extends object>(row: T, spec: Publish<T>) =>
  Object.fromEntries(
    (Object.keys(spec) as Array<keyof T & string>).filter((k) => spec[k]).map((k) => [k, plain(row[k], k)]),
  );

export const SAMPLE_PUBLISHED: Publish<SampleDetail> = {
  sample_id: true, kind: true, sample_number: true, date_start: true, date_end: true, specimen_count: true,
  locality: true, county: true, state_province: true, country: true, protocol: true, sampling_effort: true,
  inat_observation_id: true, observation_gone_since: true, host_inat_taxon_id: true, host_name_as_observed: true,
  host_rank: true, observation_place_guess: true, observation_notes: true, geoprivacy: true, taxon_geoprivacy: true,
  atlas_code: true, atlas_name: true, program_code: true, program_name: true, latitude: true, longitude: true,
  coordinate_uncertainty_m: true, location_source: true, elevation_m: true, elevation_source: true, elevation_file: true,
  elevation_stale: true, mine: true, location_withheld: true, printed: true, from_old_records: true,
  locality_override: true, location_override: true, label_diverged: true, locality_suggestion: true,
  locality_alternatives: true, wildernesses: true, ecoregion: true, collectors: true,
};
export const SPECIMEN_PUBLISHED: Publish<Omit<SpecimenDetail, "sample">> = {
  specimen_id: true, specimen_number: true, field_number: true, disposition: true, remarks: true, remarks_by: true, remarks_on: true,
};
export const SPECIMEN_ROW_PUBLISHED: Publish<SampleSpecimenRow> = {
  specimen_id: true, specimen_number: true, field_number: true, label_state: true, label_at: true, reprint_requested: true,
  rank: true, scientific_name: true, authorship: true, qualifier: true, sex: true, determiner: true, is_expert: true,
};
export const FINDING_PUBLISHED: Publish<RecordFinding> = {
  rule_name: true, details: true, detail_taxon_name: true, detail_taxon_rank: true, severity: true, specimen_id: true,
  field_number: true, waivable: true,
};
export const DETERMINATION_PUBLISHED: Publish<DeterminationEvent> = {
  entity_id: true, rank: true, scientific_name: true, authorship: true, qualifier: true, verbatim_identification: true,
  sex: true, caste: true, determiner: true, is_expert: true, channel: true, determined_on: true, determined_on_precision: true,
  recorded_at: true, notes: true, of_record: true,
};
export const LABEL_PUBLISHED: Publish<SpecimenLabelRow> = {
  print_run_id: false, number_text: true, state: true, sheet: true, cell: true, prepared_at: true, printed_at: true,
  mailed_at: true, canceled_at: true, atlas_code: true, reprint: true, request: true,
};
export const HISTORY_PUBLISHED: Publish<SampleChange> = {
  at: true, collector: false, sample_number: false, date_start: false, field: true, old_value: true, new_value: true,
  author: true, source: true, reason: true,
};

/** A sample as the API publishes it, with its id and address. */
const sampleOf = (sample: SampleDetail, origin: string) => ({
  ...pick(sample, SAMPLE_PUBLISHED),
  id: sample.sample_id,
  url: `${origin}/samples/${sample.sample_id}`,
});

/**
 * The sample record as JSON. Where the location is withheld from this reader
 * the sample's own fields already say so (`location_withheld: true` and nothing
 * below the county or state), and the findings and the history have lost what
 * would say where (`visibleFindings`, `visibleHistory`, including the reason on
 * each entry that stays). Three more things are left out here that the page
 * does not show to this reader either: the reason of a hold and the text of a
 * waiver where the location is withheld (the page shows a hold's reason only as
 * the staff_hold finding's detail, already blanked, and drops a waiver's text),
 * and who placed a hold unless the reader is staff.
 *
 * `requestedPage` is the page of specimens asked for. The page clamps a page
 * past the end to the last; the API answers the page asked for, empty, with
 * the real number of pages, so a program that walks pages can tell when it has
 * reached the end.
 */
export function sampleJson(record: SampleRecord, origin: string, staff: boolean, requestedPage = record.specimens.page) {
  const withheld = record.sample.location_withheld;
  const pastEnd = requestedPage > record.specimens.pages;
  return {
    sample: sampleOf(record.sample, origin),
    findings: record.findings.map((f) => pick(f, FINDING_PUBLISHED)),
    hold:
      record.hold === null
        ? null
        : {
            reason: withheld ? null : record.hold.reason,
            reason_withheld: withheld,
            held_by: staff ? record.hold.held_by : null,
          },
    waivers: record.waivers.map((w) => ({
      rule_name: w.rule_name,
      finding: withheld ? null : w.finding,
      reason: withheld ? null : w.reason,
      text_withheld: withheld,
      waived_by: w.waived_by,
      in_force: w.in_force,
    })),
    specimens: {
      total: record.specimens.total,
      page: pastEnd ? requestedPage : record.specimens.page,
      pages: record.specimens.pages,
      page_size: SPECIMEN_PAGE_SIZE,
      rows: pastEnd
        ? []
        : record.specimens.rows.map((r) => ({
            ...pick(r, SPECIMEN_ROW_PUBLISHED),
            id: r.specimen_id,
            url: `${origin}/specimens/${r.specimen_id}`,
          })),
    },
    history: record.history.map((h) => pick(h, HISTORY_PUBLISHED)),
  };
}

/** The specimen record as JSON, under the same rules as {@link sampleJson}. */
export function specimenJson(record: SpecimenRecord, origin: string) {
  const { specimen } = record;
  return {
    specimen: { ...pick(specimen, SPECIMEN_PUBLISHED), id: specimen.specimen_id, url: `${origin}/specimens/${specimen.specimen_id}` },
    sample: sampleOf(specimen.sample, origin),
    determinations: record.events.map((e) => pick(e, DETERMINATION_PUBLISHED)),
    findings: record.findings.map((f) => pick(f, FINDING_PUBLISHED)),
    labels: record.labels.map((l) => pick(l, LABEL_PUBLISHED)),
    reprint: plain(record.reprint),
  };
}

// --- The routes ----------------------------------------------------------------

export function registerReadRoutes(api: Hono<ApiEnv>, db: Kysely<Database>, read: ReadDeps | undefined): void {
  /** Whoever the key is, as the pages would see a session with no acting and no impersonation. */
  const readerOf = (c: Context<ApiEnv>): Reader => ({ staff: c.get("staff"), personIds: [c.get("key").personId] });
  const personOf = (c: Context<ApiEnv>) => c.get("key").personId;
  const unavailable = (c: Context<ApiEnv>) => apiError(c, 503, "unavailable", "Reading is not available on this instance.");

  const params = (c: Context<ApiEnv>) => new URL(c.req.url).searchParams;
  const atlasCodes = async () => (await atlasOptions(db)).map((a) => a.code);

  for (const kind of ["samples", "specimens"] as const) {
    const header = kind === "samples" ? SAMPLE_CSV_HEADER : SPECIMEN_CSV_HEADER;
    const sortKeys = kind === "samples" ? SAMPLE_SORT_KEYS : SPECIMEN_SORT_KEYS;

    // The listing, one page of it: what the page shows, as data.
    api.get(`/${kind}`, async (c) => {
      if (read === undefined) return unavailable(c);
      let parsed: ReturnType<typeof readQuery>;
      let pageSize: number;
      try {
        parsed = readQuery(params(c), LISTING_PARAMETERS, await atlasCodes(), sortKeys);
        pageSize = readPageSize(params(c));
      } catch (err) {
        return refuse(c, err);
      }
      const { query, exact } = parsed;
      const options = { limit: pageSize, offset: (query.page - 1) * pageSize, withFlagWords: false, exact };
      const answer = (total: number, rows: unknown[]) =>
        c.json({ total, page: query.page, page_size: pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), rows });
      if (kind === "samples") {
        const page = await listSamples(db, query, personOf(c), readerOf(c), options);
        return answer(
          page.total,
          page.rows.map((r) => ({
            ...rowOf(header, sampleCsvRow(r, page)),
            id: r.sample_id,
            url: `${read.origin}/samples/${r.sample_id}`,
            location_withheld: r.location_withheld,
          })),
        );
      }
      const page = await listSpecimens(db, query, personOf(c), readerOf(c), options);
      return answer(
        page.total,
        page.rows.map((r) => ({
          ...rowOf(header, specimenCsvRow(r, page)),
          id: r.specimen_id,
          url: `${read.origin}/specimens/${r.specimen_id}`,
          sample_id: r.sample_id,
          sample_url: `${read.origin}/samples/${r.sample_id}`,
          location_withheld: r.location_withheld,
        })),
      );
    });

    // How many, from the same filters and without fetching rows; and how they divide.
    // Registered before the record route, so that "count" is not read as an id.
    api.get(`/${kind}/count`, async (c) => {
      let parsed: ReturnType<typeof readQuery>;
      let group: CountGroup | undefined;
      try {
        parsed = readQuery(params(c), COUNT_PARAMETERS, await atlasCodes(), sortKeys);
        group = readGroup(params(c));
      } catch (err) {
        return refuse(c, err);
      }
      const count = kind === "samples" ? countSamples : countSpecimens;
      const counted = await count(db, parsed.query, personOf(c), readerOf(c), group, parsed.exact);
      return c.json(group === undefined ? { total: counted.total } : { total: counted.total, group_by: group, groups: counted.groups });
    });

    // One record, as its page shows it to this reader.
    api.get(`/${kind}/:id`, async (c) => {
      if (read === undefined) return unavailable(c);
      const raw = c.req.param("id");
      const notFound = () => apiError(c, 404, "not found", `No such ${kind === "samples" ? "sample" : "specimen"}.`);
      if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2_147_483_647) return notFound();
      const deps: RecordDeps = { db, changesPath: read.changesPath };
      if (kind === "samples") {
        let specimenPage = 1;
        try {
          const seen = new Set<string>();
          for (const [name] of params(c)) {
            if (!(SAMPLE_RECORD_PARAMETERS as readonly string[]).includes(name)) {
              throw new BadRequest(`Unknown parameter ${JSON.stringify(name)}. This endpoint takes: ${SAMPLE_RECORD_PARAMETERS.join(", ")}.`);
            }
            if (seen.has(name)) throw new BadRequest(`The parameter ${JSON.stringify(name)} was sent more than once.`);
            seen.add(name);
          }
          const page = params(c).get("page");
          if (page !== null && !/^[1-9]\d{0,3}$|^10000$/.test(page)) throw new BadRequest("page must be a whole number from 1 to 10000.");
          specimenPage = parsePage(page ?? undefined);
        } catch (err) {
          return refuse(c, err);
        }
        const record = await gatherSample(deps, Number(raw), personOf(c), readerOf(c), specimenPage);
        return record === null ? notFound() : c.json(sampleJson(record, read.origin, readerOf(c).staff, specimenPage));
      }
      for (const [name] of params(c)) {
        return apiError(c, 400, "invalid_request", `Unknown parameter ${JSON.stringify(name)}. This endpoint takes none.`);
      }
      const record = await gatherSpecimen(deps, Number(raw), personOf(c), readerOf(c));
      return record === null ? notFound() : c.json(specimenJson(record, read.origin));
    });
  }
}
