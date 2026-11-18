import { describe, expect, test } from "vitest";
import {
  createIdealLogicClient,
  IdealLogicError,
  parseRegistrant,
  provinceFromPostalCode,
  RequestBudget,
  type IdealLogicFetch,
} from "../src/ideal-logic.js";

/**
 * The Ideal Logic client (src/ideal-logic.ts). Every person here is invented:
 * the real response is names, email addresses and home addresses, and a copy
 * of it has no place in a public repository. The shapes are the real ones,
 * read off the response of 2026-11-18: a field with no value is absent or
 * null, a street can hold two lines joined by \r\n, an atlas is a list, and
 * a Canadian address has a postal code and no state.
 */

const OREGON = {
  id: "AB12-CDE3",
  identification: "Ada Bramble",
  first_name: "Ada",
  last_name: "Bramble",
  email_address: "ada@example.org",
  home_address_street: "12 Clover Lane\r\nUnit 4",
  home_address_city: "Corvallis",
  home_address_us_state: "OR",
  home_address_postal_code: "97330",
  cf_atlas: ["Oregon", "Washington"],
  cf_inaturalist_handle: " @AdaBramble ",
};

const CANADIAN = {
  id: "ZZ99-QQQ1",
  identification: "Bo Sedge",
  first_name: "Bo",
  last_name: "Sedge",
  email_address: "bo@example.org",
  home_address_street: "7 Fireweed Road",
  home_address_city: "Victoria",
  home_address_postal_code: "v8w 1p6",
  cf_atlas: ["British Columbia"],
};

const BARE = {
  id: "MM00-NNN2",
  identification: "Cy Yarrow",
  first_name: "Cy",
  last_name: "Yarrow",
  email_address: "cy@example.org",
  home_address_street: null,
  home_address_postal_code: null,
};

function fakeIdealLogic(body: string, opts: { status?: number; total?: string | null } = {}) {
  const asked: Array<{ url: string; authorization: string | undefined }> = [];
  const fetchImpl: IdealLogicFetch = async (url, init) => {
    asked.push({ url, authorization: init.headers.Authorization });
    return {
      status: opts.status ?? 200,
      headers: { get: (name) => (name.toLowerCase() === "x-numresults" ? (opts.total ?? null) : null) },
      text: async () => body,
    };
  };
  return { fetchImpl, asked };
}

describe("reading a registration", () => {
  test("a US address, several atlases, and a handle typed with an @ and spaces", () => {
    expect(parseRegistrant(OREGON)).toEqual({
      id: "AB12-CDE3",
      givenName: "Ada",
      familyName: "Bramble",
      atlases: ["OBA", "WaBA"],
      inatHandle: "AdaBramble",
      email: "ada@example.org",
      address: { street: "12 Clover Lane\nUnit 4", city: "Corvallis", stateProvince: "OR", postalCode: "97330", country: "USA" },
    });
  });

  test("a Canadian address gets its province and country from the postal code", () => {
    expect(parseRegistrant(CANADIAN)?.address).toEqual({
      street: "7 Fireweed Road",
      city: "Victoria",
      stateProvince: "BC",
      postalCode: "v8w 1p6",
      country: "CAN",
    });
  });

  test("no street is no address, and unanswered questions are empty", () => {
    expect(parseRegistrant(BARE)).toMatchObject({ address: null, atlases: [], inatHandle: null });
  });

  // The handle is the one free-text answer Beeline stores, so what is not
  // shaped like a login is dropped: above all an email address.
  test("a handle is kept only where it has the shape of a login", () => {
    const handle = (typed: string) => parseRegistrant({ ...BARE, cf_inaturalist_handle: typed })?.inatHandle;
    expect(handle("sundodger")).toBe("sundodger");
    expect(handle("@neri_a")).toBe("neri_a");
    expect(handle("bee-keeper2")).toBe("bee-keeper2");
    for (const typed of ["cy@example.org", "sun dodger", "Cy Yarrow", "inaturalist.org/people/cy", "12 Clover Lane", "@", "x"]) {
      expect(handle(typed)).toBeNull();
    }
  });

  test("'No Atlas Affiliation' is Master Melittology itself, and an atlas Beeline has no program for is left out", () => {
    expect(parseRegistrant({ ...BARE, cf_atlas: ["No Atlas Affiliation", "Atlantis"] })?.atlases).toEqual(["MM"]);
  });

  test("a record with no id, name or email address is not a registrant", () => {
    expect(parseRegistrant({ ...BARE, email_address: " " })).toBeNull();
    expect(parseRegistrant({ ...BARE, id: undefined })).toBeNull();
    expect(parseRegistrant("Cy Yarrow")).toBeNull();
  });
});

describe("the province of a Canadian postal code", () => {
  test("is named by the first letter", () => {
    expect(provinceFromPostalCode("V8W 1P6")).toBe("BC");
    expect(provinceFromPostalCode("t2p1j9")).toBe("AB");
    expect(provinceFromPostalCode(" K1A 0B1.")).toBe("ON");
  });

  test("is not guessed for X, which Nunavut and the Northwest Territories share", () => {
    expect(provinceFromPostalCode("X0A 0H0")).toBeNull();
  });

  test("is not read off a US ZIP code or nothing", () => {
    expect(provinceFromPostalCode("97330")).toBeNull();
    expect(provinceFromPostalCode("97330-1234")).toBeNull();
    expect(provinceFromPostalCode(null)).toBeNull();
  });
});

