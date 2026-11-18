/**
 * Ideal Logic: who has registered for Master Melittology (beeline-w8ab.1).
 *
 * Ideal Logic is the registration platform OSU Extension uses. Since
 * 2026-11-18 it gives Beeline one HTTP endpoint that returns every registrant:
 * a name, an email address, a home address, the atlases they said they belong
 * to, and an iNaturalist handle they typed. This file is the only code that
 * calls it.
 *
 * What Beeline does with the answer is decided elsewhere, by one rule (Peter,
 * 2026-11-18): **an address or an email address is never written to
 * Beeline's disk.** It is fetched when it is needed and dropped when the
 * request that needed it ends. Three things here follow from that rule:
 *
 * - Every error this file throws has fixed text: a status and a count, never
 *   a piece of the response and never Ideal Logic's own message. The job
 *   framework writes an error's message into `job_run.detail`, which is in
 *   the store and its backups, and its stack into the log. `JSON.parse`
 *   quotes the text it failed on, which here is somebody's record.
 * - A `Registrant` keeps the private fields under `email` and `address` and
 *   nowhere else, so that a reader can see where they go.
 * - Nothing is cached between calls. The one thing shared is a fetch that is
 *   still under way: a second call that arrives meanwhile (a double click, a
 *   download during the night's job) waits for that answer rather than
 *   spending another request, and the answer is forgotten the moment the
 *   fetch settles.
 *
 * Ideal Logic allows 100 requests a day, and one request returns everybody,
 * so the list is fetched whole and never per person or per page.
 */

export const IDEAL_LOGIC_URL = "https://apps.ideal-logic.com/api/f36e9b6c.json";

/**
 * How many requests Beeline lets itself make in one Pacific day. Ideal Logic
 * allows 100; the rest is left for a person working by hand. A night's job
 * and its retries use about a dozen at worst, and each download of a print
 * run's addresses uses one.
 */
export const DAILY_REQUEST_BUDGET = 60;

/** How long one request, with the reading of its body, may take before Beeline gives up. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** A home address as Ideal Logic holds it. Never stored: see the head of this file. */
export interface RegistrantAddress {
  /** May hold several lines. */
  street: string;
  city: string | null;
  /** A USPS or Canada Post code. Ideal Logic has a field for US states only; a province is derived from the postal code. */
  stateProvince: string | null;
  postalCode: string | null;
  /** ISO 3166-1 alpha-3, matching `atlas_region.country`. Null where neither a state nor a Canadian postal code says. */
  country: "USA" | "CAN" | null;
}

export interface Registrant {
  /** Ideal Logic's id for the registration, such as `QNN6-MX8`. */
  id: string;
  givenName: string;
  familyName: string;
  /** Program codes (`OBA`, `WaBA`, `BC`, `ID`, `NM`, `MM`), in the order given. Empty where the question was not answered. */
  atlases: string[];
  /** The iNaturalist handle the registrant typed, without a leading `@`, where it has the shape of a login; null otherwise. Unverified: "yes" has that shape. */
  inatHandle: string | null;
  /** Never stored: see the head of this file. */
  email: string;
  /** Never stored: see the head of this file. Null where the registration has no street. */
  address: RegistrantAddress | null;
}

/** An error whose message is safe to store and log: it never quotes the response. */
export class IdealLogicError extends Error {
  constructor(
    message: string,
    readonly kind: "no_key" | "budget" | "refused" | "unreadable" | "incomplete" | "unreachable",
  ) {
    super(message);
    this.name = "IdealLogicError";
  }
}

/** What Ideal Logic calls each atlas, and the program code Beeline files it under. */
const ATLAS_CODES: Readonly<Record<string, string>> = {
  Oregon: "OBA",
  Washington: "WaBA",
  "British Columbia": "BC",
  Idaho: "ID",
  "New Mexico": "NM",
  "No Atlas Affiliation": "MM",
};

/**
 * The first letter of a Canadian postal code names its province, with one
 * exception: X is shared by Nunavut and the Northwest Territories, so it
 * names neither.
 */
