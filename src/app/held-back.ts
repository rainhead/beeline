import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { REMARK_SOURCE } from "../repair-legacy-skipped.js";

/**
 * The old Beeline's records that new Beeline holds back (beeline-cel0): for
 * Lincoln Best, who asked to see which records were not carried over and
 * why (Peter, 2026-11-13).
 *
 * A staged record (`legacy_occurrence`, one per record the old system held at
 * cutover) is carried over when promotion numbered it into a sample
 * (`legacy_specimen_number`, ingest/promote-legacy.sql, which the one-time
 * repair also writes for the records it placed) or when the repair tied it to
 * a specimen as a second record (`legacy_duplicate_record`, schema/040).
 * Every other record is held back, and why is the blocking findings
 * promotion recorded for it (`legacy_promotion_finding`): no collector, no
 * sample number, a date that cannot be read, no specimen number, or the same
 * collector, date, sample and specimen number as a record that was kept. On
 * the production store of 13 November 2026 that was 276 records, every one
 * with a finding.
 *
 * The anti-join reads the table rather than `legacy_specimen_map`, which
 * joins it to `specimen` by number and would call a record held back if its
 * specimen were ever renumbered.
 *
 * Where the repair could not settle a record, it wrote what is in doubt on
 * the specimen it most resembles, naming the record by its field number
 * (src/repair-legacy-skipped.ts, writeRemarks): all 32 records held back as a
 * second print on that store are such a record, which the repair judged may
 * be a second bee. The page shows that specimen and its remark beside the
 * record. The remark is found by the field number it names, among the
 * repair's own remarks only; the repair ran once and its wording is fixed.
 *
 * These are views and tables promotion creates, not the schema's, so a
 * store without old-Beeline staging (a fresh development store, or a test)
 * has none of them, and the page says so rather than failing.
 */

/** A promotion finding that holds a record back (ingest/promote-legacy.sql). */
export const HELD_BACK_RULES = ["missing_person", "missing_sample_number", "bad_date", "bad_specimen_number", "duplicate_specimen"] as const;
export type HeldBackRule = (typeof HELD_BACK_RULES)[number];

export interface HeldBackRecord {
  id: string;
  fieldNumber: string;
  collector: string | null;
  sampleNumber: string | null;
  specimenNumber: string | null;
  /** The date as the record wrote it, year-month-day with ? for a blank part, and the end where there is one. */
  date: string | null;
  /** The year as written, where it reads as a year. */
  year: number | null;
  observationId: number | null;
  /** The expert's identification as written, else null. */
  expert: string | null;
  /** The volunteer's, as written, else null. */
  volunteer: string | null;
  rules: HeldBackRule[];
  /** The specimen whose remark names this record, if the repair wrote one. */
  related: { specimenId: number; fieldNumber: string; remark: string } | null;
}

/** Records that hold nothing but a field number: counted, not listed. */
export interface BareRecords {
  records: number;
  fieldNumbers: number;
  first: string;
  last: string;
}

export interface ReasonCount {
  rule: HeldBackRule;
  /** Records from the active seasons (season.active_since), by the year they give. */
  active: number;
  settled: number;
  /** Records whose year cannot be read. */
  noYear: number;
}

export interface HeldBack {
  records: HeldBackRecord[];
  bare: BareRecords | null;
  /** Each reason with its records, the bare ones left out; a record can have more than one. */
  reasons: ReasonCount[];
  /** The first year of the active seasons, which the counts split at. */
  activeSince: number;
}

const NEEDS = ["legacy_occurrence", "legacy_specimen_number", "legacy_duplicate_record", "legacy_promotion_finding"];

/** Whether the store holds old-Beeline staging and the views promotion left. */
export async function hasHeldBackSources(db: Kysely<Database>): Promise<boolean> {
  const { rows } = await sql<{ n: number | bigint }>`
    SELECT count(DISTINCT table_name) AS n FROM information_schema.tables
    WHERE table_name IN (${sql.join(NEEDS)})`.execute(db);
  return Number(rows[0]?.n ?? 0) === NEEDS.length;
}