describe("fetching", () => {
  test("one request for everybody, with the key as a bearer token", async () => {
    const { fetchImpl, asked } = fakeIdealLogic(JSON.stringify([OREGON, CANADIAN, BARE]), { total: "3" });
    const client = createIdealLogicClient({ key: "secret", fetchImpl });
    const got = await client.fetchRegistrants();
    expect(got.map((r) => r.id)).toEqual(["AB12-CDE3", "ZZ99-QQQ1", "MM00-NNN2"]);
    expect(asked).toEqual([{ url: "https://apps.ideal-logic.com/api/f36e9b6c.json", authorization: "Bearer secret" }]);
  });

  test("a shorter list than Ideal Logic says there is fails, so nobody is reported gone", async () => {
    const { fetchImpl } = fakeIdealLogic(JSON.stringify([OREGON]), { total: "826" });
    await expect(createIdealLogicClient({ key: "k", fetchImpl }).fetchRegistrants()).rejects.toThrow(
      "Ideal Logic returned 1 registrants and said there are 826",
    );
  });

  test("a list with no count, or one that is not a number, fails without quoting it", async () => {
    for (const total of [null, "", "many"]) {
      const { fetchImpl } = fakeIdealLogic(JSON.stringify([OREGON]), { total });
      const err = await createIdealLogicClient({ key: "k", fetchImpl })
        .fetchRegistrants()
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IdealLogicError);
      expect((err as IdealLogicError).kind).toBe("incomplete");
      expect((err as Error).message).toBe(
        "Ideal Logic did not say how many registrants there are, so the list cannot be checked for completeness",
      );
    }
  });

  test("a response that never arrives gives up at the deadline", async () => {
    const fetchImpl: IdealLogicFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted with details")));
      });
    const err = await createIdealLogicClient({ key: "k", fetchImpl, timeoutMs: 20 })
      .fetchRegistrants()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdealLogicError);
    expect((err as IdealLogicError).kind).toBe("unreachable");
    expect((err as Error).message).toBe("Ideal Logic could not be reached");
  });

  test("the caller's own abort is rethrown as it was", async () => {
    const controller = new AbortController();
    const fetchImpl: IdealLogicFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("caller stopped")));
      });
    const pending = createIdealLogicClient({ key: "k", fetchImpl }).fetchRegistrants({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("caller stopped");
  });

  // The job framework stores an error's message in the store and logs its
  // stack, and JSON.parse quotes the text it failed on. So what is thrown
  // must never contain a piece of the response.
  test("an answer cut short fails without quoting any of it", async () => {
    const whole = JSON.stringify([OREGON, CANADIAN]);
    const { fetchImpl } = fakeIdealLogic(whole.slice(0, whole.indexOf("Clover") + 9));
    const err = await createIdealLogicClient({ key: "k", fetchImpl })
      .fetchRegistrants()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdealLogicError);
    const said = `${(err as Error).message}\n${(err as Error).stack}\n${String((err as Error).cause ?? "")}`;
    for (const piece of ["Clover", "Bramble", "ada@example.org", "Corvallis"]) expect(said).not.toContain(piece);
    expect((err as Error).message).toMatch(/could not be read as JSON \(\d+ characters\)/);
  });

  test("a refusal reports the status and not Ideal Logic's message", async () => {
    const { fetchImpl } = fakeIdealLogic("Private key required as POST variable 'key'", { status: 404 });
    await expect(createIdealLogicClient({ key: "k", fetchImpl }).fetchRegistrants()).rejects.toThrow(
      /^Ideal Logic refused the request \(HTTP 404\)$/,
    );
  });

  test("a network failure says only that Ideal Logic could not be reached", async () => {
    const fetchImpl: IdealLogicFetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND apps.ideal-logic.com?key=secret");
    };
    const err = await createIdealLogicClient({ key: "secret", fetchImpl })
      .fetchRegistrants()
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("Ideal Logic could not be reached");
    expect((err as Error).cause).toBeUndefined();
  });

  test("a few malformed records are left out; most of them malformed is a changed format", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ ...BARE, id: `AA00-BBB${i}` }));
    const few = fakeIdealLogic(JSON.stringify([...eleven, { id: "XX" }]), { total: "12" });
    expect(await createIdealLogicClient({ key: "k", fetchImpl: few.fetchImpl }).fetchRegistrants()).toHaveLength(11);
    const most = fakeIdealLogic(JSON.stringify([OREGON, { id: "XX" }, { id: "YY" }]), { total: "3" });
    await expect(createIdealLogicClient({ key: "k", fetchImpl: most.fetchImpl }).fetchRegistrants()).rejects.toThrow(
      "2 of Ideal Logic's 3 records lacked an id, a name or an email address",
    );
  });
});

describe("the day's requests", () => {
  test("are counted whether or not they succeed, and refused past the limit", async () => {
    let now = new Date("2026-11-18T20:00:00Z");
    const budget = new RequestBudget(2, () => now);
    const { fetchImpl, asked } = fakeIdealLogic("nope", { status: 404 });
    const client = createIdealLogicClient({ key: "k", fetchImpl, budget });
    await expect(client.fetchRegistrants()).rejects.toThrow("refused");
    await expect(client.fetchRegistrants()).rejects.toThrow("refused");
    expect(client.remaining()).toBe(0);
    await expect(client.fetchRegistrants()).rejects.toThrow(
      "Beeline has made 2 requests to Ideal Logic today, which is its limit",
    );
    expect(asked).toHaveLength(2);

    // The day is Pacific: 07:59 UTC on the 19th is still the 18th there.
    now = new Date("2026-11-19T07:59:00Z");
    expect(client.remaining()).toBe(0);
    now = new Date("2026-11-19T08:01:00Z");
    expect(client.remaining()).toBe(2);
  });
});