const PROVINCE_BY_LETTER: Readonly<Record<string, string>> = {
  A: "NL",
  B: "NS",
  C: "PE",
  E: "NB",
  G: "QC",
  H: "QC",
  J: "QC",
  K: "ON",
  L: "ON",
  M: "ON",
  N: "ON",
  P: "ON",
  R: "MB",
  S: "SK",
  T: "AB",
  V: "BC",
  Y: "YT",
};

/** The shape of an iNaturalist login: a letter, then letters, digits, underscores and hyphens. No space, no dot, no @. */
const INAT_LOGIN = /^[A-Za-z][A-Za-z0-9_-]{1,59}$/;

const CANADIAN_POSTAL_CODE = /^([A-Za-z])\d[A-Za-z]\s*\d[A-Za-z]\d/;

/** Whether a postal code has the shape of a Canadian one (`V8W 1P6`, `v8w1p6`). */
export function isCanadianPostalCode(postalCode: string | null | undefined): boolean {
  return CANADIAN_POSTAL_CODE.test((postalCode ?? "").trim());
}

/**
 * The province a Canadian postal code is in, or null where the code is not
 * Canadian or its first letter names no single province. Ideal Logic's feed
 * has no province field (asked for, beeline-w8ab.5), and 88 of its 737
 * addresses were Canadian on 2026-11-18.
 */
export function provinceFromPostalCode(postalCode: string | null | undefined): string | null {
  const m = CANADIAN_POSTAL_CODE.exec((postalCode ?? "").trim());
  if (!m) return null;
  return PROVINCE_BY_LETTER[m[1]!.toUpperCase()] ?? null;
}

const text = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

/**
 * One record of the response as a `Registrant`, or null where it lacks what
 * every record has had (an id, both name parts, an email address). A null is
 * counted by the caller and never described.
 */
export function parseRegistrant(raw: unknown): Registrant | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = text(r.id);
  const givenName = text(r.first_name);
  const familyName = text(r.last_name);
  const email = text(r.email_address);
  if (id === null || givenName === null || familyName === null || email === null) return null;

  const atlases: string[] = [];
  if (Array.isArray(r.cf_atlas)) {
    for (const a of r.cf_atlas) {
      const code = typeof a === "string" ? ATLAS_CODES[a.trim()] : undefined;
      if (code !== undefined && !atlases.includes(code)) atlases.push(code);
    }
  }

  // The question is free text, and what is typed there is kept in the store.
  // So only something shaped like a login is taken for one: people have
  // typed display names and "yes" (harmless), and could type an email
  // address, which must not be stored.
  const typed = text(r.cf_inaturalist_handle)?.replace(/^@+/, "").trim() ?? null;
  const handle = typed !== null && INAT_LOGIN.test(typed) ? typed : null;

  const street = text(r.home_address_street);
  let address: RegistrantAddress | null = null;
  if (street !== null) {
    const postalCode = text(r.home_address_postal_code);
    const state = text(r.home_address_us_state);
    const province = state === null ? provinceFromPostalCode(postalCode) : null;
    address = {
      street: street.replace(/\r\n?/g, "\n"),
      city: text(r.home_address_city),
      stateProvince: state ?? province,
      postalCode,
      country: state !== null ? "USA" : isCanadianPostalCode(postalCode) ? "CAN" : null,
    };
  }

  return { id, givenName, familyName, atlases, inatHandle: handle, email, address };
}

type FetchResponse = {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};
export type IdealLogicFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchResponse>;

