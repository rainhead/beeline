import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import type { Messages } from "./messages/index.js";
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
 * sample number, a date that cannot be read, no specimen number (or one below
 * 1), or the same collector, date, sample and specimen number as a record
 * that was kept. On
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
  /** The sample in Beeline its observation is, with the count it states and the specimens it holds. */
  sample: { sampleId: number; counts: number | null; holds: number } | null;
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

const NEEDS = ["legacy_occurrence", "legacy_parsed", "legacy_specimen_number", "legacy_duplicate_record", "legacy_promotion_finding"];

/** Whether the store holds old-Beeline staging and the views promotion left. */
export async function hasHeldBackSources(db: Kysely<Database>): Promise<boolean> {
  const { rows } = await sql<{ n: number | bigint }>`
    SELECT count(DISTINCT table_name) AS n FROM information_schema.tables
    WHERE table_name IN (${sql.join(NEEDS)})`.execute(db);
  return Number(rows[0]?.n ?? 0) === NEEDS.length;
}

/** One held-back record as the store gives it: every staged column, and what the page derives. */
type HeldRow = Record<string, unknown> & {
  _id: string;
  fieldNumber: string | null;
  sampleId: string | null;
  specimenId: string | null;
  day: string | null;
  month: string | null;
  year: string | null;
  day2: string | null;
  month2: string | null;
  year2: string | null;
  url: string | null;
  hb_collector: string | null;
  hb_year: number | null;
  hb_expert: string | null;
  hb_volunteer: string | null;
  hb_rules: HeldBackRule[];
  hb_bare: boolean;
  hb_related_id: number | null;
  hb_related_field_number: string | null;
  hb_remark: string | null;
  hb_sample_id: number | null;
  hb_sample_counts: number | null;
  hb_sample_holds: number | bigint | null;
};

/**
 * Every held-back record in one pass, which the page and the download both
 * read: the findings view ranks every staged record, so it is evaluated once.
 *
 * A record is bare when it has no collector, sample, specimen number, date or
 * identification: the old system's empty labels.
 *
 * `duplicate_specimen` stands only where a record that was carried over has
 * the same collector, sample, date and specimen number. Promotion also gives
 * it to records whose numbers are blank, which rank only against each other
 * (the 177 bare records do), and none of them was kept.
 *
 * Where the record cites an iNaturalist observation that is a sample in
 * Beeline, the sample comes with it, with the count it states and the
 * specimens it holds: a sample that holds fewer than it counts is where a
 * held-back record may belong.
 */
async function readHeld(db: Kysely<Database>): Promise<HeldRow[]> {
  const { rows } = await sql<HeldRow>`
    WITH carried AS (
      SELECT _id FROM legacy_specimen_number UNION SELECT _id FROM legacy_duplicate_record
    ),
    held AS (
      SELECT o.*,
        nullif(trim(concat_ws(' ', nullif(trim(o.firstName), ''), nullif(trim(o.lastName), ''))), '') AS hb_collector,
        try_cast(o.year AS INTEGER) AS hb_year,
        nullif(trim(coalesce(nullif(o.scientificName, ''), concat_ws(' ', nullif(o.genus, ''), nullif(o.specificEpithet, '')))), '') AS hb_expert,
        nullif(trim(concat_ws(' ', nullif(o.genusVolDet, ''), nullif(o.speciesVolDet, ''))), '') AS hb_volunteer,
        try_cast(regexp_extract(o.url, '/observations/([0-9]+)$', 1) AS BIGINT) AS hb_observation
      FROM legacy_occurrence o
      WHERE o._id NOT IN (SELECT _id FROM carried)
    ),
    findings AS MATERIALIZED (
      SELECT f._id, f.rule FROM legacy_promotion_finding f
      WHERE f.severity = 'blocking' AND f._id IN (SELECT _id FROM held)
    ),
    reasons AS (
      SELECT f._id, list(DISTINCT f.rule ORDER BY f.rule) AS hb_rules
      FROM findings f
      WHERE f.rule <> 'duplicate_specimen'
         OR EXISTS (
           SELECT 1 FROM legacy_parsed me JOIN legacy_parsed k
             ON k.fn IS NOT DISTINCT FROM me.fn AND k.ln IS NOT DISTINCT FROM me.ln
            AND k.sid = me.sid AND k.p_date_start = me.p_date_start AND k.p_specimen_number = me.p_specimen_number
           WHERE me._id = f._id AND k._id IN (SELECT _id FROM carried))
      GROUP BY f._id
    ),
    classed AS (
      SELECT h.*, coalesce(r.hb_rules, []) AS hb_rules,
        h.hb_collector IS NULL AND nullif(trim(h.sampleId), '') IS NULL AND nullif(trim(h.specimenId), '') IS NULL
          AND nullif(trim(h.year), '') IS NULL AND h.hb_expert IS NULL AND h.hb_volunteer IS NULL AS hb_bare
      FROM held h LEFT JOIN reasons r USING (_id)
    ),
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
      WHERE NOT c.hb_bare
    ),
    observed AS (
      SELECT s.inat_observation_id, min(s.entity_id) AS sample_id
      FROM sample s WHERE s.inat_observation_id IN (SELECT hb_observation FROM classed)
      GROUP BY s.inat_observation_id
    )
    SELECT c.* EXCLUDE (hb_observation),
      r.specimen_id AS hb_related_id, r.field_number AS hb_related_field_number, r.remarks AS hb_remark,
      ob.sample_id AS hb_sample_id, s.specimen_count AS hb_sample_counts,
      (SELECT count(*) FROM specimen sp WHERE sp.sample_id = ob.sample_id) AS hb_sample_holds
    FROM classed c
    LEFT JOIN remarked r ON r._id = c._id AND r.n = 1
    LEFT JOIN observed ob ON ob.inat_observation_id = c.hb_observation
    LEFT JOIN sample s ON s.entity_id = ob.sample_id
    ORDER BY c.hb_year NULLS LAST, c.fieldNumber, c._id`.execute(db);
  return rows;
}

