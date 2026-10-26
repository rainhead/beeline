/**
 * The rule that names a sample's locality from its coordinates (beeline-7i6):
 * given what the gazetteer says about a point, the one short place name a
 * 3pt label should carry. Pure, so it is tested on its own; the gazetteer
 * lookups that feed it are in src/derive-locality.ts.
 *
 * Lifted from the prototype's `Locality.pick` (branch
 * prototype/coordinate-localities, page.html), with the settings Peter and
 * Bonnie Zand settled on 2026-10-26 fixed as the constants below. In order,
 * the first that names the point wins:
 *
 *  1. inside a national wildlife refuge, the refuge (Peter, 2026-10-23:
 *     refuge specimens are handled separately, so nothing outranks one);
 *  2. inside a WDFW wildlife area unit, a National Park Service unit, or a
 *     WA state or BC provincial park, that;
 *  3. inside a park or reserve OpenStreetMap names, 0.5 to 20,000 ha, the
 *     smallest one;
 *  4. inside a city of 50,000 or more, the neighbourhood within 1.5 km; else
 *     inside any town's limits, the town;
 *  5. on an island of 25,000 ha or less, outside a town's limits, the island;
 *  6. a lake, pass or landmark volunteers have already written for samples
 *     near it, within 5 km (2 km if one collector alone used it);
 *  7. a notable peak within 3 km, when the nearest town is 12 km or more away;
 *  8. a town with people in it within 30 km, from the point's own county if
 *     one qualifies, else from the same state or province, never across it;
 *  9. a hamlet or named locality within 10 km;
 * 10. a wilderness or reserve over 20,000 ha the point is inside;
 * 11. distance and direction from the nearest town with people in it.
 *
 * On an island every candidate must be on the same island (Bonnie Zand: a
 * Galiano Island point is not Ganges, on Salt Spring). A name is shortened
 * only as far as 18 characters needs, and one that still does not fit, or
 * that reads as a street address, falls to the next candidate.
 */

export interface GazetteerPlace {
  id: number;
  name: string;
  kind: "town" | "peak" | "locality";
  /** GeoNames' feature code: PPLX is a section of a city. */
  fcode: string;
  pop: number;
  regionId: string | null;
  islandId: string | null;
}

export interface UsedFeature {
  id: number;
  name: string;
  /** GeoNames' class and code, "H.LK". */
  code: string;
  /** Samples near it whose locality is its name, and how many collectors wrote them. */
  samples: number;
  collectors: number;
  islandId: string | null;
}

export interface Near<T> {
  at: T;
  km: number;
  /** Degrees from the place to the point, 0–360. */
  bearing: number;
}

/** Everything the gazetteer says about one point. */
export interface LocalityEvidence {
  /** The county or regional district the point is in, as a gazetteer region id (US-OR-Benton). */
  regionId: string | null;
  refuge: string | null;
  wildlifeArea: { unit: string; area: string } | null;
  nationalPark: string | null;
  /** A WA state park (suffix SP) or BC protected area (PP, PA, ER, RA). */
  statePark: { park: string; suffix: string } | null;
  /** OpenStreetMap parks and reserves the point is inside, smallest first. */
  parks: Array<{ name: string; ha: number }>;
  island: { id: string; name: string; ha: number } | null;
  townLimits: { name: string; kind: "city" | "cdp" } | null;
  /** Towns, peaks and localities near the point, nearest first. */
  nearby: Array<Near<GazetteerPlace>>;
  /** The nearest towns with people in them, however far: the last resort. */
  farTowns: Array<Near<GazetteerPlace>>;
  /** Features volunteers have named near the point, nearest first. */
  features: Array<{ at: UsedFeature; km: number }>;
}

/** Which step of the rule named the point; the page says it in words. */
export type LocalityBasis =
  | "refuge"
  | "wildlife_area"
  | "national_park"
  | "state_park"
  | "local_park"
  | "neighbourhood"
  | "town_limits"
  | "island"
  | "feature"
  | "peak"
  | "town"
  | "hamlet"
  | "large_reserve"
  | "distance";

export const LOCALITY_BASES: readonly LocalityBasis[] = [
  "refuge", "wildlife_area", "national_park", "state_park", "local_park", "neighbourhood", "town_limits",
  "island", "feature", "peak", "town", "hamlet", "large_reserve", "distance",
];

export interface NamedLocality {
  locality: string;
  basis: LocalityBasis;
}

/** The label allows 18 characters. */
export const MAX_LOCALITY_LENGTH = 18;

const RULE = {
  atKm: 1.5,
  maxKm: 30,
  sizeWeight: 0.25,
  unpopulatedKm: 10,
  peakKm: 3,
  peakWhenTownKm: 12,
  parkMinHa: 0.5,
  parkMaxHa: 20_000,
  cityDetailPop: 50_000,
  neighbourhoodKm: 1.5,
  smallIslandHa: 25_000,
  featureKm: 5,
  featureKmOneCollector: 2,
  wildlifeAreaSuffix: "WLA",
};

