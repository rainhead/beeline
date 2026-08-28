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
const dateTime = (d: Date | string) =>
  typeof d === "string"
    ? d
    : d.toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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
  /** Locale-aware value formatters, for views composing values into markup. */
  format: { date, dateTime, dateRange, number: n, list, place },

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
    },
    /** The hamburger button that holds the nav on narrow screens. */
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
    heading: "Samples needing attention",
    summary: (samples: number, blocking: number) =>
      `${n(samples)} ${samples === 1 ? "sample needs" : "samples need"} attention` +
      (blocking > 0 ? ` — ${n(blocking)} ${blocking === 1 ? "flag blocks" : "flags block"} label printing.` : "."),
    allClearHeading: "All clear",
    allClear: "Nothing needs your attention — every one of your samples is clean. Thank you!",
    lastSynced: (when: Date | string) => `Data last synced from iNaturalist ${dateTime(when)}.`,
    neverSynced: "This instance has not synced from iNaturalist yet.",
    clearsNote: "Fix things on the iNaturalist observation and the flag clears on the next sync.",
    sampleTitle: (sampleNumber: string, when: Date | string) => `Sample ${sampleNumber} · ${date(when)}`,
    specimens: (count: number) => `${n(count)} ${count === 1 ? "specimen" : "specimens"}`,
    fixOnInat: "Fix on iNaturalist",
    notInatBacked: "Not backed by an iNaturalist observation — edit it here and the flags update immediately.",
    editSample: "Edit this sample",
    blocksPrinting: "blocks printing",
    headsUp: "heads-up",
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
   * The passive counterpart to the flagged list: samples that are clean and
   * waiting on labels. No promises about when — printing is staff work whose
   * shape is still being worked out (beeline-1kb.1).
   */
  pendingPrint: {
    heading: "Waiting on labels",
    summary: (samples: number, labels: number) =>
      `${n(samples)} ${samples === 1 ? "sample is" : "samples are"} clean and waiting — ` +
      `${n(labels)} ${labels === 1 ? "label" : "labels"} still to print. Nothing more for you to do with these.`,
    colSample: "Sample",
    colPlace: "Place",
    colLabels: "Labels",
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
      ledeMine: "Every sample you collected, most recent first.",
      ledeAtlas: (atlas: string) => `Every sample in the ${atlas}, most recent first.`,
      ledeAll: "Every sample in every atlas, most recent first.",
      ledeOutside: "Every sample collected where no member atlas reaches, most recent first.",
      count: (total: number) => `${n(total)} ${total === 1 ? "sample" : "samples"}`,
      emptyHeading: "Nothing here yet",
      emptyMine: "None of your collecting has reached Beeline yet. Samples arrive from iNaturalist as they sync.",
      emptyFiltered: "No samples match these filters. Widen the dates, clear the taxon, or search for less.",
      colSample: "Sample",
      colDate: "Date",
      colCollectors: "Collectors",
      colPlace: "Place",
      colSpecimens: "Specimens",
      colStatus: "Flags",
      colAtlas: "Atlas",
      colLinks: "",
      viewOnInat: "iNaturalist",
      edit: "Edit",
    },

    specimens: {
      title: "Specimens",
      heading: "Specimens",
      ledeMine: "Every specimen from your samples, most recent collecting first.",
      ledeAtlas: (atlas: string) => `Every specimen in the ${atlas}, most recent collecting first.`,
      ledeAll: "Every specimen in every atlas, most recent collecting first.",
      ledeOutside: "Every specimen collected where no member atlas reaches, most recent collecting first.",
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
      colDetermination: "Determination",
      colDeterminer: "Determined by",
      colAtlas: "Atlas",
      /** A specimen whose label predates field numbering. */
      noFieldNumber: "not numbered",
      undetermined: "not determined",
      expert: "expert",
    },

    /** Whose records a listing shows. Staff see the control; nobody else does. */
    scope: {
      label: "Show",
      mine: "My records",
      all: "All atlases",
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
      det: "Determination",
      detAny: "Any",
      detDetermined: "Determined",
      detUndetermined: "Not determined",
      season: "Season",
      seasonAny: "Any",
      seasonOpen: "This season",
      seasonSettled: "Earlier seasons",
      qc: "Flags",
      qcAny: "Any",
      qcFlagged: "Any flag",
      qcBlocking: "Blocks printing",
      qcWarning: "Heads-up only",
      qcClean: "Clean",
      apply: "Apply",
      clear: "Clear",
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
      atlas: "Atlas",
      /** Collecting outside the member atlases is ordinary (beeline-lcl). */
      atlasOutside: "None — collected where no member atlas reaches",
      host: "Floral host",
      observation: "iNaturalist observation",
      /** Trap samples usually have none, and that is not a gap. */
      observationNone: "None — this sample did not come from an observation, so it is corrected here rather than upstream.",
      viewOnInat: "View on iNaturalist",
      edit: "Edit this sample",
      /** Every value the record simply does not carry. */
      unknown: "not recorded",

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
        source: "Where they came from",
        sources: {
          inat_trusted:
            "Read from your iNaturalist observation with trusted access, so these are the true coordinates even where the public map shows them shifted.",
          inat_public: "Read from your iNaturalist observation, which publishes them as they are.",
          legacy_import:
            "Imported from the old atlas database, which recorded nothing about where its coordinates came from. These are the ones already printed on labels.",
          staff_entry: "Entered by staff.",
        } as Record<string, string>,
        privacy: "On iNaturalist",
        privacyOpen: "Published as they are — nothing about this observation is obscured.",
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
        noFieldNumber: "not numbered",
        undetermined: "not determined",
        expert: "expert",
      },
    },

    specimen: {
      title: (fieldNumber: string) => `Specimen ${fieldNumber}`,
      /** Pre-field-number labels: the only handle is its place in the sample. */
      titleUnnumbered: (specimenNumber: number, sampleNumber: string) =>
        `Specimen ${n(specimenNumber)} of sample ${sampleNumber}`,
      back: (sampleNumber: string) => `← Sample ${sampleNumber}`,
      fieldNumber: "Field number",
      fieldNumberNone: "Not numbered — this specimen's label predates field numbering.",
      inSample: "Number in its sample",
      fromSample: "From sample",
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
    noRuns: "No runs yet.",
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
    search: "Name or login",
    searchHint: "Matches the display name or the account login.",
    onlySuspect: "Only accounts that look wrong",
    apply: "Search",
    clear: "Clear",
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
    never: "—",
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
      "A field the label needs is empty. Fill it in on the iNaturalist observation (or here for trap samples) and it will clear on the next sync.",
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
      "The location accuracy is worse than 250 m. Improve the pin accuracy on the observation, or ask staff if the uncertainty is genuine.",
    non_tracheophyte_host:
      "The iNaturalist observation should be identified as the floral host — a vascular plant. Its current identification is something else (a moss, alga, fungus, or the bee itself). Correct the observation's identification to the plant the bee was collected from and it will clear on the next sync.",
    duplicate_sample_number:
      "Two of your samples on the same day share a sample number. Renumber one of the observations so each sample that day is distinct.",
    count_mismatch:
      "Your iNaturalist observation and this sample disagree about how many specimens were collected. Update whichever side is wrong.",
    count_below_printed:
      "The specimen count is now lower than the number of labels already printed for this sample. Nothing to fix in the data — but some printed labels may never be attached to a specimen.",
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
          "How far from the pin the true location might be, as recorded by iNaturalist. Beyond 250 m the location is too vague to print, usually because the phone had a poor fix.",
      },
      determination: {
        term: "Determination",
        definition:
          "Someone asserting what a specimen is. Determinations are a record of who said what and when, so a later identification never erases an earlier one — and an expert's determination is never overwritten by a volunteer's.",
      },
      "field-number": {
        term: "Field number",
        definition:
          "The number printed on a specimen's label, issued here — 25000001. It is assigned only once the sample's data is clean, and once assigned it belongs to that specimen permanently. A museum may later add a catalog number of its own; the field number stays what it was.",
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
      label: {
        term: "Label",
        definition:
          "The printed slip pinned with a specimen, carrying where and when it was collected, by whom, and its field number. It is printed about 3pt tall, which is why the locality has to be a short place name rather than an address.",
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
          "This site pulling your observations from iNaturalist. Changes you make on iNaturalist show up here after the next sync, not the moment you make them.",
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
