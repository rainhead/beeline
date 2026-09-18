import { describe, expect, it } from "vitest";
import {
  collectorText,
  composeLabel,
  coordinatesText,
  dateText,
  layoutSheets,
  locationText,
  methodText,
  type LabelInput,
} from "../src/label-text.js";

// The reference implementation's own example strings, from beeline-1kb.1's
// reading of LabelsSubtaskHandler.js: 'USA:OR:BentonCo Corvallis',
// '44.565 -123.262 72m', '14.VII2025-1.3'.
const corvallis: LabelInput = {
  country: "USA",
  state_province: "OR",
  county: "Benton",
  locality: "Corvallis",
  latitude: 44.5646,
  longitude: -123.262,
  elevation_m: 72,
  date_start: new Date("2025-07-14"),
  date_end: new Date("2025-07-14"),
  sample_number: "1",
  specimen_number: 3,
  kind: "net",
  protocol: "net",
  collectors: [{ display_name: "Peter Abrahamsen", given_name: "Peter", family_name: "Abrahamsen" }],
};

describe("the six label fields", () => {
  it("composes the reference's example label", () => {
    const label = composeLabel(corvallis, "25000001");
    expect(label).toEqual({
      location: "USA:OR:BentonCo Corvallis",
      coordinates: "44.565 -123.262 72m",
      date: "14.VII2025-1.3",
      collector: "P.Abrahamsen",
      method: "net",
      number: "25000001",
      warnings: null,
    });
  });

  it("appends Co to a county only in the US, and abbreviates BC's regional districts", () => {
    expect(locationText({ country: "CAN", state_province: "BC", county: "Capital", locality: "Victoria" })).toBe(
      "CAN:BC:CRD Victoria",
    );
    expect(locationText({ country: "CAN", state_province: "BC", county: "Nanaimo", locality: "Nanaimo" })).toBe(
      "CAN:BC:RDN Nanaimo",
    );
    expect(locationText({ country: "USA", state_province: "NM", county: "Doña Ana", locality: "Las Cruces" })).toBe(
      "USA:NM:Dona AnaCo Las Cruces",
    );
  });

  it("never prints iNaturalist's or the geocoder's disambiguating suffix on a county", () => {
    // Real values from the store (beeline-gr7); the first printed on 172 labels.
    const at = (county: string) => locationText({ country: "USA", state_province: "WA", county, locality: "Hanford Reach NM" });
    expect(at("Franklin County, US, WA")).toBe("USA:WA:FranklinCo Hanford Reach NM");
    expect(at("Lincoln County, US, WA")).toBe("USA:WA:LincolnCo Hanford Reach NM");
    expect(at("Washington , US, ID")).toBe("USA:WA:WashingtonCo Hanford Reach NM");
    // A bare name that happens to end in County is its name, and is left alone.
    expect(locationText({ country: "CAN", state_province: "AB", county: "Strathcona County", locality: "Ardrossan" })).toBe(
      "CAN:AB:Strathcona County Ardrossan",
    );
  });

  it("prints no county clause when the county is missing, and no trailing space when the locality is", () => {
    expect(locationText({ country: "USA", state_province: "OR", county: null, locality: "Bend" })).toBe("USA:OR Bend");
    expect(locationText({ country: "USA", state_province: "OR", county: "Deschutes", locality: null })).toBe(
      "USA:OR:DeschutesCo",
    );
  });

  it("rounds coordinates to three decimals and omits an unknown elevation", () => {
    expect(coordinatesText({ latitude: 45.1234567, longitude: -122.9876543, elevation_m: null })).toBe(
      "45.123 -122.988",
    );
    expect(coordinatesText({ latitude: 45, longitude: -122, elevation_m: 1500 })).toBe("45.000 -122.000 1500m");
  });

  it("prints a trap range with both ends and strips hyphens from the series number", () => {
    expect(
      dateText({
        date_start: new Date("2025-07-14"),
        date_end: new Date("2025-07-21"),
        sample_number: "OBAS-00657",
        specimen_number: 12,
      }),
    ).toBe("14.VII-21.VII2025-OBAS00657.12");
  });

  it("prints both years when a trap range crosses one", () => {
    expect(
      dateText({
        date_start: new Date("2025-12-28"),
        date_end: new Date("2026-01-04"),
        sample_number: "WBAS-1",
        specimen_number: 1,
      }),
    ).toBe("28.XII2025-4.I2026-WBAS1.1");
  });

  it("reads nest off the protocol and otherwise prints the kind", () => {
    expect(methodText({ kind: "trap", protocol: "Trap nest" })).toBe("nest");
    expect(methodText({ kind: "trap", protocol: "vane trap" })).toBe("trap");
    expect(methodText({ kind: "net", protocol: null })).toBe("net");
  });
});

describe("the collector line", () => {
  const michael = { display_name: "Michael O'Loughlin", given_name: "Michael", family_name: "O'Loughlin" };
  const dan = { display_name: "Dan O'Loughlin", given_name: "Dan", family_name: "O'Loughlin" };
  const sheehy = { display_name: "Sarah Sheehy", given_name: "Sarah", family_name: "Sheehy" };
  const malaby = { display_name: "Sam Malaby", given_name: "Sam", family_name: "Malaby" };

  it("sets one collector tight, as every label in the drawers reads", () => {
    expect(collectorText([michael])).toBe("M.O'Loughlin");
  });

  it("says a shared family name once for a pair", () => {
    expect(collectorText([michael, dan])).toBe("M.&D.O'Loughlin");
  });

  it("prints both names in full when the family names differ", () => {
    expect(collectorText([sheehy, malaby])).toBe("S.Sheehy&S.Malaby");
  });

  it("does not collapse across a label_name override or an unparted name", () => {
    expect(collectorText([michael, { ...dan, label_name: "D. J. O'Loughlin" }])).toBe(
      "M.O'Loughlin&D. J. O'Loughlin",
    );
    expect(collectorText([michael, { display_name: "O'Loughlin" }])).toBe("M.O'Loughlin&O'Loughlin");
  });

  it("warns, and does not refuse, when a line is longer than the label was drawn for", () => {
    const four = [michael, dan, sheehy, malaby];
    const label = composeLabel({ ...corvallis, collectors: four, county: null }, "25000001");
    expect(label.collector).toBe("M.O'Loughlin&D.O'Loughlin&S.Sheehy&S.Malaby");
    expect(label.warnings).toBe("county missing; collector line long");
  });
});

describe("laying labels out on sheets", () => {
  it("skips a cell where the collector changes and starts a new sheet at 250", () => {
    // 249 labels for one collector, then 5 for another: the blank lands on
    // cell 249 of sheet 1 and the second collector begins sheet 2 at cell 0.
    const labels = [...Array(249).fill("A.Ash"), ...Array(5).fill("B.Birch")];
    const laid = layoutSheets(labels, (l) => l);
    expect(laid[248]).toEqual({ label: "A.Ash", sheet: 1, cell: 248 });
    expect(laid[249]).toEqual({ label: "B.Birch", sheet: 2, cell: 0 });
    expect(laid[253]).toEqual({ label: "B.Birch", sheet: 2, cell: 4 });
    expect(laid).toHaveLength(254);
  });

  it("puts the blank mid-sheet when the change falls there", () => {
    const laid = layoutSheets(["A", "A", "B"], (l) => l);
    expect(laid.map((l) => l.cell)).toEqual([0, 1, 3]);
  });
});
