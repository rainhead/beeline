import { describe, expect, test } from "vitest";
import {
  campgroundName,
  fits,
  localityCandidates,
  nameLocality,
  refugeName,
  shortName,
  type GazetteerPlace,
  type LocalityEvidence,
  type Near,
} from "../src/locality-rule.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

// The evidence here is synthetic: what the gazetteer would say about a point,
// written by hand. The names are real ones from the cases that settled the
// rule (beeline-7i6's comments), and the outcomes are the ones the prototype
// gave on the sandbox store.

const nothing: LocalityEvidence = {
  regionId: "US-OR-Benton",
  county: "Benton",
  refuge: null,
  wildlifeArea: null,
  nationalPark: null,
  statePark: null,
  parks: [],
  island: null,
  townLimits: null,
  nearby: [],
  farTowns: [],
  features: [],
  campgrounds: [],
  used: [],
};

let nextId = 1;
function place(name: string, over: Partial<GazetteerPlace> = {}): GazetteerPlace {
  return { id: nextId++, name, kind: "town", fcode: "PPL", pop: 1000, regionId: "US-OR-Benton", islandId: null, ...over };
}
const at = (p: GazetteerPlace, km: number, bearing = 0): Near<GazetteerPlace> => ({ at: p, km, bearing });

describe("names", () => {
  test("a refuge is written the way staff write it", () => {
    expect(refugeName("WILLIAM L. FINLEY NATIONAL WILDLIFE REFUGE")).toBe("Finley NWR");
    expect(refugeName("PEND OREILLE NATIONAL WILDLIFE REFUGE")).toBe("Pend Oreille NWR");
    expect(refugeName("HART MOUNTAIN NATIONAL ANTELOPE REFUGE")).toBe("Hart Mountain NWR");
    // Too long whole: words come off the front, as staff shorten it.
    expect(refugeName("LITTLE PEND OREILLE NATIONAL WILDLIFE REFUGE")).toBe("Pend Oreille NWR");
    expect(refugeName("TUALATIN RIVER NATIONAL WILDLIFE REFUGE")).toBe("Tualatin River NWR");
    expect(refugeName("BOSQUE DEL APACHE NATIONAL WILDLIFE REFUGE")).toBe("Bosque del Apache");
    // Curated: staff write Saddle Mountain as the monument it is part of.
    expect(refugeName("SADDLE MOUNTAIN NATIONAL WILDLIFE REFUGE")).toBe("Hanford Reach NWR");
  });

  test("a name is shortened only as far as 18 characters needs", () => {
    expect(shortName("Mount Vernon")).toBe("Mount Vernon");
    expect(shortName("Mount Hood Village")).toBe("Mount Hood Village");
    expect(shortName("Mount Hood Parkdale")).toBe("Mt Hood Parkdale");
    expect(shortName("Northwestern Experimental Station")).toBeNull();
  });

  test("a name that reads as a street address does not fit, but a Saint does", () => {
    expect(fits("Cedar Mill Rd")).toBe(false);
    expect(fits("St Helens")).toBe(true);
  });

  // fits() restates qc_rule_locality_format in TypeScript, so a name the rule
  // writes is never one the flag would raise. The two must not drift: these
  // are the localities test/qc.test.ts pins the flag with, lifted from
  // production staging, put to both.
  test("fits() agrees with qc_rule_locality_format", async () => {
    const localities = [
      "Sisters, Road 1018", "Bend Twin Bridges Rd", "Alice Street", "Eugene Olive St", "Corvallis SW Orchard Ave",
      "Rdmnd Flcn Cr Drive", "McMinnville NE Elaine Dr", "Corvallis NE Circle Blvd", "Thunderbird Ct",
      "Williams Bonlinda Lane", "Corvallis NE Smith Ln", "Jefferson County", "St Helens", "St. Helens", "St.Helens",
      "W. St. Helens", "St. Johns", "Mosier St Park", "Smith Rock St Prk", "Lane Creek", "Buell County Park",
      'The "Bluff"', "5th St, Corvallis Oregon", "Cottonwood Canyon St Prk",
    ];
    const { conn } = await createMemoryDb();
    await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Adams')`);
    for (const [i, locality] of localities.entries()) {
      await insertCleanSample(conn, { locality: `'${locality.replaceAll("'", "''")}'`, sample_number: `'${i}'` }, null);
    }
    const flagged = new Set(
      ((await rows(conn, `SELECT s.locality FROM qc_rule_locality_format q JOIN sample s ON s.entity_id = q.sample_id`)) as string[][]).map(
        ([l]) => l,
      ),
    );
    for (const locality of localities) expect(fits(locality), locality).toBe(!flagged.has(locality));
  });
});