/**
 * The held-back records with their reasons, as a temporary relation every
 * query below reads. A record is bare when it has no collector, sample,
 * specimen number, date or identification: the old system's empty labels.
 */
const HELD = sql`
  held AS (
    SELECT o.*,
      nullif(trim(concat_ws(' ', nullif(trim(o.firstName), ''), nullif(trim(o.lastName), ''))), '') AS collector,
      try_cast(o.year AS INTEGER) AS p_year,
      nullif(trim(coalesce(nullif(o.scientificName, ''), concat_ws(' ', nullif(o.genus, ''), nullif(o.specificEpithet, '')))), '') AS expert,
      nullif(trim(concat_ws(' ', nullif(o.genusVolDet, ''), nullif(o.speciesVolDet, ''))), '') AS volunteer
    FROM legacy_occurrence o
    WHERE o._id NOT IN (SELECT _id FROM legacy_specimen_number)
      AND o._id NOT IN (SELECT _id FROM legacy_duplicate_record)
  ),
  reasons AS (
    SELECT f._id, list(DISTINCT f.rule ORDER BY f.rule) AS rules
    FROM legacy_promotion_finding f
    WHERE f.severity = 'blocking' AND f._id IN (SELECT _id FROM held)
    GROUP BY f._id
  ),
  classed AS (
    SELECT h.*, coalesce(r.rules, []) AS rules,
      h.collector IS NULL AND nullif(trim(h.sampleId), '') IS NULL AND nullif(trim(h.specimenId), '') IS NULL
        AND nullif(trim(h.year), '') IS NULL AND h.expert IS NULL AND h.volunteer IS NULL AS bare
    FROM held h LEFT JOIN reasons r USING (_id)
  )`;

