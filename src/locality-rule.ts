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
 * 10. a reserve over 20,000 ha the point is inside (never a federal
 *     wilderness, which is never a locality: src/derive-locality.ts);
 * 11. distance and direction from the nearest town with people in it.
 *
 * A campground the point is beside (OpenStreetMap's tourism=camp_site, within
 * 300 m) comes after the parks: collectors camp in the back country where the
 * nearest town is a long way off, and Lost Lake CG says where better than
 * "21km NW Sisters" (beeline-4hxe).
 *
 * On an island every candidate must be on the same island (Bonnie Zand: a
 * Galiano Island point is not Ganges, on Salt Spring). A name is shortened
 * only as far as 18 characters needs, and one that still does not fit, or
 * that reads as a street address, falls to the next candidate.
 *
 * `nameLocality` gives the rule's one name. `localityCandidates` gives the
 * names a person chooses among (Peter, 2026-10-30): the best and three
 * alternatives, where the best weights the names already written for samples
 * near the point, the collector's own first, since collectors go back to the
 * same places and the name they used last time is usually right.
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
  /** The county or regional district the point is in, as a gazetteer region id (US-OR-41003, Benton County). */
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
  /** Named campgrounds near the point, nearest first. */
  campgrounds: Array<{ name: string; km: number }>;
  /** Localities already written for samples near the point (src/derive-locality.ts reads them from the store). */
  used: UsedLocality[];
}

/** A locality samples near the point already carry. */
export interface UsedLocality {
  locality: string;
  /** How many samples near the point carry it. */
  samples: number;
  /** How many of those the collector in question collected. */
  own: number;
  /** How far the nearest of them is. */
  km: number;
}

/** Which step of the rule named the point; the page says it in words. */
export type LocalityBasis =
  | "used_own"
  | "used"
  | "campground"
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
  "used_own", "used", "campground", "refuge", "wildlife_area", "national_park", "state_park", "local_park", "neighbourhood", "town_limits",
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
  campgroundKm: 0.3,
  /** How far off a campground may be and still be offered as an alternative. */
  campgroundOfferKm: 1.5,
  /** How far off a sample may be for its locality to count as used here. */
  usedKm: 1,
  /** How many names a person is offered: the best and three more. */
  candidates: 4,
};

// The test locality_street_suffix_pattern makes (schema/108), normalised as
// qc_rule_locality_format normalises a locality, so a name this rule writes
// is never one that rule flags. A word with a digit in it is written
// `[^ 0-9]*[0-9][^ ]*` rather than the macro's `[^ ]*[0-9][^ ]*`: the same
// words, but the digit the pattern pins is always the first, so JavaScript's
// backtracking engine has one way to match each word rather than one per
// digit, which CodeQL found exponential over many such words. DuckDB's RE2
// does not backtrack, so the macro needs no change.
const STREET = / (road|rd|street|str|st|avenue|ave|av|drive|dr|boulevard|blvd|court|ct|lane|ln|county)( +((ne|nw|se|sw|n|s|e|w)|[^ 0-9]*[0-9][^ ]*))* *(,|$)/;
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
 * failing that, a reserve or conservation area keeps its bare
 * name (Fanny Bay, Steens Mountain).
 */
function osmParkName(raw: string): string | null {
  let name = shortName(raw);
  for (const [re, to] of [
    [/ Regional Park$/, " RP"],
    [/ Conservation Area$/, " Cons Area"],
    [/ (Nature Reserve|Conservation Area|Preserve)$/, ""],
    [/ Park$/, " Pk"],
  ] as Array<[RegExp, string]>) {
    if (name) break;
    name = shortName(raw.replace(re, to));
  }
  return name;
}

/**
 * 'Lost Lake Campground' → 'Lost Lake CG', as the Forest Service signs them
 * on its maps; 'Camp Sherman Campground' fits as it stands.
 */
export function campgroundName(raw: string): string | null {
  // OpenStreetMap also maps single pitches inside a campground as campgrounds,
  // named only by their number: '#41', '17', 'Site 10', 'Campsite 3', 'C6', a
  // river camp's '60.7L'. About 160 of the 6,114 in October 2026's extracts
  // are like this. Such a name says nothing about where the point is, so a
  // name is refused unless it has a word of three letters or more besides
  // 'campsite', 'site' and 'pitch'.
  if (!/[a-z]{3}/i.test(raw.replace(/\b(camp ?site|tent ?site|site|pitch)\b/gi, ""))) return null;
  // Brackets at the end of a name usually hold a note for mappers, not part
  // of the name: 'Cabin Bay Campsite (BCMT)' (BC Marine Trails), '[CLOSED]'.
  // Those are dropped. Brackets that tell one campground from its neighbour,
  // as in 'Johnny Creek Campground (Upper)' and '(Lower)', are kept, because
  // dropping them would give both campgrounds the same name.
  const name = /[([]\s*(Upper|Lower|Middle|North|South|East|West|[NSEW])\s*[)\]]$/i.test(raw)
    ? raw
    : raw.replace(/(\s*[([][^)\]]*[)\]])+$/, "");
  if (fits(name)) return name;
  // "CG" before any other shortening, so it is Lost Lake CG and not
  // Lost Lk Campground. 'Recreation Site', BC's name for its forest
  // campgrounds, becomes 'Rec Site'. A word saying what kind of campground it
  // is (Group, Backcountry, Dispersed, Primitive, Provincial) is dropped along
  // with 'Campground': Honeymoon Bay Group Campground is Honeymoon Bay CG.
  for (const [re, to] of [
    [/(?: (?:Group|Backcountry|Dispersed|Primitive|Provincial))? (Campground|Campsite|Camp Site|Camping Area|Camping|RV Park|RV Resort)$/i, " CG"],
    [/ Recreation Site$/i, " Rec Site"],
    [/(?: (?:Group|Backcountry|Dispersed|Primitive|Provincial))? (Campground|Campsite|Camp Site|Camping Area|Camping|Recreation Site|Group Site)$/i, ""],
  ] as Array<[RegExp, string]>) {
    const t = shortName(name.replace(re, to));
    if (t) return t;
  }
  return shortName(name);
}