describe("the rule, in order", () => {
  test("a refuge outranks everything, a wildlife area unit included", () => {
    const e = { ...nothing, refuge: "WILLIAM L. FINLEY NATIONAL WILDLIFE REFUGE", wildlifeArea: { unit: "Wenas", area: "L.T. Murray" } };
    expect(nameLocality(e)).toEqual({ locality: "Finley NWR", basis: "refuge" });
  });

  test("a wildlife area unit is named by the unit, with WLA where it fits", () => {
    expect(nameLocality({ ...nothing, wildlifeArea: { unit: "Whiskey Dick", area: "L.T. Murray" } })).toEqual({
      locality: "Whiskey Dick WLA",
      basis: "wildlife_area",
    });
  });

  test("national, state and provincial parks take their agencies' acronyms", () => {
    expect(nameLocality({ ...nothing, nationalPark: "Olympic National Park" })?.locality).toBe("Olympic NP");
    expect(nameLocality({ ...nothing, statePark: { park: "Ginkgo Petrified Forest", suffix: "SP" } })?.locality).toBe(
      "Ginkgo SP",
    );
    expect(nameLocality({ ...nothing, statePark: { park: "ELK FALLS", suffix: "PP" } })?.locality).toBe("Elk Falls PP");
  });

  test("the smallest park a point is inside, and not a playground", () => {
    const e = {
      ...nothing,
      parks: [
        { name: "Tot Lot", ha: 0.2 },
        { name: "Discovery Park", ha: 216 },
        { name: "Magnolia Greenbelt", ha: 900 },
      ],
      townLimits: { name: "Seattle", kind: "city" as const },
    };
    expect(nameLocality(e)).toEqual({ locality: "Discovery Park", basis: "local_park" });
  });

  test("inside a big city, the neighbourhood; inside a small one, the town", () => {
    const seattle = place("Seattle", { pop: 737_015 });
    const montlake = place("Montlake", { fcode: "PPLX", pop: 0 });
    const big = { ...nothing, townLimits: { name: "Seattle", kind: "city" as const }, nearby: [at(montlake, 0.6), at(seattle, 4)] };
    expect(nameLocality(big)).toEqual({ locality: "Montlake", basis: "neighbourhood" });
    const corvallis = place("Corvallis", { pop: 59_922 });
    const small = { ...nothing, townLimits: { name: "Philomath", kind: "city" as const }, nearby: [at(corvallis, 8)] };
    expect(nameLocality(small)).toEqual({ locality: "Philomath", basis: "town_limits" });
  });

  test("on a small island, only the island's own places, and outside a town the island", () => {
    const ganges = place("Ganges", { pop: 1500, islandId: "saltspring" });
    const e = {
      ...nothing,
      regionId: "CA-BC-CRD",
      island: { id: "galiano", name: "Galiano Island", ha: 6000 },
      nearby: [at(ganges, 6)],
    };
    expect(nameLocality(e)).toEqual({ locality: "Galiano Island", basis: "island" });
  });

  test("a feature volunteers named nearby, before a town", () => {
    const randle = place("Randle", { pop: 1000, regionId: "US-WA-Lewis" });
    const e = {
      ...nothing,
      regionId: "US-WA-Lewis",
      nearby: [at(randle, 25)],
      features: [{ at: { id: 1, name: "Takhlakh Lake", code: "H.LK", samples: 14, collectors: 3, islandId: null }, km: 0.8 }],
    };
    expect(nameLocality(e)).toEqual({ locality: "Takhlakh Lake", basis: "feature" });
  });

  test("a name only one collector used reaches 2 km, not 5", () => {
    const e = {
      ...nothing,
      features: [{ at: { id: 1, name: "Bald Hill", code: "T.HLL", samples: 4, collectors: 1, islandId: null }, km: 3 }],
      nearby: [at(place("Corvallis", { pop: 59_922 }), 6)],
    };
    expect(nameLocality(e)).toEqual({ locality: "Corvallis", basis: "town" });
  });

  test("a peak only when the nearest town is 12 km or more away", () => {
    const ashland = place("Ashland", { pop: 21_000 });
    const peak = place("Mount Ashland", { kind: "peak", pop: 0 });
    expect(nameLocality({ ...nothing, nearby: [at(peak, 1), at(ashland, 13)] })).toEqual({
      locality: "Mount Ashland",
      basis: "peak",
    });
    expect(nameLocality({ ...nothing, nearby: [at(peak, 1), at(ashland, 8)] })).toEqual({
      locality: "Ashland",
      basis: "town",
    });
  });

  test("a town from the point's own county first, then its own state, never across the line", () => {
    const alsea = place("Alsea", { pop: 164, regionId: "US-OR-Benton" });
    const waldport = place("Waldport", { pop: 2033, regionId: "US-OR-Lincoln" });
    expect(nameLocality({ ...nothing, nearby: [at(waldport, 5), at(alsea, 20)] })?.locality).toBe("Alsea");
    expect(nameLocality({ ...nothing, nearby: [at(waldport, 5)] })?.locality).toBe("Waldport");
    // Atlin, BC: Carcross is in the Yukon, so it is no name for the point.
    const carcross = place("Carcross", { pop: 301, regionId: "CA-YT-Yukon" });
    const atlin = { ...nothing, regionId: "CA-BC-SRD", nearby: [at(carcross, 19)], farTowns: [at(carcross, 19, 180)] };
    expect(nameLocality(atlin)).toEqual({ locality: "19km S Carcross", basis: "distance" });
  });

  test("a hamlet before a large reserve, and the reserve before a distance", () => {
    const galena = place("Galena", { kind: "locality", pop: 0, regionId: "CA-BC-RDKB" });
    const hines = place("Hines", { pop: 1500, regionId: "US-OR-Harney" });
    expect(
      nameLocality({ ...nothing, regionId: "CA-BC-RDKB", nearby: [at(galena, 4)], farTowns: [at(hines, 80)] }),
    ).toEqual({ locality: "Galena", basis: "hamlet" });
    // A wilderness never reaches the rule (src/derive-locality.ts leaves it
    // out); a large preserve does. The preserve's name here is made up.
    const reserve = { ...nothing, regionId: "US-OR-Harney", parks: [{ name: "Alvord Basin Preserve", ha: 69_000 }], farTowns: [at(hines, 80, 135)] };
    expect(nameLocality(reserve)).toEqual({ locality: "Alvord Basin", basis: "large_reserve" });
    expect(nameLocality({ ...reserve, parks: [] })).toEqual({ locality: "80km SE Hines", basis: "distance" });
  });

  test("far from anywhere, the nearest town whose distance and name fit", () => {
    const fsj = place("Fort St. John", { pop: 21_465, regionId: "CA-BC-PRRD" });
    const taylor = place("Taylor", { pop: 1317, regionId: "CA-BC-PRRD" });
    const e = { ...nothing, regionId: "CA-BC-PRRD", farTowns: [at(fsj, 121, 135), at(taylor, 130, 135)] };
    expect(nameLocality(e)).toEqual({ locality: "130km SE Taylor", basis: "distance" });
  });

  test("nothing at all in reach is no name, rather than a wrong one", () => {
    expect(nameLocality(nothing)).toBeNull();
  });
});

