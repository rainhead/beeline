import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it } from "vitest";
import { initErrorReporting } from "../src/app/error-reporting.js";
import { EMPTY_QUERY, type ListingQuery } from "../src/app/listings.js";
import { EMPTY_ROSTER_QUERY } from "../src/app/roster.js";
import { countListingView, listingAttributes, rosterAttributes } from "../src/app/usage.js";

const volunteer = { admin: false, impersonating: false, actingFor: false };
const staff = { admin: true, impersonating: false, actingFor: false };

// Synthetic free text in the shapes people type: a name, a place, a taxon.
const everyFilter: ListingQuery = {
  ...EMPTY_QUERY,
  scope: "OBA",
  q: "Ada Example",
  from: "2025-04-01",
  to: "2025-09-30",
  place: "Wallowa Mountain Loop",
  collector: "adaexample",
  member: "unrecorded",
  taxon: "Bombus vosnesenskii",
  host: "Ericameria nauseosa",
  det: "undetermined",
  qc: "blocking",
  sort: "host",
  dir: "asc",
  page: 7,
};

describe("listingAttributes", () => {
  it("says a bare listing used nothing", () => {
    expect(listingAttributes("samples", "page", EMPTY_QUERY, volunteer)).toMatchObject({
      listing: "samples",
      format: "page",
      role: "volunteer",
      scope: "mine",
      sort: "date",
      dir: "desc",
      sort_changed: false,
      page: "1",
      filter_count: 0,
      filters: "none",
      "filter.search": false,
      qc: "any",
      member: "any",
    });
  });

  it("names every filter in use and the enumerated values, and none of the text", () => {
    const attrs = listingAttributes("specimens", "csv", everyFilter, staff);
    expect(attrs).toMatchObject({
      role: "staff",
      scope: "OBA",
      sort: "host",
      dir: "asc",
      sort_changed: true,
      page: "6+",
      filter_count: 10,
      filters: "search+from+to+place+collector+member+taxon+host+det+qc",
      "filter.taxon": true,
      qc: "blocking",
      det: "undetermined",
      member: "unrecorded",
    });
    const sent = JSON.stringify(attrs);
    for (const text of ["Ada", "adaexample", "Wallowa", "Bombus", "Ericameria", "2025-04-01"]) {
      expect(sent).not.toContain(text);
    }
  });

  it("keeps staff viewing as a volunteer apart from the volunteer", () => {
    expect(listingAttributes("samples", "page", EMPTY_QUERY, { admin: false, impersonating: true, actingFor: false }).role).toBe(
      "impersonating",
    );
    expect(listingAttributes("samples", "page", EMPTY_QUERY, { ...volunteer, actingFor: true }).acting_for).toBe(true);
  });
});

describe("rosterAttributes", () => {
  it("reduces the search to whether it was used", () => {
    const attrs = rosterAttributes("page", { ...EMPTY_ROSTER_QUERY, search: "Ada Example", active: "inactive", suspect: true });
    expect(attrs).toMatchObject({
      listing: "people",
      filters: "search+suspect+active",
      "filter.search": true,
      active: "inactive",
      sort_changed: false,
    });
    expect(JSON.stringify(attrs)).not.toContain("Ada");
  });
});

describe("countListingView", () => {
  const sent: unknown[] = [];
  afterEach(async () => {
    await Sentry.close(100);
    sent.length = 0;
  });

  it("does nothing without a DSN, and sends the count once one is set", async () => {
    countListingView(listingAttributes("samples", "page", EMPTY_QUERY, volunteer));
    initErrorReporting(
      { sentryDsn: "https://public@example.invalid/1", environment: "sandbox", release: "test" },
      {
        transport: () => ({
          send: async (envelope: unknown) => {
            sent.push(envelope);
            return {};
          },
          flush: async () => true,
        }),
      },
    );
    countListingView(listingAttributes("samples", "page", everyFilter, staff));
    await Sentry.flush(1000);
    const wire = JSON.stringify(sent);
    expect(wire).toContain("listing.view");
    expect(wire).toContain("search+from+to+place");
    expect(wire).not.toContain("Wallowa");
  });
});