/** A federal wilderness is never a locality (Peter, 2026-10-26), whoever wrote it. */
const WILDERNESS = /\bWilderness( Area)?$/i;

const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg: number) => DIRS[Math.round(deg / 45) % 8]!;

/** US-OR-41003 → US-OR: the state or province a region is in. */
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
  {
    const camp = e.campgrounds.find((x) => x.km <= RULE.campgroundKm);
    const name = camp && campgroundName(camp.name);
    if (name) return { locality: name, basis: "campground" };
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
    // Back country inside a large preserve: its name beats
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

/**
 * The names a person chooses a sample's locality among (beeline-4hxe): the
 * best first, then up to three alternatives, none repeated and every one fit
 * for a label.
 *
 * The best weights what has been used before (Peter, 2026-10-30). A refuge
 * still comes first of everything, because refuge specimens are handled
 * separately and the label must say so. Then the names written for samples
 * within a kilometre: the collector's own, most often written first, then
 * other people's, the oftener and nearer the better. Then the rule's own
 * name, and after it every other name the rule could have given, in the
 * rule's order: the parks the point is in, a campground near it, the town
 * whose limits it is in, the island, a feature, a peak, the nearest towns, a
 * hamlet, a large reserve, a distance.
 */
export function localityCandidates(e: LocalityEvidence, max: number = RULE.candidates): NamedLocality[] {
  const out: NamedLocality[] = [];
  const add = (locality: string | null | undefined, basis: LocalityBasis) => {
    if (!locality || !fits(locality) || WILDERNESS.test(locality)) return;
    const key = locality.toLowerCase();
    if (out.some((o) => o.locality.toLowerCase() === key)) return;
    out.push({ locality, basis });
  };
  if (e.refuge !== null) add(refugeName(e.refuge), "refuge");
  const used = e.used.filter((u) => u.km <= RULE.usedKm && u.locality === u.locality.trim());
  const usedScore = (u: UsedLocality, n: number) => u.km / Math.sqrt(Math.max(n, 1));
  for (const u of used.filter((x) => x.own > 0).sort((a, b) => usedScore(a, a.own) - usedScore(b, b.own))) {
    add(u.locality, "used_own");
  }
  for (const u of used.filter((x) => x.own === 0).sort((a, b) => usedScore(a, a.samples) - usedScore(b, b.samples))) {
    add(u.locality, "used");
  }
  const best = nameLocality(e);
  if (best) add(best.locality, best.basis);
  for (const a of alternatives(e)) {
    if (out.length >= max) break;
    add(a.locality, a.basis);
  }
  return out.slice(0, max);
}

/** Every name the rule could give the point, in the rule's order. */
function alternatives(e: LocalityEvidence): NamedLocality[] {
  const out: NamedLocality[] = [];
  const push = (locality: string | null | undefined, basis: LocalityBasis) => {
    if (locality) out.push({ locality, basis });
  };
  const onIsland = e.island?.id ?? null;
  const sameIsland = (islandId: string | null) => onIsland === null || islandId === onIsland;
  if (e.wildlifeArea !== null) push(unitName(e.wildlifeArea.unit), "wildlife_area");
  if (e.nationalPark !== null) push(npsName(e.nationalPark), "national_park");
  if (e.statePark !== null) push(parkName(e.statePark.park, e.statePark.suffix), "state_park");
  for (const p of e.parks) if (p.ha >= RULE.parkMinHa && p.ha <= RULE.parkMaxHa) push(osmParkName(p.name), "local_park");
  for (const c of e.campgrounds) if (c.km <= RULE.campgroundOfferKm) push(campgroundName(c.name), "campground");
  if (e.townLimits !== null) push(shortName(e.townLimits.name), "town_limits");
  if (e.island !== null && e.island.ha <= RULE.smallIslandHa) push(shortName(e.island.name), "island");
  for (const f of e.features) {
    if (sameIsland(f.at.islandId) && f.km <= (f.at.collectors >= 2 ? RULE.featureKm : RULE.featureKmOneCollector)) {
      push(shortName(f.at.name), "feature");
    }
  }
  const inState = (regionId: string | null) => e.regionId === null || stateOf(regionId) === stateOf(e.regionId);
  for (const c of e.nearby) {
    if (!sameIsland(c.at.islandId) || !inState(c.at.regionId)) continue;
    if (c.at.kind === "peak" && c.km <= RULE.peakKm) push(shortName(c.at.name), "peak");
  }
  const towns = e.nearby
    .filter((c) => sameIsland(c.at.islandId) && inState(c.at.regionId) && c.at.kind === "town" && c.at.pop > 0 && c.km <= RULE.maxKm)
    .sort((a, b) => a.km / Math.pow(a.at.pop, RULE.sizeWeight) - b.km / Math.pow(b.at.pop, RULE.sizeWeight));
  for (const t of towns.slice(0, 3)) push(shortName(t.at.name), "town");
  for (const c of e.nearby) {
    if (!sameIsland(c.at.islandId) || !inState(c.at.regionId)) continue;
    if ((c.at.kind === "locality" || (c.at.kind === "town" && c.at.pop === 0)) && c.km <= RULE.unpopulatedKm) {
      push(shortName(c.at.name), "hamlet");
    }
  }
  for (const p of e.parks) if (p.ha > RULE.parkMaxHa) push(osmParkName(p.name), "large_reserve");
  return out;
}