describe("candidates (beeline-4hxe)", () => {
  const town = place("Philomath", { pop: 5000 });
  const used = (locality: string, samples: number, own: number, km: number) => ({ locality, samples, own, km });

  test("with nothing used nearby, the rule's name comes first", () => {
    const e = { ...nothing, nearby: [at(town, 4)] };
    expect(localityCandidates(e)[0]).toEqual({ locality: "Philomath", basis: "town" });
  });

  test("the collector's own names come before other people's, and other people's before the gazetteer's", () => {
    const e = {
      ...nothing,
      nearby: [at(town, 4)],
      used: [used("Philomath Ridge", 5, 0, 0.4), used("Wren Meadow", 2, 2, 0.6)],
    };
    expect(localityCandidates(e).map((c) => [c.locality, c.basis])).toEqual([
      ["Wren Meadow", "used_own"],
      ["Philomath Ridge", "used"],
      ["Philomath", "town"],
    ]);
  });

  test("among other people's names, a name written oftener can beat a nearer one", () => {
    const e = { ...nothing, used: [used("Once Spot", 1, 0, 0.2), used("Common Spot", 16, 0, 0.6)] };
    expect(localityCandidates(e).map((c) => c.locality)).toEqual(["Common Spot", "Once Spot"]);
  });

  test("a refuge comes before anything used, since refuge specimens are handled separately", () => {
    const e = { ...nothing, refuge: "WILLIAM L. FINLEY NATIONAL WILDLIFE REFUGE", used: [used("Wren Meadow", 3, 3, 0.1)] };
    expect(localityCandidates(e)[0]).toEqual({ locality: "Finley NWR", basis: "refuge" });
  });

  test("a used name that cannot go on a label, or is a wilderness, is never offered", () => {
    const e = {
      ...nothing,
      nearby: [at(town, 4)],
      used: [
        used("1200 NW Hilltop Road", 4, 4, 0.1),
        used("Corvallis, OR", 4, 4, 0.1),
        used("A Very Long Locality Name", 4, 4, 0.1),
        used("Steens Wilderness", 4, 4, 0.1),
        used("Far Away Spot", 4, 4, 1.4),
      ],
    };
    expect(localityCandidates(e).map((c) => c.locality)).toEqual(["Philomath"]);
  });

  test("a used name that is only the point's county is never offered, unless a town nearby has the name", () => {
    // As written on the sandbox store: "Curry", "King", "Cariboo" were first
    // choices for samples in those counties (2026-10-30).
    const curry = { ...nothing, county: "Curry", nearby: [at(place("Gold Beach"), 6)] };
    for (const name of ["Curry", "Curry County", "Curry Co.", "curry"]) {
      expect(localityCandidates({ ...curry, used: [used(name, 4, 4, 0.1)] }).map((c) => c.locality)).toEqual(["Gold Beach"]);
    }
    const cariboo = { ...nothing, county: "Cariboo", nearby: [at(place("Alexis Creek"), 3)] };
    expect(localityCandidates({ ...cariboo, used: [used("Cariboo Regional District", 2, 2, 0.1)] })[0]!.locality).toBe("Alexis Creek");
    const stikine = { ...nothing, county: "Stikine Region", nearby: [at(place("Dease Lake"), 20)], used: [used("Stikine", 8, 8, 0.1)] };
    expect(localityCandidates(stikine)[0]!.locality).toBe("Dease Lake");
    // Hood River is a town as well as the county it is in.
    const hoodRiver = { ...nothing, county: "Hood River", nearby: [at(place("Hood River"), 8)], used: [used("Hood River", 5, 5, 0.1)] };
    expect(localityCandidates(hoodRiver)[0]).toEqual({ locality: "Hood River", basis: "used_own" });
    // Written as the county, it is the county's name, town or no town.
    const hoodRiverCounty = { ...hoodRiver, used: [used("Hood River County", 5, 5, 0.1)] };
    expect(localityCandidates(hoodRiverCounty).map((c) => c.locality)).not.toContain("Hood River County");
  });

  test("never more than four, and no name twice whatever its basis", () => {
    const e = {
      ...nothing,
      nearby: [at(town, 4), at(place("Alsea", { pop: 164 }), 9), at(place("Blodgett", { pop: 80 }), 12), at(place("Wren", { pop: 50 }), 6)],
      used: [used("Philomath", 3, 0, 0.2), used("Mary's River", 1, 0, 0.5)],
    };
    const cands = localityCandidates(e);
    expect(cands.length).toBe(4);
    expect(cands[0]).toEqual({ locality: "Philomath", basis: "used" });
    expect(new Set(cands.map((c) => c.locality.toLowerCase())).size).toBe(4);
  });

  test("a campground right beside the point is its name; one further off is offered after", () => {
    const beside = { ...nothing, nearby: [at(town, 20)], campgrounds: [{ name: "Lost Lake Campground", km: 0.1 }] };
    expect(localityCandidates(beside)[0]).toEqual({ locality: "Lost Lake CG", basis: "campground" });
    const off = { ...nothing, nearby: [at(town, 4)], campgrounds: [{ name: "Lost Lake Campground", km: 1.2 }] };
    expect(localityCandidates(off).map((c) => c.locality)).toEqual(["Philomath", "Lost Lake CG"]);
  });

  test("campground names", () => {
    expect(campgroundName("Camp Sherman Campground")).toBe("Camp Sherman CG");
    expect(campgroundName("Riverside Campground")).toBe("Riverside CG");
    expect(campgroundName("Cold Springs")).toBe("Cold Springs");
    expect(campgroundName("Lower Bridge Camping Area")).toBe("Lower Bridge CG");
  });

  test("campground names as OpenStreetMap writes them", () => {
    // From the gazetteer built 2026-10-30.
    expect(campgroundName("Three Isle Lake Backcountry Campground")).toBe("Three Isle Lake CG");
    expect(campgroundName("Shoreline Group Campground")).toBe("Shoreline CG");
    expect(campgroundName("Colchuck Lake Backcountry Camping")).toBe("Colchuck Lake CG");
    expect(campgroundName("Holmes Lake Recreation Site")).toBe("Holmes Lk Rec Site");
    expect(campgroundName("Surprise Lake Recreation Site")).toBe("Surprise Lake");
    expect(campgroundName("Cabin Bay Campsite (BCMT)")).toBe("Cabin Bay Campsite");
    expect(campgroundName("Banco Bonito Campground (Special Use Permit Required)")).toBe("Banco Bonito CG");
    expect(campgroundName("Camp Gray (OMSI)")).toBe("Camp Gray");
    // "(Upper)" is what tells it from Johnny Creek's lower campground, so it is
    // kept rather than dropped as a note, and the name is then too long for a
    // label: offering nothing is better than offering the other campground.
    expect(campgroundName("Johnny Creek Campground (Upper)")).toBeNull();
  });

  test("a single pitch, named only by its number, is no campground", () => {
    // From the gazetteer built 2026-10-30: OpenStreetMap's tourism=camp_site
    // points that are one pitch inside a campground.
    for (const pitch of ["#41", "17", "Site 10", "Campsite 3", "Campsite No. 1", "Campsite", "C6", "SU8", "60.7L", "B"]) {
      expect(campgroundName(pitch)).toBeNull();
    }
    expect(campgroundName("Loop Camp")).toBe("Loop Camp");
    const pitch = { ...nothing, nearby: [at(town, 4)], campgrounds: [{ name: "#41", km: 0.05 }] };
    expect(localityCandidates(pitch)[0]).toEqual({ locality: "Philomath", basis: "town" });
    // A pitch nearer the point than the campground it is in does not hide it.
    const inside = { ...pitch, campgrounds: [{ name: "#41", km: 0.05 }, { name: "Lost Lake Campground", km: 0.1 }] };
    expect(localityCandidates(inside)[0]).toEqual({ locality: "Lost Lake CG", basis: "campground" });
  });
});
