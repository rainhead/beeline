/**
 * The English catalog — and, via `typeof`, the shape every other catalog
 * must satisfy. Plain data and functions, no framework: a message with
 * variables is a function so word order stays the translator's decision.
 * Views never carry literal user-facing prose; they render from here.
 */

const locale = "en";
const n = (x: number) => x.toLocaleString(locale);

export const en = {
  locale,
  brand: "Beeline",

  layout: {
    /** Any instance that is not production says so (beeline-2u8). */
    envBanner: (environment: string) => `${environment} instance — data here may be blown away and rebuilt at any time`,
    nav: { patterns: "Patterns" },
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

  home: {
    title: "Home",
    heading: "Beeline",
    holdings: (samples: number, people: number) => `Holding ${n(samples)} samples from ${n(people)} people.`,
    qcTeaser: "The self-service QC experience lands here (beeline-2c3.6).",
  },

  errors: {
    crossOrigin: "cross-origin request refused",
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

  messagesProof: {
    title: "Messages",
    heading: "Message catalog",
    intro:
      "Every message in the catalog, rendered. Functions are called with «sample» placeholders so each interpolation slot is visible. Proof copy here before any screen ships it.",
    keyHeader: "Key",
    textHeader: "Rendered",
  },

  patterns: {
    title: "Pattern library",
    heading: "Pattern library",
    messagesLink: "Proof the message catalog →",
    intro:
      "Every pattern the app dresses in, on one page. Colors are generated from the seed in src/app/theme/tokens.ts; shapes and type live in src/app/static/base.css. Flip your system color scheme to proof dark mode.",
    colorRoles: "Color roles",
    typeScale: "Type scale",
    buttonsChips: "Buttons and chips",
    formControls: "Form controls",
    table: "Table",
    card: "Card",
    island: "Island",
    islandIntro:
      "A Lit component hydrated client-side, in light DOM so this same stylesheet reaches in. If the counter counts, the Vite island build and hydration chain work:",
  },
};

export type Messages = typeof en;
