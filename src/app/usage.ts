import * as Sentry from "@sentry/node";
import { DEFAULT_SORT, defaultDirection, MEMBER_ANY, MINE, type ListingQuery } from "./listings.js";
import { DEFAULT_ROSTER_SORT, defaultRosterDirection, LEAD_OFF, type RosterQuery } from "./roster.js";

/**
 * How people use the listings: which filters, sorts and scopes they reach
 * for, counted as Sentry application metrics.
 *
 * The shape of a request and never its content. Every value sent here is one
 * of a fixed set the parsers already enforce — a sort key, a direction, a
 * scope, an atlas code, a QC bucket — and every free-text field (search,
 * place, collector, taxon, host) is reduced to whether it was used. A listing
 * search is how a volunteer finds a person or a place, so its text is exactly
 * what must not leave the machine; no identity is attached either. With no
 * DSN configured, every call is a no-op.
 */

export type Attributes = Record<string, string | number | boolean>;

/** Who is asking, as far as the counts need to know: never who they are. */
export interface Viewer {
  admin: boolean;
  /** Staff viewing as a volunteer, whose clicks are not that volunteer's. */
  impersonating: boolean;
  /** A delegate browsing as the person they act for. */
  actingFor: boolean;
}

const role = (v: Viewer) => (v.impersonating ? "impersonating" : v.admin ? "staff" : "volunteer");

/** 1, 2–5, 6 or more: whether people page at all, without a series per page number. */
const pageBand = (page: number) => (page <= 1 ? "1" : page <= 5 ? "2-5" : "6+");

/** The attributes of one /samples or /specimens request. Exported for its test. */
export function listingAttributes(
  listing: "samples" | "specimens",
  format: "page" | "csv",
  q: ListingQuery,
  viewer: Viewer,
): Attributes {
  const used = {
    search: q.q !== "",
    from: q.from !== null,
    to: q.to !== null,
    place: q.place !== "",
    collector: q.collector !== "",
    member: q.member !== MEMBER_ANY,
    taxon: q.taxon !== "",
    host: q.host !== "",
    det: q.det !== "any",
    qc: q.qc !== "any",
  };
  const filters = Object.entries(used)
    .filter(([, on]) => on)
    .map(([name]) => name);
  return {
    listing,
    format,
    role: role(viewer),
    acting_for: viewer.actingFor,
    // mine, all, outside, or an atlas code — all from the parser's own list.
    scope: q.scope === MINE ? "mine" : q.scope,
    sort: q.sort,
    dir: q.dir,
    sort_changed: q.sort !== DEFAULT_SORT || q.dir !== defaultDirection(DEFAULT_SORT),
    page: pageBand(q.page),
    filter_count: filters.length,
    // One sorted string, so "place+taxon" can be counted as a combination…
    filters: filters.length === 0 ? "none" : filters.join("+"),
    // …and one boolean each, so "anything using taxon" needs no pattern.
    ...Object.fromEntries(Object.entries(used).map(([name, on]) => [`filter.${name}`, on])),
    // Enumerated filter values, which say which QC bucket or membership was wanted.
    qc: q.qc,
    det: q.det,
    member: q.member === MEMBER_ANY ? "any" : q.member,
  };
}

/** The attributes of one /people request. Exported for its test. */
export function rosterAttributes(format: "page" | "csv", q: RosterQuery, viewer: Viewer): Attributes {
  const used = {
    search: q.search !== "",
    suspect: q.suspect,
    active: q.active !== "any",
    member: q.member !== MEMBER_ANY,
    admin: q.admin,
    lead: q.lead !== LEAD_OFF,
  };
  const filters = Object.entries(used)
    .filter(([, on]) => on)
    .map(([name]) => name);
  return {
    listing: "people",
    format,
    role: role(viewer),
    acting_for: viewer.actingFor,
    sort: q.sort,
    dir: q.dir,
    sort_changed: q.sort !== DEFAULT_ROSTER_SORT || q.dir !== defaultRosterDirection(DEFAULT_ROSTER_SORT),
    page: pageBand(q.page),
    filter_count: filters.length,
    filters: filters.length === 0 ? "none" : filters.join("+"),
    ...Object.fromEntries(Object.entries(used).map(([name, on]) => [`filter.${name}`, on])),
    active: q.active,
    member: q.member === MEMBER_ANY ? "any" : q.member,
    lead: q.lead === LEAD_OFF ? "off" : q.lead,
  };
}

/** Count one listing request. Never throws: a metric is no reason to fail a page. */
export function countListingView(attributes: Attributes): void {
  try {
    Sentry.metrics.count("listing.view", 1, { attributes });
  } catch {
    // Reporting is best-effort by construction; the page is what matters.
  }
}
