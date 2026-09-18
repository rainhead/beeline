import { labelName, type PersonNameParts } from "./person-name.js";

/**
 * What a label says, composed once at freeze time and stored on printed_label
 * (schema/035) — never recomputed from live data, because a printed label is
 * a fact and the sample is not. Six fields, no taxon (CONTEXT.md, Label): the
 * label is a record of the collecting event, and printing precedes
 * determination.
 *
 * The formats are the reference implementation's
 * (LabelsSubtaskHandler.js#createLabelFromOccurrence), matched deliberately so
 * that a Beeline label reads like every label already pinned in the drawers,
 * the collector line included: `P.Abrahamsen`, set tight (see collectorText).
 * For a pair, both names (Andony, gh-17).
 */

export interface LabelInput {
  country: string | null;
  state_province: string | null;
  county: string | null;
  locality: string | null;
  latitude: number;
  longitude: number;
  elevation_m: number | null;
  date_start: Date;
  date_end: Date;
  sample_number: string;
  specimen_number: number;
  kind: "net" | "trap";
  protocol: string | null;
  /** In sample_collector position order; position 1 first. */
  collectors: PersonNameParts[];
}

export interface LabelText {
  location: string;
  coordinates: string;
  date: string;
  collector: string;
  method: string;
  number: string;
  /** What the proofer should look at, or null. */
  warnings: string | null;
}

/**
 * The reference's line-length thresholds: past these, the renderer shrinks the
 * text to fit and the proofer should look. Warnings, never blocks.
 */
export const LABEL_LIMITS = { location: 38, collector: 22, method: 5 } as const;

/**
 * How a county prints. British Columbia's regional districts by their usual
 * abbreviations; everything else prints as it is (the geocoder artefacts the
 * reference's table also listed are handled by countyName, for every county
 * rather than the two it knew about). From the reference
 * implementation's constants.ts, kept as a Map rather than a table because
 * it is a rendering convention and not a fact about places.
 */
const COUNTY_ABBREVIATIONS = new Map<string, string>([
  ["Alberni-Clayoquot", "ACRD"],
  ["Bulkley-Nechako", "RDBN"],
  ["Capital", "CRD"],
  ["Cariboo", "Cariboo"],
  ["Central Coast", "CCRD"],
  ["Central Kootenay", "RDCK"],
  ["Central Okanagan", "RDCO"],
  ["Columbia-Shuswap", "CSRD"],
  ["Comox-Strathcona", "CxSRD"],
  ["Cowichan Valley", "CwVRD"],
  ["East Kootenay", "RDEK"],
  ["Fraser Valley", "FVRD"],
  ["Fraser-Fort George", "RDFS"],
  ["Greater Vancouver", "MVRD"],
  ["Kitimat-Stikine", "RDKS"],
  ["Kootenay Boundary", "RDKB"],
  ["Mount Waddington", "RDMW"],
  ["Nanaimo", "RDN"],
  ["North Coast", "RDNC"],
  ["North Okanagan", "RDNO"],
  ["Northern Rockies", "NRRM"],
  ["Okanagan-Similkameen", "RDOS"],
  ["Peace River", "Peace River"],
  ["Skeena-Queen Charlotte", "NCRD"],
  ["Squamish-Lillooet", "SLRD"],
  ["Stikine Region", "Stikine"],
  ["Strathcona", "SRD"],
  ["Sunshine Coast", "SCRD"],
  ["Thompson-Nicola", "TNRD"],
  ["Doña Ana", "Dona Ana"],
]);

const ROMAN_MONTHS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

/**
 * A county as a label says it: the name alone. iNaturalist disambiguates a
 * few counties as 'Franklin County, US, WA', and the legacy geocoder as
 * 'Franklin , US, WA'; the store is repaired at its source (schema/107,
 * migration 0032, beeline-gr7), and this is the label refusing to print the
 * suffix regardless, because a label is the one thing that cannot be fixed
 * afterwards — 172 of them said 'Franklin County, US, WACo' before it did.
 */
export function countyName(county: string | null | undefined): string {
  const raw = county?.trim() ?? "";
  if (!raw.includes(",")) return raw;
  const name = raw.split(",")[0]!.trim();
  return name.endsWith(" County") ? name.slice(0, -" County".length) : name;
}

/** `USA:OR:BentonCo Corvallis` — the county carries `Co` only in the US. */
export function locationText(input: Pick<LabelInput, "country" | "state_province" | "county" | "locality">): string {
  const country = input.country?.trim() ?? "";
  const state = input.state_province?.trim() ?? "";
  const county = countyName(input.county);
  const countyText = county
    ? `:${COUNTY_ABBREVIATIONS.get(county) ?? county}${country === "USA" ? "Co" : ""}`
    : "";
  return `${country}:${state}${countyText} ${input.locality?.trim() ?? ""}`.trimEnd();
}

