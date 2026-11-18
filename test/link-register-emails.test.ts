import { describe, expect, test } from "vitest";
import type { Registrant } from "../src/ideal-logic.js";
import { matchByRegisterEmail, readPeople, readRegister, retryAfterSeconds, sendLinks, type StorePerson } from "../src/link-register-emails.js";

/**
 * Linking people to registrations through the old register's email addresses
 * (src/link-register-emails.ts). Everybody is invented; the cases are the
 * ones the real files of 2026-11-18 held.
 */

const registrant = (id: string, givenName: string, familyName: string, email: string): Registrant => ({
  id,
  givenName,
  familyName,
  email,
  atlases: [],
  inatHandle: null,
  address: null,
});

const PEOPLE: StorePerson[] = [
  { entity_id: 1, display_name: "Ada Bramble", login: "adabramble" },
  { entity_id: 2, display_name: "Cy Yarrow", login: "yarrows" },
  { entity_id: 3, display_name: "Dot Yarrow", login: null },
  { entity_id: 4, display_name: "Richard Fescue", login: "rfescue" },
];

const REGISTER = [
  { email: "Ada@Example.org ", login: "AdaBramble" },
  // A household: two addresses, one login, which only Cy holds.
  { email: "cy@example.org", login: "yarrows" },
  { email: "dot@example.org", login: "yarrows" },
  { email: "rick@example.org", login: "rfescue" },
  // One address the register lists under two logins.
  { email: "shared@example.org", login: "adabramble" },
  { email: "shared@example.org", login: "rfescue" },
  // A login nobody in the store holds.
  { email: "gone@example.org", login: "departed" },
  { email: "", login: "adabramble" },
];

describe("matching by the register's email addresses", () => {
  test("links where the email reaches one login, one person holds it, and the full name agrees", () => {
    const got = matchByRegisterEmail([registrant("A-1", "Ada", "Bramble", "ada@example.org")], REGISTER, PEOPLE);
    expect(got.links).toEqual([{ personId: 1, login: "adabramble", displayName: "Ada Bramble", idealLogicId: "A-1" }]);
  });

  test("a household that shares a login: the holder links, the other is left for staff", () => {
    const got = matchByRegisterEmail(
      [registrant("C-1", "Cy", "Yarrow", "cy@example.org"), registrant("D-1", "Dot", "Yarrow", "dot@example.org")],
      REGISTER,
      PEOPLE,
    );
    expect(got.links).toEqual([{ personId: 2, login: "yarrows", displayName: "Cy Yarrow", idealLogicId: "C-1" }]);
    expect(got.toStaff.nameDiffers).toBe(1);
  });

  test("a nickname is not the name: Rick for Richard goes to staff", () => {
    const got = matchByRegisterEmail([registrant("R-1", "Rick", "Fescue", "rick@example.org")], REGISTER, PEOPLE);
    expect(got.links).toEqual([]);
    expect(got.toStaff).toEqual({ loginAmbiguous: 0, loginUnheld: 0, nameDiffers: 1, alreadyMatched: 0 });
  });

  test("an email under several logins, and a login nobody holds, link nobody", () => {
    const got = matchByRegisterEmail(
      [registrant("S-1", "Ada", "Bramble", "shared@example.org"), registrant("G-1", "Gus", "Gone", "gone@example.org")],
      REGISTER,
      PEOPLE,
    );
    expect(got.links).toEqual([]);
    expect(got.toStaff).toMatchObject({ loginAmbiguous: 1, loginUnheld: 1 });
  });

  test("an email the register does not have is not counted at all", () => {
    const got = matchByRegisterEmail([registrant("N-1", "Nan", "Newcomer", "nan@example.org")], REGISTER, PEOPLE);
    expect(got).toEqual({ links: [], toStaff: { loginAmbiguous: 0, loginUnheld: 0, nameDiffers: 0, alreadyMatched: 0 } });
  });

  test("a person who registered twice is linked to neither registration, whichever Ideal Logic lists first", () => {
    const register = [...REGISTER, { email: "ada.new@example.org", login: "adabramble" }];
    const got = matchByRegisterEmail(
      [registrant("A-1", "Ada", "Bramble", "ada@example.org"), registrant("A-2", "Ada", "Bramble", "ada.new@example.org")],
      register,
      PEOPLE,
    );
    expect(got.links).toEqual([]);
    expect(got.toStaff.alreadyMatched).toBe(2);
  });

  test("a name with no ASCII letters agrees with nothing, since it folds to nothing", () => {
    const people: StorePerson[] = [{ entity_id: 9, display_name: "李 雷", login: "lilei" }];
    const got = matchByRegisterEmail([registrant("L-1", "韓", "梅梅", "han@example.org")], [{ email: "han@example.org", login: "lilei" }], people);
    expect(got.links).toEqual([]);
    expect(got.toStaff.nameDiffers).toBe(1);
  });
});

