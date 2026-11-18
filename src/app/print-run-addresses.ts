import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import type { Registrant } from "../ideal-logic.js";
import { collectorText } from "../label-text.js";
import type { PersonNameParts } from "../person-name.js";

/**
 * The mailing addresses of a print run's collectors (beeline-w8ab.3).
 *
 * The addresses are Ideal Logic's and are never written to disk (see
 * docs/architecture/ideal-logic.md). This module only reads the store for who
 * the collectors are, and joins them in memory to the registrants the caller
 * has just fetched. It holds nothing between calls.
 *
 * A printed label records the collector line as printed and no person: the
 * freeze (src/print-run.ts) reads `sample_primary_collector` to order the
 * sheets and keeps only the text. So the file follows each sample's primary
 * collector as it is now, and says so where that no longer matches the paper.
 */

/** One primary collector of a run's labels, and the registration they are linked to. */
export interface RunCollector {
  personId: number;
  displayName: string;
  familyName: string | null;
  givenName: string | null;
  /** How many of the run's labels are this person's. */
  labels: number;
  /** The distinct collector lines printed for them, so staff can match the file to the cut sheets. */
  printedAs: string[];
  /** Null where the person is linked to no registration. */
  idealLogicId: string | null;
  /** True where a label of theirs was printed with a collector line that is not what their sample would print today. */
  changedAfterPrinting: boolean;
}

/** The collectors of a run, and how many labels the run holds in all. */
export interface RunCollectors {
  collectors: RunCollector[];
  /** Every label of the run, including those whose sample has no primary collector now. */
  totalLabels: number;
}

/** A part of an address that an envelope cannot be delivered without. */
export type MissingPart = "city" | "postalCode" | "stateProvince" | "country";

/** What a row says about itself, beside the names and the address. */
export type AddressNote =
  | { code: "noRegistration" | "noAddress" | "notInAnswer" | "collectorChanged" }
  | { code: "incompleteAddress"; missing: MissingPart[] }
  | { code: "unaccountedLabels"; labels: number };

export interface AddressRow {
  names: string[];
  line1: string;
  line2: string;
  city: string;
  stateProvince: string;
  postalCode: string;
  country: string;
  labels: number;
  printedAs: string[];
  notes: AddressNote[];
  /** True where the row holds a street address, complete or not. */
  hasAddress: boolean;
}

/** The distinct primary collectors of a run's labels, each with their registration link. */
export async function runCollectors(db: Kysely<Database>, printRunId: number): Promise<RunCollectors> {
  const total = await sql<{ n: number | bigint }>`
    SELECT count(*) AS n FROM printed_label WHERE print_run_id = ${printRunId}`.execute(db);
  const labels = await sql<{
    sample_id: number | bigint;
    person_id: number | bigint;
    display_name: string;
    family_name: string | null;
    given_name: string | null;
    collector_text: string;
    ideal_logic_id: string | null;
  }>`
    SELECT sp.sample_id, pc.person_id, p.display_name, p.family_name, p.given_name, pl.collector_text,
           reg.ideal_logic_id
    FROM printed_label pl
    JOIN specimen sp ON sp.entity_id = pl.specimen_id
    JOIN sample_primary_collector pc ON pc.sample_id = sp.sample_id
    JOIN person p ON p.entity_id = pc.person_id
    LEFT JOIN person_registration reg ON reg.person_id = pc.person_id
    WHERE pl.print_run_id = ${printRunId}
    ORDER BY pc.person_id, pl.collector_text`.execute(db);
  // Everyone who collects each of those samples now, to say what the labels
  // would print today.
  const everyone = await sql<{
    sample_id: number | bigint;
    display_name: string;
    given_name: string | null;
    family_name: string | null;
    label_name: string | null;
  }>`
    SELECT sc.sample_id, p.display_name, p.given_name, p.family_name, p.label_name
    FROM sample_collector sc
    JOIN person p ON p.entity_id = sc.person_id
    WHERE sc.sample_id IN (
      SELECT sp.sample_id FROM printed_label pl JOIN specimen sp ON sp.entity_id = pl.specimen_id
      WHERE pl.print_run_id = ${printRunId})
    ORDER BY sc.sample_id, sc.position`.execute(db);
  const listOf = new Map<number, PersonNameParts[]>();
  for (const r of everyone.rows) {
    const key = Number(r.sample_id);
    if (!listOf.has(key)) listOf.set(key, []);
    listOf.get(key)!.push(r);
  }

  const byPerson = new Map<number, RunCollector>();
  for (const r of labels.rows) {
    const id = Number(r.person_id);
    let c = byPerson.get(id);
    if (c === undefined) {
      c = {
        personId: id,
        displayName: r.display_name,
        familyName: r.family_name,
        givenName: r.given_name,
        labels: 0,
        printedAs: [],
        idealLogicId: r.ideal_logic_id,
        changedAfterPrinting: false,
      };
      byPerson.set(id, c);
    }
    c.labels += 1;
    if (!c.printedAs.includes(r.collector_text)) c.printedAs.push(r.collector_text);
    if (collectorText(listOf.get(Number(r.sample_id)) ?? []) !== r.collector_text) c.changedAfterPrinting = true;
  }
  return { collectors: [...byPerson.values()], totalLabels: Number(total.rows[0]!.n) };
}

