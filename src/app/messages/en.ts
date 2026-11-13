/**
 * The English catalog — and, via `typeof`, the shape every other catalog
 * must satisfy. Plain data and functions, no framework: a message with
 * variables is a function so word order stays the translator's decision.
 * Views never carry literal user-facing prose; they render from here.
 */

import type { TaxonQualifier } from "../views/components/taxon.js";
import type { LocalityBasis } from "../../locality-rule.js";
import type { OutOfDateField } from "../../model.js";
import { OLD_BEELINE_ORIGIN } from "../old-beeline.js";

/** An outside data source the site footer credits, with the licence or terms it asks credit under, where it names some. */
export interface CreditedSource {
  name: string;
  href: string;
  terms?: string;
  termsHref?: string;
}

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
// A print run's name (GitHub #105): the moment it was prepared, to the
// second, in Pacific time, beside its scope. It used to be the run's
// entity_id — "Print run 804,984" — which says nothing to the people holding
// the sheets and is a per-store draw a rebuild redraws. Year first, because a reader seeing
// 04.09 cannot tell April from September; seconds, because two runs
// prepared in the same minute are still two runs.
const stampParts = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: ZONE,
  timeZoneName: "short",
});
const stamp = (d: Date | string) => {
  if (typeof d === "string") return d;
  const p = Object.fromEntries(stampParts.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${p.timeZoneName}`;
};
/** The calendar day an INSTANT fell on, in Pacific time — never for a DATE column, which is `date`. */
const day = (d: Date | string) =>
  typeof d === "string"
    ? d
    : d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric", timeZone: ZONE });
// A collecting window: one day for a net sample, a range for a trap left out
// across several. One formatter rather than one per screen, because it is a
// value formatting rule and not something a screen decides.
// A date the source stated only part of (beeline-9ut): a bare year from
// Ecdysis is shown as the year, never as a confident January 1st.
const datePrecise = (d: Date | string, precision: "month" | "year" | null) => {
  if (typeof d === "string" || precision === null) return date(d);
  if (precision === "year") return String(d.getFullYear());
  return d.toLocaleDateString(locale, { year: "numeric", month: "short" });
};
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
  format: { date, datePrecise, day, dateTime, dateRange, number: n, list, place },

  /** The combobox's own words (src/app/islands/combobox.ts, beeline-wn2). */
  combobox: {
    /** The list is open and nothing matches what is typed. */
    noMatches: "Nothing matches.",
    /** The chevron at the right of the box, for a screen reader. */
    toggle: "Show choices",
  },

  /**
   * A locality named from the sample's coordinates (beeline-7i6), offered on
   * the sample page and on the front page's locality flags. One click makes
   * it the sample's locality, set here over the observation's (Peter,
   * 2026-10-26), and the volunteer who did it can go back. `basis` says in a
   * few words why the name was chosen, so a reader can tell "inside the
   * refuge" from "the nearest town" without knowing the rule
   * (src/locality-rule.ts).
   */
  suggestedLocality: {
    lead: "Suggested from the coordinates:",
    use: "Use this locality",
    /** The sample's locality already is the suggestion. */
    inUse: "This is the sample's locality.",
    /** Before the other names offered for the point (beeline-4hxe). */
    alternativesLead: "Or:",
    /** On an alternative: make it the sample's locality. */
    useShort: "Use",
    /** What a screen reader says for that button, so the alternatives' buttons are not all just "Use". */
    useShortLabel: (locality: string) => `Use ${locality}`,
    /** On an alternative that is the sample's locality already. */
    inUseShort: "in use",
    /** Recorded as the reason beside the locality set here, so the sample page says where it came from. */
    reason: (basis: string) => `Suggested from the coordinates: ${basis}.`,
    /** Somebody else set the locality standing on the sample: theirs to take back, not this person's. */
    notYours: "Only the person who set this locality can change it. Contact staff to request a change.",
    /** Somebody else's locality stands on the sample, and is theirs to change. */
    setByOther: "Another user set this sample's locality. Contact staff to request a change.",
    /** The suggestion moved between drawing the page and the click: nothing was saved. */
    changed: "The suggested locality has changed since the page was loaded. Review it before confirming.",
    /** A printed sample's locality no longer follows anything (CONTEXT.md, Upstream). The name is still shown, for judging it. */
    printed: "Labels have already been printed for this sample, so its locality cannot be changed.",
    basis: {
      used_own: "the locality of the collector's other samples here",
      used: "the locality of other samples here",
      campground: "a nearby campground",
      refuge: "inside a national wildlife refuge",
      wildlife_area: "inside a WDFW wildlife area unit",
      national_park: "inside a national park or monument",
      state_park: "inside a state or provincial park",
      local_park: "inside a park or reserve",
      neighbourhood: "the neighborhood",
      town_limits: "inside the town's limits",
      island: "on the island",
      feature: "a place other volunteers have named nearby",
      peak: "a peak nearby",
      town: "a town nearby",
      hamlet: "a named place nearby",
      large_reserve: "inside a large reserve",
      distance: "distance and direction from the nearest town",
    } satisfies Record<LocalityBasis, string>,
  },

  layout: {
    /**
     * The site footer's credit for the outside data the pages show (Peter,
     * 2026-10-26): the observations and determinations the records come
     * from, and the places and elevations derived for them. The suggested
     * locality is named from these places
     * (beeline-7i6) and the elevations are read from these models, and
     * several of the licences require the credit wherever the data appears:
     * GeoNames (CC BY 4.0), OpenStreetMap (ODbL), BC's Open Government
     * Licence, and the Copernicus DEM's own wording. The US agencies' data is
     * public domain and credited as a courtesy. Proper names stay as their
     * owners write them.
     */
    credits: {
      /** The repository is public (Peter, 2026-10-26: the footer might as well link it). */
      source: { lead: "Beeline's source code is on", label: "GitHub", href: "https://github.com/rainhead/beeline" },
      /**
       * Ecdysis asks to be cited, and for its occurrence data the collections
       * that published it (its Data Usage Guidelines): Beeline reads its
       * taxonomic thesaurus and adopts the determinations the collections
       * publish through it. iNaturalist's observers made every sample since
       * 2019 an observation.
       */
      records: "Taxonomy and determinations",
      recordSources: [
        {
          name: "Ecdysis and the collections that publish through it",
          href: "https://ecdysis.org/index.php",
          terms: "Data Usage Guidelines",
          termsHref: "https://ecdysis.org/includes/usagepolicy.php",
        },
      ],
      observations: "Observations",
      observationSources: [{ name: "iNaturalist and its observers", href: "https://www.inaturalist.org/" }],
      places: "Place names and boundaries",
      elevations: "Elevations",
      placeSources: [
        { name: "GeoNames", href: "https://www.geonames.org/", terms: "CC BY 4.0", termsHref: "https://creativecommons.org/licenses/by/4.0/" },
        { name: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright", terms: "ODbL", termsHref: "https://www.openstreetmap.org/copyright" },
        {
          name: "Province of British Columbia",
          href: "https://catalogue.data.gov.bc.ca/",
          terms: "Open Government Licence – British Columbia",
          termsHref: "https://www2.gov.bc.ca/gov/content/data/policy-standards/open-data/open-government-licence-bc",
        },
        { name: "US Census Bureau", href: "https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html" },
        { name: "US Fish and Wildlife Service", href: "https://www.fws.gov/program/national-wildlife-refuge-system" },
        { name: "National Park Service", href: "https://www.nps.gov/" },
        { name: "Washington Department of Fish and Wildlife", href: "https://wdfw.wa.gov/places-to-go/wildlife-areas" },
        { name: "Washington State Parks", href: "https://parks.wa.gov/" },
        { name: "Wilderness Connect", href: "https://wilderness.net/" },
      ],
      elevationSources: [
        { name: "NASA SRTM", href: "https://www.earthdata.nasa.gov/data/instruments/srtm" },
        {
          name: "Copernicus DEM GLO-30",
          href: "https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM",
          terms:
            "© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA",
        },
      ],
    } satisfies {
      source: { lead: string; label: string; href: string };
      records: string;
      recordSources: CreditedSource[];
      observations: string;
      observationSources: CreditedSource[];
      places: string;
      elevations: string;
      placeSources: CreditedSource[];
      elevationSources: CreditedSource[];
    },
    /** Any instance that is not production says so (beeline-2u8). */
    envBanner: (environment: string) => `${environment} instance — data here may be blown away and rebuilt at any time`,
    /**
     * The sandbox's own banner, from cutover (beeline-83b8.15): staff made real
     * decisions there daily until production opened, and one made there now is
     * lost, so the banner says where the record is instead.
     */
    sandboxBanner: "This is the sandbox, not Beeline. Changes made here are not kept. Beeline is at melittologist.org.",
    nav: {
      samples: "Samples",
      specimens: "Specimens",
      glossary: "Glossary",
      howItWorks: "How Beeline works",
      people: "People",
      design: "Design",
      jobs: "Jobs",
      taxonomy: "Taxonomy",
      programs: "Programs",
      printRuns: "Print runs",
      exports: "Exports",
      identify: "Identify specimens",
      unclaimed: "Unknown collectors",
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
      body: (context: { url: string; when: string; userAgent: string; login: string; session: string; reference?: string }) =>
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
          // Only on an error page: the reference that finds the failure in the logs (beeline-0kj).
          ...(context.reference === undefined ? [] : [`Error reference: ${context.reference}`]),
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
      banner: (name: string) => `You are acting on behalf of ${name}. Samples shown as yours belong to them.`,
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
    /** The link to the person's own API keys (/keys), in the account menu. */
    apiKeys: "API keys",
    /** BEELINE_DEV_LOGIN sessions ignore cookies, so there is nothing to sign out of. */
    devSession: "Signed in by BEELINE_DEV_LOGIN — stop the dev server to change who you are.",
    pageTitle: (title: string) => `${title} · Beeline`,
  },

  signIn: {
    title: "Sign in",
    heading: "Beeline",
    /**
     * Until the old Beeline closes (beeline-83b8.12): new Beeline was never
     * announced to volunteers, so the page says what it is (Peter,
     * 2026-11-03). Afterwards it reads "Sign in with iNaturalist to access
     * your records." again.
     */
    nothingPublic: "Beeline has been remade. Try it out by signing in with iNaturalist.",
    button: "Sign in with iNaturalist",
    /**
     * For someone who lands here with no account (beeline-2c3.16): what this
     * is, and where a would-be volunteer goes instead. Each atlas runs its own
     * volunteers, so the way in is the atlas's own site.
     */
    about: {
      lead: "Beeline keeps the records of the bee specimens that",
      /** The program's own page at OSU Extension (Peter, 2026-10-27). */
      program: { label: "Master Melittologist", href: "https://extension.oregonstate.edu/master-melittologist" },
      tail: "volunteers collect.",
    },
    /**
     * For a volunteer who bookmarked the old Beeline at this address, which it
     * left at cutover (beeline-83b8.12). Until the old Beeline closes, after
     * February.
     */
    oldBeeline: {
      lead: "If you would like to continue using the old interface to enter your determinations, it will be available at",
      label: "old.melittologist.org",
      tail: " through February 2027.",
    },
    joinLead: "To become a volunteer, start with your atlas:",
    failed: "Sign-in failed (state mismatch or missing code). Try again from the sign-in page.",
  },

  pendingApproval: {
    title: "Almost there",
    heading: "Almost there",
    body: (login: string) =>
      `You signed in as ${login}, but that iNaturalist account is not connected to a member record yet. ` +
      `Your atlas staff can connect it.`,
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
      "Beeline tracks the bees you collect for your atlas. Each iNaturalist observation becomes a sample here, " +
      "specimens receive labels, and expert determinations are recorded back to the sample. " +
      "This page shows your samples from this season that need attention or are waiting on labels, " +
      "as well as samples from last season until 1 March.",
    /** After the lede: the whole process, for someone who has just arrived (beeline-kgwd). */
    howItWorksLink: "How Beeline works, step by step.",
    /** Positional so the proofing page can call it with placeholders (messages-proof.tsx). */
    summary: (flagged: number, blocking: number, waiting: number, placeholders: number, unnumbered = 0) => {
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
      if (unnumbered > 0) {
        parts.push(
          `${n(unnumbered)} ${unnumbered === 1 ? "observation has" : "observations have"} no sample number`,
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
    allClear: "None of your recent samples need attention, and none are waiting on labels. Thank you!",
    /**
     * The schedule, in words a volunteer has: never "sync", and never the
     * timestamp of the last run — which the sandbox printed in UTC as 9am
     * and which is /jobs's business anyway (Peter, 2026-09-16).
     */
    refreshNote:
      "Beeline reads your observations from iNaturalist every morning at 2am Pacific. " +
      "A fix you make on iNaturalist shows up here the next day.",
    neverSynced: "This instance has not read anything from iNaturalist yet.",
    /**
     * "Check iNaturalist now" (beeline-yso): reads the active seasons'
     * observations again at once — this season's, and last season's until
     * 1 March. Never "sync", like the note above it.
     */
    check: {
      button: "Check iNaturalist now",
      why: "If you updated observations on iNaturalist, Beeline can check for updates now.",
      lastChecked: (when: Date) => `Last checked ${dateTime(when)}.`,
      done: (fetched: number, changed: number) =>
        `Beeline read ${n(fetched)} of your recent ${fetched === 1 ? "observation" : "observations"} again. ` +
        (changed === 0
          ? "None had changed since it last read them."
          : `${n(changed)} had changed, and this page shows them as they are now.`),
      tooSoon: (seconds: number) =>
        `Beeline checked iNaturalist recently. It can check again in ${n(seconds)} ${seconds === 1 ? "second" : "seconds"}.`,
      busy: "Beeline is reading everybody's observations from iNaturalist right now. Try again after 5am Pacific.",
      failed:
        "Beeline couldn't reach iNaturalist just now, so nothing here has changed. " +
        "Try again in a few minutes, or wait for tomorrow morning's read.",
      noAccount: "Beeline can't check iNaturalist here, because no iNaturalist account is connected to this person.",
      unavailable: "This instance of Beeline doesn't read from iNaturalist.",
    },
    sampleTitle: (sampleNumber: string, when: Date | string) => `Sample ${sampleNumber} · ${date(when)}`,
    /** An observation whose sample number was left blank: it has no number to be titled by. */
    unnumberedTitle: (when: Date | string) => `No number · ${date(when)}`,
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
    /** A host identified on iNaturalist to a taxon Beeline has no name for (gh-250): the taxon, linked, never "none". */
    hostUnnamed: (taxonId: number) => `iNaturalist taxon ${taxonId}`,
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
        "Once you have checked the place, coordinates, and count, enter how many you collected.",
    },
    /**
     * An observation in the atlas's iNaturalist project with its sample
     * number left blank (beeline-a04). The project lets an observation in
     * with the field empty, and nothing becomes a sample without a number,
     * so it would otherwise vanish. The volunteer's own notes are quoted
     * back when there are any, since that is where some wrote the number —
     * quoted, never read for one.
     */
    unnumbered: {
      chip: "no number",
      note:
        "This observation is in your atlas's iNaturalist project with its sample number left blank, so it is not a sample yet. " +
        "If you collected bees from this plant, enter the sample number on the observation.",
      notesSay: (notes: string) => `Your notes say: “${notes}”.`,
    },
    /**
     * Numbers missing from a day's run — 1, 2, 4 and no 3 (beeline-virz).
     * Advisory: a skipped number is fine, and only the volunteer knows
     * whether one was skipped or is a vial whose observation never reached
     * the project. So it asks, below the table, and blocks nothing.
     */
    skipped: {
      note:
        "Some recent days skip a sample number. " +
        "If you collected a sample under one of these, confirm that its observation is in your atlas's iNaturalist project with its sample number.",
      /** `runs` is the numbers as runs ("3", "5–7"); `count` is how many numbers they hold. */
      day: (when: Date | string, runs: readonly string[], count: number) =>
        `${date(when)}: ${count === 1 ? "no sample" : "no samples"} ${list(runs)}`,
      link: "your observations that day",
    },
    /**
     * Whose sample you are looking at when it isn't only yours: the sample
     * number belongs to the first collector's series, so a shared sample has
     * to say who else was there (beeline-77j).
     */
    collectedWith: (people: string) => `collected with ${people}`,

    /**
     * Specimens from the newest active season with any that nobody has named
     * yet, linking to where a volunteer names them. The year is named, since
     * in January and February it is usually last season's.
     */
    identify: {
      note: (specimens: number, season: number) =>
        `${n(specimens)} of your specimens from ${season} ${specimens === 1 ? "is" : "are"} waiting to be identified.`,
      link: "Identify them",
    },
    /**
     * The feed of experts' identifications of the person's bees
     * (beeline-xegx). Identification arrives in batches, often a year or more
     * after collecting, and until this a volunteer had no way to learn of it.
     */
    identifications: {
      heading: "Latest identifications of your bees",
      intro: "Experts identify in batches, often a year or more after the bees were collected. These are the newest days they identified yours.",
      empty: "No dated identification of your bees by an expert other than you yet.",
    },
    /**
     * Settled seasons stop asking (beeline-2c3.24). Said out loud rather than
     * silently dropped: a flag that vanishes without explanation reads as a
     * bug, and these are still fixable.
     */
    settled: {
      note: (samples: number) =>
        `${n(samples)} older ${samples === 1 ? "sample" : "samples"} of yours still ${samples === 1 ? "carries a flag" : "carry flags"}. ` +
        `Each season settles on 1 March of the next year; flags remain visible and can still be corrected.`,
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
      emptyMine: "None of your collecting has reached Beeline yet. Samples arrive from iNaturalist during scheduled syncs.",
      emptyFiltered: "No samples match these filters. Widen the dates, clear the taxon, or broaden the search.",
      colSample: "Sample",
      colDate: "Date",
      colCollectors: "Collectors",
      colPlace: "Place",
      colHost: "Host plant",
      /** The record page's word for net or trap, so the two pages call it one thing. */
      colMethod: "Method",
      colSpecimens: "Specimens",
      colStatus: "Flags",
      colAtlas: "Atlas",
      /** A sample collected where no member atlas reaches: ordinary, and said so rather than left blank. */
      atlasOutside: "outside",
      /** Read aloud, never shown: the column of links out. */
      colLinks: "Links",
      viewOnInat: "View on iNaturalist",
      edit: "Edit",
      /**
       * Changing a sample's locality from its place (beeline-7ywr,
       * beeline-8w8n): a pencil, in the listing's Place cell and the sample
       * page's Place row, that opens a choice of the observation's own
       * locality and the names suggested from the coordinates, and for staff
       * a box to write one in.
       */
      placeEdit: {
        /** The pencil, for a screen reader: it has no visible words. */
        open: (sample: string) => `Change the place of sample ${sample}`,
        /** The box's label, read aloud only: the column heading or row says it on screen. */
        label: "Place",
        /** Beside each choice in the box: where the name came from. */
        noteInaturalist: "from iNaturalist",
        /**
         * Beside a name suggested from the coordinates: why, in a word or two
         * (Peter, 2026-11-06: "nearby town" says more than "suggested"). The
         * longer form is `suggestedLocality.basis`, which the front page shows.
         */
        noteBasis: {
          used_own: "previously used by the collector",
          used: "previously used",
          campground: "campground",
          refuge: "wildlife refuge",
          wildlife_area: "wildlife area",
          national_park: "national park",
          state_park: "state park",
          local_park: "park",
          neighbourhood: "neighborhood",
          town_limits: "town",
          island: "island",
          feature: "named nearby",
          peak: "nearby peak",
          town: "nearby town",
          hamlet: "nearby place",
          large_reserve: "reserve",
          distance: "from nearest town",
        } satisfies Record<LocalityBasis, string>,
        noteCurrent: "current",
        /** Under the box, for staff on a printed sample: the labels keep the old name. */
        printed: "This sample's labels are already printed. Changing the locality here does not change the printed labels.",
        save: "Save",
        cancel: "Cancel",
        /** A collector wrote a name that is not one of the choices. */
        onlyOffered: "Choose one of the names offered. To use another, change the place on iNaturalist.",
      },
    },

    specimens: {
      title: "Specimens",
      heading: "Specimens",
      ledeMine: "Every specimen from your samples.",
      /** After ledeMine, a link to /determinations. */
      identify: "Identify them.",
      ledeAtlas: (atlas: string) => `Every specimen in the ${atlas}.`,
      ledeAll: "Every specimen in every atlas.",
      ledeOutside: "Every specimen collected where no member atlas reaches.",
      count: (total: number) => `${n(total)} ${total === 1 ? "specimen" : "specimens"}`,
      emptyHeading: "Nothing here yet",
      emptyMine:
        "No specimens recorded yet. A specimen becomes its own record when its label is printed.",
      emptyFiltered: "No specimens match these filters. Widen the dates, clear the taxon, or broaden the search.",
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
      /** Beside the number: asked for again, and no run has taken it yet (gh-218). */
      reprintRequested: "reprint requested",
      /**
       * Ticking specimens and marking their labels for reprint (beeline-1kb.23).
       * Staff only. The selection is kept while the person pages and filters,
       * in this browser tab only.
       */
      bulk: {
        /** The button that puts the listing in the reprint action's mode. */
        start: "Mark labels for reprint…",
        modeHeading: "Marking labels for reprint.",
        modeIntro:
          "Tick the specimens whose labels should print again; a row that cannot be marked says why. Your ticks stay while you page and filter, in this tab.",
        leave: "Stop marking",
        /** In the tick column, instead of a box: why this label cannot be marked now (REPRINT_BLOCKER). */
        blocker: {
          unnumbered: "no field number",
          asked: "already waiting",
          printing: "in an unprinted run",
        } as Record<string, string>,
        /** The heading cell's box, for a screen reader: it has no visible words. */
        tickPage: "Tick every specimen on this page",
        tickOne: (fieldNumber: string) => `Tick ${fieldNumber}`,
        /** Counts, with {n} replaced in the browser as the ticks change. */
        countNone: "Nothing ticked yet",
        countOne: "1 specimen ticked",
        countOther: "{n} specimens ticked",
        hint: "Their labels go into the next print run under the field numbers they already have, after that run's new labels. A reason is optional.",
        button: "Mark for reprint",
        clear: "Untick all",
        /** After the marking, back on the listing. */
        done: (requested: number, of: number) =>
          requested === of
            ? `Marked ${n(requested)} ${requested === 1 ? "label" : "labels"} for reprint.`
            : `Marked ${n(requested)} of ${n(of)} ${of === 1 ? "label" : "labels"} for reprint. The rest were already waiting, are in a run that has not printed, or have no field number.`,
      },
    },

    /**
     * Whose records a listing shows: a three-way toggle — mine, my atlas,
     * everything (Peter, 2026-09-16) — for everyone since volunteers could
     * see every record (2026-10-23).
     */
    scope: {
      label: "Show",
      mine: "My records",
      atlasRecords: (atlas: string) => `${atlas} records`,
      all: "All records",
      /**
       * Collecting outside the atlases is ordinary, not an error, and the label
       * has to sound like it (beeline-lcl).
       */
      outside: "Outside the atlases",
      /** Above a listing of other people's records, for anyone but staff. */
      withheldNote:
        "Where an observation is obscured or private on iNaturalist, only its collectors and staff see where it was collected. The same applies where Beeline has not read the observation, or cannot find it on iNaturalist.",
    },
    /** In a Place cell whose locality, and perhaps county, is somebody else's to see. */
    locationHidden: "location hidden",

    filters: {
      search: "Search",
      searchHint: "Sample number, collector, or field number",
      from: "Collected from",
      to: "Collected to",
      place: "Place",
      placeHint: "Locality, county, state, country, wilderness, or ecoregion",
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
      /** Whether labels are on paper (beeline-3v33): a sample's labels, or a specimen's own. */
      labels: "Labels",
      labelsAny: "Any",
      labelsWaiting: "Waiting",
      labelsPrinted: "All printed",
      labelsWaitingHint: "Some specimens have no label printed yet, including samples held back by a flag",
      labelWaiting: "Not printed yet",
      labelPrinted: "Printed",
      /** Beside a sample's specimen count. */
      labelsWaitingCount: (count: number) => `${n(count)} waiting on labels`,
      method: "Method",
      methodAny: "Any",
      methodNet: "Net",
      methodTrap: "Trap",
      qc: "Flags",
      qcAny: "Any",
      qcFlagged: "Any flag",
      qcBlocking: "Blocks printing",
      qcWarning: "Heads-up only",
      qcClean: "Clean",
      /** A locality flag, or no locality at all: what a suggested locality fixes (beeline-7ywr). */
      qcLocality: "Locality missing or unusable",
      /** One kind of flag, named as its chip is (status.flag). */
      flagKind: "Kind of flag",
      flagKindAny: "Any",
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
      /**
       * One chip per kind of flag in the Flags column (beeline-ik0d, Peter
       * 2026-11-04): the problem in a word or two, the colour for whether it
       * blocks printing, the rule's explanation on click. Keyed by
       * qc_rule.name, like qcInstructions; a test holds the keys to the
       * schema's rules. Two take their words from the finding instead: a
       * missing field names the field, and a hold uses its reason.
       */
      flag: {
        missing_required_field: "missing field",
        missing_recommended_field: "no county",
        obscured_no_true_coordinates: "hidden location",
        taxon_obscured_awaiting_atlas: "rare host plant",
        locality_format: "locality",
        place_unabbreviated: "place abbreviation",
        place_unrecognised: "unknown state",
        coordinate_uncertainty: "accuracy",
        coordinate_out_of_region: "out of region",
        non_tracheophyte_host: "host plant",
        duplicate_sample_number: "duplicate number",
        count_mismatch: "specimen count",
        count_below_printed: "count below labels",
        within_sample_disagreement: "identifications differ",
        observation_missing_upstream: "observation gone",
        staff_hold: "held by staff",
      },
      /** What missing_required_field's details name, in the chip's words. */
      flagMissing: {
        location: "no location",
        country: "no country",
        state_province: "no state",
        locality: "no locality",
        protocol: "no method",
      } as Record<string, string>,
      /** For screen readers and the hover text: colour alone cannot say it. */
      flagSeverity: { blocking: "Blocks printing", warning: "Heads-up" },
      flagMore: (count: number) => `+${n(count)} more`,
      /** In a flag's panel: its details, how far over a limit and the like, are on the sample's page. */
      flagSeeSample: "See the sample",    },

    paging: {
      page: (page: number, pages: number) => `Page ${n(page)} of ${n(pages)}`,
      previous: "← Previous",
      next: "Next →",
    },

    /** The Download menu above a listing's table: each form the rows can be had in, and what a download holds. */
    csv: {
      menu: "Download",
      download: "Download as CSV",
      note:
        "The CSV holds exactly what these filters select, coordinates and all, in Darwin Core columns, " +
        "less any location hidden here. Where iNaturalist obscures a record, its own columns say so — worth a look before anything is republished.",
    },
  },

  /** Entering a trap sample, and editing one entered here (beeline-3vs.2). */
  trapSample: {
    newTitle: "Enter a trap sample",
    newHeading: "Enter a trap sample",
    editTitle: "Edit trap sample",
    editHeading: (sampleNumber: string) => `Edit trap sample ${sampleNumber}`,
    intro:
      "One sample is what one bottle or pooled set of bottles holds, from the day the traps were set to the day they were collected. " +
      "Its labels print once the specimens are pinned and counted.",
    notSaved: "Nothing was saved. Correct the fields marked below and save again.",
    trapCollectorNote: "has trap samples",
    fields: {
      sampleNumber: "Sample number",
      collector: "Collector",
      otherCollector: (n: number) => `Collector ${n} (optional)`,
      dateStart: "Traps set",
      dateEnd: "Traps collected",
      method: "Kind of trap",
      trapCount: "Number of traps",
      specimenCount: "Specimens",
      latitude: "Latitude",
      longitude: "Longitude",
      uncertainty: "Coordinate uncertainty (m)",
      country: "Country",
      stateProvince: "State or province",
      county: "County",
      locality: "Locality",
    },
    hints: {
      sampleNumber: "The next number in Oregon's series is filled in. Change it for another series or a trap code.",
      collector: "The first collector's name comes first on the label.",
      dateStart: "The day the traps went out.",
      dateEnd: "The day they were brought in. Leave it empty if it was the same day.",
      method: "Choose one, or write it in.",
      trapCount: "How many traps went into this sample, if you know.",
      specimenCount: "Leave at 0 until the bees are pinned and counted: a sample with no specimens prints no labels.",
      // An example in the hint, never as a placeholder: grey text in an empty box read as a value (Peter, 2026-11-04).
      latitude: "In decimal degrees, such as 44.5646.",
      longitude: "In decimal degrees, west negative, such as -123.2620.",
      uncertainty: "How far the traps could be from this point.",
      stateProvince: "The two-letter code: OR, WA, BC.",
      county: "Beeline writes the county from the coordinates each night, so this can be left empty.",
      locality: "As the label should print it.",
    },
    create: "Enter sample",
    save: "Save changes",
    cancel: "Cancel",
    enterLink: "Enter a trap sample",
    edit: "Edit trap sample",
    notAllowedHeading: "Trap samples are entered by people who handle them",
    notAllowed: "Trap samples are entered by staff and by people who have collected trap samples before.",
    notEditableHeading: "This sample can no longer be changed here",
    notEditable: "This sample's labels are printed or about to print, so it can no longer be changed here. Ask staff to correct it.",
  },

  sampleEdit: {
    title: "Edit sample",
    heading: (sampleNumber: string) => `Edit sample ${sampleNumber}`,
    intro:
      "This sample has no iNaturalist observation, so corrections are made here. " +
      "Saved changes take effect immediately and are recorded with your name.",
    fields: {
      locality: "Locality",
      country: "Country",
      state_province: "State / province",
      county: "County",
      protocol: "Sampling protocol",
    } as Record<string, string>,
    noteLabel: "Note (optional)",
    noteHint: "Reason for this change (optional)",
    save: "Save changes",
    cancel: "Cancel",
    notEditable: "This sample cannot be edited here. It may belong to another collector, or must be edited directly on iNaturalist.",
    /** The error page's heading for that refusal: "There's nothing here" would contradict it. */
    notEditableHeading: "This sample cannot be edited here",
    noStagingRows: "This sample has no underlying records to correct. Please contact staff for assistance.",
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
      hint: "Every change recorded for this sample, newest first: an edit made here, an update from iNaturalist, or the import from old Beeline.",
      empty: "No changes yet. Changes to this sample will be listed here.",
      colWhen: "When",
      colWhat: "What",
      colChange: "Change",
      colWho: "Who",
      /** Shown beside the author of a change that came through the API rather than a page. */
      viaApi: "through the API",
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
        protocol: "Method",
        sampling_effort: "Sampling effort",
        host: "Floral host",
        atlas: "Atlas",
        atlas_assigned_by: "Atlas assigned by",
        co_collectors: "Co-collectors",
        hold: "Held back from printing",
        waivers: "Waived flags",
        collector: "Collector",
        sample_number: "Sample number",
        date_start: "Start date",
      },
      source: {
        app: "staff",
        api: "the API",
        legacy_promotion: "the import from old Beeline",
        observation_promotion: "iNaturalist",
        reconcile: "found at startup",
        /** The county written from the sample's coordinates (beeline-313x). */
        coordinates: "its coordinates",
      },
    },
    notYours: "Someone else collected this sample.",

    sample: {
      title: (sampleNumber: string) => `Sample ${sampleNumber}`,
      back: "← All samples",
      collectors: "Collected by",
      collected: "Collected",
      method: "Method",
      methodNet: "Net",
      methodTrap: "Trap",
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
      /**
       * The coordinates lie inside a federal wilderness (beeline-zdfz). A
       * note, not a flag: it blocks nothing (Peter, 2026-10-26). Permits are
       * not tracked, so it says that one is needed and not whether the
       * program had one: inside Olympic it did. `names` is already a list.
       */
      inWilderness: (names: string) => `Inside the ${names}. Collecting in a federal wilderness needs a permit.`,
      /** The EPA Level III ecoregion the coordinates lie in (beeline-l5so): a fact, not a note. */
      inEcoregion: (name: string) => `${name} ecoregion`,
      /** The program the sample was collected for (beeline-8w8n): its atlas, else Master Melittology itself. */
      program: "Program",
      host: "Floral host",
      observation: "iNaturalist observation",
      /** Trap samples usually have none, and that is not a gap. */
      observationNone: "None. This sample is not linked to an iNaturalist observation, so it is corrected here in Beeline.",
      /**
       * Beside the id, unlinked, where iNaturalist has never given Beeline
       * the observation and, asked for it, answered without it
       * (beeline-wcc6). "Deleted" is the likely reading rather than a
       * certainty, so it is said as one.
       */
      observationGone: (since: Date | string) =>
        `Not found on iNaturalist since ${date(since)}: it has most likely been deleted.`,
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
       * A locality set in Beeline over the observation's (beeline-649,
       * beeline-7i6). The provenance lines sit under the place, in the same
       * voice as asRecorded: what stands, who said so, and what iNaturalist
       * says now where that has moved on. It is changed from the Place row's
       * pencil, where iNaturalist's own name is one of the choices.
       */
      staffLocality: {
        setBy: (name: string) => `Locality set in Beeline by ${name}.`,
        setByStaff: "Locality set in Beeline by staff.",
        because: (reason: string) => `Reason: ${reason}`,
        observationNow: (text: string) =>
          `iNaturalist now gives “${text}” for this observation. The locality set in Beeline is kept until someone chooses iNaturalist's instead.`,
      },
      /**
       * Staff set the coordinates (beeline-942), on the same terms as the
       * locality. The case that matters most is an obscured observation
       * with no trusted access: it yields no coordinates, cannot print, and
       * only a person who knows where the bees were caught can say. Changed
       * from a pencil on the Coordinates row, as the place is (beeline-8w8n).
       */
      /**
       * Staff correcting how a sample from old Beeline was collected,
       * from a pencil on the Method row (beeline-p8y1).
       */
      methodEdit: {
        /** The pencil, for a screen reader: it has no visible words. */
        open: "Correct how this sample was collected",
        hint: "Old Beeline holds records of this sample. A correction here is recorded against those records, with your name.",
        protocol: "Method, in the record's words",
        protocolHint: "For example, pan traps, blue vane traps or aerial net.",
        dateEnd: "Collecting ended",
        dateEndHint: "Give the day the traps came in to make this a trap sample. Leave it blank for a net sample collected on one day.",
        note: "Reason (optional)",
        save: "Save",
        problems: {
          date: "The end date is not a date Beeline can read.",
          before_start: "Collecting cannot end before the day it started.",
          future: "Collecting cannot end on a day that has not come yet.",
        },
        noOldRecords: "Old Beeline holds no records of this sample, so it cannot be corrected here.",
        conflict: "Someone changed this sample's method or dates after you opened the form. Reload the page to see what they saved, then make your correction again.",
      },
      staffCoordinates: {
        setBy: (name: string) => `Coordinates set in Beeline by ${name}.`,
        setByStaff: "Coordinates set in Beeline by staff.",
        because: (reason: string) => `Reason: ${reason}`,
        observationNow: (lat: number, lon: number) =>
          `iNaturalist now puts this observation at ${lat}, ${lon}. The coordinates set in Beeline are kept until someone chooses to follow iNaturalist again.`,
        /** The pencil, for a screen reader: it has no visible words. */
        open: "Change the coordinates",
        hint: "Coordinates set here are treated as the true location and replace the observation's, even when iNaturalist updates. The elevation is recalculated overnight.",
        printed: "This sample's labels are already printed. Changing the coordinates here does not change the printed labels.",
        noObservation: "Coordinates can only be set here on a sample with an iNaturalist observation.",
        latitude: "Latitude",
        longitude: "Longitude",
        uncertainty: "Accuracy, in meters (optional)",
        save: "Save",
        remove: "Follow iNaturalist again",
        /** After a save whose county and state could not be set from the new point at once (beeline-1kb.17.1). */
        placePending:
          "Beeline could not set the county and state from these coordinates just now, so they may not match. Check them before reprinting this sample's labels.",
        /** Refused while the overnight sync runs, which would undo or race the change. */
        busy: "Beeline is syncing with iNaturalist right now. Try again once it has finished.",
      },
      /**
       * Staff taking iNaturalist's location for a sample Beeline printed,
       * after the collector moved the pin (beeline-1kb.17.1, GitHub #298).
       * Says what moved and by how much, and leaves the reprint to staff:
       * either side may be the wrong one, and a reprint is always chosen.
       */
      takeObservationLocation: {
        lead: (lat: number, lon: number, place: string | null, distance: string) =>
          `iNaturalist now puts this observation at ${lat}, ${lon}${place === null ? "" : ` (${place})`}, ${distance} from the coordinates above, which its labels were printed with.`,
        then: "If iNaturalist is right, use its location here. That sets the county and state from it too. Then mark the labels for reprint.",
        note: "Note (optional)",
        noteHint: "Saved with the change, for whoever reads this sample's history.",
        action: "Use iNaturalist's location",
        reason: "Taken from the iNaturalist observation, which was moved after the labels printed.",
        notMoved: "iNaturalist no longer puts this sample anywhere else, so there is nothing to take.",
        unavailable: "This can't be done right now. Try again in a minute.",
      },

      where: {
        heading: "Where it was collected",
        /**
         * Said instead of the coordinates, the elevation and the locality on
         * somebody else's sample whose observation iNaturalist keeps from
         * everyone but its observer — and which of the two kept it, since
         * one is the collector's choice and the other is about a rare plant.
         */
        withheld: (why: { geoprivacy: string | null; taxonGeoprivacy: string | null; gone: boolean }) =>
          // Before "not read yet", which would promise a read that cannot
          // come: the observation is no longer on iNaturalist (beeline-wcc6).
          why.gone
            ? "Beeline cannot find this sample's observation on iNaturalist, so it cannot tell whether the collector kept its location private there. Only its collectors and staff see where it was collected."
            : why.geoprivacy === null && why.taxonGeoprivacy === null
            ? "Beeline has not read this sample's observation from iNaturalist, so it cannot tell whether the collector keeps its location private there. Until it can, only its collectors and staff see where it was collected."
            : why.geoprivacy !== null
            ? `The collector keeps this observation's location ${why.geoprivacy === "private" ? "private" : "obscured"} on iNaturalist, so only its collectors and staff see where it was collected.`
            : `iNaturalist ${why.taxonGeoprivacy === "private" ? "hides" : "obscures"} this observation's location because its host plant is rare, so only its collectors and staff see where it was collected.`,
        coordinates: "Coordinates",
        /**
         * Absence is a statement here, not a blank: shifted coordinates are
         * deliberately never brought across, so "none" means none believed.
         */
        coordinatesNone:
          "Beeline has no coordinates for this sample. Beeline records only true coordinates, so where iNaturalist shifts an observation's location for privacy, the shifted location is not used.",
        accuracy: "Accuracy",
        accuracyValue: (metres: number) => `within ${n(metres)} m`,
        source: "Source",
        sources: {
          inat_trusted:
            "From the iNaturalist observation, read with the collector's permission, so these are the true coordinates even where iNaturalist's public map shifts them.",
          inat_public: "From the iNaturalist observation, which shows them publicly as they are.",
          legacy_import:
            "Imported from old Beeline, which did not record where its coordinates came from. These are the coordinates printed on the labels.",
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
          "The collector set this observation to obscured on iNaturalist, so its public map shows a shifted location. The coordinates above are the true location.",
        privacyPrivate:
          "The collector set this observation to private on iNaturalist, so its public map shows no location. The coordinates above are the true location.",
        privacyTaxonObscured:
          "iNaturalist shifts this observation's public location automatically because its host plant is rare. The coordinates above are the true location.",
        privacyTaxonPrivate:
          "iNaturalist hides this observation's public location automatically because its host plant is rare. The coordinates above are the true location.",
        elevation: "Elevation",
        elevationValue: (metres: number) => `${n(metres)} m`,
        /** Derived from the coordinates, so never anyone's gap to fill. */
        elevationNone: "Not calculated yet. Elevation is worked out from the coordinates overnight.",
        elevationFrom: (source: string) => `Read from ${source}.`,
        elevationStale: "Calculated for earlier coordinates. It will be recalculated overnight.",
      },

      flags: {
        heading: "Flags",
        clean: "Nothing is flagged on this sample.",
        onSpecimen: (fieldNumber: string) => `on specimen ${fieldNumber}`,
        onOneSpecimen: "on one of its specimens",
      },
      /**
       * Staff decisions over the flags (beeline-plu, beeline-1kb.9). A hold
       * keeps a sample from printing; a waiver lets a blocking flag staff
       * judged fine print anyway. Waivers are shown to everyone who sees the
       * flags, so the collector knows why a flag stopped asking.
       */
      qcDecisions: {
        waivedHeading: "Waived flags",
        waivedBy: (name: string) => `Waived by ${name}.`,
        waivedByStaff: "Waived by staff.",
        flagSaid: (text: string) => `When it was waived, the flag said “${text}”.`,
        because: (reason: string) => `Reason: ${reason}`,
        noLongerApplies:
          "This waiver no longer applies, because the flag's details have changed since it was waived. If the flag still applies, it is listed above.",
        waive: "Waive this flag",
        waiveHint:
          "For staff. The flag stops blocking printing until its details change. Say why: the collector and whoever prints will see your reason.",
        reason: "Why",
        waiveSave: "Waive",
        removeWaiver: "Remove the waiver",
        holdHeading: "Hold back from printing",
        holdHint:
          "For staff. A held sample is left out of new print runs until an admin lifts the hold, even if the collector fixes the record. If it is already in a prepared run, that run's page says so. The collector and whoever prints will see your note.",
        holdPrinted: "Its labels are already printed, so a hold only matters if more specimens are added.",
        heldBy: (name: string) => `Held by ${name}.`,
        heldByStaff: "Held by staff.",
        hold: "Hold",
        liftNote: "Note (optional)",
        lift: "Lift the hold",
        noObservation: "This sample has no iNaturalist observation, so it cannot be held or have flags waived.",
      },

      specimens: {
        heading: "Specimens",
        count: (total: number) => `${n(total)} ${total === 1 ? "specimen" : "specimens"}`,
        none: "No specimens yet. A specimen becomes its own record when its label is printed.",
        /** The working count and the printed rows can honestly disagree. */
        counted: (expected: number, printed: number) =>
          `The sample's specimen count is ${n(expected)}, and ${n(printed)} of them ${printed === 1 ? "has" : "have"} printed labels so far.`,
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
          /** Under the state: a reprint someone asked for that no run has taken yet (gh-218). */
          reprintRequested: "reprint requested",
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
      identifyPrompt: "No volunteer has named this specimen yet.",
      identifyLink: "Identify your specimens",
      fieldNumberNone:"Not numbered — this specimen's label predates field numbering.",
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
      /**
       * What became of the pin, where a staff inventory has said
       * (specimen_disposition, beeline-fud5): the 2025 boxes were gone
       * through in the autumn of 2026, and every record found wanting got a
       * remark. Also what the old Beeline's records leave in doubt about a
       * specimen of an earlier year, stated by Beeline (beeline-iuva). Shown
       * only on a specimen that has one.
       */
      disposition: {
        heading: "The pin",
        state: "Where it is",
        inCollection: "In the collection",
        missing: "Missing: no pin with this label was found",
        remarks: "Remarks",
        statedBy: (name: string, date: string) => `Stated by ${name}, ${date}.`,
      },
      /** Every time a label for this specimen went into a print run (schema/035). */
      labels: {
        heading: "Labels",
        intro:
          "Every print run that prepared a label for this specimen, and how far each run got. If the label was printed more than once, the most recent one is correct.",
        /** An imported specimen: printed, but by the old system, so there is no run to show. */
        legacy: "Printed by old Beeline, so there is no print run to show.",
        colRun: "Print run",
        /** As printed, or as it would have: a canceled run's number lives on only here. */
        colNumber: "Number",
        colState: "State",
        colSheet: "Sheet · cell",
        colPrepared: "Prepared",
        colPrinted: "Printed",
        colMailed: "Mailed",
        notYet: "not yet",
        /** Beside a run whose label was a second print under the same number (gh-218). */
        reprint: "reprint",
        requestedBy: (name: string, reason: string | null, note: string | null) =>
          `Asked for by ${name}${reason === null ? "" : `: ${reason.toLowerCase()}`}${note === null ? "" : ` — ${note}`}.`,
      },
      /** Asking for this label again (gh-218): the form is for staff, the state for everyone. */
      reprint: {
        heading: "Reprint",
        pending: (name: string, when: string) => `${name} asked on ${when} for this label to be printed again. It goes into the next print run, under the same field number.`,
        because: (reason: string) => `Reason: ${reason}.`,
        noteSaid: (note: string) => `Note: ${note}`,
        /** A flag no waiver can set aside stops it, as it would stop a new label: a hold, a missing field, a hidden point. */
        waiting: "It will wait while the sample has a flag that blocks printing (shown beside the sample below).",
        hint: "For staff. The label is printed in the next print run, after that run's new labels, with the field number it already has and the record as it stands then.",
        reason: "Reason",
        noReason: "No reason given",
        note: "Note (optional)",
        button: "Reprint this label",
        withdraw: "Take back the reprint",
        /** Why there is no form: there is nothing to print, or a run is about to print it. */
        cannotUnnumbered: "This specimen has no field number, so there is no label to reprint.",
        cannotPrinting: "A print run that has not printed yet already holds a label for this specimen. To change that label, cancel the run.",
      },
    },

    determinations: {
      heading: "Determinations",
      intro:
        "Every identification of this specimen, newest first. A new identification never erases an earlier one.",
      /**
       * Stated whenever there is a history to read, because the rule is not
       * guessable from the rows: determination_of_record is not simply the
       * newest (schema/110).
       */
      recordRule:
        "The identification marked “current” is the one Beeline uses, as Ecdysis does: the most recent by an expert, or the most recent of all if no expert has identified the specimen.",
      recordNotNewest:
        "An expert determination stays current until another expert revises it. A later volunteer identification does not replace it.",
      empty: "Nobody has identified this specimen yet.",
      colDetermination: "Determination",
      colDeterminer: "Determined by",
      colDetermined: "Determined",
      colRecorded: "Added to Beeline",
      /** The status column carries the chip and needs no heading. */
      colStatus: "",
      /** Ecdysis's word for the determination in use (Peter, 2026-11-06), and the plainer one to a volunteer. */
      ofRecord: "current",
      expert: "expert",
      determinerUnknown: "not recorded",
      determinedUnknown: "date not recorded",
      /** The name as the source wrote it, kept beside the node it resolved to. */
      verbatim: (text: string) => `written as “${text}”`,
      /** Female and male read plainly on their own; anything else says what it is. */
      sex: (value: string) => (value === "female" || value === "male" ? value : `sex ${value}`),
      caste: (value: string) => `caste ${value}`,
      /** How the determination reached Beeline, in a volunteer's words. */
      channels: {
        in_app: "entered here",
        ecdysis_import: "imported from Ecdysis",
        legacy_import: "imported from old Beeline",
        worksheet_import: "imported from a determination worksheet",
      } as Record<string, string>,
    },
  },

  /**
   * Naming your own specimens (beeline-bcq). Written for a volunteer who has
   * never read a glossary: plain verbs ("name", "tick"), the program's one
   * technical word — determination — introduced once and linked, and the
   * overnight commit said as what it means to them: you can change today's
   * entries until tonight.
   */
  determine: {
    title: "Identify your specimens",
    lede: "Enter identifications for your pinned specimens. Identify each specimen as far as you are certain, such as to genus or family.",
    /** The glossary link after the lede. */
    aboutDetermination: "More about determinations.",
    /**
     * The overnight commit, said as what it means to the person: undo is free
     * until 1am; after that a change is still possible and is kept beside the
     * earlier name. And why expert names are missing, so nobody thinks an
     * expert's work was lost.
     */
    tonight:
      "Changes save automatically. Entries made today can be undone until 1am Pacific. " +
      "After 1am, an updated identification is saved as a new determination, and the earlier entry is preserved in the specimen's history.",
    experts:
      "Identifications from experts are not shown here to encourage independent determination. They remain recorded on each specimen's page.",
    readOnly: "You're viewing this as someone else, so nothing here can be changed.",
    /**
     * The screen says "collection year" for what the code calls a season,
     * the calendar year of a sample's first day: to a volunteer "season"
     * reads as spring or summer (Karla Salp, 2026-11-13, beeline-mjml).
     */
    season: "Collection year",
    /** Only without script, beside the season menu. */
    seasonGo: "Show",
    seasonOption: (season: number, unnamed: number) =>
      unnamed === 0 ? String(season) : `${season} · ${n(unnamed)} to name`,
    empty: "You have no specimens yet. A specimen appears here once its label has been printed.",
    emptySeason: "No specimens from this year.",
    mode: {
      label: "Work through",
      bySample: "By collection year",
      batch: (count: number) => `By field number (${n(count)})`,
    },
    jump: {
      label: "Go to field number",
      placeholder: "26019685, or its last few digits",
      /** Said once the row is found and selected: the row also flashes, which a screen reader cannot see. */
      found: (fieldNumber: string) => `Selected ${fieldNumber}.`,
      /** Said while the box looks for a number in the other years, before the page moves there. */
      looking: (typed: string) => `${typed} isn't among these. Looking in your other years…`,
      lookupFailed: "Couldn't look in your other years. Check your connection, then try again.",
      /**
       * Found in another year while rows here are ticked. Opening that year
       * loads a new page, which clears the ticks, so the screen asks first.
       */
      elsewhere: (typed: string, season: number) =>
        `${typed} is among your ${season} specimens. Opening that year clears what you've ticked here. To name specimens from different years together, add them to your list under By field number.`,
      open: (season: number) => `Open ${season}`,
      /** Found in another year, but a change here has not saved, so the page stays. */
      unsaved: (typed: string, season: number) =>
        `${typed} is among your ${season} specimens, but a change here hasn't saved. Try it again, then look for ${typed} again.`,
    },
    batch: {
      lede:
        "Gather specimens from any year by their field numbers. " +
        "They're listed in the order you add them, and your list is kept until you clear it.",
      /** How to write numbers, under the box. */
      hint:
        "Separate numbers with commas. A range can end in just its last digits: 26019685-697 means 26019685 to 26019697. " +
        "If only one of your numbers ends in 412, 412 is sufficient.",
      add: "Add field numbers",
      addButton: "Add",
      placeholder: "26019685-697, 26027608 — or scan each label",
      empty: "Your list is empty. Add field numbers above, or tick rows under By collection year and add them from there.",
      added: (count: number) => `Added ${n(count)}.`,
      addedSome: (added: number, already: number) =>
        `Added ${n(added)}; ${n(already)} ${already === 1 ? "was" : "were"} already in your list.`,
      alreadyOne: (fieldNumber: string) => `${fieldNumber} is already in your list.`,
      alreadyAll: (count: number) => `All ${n(count)} are already in your list.`,
      dismiss: (text: string) => `Dismiss ${text}`,
      emptyBatch: "Clear the list",
      remove: (fieldNumber: string) => `Remove ${fieldNumber} from the list (its name stays)`,
    },
    /** Why a field number someone typed found nothing. */
    problem: {
      notNumber: "That isn't a field number.",
      ambiguous: (typed: string, count: number, examples: readonly string[] | string) => {
        // A plain string passes through, for the proofing page's «sample» placeholders.
        const some = Array.isArray(examples) ? examples : [String(examples)];
        return `${n(count)} of your field numbers end in ${typed} (${some.join(", ")}${count > some.length ? "…" : ""}). Type more of it.`;
      },
      digits: (typed: string, spans: string) => `${typed} has ${typed.length} digits. ${spans}`,
      /** A number one digit short of the person's newest: almost always a dropped digit. */
      digitsShort: (typed: string, digits: number, example: string) =>
        `${typed} has ${typed.length} digits. Is one missing? Your newest have ${n(digits)}, like ${example}.`,
      notTheirs: (typed: string, spans: string) => `${typed} isn't one of your field numbers. ${spans}`,
      rangeStart: (inner: string) => `A range has to start at one of your field numbers. ${inner}`,
      backwards: "That range runs backwards. Put the lower number first.",
      tooLong: (max: number) => `That range covers more than ${n(max)} numbers. Is a digit missing, or one too many?`,
      lengthsDiffer: (start: string, end: string) => `${start} and ${end} have different numbers of digits. Is one missing?`,
      emptyRange: (spans: string) => `None of your field numbers fall in that range. ${spans}`,
      /** A range written one digit short of the person's newest numbers: almost always a dropped digit. */
      digitMissing: (digits: number, example: string) =>
        `None of your field numbers fall in that range. Is a digit missing? Your newest have ${n(digits)} digits, like ${example}.`,
      noSpecimens: "You have no specimens with field numbers yet.",
      /** What their numbers look like, so a dropped or doubled digit shows. One span or several, by length. */
      spans: (spans: readonly { digits: number; first: string; last: string }[] | string) =>
        typeof spans === "string"
          ? spans
          : spans.length === 1
          ? `Yours run from ${spans[0]!.first} to ${spans[0]!.last}.`
          : `Yours run ${list(spans.map((s) => `${s.first} to ${s.last} (${s.digits} digits)`))}.`,
    },
    bulk: {
      none: "Select rows to identify multiple specimens at once. Hold Shift to select a block.",
      ticked: (count: number) => `${n(count)} selected`,
      namePlaceholder: (count: number) => (count === 0 ? "Name them…" : count === 1 ? "Name it…" : `Name all ${n(count)}…`),
      named: (count: number, name: string) => `Named ${n(count)} ${name}.`,
      sexSet: (count: number) => `Set the sex of ${n(count)}.`,
      undo: "Undo",
      untick: "Clear selection",
      addToBatch: "Add to list",
      removeFromBatch: "Remove from list",
      sexLabel: "Sex of the selected specimens",
      /** The name box in the bar, for a screen reader: its grey text changes with the count and is not a label. */
      nameLabel: "Name for the selected specimens",
    },
    table: {
      tickAll: (count: number) => `Select all ${n(count)} shown`,
      tickSample: "Select every specimen in this sample",
      tick: (fieldNumber: string) => `Select ${fieldNumber}`,
      position: "#",
      fieldNumber: "Field number",
      sample: "Sample",
      name: "Identified as",
      sex: "Caste",
      saved: "Entered",
      sampleHeading: (sampleNumber: string, when: string) => `Sample ${sampleNumber} · ${when}`,
      onHost: "on",
      viewOnInat: "View on iNaturalist",
      addName: "Add a name",
      /** What a screen reader calls one row's name button, name box and caste buttons, so rows can be told apart by ear. */
      addNameTo: (fieldNumber: string) => `Add a name to ${fieldNumber}`,
      changeName: (name: string, fieldNumber: string) => `${name}: change the name of ${fieldNumber}`,
      nameOf: (fieldNumber: string) => `Name of ${fieldNumber}`,
      sexOf: (fieldNumber: string) => `Caste of ${fieldNumber}`,
      /** A specimen whose label never carried a field number, or whose number a canceled print run took back. */
      noNumber: "no field number",
      showMore: (more: number, left: number) => `Show ${n(more)} more (${n(left)} left)`,
    },
    /** The Saved column. */
    saved: {
      today: "Today",
      todayHint: "You can undo this entry until 1am Pacific.",
      undo: "Undo",
      undoHint: "Revert to what this said before today",
      on: (when: string) => when,
      beforeBeeline: "Old system",
      nothing: "nothing entered",
      saving: "Saving…",
      failed: "Not saved",
      retry: "Try again",
    },
    /** The column is "Caste" and a queen is a gyne, the museum databases' words (Peter, 2026-10-31). */
    sex: {
      label: "Caste",
      female: "Female",
      male: "Male",
      queen: "Gyne",
      worker: "Worker",
      drone: "Drone",
      /** Why some rows offer gyne and worker. */
      castesHint: "Bumble bees and honey bees: gyne, worker or drone",
    },
    picker: {
      placeholder: "Type a name (such as Bombus or Osmia)",
      noBees: "No bee name matches.",
      noNames: "No name matches.",
      bycatch: "Include wasps and other non-bees",
    },
    saveFailed: "That didn't save. Check your connection, then try again.",
  },

  /**
   * The pages a request gets when it fails or finds nothing (beeline-0kj).
   * Written for a volunteer who has never seen a status code: what happened,
   * that it is not their fault where it isn't, what to do next. The
   * not-found page never says whether a record is missing or merely not
   * theirs — record pages answer both the same way so a URL cannot be used
   * to probe — and the failure page never says what failed, because the
   * error's own words come from the database and quote record values.
   */
  errorPage: {
    notFound: {
      title: "Page not found",
      heading: "There's nothing here",
      body:
        "This page does not exist, or it holds records you do not have permission to view. " +
        "If a link in Beeline brought you here, send feedback so staff can fix it.",
    },
    failed: {
      title: "Something went wrong",
      heading: "Something went wrong",
      body:
        "Beeline ran into a problem and couldn't show this page. It wasn't anything you did. " +
        "Try again in a minute. If it keeps happening, send feedback and include the reference below: it helps us find the problem.",
      reference: (reference: string) => `Reference: ${reference}`,
    },
    /**
     * Served by the machine while it is in maintenance mode (src/app/maintenance.ts):
     * the app is stopped so staff can work on the store, and nothing can be
     * looked up, not even who is asking.
     */
    maintenance: {
      title: "Down for maintenance",
      heading: "Beeline is down for maintenance",
      body: "Staff are working on Beeline and it will be back shortly. Please try again in a few minutes.",
    },
    back: "Go back",
    home: "Go to your front page",
    /** Shown in development only: the error itself, and a hint where it looks like a store behind its migrations. */
    dev: {
      heading: "The error (shown in development only)",
      staleStore: "This looks like a store behind the schema. Check it with pnpm db:migrate --status.",
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
   * determined to, and how each stands in Ecdysis's list of names
   * (beeline-7gob; ITIS until 2026-10-23). Read by everyone, like the
   * glossary, so written for a volunteer who has never opened Ecdysis.
   * Curation will land on these same pages.
   */
  taxonomy: {
    title: "Taxonomy",
    intro:
      "The taxonomic names applied to specimens, organized under the program's taxonomy, and their status in the Ecdysis museum database.",
    aboutEcdysis: "More about Ecdysis.",
    fetched: (on: Date | string) => `Checked against Ecdysis's names as of ${date(on)}.`,
    notLoaded: "Ecdysis's names have not been loaded here, so nothing on these pages says how a name stands there.",
    /** Every name in the tree, one row each, in the order the pages browse it. */
    csv: "Download CSV",
    /** The counts above the filter, each linking to the list it counts. */
    summary: {
      accepted: (count: number) => `${n(count)} accepted in Ecdysis`,
      synonym: (count: number) => `${n(count)} outdated`,
      homonym: (count: number) => `${n(count)} ambiguous`,
      absent: (count: number) => `${n(count)} not in Ecdysis`,
      /** Names a taxonomist has decided about, and the ones Ecdysis has since moved from under. */
      decided: (count: number) => `${n(count)} decided by a taxonomist`,
      moved: (count: number) => `${n(count)} to look at again`,
    },
    search: "Name",
    searchHint: "Any part of a scientific name.",
    standingLabel: "In Ecdysis",
    standingOptions: {
      any: "Any",
      accepted: "Accepted",
      synonym: "Outdated",
      homonym: "Ambiguous",
      absent: "Not in Ecdysis",
    },
    decidedLabel: "Taxonomist's decision",
    decidedOptions: {
      any: "Any",
      decided: "Decided",
      moved: "To look at again",
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
    colEcdysis: "Ecdysis",
    colSpecimens: "Specimens",
    /** A row speaks about Ecdysis only when the name is not simply accepted there. */
    chip: {
      synonym: "Outdated",
      homonym: "Ambiguous",
      absent: "Not in Ecdysis",
      /** A name a taxonomist has decided about says so instead, in the decision's words. */
      decided: {
        addition: "Kept beyond Ecdysis",
        departure: "Kept against Ecdysis",
        homonym: "Chosen",
      },
    },
    nowCalled: "Ecdysis uses:",
    specimens: (count: number) => `${n(count)} ${count === 1 ? "specimen" : "specimens"}`,
    /** Under a name's count, when nothing below it was counted. */
    counted: "Counted by current determination.",
    /** Under a name's count, which includes everything filed below it. */
    determinedHere: (count: number, rank: string) =>
      `Counted by current determination, including everything filed below. ${n(count)} ${count === 1 ? "is" : "are"} determined to this ${rank} and no finer.`,
    seeSpecimens: "See these specimens",
    /**
     * The reader's own specimens of the name, by where they were collected
     * and off which plant (beeline-nstp). Only ever the reader's, so "you".
     */
    yours: {
      heading: "Yours",
      /** "You collected 108 of them.", the count linked to the specimen listing at My records. */
      collected: "You collected",
      /** "Them" is the specimens the page counts, so it stays plural when the reader has one. */
      ofThem: (count: number) => `${n(count)} of them`,
      from: (count: number, where: string) => `${n(count)} from ${where}`,
      nowhere: (count: number) => `${n(count)} with no place recorded`,
      off: "off",
      inSeasons: (seasons: readonly string[]) => `in ${list(seasons)}`,
      /** The places and plants past the first few, folded away, the fewest specimens last. */
      more: (count: number) => `${n(count)} more ${count === 1 ? "place or plant" : "places and plants"}`,
      notListed: (count: number) => `${n(count)} more, each with fewer specimens, are not listed here.`,
    },
    below: "Filed below",
    nothingBelow: "Nothing is filed below this name.",
    /** One name's standing, said in full on its own page. */
    standing: {
      accepted: "An accepted name in Ecdysis.",
      synonym: "Ecdysis classifies this name as outdated. The accepted name in Ecdysis is:",
      homonym:
        "Ecdysis has more than one accepted name spelled this way, from different authors, and nothing recorded here says which one this is:",
      absent: (rank: string) =>
        `Ecdysis has no ${rank} with this spelling. This includes names not yet in Ecdysis, alternative program treatments, and misspellings.`,
      report: (tid: string) => `Ecdysis taxon ${tid}`,
    },
    /** What the program has decided about a name against Ecdysis, and on whose word (beeline-45v.1). */
    decision: {
      addition: "The program keeps this name, which Ecdysis does not have.",
      departure: "The program keeps this name under its own treatment. Ecdysis files it under:",
      homonym: (author: string | null) =>
        author === null
          ? "Of Ecdysis's names spelled this way, the program has said which one it means."
          : `Of Ecdysis's names spelled this way, the program means the one by ${author}.`,
      by: (taxonomist: string, decidedOn: Date | string, fetchedOn: Date | string) =>
        `Decided by ${taxonomist}, ${date(decidedOn)}, against Ecdysis's names as of ${date(fetchedOn)}.`,
      reference: "Reference:",
      /** Before what animal_curation_stale says has moved since the decision. */
      moved: "Ecdysis has changed since.",
    },
    notFound: "There is no such name in the taxonomy.",
  },

  /** Photographs in a row (PhotoCarousel), as a program's page shows them. */
  photos: {
    label: "Photos",
    credit: (name: string) => `Photo: ${name}`,
    previous: "Previous photo",
    next: "Next photo",
  },

  /**
   * The programs (beeline-rrit): a listing, and a page for each, read by
   * everyone signed in. The counts link into the listings for staff only,
   * since a volunteer's listings hold only their own records.
   */
  programs: {
    title: "Programs",
    intro:
      "The programs Beeline keeps records for: each bee atlas, which holds the records collected on its ground; Master Melittology, which holds those collected where no atlas reaches; and the BLM surveys.",
    colProgram: "Program",
    colLeads: "Led by",
    colMembers: "Members",
    colSamples: (season: number) => `Samples in ${season}`,
    colSpecimens: "Specimens, every season",
    noLeads: "no lead recorded",
    notMembership: "not recorded",
    notFound: "There is no program with that code.",
    /** The header line under the name. */
    meta: (code: string, atlas: boolean) => (atlas ? `${code} · a bee atlas` : code),
    summary: "At a glance",
    members: "Members",
    membersLink: (count: number) => `${n(count)} ${count === 1 ? "person" : "people"}`,
    collectors: (season: number) => `Collectors in ${season}`,
    samples: (season: number) => `Samples in ${season}`,
    specimens: (season: number) => `Specimens in ${season}`,
    specimensEver: "Specimens, every season",
    contact: "Contact",
    leads: "Led by",
    website: "Website",
    email: "Email",
    emailNone: "none recorded yet",
    /** The staff form under the contact details. */
    emailField: "The program's email address",
    emailHint: "The address the program gives people for questions. Leave it empty to remove it.",
    emailSet: (login: string, when: string) => `Set by ${login}, ${when}.`,
    emailSave: "Save address",
    labels: "Labels",
    printsOwn: "Prints its own labels, in print runs prepared for it alone.",
    printedByProgram:
      "Does not print its own labels: they are printed in the program's print runs, which Oregon prepares for every atlas that does not print its own.",
    seasons: "Records by season",
    colSeason: "Season",
    colSeasonSamples: "Samples",
    colSeasonSpecimens: "Specimens",
    colSeasonCollectors: "Collectors",
    season: (year: number) => `${year} season`,
    noRecords: "No records yet.",
    /** A program with no ground: why it has no records by geography, in its own terms. */
    noGround: (code: string) =>
      code === "BLM"
        ? "None by where they were collected: survey samples will come in through the surveys' own field entry, and belong to them by the day they were collected on rather than by where they fell."
        : code === "NWR"
          ? "None by where they were collected: refuge samples come in through their atlases' iNaturalist projects and print with their atlases, and belong to the program by the refuge they were collected in, which Beeline does not yet record."
          : "None by where they were collected: this program has no ground of its own, and which samples are its is not yet recorded.",
    seeSamples: "See its samples",
    seeSpecimens: "See its specimens",
    ecdysis: "Expert determinations",
    ecdysisDataset: (datasetId: number) =>
      `Read back every night at 3am Pacific from Ecdysis, the museum database, dataset ${datasetId}.`,
  },

  /**
   * A person's own API keys (/keys, beeline-pnqr.1). Anyone may see their keys
   * and revoke them; making one is staff only for now, and collectors get that
   * once the API has something for them to read. Staff also see these keys on
   * a person's page (beeline-pnqr.9).
   */
  keys: {
    title: "API keys",
    heading: "API keys",
    intro:
      "An API key lets a program of yours, such as a script or an AI assistant, ask Beeline for records as you. Anyone who has one of your keys can do what the key allows, so keep each one where only that program can read it, and revoke it when you stop using it.",
    yours: "Your keys",
    none: "You have not made a key.",
    col: {
      name: "Name",
      scope: "Allows",
      created: "Made",
      expires: "Expires",
      lastUsed: "Last used",
      reference: "Reference",
    },
    scope: {
      read: { label: "Read", means: "see the records you can see" },
      edit: { label: "Edit", means: "see the records you can see, and correct your own samples" },
      staff: { label: "Staff", means: "do what you can do as staff, for as long as you are staff" },
    },
    /**
     * Who revoked a key and why. On the owner's own page an owner's revocation
     * says only when ("Revoked 12 Nov"); a staff member's names them ("Revoked
     * 12 Nov by samstaff"), and a change of account says so ("Revoked 12 Nov
     * by samstaff: the iNaturalist account changed"). On a person's page, for
     * staff, it always says who, "by its owner" included. A key revoked before
     * the reason was kept has neither, and says only when.
     */
    revoked: (
      when: string,
      by: string | null,
      reason: "owner" | "staff" | "account_changed" | "account_gone" | null,
      audience: "owner" | "staff" = "owner",
    ) => {
      const who =
        reason === "owner" ? (audience === "staff" ? " by its owner" : "") : by === null || reason === null ? "" : ` by ${by}`;
      const why =
        reason === "account_changed"
          ? ": the iNaturalist account changed"
          : reason === "account_gone"
            ? ": the iNaturalist account is no longer linked to anyone"
            : "";
      return `Revoked ${when}${who}${why}`;
    },
    expired: (when: string) => `Expired ${when}`,
    neverUsed: "Never",
    revoke: "Revoke",
    created: {
      lead: (name: string) => `Your key "${name}" is below. Copy it now: Beeline does not keep it and cannot show it again.`,
      use: "A program sends it with each request, in a header: Authorization: Bearer followed by the key. Ask /api/v1/me to check that it works.",
    },
    problems: {
      name: "Give the key a name of up to 80 characters.",
      scope: "Choose what the key may do from the list.",
      lifetime: "Choose how long the key lasts from the list.",
      tooMany: "You have 10 working keys, which is the most Beeline allows. Revoke one you no longer use, then make the new one.",
    },
    create: {
      heading: "Make a key",
      name: "Name",
      nameHint: (max: number) => `Where you will use it, so you can tell your keys apart. Up to ${max} characters.`,
      scope: "What it may do",
      lifetime: "How long it lasts",
      lifetimeHint: "A key stops working after this, and you make a new one.",
      days: (days: number) => `${days} days`,
      submit: "Make key",
      notYet: "Making keys is not open to you yet. You can still see the keys you have made and revoke them.",
      acting: "You are acting for someone else. Keys belong to the person signed in, so stop acting for them to make or revoke a key.",
    },
  },
  exports: {
    title: "Exports",
    heading: "Exports",
    intro:
      "Files for work outside Beeline. The occurrences file has the old system's columns, in its order and format, so reports and uploads built on that file read it unchanged. It is rewritten every night at 4am Pacific; run the legacy-export job on Jobs to write it now.",
    occurrences: "Occurrences, in the old system's format",
    written: (when: string) => `Written ${when}`,
    size: (megabytes: string) => `${megabytes} MB`,
    download: "Download",
    missing: "Not written yet. It appears after the next nightly run, or after running the legacy-export job on Jobs.",
    archives: "Darwin Core archives, by program and year",
    archivesIntro:
      "Each program's specimens collected in a calendar year, as a Darwin Core archive: the columns of the specimens CSV, tab-separated, and every identification each specimen has had. A year runs from January to December, as the taxonomists count it, and a sample belongs to the year of its first day. An atlas's archive holds the specimens collected on its ground, and Master Melittology's holds those no atlas covers. Every year is written every night at 4am Pacific, so you can download and review it. Before a year is published, its program has to say under which licence its records leave it and have a privacy policy for that year; the Licence and Privacy policy columns say how far each has got. Each program also has an archive of every year together, which states a licence only when all its years share one, and a checklist covering every year: the names its specimens are identified to, with the ranks above them, how many specimens each has and in which years, as a Darwin Core checklist.",
    archivesCaution:
      "These are for running the program and for checking that GBIF's and Symbiota's tools can read what Beeline writes. Do not upload them to Ecdysis, GBIF or anywhere else until each program has settled what it publishes, under which identifiers, and which records stay embargoed. They hold collectors' names and true coordinates, including taxon-obscured ones.",
    archivesMissing:
      "Not written yet. They appear after the next nightly run, or after running the dwc-archives job on Jobs.",
    archiveNone: (code: string) =>
      code === "BLM"
        ? "No archives: survey samples will come in through the surveys' own field entry, and belong to them by the day they were collected on rather than by where they fell."
        : code === "NWR"
          ? "No archives: refuge samples are in their atlases' archives, and belong to the program by the refuge they were collected in, which Beeline does not yet record."
          : "No archives: this program has no ground of its own, and which samples are its is not yet recorded.",
    noSpecimens: "No specimens yet.",
    colYear: "Year",
    colSpecimens: "Specimens",
    colLicense: "Licence",
    colPolicy: "Privacy policy",
    colArchive: "Archive",
    noLicense: "no licence",
    noPolicy: "none yet",
    policyNoPage: "Agreed, not yet published",
    policyLink: "Read it",
    archiveLicenseNone: "This file states no licence; it is rewritten with this one tonight.",
    archiveLicenseWas: (license: string) => `This file states ${license}; it is rewritten with this licence tonight.`,
    downloadSized: (size: string) => `Download (${size})`,
    archiveDownload: (program: string, year: number) => `Download the ${program} archive for ${year}`,
    /** A program's checklist, above its years. */
    checklist: (taxa: number) => `Checklist: ${n(taxa)} ${taxa === 1 ? "name" : "names"}, every year together.`,
    checklistDownload: (program: string) => `Download the ${program} checklist`,
    /** A program's archive of every year together, above its years (beeline-9bnm). */
    allYears: (specimens: number, first: number, last: number) =>
      first === last
        ? `Every year together: ${n(specimens)} ${specimens === 1 ? "specimen" : "specimens"}, all from ${first}.`
        : `Every year together: ${n(specimens)} ${specimens === 1 ? "specimen" : "specimens"}, ${first} to ${last}.`,
    allYearsLicense: (license: string) => `Every year is under ${license}.`,
    allYearsNoLicense: "Its years do not all have the same licence, so none is stated for them together.",
    allYearsDownload: (program: string) => `Download the ${program} archive of every year`,
    /** The file states a licence its years no longer share. */
    allYearsLicenseDropped: (license: string) => `This file states ${license}; it is rewritten with no licence tonight.`,
  },
  jobs: {
    title: "Jobs",
    heading: "Scheduled jobs",
    intro: "Everything the app runs on a schedule, and how the recent runs went. Night-window jobs may run long; interactive jobs answer to the one-second budget.",
    registered: "Registered",
    recentRuns: "Recent runs",
    /** What each job does, keyed by Job.name (a test pins the key sets together). */
    descriptions: {
      "session-purge": "Each night, deletes the sign-in sessions idle for more than 30 days, which have already stopped working.",
      "nightly-pipeline":
        "Pulls every observation changed since the last run (edits and new records, however old the observation), promotes into samples, and fills missing elevations from the DEM tiles on disk.",
      "legacy-export":
        "Writes every specimen as the old system's occurrences file — the same columns, order and format — so reports and uploads built on that file keep working. Download it from Exports.",
      "legacy-copy":
        "Copies every specimen printed here into the old Beeline at old.melittologist.org, so volunteers can enter their identifications there until it closes in February 2027. Sends only what changed since the last copy, and never overwrites an identification a volunteer entered there.",
      "legacy-volunteer-import":
        "Reads the identifications volunteers entered in the old Beeline at old.melittologist.org and adds each new or changed one here, as the collector's. Names Beeline lacks, specimens whose old records disagree, and identifications removed there are listed in the run, not added.",
      "dwc-archives":
        "Writes a Darwin Core archive for each atlas and for Master Melittology, one per calendar year, for staff to review, and removes any whose year no longer has specimens. Download them from Exports.",
      "ecdysis-fetch":
        "Brings back the determinations made in Ecdysis, Washington's museum database. Downloads the collection only when Ecdysis says something changed, and otherwise reloads the copy it kept; names Beeline lacks are taken from Ecdysis's own list of names where it accepts them, and the rest are listed in the run.",
      "store-backup":
        "Copies the whole store and the staff decisions and change histories into one file in the Bee Line folder on the OSU shared drive, for recovery only. It checks that the copies open and that the file Drive holds is the one sent, and keeps every night's copy for two weeks and the first of each month for a year.",
      "commit-determinations":
        "Turns the day's entries on Identify specimens into determinations. Until it runs, volunteers can change what they entered; after it, a change is added beside the old one.",
      "resource-budget":
        "Reads what the machine used in the last day and an hour — processor, memory, swap and disk — from Fly's metrics, and fails when it came close to a limit, so somebody looks before the machine is throttled, killed or its disk grows.",
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
    /** The night steps' trend (beeline-e1xg). */
    steps: "Night steps over time",
    stepsIntro:
      "Each step of the night jobs: how its latest run went, and the most memory the app held during it in the week three months ago, the week a month ago and this week. A step whose figure rises from left to right is growing with the data, and is the one to make lighter before a night runs out of memory. DuckDB's figure is the part its own memory limit caps.",
    noSteps: "No night job has run since steps were recorded.",
    colStep: "Step",
    colLastRun: "Latest run",
    colTook: "Took",
    colMemory: "Memory at most",
    colDuckDb: "DuckDB",
    colQuarterAgo: "3 months ago",
    colMonthAgo: "A month ago",
    colThisWeek: "This week",
    stepFailed: "failed",
    megabytes: (mb: number) => `${n(mb)} MB`,
    /** Seconds are rounded before they are split, so nothing reads "1 min 60 s". */
    duration: (ms: number) => {
      if (ms < 1000) return `${n(ms)} ms`;
      if (ms < 59_950) return `${n(Math.round(ms / 100) / 10)} s`;
      const s = Math.round(ms / 1000);
      return `${n(Math.floor(s / 60))} min ${n(s % 60)} s`;
    },
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
    /** The quick choices for why a label is reprinted (gh-218); none is required. */
    reprintReason: {
      never_received: "Never received",
      damaged: "Damaged or lost",
      data_corrected: "Record corrected",
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
      waiting: (labels: number, samples: number, reprints = 0) =>
        `${
          labels === 0
            ? "no new labels"
            : `${n(labels)} ${labels === 1 ? "label" : "labels"} for ${n(samples)} ${samples === 1 ? "sample" : "samples"}`
        }${reprints === 0 ? "" : ` and ${n(reprints)} ${reprints === 1 ? "reprint" : "reprints"}`} waiting`,
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
        | { code: "atlas_not_printing"; atlasId: number }
        | { code: "reprint_refused"; specimens: number; unnumbered: number; asked: number; printing: number },
    ) =>
      refusal.code === "reprint_refused"
        ? refusal.specimens === 0
          ? "There is no specimen there to reprint. Nothing was changed."
          : refusal.specimens === 1
          ? refusal.asked > 0
            ? "A reprint of this label has already been asked for. Nothing was changed."
            : refusal.printing > 0
              ? "A print run that has not printed yet already holds this label. Nothing was changed."
              : "This specimen has no field number, so there is no label to reprint. Nothing was changed."
          : `No label was asked for: of ${n(refusal.specimens)} specimens, ${n(refusal.asked)} ${refusal.asked === 1 ? "is" : "are"} already waiting, ${n(refusal.printing)} ${refusal.printing === 1 ? "is" : "are"} in a run that has not printed, and ${n(refusal.unnumbered)} ${refusal.unnumbered === 1 ? "has" : "have"} no field number.`
        : refusal.code === "atlas_not_printing"
        ? "No run was prepared: that atlas does not print its own labels, so its samples go in the run for everyone Oregon prints for."
        : refusal.code === "determined"
        ? `This run cannot be canceled: ${n(refusal.specimens)} of its specimens ${refusal.specimens === 1 ? "has" : "have"} already been identified, and canceling would take their field numbers away. Nothing was changed.`
        : refusal.code === "no_location"
          ? `No run was prepared: sample ${refusal.sampleId} is waiting to print but has no coordinates on record, which should not be possible. Look at /samples/${refusal.sampleId} before trying again.`
          : `No run was prepared: sample ${refusal.sampleId} is waiting to print but does not have exactly one primary collector. Look at /samples/${refusal.sampleId} before trying again.`,
    scopeProgram: "program",
    notYet: "not yet",
    run: {
      /** When it was prepared and for whom: the atlas's code, or the program's run (GitHub #105). */
      title: (preparedAt: Date | string, atlasCode: string | null) =>
        `Print run ${stamp(preparedAt)} · ${atlasCode ?? "program"}`,
      back: "← Print runs",
      preparedBy: (name: string, when: string) => `Prepared by ${name}, ${when}.`,
      scopeProgram: "Everyone Oregon prints for.",
      scopeAtlas: (name: string) => `${name} only.`,
      counts: (labels: number, samples: number, collectors: number, sheets: number, reprints = 0) =>
        `${n(labels)} ${labels === 1 ? "label" : "labels"} for ${n(samples)} ${samples === 1 ? "sample" : "samples"} from ${n(collectors)} ${collectors === 1 ? "collector" : "collectors"}, on ${n(sheets)} ${sheets === 1 ? "sheet" : "sheets"}.` +
        (reprints === 0
          ? ""
          : ` ${n(reprints)} of the labels ${reprints === 1 ? "is a reprint" : "are reprints"}, after the new ones.`),
      /** Beside a label that is a second print under the number it already had. */
      reprint: "reprint",
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
        "These lines were longer than the label was drawn for and have been shrunk to fit, a county was missing, or a reprint reads differently from the specimen's last label because the record has changed since. The run prints regardless.",
      warningsNone: "Every label fits.",
      splitSamples: (count: number) =>
        `${n(count)} ${count === 1 ? "sample" : "samples"} in this run also ${count === 1 ? "has" : "have"} labels in another open run, so its labels will arrive in two envelopes.`,
      /** A sample staff held back after this run was prepared (beeline-plu); the printer decides. */
      held: (count: number) =>
        `Staff have held ${count === 1 ? "a sample" : `${n(count)} samples`} in this run back from printing since it was prepared. ` +
        `The run still includes ${count === 1 ? "it" : "them"}. To leave ${count === 1 ? "it" : "them"} out, cancel the run and prepare it again.`,
      heldSample: (collector: string, sampleNumber: string) => `${collector}'s sample ${sampleNumber}`,
      outOfDate: (count: number) =>
        `${count === 1 ? "A sample" : `${n(count)} samples`} in this run ${count === 1 ? "has" : "have"} changed since it was prepared, ` +
        `but ${count === 1 ? "its labels" : "their labels"} still show the values from then. ` +
        `To print the new values, cancel the run and prepare it again, or print it and reprint ${count === 1 ? "those labels" : "the labels of these samples"}.`,
      outOfDateSample: (collector: string, sampleNumber: string, labels: number) =>
        `${collector}'s sample ${sampleNumber} (${n(labels)} ${labels === 1 ? "label" : "labels"})`,
      outOfDateField: {
        locality: "locality",
        county: "county",
        state_province: "state or province",
        country: "country",
        coordinates: "coordinates",
        elevation: "elevation",
        dates: "dates",
      } satisfies Record<OutOfDateField, string>,
      outOfDateChange: (field: string, onLabel: string | null, now: string | null) =>
        `${field} ${onLabel ?? "none"} on the labels, ${now ?? "none"} now`,
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
    /**
     * Program leads (beeline-7c1): whose a program's work is, and who to
     * raise its questions with. Responsibility, not access, which the hint
     * says because the card sits beside admin rights and could be read as one.
     */
    /**
     * The person's API keys (beeline-pnqr.9), shown only when they have made
     * one. The columns and the revoked line are the keys page's own.
     */
    keys: {
      heading: "API keys",
      hint: "The keys this person has made, never the keys themselves. If one may have leaked and this person cannot be reached, revoke it here: it stops working at once, and the list says who revoked it.",
      earlierHeading: "Made before this account was linked to this person",
      earlierHint:
        "These keys were made under this iNaturalist account before it was unlinked or linked to someone else, so they are not this person's. None of them works any more. They are listed so that staff can trace one.",
    },
    leadership: "Program leads",
    leadershipHint:
      "The programs this person leads: their work is this person's to take up, and their questions this person's to answer. A program can have several leads. Leading a program grants no access — that is admin rights, below.",
    leadsNothing: "Leads no program",
    removeLead: (program: string) => `Stop leading ${program}`,
    addLead: "Add a program they lead",
    chooseProgram: "Choose a program",
    saveLead: "Add",
    colLeads: "Leads",
    leadAny: "Anyone",
    leadSome: "Any program",
    notALead: "leads no program",
    /**
     * ORCID (beeline-0544, beeline-yaaj). The card is staff-facing like the
     * rest of the page, but the note on connecting one is written to be read
     * out to the volunteer, since telling them is what staff use it for.
     */
    orcid: "ORCID",
    orcidHint:
      "An ORCID iD credits this person in the records Beeline publishes, as the collector and as the identifier. The iD connected on their iNaturalist account is the one used; one recorded here is used only when their account has none.",
    orcidFromInat: "From their iNaturalist account",
    orcidFromStaff: "Recorded by staff",
    orcidNone: "No ORCID iD",
    /** The note, in three pieces so the middle one can be the link. */
    orcidConnect: "To be credited by name when their records are published, they can connect their ORCID iD on iNaturalist: in ",
    orcidConnectLink: "iNaturalist's settings",
    orcidConnectAfter:
      ", under Applications, choose Connected Accounts and connect ORCID. Beeline picks it up the next time they sign in to Beeline — if they are already signed in, they sign out and back in.",
    orcidOverridden: (staff: string) =>
      `Staff also recorded ${staff}. Their iNaturalist account's iD is the one used.`,
    orcidShared: (names: string) => `The same iD also credits ${names}. An iD belongs to one person — find out whose it is.`,
    orcidField: "ORCID iD recorded by staff",
    orcidFieldHint:
      "Only an iD the person gave you or that you have confirmed is theirs. The full address (https://orcid.org/…) or the sixteen digits alone are both fine.",
    orcidInvalid: (value: string) =>
      `'${value}' is not an ORCID iD — it should be sixteen digits in four groups, like 0000-0002-1825-0097, and the last one is a check digit`,
    orcidTaken: (orcid: string, name: string) => `${orcid} is already recorded for ${name}`,
    accountTaken: (uid: number, name: string) => `iNat account ${uid} is already bound to ${name}`,
    saveOrcid: "Save ORCID",
    removeOrcid: "Remove",
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
    savedRebuild: "Saved.",

    /**
     * The change log (beeline-o22). Staff-facing, English-only like the rest
     * of this screen. The overlay beside it keeps one current row per field,
     * so it can say who last changed a thing and never when, what it was
     * before, or that it changed twice; this says all of it.
     */
    history: {
      heading: "History",
      hint:
        "Every change recorded for this person, newest first — from this screen, from the import from old Beeline, or from an iNaturalist sync.",
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
        leads: "Leads",
        orcid: "ORCID iD recorded by staff",
        inat_orcid: "ORCID iD on iNaturalist",
      },
      /**
       * Who, where nobody can be named. All but the first are passes over
       * the store or moments that found a difference, which is a weaker
       * claim than a staff member's login and is written to read like one.
       */
      source: {
        app: "staff",
        legacy_promotion: "the import from old Beeline",
        observation_promotion: "an iNaturalist sync",
        inat_backfill: "an iNaturalist login lookup",
        inat_orcid_fetch: "an iNaturalist ORCID lookup",
        sign_in: "their sign-in",
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
   * Adding somebody by their iNaturalist account (beeline-2c3.33): staff, an
   * intern, anyone who collects nothing and so has no other way in.
   * Staff-facing, English-only.
   */
  addPerson: {
    link: "Add a person",
    title: "Add a person",
    heading: "Add a person",
    intro:
      "Somebody who signs in to Beeline needs to be connected to their iNaturalist account first. Volunteers are added from their collection records on Unknown collectors; use this for anyone who has none, such as staff.",
    backToPeople: "All people",
    lookUp: "Their iNaturalist account",
    lookUpHint: "Their login, or a link to their iNaturalist profile.",
    find: "Look them up",
    notAccount: (typed: string) => `"${typed}" isn't an iNaturalist login or a link to a profile.`,
    noSuchAccount: (typed: string) => `iNaturalist has no account called ${typed}.`,
    lookupFailed: "iNaturalist didn't answer just now. Try again in a minute.",

    turnedAwayHeading: "Turned away at sign-in",
    turnedAwayHint:
      "These people signed in with iNaturalist, but nobody in Beeline is connected to their account, so they were told to ask their atlas staff.",
    turnedAwayEmpty: "Nobody has been turned away at sign-in.",
    colAccount: "iNaturalist account",
    colTried: "Last tried",
    // Compared as said, so two attempts in the same minute read as one.
    tried: (first: Date, last: Date) =>
      dateTime(first) === dateTime(last) ? dateTime(last) : `${dateTime(last)} (first ${dateTime(first)})`,
    addThem: "Add",

    profile: "Their iNaturalist profile",
    profileName: (name: string) => `Named ${name} on iNaturalist`,
    noProfileName: "No name on their iNaturalist profile",
    about: (observations: number, joined: Date | null) =>
      [
        `${n(observations)} ${observations === 1 ? "observation" : "observations"}`,
        joined === null
          ? null
          : // A string passes through, as the formatters above let the proofing page's placeholders.
            `joined ${typeof joined === "string" ? joined : joined.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric", timeZone: ZONE })}`,
      ]
        .filter((x) => x !== null)
        .join(", "),
    triedToSignIn: (when: Date) => `Tried to sign in to Beeline ${dateTime(when)}.`,
    held: (name: string) => `This account is already connected to ${name}.`,
    openPerson: (name: string) => `Open ${name}`,
    waiting: (records: number) =>
      `This account has ${n(records)} collection ${records === 1 ? "record" : "records"} waiting on Unknown collectors. Add them there, so their records become samples at the same time.`,
    openWaiting: "Open them on Unknown collectors",

    displayName: "Name",
    displayNameHint: "How they appear across Beeline.",
    givenName: "Given name",
    familyName: "Family name",
    namesHint: "Used on labels, if they ever collect.",
    staff: "Staff",
    staffHint: "Staff can see and change everything in Beeline, including People.",
    reason: "Why (optional)",
    add: "Add them",
    addedReason: (staff: boolean) => (staff ? "Program staff" : "Added by their iNaturalist account"),

    nameBlank: "give them a name",
    nameTaken: (name: string) =>
      `somebody here is already called "${name}". If this is them, connect the account from their page on People; if not, give this person a name that tells them apart`,
    problem: (why: string) => `Not saved: ${why}`,
  },

  /**
   * Collectors Beeline does not know (beeline-e85). Staff-facing, English-only.
   * Said as staff would say it: somebody posted collection records and
   * nobody here is connected to their iNaturalist account — never "unresolved"
   * or "unbound", which are the model's words.
   */
  unclaimed: {
    title: "Unknown collectors",
    heading: "Collectors Beeline doesn't know",
    intro:
      "These people put collection records in the projects on iNaturalist, and nobody in Beeline is connected to their iNaturalist account. Until somebody says who they are, their records don't become samples and they can't sign in.",
    summary: (records: number, people: number, active: number) =>
      `${n(records)} ${records === 1 ? "record" : "records"} from ${n(people)} ${people === 1 ? "person" : "people"}, ${n(active)} of them from active seasons.`,
    empty: "Everyone who has put a collection record on iNaturalist is somebody Beeline knows.",
    emptyHeading: "Nobody waiting",
    ledBy: "Led by",
    noLead: "No lead recorded",
    colAccount: "iNaturalist account",
    colRecords: "Records",
    colActiveSeasons: "Active seasons",
    colCollected: "Collected",
    colMightBe: "Might be",
    colWhy: "Why",
    noSuggestion: "no suggestion",
    backToList: "All unknown collectors",
    lede: (records: number, first: Date, last: Date) =>
      `${n(records)} collection ${records === 1 ? "record" : "records"} on iNaturalist, ${dateRange(first, last)}.`,
    profile: "Their iNaturalist profile",
    profileName: (name: string) => `Named ${name} on iNaturalist`,
    collectedIn: (programs: string) => `Collected in ${programs}`,
    records: "Their records",
    colSample: "Sample",
    colSpecimens: "Specimens",
    colPlace: "Place",
    colProgram: "Program",
    placeUnknown: "not known",
    viewOnInat: "View on iNaturalist",

    existing: "Somebody already here",
    existingHint:
      "A volunteer who changed accounts, or a household member, may already be in Beeline under another name or account. Connecting this account to them makes these records theirs, and any that are already in Beeline as samples are matched rather than made a second time.",
    evidenceRegister: (login: string) => `The old system's list of volunteers has @${login} under this name.`,
    evidenceInatName: "Their iNaturalist profile has this name.",
    alreadyConnected: (login: string) => `Already connected to @${login}`,
    thisIs: (name: string) => `This is ${name}`,
    someoneElse: "Someone else",
    someoneElseHint: "Their name as it appears on People.",
    connect: "Connect",

    newcomer: "Somebody new",
    newcomerHint:
      "Adds them to Beeline with this iNaturalist account, so their records become samples and they can sign in.",
    checkFirst:
      "Check the suggestions above first. If this is somebody already here, adding them again makes a second copy of samples Beeline already has.",
    displayName: "Name",
    displayNameHint: "How they appear across Beeline. Filled in from their iNaturalist profile where it has a name.",
    givenName: "Given name",
    familyName: "Family name",
    namesHint: "Used for their labels.",
    add: "Add them",

    reason: "Why (optional)",
    connectedReason: (records: number) => `${n(records)} collection records on iNaturalist under this account`,

    connected: (login: string, name: string) => `@${login} is now ${name}.`,
    outcome: (made: number, linked: number, left: number) =>
      [
        `${n(made)} new ${made === 1 ? "sample" : "samples"}`,
        linked > 0 ? `${n(linked)} matched to ${linked === 1 ? "a sample" : "samples"} already here` : null,
        left > 0 ? `${n(left)} ${left === 1 ? "record" : "records"} could not be made into samples` : null,
      ]
        .filter((x) => x !== null)
        .join(", ") + ".",
    notMadeYet:
      "Saved, but their samples could not be made just now. The nightly run at 2am will make them.",
    openPerson: (name: string) => `Open ${name}`,

    gone: "Nobody is waiting under this account. It may have just been connected to somebody.",
    nobodyCalled: (name: string) => `nobody here is called "${name}"`,
    nameAmbiguous: (name: string) =>
      `"${name}" is also how the old records name somebody else, so connecting by it could reach the wrong person — connect the account from the right person's page on People`,
    nameShared: (name: string) =>
      `two people here are called "${name}" — connect the account from the right one's page on People`,
    alreadyHasAccount: (name: string, login: string) =>
      `${name} is already connected to @${login}. A person has one iNaturalist account here; to move them to this one, change it on their page on People`,
    nameBlank: "give them a name",
    nameTaken: (name: string) =>
      `somebody here is already called "${name}". If this is them, connect the account to them instead; if not, give the newcomer a name that tells them apart`,
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
      "A recommended field is empty. Adding it improves the record, but does not block printing.",
    obscured_no_true_coordinates:
      "The coordinates are obscured by iNaturalist geoprivacy and Beeline does not hold the true coordinates. Join the project with trusted coordinate access, or clear the geoprivacy setting on the observation.",
    taxon_obscured_awaiting_atlas:
      "iNaturalist obscures where the plant on this observation grows due to its conservation status. A label carries the true location, and Beeline prints it only where approved by the regional bee atlas. Approval is not yet in place for this area, so labels will not print for now. No action is required.",
    locality_format:
      "The locality must be short (18 characters or fewer), without commas or double quotes, and more than a county name: it is printed on a 3pt label beside the county. Example: Corvallis rather than Corvallis, OR.",
    place_unabbreviated:
      "Country and state/province must use standard abbreviations (such as USA instead of United States, or OR instead of Oregon) due to limited space on printed labels.",
    place_unrecognised:
      "The state or province on this record is not recognized by Beeline, or does not match the country. Use the two-letter US state or Canadian province code (UT, BC) with a matching country. Records from outside the US and Canada can be confirmed by staff.",
    coordinate_uncertainty:
      "The location accuracy exceeds the allowed limit. The flag indicates the accuracy and the applicable limit. Records must be within 100 m (GPS resolution) to print. A record collected before 2 September 2026 keeps the previous 250 m limit only once its labels have printed or its season has settled. Update the location accuracy on the observation, or contact staff if the uncertainty cannot be reduced.",
    coordinate_out_of_region:
      "The coordinates on this record are outside North America, but the record indicates they should be within it. Check the pin on the iNaturalist observation. If the record was collected outside North America, set its country to match and ask staff to confirm it.",
    // The second sentence used to be "Its current identification is something
    // else (a moss, alga, fungus, or the bee itself)", which was as close as
    // this could get to naming the taxon while the detail was a machine value.
    // The detail now says which one it is, so the generic list folds into the
    // first sentence rather than being said twice (beeline-dys).
    non_tracheophyte_host:
      "The iNaturalist observation should be identified as the floral host: a vascular plant, rather than a moss, alga, fungus, or the bee itself. Update the observation's identification to the plant the bee was collected from. If the bee was not on a plant at all, for example caught in flight, remove the identification instead: an observation with none is not flagged.",
    duplicate_sample_number:
      "Each sample must have its own number, and this one appears on more than one of your samples for that date. Renumber all but one of the observations on iNaturalist. Your samples in Beeline will update automatically until their labels are printed.",
    count_mismatch:
      "The specimen count on iNaturalist does not match this sample. Verify that the observation has a sample number, date, and a count of one or more. Once labels have printed, the record keeps the count its labels were printed for.",
    count_below_printed:
      "The specimen count is now lower than the number of labels already printed for this sample. No action is needed; extra labels can be discarded.",
    within_sample_disagreement:
      "Historical records merged into this sample had conflicting values for a field. The earliest record's value was retained. Review the listed alternatives and edit the sample if the retained value is incorrect.",
    observation_missing_upstream:
      "iNaturalist no longer returns the observation backing this sample. It may have been deleted, or, if Beeline used to read it through a project, removed from that project or given a different date. Staff will investigate before any further printing for this sample.",
    staff_hold:
      "Staff are holding this sample back from printing. Their note says why. If it asks you to change something, change it; staff will review and lift the hold.",
  } as Record<string, string>,

  /**
   * "Your bees" (beeline-fiay, beeline-xegx): a volunteer's own bees by the
   * year they were collected, and the experts' identifications of them as they
   * arrived, a day at a time. The start of the student report's replacement.
   */
  yourBees: {
    title: "Your bees",
    heading: "Your bees",
    lede: "Every bee you have collected: how far each has been identified, when experts identified them, and what they turned out to be.",
    tabs: { label: "Your bees", identifications: "Identifications", found: "What you found" },
    /** The taxa the volunteer's bees are (beeline-fiay), by family and genus. */
    found: {
      title: "What you found",
      heading: "What you found",
      /** How many bees are identified, and the taxa they cover: separate claims, since a bee named only to genus adds a genus and no species. */
      summary: (identified: number, species: number, genera: number, families: number) =>
        `${n(identified)} of your bees ${identified === 1 ? "is" : "are"} identified. ` +
        `${identified === 1 ? "It covers" : "Between them they cover"} ${n(families)} ${families === 1 ? "family" : "families"}, ` +
        `${n(genera)} ${genera === 1 ? "genus" : "genera"} and ${species === 0 ? "no species yet" : `${n(species)} species`}.`,
      notYet: (count: number) => `${n(count)} more ${count === 1 ? "is" : "are"} not identified yet.`,
      waiting: (count: number) => `${n(count)} ${count === 1 ? "is" : "are"} waiting to be identified.`,
      /** Against everything found in the atlases the volunteer collects in, by anybody, the volunteer included. */
      summaryOf: (
        identified: number,
        families: number,
        allFamilies: number,
        genera: number,
        allGenera: number,
        species: number,
        allSpecies: number,
        atlases: readonly string[] | string,
      ) =>
        `${n(identified)} of your bees ${identified === 1 ? "is" : "are"} identified. ` +
        `${identified === 1 ? "It covers" : "Between them they cover"} ${n(families)} of the ${n(allFamilies)} ${allFamilies === 1 ? "family" : "families"}, ` +
        `${n(genera)} of the ${n(allGenera)} ${allGenera === 1 ? "genus" : "genera"} and ${n(species)} of the ${n(allSpecies)} species found in the ${list(atlases)}.`,
      introOthers: (atlases: readonly string[] | string) =>
        `Under each genus, the species others in the ${list(atlases)} have found and you have not are folded away, with how many they have collected.`,
      noneYet: "none of yours yet",
      atlasHas: (families: number, genera: number, species: number, atlases: readonly string[] | string) =>
        `Others in the ${list(atlases)} have found ${n(families)} ${families === 1 ? "family" : "families"}, ${n(genera)} ${genera === 1 ? "genus" : "genera"} and ${n(species)} species of bee.`,
      othersMore: (count: number) => `${n(count)} more species found by others`,
      othersOnly: (count: number) => `${n(count)} species found by others`,
      byOthers: (bees: number) => (bees === 1 ? "1 by others" : `${n(bees)} by others`),
      intro:
        "Each bee is counted as far as it is identified now, under its family and genus. Your own identifications count, and an expert's takes the place of yours where there is one. A name marked aff. or nr., which says the bee is probably something else, is listed but not counted as a species found.",
      empty: "None of your bees has been identified yet.",
      bees: (count: number) => (count === 1 ? "1 bee" : `${n(count)} bees`),
      col: { genus: "Genus", bees: "Bees", species: "Species" },
      noFamily: "Not identified to family",
      noGenus: "Not identified to genus",
      toGenusOnly: (count: number) => `${n(count)} identified only to genus or subgenus`,
      /** A genus's list folded away: how many names it holds, which may be more than its species ("cf.", "aff.", subspecies). */
      names: (count: number) => (count === 1 ? "1 name" : `${n(count)} names`),
      notBees: (count: number) =>
        `${n(count)} ${count === 1 ? "specimen was" : "specimens were"} identified as something other than a bee, and ${count === 1 ? "is" : "are"} left out.`,
    },
    byYear: {
      heading: "Your bees by year",
      intro:
        "Each bar is the bees you collected that year, split by how far each one is identified now. Your own identifications count, and an expert's takes the place of yours where there is one. Specimens identified as something other than a bee are left out.",
      empty: "None of your samples has specimens recorded yet. They appear here once your samples' labels are printed.",
      chartLabel: "Bees you collected each year, by how far each is identified",
      legend: { species: "To species", genus: "To genus", coarser: "Coarser than genus", none: "Not yet identified" },
      col: { season: "Year", collected: "Collected" },
      asTable: "Show as a table",
      title: (season: number | string, collected: number, species: number, genus: number, coarser: number, none: number) =>
        `${season}: ${n(collected)} bees. ${n(species)} to species, ${n(genus)} to genus, ${n(coarser)} coarser, ${n(none)} not yet identified.`,
    },
    batches: {
      heading: "When experts identified them",
      intro: "Experts identify in batches, often a year or more after the bees were collected. Each entry is one day's identifications, newest first.",
      undated: (count: number) =>
        `${n(count)} of your bees ${count === 1 ? "was" : "were"} identified at a time Beeline does not know, most in the old Beeline, which kept no dates. Those are only on each specimen's page.`,
      empty: "No dated identification of your bees by an expert other than you yet.",
      /** An expert's sheet that stated no day: when it arrived is the latest the bees could have been identified. */
      onOrBefore: (day: string) => `On or before ${day}`,
      identified: (parts: readonly string[] | string, experts: number) => `${experts > 1 ? "Experts" : "An expert"} identified ${list(parts)}.`,
      ofSeason: (count: number, season: number | string) => `${n(count)} of your ${season} bees`,
      kinds: (parts: readonly string[] | string) => {
        const text = Array.isArray(parts) ? parts.join("; ") : String(parts);
        return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
      },
      /**
       * What each identification did to the name an expert gave the bee
       * before. "Your own" is a name the volunteer gave, which Washington's
       * staff upload to Ecdysis, where it reads as an expert's.
       */
      kind: {
        first: (count: number) => `${n(count)} for the first time`,
        confirmed: (count: number) => `${n(count)} confirmed`,
        finer: (count: number, from: string, to: string) => `${n(count)} from ${from} to ${to}`,
        coarser: (count: number, from: string, to: string) => `${n(count)} back from ${from} to ${to}`,
        corrected: (count: number) => `${n(count)} corrected`,
        certainty: (count: number) => `${n(count)} with a change in how sure the identification is`,
        own: (own: number, count: number) =>
          own === count
            ? count === 1
              ? "(it was your own identification)"
              : "(all were your own identifications)"
            : own === 1
              ? "(1 was your own identification)"
              : `(${n(own)} were your own identifications)`,
      },
      by: (names: readonly string[] | string) => `By ${list(names)}`,
      names: (count: number) => (count === 1 ? "1 name" : `${n(count)} names`),
      times: (count: number) => `× ${n(count)}`,
      /** A specimen with no field number yet, by its place in its sample. */
      specimen: (sampleNumber: string, specimenNumber: number) => `sample ${sampleNumber}, specimen ${specimenNumber}`,
      andMore: (count: number) => `and ${n(count)} more`,
    },
  },

  /**
   * The process, step by step, for a volunteer who has never seen Beeline
   * (beeline-kgwd; Peter, 2026-11-03, cutover day): what happens and when, and
   * what each step needs from them. Every sentence is a fact about how the
   * system runs today, and nothing promises a timing it does not keep: print
   * runs are staff's decision, not a schedule. A body is text with links in
   * it, so each technical word is glossed where it first appears, as the
   * voice page asks. The order is the specimen's own: field, overnight read,
   * front page, print run, pinning, identifying, handing in.
   */
  howItWorks: {
    title: "How Beeline works",
    heading: "How Beeline works",
    lede: "Beeline turns your collecting into labelled, identified specimens. Here is what happens at each step, and what it needs from you.",
    steps: [
      {
        heading: "In the field: record each sample on iNaturalist.",
        body: [
          "A ",
          { href: "/glossary#sample", label: "sample" },
          " is one act of collecting: one place, one day, one kind of plant (or none). For each one, make an ",
          { href: "/glossary#observation", label: "observation" },
          " in your atlas's project, of the plant you collected from. If the bees were not on a plant, for example caught in flight, make the observation with no identification. Give it the sample number (1, 2, 3… restarting each day) and the number of specimens. The observation's date and location become the sample's.",
        ],
      },
      {
        heading: "Every morning at 2am Pacific, Beeline reads your observations.",
        body: [
          "Nothing to do. A new or changed observation shows up here the next day, or straight away if you press “Check iNaturalist now” on ",
          { href: "/", label: "your front page" },
          ".",
        ],
      },
      {
        heading: "Your front page lists what needs attention.",
        body: [
          "Beeline checks each sample before it can be labelled, and lists the ones that need something, such as a missing sample number or count, a number used twice on one day, a place name that won't fit on a label, coordinates that are uncertain, outside North America, or hidden by iNaturalist so that Beeline cannot read them, a host that is not a plant, or an observation that no longer exists. Most fixes are made on iNaturalist; a place name can often be fixed in one click here. A sample with a ",
          { href: "/glossary#flag", label: "flag" },
          " that ",
          { href: "/glossary#blocks-printing", label: "blocks printing" },
          " is not printed until it's fixed, so this is the step that matters most.",
        ],
      },
      {
        heading: "Staff prepare a print run.",
        body: [
          "When staff prepare a print run, every sample that is ready goes in. That is the moment your specimens get their field numbers; the ",
          { href: "/glossary#label", label: "labels" },
          " are printed and mailed to you. From then on, the place, the coordinates, the sample number and the count are fixed: a later edit on iNaturalist no longer changes them, so check your observations before the run, not after. A sample's date is taken once and never changed from iNaturalist; a wrong date is fixed by telling staff.",
        ],
      },
      {
        heading: "Labels arrive: pin your specimens and attach them.",
        body: [
          "Each label carries the field number, your name, the date, the place and the ",
          { href: "/glossary#specimen", label: "specimen" },
          "'s number in its sample.",
        ],
      },
      {
        heading: "Identify your specimens.",
        body: [
          "Open ",
          { href: "/determinations", label: "Identify your specimens" },
          " and enter what you can for each one, as far as you are certain, such as genus or family. Changes save as you go and can be undone until 1am; after that they are kept as your ",
          { href: "/glossary#determination", label: "determination" },
          ". If you prefer the old Beeline's screens, they stay available at ",
          { href: OLD_BEELINE_ORIGIN, label: "old.melittologist.org" },
          " through February 2027.",
        ],
      },
      {
        heading: "Hand in your specimens.",
        body: [
          "Your season's specimens go to your atlas's taxonomist or staff, by the Melittologist conference in early March. Expert identifications arrive later, often months or years, in batches, and appear on each specimen's page.",
        ],
      },
    ],
    whenHeading: "When things happen",
    when: [
      ["Every day, 1am Pacific: the identifications you entered since the last 1am are recorded as your determinations."],
      ["Every day, 2am Pacific: Beeline reads iNaturalist."],
      [
        "1 March: the previous year's ",
        { href: "/glossary#season", label: "season" },
        " settles. No new labels are printed from it, though its records stay editable.",
      ],
      ["Print runs happen when staff prepare them, not on a schedule."],
    ],
  },

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
      "Terms used across Beeline, from iNaturalist, and in scientific nomenclature.",
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
          "A state or provincial bee atlas: Oregon, Washington, British Columbia, Idaho, or New Mexico. Samples belong to an atlas based on where they were collected. Volunteers may also collect outside member atlases as part of Master Melittology.",
      },
      authorship: {
        term: "Authorship",
        definition:
          "The author who first published a taxonomic name, and the year of publication. Authorship is part of the formal scientific name and is not italicised.",
        example: { rank: "species", scientificName: "Bombus vosnesenskii", authorship: "Radoszkowski, 1862" },
      },
      "blocks-printing": {
        term: "Blocks printing",
        definition:
          "A flag indicating an issue that prevents labels from being printed, such as a missing required field or untrusted coordinates.",
      },
      bycatch: {
        term: "Bycatch",
        definition:
          "Non-bee specimens collected in a sample, such as wasps, bee flies, or beetles. Bycatch is preserved, labelled, and identified alongside bees.",
      },
      "catalog-number": {
        term: "Catalog number",
        definition:
          "The identifier assigned to a specimen by a museum collection, distinct from the field number printed on the label.",
      },
      "cf-aff": {
        term: "cf., aff. and nr.",
        definition:
          "Qualifiers used when a species identification is tentative. 'cf.' indicates the specimen resembles that species and requires confirmation; 'aff.' indicates affinity to a species but likely a distinct taxon; 'nr.' indicates near that species.",
        example: { rank: "species", scientificName: "Bombus occidentalis", qualifier: "cf." },
      },
      collector: {
        term: "Collector",
        definition:
          "A person who collected a sample. When a sample lists multiple collectors, the sample number matches the numbering of the first collector listed.",
      },
      "coordinate-uncertainty": {
        term: "Coordinate uncertainty",
        definition:
          "The estimated accuracy radius of the coordinates recorded on iNaturalist. Accuracy beyond 100 m is too imprecise to print. A record collected before 2 September 2026 whose labels have printed, or whose season has settled, keeps the previous 250 m limit.",
      },
      determination: {
        term: "Determination",
        definition:
          "A taxonomic identification recorded for a specimen. Determinations record who identified the specimen and when; earlier determinations are preserved in history when a specimen is re-identified.",
      },
      ecdysis: {
        term: "Ecdysis",
        definition:
          "The portal and database where specimen records and taxonomist determinations are maintained. Scientific names in Beeline are validated against the Ecdysis taxonomic thesaurus.",
      },
      "field-number": {
        term: "Field number",
        definition:
          "The unique identifier assigned to a specimen when print runs are prepared, printed directly on the specimen label. Once assigned, the field number remains permanently associated with that specimen.",
      },
      flag: {
        term: "Flag",
        definition:
          "A notice indicating an issue with a sample's data. Flags are evaluated automatically from your data during each sync; correcting the issue clears the flag.",
      },
      "floral-host": {
        term: "Floral host",
        definition:
          "The plant from which a sample was collected, identified via the sample's iNaturalist observation. Floral hosts must be vascular plants. Samples collected without a host plant record none.",
      },
      "heads-up": {
        term: "Heads-up",
        definition:
          "An advisory flag highlighting a recommended improvement that does not prevent labels from being printed.",
      },
      label: {
        term: "Label",
        definition:
          "The printed label pinned with a specimen, indicating collection date, locality, collectors, and field number. Locality text is limited to 18 characters to fit the label.",
      },
      "master-melittology": {
        term: "Master Melittology",
        definition:
          "The program at Oregon State University Extension that trains volunteers and coordinates the regional bee atlases.",
      },
      method: {
        term: "Method",
        definition: "How a sample was collected: with a net, or in a trap such as a vane trap, pan trap, or trap nest.",
      },
      "obscured-coordinates": {
        term: "Obscured coordinates",
        definition:
          "Coordinates shifted by iNaturalist for geoprivacy or rare taxon protection. Obscured coordinates are not printed on specimen labels.",
      },
      observation: {
        term: "Observation",
        definition:
          "An iNaturalist record representing the collection event for a sample, providing the sample number, specimen count, collection date, coordinates, and host plant identification.",
      },
      program: {
        term: "Program",
        definition:
          "The program a sample was collected for: a state or provincial bee atlas where it was collected inside one, otherwise Master Melittology itself. Programs that are not atlases, such as the BLM surveys, will be recorded as they begin.",
      },
      rank: {
        term: "Rank",
        definition:
          "The taxonomic level of an identification, such as family, genus, species, or subspecies. Identifications at genus or family rank are valid determinations.",
      },
      "sensu-stricto": {
        term: "s. str. and s. lat.",
        definition:
          "Abbreviations for sensu stricto ('in the strict sense') and sensu lato ('in the broad sense'), specifying which taxonomic definition of a name is intended.",
        example: { rank: "genus", scientificName: "Bombus", qualifier: "s. str." },
      },
      sample: {
        term: "Sample",
        definition:
          "All specimens collected from a single host plant species at one location on a single date, or collected at that location and date without a host. The sample is the primary unit for QC checks and label generation.",
      },
      "sample-number": {
        term: "Sample number",
        definition:
          "The identifier assigned to a sample on the date of collection. Sample numbers are unique to each collector on a given date.",
      },
      "scientific-name": {
        term: "Scientific name",
        definition:
          "The formal Latin name of an organism. Genus names and below are written in italics; family names and above are not italicised.",
        example: { rank: "species", scientificName: "Bombus vosnesenskii" },
      },
      season: {
        term: "Season",
        definition:
          "A calendar year of collecting. Samples belong to the season in which they were collected or, for traps, when set. Active seasons receive label printing; on 1 March, the previous season settles and labels are no longer printed.",
      },
      sp: {
        term: "sp. and spp.",
        definition:
          "Taxonomic abbreviations: 'sp.' denotes an unidentified species in a genus; 'spp.' denotes multiple species. Neither is italicised.",
        example: { rank: "genus", scientificName: "Bombus", qualifier: "sp." },
      },
      specimen: {
        term: "Specimen",
        definition: "An individual insect from a sample. Each specimen receives a distinct field number and printed label.",
      },
      subgenus: {
        term: "Subgenus",
        definition:
          "A taxonomic rank between genus and species, written in parentheses between the genus name and specific epithet.",
        example: { rank: "species", scientificName: "Bombus insularis", subgenus: "Psithyrus" },
      },
      sync: {
        term: "Sync",
        definition:
          "The scheduled morning process that imports observation updates from iNaturalist into Beeline.",
      },
      "trap-sample": {
        term: "Trap sample",
        definition:
          "Specimens collected using an unattended trap, dated across the interval since the trap was last serviced. Trap samples without iNaturalist observations are edited directly in Beeline.",
      },
      "vernacular-name": {
        term: "Vernacular name",
        definition:
          "A common or colloquial name for an organism. Beeline records formal scientific names rather than common names.",
      },
    } satisfies Record<string, GlossaryEntry>,
  },
};

export type Messages = typeof en;
