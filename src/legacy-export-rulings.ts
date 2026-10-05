import { readFile } from "node:fs/promises";
import { parseCsv } from "./corrections.js";
import { LEGACY_EXPORT_COLUMNS } from "./legacy-export.js";

/**
 * Rulings on the parallel run (beeline-en7i): which differences between the
 * legacy-format export and the legacy system's own records have been
 * explained, so the comparison reports only what nobody has explained yet
 * and the same difference is not investigated twice.
 *
 * The file is `ingest/legacy-export-rulings.csv`, written by hand and
 * reviewed in git like the other curated files beside it; nothing writes it.
 * A ruling names a column and, optionally, a kind of difference and a
 * single record by field number. The field number is the key both systems
 * share and names nobody, which is what lets the file be public; a reason
 * must not name a volunteer either.
 *
 *   expected         Beeline means to differ: it normalises, fills, or follows an edit
 *   reference-wrong  the legacy system has it wrong and Beeline right
 *   beeline-wrong    a Beeline defect, reported until the difference is gone
 *   known-gap        something Beeline does not do yet, on purpose
 *
 * A difference several rulings match is explained by the most specific —
 * a field number beats a whole column, a kind beats every kind — so adding
 * a ruling only ever explains the differences it names.
 */

export const RULING_COLUMNS = [
  "field_number", "column", "kind", "outcome", "reason", "source", "decided_by", "decided_on",
] as const;
export type Ruling = Record<(typeof RULING_COLUMNS)[number], string>;

export const OUTCOMES = ["expected", "reference-wrong", "beeline-wrong", "known-gap"] as const;

/**
 * What a difference in one column's value looks like, judged on the two
 * values alone, first match winning. `changed` is everything else. Those
 * after it are read from the store instead, because the values alone cannot
 * say them, and they take precedence over what the values look like.
 */
export const VALUE_KINDS = [
  "filled", // the legacy record is blank and Beeline says something
  "blanked", // Beeline is blank where the legacy record says something
  "whitespace", // equal once spaces are trimmed and collapsed
  "case", // equal ignoring capitals: Male / male
  "number_form", // the same number written differently: 10 / 10.0
  "date_form", // the same date or range: VII / 7, 2018-5-17/2018-5-17 / 5/17/2018
  "country_code", // a three-letter code where the template has two: CAN / CA
  "initial_form", // the same initials with or without their full stops: S / S.
  "collector_list_form", // the same collectors, one name each: Michael and Dan / Michael | Dan, O'Loughlin / O'Loughlin | O'Loughlin
  "collector_added", // the legacy record's collectors and more, the rest of its sample's: Maggie / Maggie | Henry
  "name_spelling", // a collector's name spaced or punctuated another way: MaryJo Mosby / Mary Jo Mosby
  "subgenus_form", // the subgenus written inside or beside the name: Dialictus / Lasioglossum (Dialictus)
  "authorship", // the same name with or without its author and year: Halictus ligatus Say, 1837
  "morphospecies", // a morphospecies the tree cannot hold, written as its genus: Melissodes sp.1 / Melissodes
  "changed",
  "collector_alias", // the legacy spelling of a collector, corrected in ingest/collector-aliases.csv: Brendon / Brendan
  "taxon_alias", // a misspelt genus or epithet, corrected in ingest/taxon-aliases.csv: Agopostemon / Agapostemon
  "staff_correction", // the legacy row as staff corrected it: Kennedy Rd. / Caledon
  "collector_order", // the pair in one order where its sample's rows list it both ways
  "initial_from_surname", // an initial taken from the family name: Alyssa Tollefson as T.
  "label_name", // the initials a label name gives: J. / J.M.
  "newer_determination", // an expert identification from Ecdysis or Beeline, newer than the legacy record's
  "one_day_range", // an end the legacy record wrote on its start day: 2018-7-26/2018-7-26
  "login_renamed", // the same iNaturalist user id under another login
  "sample_disagreement", // the legacy rows Beeline merged into one sample name different places, and the sample keeps one
] as const;

/**
 * A record only one side holds is a difference about the whole record, in
 * the column named `(record)`. Its kind says why: the blocking promotion
 * finding that stopped a legacy record becoming a specimen
 * (`legacy_promotion_finding`: duplicate_specimen, bad_date, …), or, for a
 * record only Beeline holds, whether Beeline minted its number.
 */
export const RECORD_COLUMN = "(record)";
export const RECORD_KINDS_FIXED = ["not_promoted", "not_exported", "minted_by_beeline", "not_in_legacy"] as const;

const HEADER = RULING_COLUMNS.join(",");
const COLUMNS = new Set<string>([...LEGACY_EXPORT_COLUMNS, RECORD_COLUMN]);

export function rulingKey(r: Pick<Ruling, "field_number" | "column" | "kind">): string {
  return `${r.field_number}\t${r.column}\t${r.kind}`;
}

export function rulingProblem(r: Ruling): string | null {
  if (!COLUMNS.has(r.column)) return `'${r.column}' is neither an exported column nor ${RECORD_COLUMN}`;
  if (r.kind !== "") {
    if (r.column === RECORD_COLUMN) {
      // The finding names are promotion's vocabulary and can grow; a misspelt
      // one matches nothing, which the report says of every such ruling.
      if (!/^[a-z_]+$/.test(r.kind)) return `'${r.kind}' is not a record kind`;
    } else if (!(VALUE_KINDS as readonly string[]).includes(r.kind)) {
      return `'${r.kind}' is not a kind of difference (${VALUE_KINDS.join(", ")})`;
    }
  }
  if (r.field_number !== r.field_number.trim()) return "the field number has spaces around it";
  if (!(OUTCOMES as readonly string[]).includes(r.outcome)) return `outcome '${r.outcome}' is not one of ${OUTCOMES.join(", ")}`;
  if (r.reason.trim() === "") return "every ruling says why";
  if (r.source.trim() === "") return "every ruling says where the call was made";
  if (r.decided_by.trim() === "") return "every ruling says who decided";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.decided_on)) return `decided_on '${r.decided_on}' is not a date (YYYY-MM-DD)`;
  return null;
}

export function parseRulings(text: string, where: string): Ruling[] {
  const records = parseCsv(text.replace(/^﻿/, "")).filter((r) => !(r.length === 1 && r[0] === ""));
  if (records.length === 0) return [];
  const header = records[0]!;
  if (header.join(",") !== HEADER) throw new Error(`${where}: header is '${header.join(",")}', expected '${HEADER}'`);
  const seen = new Set<string>();
  return records.slice(1).map((fields, i) => {
    const line = i + 2;
    if (fields.length !== RULING_COLUMNS.length) {
      throw new Error(`${where} line ${line}: ${fields.length} fields, expected ${RULING_COLUMNS.length}`);
    }
    const r = Object.fromEntries(RULING_COLUMNS.map((c, j) => [c, fields[j]!])) as Ruling;
    const bad = rulingProblem(r);
    if (bad !== null) throw new Error(`${where} line ${line}: ${bad}`);
    const key = rulingKey(r);
    if (seen.has(key)) throw new Error(`${where} line ${line}: this column, kind and field number are ruled on twice`);
    seen.add(key);
    return r;
  });
}

/** The rulings at `path`, or none when there is no file yet. */
export async function readRulings(path: string): Promise<Ruling[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return parseRulings(text, path);
}
