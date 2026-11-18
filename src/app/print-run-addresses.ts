import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import type { Registrant } from "../ideal-logic.js";

/**
 * The mailing addresses of a print run's collectors (beeline-w8ab.3).
 *
 * The addresses are Ideal Logic's and are never written to disk (see
 * docs/architecture/ideal-logic.md). This module only reads the store for who
 * the collectors are, and joins them in memory to the registrants the caller
 * has just fetched. It holds nothing between calls.
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
}

/** Why a row has no address. */
export type AddressNote = "noRegistration" | "noAddress" | "notInAnswer";

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
  note: AddressNote | null;
}

/** The distinct primary collectors of a run's labels, each with their registration link. */
export async function runCollectors(db: Kysely<Database>, printRunId: number): Promise<RunCollector[]> {
  const result = await sql<{
    person_id: number | bigint;
    display_name: string;
    family_name: string | null;
    given_name: string | null;
    collector_text: string;
    labels: number | bigint;
    ideal_logic_id: string | null;
  }>`
    SELECT pc.person_id, p.display_name, p.family_name, p.given_name, pl.collector_text,
           count(*) AS labels, reg.ideal_logic_id
    FROM printed_label pl
    JOIN specimen sp ON sp.entity_id = pl.specimen_id
    JOIN sample_primary_collector pc ON pc.sample_id = sp.sample_id
    JOIN person p ON p.entity_id = pc.person_id
    LEFT JOIN person_registration reg ON reg.person_id = pc.person_id
    WHERE pl.print_run_id = ${printRunId}
    GROUP BY pc.person_id, p.display_name, p.family_name, p.given_name, pl.collector_text, reg.ideal_logic_id
    ORDER BY pc.person_id, pl.collector_text`.execute(db);
  const byPerson = new Map<number, RunCollector>();
  for (const r of result.rows) {
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
      };
      byPerson.set(id, c);
    }
    c.labels += Number(r.labels);
    if (!c.printedAs.includes(r.collector_text)) c.printedAs.push(r.collector_text);
  }
  return [...byPerson.values()];
}

/** Lower-case letters and digits only, so that "12 Oak St." and "12 oak st" are one address. */
const fold = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const byName = (a: RunCollector, b: RunCollector) =>
  (a.familyName ?? a.displayName).localeCompare(b.familyName ?? b.displayName) ||
  (a.givenName ?? "").localeCompare(b.givenName ?? "") ||
  a.personId - b.personId;

const countryName = (country: "USA" | "CAN" | null) => (country === "CAN" ? "CANADA" : "");

/**
 * One row per address, then a noted row for each collector who has none.
 * Collectors at the same address (a household) share a row. Nobody is dropped.
 */
export function addressRows(collectors: RunCollector[], registrants: Registrant[]): AddressRow[] {
  const registrantById = new Map(registrants.map((r) => [r.id, r]));
  const groups = new Map<string, { people: RunCollector[]; registrant: Registrant }>();
  const unaddressed: AddressRow[] = [];
  const noted = (c: RunCollector, note: AddressNote): void => {
    unaddressed.push({
      names: [c.displayName],
      line1: "",
      line2: "",
      city: "",
      stateProvince: "",
      postalCode: "",
      country: "",
      labels: c.labels,
      printedAs: c.printedAs,
      note,
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
    const street = registrant.address?.street ?? "";
    if (registrant.address === null || fold(street) === "") {
      noted(c, "noAddress");
      continue;
    }
    const key = `${fold(street)}|${fold(registrant.address.postalCode)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { people: [c], registrant });
    else group.people.push(c);
  }
  const addressed: AddressRow[] = [];
  for (const { people, registrant } of groups.values()) {
    const a = registrant.address!;
    const lines = a.street
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "");
    const printedAs: string[] = [];
    for (const p of people) for (const t of p.printedAs) if (!printedAs.includes(t)) printedAs.push(t);
    addressed.push({
      names: people.map((p) => p.displayName),
      line1: lines[0] ?? "",
      line2: lines.slice(1).join(", "),
      city: a.city ?? "",
      stateProvince: a.stateProvince ?? "",
      postalCode: a.postalCode ?? "",
      country: countryName(a.country),
      labels: people.reduce((n, p) => n + p.labels, 0),
      printedAs,
      note: null,
    });
  }
  // The collectors were visited in name order and a Map keeps insertion
  // order, so the addressed rows are already sorted by their first collector.
  return [...addressed, ...unaddressed];
}