/** Every held-back record, with its reasons and what the repair said about it. Null where the store has no staging. */
export async function heldBackRecords(db: Kysely<Database>): Promise<HeldBack | null> {
  if (!(await hasHeldBackSources(db))) return null;
  const { rows: listed } = await sql<{
    _id: string;
    fieldNumber: string | null;
    collector: string | null;
    sampleId: string | null;
    specimenId: string | null;
    day: string | null;
    month: string | null;
    year: string | null;
    day2: string | null;
    month2: string | null;
    year2: string | null;
    p_year: number | null;
    url: string | null;
    expert: string | null;
    volunteer: string | null;
    rules: HeldBackRule[];
    related_id: number | null;
    related_field_number: string | null;
    remark: string | null;
  }>`
    WITH ${HELD},
    remarked AS (
      SELECT c._id, d.specimen_id, sp.field_number, d.remarks,
        row_number() OVER (PARTITION BY c._id ORDER BY d.specimen_id) AS n
      FROM classed c
      JOIN specimen_disposition d
        ON d.source = ${REMARK_SOURCE} AND coalesce(c.fieldNumber, '') <> ''
       -- Ended by a space or, for a record the repair matched despite missing details, a comma.
       AND (strpos(d.remarks, concat('field number ', c.fieldNumber, ' ')) > 0
            OR strpos(d.remarks, concat('field number ', c.fieldNumber, ',')) > 0)
      JOIN specimen sp ON sp.entity_id = d.specimen_id
      WHERE NOT c.bare
    )
    SELECT c._id, c.fieldNumber, c.collector, c.sampleId, c.specimenId, c.day, c.month, c.year,
           c.day2, c.month2, c.year2, c.p_year, c.url, c.expert, c.volunteer, c.rules,
           r.specimen_id AS related_id, r.field_number AS related_field_number, r.remarks AS remark
    FROM classed c LEFT JOIN remarked r ON r._id = c._id AND r.n = 1
    WHERE NOT c.bare
    ORDER BY c.p_year NULLS LAST, c.fieldNumber, c._id`.execute(db);

  const { rows: bare } = await sql<{ records: number | bigint; field_numbers: number | bigint; first: string; last: string }>`
    WITH ${HELD}
    SELECT count(*) AS records, count(DISTINCT fieldNumber) AS field_numbers, min(fieldNumber) AS first, max(fieldNumber) AS last
    FROM classed WHERE bare`.execute(db);

  const { rows: counts } = await sql<{ rule: HeldBackRule; active: number | bigint; settled: number | bigint; no_year: number | bigint }>`
    WITH ${HELD}, since AS (SELECT CAST(extract(year FROM active_since) AS INTEGER) AS y FROM season)
    SELECT rule,
      count(*) FILTER (WHERE p_year >= (SELECT y FROM since)) AS active,
      count(*) FILTER (WHERE p_year < (SELECT y FROM since)) AS settled,
      count(*) FILTER (WHERE p_year IS NULL) AS no_year
    FROM (SELECT unnest(rules) AS rule, p_year FROM classed WHERE NOT bare)
    GROUP BY rule`.execute(db);
  const { rows: since } = await sql<{ y: number }>`SELECT CAST(extract(year FROM active_since) AS INTEGER) AS y FROM season`.execute(db);

  // Year, month, day, as the record wrote each, so 4/5 cannot be read either
  // way round; a part it left blank is a question mark.
  const written = (...parts: (string | null)[]) => {
    const [y, m, d] = parts.map((p) => (p ?? "").trim());
    return [y, m, d].every((p) => p === "") ? "" : [y, m, d].map((p) => (p === "" ? "?" : p)).join("-");
  };
  const text = (v: string | null) => ((v ?? "").trim() === "" ? null : v!.trim());
  const records = listed.map((r): HeldBackRecord => {
    const start = written(r.year, r.month, r.day);
    const end = written(r.year2, r.month2, r.day2);
    const observation = /\/observations\/(\d+)$/.exec(r.url ?? "");
    return {
      id: r._id,
      fieldNumber: r.fieldNumber ?? "",
      collector: r.collector,
      sampleNumber: text(r.sampleId),
      specimenNumber: text(r.specimenId),
      date: start === "" && end === "" ? null : end === "" ? start : `${start} to ${end}`,
      year: r.p_year === null ? null : Number(r.p_year),
      observationId: observation === null ? null : Number(observation[1]),
      expert: r.expert,
      volunteer: r.volunteer,
      rules: [...r.rules],
      related:
        r.related_id === null ? null : { specimenId: Number(r.related_id), fieldNumber: r.related_field_number!, remark: r.remark! },
    };
  });
  const b = bare[0];
  return {
    records,
    bare: b === undefined || Number(b.records) === 0 ? null : { records: Number(b.records), fieldNumbers: Number(b.field_numbers), first: b.first, last: b.last },
    reasons: HELD_BACK_RULES.flatMap((rule) => {
      const c = counts.find((x) => x.rule === rule);
      return c === undefined ? [] : [{ rule, active: Number(c.active), settled: Number(c.settled), noYear: Number(c.no_year) }];
    }),
    activeSince: Number(since[0]!.y),
  };
}

/** The download: every held-back record, bare ones too, with every column the old system held and why it was held back. */
export async function heldBackCsvRows(db: Kysely<Database>): Promise<{ header: string[]; rows: unknown[][] } | null> {
  if (!(await hasHeldBackSources(db))) return null;
  const { rows: columns } = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'legacy_occurrence' ORDER BY ordinal_position`.execute(db);
  const names = columns.map((c) => c.column_name);
  const { rows } = await sql<Record<string, unknown>>`
    WITH ${HELD}
    SELECT ${sql.join(names.map((n) => sql.ref(`classed.${n}`)))}, array_to_string(rules, ';') AS held_back_because
    FROM classed
    ORDER BY p_year NULLS LAST, fieldNumber, _id`.execute(db);
  const header = [...names, "held_back_because"];
  return { header, rows: rows.map((r) => header.map((h) => r[h] ?? null)) };
}