/** The Pacific calendar day of an instant, as `2026-11-18`: the day the budget is counted in. */
const pacificDay = (at: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(at);

/**
 * Counts the requests made today and refuses the one that would pass
 * `DAILY_REQUEST_BUDGET`. Attempts are counted, not successes: Ideal Logic
 * counts a request it refused. Kept in memory, so a restart forgets the
 * count; nothing fetches at boot, so a machine that restarts in a loop makes
 * no requests.
 */
export class RequestBudget {
  private day = "";
  private used = 0;

  constructor(
    private readonly limit: number = DAILY_REQUEST_BUDGET,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** How many requests are left today. */
  remaining(): number {
    this.roll();
    return Math.max(0, this.limit - this.used);
  }

  /** Count one request, or throw when today's are spent. */
  spend(): void {
    this.roll();
    if (this.used >= this.limit) {
      throw new IdealLogicError(
        `Beeline has made ${this.used} requests to Ideal Logic today, which is its limit; it can ask again after midnight Pacific time`,
        "budget",
      );
    }
    this.used += 1;
  }

  private roll(): void {
    const today = pacificDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
  }
}

export interface IdealLogicClient {
  /**
   * Every registrant, in one request. Throws an `IdealLogicError`, whose message never quotes the response.
   * A call made while another is still under way waits for that one's answer and costs nothing; the signal of the call that started the fetch governs it.
   */
  fetchRegistrants(opts?: { signal?: AbortSignal }): Promise<Registrant[]>;
  /** How many requests Beeline may still make today. */
  remaining(): number;
}

/**
 * A client for one key. One per process, so that the night's job and the
 * downloads draw on one budget.
 */
export function createIdealLogicClient(opts: {
  key: string;
  fetchImpl?: IdealLogicFetch;
  budget?: RequestBudget;
  url?: string;
  /** How long the request and the reading of its body may take together. Defaults to `REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
}): IdealLogicClient {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as IdealLogicFetch);
  const budget = opts.budget ?? new RequestBudget();
  const url = opts.url ?? IDEAL_LOGIC_URL;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const fetchOnce = async (signal: AbortSignal | undefined): Promise<Registrant[]> => {
    budget.spend();
    let res: FetchResponse;
    let body: string;
    // A stalled response must not hold the night's job: the caller's signal
    // and a deadline are combined.
    const limit = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    try {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${opts.key}` }, signal: limit });
      body = await res.text();
    } catch (err) {
      if (signal?.aborted) throw err;
      // The cause is left off on purpose: a network error's text is not
      // ours to vouch for, and the stack is logged.
      throw new IdealLogicError("Ideal Logic could not be reached", "unreachable");
    }
    // Every failure is a 404 with a message, by Ideal Logic's own account.
    // The message is not repeated: only the status is ours to store.
    if (res.status !== 200) {
      throw new IdealLogicError(`Ideal Logic refused the request (HTTP ${res.status})`, "refused");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new IdealLogicError(
        `Ideal Logic's answer could not be read as JSON (${body.length} characters)`,
        "unreadable",
      );
    }
    if (!Array.isArray(parsed)) {
      throw new IdealLogicError("Ideal Logic's answer was not a list of registrants", "unreadable");
    }
    // Without paging parameters the answer holds everybody, and the header
    // says how many that is. A shorter list means the default changed, and
    // a job that took it for everybody would report registrants as gone.
    const header = res.headers.get("x-numresults");
    const total = header === null || header.trim() === "" ? NaN : Number(header);
    if (!Number.isInteger(total)) {
      throw new IdealLogicError(
        "Ideal Logic did not say how many registrants there are, so the list cannot be checked for completeness",
        "incomplete",
      );
    }
    if (total !== parsed.length) {
      throw new IdealLogicError(
        `Ideal Logic returned ${parsed.length} registrants and said there are ${total}`,
        "incomplete",
      );
    }
    const registrants: Registrant[] = [];
    let unreadable = 0;
    for (const raw of parsed) {
      const r = parseRegistrant(raw);
      if (r === null) unreadable += 1;
      else registrants.push(r);
    }
    // A few malformed records are Ideal Logic's to fix and not a reason to
    // mail nobody; most of them malformed is a changed format.
    if (unreadable > parsed.length / 10) {
      throw new IdealLogicError(
        `${unreadable} of Ideal Logic's ${parsed.length} records lacked an id, a name or an email address`,
        "unreadable",
      );
    }
    return registrants;
  };

  // The fetch under way, if any. Cleared when it settles, so that no answer
  // outlives the request that needed it.
  let inFlight: Promise<Registrant[]> | null = null;
  return {
    remaining: () => budget.remaining(),
    fetchRegistrants({ signal } = {}) {
      if (inFlight !== null) return inFlight;
      const started = fetchOnce(signal).finally(() => {
        if (inFlight === started) inFlight = null;
      });
      inFlight = started;
      return started;
    },
  };
}