// The test locality_street_suffix_pattern makes (schema/108), normalised as
// qc_rule_locality_format normalises a locality, so a name this rule writes
// is never one that rule flags.
const STREET = / (road|rd|street|str|st|avenue|ave|av|drive|dr|boulevard|blvd|court|ct|lane|ln|county)( +((ne|nw|se|sw|n|s|e|w)|[^ ]*[0-9][^ ]*))* *(,|$)/;
const looksLikeStreet = (s: string) =>
  STREET.test(` ${s.toLowerCase().replaceAll(".", " ").replaceAll(",", " , ")} `);

/** Whether a name can go on a label as it stands. */
export function fits(s: string): boolean {
  return s.length <= MAX_LOCALITY_LENGTH && !s.includes(",") && !s.includes('"') && !looksLikeStreet(s);
}

/** 'BOSQUE DEL APACHE' → 'Bosque del Apache': the agencies write their names in capitals. */
const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/(^|[\s\-(])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase())
    .replace(/\bMc([a-z])/g, (_m, a: string) => "Mc" + a.toUpperCase())
    .replace(/ (Del|De|La|Of|And|The) /g, (w) => w.toLowerCase());

/** The USPS forms, applied one at a time and only until the name fits. */
const ABBREV: Array<[RegExp, string]> = [
  [/\bMount\b/g, "Mt"],
  [/\bMountain\b/g, "Mt"],
  [/\bSaint\b/g, "St"],
  [/\bFort\b/g, "Ft"],
  [/\bJunction\b/g, "Jct"],
  [/\bSprings\b/g, "Spgs"],
  [/\bLake\b/g, "Lk"],
  [/\bCreek\b/g, "Crk"],
  [/\bCanyon\b/g, "Cyn"],
  [/\bIsland\b/g, "Is"],
];

/** A name, shortened only as far as it must be; null if it cannot be made to fit. */
export function shortName(name: string): string | null {
  if (fits(name)) return name;
  let s = name;
  for (const [re, to] of ABBREV) {
    s = s.replace(re, to);
    if (fits(s)) return s;
  }
  return null;
}

// Where staff write a refuge by another name than its own.
const REFUGE_NAMES: Record<string, string> = {
  "SADDLE MOUNTAIN NATIONAL WILDLIFE REFUGE": "Hanford Reach NWR",
};

/** 'WILLIAM L. FINLEY NATIONAL WILDLIFE REFUGE' → 'Finley NWR', the way staff already write them. */
export function refugeName(org: string): string | null {
  const curated = REFUGE_NAMES[org];
  if (curated !== undefined) return curated;
  let s = titleCase(org)
    .replace(/ National (Wildlife|Antelope|Bison|Elk) Refuge$/, " NWR")
    .replace(/ National Wildlife Range$/, " NWR");
  if (fits(s)) return s;
  s = s.replace(/\bMountain\b/, "Mt");
  if (fits(s)) return s;
  const generic = s.replace(/ (Lake|River|Creek|Slough|Marsh|Bay|Island|Islands) NWR$/, " NWR");
  if (fits(generic)) return generic;
  // William L. Finley NWR → Finley NWR: a refuge named for a person goes by
  // the surname, the way staff write it.
  const surname = s.replace(/^(?:[A-Z][a-z]+ )+(?:[A-Z]\. )+/, "");
  if (surname !== s && fits(surname)) return surname;
  // Bosque del Apache: the name people use, without the NWR.
  const bare = s.replace(/ NWR$/, "");
  if (fits(bare)) return bare;
  const words = s.split(" ");
  while (words.length > 2) {
    words.shift();
    while (words.length > 2 && /^[A-Z]\.$|^Jr\.$/.test(words[0]!)) words.shift();
    const t = words.join(" ");
    if (fits(t)) return t;
  }
  return null;
}

/** 'Whiskey Dick' (a unit of L.T. Murray) → 'Whiskey Dick WLA'; the suffix goes where it will not fit. */
function unitName(unit: string): string | null {
  const suffixed = `${unit} ${RULE.wildlifeAreaSuffix}`;
  return fits(suffixed) ? suffixed : shortName(unit);
}

/** 'Ginkgo Petrified Forest' → 'Ginkgo SP'; 'Sun Lakes-Dry Falls' → 'Sun Lakes SP'; 'ELK FALLS' → 'Elk Falls PP'. */
function parkName(raw: string, suffix: string): string | null {
  const park = raw === raw.toUpperCase() ? titleCase(raw) : raw;
  const tries = [`${park} ${suffix}`, `${park.split("-")[0]!.trim()} ${suffix}`];
  for (const [re, to] of ABBREV) {
    const t = park.replace(re, to);
    if (t !== park) tries.push(`${t} ${suffix}`);
  }
  const words = park.split(" ");
  while (words.length > 1) {
    words.pop();
    tries.push(`${words.join(" ")} ${suffix}`);
  }
  return tries.find(fits) ?? null;
}