/** Every held-back record, with its reasons and what Beeline holds of it. Null where the store has no staging. */
export async function heldBackRecords(db: Kysely<Database>): Promise<HeldBack | null> {
  if (!(await hasHeldBackSources(db))) return null;
  const rows = await readHeld(db);
  const { rows: since } = await sql<{ y: number }>`SELECT CAST(extract(year FROM active_since) AS INTEGER) AS y FROM season`.execute(db);
  const activeSince = Number(since[0]!.y);

  // Year, month, day, as the record wrote each, so 4/5 cannot be read either
  // way round; a part it left blank is a question mark.
  const written = (...parts: (string | null)[]) => {
    const [y, m, d] = parts.map((p) => (p ?? "").trim());
    return [y, m, d].every((p) => p === "") ? "" : [y, m, d].map((p) => (p === "" ? "?" : p)).join("-");
  };
  const text = (v: string | null) => ((v ?? "").trim() === "" ? null : v!.trim());
  const listed = rows.filter((r) => !r.hb_bare);
  const records = listed.map((r): HeldBackRecord => {
    const start = written(r.year, r.month, r.day);
    const end = written(r.year2, r.month2, r.day2);
    const observation = /\/observations\/(\d+)$/.exec(r.url ?? "");
    return {
      id: r._id,
      fieldNumber: r.fieldNumber ?? "",
      collector: r.hb_collector,
      sampleNumber: text(r.sampleId),
      specimenNumber: text(r.specimenId),
      date: start === "" && end === "" ? null : end === "" ? start : `${start} to ${end}`,
      year: r.hb_year === null ? null : Number(r.hb_year),
      observationId: observation === null ? null : Number(observation[1]),
      expert: r.hb_expert,
      volunteer: r.hb_volunteer,
      rules: [...r.hb_rules],
      related:
        r.hb_related_id === null
          ? null
          : { specimenId: Number(r.hb_related_id), fieldNumber: r.hb_related_field_number!, remark: r.hb_remark! },
      sample:
        r.hb_sample_id === null
          ? null
          : { sampleId: Number(r.hb_sample_id), counts: r.hb_sample_counts === null ? null : Number(r.hb_sample_counts), holds: Number(r.hb_sample_holds) },
    };
  });
  const bare = rows.filter((r) => r.hb_bare);
  const numbers = [...new Set(bare.map((r) => r.fieldNumber ?? ""))].sort();
  return {
    records,
    bare: bare.length === 0 ? null : { records: bare.length, fieldNumbers: numbers.length, first: numbers[0]!, last: numbers.at(-1)! },
    reasons: HELD_BACK_RULES.flatMap((rule) => {
      const with_ = records.filter((r) => r.rules.includes(rule));
      if (with_.length === 0) return [];
      return [
        {
          rule,
          active: with_.filter((r) => r.year !== null && r.year >= activeSince).length,
          settled: with_.filter((r) => r.year !== null && r.year < activeSince).length,
          noYear: with_.filter((r) => r.year === null).length,
        },
      ];
    }),
    activeSince,
  };
}

/**
 * The download: every held-back record, bare ones too, with every column the
 * old system held, then why it was held back in the page's words, the
 * specimen whose note names it, and the sample its observation is in Beeline.
 */
export async function heldBackCsvRows(db: Kysely<Database>, m: Messages): Promise<{ header: string[]; rows: unknown[][] } | null> {
  if (!(await hasHeldBackSources(db))) return null;
  const { rows: columns } = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'legacy_occurrence' ORDER BY ordinal_position`.execute(db);
  const names = columns.map((c) => c.column_name);
  const rows = await readHeld(db);
  const header = [
    ...names,
    "held_back_because",
    "beeline_note_specimen",
    "beeline_note",
    "beeline_sample_id",
    "beeline_sample_counts",
    "beeline_sample_holds",
  ];
  return {
    header,
    rows: rows.map((r) => [
      ...names.map((n) => r[n] ?? null),
      r.hb_rules.length === 0 ? m.heldBack.noReason : r.hb_rules.map((rule) => m.heldBack.reason[rule]).join("; "),
      r.hb_related_field_number,
      r.hb_remark,
      r.hb_sample_id === null ? null : Number(r.hb_sample_id),
      r.hb_sample_counts === null ? null : Number(r.hb_sample_counts),
      r.hb_sample_id === null ? null : Number(r.hb_sample_holds),
    ]),
  };
}
