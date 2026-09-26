/**
 * The English catalog — and, via `typeof`, the shape every other catalog
 * must satisfy. Plain data and functions, no framework: a message with
 * variables is a function so word order stays the translator's decision.
 * Views never carry literal user-facing prose; they render from here.
 */

import type { TaxonQualifier } from "../views/components/taxon.js";

/**
 * One glossary entry. `example` is a taxon name as data — rank and parts,
 * never markup — so the page can set it correctly through TaxonName
 * (beeline-0i2.6). The entries object satisfies this shape entry by entry,
 * which is what makes a mistyped qualifier a compile error.
 */
export interface GlossaryEntry {
  term: string;
  definition: string;
  example?: {
    rank: string;
    scientificName: string;
    subgenus?: string;
    qualifier?: TaxonQualifier;
    authorship?: string;
  };
}

const locale = "en";
const n = (x: number) => x.toLocaleString(locale);
// Date formatters pass strings through untouched so the proofing page's
// «sample» placeholders survive; real callers always pass Date.
const date = (d: Date | string) =>
  typeof d === "string" ? d : d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
// Like the date formatters: a plain string passes through, so the proofing
// page's «sample» placeholder survives a formatter that expects a list.
const listFormat = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
const list = (xs: readonly string[] | string) => (Array.isArray(xs) ? listFormat.format(xs) : String(xs));
// An instant is said in Pacific time, by name, whatever clock the server
// keeps: the sandbox runs in UTC and printed a 2pm edit as 9pm (Peter,
// 2026-09-18), the same defect the front page's schedule note once had. The
// program is run from Oregon; a per-person zone waits for somebody to need
// one. `date` above stays zone-free on purpose: it formats DATE columns,
// which arrive as UTC midnight and would slip a day in any western zone.
const ZONE = "America/Los_Angeles";
const dateTime = (d: Date | string) =>
  typeof d === "string"
    ? d
    : d.toLocaleString(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: ZONE,
        timeZoneName: "short",
      });
/** The calendar day an INSTANT fell on, in Pacific time — never for a DATE column, which is `date`. */
const day = (d: Date | string) =>
  typeof d === "string"
    ? d
    : d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric", timeZone: ZONE });
// A collecting window: one day for a net sample, a range for a trap left out
// across several. One formatter rather than one per screen, because it is a
// value formatting rule and not something a screen decides.
const dateRange = (start: Date | string, end: Date | string) =>
  date(start) === date(end) ? date(start) : `${date(start)} – ${date(end)}`;
// Where a record was collected, from whichever parts it carries. A formatter
// rather than a helper in each view: which separator joins a locality to its
// county is a language's decision, not a screen's — and it was retyped in
// three views before it had a home.
const place = (parts: ReadonlyArray<string | null> | string) =>
  (Array.isArray(parts) ? parts : [parts]).filter(Boolean).join(", ");