/** Lower-case letters and digits only, so that "12 Oak St." and "12 oak st" are one address. */
const fold = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const byName = (a: RunCollector, b: RunCollector) =>
  (a.familyName ?? a.displayName).localeCompare(b.familyName ?? b.displayName) ||
  (a.givenName ?? "").localeCompare(b.givenName ?? "") ||
  a.personId - b.personId;

const countryName = (country: "USA" | "CAN" | null) => (country === "CAN" ? "CANADA" : "");

const NO_ADDRESS = { line1: "", line2: "", city: "", stateProvince: "", postalCode: "", country: "" };

/**
 * One row per home, then the rows with an incomplete address, then those with
 * none, then, if any of the run's labels are not in the file, one row saying
 * how many.
 *
 * Collectors linked to the same registration always share a row. Collectors
 * linked to different registrations share one only when the street, city,
 * state or province, postal code and country all agree after folding, and
 * never when the postal code is empty: the same street name in two towns is
 * two homes. Nobody is dropped.
 */
export function addressRows({ collectors, totalLabels }: RunCollectors, registrants: Registrant[]): AddressRow[] {
  const registrantById = new Map(registrants.map((r) => [r.id, r]));
  const byRegistration = new Map<string, { people: RunCollector[]; registrant: Registrant }>();
  const unaddressed: AddressRow[] = [];
  const noted = (c: RunCollector, code: "noRegistration" | "noAddress" | "notInAnswer"): void => {
    unaddressed.push({
      names: [c.displayName],
      ...NO_ADDRESS,
      labels: c.labels,
      printedAs: c.printedAs,
      notes: c.changedAfterPrinting ? [{ code }, { code: "collectorChanged" }] : [{ code }],
      hasAddress: false,
    });
  };
  for (const c of [...collectors].sort(byName)) {
    if (c.idealLogicId === null) {
      noted(c, "noRegistration");
      continue;
    }
    const registrant = registrantById.get(c.idealLogicId);
    if (registrant === undefined) {
      noted(c, "notInAnswer");
      continue;
    }
    if (registrant.address === null || fold(registrant.address.street) === "") {
      noted(c, "noAddress");
      continue;
    }
    const same = byRegistration.get(registrant.id);
    if (same === undefined) byRegistration.set(registrant.id, { people: [c], registrant });
    else same.people.push(c);
  }

  // Registrations at one home are merged, in the order of their first collector.
  const homes = new Map<string, { people: RunCollector[]; registrant: Registrant }>();
  for (const reg of byRegistration.values()) {
    const a = reg.registrant.address!;
    const base = [fold(a.street), fold(a.city), fold(a.stateProvince), fold(a.postalCode), a.country ?? ""].join("|");
    const key = fold(a.postalCode) === "" ? `${base}|registration:${reg.registrant.id}` : base;
    const home = homes.get(key);
    if (home === undefined) homes.set(key, { people: [...reg.people], registrant: reg.registrant });
    else home.people.push(...reg.people);
  }

  const complete: AddressRow[] = [];
  const incomplete: AddressRow[] = [];
  for (const { people, registrant } of homes.values()) {
    const a = registrant.address!;
    const lines = a.street
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "");
    const printedAs: string[] = [];
    for (const p of people) for (const t of p.printedAs) if (!printedAs.includes(t)) printedAs.push(t);
    const missing: MissingPart[] = [];
    if (fold(a.city) === "") missing.push("city");
    if (fold(a.stateProvince) === "") missing.push("stateProvince");
    if (fold(a.postalCode) === "") missing.push("postalCode");
    if (a.country === null) missing.push("country");
    const notes: AddressNote[] = [];
    if (missing.length > 0) notes.push({ code: "incompleteAddress", missing });
    if (people.some((p) => p.changedAfterPrinting)) notes.push({ code: "collectorChanged" });
    (missing.length > 0 ? incomplete : complete).push({
      names: people.map((p) => p.displayName),
      line1: lines[0] ?? "",
      line2: lines.slice(1).join(", "),
      city: a.city ?? "",
      stateProvince: a.stateProvince ?? "",
      postalCode: a.postalCode ?? "",
      country: countryName(a.country),
      labels: people.reduce((n, p) => n + p.labels, 0),
      printedAs,
      notes,
      hasAddress: true,
    });
  }

  const rows = [...complete, ...incomplete, ...unaddressed];
  // Labels follow today's primary collector, so a sample that has none now,
  // or another one, leaves a stack of labels out of this file.
  const inFile = collectors.reduce((n, c) => n + c.labels, 0);
  if (inFile !== totalLabels) {
    rows.push({
      names: [],
      ...NO_ADDRESS,
      labels: totalLabels - inFile,
      printedAs: [],
      notes: [{ code: "unaccountedLabels", labels: totalLabels - inFile }],
      hasAddress: false,
    });
  }
  return rows;
}
