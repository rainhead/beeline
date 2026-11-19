import { describe, expect, it } from "vitest";
import { fingerprintEmail, parseEmailKey } from "../src/email-fingerprint.js";

const KEY = Buffer.alloc(48, 7);

describe("fingerprintEmail", () => {
  it("gives one fingerprint to an address in any case, with or without spaces around it", () => {
    const plain = fingerprintEmail(KEY, "ada@example.org");
    expect(fingerprintEmail(KEY, "  Ada@Example.ORG ")).toBe(plain);
    expect(plain).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives another address another fingerprint", () => {
    expect(fingerprintEmail(KEY, "ada@example.org")).not.toBe(fingerprintEmail(KEY, "bo@example.org"));
  });

  it("gives the same address another fingerprint under another key", () => {
    expect(fingerprintEmail(KEY, "ada@example.org")).not.toBe(fingerprintEmail(Buffer.alloc(48, 8), "ada@example.org"));
  });

  it("never contains the address or any part of it", () => {
    const fp = fingerprintEmail(KEY, "ada@example.org");
    for (const piece of ["ada", "example", "org", "@"]) expect(fp).not.toContain(piece);
  });
});

describe("parseEmailKey", () => {
  it("is off where the key is unset or blank", () => {
    expect(parseEmailKey(undefined)).toBeNull();
    expect(parseEmailKey("  ")).toBeNull();
  });

  it("reads a base64 key of 32 bytes or more", () => {
    expect(parseEmailKey(KEY.toString("base64"))?.length).toBe(48);
    expect(parseEmailKey(Buffer.alloc(32, 1).toString("base64"))?.length).toBe(32);
  });

  it("refuses a short key without quoting it", () => {
    const short = Buffer.alloc(31, 1).toString("base64");
    expect(() => parseEmailKey(short)).toThrow(/REGISTRATION_EMAIL_KEY.*32 bytes/);
    try {
      parseEmailKey(short);
    } catch (err) {
      expect((err as Error).message).not.toContain(short);
    }
  });
});