const NPS_SHORT: Array<[RegExp, string]> = [
  [/ National Park$/, " NP"],
  [/ National Monument( and Preserve)?$/, " NM"],
  [/ National Recreation Area$/, " NRA"],
  [/ National Historical Park$/, " NHP"],
  [/ National Historic Site$/, " NHS"],
  [/ National Preserve$/, " NPres"],
  [/ National Reserve$/, " NRes"],
  [/ National Historical Reserve$/, " NHR"],
  [/ National Seashore$/, " NS"],
  [/ National Battlefield$/, " NB"],
];

/** 'Olympic National Park' → 'Olympic NP', the way staff write it. */
function npsName(unit: string): string | null {
  let s = unit;
  for (const [re, to] of NPS_SHORT) s = s.replace(re, to);
  return shortName(s);
}

/**
 * Too long: 'Regional Park' becomes RP, as BC writes it, and 'Conservation
 * Area' Cons Area (Pine Crk Cons Area, so it does not read as a creek);
 * failing that, a reserve, conservation area or wilderness keeps its bare
 * name (Fanny Bay, Steens Mountain).
 */
function osmParkName(raw: string): string | null {
  let name = shortName(raw);
  for (const [re, to] of [
    [/ Regional Park$/, " RP"],
    [/ Conservation Area$/, " Cons Area"],
    [/ (Nature Reserve|Conservation Area|Wilderness|Preserve)$/, ""],
    [/ Park$/, " Pk"],
  ] as Array<[RegExp, string]>) {
    if (name) break;
    name = shortName(raw.replace(re, to));
  }
  return name;
}

const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg: number) => DIRS[Math.round(deg / 45) % 8]!;

/** US-OR-Benton → US-OR: the state or province a region is in. */
const stateOf = (regionId: string | null) => (regionId ? regionId.split("-").slice(0, 2).join("-") : null);

interface Candidate extends Near<GazetteerPlace> {
  short: string;
  sameCounty: boolean;
  sameState: boolean;
}