describe("reading the files", () => {
  test("the register by its header, whatever the column order, with a byte-order mark", () => {
    const text = '﻿userLogin,fullName,email,address\nadabramble,Ada Bramble,ada@example.org,"12 Clover Lane, Unit 4"\n';
    expect(readRegister(text)).toEqual([{ email: "ada@example.org", login: "adabramble" }]);
    expect(() => readRegister("userLogin,fullName\nx,y\n")).toThrow("no email or userLogin column");
  });

  test("the people as pnpm store:query --json writes them", () => {
    const text = JSON.stringify({
      columns: [{ name: "entity_id" }, { name: "display_name" }, { name: "login" }],
      rows: [
        [1, "Ada Bramble", "adabramble"],
        [3, "Dot Yarrow", null],
      ],
    });
    expect(readPeople(text)).toEqual([
      { entity_id: 1, display_name: "Ada Bramble", login: "adabramble" },
      { entity_id: 3, display_name: "Dot Yarrow", login: null },
    ]);
  });
});

describe("sending the links", () => {
  const link = { personId: 1, login: "ada.bramble/x", displayName: "Ada Bramble", idealLogicId: "A-1" };
  const opts = { origin: "https://beeline.example.org", apiKey: "test-key", reference: null };
  const ok = () => new Response(JSON.stringify({ outcome: "saved" }), { status: 200 });

  test("addresses the person by login, encoded, not by store id", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return ok();
    }) as unknown as typeof fetch;
    const got = await sendLinks([link], opts, { out: () => {}, fetchImpl });
    expect(urls).toEqual(["https://beeline.example.org/api/v1/people/ada.bramble%2Fx/registration"]);
    expect(got.counts.get("saved")).toBe(1);
  });

  test("on a 429 waits for Retry-After and sends the same link again", async () => {
    const answers = [new Response("", { status: 429, headers: { "retry-after": "7" } }), ok()];
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(init.body);
      return answers.shift()!;
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    const got = await sendLinks([link], opts, { out: () => {}, fetchImpl, sleep: async (s) => void waits.push(s) });
    expect(waits).toEqual([7]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(got).toEqual({ counts: new Map([["saved", 1]]), failed: 0 });
  });

  test("counts a link as refused after five answers of 429", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("", { status: 429 });
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const got = await sendLinks([link], opts, { out: (t) => void lines.push(t), fetchImpl, sleep: async () => {} });
    expect(calls).toBe(5);
    expect(got.failed).toBe(1);
    expect(lines).toEqual(["ada.bramble/x\tAda Bramble\tHTTP 429\n"]);
  });

  test("another status is refused at once, without a retry", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("", { status: 409 });
    }) as unknown as typeof fetch;
    const got = await sendLinks([link], opts, { out: () => {}, fetchImpl, sleep: async () => {} });
    expect(calls).toBe(1);
    expect(got.failed).toBe(1);
  });

  test("the wait is 5 seconds when the header is missing or not a number, and at most 60", () => {
    expect([retryAfterSeconds(null), retryAfterSeconds("soon"), retryAfterSeconds("3"), retryAfterSeconds("900")]).toEqual([5, 5, 3, 60]);
  });
});