/** `44.565 -123.262 72m` — three decimals, elevation when known. */
export function coordinatesText(input: Pick<LabelInput, "latitude" | "longitude" | "elevation_m">): string {
  const elevation = input.elevation_m === null ? "" : ` ${input.elevation_m}m`;
  return `${input.latitude.toFixed(3)} ${input.longitude.toFixed(3)}${elevation}`;
}

/**
 * `14.VII2025-3.2`: day.RomanMonth, year, then sample.specimen. A trap range
 * prints both ends, `14.VII-21.VII2025-OBAS00657.12`, and a range that
 * crosses a year prints both years. Hyphens come out of the sample number
 * because the hyphen is this line's separator.
 */
export function dateText(
  input: Pick<LabelInput, "date_start" | "date_end" | "sample_number" | "specimen_number">,
): string {
  const day = (d: Date) => `${d.getUTCDate()}.${ROMAN_MONTHS[d.getUTCMonth()]}`;
  const start = input.date_start;
  const end = input.date_end;
  const sameDay = start.getTime() === end.getTime();
  const sample = input.sample_number.replaceAll("-", "");
  const when = sameDay
    ? `${day(start)}${start.getUTCFullYear()}`
    : start.getUTCFullYear() === end.getUTCFullYear()
      ? `${day(start)}-${day(end)}${end.getUTCFullYear()}`
      : `${day(start)}${start.getUTCFullYear()}-${day(end)}${end.getUTCFullYear()}`;
  return `${when}-${sample}.${input.specimen_number}`;
}

/**
 * The collector line is set tight, `A.Bulger`, with no space after the
 * initial — decided in the room with the people who print and pin them
 * (2026-09-18): it is how every label in the drawers reads, and on a label
 * two thirds of an inch wide the space is width the name needs. Screens keep
 * `labelName()`'s `A. Bulger`; only the label closes it up. A `label_name`
 * override and a name with no parts print exactly as they are.
 *
 * Two or more collectors all print (Andony, gh-17: paired trap collectors
 * always both appear), joined with `&` and as tight as the rest, and a
 * shared family name is said once — `M.&D.O'Loughlin` rather than
 * `M.O'Loughlin&D.O'Loughlin` — which only applies where every name is the
 * derived initial-plus-family form.
 */
function parts(c: PersonNameParts): { initial: string; family: string } | null {
  const family = c.family_name?.trim() || null;
  const given = c.given_name?.trim() || null;
  const override = c.label_name?.trim() || null;
  return override || !family || !given ? null : { initial: [...given][0]!.toUpperCase(), family };
}

export function collectorText(collectors: PersonNameParts[]): string {
  if (collectors.length === 0) return "";
  const parted = collectors.map(parts);
  const names = collectors.map((c, i) => (parted[i] ? `${parted[i]!.initial}.${parted[i]!.family}` : labelName(c)));
  if (collectors.length === 1) return names[0]!;
  const family = parted[0]?.family;
  if (family && parted.every((p) => p !== null && p.family === family)) {
    return `${parted.map((p) => `${p!.initial}.`).join("&")}${family}`;
  }
  return names.join("&");
}

/** `net`, `trap`, or `nest` where the protocol says so — the reference's rule, minus its lowercasing of free text. */
export function methodText(input: Pick<LabelInput, "kind" | "protocol">): string {
  return input.protocol?.toLowerCase().includes("nest") ? "nest" : input.kind;
}

export function composeLabel(input: LabelInput, fieldNumber: string): LabelText {
  const text = {
    location: locationText(input),
    coordinates: coordinatesText(input),
    date: dateText(input),
    collector: collectorText(input.collectors),
    method: methodText(input),
    number: fieldNumber,
  };
  const warnings: string[] = [];
  if (!input.county?.trim()) warnings.push("county missing");
  if (text.location.length > LABEL_LIMITS.location) warnings.push("location line long");
  if (text.collector.length > LABEL_LIMITS.collector) warnings.push("collector line long");
  if (text.method.length > LABEL_LIMITS.method) warnings.push("method long");
  return { ...text, warnings: warnings.length ? warnings.join("; ") : null };
}

/** 25 rows of 10 on a US Letter sheet — the reference's geometry, which Arthur asked us to keep. */
export const LABELS_PER_SHEET = 250;

/**
 * Lays labels out on sheets in the order given, skipping one cell wherever the
 * collector changes so the sheet can be cut apart by collector (the
 * reference's #partitionLabels). Returns 1-based sheet and 0-based cell per
 * label; a blank that falls at the end of a sheet is simply the sheet ending
 * early.
 */
export function layoutSheets<T>(
  labels: T[],
  collectorOf: (label: T) => string,
): Array<{ label: T; sheet: number; cell: number }> {
  const out: Array<{ label: T; sheet: number; cell: number }> = [];
  let index = 0;
  labels.forEach((label, i) => {
    if (i > 0 && collectorOf(labels[i - 1]!) !== collectorOf(label)) index += 1;
    out.push({ label, sheet: Math.floor(index / LABELS_PER_SHEET) + 1, cell: index % LABELS_PER_SHEET });
    index += 1;
  });
  return out;
}