export const en = {
  locale,
  brand: "Beeline",
  /**
   * What a missing value means, for the Absent component: read aloud always,
   * and written out where the absence is the exception (Nora, 2026-09-17).
   * A screen adds its own where it knows more — "not determined", "never".
   */
  absence: {
    none: "none",
    notRecorded: "not recorded",
  },

  /** Locale-aware value formatters, for views composing values into markup. */
  format: { date, day, dateTime, dateRange, number: n, list, place },

  layout: {
    /** Any instance that is not production says so (beeline-2u8). */
    envBanner: (environment: string) => `${environment} instance — data here may be blown away and rebuilt at any time`,
    nav: {
      samples: "Samples",
      specimens: "Specimens",
      glossary: "Glossary",
      people: "People",
      design: "Design",
      jobs: "Jobs",
      taxonomy: "Taxonomy",
      printRuns: "Print runs",
    },
    /**
     * The menu's destinations beyond the records — reference pages and staff
     * tools, grouped by purpose (beeline-45v.5). Read aloud as the name of
     * that group, never shown.
     */
    more: "Reference and tools",
    /** The records nav as it appears inside the menu on a narrow screen. Read aloud, never shown. */
    records: "Records",
    /**
     * The feedback link in the header: an email, pre-filled with what staff
     * need to find what the person was looking at. In the header rather than
     * a menu so nobody has to go looking for it; the body leaves room at the
     * top for the person's own words, which are the point.
     */
    feedback: {
      label: "Send feedback",
      subject: "Beeline feedback",
      body: (context: { url: string; when: string; userAgent: string; login: string; session: string }) =>
        [
          "What happened, or what would you like to tell us?",
          "",
          "",
          "",
          "-- Please leave the lines below: they help us find what you were looking at. --",
          `Page: ${context.url}`,
          `Page loaded: ${context.when}`,
          `Signed in as: ${context.login}`,
          `Session: ${context.session}`,
          `Browser: ${context.userAgent}`,
        ].join("\n"),
    },
    /** The hamburger button left of the brand: reference pages and staff tools, and the nav on narrow screens. */
    menu: "Menu",
    /** The avatar button that opens the account menu. */
    account: (login: string) => `Account: ${login}`,
    /**
     * Acting for somebody else (beeline-oyl). A household shares one iNat
     * login and only one of them holds it, so the other's records are only
     * reachable this way. The banner is deliberately plain and constant: it
     * has to be readable at a glance on every page, because everything the
     * page says about "my" samples means somebody else while it is up.
     */
    acting: {
      banner: (name: string) => `You are acting for ${name}. Samples shown as yours are theirs.`,
      stop: "Stop acting",
      /** The picker in the account menu, for a delegate with grants. */
      start: "Act for someone",
      startFor: (name: string) => `Act for ${name}`,
    },
    /**
     * Viewing Beeline as somebody else (beeline-jjt): staff seeing exactly
     * what one volunteer sees. Same shape as the acting banner, and as
     * constant, because it is the only thing on the page that is not theirs.
     */
    impersonating: {
      banner: (name: string) =>
        `You are viewing Beeline as ${name}. This is what they see, and nothing can be changed from here.`,
      stop: "Stop viewing as them",
    },
    signOut: "Sign out",
    /** BEELINE_DEV_LOGIN sessions ignore cookies, so there is nothing to sign out of. */
    devSession: "Signed in by BEELINE_DEV_LOGIN — stop the dev server to change who you are.",
    pageTitle: (title: string) => `${title} · Beeline`,
  },

  signIn: {
    title: "Sign in",
    heading: "Beeline",
    nothingPublic: "Nothing here is public — sign in with iNaturalist to continue.",
    button: "Sign in with iNaturalist",
    failed: "Sign-in failed (state mismatch or missing code) — try again from the sign-in page.",
  },

  pendingApproval: {
    title: "Almost there",
    heading: "Almost there",
    body: (login: string) =>
      `You signed in as ${login}, but that iNaturalist account isn't connected to a member record yet. ` +
      `Your atlas's staff can connect it — nothing more for you to do here.`,
  },

  qc: {
    title: "Your samples",
    /**
     * The front page is titled with the brand and opens with what the site
     * is, for a volunteer who has just been let in (Peter, 2026-09-16). It
     * is not "Samples needing attention": the table below says that.
     */
    heading: "Beeline",
    lede:
      "Beeline follows the bees you collect for your atlas. Each iNaturalist observation you make becomes a sample here, " +
      "its specimens get labels, and what the experts determine them to be comes back to it. " +
      "This page is your samples from this season that need something from you, or are waiting on labels.",
    /** Positional so the proofing page can call it with placeholders (messages-proof.tsx). */
    summary: (flagged: number, blocking: number, waiting: number, placeholders: number) => {
      const parts: string[] = [];
      if (flagged > 0) {
        parts.push(
          `${n(flagged)} ${flagged === 1 ? "sample needs" : "samples need"} attention` +
            (blocking > 0 ? ` (${n(blocking)} cannot print until fixed)` : ""),
        );
      }
      // The first clause names its subject; a later one borrows it. With
      // nothing flagged this is the first, and "3 are waiting" has none.
      if (waiting > 0) {
        parts.push(
          parts.length === 0
            ? `${n(waiting)} ${waiting === 1 ? "sample is" : "samples are"} waiting on labels`
            : `${n(waiting)} ${waiting === 1 ? "is" : "are"} waiting on labels`,
        );
      }
      if (placeholders > 0) {
        parts.push(
          `${n(placeholders)} ${placeholders === 1 ? "observation still says" : "observations still say"} 0 specimens`,
        );
      }
      return parts.join(" · ");
    },
    col: {
      sample: "Sample",
      place: "Place",
      coordinates: "Coordinates",
      host: "Host plant",
      specimens: "Specimens",
    },
    allClear: "Nothing needs your attention this season, and nothing is waiting on labels. Thank you!",
    /**
     * The schedule, in words a volunteer has: never "sync", and never the
     * timestamp of the last run — which the sandbox printed in UTC as 9am
     * and which is /jobs's business anyway (Peter, 2026-09-16).
     */
    refreshNote:
      "Beeline reads your observations from iNaturalist every morning at 2am Pacific. " +
      "A fix you make on iNaturalist shows up here the next day.",
    neverSynced: "This instance has not read anything from iNaturalist yet.",
    sampleTitle: (sampleNumber: string, when: Date | string) => `Sample ${sampleNumber} · ${date(when)}`,
    specimens: (count: number) => `${n(count)} ${count === 1 ? "specimen" : "specimens"}`,
    labelsWaiting: (count: number) => `${n(count)} ${count === 1 ? "label" : "labels"} to print`,
    /** In a print run that is not on paper yet. Still on the page: waiting ends when the envelope goes. */
    labelsPrinting: (count: number) => `${n(count)} ${count === 1 ? "label is" : "labels are"} being printed`,
    labelsPrinted: (count: number, when: string) =>
      `${n(count)} ${count === 1 ? "label" : "labels"} printed ${when}, not mailed yet`,
    /** Already formatted to four places by the view: a coordinate's precision is a fact about the reading, not the locale. */
    coordinates: (latitude: string, longitude: string) => `${latitude}, ${longitude}`,
    accuracy: (metres: number) => `within ${n(metres)} m`,
    /** No believed-true pair, and the observation says why: geoprivacy. */
    coordinatesObscured: "obscured",
    coordinatesNone: "none",
    hostNone: "none",
    fixOnInat: "Fix on iNaturalist",
    editSample: "Edit this sample",
    blocksPrinting: "blocks printing",
    headsUp: "heads-up",
    /**
     * What the record actually says, where that is a name rather than a
     * measurement (beeline-dys). A finding's detail follows the rule's
     * instruction, and most details are machine values that read as an
     * annotation on their own; a bare scientific name after a full stop
     * reads as a dropped fragment, so it gets three words of its own.
     */
    identifiedAs: "It is currently identified as",
    /**
     * An observation numbered as a sample and left at 0 specimens: the
     * placeholder a volunteer makes in the field and fills in once the catch
     * is counted — or forgets to (Peter, 2026-09-16). Not a sample yet, so
     * not a finding; it is on this page so it is not forgotten.
     */
    placeholder: {
      chip: "still 0",
      note:
        "This observation still says 0 specimens, so it is not a sample yet and has nothing to print. " +
        "Once you have checked the place, the pin and the count, enter how many you collected.",
    },
    /**
     * Whose sample you are looking at when it isn't only yours: the sample
     * number belongs to the first collector's series, so a shared sample has
     * to say who else was there (beeline-77j).
     */
    collectedWith: (people: string) => `collected with ${people}`,

    /**
     * Closed seasons stop asking (beeline-2c3.24). Said out loud rather than
     * silently dropped: a flag that vanishes without explanation reads as a
     * bug, and these are still fixable.
     */
    settled: {
      note: (samples: number) =>
        `${n(samples)} older ${samples === 1 ? "sample" : "samples"} of yours still ${samples === 1 ? "carries a flag" : "carry flags"}. ` +
        `Seasons settle on 1 March, so earlier ones no longer wait for you here — fixing them is welcome, not expected.`,
      link: "Show them",
    },
  },

  /**
   * Browsing the collection (/samples, /specimens). Volunteer-facing, so
   * every string is here — including the scope control, which only staff
   * ever see but which sits on a volunteer's page.
   */
  listings: {
    samples: {
      title: "Samples",
      heading: "Samples",
      ledeMine: "Every sample you collected.",
      ledeAtlas: (atlas: string) => `Every sample in the ${atlas}.`,
      ledeAll: "Every sample in every atlas.",
      ledeOutside: "Every sample collected where no member atlas reaches.",
      count: (total: number) => `${n(total)} ${total === 1 ? "sample" : "samples"}`,
      emptyHeading: "Nothing here yet",
      emptyMine: "None of your collecting has reached Beeline yet. Samples arrive from iNaturalist as they sync.",
      emptyFiltered: "No samples match these filters. Widen the dates, clear the taxon, or search for less.",
      colSample: "Sample",
      colDate: "Date",
      colCollectors: "Collectors",
      colPlace: "Place",
      colHost: "Host plant",
      colSpecimens: "Specimens",
      colStatus: "Flags",
      colAtlas: "Atlas",
      /** A sample collected where no member atlas reaches: ordinary, and said so rather than left blank. */
      atlasOutside: "outside",
      /** Read aloud, never shown: the column of links out. */
      colLinks: "Links",
      viewOnInat: "View on iNaturalist",
      edit: "Edit",
    },

    specimens: {
      title: "Specimens",
      heading: "Specimens",
      ledeMine: "Every specimen from your samples.",
      ledeAtlas: (atlas: string) => `Every specimen in the ${atlas}.`,
      ledeAll: "Every specimen in every atlas.",
      ledeOutside: "Every specimen collected where no member atlas reaches.",
      count: (total: number) => `${n(total)} ${total === 1 ? "specimen" : "specimens"}`,
      emptyHeading: "Nothing here yet",
      emptyMine:
        "None of your samples have specimens yet. A specimen becomes its own record when its label is printed.",
      emptyFiltered: "No specimens match these filters. Widen the dates, clear the taxon, or search for less.",
      colFieldNumber: "Field number",
      colSample: "Sample",
      colDate: "Date",
      colCollectors: "Collectors",
      colPlace: "Place",
      colHost: "Host plant",
      colDetermination: "Determination",
      colDeterminer: "Determined by",
      /** When the determination of record was made — the date on the determination, not when it reached Beeline. */
      colDetermined: "Determined",
      colAtlas: "Atlas",
      /** An imported specimen whose label predates field numbering. */
      noFieldNumber: "not numbered",
      /** A number taken back by a canceled run; the next run issues another (beeline-1kb.21). */
      awaitingNumber: "awaiting a number",
      undetermined: "not determined",
      expert: "expert",
    },

    /**
     * Whose records a listing shows: a three-way toggle for staff — mine, my
     * atlas, everything (Peter, 2026-09-16) — and nothing for a volunteer,
     * whose listing is their own.
     */
    scope: {
      label: "Show",
      mine: "My records",
      atlasRecords: (atlas: string) => `${atlas} records`,
      all: "All records",
      /** Says plainly that this is more than the viewer's own collecting. */
      staffNote: (what: string) => `Staff view: ${what}. Volunteers only ever see their own records here.`,
      /**
       * Collecting outside the six is ordinary, not an error, and the label
       * has to sound like it (beeline-lcl).
       */
      outside: "Outside the atlases",
      staffNoteAll: "every atlas",
      staffNoteOutside: "everywhere no member atlas reaches",
      staffNoteAtlas: (atlas: string) => `the ${atlas}`,
    },

    filters: {
      search: "Search",
      searchHint: "Sample number, collector, or field number",
      from: "Collected from",
      to: "Collected to",
      place: "Place",
      placeHint: "Locality, county, state, or country",
      collector: "Collector",
      collectorHint: "Name or iNaturalist login — anyone on the sample",
      /**
       * The other axis from scope: where the collector belongs, not where the
       * sample fell. Most records from outside the atlases are members
       * travelling, so one control could not answer both (beeline-lcl).
       */
      member: "Collector belongs to",
      memberHint: "Where the person belongs — not where they collected",
      memberAny: "Anywhere",
      memberProgram: "Master Melittology (no atlas)",
      memberUnrecorded: "Not recorded",
      taxon: "Taxon",
      taxonHint: "A family, genus, or species — anything below it matches too",
      host: "Host plant",
      hostHint: "The plant the bee was collected from, as the observation names it",
      det: "Determination",
      detAny: "Any",
      detDetermined: "Determined",
      detUndetermined: "Not determined",
      qc: "Flags",
      qcAny: "Any",
      qcFlagged: "Any flag",
      qcBlocking: "Blocks printing",
      qcWarning: "Heads-up only",
      qcClean: "Clean",
      apply: "Apply",
      clear: "Clear all",
      /** Read aloud over the row of pills: the filters in force. */
      inForce: "Filters in force",
      remove: (filter: string) => `Remove the ${filter} filter`,
    },

    /** The two orders a column offers, named by what its values are. */
    sort: {
      textAsc: "A to Z",
      textDesc: "Z to A",
      dateAsc: "Oldest first",
      dateDesc: "Newest first",
      numberAsc: "Lowest first",
      numberDesc: "Highest first",
    },
    /**
     * The accessible name of a column heading's menu. It says what the menu
     * holds and no more: a column that only sorts must not tell a
     * screen-reader user there is a filter to find (CodeRabbit on #67).
     */
    columnMenu: {
      both: (column: string) => `${column}: sort and filter`,
      sort: (column: string) => `${column}: sort`,
      filter: (column: string) => `${column}: filter`,
    },


    /** Chips on a row, and the same three words the QC filter offers. */
    status: {
      blocking: (count: number) => `${n(count)} ${count === 1 ? "flag blocks" : "flags block"} printing`,
      warning: (count: number) => `${n(count)} ${count === 1 ? "heads-up" : "heads-ups"}`,
      clean: "clean",
    },

    paging: {
      page: (page: number, pages: number) => `Page ${n(page)} of ${n(pages)}`,
      previous: "← Previous",
      next: "Next →",
    },

    csv: {
      download: "Download CSV",
      note:
        "The CSV holds exactly what these filters select, coordinates and all. " +
        "Where iNaturalist obscures a record, its own columns say so — worth a look before anything is republished.",
      truncated: (limit: number) => `Only the first ${n(limit)} rows are exported — narrow the filters for the rest.`,
    },
  },

  sampleEdit: {
    title: "Edit sample",
    heading: (sampleNumber: string) => `Edit sample ${sampleNumber}`,
    intro:
      "This sample has no iNaturalist observation to fix, so corrections happen here. " +
      "Saved changes take effect immediately and are kept as attributed corrections that survive database rebuilds.",
    fields: {
      locality: "Locality",
      country: "Country",
      state_province: "State / province",
      county: "County",
      protocol: "Sampling protocol",
    } as Record<string, string>,
    noteLabel: "Note (optional)",
    noteHint: "Why the change, if it isn't obvious",
    save: "Save changes",
    cancel: "Cancel",
    notEditable: "This sample can't be edited here — it may not be yours, or its fixes belong on iNaturalist.",
    noStagingRows: "This sample has no underlying records to correct — ask staff to look into it.",
  },

  /**
   * One record: /samples/:id and /specimens/:id (beeline-2c3.34).
   *
   * The listings show a determination in one cell — the conclusion without
   * the argument. These pages carry the argument, so the copy has to name
   * things a volunteer has never needed a word for: which channel an
   * identification arrived through, and why a 2019 expert determination
   * stands over a 2026 volunteer one. Where a word has a glossary entry the
   * page links it rather than re-explaining it (/design/voice).
   */
  record: {
    /**
     * The sample's own change history (beeline-ewl): what the change log
     * recorded, newest first, in the words of this page. The log's fields
     * are the sample's state, so most values render as themselves.
     */
    history: {
      heading: "History",
      hint: "Every change recorded for this sample, newest first — an edit made here, an iNaturalist sync moving something, or a rebuild.",
      empty: "No changes recorded — this sample has not changed since Beeline began keeping history. Changes from here on appear in this list.",
      colWhen: "When",
      colWhat: "What",
      colChange: "Change",
      colWho: "Who",
      set: "set to",
      cleared: "cleared — was",
      blank: "nothing",
      field: {
        kind: "Kind",
        date_end: "End date",
        specimen_count: "Specimen count",
        observation: "iNaturalist observation",
        location: "Coordinates",
        location_source: "Coordinate source",
        geoprivacy: "Geoprivacy",
        taxon_geoprivacy: "Taxon geoprivacy",
        country: "Country",
        state_province: "State/Province",
        county: "County",
        locality: "Locality",
        protocol: "Protocol",
        sampling_effort: "Sampling effort",
        host: "Floral host",
        atlas: "Atlas",
        atlas_assigned_by: "Atlas assigned by",
        co_collectors: "Co-collectors",
        collector: "Collector",
        sample_number: "Sample number",
        date_start: "Start date",
      },
      source: {
        app: "staff",
        legacy_promotion: "a rebuild",
        observation_promotion: "an iNaturalist sync",
        reconcile: "found at startup",
      },
    },
    /** Unreachable and non-existent are one answer, so this covers both. */
    notFound: "No such record, or not one you can see.",
    staffNote: "Staff view: this is not one of your own records.",

    sample: {
      title: (sampleNumber: string) => `Sample ${sampleNumber}`,
      back: "← All samples",
      collectors: "Collected by",
      collected: "Collected",
      method: "Method",
      methodNet: "Net",
      methodTrap: "Trap",
      protocol: "Sampling protocol",
      effort: "Sampling effort",
      place: "Place",
      /**
       * The observation's own place text, beside what the model made of it —
       * the same stance verbatim_identification takes for a determination
       * (schema/040). The observation is not listed anywhere on the site, so
       * this is the only place a volunteer sees the string their record came
       * from.
       *
       * "Recorded in iNaturalist as" rather than "iNaturalist records this
       * as" (Peter, 2026-08-29), and the neutrality is the point: iNaturalist
       * AUTO-ASSIGNS place_guess by reverse geocoding, most observers never
       * touch it, and our volunteers are instructed to set it themselves. So
       * the string is sometimes theirs and sometimes the geocoder's, and the
       * copy should not claim to know which.
       *
       * Which is also what a refused locality means. "Snohomish County,
       * US-WA, US" is an untouched auto-assignment and "Verlot, WA, US" is a
       * volunteer who followed the instruction — so missing_required_field on
       * a minted sample is not bad data, it is the nudge to go and do the
       * step that was asked for, and this row is the evidence for it.
       */
      asRecorded: (text: string) => `Recorded in iNaturalist as “${text}”.`,
      atlas: "Atlas",
      /** Collecting outside the member atlases is ordinary (beeline-lcl). */
      atlasOutside: "None — collected where no member atlas reaches",
      host: "Floral host",
      observation: "iNaturalist observation",
      /** Trap samples usually have none, and that is not a gap. */
      observationNone: "None — this sample did not come from an observation, so it is corrected here rather than upstream.",
      /**
       * The observer's own free text on the observation (beeline-hza). "Notes"
       * rather than "Description", which is iNaturalist's word for the field
       * and not what anyone calls it. The row is absent where there are none,
       * which is the usual case and not a gap: most observations carry no
       * notes, and a volunteer who wrote nothing has said nothing.
       */
      notes: "Notes",
      viewOnInat: "View on iNaturalist",
      edit: "Edit this sample",
      /** Every value the record simply does not carry. */
      unknown: "not recorded",
      /**
       * Staff set a locality the observation cannot yield (beeline-649). The
       * provenance lines sit under the place, in the same voice as
       * asRecorded: what stands, who said so, and what iNaturalist says now
       * where that has moved on. The form is the page's only write for
       * staff, and says plainly that the value stands over the observation
       * until it is removed — the one thing a staffer needs to know before
       * pressing it.
       */
      staffLocality: {
        setBy: (name: string) => `Locality set here by ${name}.`,
        setByStaff: "Locality set here by staff.",
        because: (reason: string) => `Reason: ${reason}`,
        observationNow: (text: string) =>
          `iNaturalist now yields “${text}” for this observation; the locality set here stands until it is removed.`,
        heading: "Set the locality",
        hint: "For staff. A locality set here stands over the observation's on every sync, and survives rebuilds, until it is removed.",
        hintNoObservation:
          "For staff. This sample has no observation, so the locality is kept as a correction — the same way the collector's own edits are.",
        printed:
          "Labels for this sample have already been printed and carry the locality as it was; changing it here does not change them.",
        field: "Locality",
        note: "Why (optional)",
        save: "Set locality",
        remove: "Remove, and follow iNaturalist again",
      },
      /**
       * Staff set the coordinates (beeline-942), on the same terms as the
       * locality. The case that matters most is an obscured observation
       * with no trusted access: it yields no coordinates, cannot print, and
       * only a person who knows where the bees were caught can say.
       */
      staffCoordinates: {
        setBy: (name: string) => `Coordinates set here by ${name}.`,
        setByStaff: "Coordinates set here by staff.",
        because: (reason: string) => `Reason: ${reason}`,
        observationNow: (lat: number, lon: number) =>
          `iNaturalist now puts this observation at ${lat}, ${lon}; the coordinates set here stand until they are removed.`,
        heading: "Set the coordinates",
        hint: "For staff. Coordinates set here are believed true, stand over the observation's on every sync, and survive rebuilds, until they are removed. The elevation is read again on the next run.",
        printed:
          "Labels for this sample have already been printed and carry the coordinates as they were; changing them here does not change them.",
        noObservation: "Coordinates can only be set here on a sample with an iNaturalist observation.",
        latitude: "Latitude",
        longitude: "Longitude",
        uncertainty: "Accuracy, in meters (optional)",
        note: "Why (optional)",
        save: "Set coordinates",
        remove: "Remove, and follow iNaturalist again",
      },

      where: {
        heading: "Where it was collected",
        coordinates: "Coordinates",
        /**
         * Absence is a statement here, not a blank: shifted coordinates are
         * deliberately never brought across, so "none" means none believed.
         */
        coordinatesNone:
          "Beeline holds no coordinates for this sample. Where iNaturalist has shifted an observation's coordinates, the shifted pair is deliberately never brought across — so nothing here means nothing we believe.",
        accuracy: "Accuracy",
        accuracyValue: (metres: number) => `within ${n(metres)} m`,
        source: "Source",
        sources: {
          inat_trusted:
            "Read from your iNaturalist observation with trusted access, so these are the true coordinates even where the public map shows them shifted.",
          inat_public: "Read from your iNaturalist observation, which publishes them as they are.",
          legacy_import:
            "Imported from the old atlas database, which recorded nothing about where its coordinates came from. These are the ones already printed on labels.",
          staff_entry: "Entered by staff.",
        } as Record<string, string>,
        /**
         * What the public sees, and shown ONLY where that differs from the
         * true coordinates above — an obscured observation still has true
         * coordinates here, and saying so is the point of the row.
         *
         * It used to render for every sample, with an "open" line saying
         * nothing was obscured. That was redundant beside `source`, which
         * already says iNaturalist publishes them as they are, and it was
         * nonsense on the 6,365 samples that carry coordinates and no
         * observation: they were told that nothing about "this observation"
         * was obscured, about an observation that does not exist.
         */
        privacy: "Public coordinates",
        privacyObscured:
          "You set this observation's coordinates to obscured, so the map shows a shifted pair. What is above is the true location.",
        privacyPrivate:
          "You set this observation's coordinates to private, so the map shows none. What is above is the true location.",
        privacyTaxonObscured:
          "iNaturalist obscures this observation's public coordinates because of the species identified on it — not because of anything you set. What is above is the true location.",
        privacyTaxonPrivate:
          "iNaturalist withholds this observation's public coordinates because of the species identified on it — not because of anything you set. What is above is the true location.",
        elevation: "Elevation",
        elevationValue: (metres: number) => `${n(metres)} m`,
        /** Derived from the coordinates, so never anyone's gap to fill. */
        elevationNone: "Not worked out yet. Elevation is read from the coordinates rather than entered, so there is nothing to do about it.",
        elevationFrom: (source: string) => `Read from ${source}.`,
        elevationStale:
          "Read at a point that is no longer where the coordinates above say — it will be read again on the next elevation run.",
      },

      flags: {
        heading: "Flags",
        clean: "Nothing is flagged on this sample.",
        onSpecimen: (fieldNumber: string) => `on specimen ${fieldNumber}`,
        onOneSpecimen: "on one of its specimens",
      },

      specimens: {
        heading: "Specimens",
        count: (total: number) => `${n(total)} ${total === 1 ? "specimen" : "specimens"}`,
        none: "No specimens yet. A specimen becomes its own record when its label is printed.",
        /** The working count and the printed rows can honestly disagree. */
        counted: (expected: number, printed: number) =>
          `The sample is counted at ${n(expected)}; ${n(printed)} ${printed === 1 ? "has" : "have"} been individuated by printing.`,
        colFieldNumber: "Field number",
        colNumber: "#",
        colDetermination: "Determination",
        colDeterminer: "Determined by",
        /** An imported specimen whose label predates field numbering. */
        noFieldNumber: "not numbered",
        /** A number taken back by a canceled run — the Label column says so — until the next run issues another. */
        awaitingNumber: "awaiting a number",
        undetermined: "not determined",
        expert: "expert",
        colLabel: "Label",
        /**
         * Where each specimen's label is: what a volunteer waiting on an
         * envelope wants to know (beeline-1kb.2). "Printing" covers a run
         * that is prepared or approved but not on paper yet.
         */
        label: {
          printing: (prepared: string) => `Printing — prepared ${prepared}`,
          printed: (when: string) => `Printed ${when}`,
          mailed: (when: string) => `Mailed ${when}`,
          canceled: "run canceled; it will be numbered again in the next run",
          /** Every imported specimen: the old system printed it, and Beeline holds no run for it. */
          legacy: "printed before Beeline",
        },
      },
    },

    specimen: {
      title: (fieldNumber: string) => `Specimen ${fieldNumber}`,
      /** Pre-field-number labels: the only handle is its place in the sample. */
      titleUnnumbered: (specimenNumber: number, sampleNumber: string) =>
        `Specimen ${n(specimenNumber)} of sample ${sampleNumber}`,
      back: (sampleNumber: string) => `← Sample ${sampleNumber}`,
      fieldNumber: "Field number",
      /** An imported specimen: no label row at all. */
      fieldNumberNone: "Not numbered — this specimen's label predates field numbering.",
      /**
       * A specimen a canceled run had numbered (beeline-1kb.21): the number
       * is burned and stays visible in the Labels table below, and the next
       * run numbers the specimen afresh. Said in the same words as the sample
       * page's Label column, so the two cannot read as contradicting.
       */
      fieldNumberWithdrawn: (number: string, run: string) =>
        `Not numbered — ${number} was taken back when ${run} was canceled; the next run will number this specimen again.`,
      inSample: "Number in its sample",
      fromSample: "From sample",
      /** Every time a label for this specimen went into a print run (schema/035). */
      labels: {
        heading: "Labels",
        intro:
          "Each time a label for this specimen was prepared for printing, and how far that run got. Two rows means it was printed twice; the later one is the label to trust.",
        /** An imported specimen: printed, but by the old system, so there is no run to show. */
        legacy: "Printed before Beeline — the previous system printed this label, so there is no print run to show.",
        colRun: "Print run",
        /** As printed, or as it would have: a canceled run's number lives on only here. */
        colNumber: "Number",
        colState: "State",
        colSheet: "Sheet · cell",
        colPrepared: "Prepared",
        colPrinted: "Printed",
        colMailed: "Mailed",
        notYet: "not yet",
      },
    },

    determinations: {
      heading: "Determinations",
      intro:
        "Every identification anyone has recorded for this specimen, newest first. Nothing here is ever overwritten: a correction is a new entry and the earlier one stays.",
      /**
       * Stated whenever there is a history to read, because the rule is not
       * guessable from the rows: determination_of_record is not simply the
       * newest (schema/110).
       */
      recordRule:
        "The one marked of record is the one the rest of this site uses: the most recent expert determination, or the most recent of any kind if no expert has looked.",
      recordNotNewest:
        "It is not the newest entry here — an expert's determination stands until another expert revises it, so a later identification does not displace it.",
      empty: "Nobody has identified this specimen yet.",
      colDetermination: "Determination",
      colDeterminer: "Determined by",
      colDetermined: "Determined",
      colRecorded: "Reached Beeline",
      /** The status column carries the chip and needs no heading. */
      colStatus: "",
      ofRecord: "of record",
      expert: "expert",
      determinerUnknown: "not recorded",
      determinedUnknown: "date not recorded",
      /** The name as the source wrote it, kept beside the node it resolved to. */
      verbatim: (text: string) => `written as “${text}”`,
      sex: (value: string) => `sex ${value}`,
      caste: (value: string) => `caste ${value}`,
      /** How the determination reached Beeline, in a volunteer's words. */
      channels: {
        in_app: "entered here",
        ecdysis_import: "imported from Ecdysis",
        legacy_import: "imported from the old atlas database",
      } as Record<string, string>,
    },
  },

  errors: {
    crossOrigin: "cross-origin request refused",
    /** Asking to act for somebody nobody granted you (beeline-oyl). */
    forbidden: "you have not been granted that",
    /** A save attempted while viewing as somebody else (beeline-jjt). */
    readOnlyImpersonating: "nothing can be changed while viewing Beeline as somebody else",
    /** The trace could not be written, so the switch was not turned on (beeline-jjt). */
    impersonationNotRecorded: "could not record that you are viewing as somebody else, so it was not started",
  },

  /**
   * The taxonomy (/taxonomy, beeline-45v.5): the names specimens are
   * determined to, and how each stands against ITIS. Read by everyone, like
   * the glossary, so written for a volunteer who has never heard of ITIS.
   * Curation will land on these same pages.
   */
  taxonomy: {
    title: "Taxonomy",
    intro:
      "The names specimens are determined to, filed the way the program files them, and how each one stands against ITIS, the published list of names determinations here are made against.",
    aboutItis: "More about ITIS.",
    release: (asOf: Date | string) => `Checked against the ITIS release of ${date(asOf)}.`,
    notLoaded: "ITIS has not been loaded here, so nothing on these pages says how a name stands against it.",
    /** The counts above the filter, each linking to the list it counts. */
    summary: {
      valid: (count: number) => `${n(count)} current in ITIS`,
      synonym: (count: number) => `${n(count)} outdated`,
      homonym: (count: number) => `${n(count)} ambiguous`,
      absent: (count: number) => `${n(count)} not in ITIS`,
    },
    search: "Name",
    searchHint: "Any part of a scientific name.",
    standingLabel: "In ITIS",
    standingOptions: {
      any: "Any",
      valid: "Current",
      synonym: "Outdated",
      homonym: "Ambiguous",
      absent: "Not in ITIS",
    },
    apply: "Apply",
    clear: "Clear",
    found: (total: number) => `${n(total)} ${total === 1 ? "name" : "names"}`,
    nothingFound: "No name matches. Try fewer letters, or a different standing.",
    pageOf: (page: number, pages: number) => `Page ${n(page)} of ${n(pages)}`,
    previous: "← Previous",
    next: "Next →",
    browse: "Browse",
    empty: "The taxonomy is empty: nothing has been determined here yet.",
    /** The breadcrumb trail, as a screen reader names it. */
    filedUnder: "Filed under",
    colName: "Name",
    colRank: "Rank",
    colFiledUnder: "Filed under",
    colItis: "ITIS",
    colSpecimens: "Specimens",
    /** A row speaks about ITIS only when the name is not simply current there. */
    chip: {
      synonym: "Outdated",
      homonym: "Ambiguous",
      absent: "Not in ITIS",
    },
    nowCalled: "ITIS now:",
    specimens: (count: number) => `${n(count)} ${count === 1 ? "specimen" : "specimens"}`,
    /** Under a name's count, when nothing below it was counted. */
    counted: "Counted by determination of record.",
    /** Under a name's count, which includes everything filed below it. */
    determinedHere: (count: number, rank: string) =>
      `Counted by determination of record, including everything filed below. ${n(count)} ${count === 1 ? "is" : "are"} determined to this ${rank} and no finer.`,
    seeSpecimens: "See these specimens",
    seeYourSpecimens: "See your specimens",
    below: "Filed below",
    nothingBelow: "Nothing is filed below this name.",
    /** One name's standing, said in full on its own page. */
    standing: {
      valid: "A current name in ITIS.",
      synonym: "ITIS lists this name as outdated. The name it uses now:",
      homonym:
        "ITIS has more than one current name spelled this way, from different authors, and nothing recorded here says which one this is:",
      absent: (rank: string) =>
        `ITIS has no ${rank} spelled this way. A name newer than ITIS, a subgenus ITIS does not carry, and a misspelling all look like this.`,
      report: (tsn: string) => `ITIS record ${tsn}`,
    },
    notFound: "There is no such name in the taxonomy.",
  },

  jobs: {
    title: "Jobs",
    heading: "Scheduled jobs",
    intro: "Everything the app runs on a schedule, and how the recent runs went. Night-window jobs may run long; interactive jobs answer to the one-second budget.",
    registered: "Registered",
    recentRuns: "Recent runs",
    /** What each job does, keyed by Job.name (a test pins the key sets together). */
    descriptions: {
      "session-purge": "Deletes sign-in sessions idle for more than 30 days; their cookies stop working.",
      "nightly-pipeline":
        "Pulls every observation changed since the last run (edits and new records, however old the observation), promotes into samples, and fills missing elevations from the DEM tiles on disk.",
      "weekly-sweep":
        "Re-fetches the full trailing year from each project as a presence proof — the run that detects deletions and anything the incremental pulls missed — then promotes and derives elevations.",
    } as Record<string, string>,
    everyMinutes: (minutes: number) => `every ${n(minutes)} min`,
    dailyLA: (hour: number) => `daily at ${n(hour)}:00 Pacific (night window)`,
    weeklyLA: (weekday: string, hour: number) => `${weekday}s at ${n(hour)}:00 Pacific (night window)`,
    weekdays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    windowInteractive: "interactive",
    windowNight: "night",
    runNow: "Run now",
    colJob: "Job",
    colSchedule: "Schedule",
    colWindow: "Window",
    colStarted: "Started",
    colDuration: "Duration",
    colOutcome: "Outcome",
    colBreaches: "SLA breaches",
    colDetail: "Detail",
    outcomeSucceeded: "succeeded",
    outcomeFailed: "failed",
    outcomeRunning: "running…",
    durationSeconds: (s: number) => `${n(s)}s`,
    /** A run with no end yet: said, since a blank duration reads as one that failed to record. */
    stillRunning: "still running",
    noRuns: "No runs yet.",
  },

  /** Print runs (/print-runs, beeline-1kb.2). Staff-facing, English-only. */
  printRuns: {
    title: "Print runs",
    heading: "Print runs",
    intro:
      "A run freezes the samples that are ready to print, gives every specimen its field number, and produces the sheets. Nothing added or changed after the freeze joins it; that waits for the next run.",
    /** The state words, shared with the record pages. */
    state: {
      prepared: "Prepared",
      approved: "Approved",
      printed: "Printed",
      mailed: "Mailed",
      canceled: "Canceled",
    } as Record<string, string>,
    prepare: {
      heading: "Prepare a run",
      scopeLabel: "Whose labels",
      /** The unscoped run: every atlas that does not print its own, plus samples outside any atlas. */
      program: "Everyone Oregon prints for",
      programCovers: (codes: readonly string[]) =>
        codes.length === 0
          ? "Covers samples outside every atlas; each atlas prints its own."
          : `Covers ${list(codes)}, and samples outside every atlas.`,
      waiting: (labels: number, samples: number) =>
        `${n(labels)} ${labels === 1 ? "label" : "labels"} for ${n(samples)} ${samples === 1 ? "sample" : "samples"} waiting`,
      nothingWaiting: "nothing waiting",
      button: "Prepare",
      hint:
        "Preparing freezes the set and assigns field numbers, in the order the labels will appear on the sheets. If that was wrong, cancel the run before it prints: the numbers stay used and the samples go back to waiting.",
      /** The POST found nothing pending, so no run was made. */
      nothingToPrepare: "Nothing was waiting to print in that scope, so no run was prepared.",
    },
    colRun: "Run",
    colScope: "Scope",
    colState: "State",
    colPrepared: "Prepared",
    colLabels: "Labels",
    colSamples: "Samples",
    colCollectors: "Collectors",
    colSheets: "Sheets",
    colPrinted: "Printed",
    colMailed: "Mailed",
    none: "No print runs yet.",
    /**
     * The store declining a write, in words (src/print-run.ts,
     * PrintRunRefused). Each names the record to go and look at.
     */
    refused: (
      refusal:
        | { code: "no_location"; sampleId: number }
        | { code: "no_primary_collector"; sampleId: number }
        | { code: "determined"; printRunId: number; specimens: number }
        | { code: "atlas_not_printing"; atlasId: number },
    ) =>
      refusal.code === "atlas_not_printing"
        ? "No run was prepared: that atlas does not print its own labels, so its samples go in the run for everyone Oregon prints for."
        : refusal.code === "determined"
        ? `This run cannot be canceled: ${n(refusal.specimens)} of its specimens ${refusal.specimens === 1 ? "has" : "have"} already been identified, and canceling would take their field numbers away. Nothing was changed.`
        : refusal.code === "no_location"
          ? `No run was prepared: sample ${refusal.sampleId} is waiting to print but has no coordinates on record, which should not be possible. Look at /samples/${refusal.sampleId} before trying again.`
          : `No run was prepared: sample ${refusal.sampleId} is waiting to print but does not have exactly one primary collector. Look at /samples/${refusal.sampleId} before trying again.`,
    scopeProgram: "program",
    notYet: "not yet",
    run: {
      title: (id: number) => `Print run ${n(id)}`,
      back: "← Print runs",
      preparedBy: (name: string, when: string) => `Prepared by ${name}, ${when}.`,
      scopeProgram: "Everyone Oregon prints for.",
      scopeAtlas: (name: string) => `${name} only.`,
      counts: (labels: number, samples: number, collectors: number, sheets: number) =>
        `${n(labels)} ${labels === 1 ? "label" : "labels"} for ${n(samples)} ${samples === 1 ? "sample" : "samples"} from ${n(collectors)} ${collectors === 1 ? "collector" : "collectors"}, on ${n(sheets)} ${sheets === 1 ? "sheet" : "sheets"}.`,
      download: "Download the sheets (PDF)",
      approve: "Approve",
      approveHint: "The labels have been proofed and are good to print.",
      markPrinted: "Mark printed",
      markPrintedHint:
        "The sheets are on paper. From here the samples in this run keep their date, place and coordinates even if the observation changes on iNaturalist.",
      markMailed: "Mark mailed",
      markMailedHint: "The envelopes have gone out.",
      cancel: "Cancel run",
      cancelHint:
        "Only before printing. Its field numbers stay used and are never reissued; its samples go back to waiting and are numbered again in the next run.",
      note: "Note",
      noteHint: "Kept with the run: what was odd about it, or why it was canceled.",
      done: "This run is finished.",
      canceledAt: (when: string, note: string | null) =>
        note === null ? `Canceled ${when}.` : `Canceled ${when}: ${note}`,
      warnings: (count: number) => `${n(count)} ${count === 1 ? "label" : "labels"} to look at`,
      warningsIntro:
        "These lines were longer than the label was drawn for and have been shrunk to fit, or a county was missing. The run prints regardless.",
      warningsNone: "Every label fits.",
      splitSamples: (count: number) =>
        `${n(count)} ${count === 1 ? "sample" : "samples"} in this run also ${count === 1 ? "has" : "have"} labels in another open run, so its labels will arrive in two envelopes.`,
      labels: "Labels",
      colSheet: "Sheet",
      colCell: "Cell",
      colLocation: "Location",
      colCoordinates: "Coordinates",
      colDate: "Date · sample.specimen",
      colCollector: "Collector",
      colMethod: "Method",
      colNumber: "Field number",
      colWarnings: "Look at",
      colSample: "Sample",
      noLabels: "This run holds no labels.",
      /** The transition could not happen from the run's current state. */
      wrongState: (state: string) => `The run is ${state.toLowerCase()}, so that cannot be done now.`,
      notFound: "No such print run.",
      /** The sheets of a canceled run are not served: its numbers are burned and must never reach paper. */
      canceledNoSheets: "This run was canceled, so it has no sheets to print. Its samples are waiting for the next run.",
    },
  },

  /** The people roster (/people). Staff-facing, like jobs. */
  people: {
    /** Acting for somebody else (beeline-oyl). Staff-facing, English-only. */
    delegation: "Acting for others",
    delegationHint:
      "Who this person may act for. A household shares one iNaturalist login, so the partner who does not hold it cannot sign in and their samples are unreachable without this. It grants reach, never credit: samples, labels and Master Melittology progress stay with whoever collected them.",
    actsFor: "May act for",
    actsForHint:
      "One reference per person, separated by semicolons: name:Robert Pederson;inat:429964. This replaces the whole list — leave it empty to revoke every grant.",
    saveDelegation: "Save",
    actsForNobody: "Acts for nobody",
    /** Impersonation (beeline-jjt). Staff-facing, English-only. */
    viewAs: "View Beeline as them",
    viewAsHint:
      "See exactly what this person sees when they sign in — their flagged samples, their listings, their record pages — to help them over the phone or to check what they are being told. Read-only, and the staff pages go away until you stop. Each time is recorded.",
    viewAsButton: (name: string) => `View as ${name}`,
    /** Two people share this display name, so neither can be named by it (CONTEXT.md, Person identity). */
    viewAsNameShared:
      "two people share this name, and the view cannot tell them apart — give one of them a distinguishing name first",
    title: "People",
    heading: "People",
    /**
     * What the page is, in the order it matters: people first. Which account
     * promotion picked for each of them, and how sure that is, is a job that
     * ends at cutover — so it is said in ordinary words and never given a
     * column of its own.
     */
    intro:
      "Everyone in the store, and the iNaturalist account each one signs in with. Someone with no account cannot sign in until staff connect one.",
    search: "Search",
    searchHint: "Name or iNaturalist login",
    onlySuspect: "Only accounts that look wrong",
    apply: "Apply",
    clear: "Clear all",
    inForce: "Filters in force",
    remove: (filter: string) => `Remove the ${filter} filter`,
    /** Still active, or gone quiet: a sample or a visit within twelve months (beeline-caa). */
    activity: "Active",
    activityHint: "A sample collected, or a visit here, in the last 12 months",
    activityAny: "Anyone",
    activityActive: "Active in the last 12 months",
    activityInactive: "Not active in the last 12 months",
    memberAny: "Anywhere",
    memberUnrecorded: "Not recorded",
    onlyAdmins: "Only admins",
    csv: "Download CSV",
    colPerson: "Person",
    colAccount: "iNaturalist account",
    colSamples: "Samples",
    /** The two activity columns: still collecting, still turning up here. */
    colLastSample: "Last sample",
    colLastSeen: "Last seen",
    /**
     * Said on the row only where the date is a sign-in rather than a visit.
     * iNat tokens never expire, so that date can be months behind somebody who
     * has used the site every week since — and the column is read to judge
     * whether a person is still active, which is the judgement it would
     * quietly get wrong (beeline-dji).
     */
    lastSeenSignInOnly: "sign-in only",
    never: "never",
    /** Not "Atlas": the column's answer is sometimes the program itself. */
    colMembership: "Belongs to",
    colAdmin: "Admin",
    noPeople: "Nobody matches.",
    noAccount: "No account",
    /**
     * A household shares one iNaturalist login and only one of them can hold
     * it, so the partner's row is blank where the truth is "signs in as the
     * other one". Said on the row, because a blank invites the wrong guess.
     */
    accountHeldBy: (login: string, holder: string) => `Their records use ${login}, which is ${holder}'s.`,
    accountRecordsPointAt: (records: number, login: string) =>
      `${n(records)} of their records use ${login}, which nobody here holds.`,
    found: (total: number) => `${n(total)} ${total === 1 ? "person" : "people"}`,
    pageOf: (page: number, pages: number) => `Page ${n(page)} of ${n(pages)}`,
    previous: "← Previous",
    next: "Next →",

    /**
     * A wrong account is invisible in a list that prints only the login, which
     * is how one survived review (beeline-eft). So the two shapes of wrong say
     * so on the row — and a right one says nothing at all, because a listing
     * of people should be quiet when there is nothing to report.
     */
    accountLooksWrong: "probably the wrong account",
    accountNotInRecords: "not in their records",
    lookWrong: (people: number) =>
      `${n(people)} ${people === 1 ? "person has an account that does not match" : "people have accounts that do not match"} ` +
      `the records behind them.`,
    showThem: "Show them",
    accountWhy: {
      supported: (records: number) => `${n(records)} of their records ${records === 1 ? "uses" : "use"} this account.`,
      outweighed: (bound: number, top: string, top_records: number) =>
        `Only ${n(bound)} of their records ${bound === 1 ? "uses" : "use"} this account. ` +
        `${n(top_records)} ${top_records === 1 ? "uses" : "use"} ${top} instead.`,
      unattested: "No record of theirs uses this account. It may still be right — nothing here says so either way.",
      unbound: "No iNaturalist account, so they cannot sign in.",
      unboundHeldBy: (records: number, login: string, holder: string) =>
        `No iNaturalist account, so they cannot sign in. ${n(records)} of their records use ${login}, ` +
        `which is ${holder}'s — a shared login only one person can hold.`,
    },
    records: (n_: number) => `${n(n_)} ${n_ === 1 ? "record" : "records"}`,

    // Detail page.
    backToRoster: "← All people",
    identity: "Name",
    account: "iNaturalist account",
    accountHint:
      "The user id is what actually connects them; the login is shown alongside because logins change and ids do not. Check a candidate on iNaturalist before saving it.",
    loginsSeen: "Accounts on their older records",
    loginsSeenHint: "Every account that appears on records of theirs, most-used first. Only one can be theirs.",
    colRecords: "Records",
    boundMark: "in use",
    useThis: "Bind this one",
    membership: "Membership",
    belongsTo: "Belongs to",
    belongsToHint:
      "Where this person belongs — not where their samples fell. Master Melittology itself is an answer, not a blank: volunteers outside every member atlas work under OBA staff's auspices.",
    saveMembership: "Save membership",
    /** No row: nobody has answered. Distinct from having answered "no atlas". */
    membershipUnrecorded: "Not recorded",
    membershipProgram: "Master Melittology (no atlas)",
    /** The same answer in a table cell, where the column is already "Atlas". */
    membershipProgramShort: "Program",
    adminRights: "Admin rights",
    adminHint: "Admins reach Jobs, People, Design, and the atlas-wide listings.",
    grantAdmin: "Grant admin",
    revokeAdmin: "Revoke admin",
    isAdmin: "Has admin rights",
    notAdmin: "No admin rights",
    displayName: "Display name",
    givenName: "Given name",
    familyName: "Family name",
    labelName: "Label name override",
    labelNameHint: "Leave blank to keep the derived form. Only set this when derivation gets it wrong.",
    saveNames: "Save names",
    unbind: "Remove account",
    inatUserId: "iNaturalist user id",
    inatLogin: "Login",
    bindAccount: "Save account",
    reason: "Why",
    reasonHint: "Recorded in the overlay beside the change, and read by whoever reviews it later.",
    samplesCollected: (all: number, primary: number) =>
      `${n(all)} collected, ${n(primary)} as primary collector`,
    saved: "Saved.",
    savedRebuild: "Saved. It is also recorded in the overlay, so a rebuild keeps it.",

    /**
     * The change log (beeline-o22). Staff-facing, English-only like the rest
     * of this screen. The overlay beside it keeps one current row per field,
     * so it can say who last changed a thing and never when, what it was
     * before, or that it changed twice; this says all of it.
     */
    history: {
      heading: "History",
      hint:
        "Every change recorded for this person, newest first — from this screen, from a rebuild, or from an iNaturalist sync.",
      empty: "Nothing recorded yet. Changes from here on appear in this list.",
      colWhen: "When",
      colWhat: "What",
      colChange: "Change",
      colWho: "Who",
      colPerson: "Person",
      /**
       * A value arriving where there was none, and one going away. Prefixes
       * rather than whole sentences because the value beside them is markup:
       * an account id renders as code, a missing membership as "not
       * recorded". Most of the log is arrivals — the first pass over a corpus
       * records everything it finds — and "nothing → Ada Collector" reads as
       * a correction that never happened.
       */
      set: "set to",
      cleared: "cleared — was",
      /** What the log's fields are called in the words this screen uses. */
      field: {
        display_name: "Display name",
        given_name: "Given name",
        family_name: "Family name",
        label_name: "Label name override",
        inat_user_id: "iNaturalist user id",
        login: "Login",
        membership: "Belongs to",
        admin: "Admin rights",
        acts_for: "May act for",
      },
      /**
       * Who, where nobody can be named. Four of these are passes over the
       * store that found a difference, which is a weaker claim than a staff
       * member's login and is written to read like one.
       */
      source: {
        app: "staff",
        legacy_promotion: "a rebuild",
        observation_promotion: "an iNaturalist sync",
        inat_backfill: "an iNaturalist login lookup",
        reconcile: "found at startup",
      },
      /** An empty value, in a cell that has to show something. */
      blank: "nothing",
      admin: { yes: "yes", no: "no" },
      membershipNone: "not recorded",
      /** The roster's panel: the same entries, across everybody. */
      recentHeading: "Recent changes",
      recentHint: "The newest entries in the change log, across everyone.",
      /** A person the store no longer holds, so there is nowhere to link. */
      personGone: "no longer in the store",
    },

    notFound: "No such person.",
    problem: (why: string) => `Not saved: ${why}`,
  },

  /**
   * Self-service "what to do" copy, keyed by qc_rule.name. The catalog owns
   * what users see; schema/050_qc.sql keeps the same text as in-database
   * documentation (a test pins the key sets together).
   */
  qcInstructions: {
    missing_required_field:
      "A field the label needs is empty. Fill it in on the iNaturalist observation (or here for trap samples).",
    missing_recommended_field:
      "A field the record should carry is empty. Filling it in improves the record but does not block printing.",
    obscured_no_true_coordinates:
      "The coordinates are obscured by iNaturalist geoprivacy and Beeline does not hold the true coordinates. Join the project with trusted coordinate access, or clear the geoprivacy setting on the observation.",
    locality_format:
      "The locality must be a short place name (18 characters or fewer) without commas, quotes, or street addresses — it is printed on a 3pt label. Example: Corvallis not 5th St, Corvallis OR.",
    place_unabbreviated:
      "Country and state/province must be abbreviations (USA not United States; OR not Oregon) — the label cell is tiny.",
    place_unrecognised:
      "The state or province on this record is not one Beeline recognises, or does not agree with the country beside it. Use the two-letter US state or Canadian province code (UT, BC), and a country that matches it. Records from outside the US and Canada are expected here and are not a mistake — staff can confirm them.",
    coordinate_uncertainty:
      "The location accuracy is worse than this record allows — the flag says by how much, and which limit applied. Records from 2 September 2026 onwards must be within 100 m, the resolution of a GPS reading; for a trap, the day it was emptied is the one that counts. Earlier records keep the 250 m that was in force when they were collected. Improve the pin accuracy on the observation, or ask staff if the uncertainty is genuine.",
    coordinate_out_of_region:
      "The coordinates on this record are not in North America, but the record says they should be. Usually the pin was moved on the observation after its location text was written, or a longitude lost its minus sign. Check the pin on the iNaturalist observation — if the record really was collected outside North America, set its country to match and ask staff to confirm it.",
    // The second sentence used to be "Its current identification is something
    // else (a moss, alga, fungus, or the bee itself)", which was as close as
    // this could get to naming the taxon while the detail was a machine value.
    // The detail now says which one it is, so the generic list folds into the
    // first sentence rather than being said twice (beeline-dys).
    non_tracheophyte_host:
      "The iNaturalist observation should be identified as the floral host — a vascular plant, not a moss, an alga, a fungus, or the bee itself. Correct the observation's identification to the plant the bee was collected from.",
    duplicate_sample_number:
      "Two of your samples on the same day share a sample number. Renumber one of the observations so each sample that day is distinct.",
    count_mismatch:
      "The specimen count on your iNaturalist observation has changed since this sample was made from it. Until labels print, the observation is the record; staff carry the new count across.",
    count_below_printed:
      "The specimen count is now lower than the number of labels already printed for this sample. Nothing to fix — you will have a few labels left over to discard.",
    within_sample_disagreement:
      "The legacy records merged into this sample disagreed about a field; the earliest record's value was kept. Review the alternatives listed and correct the sample if the kept value is wrong.",
    observation_missing_upstream:
      "The iNaturalist observation backing this sample was not returned by a sync that should have included it. It may have been deleted, removed from the project, or had its observation date changed. Staff investigate before any further printing for this sample.",
  } as Record<string, string>,

  /**
   * The glossary (/glossary). Volunteers meet a lot of vocabulary here that
   * nobody explained to them — some of it ours, some of it nomenclature.
   * Keys are the anchor slugs, so renaming one breaks a link: a test pins
   * every `Term` usage against these keys.
   *
   * Order is display order. Written to be read by someone who has collected
   * bees for a season and never used this software.
   */
  glossary: {
    title: "Glossary",
    heading: "Glossary",
    intro:
      "The words this site uses, and what they mean here. Some are ours; some come from iNaturalist or from the way scientific names are written. Nothing on this page is something you need to memorise — it is here so you can look it up.",
    /**
     * Alphabetical by term (beeline-0i2.1): a page called Glossary is a page
     * someone looks a word up on. A test keeps it that way. The key is the
     * anchor slug, so renaming one breaks every link to it.
     *
     * Nomenclature entries carry their example as data rather than as text,
     * because the page has to set the example the way the entry says it
     * should be set — italics and brackets come from TaxonName, which knows
     * them from the rank (beeline-0i2.6).
     */
    entries: {
      atlas: {
        term: "Atlas",
        definition:
          "Your state or provincial bee atlas: Oregon, Washington, British Columbia, Idaho, New Mexico, or Oklahoma. Samples belong to an atlas by where they were collected, not by which iNaturalist project they arrived through. Not everyone has one — you can be a Master Melittologist without a member atlas, and collecting somewhere no atlas covers is ordinary rather than a mistake.",
      },
      authorship: {
        term: "Authorship",
        definition:
          "The person who first published a name, and the year, written after it. It is part of the formal name, not a citation, and it is never italicised.",
        example: { rank: "species", scientificName: "Bombus vosnesenskii", authorship: "Radoszkowski, 1862" },
      },
      "blocks-printing": {
        term: "Blocks printing",
        definition:
          "A flag serious enough that labels cannot be printed for that sample until it is fixed — usually a missing field the label needs, or coordinates we cannot trust.",
      },
      bycatch: {
        term: "Bycatch",
        definition:
          "Anything that isn't a bee but ended up in your sample anyway — wasps, bee flies, beetles. It is kept, labelled, and identified like everything else.",
      },
      "catalog-number": {
        term: "Catalog number",
        definition:
          "The identifier a museum gives a specimen once the specimen is in its collection — Washington's come back from Ecdysis as WSDA_2303966. It is not the number on the label you print: that one is the field number.",
      },
      "cf-aff": {
        term: "cf., aff. and nr.",
        definition:
          "Ways of naming a species without quite asserting it. cf. means the specimen resembles that species and needs confirming; aff. means it is close to it but probably something else; nr. means near it. All three sit in front of the species name, and all three say more than dropping back to the genus would.",
        example: { rank: "species", scientificName: "Bombus occidentalis", qualifier: "cf." },
      },
      collector: {
        term: "Collector",
        definition:
          "A person who collected a sample. A sample can name more than one — a trap line run by two people belongs to both of you, under the numbering of whoever is listed first.",
      },
      "coordinate-uncertainty": {
        term: "Coordinate uncertainty",
        definition:
          "How far from the pin the true location might be, as recorded by iNaturalist. Beyond 100 m the location is too vague to print — usually because the phone had a poor fix. Records collected before 2 September 2026, or trapped and emptied before then, are held to the older 250 m limit: their specimens have often left the collector's hands, so the pin can no longer be corrected.",
      },
      determination: {
        term: "Determination",
        definition:
          "Someone asserting what a specimen is. Determinations are a record of who said what and when, so a later identification never erases an earlier one — and an expert's determination is never overwritten by a volunteer's.",
      },
      "field-number": {
        term: "Field number",
        definition:
          "The number printed on a specimen's label, issued here — 25000001. It is assigned when a print run is prepared, only once the sample's data is clean, and once assigned it belongs to that specimen permanently. A museum may later add a catalog number of its own; the field number stays what it was.",
      },
      flag: {
        term: "Flag",
        definition:
          "Something this site noticed about one of your samples. A flag is not a mark against you — it is a to-do. Flags are worked out fresh from your data every sync, so fixing the cause makes the flag disappear on its own.",
      },
      "floral-host": {
        term: "Floral host",
        definition:
          "The plant a sample was collected from, identified by the sample's iNaturalist observation. It must be a vascular plant — if the observation is identified as a moss or a fungus or as the bee itself, that raises a flag. Bees taken off no flower have no floral host, and that is a complete answer, not a gap.",
      },
      "heads-up": {
        term: "Heads-up",
        definition:
          "A flag worth fixing that does not stop labels being printed. Improving it makes the record better; leaving it does not hold anything up.",
      },
      itis: {
        term: "ITIS",
        definition:
          "The Integrated Taxonomic Information System: a published list of scientific names, kept by a partnership of North American government agencies, that determinations here are made against. It lags behind bee taxonomy in places, so a few names the program uses are newer than ITIS, and a few ITIS still calls current have since been revised.",
      },
      label: {
        term: "Label",
        definition:
          "The printed slip pinned with a specimen, carrying where and when it was collected, by whom, and its field number. It is printed about 3pt tall, which is why the locality has to be a short place name rather than an address. Labels are printed in batches called print runs; each of your specimens says whether its label is being printed, printed, or mailed.",
      },
      "master-melittology": {
        term: "Master Melittology",
        definition:
          "The program at Oregon State University Extension that trains and coordinates the atlases, and the umbrella all of them sit under. This site is run by the program on behalf of your atlas — or, if you belong to no member atlas, on its own behalf.",
      },
      "obscured-coordinates": {
        term: "Obscured coordinates",
        definition:
          "iNaturalist sometimes shifts an observation's public coordinates — either because you set it to, or automatically for sensitive species. Obscured coordinates cannot go on a label, because they are not where the bee was actually collected.",
      },
      observation: {
        term: "Observation",
        definition:
          "A record on iNaturalist. For this site an observation is the evidence of a sample: it carries your sample number, your specimen count, the date, and the location, and where there is a floral host it is the photograph of that plant. Bees collected off no flower still get an observation — one with no photo and no identification, there to carry the sample.",
      },
      rank: {
        term: "Rank",
        definition:
          "How specific a name is — family, genus, species, subspecies, and the coarser ranks above them. Identifications do not always reach species, and a name at genus rank is a complete answer, not a failed one.",
      },
      "sensu-stricto": {
        term: "s. str. and s. lat.",
        definition:
          "Short for sensu stricto and sensu lato — “in the narrow sense” and “in the broad sense”. They mark which of two competing definitions of a name is meant, and like other abbreviations they stay upright.",
        example: { rank: "genus", scientificName: "Bombus", qualifier: "s. str." },
      },
      sample: {
        term: "Sample",
        definition:
          "Everything you collected off one flower species in one place on one day — or, where there was no flower, everything you collected in that place that day. Two flower species in the same place on the same day are two samples. A sample is the unit this whole site is organised around: it holds your specimens, it gets its flags checked, and it is what labels are printed for.",
      },
      "sample-number": {
        term: "Sample number",
        definition:
          "The number you gave a sample on the day you collected it. It only has to be unique among your own samples on that date — two people can both have a sample 3 on the same day.",
      },
      protocol: {
        term: "Sampling protocol",
        definition: "How a sample was collected — netting, a vane trap, a pan trap, a trap nest.",
      },
      "scientific-name": {
        term: "Scientific name",
        definition:
          "The formal Latin name of an organism. Genus names and everything below them are written in italics; family names and above are not.",
        example: { rank: "species", scientificName: "Bombus vosnesenskii" },
      },
      sp: {
        term: "sp. and spp.",
        definition:
          "sp. means one unnamed species in that genus — “a bumble bee, genus known, species not”. spp. means several. Neither is italicised, because they are abbreviations rather than names.",
        example: { rank: "genus", scientificName: "Bombus", qualifier: "sp." },
      },
      specimen: {
        term: "Specimen",
        definition: "One bee (or one piece of bycatch) from a sample. Each specimen gets its own label and its own field number.",
      },
      subgenus: {
        term: "Subgenus",
        definition:
          "A grouping inside a genus, written in brackets between the genus and the species. The brackets are part of the convention, not an aside.",
        example: { rank: "species", scientificName: "Bombus insularis", subgenus: "Psithyrus" },
      },
      sync: {
        term: "Sync",
        definition:
          "Staff's word for Beeline reading your observations from iNaturalist, which it does every morning at 2am Pacific. A change you make on iNaturalist shows up here the next day, not the moment you make it.",
      },
      "trap-sample": {
        term: "Trap sample",
        definition:
          "The contents of a trap, collected on the day you emptied it. Because a trap works unattended, its specimens are dated to the range since you last serviced it rather than to a single day. Trap samples usually have no iNaturalist observation, so they are corrected here instead of upstream.",
      },
      "vernacular-name": {
        term: "Vernacular name",
        definition:
          "An everyday English name, like “yellow-faced bumble bee”. Plants usually have one and bees usually do not, and the same name can mean different things in different places — so scientific names are what this site records.",
      },
    } satisfies Record<string, GlossaryEntry>,
  },
};

export type Messages = typeof en;
