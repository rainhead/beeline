import { describe, expect, it } from "vitest";
import { observationFromSearch } from "../src/app/observation-search.js";

const url = (id: number) => ({ id, fromUrl: true });

describe("reading an observation out of what was typed (beeline-slkv)", () => {
  it.each([
    ["https://www.inaturalist.org/observations/123456789", 123456789],
    ["http://www.inaturalist.org/observations/123456789", 123456789],
    ["https://inaturalist.org/observations/123456789", 123456789],
    ["www.inaturalist.org/observations/123456789", 123456789],
    ["inaturalist.org/observations/123456789", 123456789],
    ["https://www.inaturalist.org/observations/123456789/", 123456789],
    ["https://www.inaturalist.org/observations/123456789?locale=fr", 123456789],
    ["https://www.inaturalist.org/observations/123456789#activity_identification_9", 123456789],
    ["https://www.inaturalist.org/observations/123456789/?a=1#x", 123456789],
    ["  https://www.inaturalist.org/observations/123456789\n", 123456789],
    ["HTTPS://WWW.INATURALIST.ORG/observations/42", 42],
    ["https://inaturalist.ca/observations/777", 777],
    ["https://www.inaturalist.nz/observations/777", 777],
    ["https://www.naturalista.uy/observations/777", 777],
    ["https://uk.inaturalist.org/observations/777", 777],
    ["https://inaturalist.ala.org.au/observations/777", 777],
    ["https://inaturalist.laji.fi/observations/777", 777],
  ])("reads the address %s", (typed, id) => {
    expect(observationFromSearch(typed)).toEqual(url(id));
  });

  it("reads a bare number, and says it was not an address", () => {
    expect(observationFromSearch("12345678")).toEqual({ id: 12345678, fromUrl: false });
    expect(observationFromSearch(" 1234 ")).toEqual({ id: 1234, fromUrl: false });
  });

  it.each([
    "",
    "A-1",
    "barnes",
    "12-3",
    "1234 5678",
    "-5",
    "1.5",
    // a number too long to be an observation's
    "1234567890123456",
    "https://www.inaturalist.org/observations/1234567890123456",
    // another site
    "https://www.example.org/observations/123456789",
    "https://inaturalist.org.evil.example/observations/123456789",
    "https://notinaturalist.org/observations/123456789",
    "https://evilinaturalist.org/observations/123456789",
    "https://naturalista.mx/observations/123456789",
    "https://inaturalist.fi/observations/123456789",
    "https://evil.example/https://www.inaturalist.org/observations/123456789",
    // not an observation page
    "https://www.inaturalist.org/observations/123456789abc",
    "https://www.inaturalist.org/observations/abc",
    "https://www.inaturalist.org/observations/",
    "https://www.inaturalist.org/observations",
    "https://www.inaturalist.org/taxa/123456789",
    "https://www.inaturalist.org/people/123456789",
    "https://www.inaturalist.org/projects/observations/123456789",
    // the UUID form, which Beeline does not store
    "https://www.inaturalist.org/observations/9b2c1a52-5d0f-4a0e-9c1b-0a0b0c0d0e0f",
  ])("does not read %j as an observation", (typed) => {
    expect(observationFromSearch(typed)).toBeNull();
  });
});