export function nameLocality(e: LocalityEvidence): NamedLocality | null {
  if (e.refuge !== null) {
    const name = refugeName(e.refuge);
    if (name) return { locality: name, basis: "refuge" };
  }
  const onIsland = e.island?.id ?? null;
  const smallIsland = e.island !== null && e.island.ha <= RULE.smallIslandHa;
  const cands: Candidate[] = [];
  for (const c of e.nearby) {
    if (onIsland !== null && c.at.islandId !== onIsland) continue;
    const short = shortName(c.at.name);
    if (short === null) continue;
    cands.push({
      ...c,
      short,
      sameCounty: c.at.regionId === e.regionId,
      // A point offshore is in no county: any state will do.
      sameState: e.regionId === null || stateOf(c.at.regionId) === stateOf(e.regionId),
    });
  }
  if (e.wildlifeArea !== null) {
    const name = unitName(e.wildlifeArea.unit);
    if (name) return { locality: name, basis: "wildlife_area" };
  }
  if (e.nationalPark !== null) {
    const name = npsName(e.nationalPark);
    if (name) return { locality: name, basis: "national_park" };
  }
  if (e.statePark !== null) {
    const name = parkName(e.statePark.park, e.statePark.suffix);
    if (name) return { locality: name, basis: "state_park" };
  }
  {
    const park = e.parks.find((x) => x.ha >= RULE.parkMinHa && x.ha <= RULE.parkMaxHa);
    const name = park && osmParkName(park.name);
    if (name) return { locality: name, basis: "local_park" };
  }
  const tl = e.townLimits;
  // The population of the town whose limits the point is in, where GeoNames
  // has a town of that name nearby.
  const limitsPop = tl === null ? 0 : (e.nearby.find((c) => c.at.kind === "town" && c.at.name === tl.name)?.at.pop ?? 0);
  // Inside a city a volunteer lives in, the city's name says too little: the
  // neighbourhood. GeoNames lists one as a section of a city (PPLX), with a
  // population in Vancouver (Fairview, 33,620) and none in Seattle.
  if (tl !== null && tl.kind === "city" && limitsPop >= RULE.cityDetailPop) {
    const hood = e.nearby.find(
      (c) =>
        c.at.kind === "town" &&
        (c.at.fcode === "PPLX" || c.at.pop === 0) &&
        c.at.name !== tl.name &&
        c.km <= RULE.neighbourhoodKm &&
        shortName(c.at.name) !== null,
    );
    if (hood) return { locality: shortName(hood.at.name)!, basis: "neighbourhood" };
  }
  if (tl !== null) {
    const name = shortName(tl.name);
    if (name) return { locality: name, basis: "town_limits" };
  }
  // On a smaller island and outside any town's limits, the island is the
  // name people use (Galiano Island, Lopez Island); a large one, Whidbey or
  // Vancouver Island, is named by its towns like the mainland.
  if (e.island !== null && smallIsland) {
    const name = shortName(e.island.name);
    if (name) return { locality: name, basis: "island" };
  }
  {
    // The most used feature in reach: distance over the square root of how
    // many samples carry its name, so Crystal Mountain at 3.6 km can beat a
    // pass at 2.9 km that one sample names. A name only one collector has
    // used reaches less far: it may be theirs alone.
    const score = (x: { at: UsedFeature; km: number }) => x.km / Math.sqrt(Math.max(x.at.samples, 1));
    let hit: { at: UsedFeature; km: number } | null = null;
    for (const x of e.features) {
      if (onIsland !== null && x.at.islandId !== onIsland) continue;
      if (x.km > (x.at.collectors >= 2 ? RULE.featureKm : RULE.featureKmOneCollector)) continue;
      if (shortName(x.at.name) === null) continue;
      if (hit === null || score(x) < score(hit)) hit = x;
    }
    if (hit) return { locality: shortName(hit.at.name)!, basis: "feature" };
  }
  const choose = (pool: Candidate[]): { c: Candidate; basis: LocalityBasis } | null => {
    // Right beside a town: name it whatever its size, unless the point is
    // inside a town's limits, where a hamlet so close is a neighbourhood.
    const at = tl !== null ? undefined : pool.find((c) => c.at.kind === "town" && c.at.pop > 0 && c.km <= RULE.atKm);
    if (at) return { c: at, basis: "town" };
    const score = (c: Candidate) => c.km / Math.pow(Math.max(c.at.pop, 1), RULE.sizeWeight);
    let town: Candidate | null = null;
    for (const c of pool) {
      if (c.at.kind !== "town" || c.at.pop <= 0 || c.km > RULE.maxKm) continue;
      if (town === null || score(c) < score(town)) town = c;
    }
    const peak = pool.find((c) => c.at.kind === "peak" && c.km <= RULE.peakKm);
    if (peak && (!town || town.km >= RULE.peakWhenTownKm)) return { c: peak, basis: "peak" };
    return town ? { c: town, basis: "town" } : null;
  };
  const r = choose(cands.filter((c) => c.sameCounty)) ?? choose(cands.filter((c) => c.sameState));
  if (r) return { locality: r.c.short, basis: r.basis };
  // Nothing on a smaller island to name it by: the island itself.
  if (e.island !== null && smallIsland) {
    const name = shortName(e.island.name);
    if (name) return { locality: name, basis: "island" };
  }
  {
    // A hamlet or named locality nobody is counted in.
    const pool = cands.filter((c) => c.sameCounty).concat(cands.filter((c) => c.sameState));
    const near = pool.find(
      (c) => (c.at.kind === "locality" || (c.at.kind === "town" && c.at.pop === 0)) && c.km <= RULE.unpopulatedKm,
    );
    if (near) return { locality: near.short, basis: "hamlet" };
  }
  {
    // Back country inside a wilderness or a large preserve: its name beats
    // a distance from a town.
    const big = e.parks.find((x) => x.ha > RULE.parkMaxHa);
    const name = big && osmParkName(big.name);
    if (name) return { locality: name, basis: "large_reserve" };
  }
  // Nothing near enough to name: how far, and which way, from the nearest
  // town with people in it, so a far name is not read as where the bee was.
  // A town in the same state or province first, unless it is more than
  // twice as far as the nearest across the line: "164km W Atlin" helps
  // nobody where "57km NW Klukwan" does.
  if (e.farTowns.length > 0) {
    const inState = (t: Near<GazetteerPlace>) => e.regionId === null || stateOf(t.at.regionId) === stateOf(e.regionId);
    const nearest = Math.min(...e.farTowns.map((t) => t.km));
    const preferred = (t: Near<GazetteerPlace>) => (inState(t) && t.km <= 2 * nearest ? 1 : 0);
    const ordered = [...e.farTowns].sort((a, b) => a.km - b.km).sort((a, b) => preferred(b) - preferred(a));
    for (const t of ordered) {
      const lead = `${Math.round(t.km)}km ${compass(t.bearing)} `;
      let name = t.at.name;
      let named = fits(lead + name) ? lead + name : null;
      for (const [re, to] of ABBREV) {
        if (named) break;
        name = name.replace(re, to);
        if (fits(lead + name)) named = lead + name;
      }
      if (named) return { locality: named, basis: "distance" };
    }
  }
  return null;
}
