/**
 * The English catalog — and, via `typeof`, the shape every other catalog
 * must satisfy. Plain data and functions, no framework: a message with
 * variables is a function so word order stays the translator's decision.
 * Views never carry literal user-facing prose; they render from here.
 */

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

export const en = {
  locale,
  brand: "Beeline",
  /** Locale-aware value formatters, for views composing values into markup. */
  format: { date, dateTime, number: n, list },

  layout: {
    /** Any instance that is not production says so (beeline-2u8). */
    envBanner: (environment: string) => `${environment} instance — data here may be blown away and rebuilt at any time`,
    nav: { glossary: "Glossary", design: "Design", jobs: "Jobs" },
    /** The hamburger button that holds the nav on narrow screens. */
    menu: "Menu",
    /** The avatar button that opens the account menu. */
    account: (login: string) => `Account: ${login}`,
    signOut: "Sign out",
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
      (blocking > 0 ? ` — ${n(blocking)} ${blocking === 1 ? "finding blocks" : "findings block"} label printing.` : "."),
    allClearHeading: "All clear",
    allClear: "Nothing needs your attention — every one of your samples is clean. Thank you!",
    lastSynced: (when: Date | string) => `Data last synced from iNaturalist ${dateTime(when)}.`,
    neverSynced: "This instance has not synced from iNaturalist yet.",
    clearsNote: "Fix things on the iNaturalist observation and the finding clears on the next sync.",
    sampleTitle: (sampleNumber: string, when: Date | string) => `Sample ${sampleNumber} · ${date(when)}`,
    specimens: (count: number) => `${n(count)} ${count === 1 ? "specimen" : "specimens"}`,
    fixOnInat: "Fix on iNaturalist",
    notInatBacked: "Not backed by an iNaturalist observation — edit it here and the findings update immediately.",
    editSample: "Edit this sample",
    blocksPrinting: "blocks printing",
    headsUp: "heads-up",
    /**
     * Whose sample you are looking at when it isn't only yours: the sample
     * number belongs to the first collector's series, so a shared sample has
     * to say who else was there (beeline-77j).
     */
    collectedWith: (people: string) => `collected with ${people}`,
  },

  /**
   * The passive counterpart to the findings list: samples that are clean and
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

  errors: {
    crossOrigin: "cross-origin request refused",
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
        "Pulls every observation changed since the last run (edits and new records, however old the observation), promotes into samples, and fills missing elevations from the SRTM tiles on disk.",
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
   * Pronoun vocabulary (beeline-0qr's home): grammatical forms per set, so
   * prose about a person can be written without hardcoding English forms.
   * person.pronouns is null = unstated: render neutrally via `they`.
   */
  pronounForms: {
    he: { subject: "he", object: "him", possessive: "his" },
    she: { subject: "she", object: "her", possessive: "her" },
    they: { subject: "they", object: "them", possessive: "their" },
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
      "The words this site uses, and what they mean here. Some are ours; some come from iNaturalist or from the way scientific names are written. Nothing on this page is something you need to memorise — it is here so you can look it up.",
    entries: {
      sample: {
        term: "Sample",
        definition:
          "Everything you collected in one place on one day. A sample is the unit this whole site is organised around: it holds your specimens, it gets its findings checked, and it is what labels are printed for.",
      },
      "sample-number": {
        term: "Sample number",
        definition:
          "The number you gave a sample on the day you collected it. It only has to be unique among your own samples on that date — two people can both have a sample 3 on the same day.",
      },
      "trap-sample": {
        term: "Trap sample",
        definition:
          "The contents of a trap, collected on the day you emptied it. Because a trap works unattended, its specimens are dated to the range since you last serviced it rather than to a single day. Trap samples usually have no iNaturalist observation, so they are corrected here instead of upstream.",
      },
      specimen: {
        term: "Specimen",
        definition: "One bee (or one piece of bycatch) from a sample. Each specimen gets its own label and its own catalog number.",
      },
      bycatch: {
        term: "Bycatch",
        definition:
          "Anything that isn't a bee but ended up in your sample anyway — wasps, bee flies, beetles. It is kept, labelled, and identified like everything else.",
      },
      observation: {
        term: "Observation",
        definition:
          "A record on iNaturalist. For this site an observation is the evidence of a sample: the plant you photographed is the floral host, and the observation carries your sample number, your specimen count, the date, and the location.",
      },
      "floral-host": {
        term: "Floral host",
        definition:
          "The plant a sample was collected from, identified by the sample's iNaturalist observation. It must be a vascular plant — if the observation is identified as a moss or a fungus or as the bee itself, that raises a finding.",
      },
      collector: {
        term: "Collector",
        definition: "The person who collected a sample — you, on your own samples. Identified by your iNaturalist login.",
      },
      atlas: {
        term: "Atlas",
        definition:
          "Your state or provincial bee atlas: Oregon, Washington, British Columbia, Idaho, New Mexico, or Oklahoma. Samples belong to an atlas by where they were collected, not by which iNaturalist project they arrived through.",
      },
      "master-melittology": {
        term: "Master Melittology",
        definition:
          "The program at Oregon State University Extension that trains and coordinates the atlases, and the umbrella all of them sit under. This site is run by the program on behalf of your atlas.",
      },
      determination: {
        term: "Determination",
        definition:
          "Someone asserting what a specimen is. Determinations are a record of who said what and when, so a later identification never erases an earlier one — and an expert's determination is never overwritten by a volunteer's.",
      },
      "catalog-number": {
        term: "Catalog number",
        definition:
          "The unique number printed on a specimen's label. It is assigned only once the sample's data is clean, and once assigned it belongs to that specimen permanently.",
      },
      label: {
        term: "Label",
        definition:
          "The printed slip pinned with a specimen, carrying where and when it was collected, by whom, and its catalog number. Labels are printed about 3pt tall, which is why several of the findings here are about text being too long.",
      },
      finding: {
        term: "Finding",
        definition:
          "Something this site noticed about one of your samples. A finding is not a mark against you — it is a to-do. Findings are worked out fresh from your data every sync, so fixing the cause makes the finding disappear on its own.",
      },
      "blocks-printing": {
        term: "Blocks printing",
        definition:
          "A finding serious enough that labels cannot be printed for that sample until it is fixed — usually a missing field the label needs, or coordinates we cannot trust.",
      },
      "heads-up": {
        term: "Heads-up",
        definition: "A finding worth fixing that does not stop labels being printed. Improving it makes the record better; leaving it does not hold anything up.",
      },
      sync: {
        term: "Sync",
        definition:
          "The nightly pull of your observations from iNaturalist. Changes you make on iNaturalist show up here after the next sync, not immediately.",
      },
      "obscured-coordinates": {
        term: "Obscured coordinates",
        definition:
          "iNaturalist sometimes shifts an observation's public coordinates — either because you set it to, or automatically for sensitive species. Obscured coordinates cannot go on a label, because they are not where the bee was actually collected.",
      },
      "coordinate-uncertainty": {
        term: "Coordinate uncertainty",
        definition:
          "How far from the pin the true location might be, as recorded by iNaturalist. Beyond 250 m the location is too vague to print, usually because the phone had a poor fix.",
      },
      protocol: {
        term: "Sampling protocol",
        definition: "How a sample was collected — netting, a vane trap, a pan trap, a trap nest.",
      },
      "scientific-name": {
        term: "Scientific name",
        definition:
          "The formal Latin name of an organism, like Bombus vosnesenskii. Genus names and everything below them are written in italics; family names and above are not.",
      },
      rank: {
        term: "Rank",
        definition:
          "How specific a name is — family, genus, species, subspecies, and the coarser ranks above them. Identifications do not always reach species, and a name at genus rank is a complete answer, not a failed one.",
      },
      subgenus: {
        term: "Subgenus",
        definition:
          "A grouping inside a genus, written in brackets between the genus and the species: Bombus (Psithyrus) insularis. The brackets are part of the convention, not an aside.",
      },
      sp: {
        term: "sp. and spp.",
        definition:
          "sp. means one unnamed species in that genus — Bombus sp. is “a bumble bee, genus known, species not”. spp. means several. Neither is italicised, because they are abbreviations rather than names.",
      },
      "sensu-stricto": {
        term: "s. str. and s. lat.",
        definition:
          "Short for sensu stricto and sensu lato — “in the narrow sense” and “in the broad sense”. They mark which of two competing definitions of a name is meant, and like other abbreviations they stay upright.",
      },
      "cf-aff": {
        term: "cf. and aff.",
        definition:
          "cf. means the specimen resembles that species and needs confirming; aff. means it is close to it but probably something else. Both sit in front of the species name: Bombus cf. occidentalis.",
      },
      authorship: {
        term: "Authorship",
        definition:
          "The person who first published a name, and the year, written after it: Bombus vosnesenskii Radoszkowski, 1862. It is part of the formal name, not a citation, and it is never italicised.",
      },
      "vernacular-name": {
        term: "Vernacular name",
        definition:
          "An everyday English name, like “yellow-faced bumble bee”. Plants usually have one and bees usually do not, and the same name can mean different things in different places — so scientific names are what this site records.",
      },
    },
  },
};

export type Messages = typeof en;
