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
  SORT_KEYS,
  SPECIMEN_CSV_HEADER,
  specimenCsvRow,
  type CountGroup,
  type ExactLookup,
  type ListingQuery,
  type Reader,
} from "./listings.js";
import { gatherSample, gatherSpecimen, parsePage, type RecordDeps, type SampleRecord, type SpecimenRecord } from "./record.js";

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
  oneOf("sort", SORT_KEYS);
  oneOf("dir", ["asc", "desc"]);
  for (const name of ["from", "to"]) {
    const v = params.get(name);
    if (v !== null && v !== "" && !isIsoDay(v)) throw new BadRequest(`${name} must be a date as YYYY-MM-DD.`);
  }
  const page = params.get("page");
  if (page !== null && !/^[1-9]\d{0,3}$|^10000$/.test(page)) throw new BadRequest("page must be a whole number from 1 to 10000.");

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
 * The sample record as JSON. Where the location is withheld from this reader
 * the sample's own fields already say so (`location_withheld: true` and nothing
 * below the county or state), and so do the findings and the history, as on the
 * page. Two texts the page shows regardless are left out here: a hold's reason
 * and a waiver's finding and reason, which staff write and which can say where
 * the sample was (the history drops the same entries for the same reason).
 */
export function sampleJson(record: SampleRecord, origin: string) {
  const { sample } = record;
  const withheld = sample.location_withheld;
  return {
    sample: { ...(plain(sample) as object), id: sample.sample_id, url: `${origin}/samples/${sample.sample_id}` },
    findings: plain(record.findings),
    hold: record.hold === null ? null : plain({ ...record.hold, reason: withheld ? null : record.hold.reason, reason_withheld: withheld }),
    waivers: record.waivers.map((w) =>
      plain({ ...w, finding: withheld ? null : w.finding, reason: withheld ? null : w.reason, text_withheld: withheld }),
    ),
    specimens: {
      total: record.specimens.total,
      page: record.specimens.page,
      pages: record.specimens.pages,
      page_size: 50,
      rows: record.specimens.rows.map((r) => ({
        ...(plain(r) as object),
        id: r.specimen_id,
        url: `${origin}/specimens/${r.specimen_id}`,
      })),
    },
    history: record.history.map((h) =>
      plain({ at: h.at, field: h.field, old_value: h.old_value, new_value: h.new_value, author: h.author, source: h.source, reason: h.reason }),
    ),
  };
}

/** The specimen record as JSON, under the same rules as {@link sampleJson}. */
export function specimenJson(record: SpecimenRecord, origin: string) {
  const { specimen } = record;
  const { sample: _sample, ...own } = specimen;
  return {
    specimen: { ...(plain(own) as object), id: specimen.specimen_id, url: `${origin}/specimens/${specimen.specimen_id}` },
    sample: { ...(plain(specimen.sample) as object), id: specimen.sample.sample_id, url: `${origin}/samples/${specimen.sample.sample_id}` },
    determinations: plain(record.events),
    findings: plain(record.findings),
    labels: record.labels.map((l) => {
      const { print_run_id: _run, ...rest } = l;
      return plain(rest);
    }),
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

    // The listing, one page of it: what the page shows, as data.
    api.get(`/${kind}`, async (c) => {
      if (read === undefined) return unavailable(c);
      let parsed: ReturnType<typeof readQuery>;
      let pageSize: number;
      try {
        parsed = readQuery(params(c), LISTING_PARAMETERS, await atlasCodes());
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
        parsed = readQuery(params(c), COUNT_PARAMETERS, await atlasCodes());
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
          for (const [name] of params(c)) {
            if (!(SAMPLE_RECORD_PARAMETERS as readonly string[]).includes(name)) {
              throw new BadRequest(`Unknown parameter ${JSON.stringify(name)}. This endpoint takes: ${SAMPLE_RECORD_PARAMETERS.join(", ")}.`);
            }
          }
          const page = params(c).get("page");
          if (page !== null && !/^[1-9]\d{0,3}$|^10000$/.test(page)) throw new BadRequest("page must be a whole number from 1 to 10000.");
          specimenPage = parsePage(page ?? undefined);
        } catch (err) {
          return refuse(c, err);
        }
        const record = await gatherSample(deps, Number(raw), personOf(c), readerOf(c), specimenPage);
        return record === null ? notFound() : c.json(sampleJson(record, read.origin));
      }
      for (const [name] of params(c)) {
        return apiError(c, 400, "invalid_request", `Unknown parameter ${JSON.stringify(name)}. This endpoint takes none.`);
      }
      const record = await gatherSpecimen(deps, Number(raw), personOf(c), readerOf(c));
      return record === null ? notFound() : c.json(specimenJson(record, read.origin));
    });
  }
}
