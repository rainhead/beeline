import type { DuckDBConnection } from "@duckdb/node-api";
import { matchCollectors, type MatchedCollector } from "./collector-match.js";
import { withPrintRunLock } from "./print-run.js";

/**
 * Trap samples entered in Beeline (beeline-3vs.2).
 *
 * Until now every sample came from iNaturalist or the old Beeline. Trap
 * samples had no way in except a spreadsheet staff prepared and uploaded to
 * the old system, a few batches a year, so this is a form: the fields are the
 * ones Lincoln Best's registry of Oregon's trap samples and the old system's
 * trap rows carry that a label prints or a Darwin Core record would carry
 * (the scope rule on beeline-3vs). Beeline is the only record of a sample
 * entered here (beeline-ni5m.9), so the writes go straight to the store, and
 * `sample_entry` marks the sample as one of these.
 *
 * Who may: staff, and anyone who has ever collected a trap sample (Peter,
 * 2026-11-04, beeline-3vs.1). A sample entered here is edited from the same
 * form until its labels are frozen into a print run.
 */

/** What the form posts: every field as typed. */
export interface TrapSampleForm {
  sample_number: string;
  /** Collector names in order, the first being the primary. Blank entries are ignored. */
  collectors: string[];
  date_start: string;
  date_end: string;
  method: string;
  trap_count: string;
  specimen_count: string;
  latitude: string;
  longitude: string;
  uncertainty: string;
  country: string;
  state_province: string;
  county: string;
  locality: string;
}

/** The methods the spreadsheets use most; anything else may be written in. */
export const TRAP_METHODS = ["vane trap", "pan trap", "malaise trap", "trap nest"] as const;

/** A sample ready to write. */
export interface TrapSample {
  sample_number: string;
  collector_ids: number[];
  date_start: string;
  date_end: string;
  protocol: string;
  sampling_effort: string | null;
  specimen_count: number;
  latitude: number;
  longitude: number;
  uncertainty_m: number | null;
  country: string;
  state_province: string;
  county: string | null;
  locality: string | null;
}

export type FieldProblems = Partial<Record<keyof TrapSampleForm, string>>;

async function rows<T>(conn: DuckDBConnection, sql: string, params: unknown[] = []): Promise<T[]> {
  const reader = await conn.runAndReadAll(sql, params as never);
  return reader.getRowObjectsJS() as T[];
}

/**
 * Who may enter trap samples: staff, and anyone who is a collector on a trap
 * sample already (Peter, 2026-11-04). Derived rather than granted, so nobody
 * has to be set up first; a grant for someone new to trapping is beeline-3vs.1.
 */
/**
 * A trap sample's effort as the old records wrote it: the count and the trap
 * kind, plural where there is more than one ('6 vane traps'). Staff correcting
 * the method on the sample page may already have written it plural.
 */
export const trapEffort = (count: number, method: string): string =>
  `${count} ${method}${count === 1 || /s$/i.test(method) ? "" : "s"}`;

/** The trap count an effort written by trapEffort starts with, or null. */
export const trapCountOf = (effort: string | null): number | null => {
  const found = /^(\d+) /.exec(effort ?? "");
  return found === null ? null : Number(found[1]);
};

export async function mayEnterTrapSamples(conn: DuckDBConnection, personId: number | null, admin: boolean): Promise<boolean> {
  if (admin) return true;
  if (personId === null) return false;
  const found = await rows<{ n: number }>(
    conn,
    `SELECT count(*)::INTEGER AS n FROM sample_collector c JOIN sample s ON s.entity_id = c.sample_id
     WHERE c.person_id = $1 AND s.kind = 'trap'`,
    [personId],
  );
  return (found[0]?.n ?? 0) > 0;
}

/**
 * Who may edit an entered sample: staff, one of its collectors, or whoever
 * entered it, as the correction form lets a collector edit only their own
 * samples (CodeRabbit). Entering is open to every trapper; editing someone
 * else's sample is not. Once the sample's season settles (`settled_sample`) its other collectors lose the form and only
 * whoever entered it, and staff, keep it (Peter, 2026-11-19): samples staff load on a collector's behalf, the registry's
 * settled ones, must not give every collector named on them a permanent right to rewrite them, while a trapper's own
 * late entry stays theirs to fix.
 */
export async function mayEditTrapSample(conn: DuckDBConnection, sampleId: number, personId: number | null, admin: boolean): Promise<boolean> {
  if (admin) return true;
  if (personId === null) return false;
  const found = await rows<{ n: number }>(
    conn,
    `SELECT count(*)::INTEGER AS n FROM sample_entry e
     WHERE e.sample_id = $1
       AND (e.entered_by = $2
            OR (NOT EXISTS (SELECT 1 FROM settled_sample ss WHERE ss.sample_id = e.sample_id)
                AND EXISTS (SELECT 1 FROM sample_collector c WHERE c.sample_id = e.sample_id AND c.person_id = $2)))`,
    [sampleId, personId],
  );
  return (found[0]?.n ?? 0) > 0;
}

/** The people the collector boxes offer: everyone who has collected anything, trap collectors first. */
export async function collectorChoices(conn: DuckDBConnection): Promise<{ name: string; trap: boolean }[]> {
  const found = await rows<{ display_name: string; trap: boolean }>(
    conn,
    `SELECT p.display_name, bool_or(s.kind = 'trap') AS trap
     FROM person p JOIN sample_collector c ON c.person_id = p.entity_id JOIN sample s ON s.entity_id = c.sample_id
     GROUP BY p.entity_id, p.display_name
     ORDER BY trap DESC, p.display_name`,
  );
  return found.map((r) => ({ name: r.display_name, trap: r.trap }));
}

/**
 * The next number in a prefixed series: the highest number after the prefix
 * on any sample, plus one, zero-padded to five digits (OBAS-00657, Peter,
 * 2026-10-30). The series keeps counting across years.
 */
export async function nextSampleNumber(conn: DuckDBConnection, prefix = "OBAS-"): Promise<string> {
  return `${prefix}${String((await highestSampleNumber(conn, prefix)) + 1).padStart(5, "0")}`;
}

/** The highest number after the prefix on any sample, 0 if none has the prefix: what the next number offered counts from. */
export async function highestSampleNumber(conn: DuckDBConnection, prefix = "OBAS-"): Promise<number> {
  const found = await rows<{ n: number | null }>(
    conn,
    `SELECT max(TRY_CAST(substr(sample_number, length($1) + 1) AS INTEGER))::INTEGER AS n
     FROM sample WHERE starts_with(sample_number, $1)`,
    [prefix],
  );
  return found[0]?.n ?? 0;
}

/** A stored number that may be a spelling of the program's series: its letters in order, with separators between them. A prefilter, then the fold decides. */
const MAYBE_PROGRAM_SERIES = `regexp_matches(upper(sample_number), 'O[\\s\\-_./]*B[\\s\\-_./]*A[\\s\\-_./]*S')`;
const FOLDED_NUMBER = `regexp_replace(upper(sample_number), '[\\s\\-_./]+', '', 'g')`;

/**
 * The highest number in the program's series among the numbers written as it, in any spelling: OBAS and exactly five
 * digits after folding (so `OBAS 00040` counts, and `OBAS-100000` or `OBAS-1204` neither exhaust the series nor skew
 * it). What a blank row's number is counted from.
 */
export async function highestSeriesNumber(conn: DuckDBConnection): Promise<number> {
  const found = await rows<{ n: number | null }>(
    conn,
    `SELECT max(CAST(substr(f, 5) AS INTEGER))::INTEGER AS n
     FROM (SELECT ${FOLDED_NUMBER} AS f FROM sample WHERE ${MAYBE_PROGRAM_SERIES}) WHERE regexp_full_match(f, 'OBAS[0-9]{5}')`,
  );
  return found[0]?.n ?? 0;
}

/** What a form carries as its number when the real one is given under the print runs' lock, so the form's own checks run. */
export const AUTO_NUMBER_PLACEHOLDER = "(next number)";

/** The series the program numbers its own trap samples in, whose next number the form offers. */
export const PROGRAM_SERIES = "OBAS-";

/** A number with its spaces and separators taken out and upper-cased, so that spellings of one number meet. */
export const foldNumber = (sampleNumber: string): string => sampleNumber.toUpperCase().replace(/[\s\-_./]+/g, "");

/** Whether a number is a spelling of the program's own series: OBAS and digits, however written (`obas-00700`, `OBAS 00700`, `OBAS00700`). */
export const isProgramSeries = (sampleNumber: string): boolean => /^OBAS\d+$/.test(foldNumber(sampleNumber));

/**
 * The sentence saying why a number in the program's series cannot be used, or null if it can: it must be written
 * exactly `OBAS-` and five digits, so a spelling that folds to the same number (`obas-00700`, `OBAS00700`) is not used
 * either. A number outside the series is not judged: a collector's own numbers are theirs. How far a number may be from
 * the others is not checked: the series' numbers wait for a person to confirm them (Peter, 2026-11-19), since the
 * highest in the store may be a block set aside, as OBAS-20214 is.
 */
export function seriesNumberProblem(sampleNumber: string): string | null {
  if (!isProgramSeries(sampleNumber) && !sampleNumber.startsWith(PROGRAM_SERIES)) return null;
  if (!/^OBAS-\d{5}$/.test(sampleNumber)) {
    return `A number like OBAS is the program's own and is written exactly ${PROGRAM_SERIES} and five digits, such as ${PROGRAM_SERIES}00657, not "${sampleNumber}".`;
  }
  return null;
}

/** A number written as a series: letters, a hyphen and what follows, such as OBAS-00657 or WBAS-00012. */
export const isSeriesNumber = (sampleNumber: string): boolean => /^[A-Za-z]+-/.test(sampleNumber);

/**
 * The sample, of any kind, that has this number, if the number is a series number. A series number is the program's
 * and unique, though the old Beeline holds some trap bottles as net samples, and a net sample's own plain numbers
 * ("3") are the collector's for the day and shared, so only a series number is judged. The program's own series is
 * compared on the folded form, so a sample written `OBAS 00700` holds `OBAS-00700`. The trap form's own check counts
 * trap samples only; the upload path asks this as well.
 */
export async function seriesNumberHolder(conn: DuckDBConnection, sampleNumber: string): Promise<{ sampleId: number; kind: string } | null> {
  const found = isProgramSeries(sampleNumber)
    ? await rows<{ entity_id: number; kind: string }>(
        conn,
        `SELECT entity_id, kind FROM sample
         WHERE ${MAYBE_PROGRAM_SERIES} AND ${FOLDED_NUMBER} = $1
         ORDER BY entity_id LIMIT 1`,
        [foldNumber(sampleNumber)],
      )
    : isSeriesNumber(sampleNumber)
      ? await rows<{ entity_id: number; kind: string }>(conn, `SELECT entity_id, kind FROM sample WHERE sample_number = $1 ORDER BY entity_id LIMIT 1`, [sampleNumber])
      : [];
  return found[0] === undefined ? null : { sampleId: found[0].entity_id, kind: found[0].kind };
}

/** What a series number that another sample already has is told, with how to compare the row with that sample. */
export const seriesNumberHeldProblem = (sampleNumber: string, holder: { sampleId: number; kind: string }) =>
  `${sampleNumber} is already a ${holder.kind} sample in Beeline, sampleId ${holder.sampleId}. To compare this row with that sample, put its sampleId in the row (changes to existing samples are not applied yet); otherwise give the new sample another number.`;

/** How near a new sample's point must be to an existing sample's, in metres, for the two to look like one sample. */
export const LOOKALIKE_METRES = 100;

/** A sample that a new one looks like. */
export interface Lookalike {
  sampleId: number;
  sampleNumber: string;
  /** For a look-alike in the same file, its row there (and `sampleId` is 0). */
  fileRow?: number;
}

/** The facts of a sample that its look-alikes are judged by. */
export interface LookalikeFacts {
  firstCollectorId: number;
  dateStart: string;
  dateEnd: string;
  latitude: number;
  longitude: number;
}

/** The same rule as findLookalikes, for two rows of one file that are not in the store yet. */
export function lookAlike(a: LookalikeFacts, b: LookalikeFacts): boolean {
  if (a.firstCollectorId !== b.firstCollectorId || a.dateStart > b.dateEnd || b.dateStart > a.dateEnd) return false;
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h)) <= LOOKALIKE_METRES;
}

/**
 * The samples a new trap sample looks like: the same first collector, collecting days that overlap, and a point
 * within LOOKALIKE_METRES. Any kind of sample counts, a net sample as well as a trap. One rule, in one place, so
 * the preview that holds the row and the job that makes it judge it alike.
 */
export async function findLookalikes(
  conn: DuckDBConnection,
  sample: LookalikeFacts,
  /** Samples not to count: the one being made, and those a samples file's apply has made already (its own rows are not look-alikes of one another). */
  excluding: { sampleId?: number; uploadId?: number } = {},
): Promise<Lookalike[]> {
  // A box a little wider than the distance first, which a place's coordinates can answer from their own order, then
  // the great-circle distance for what is inside it.
  const degrees = (LOOKALIKE_METRES * 1.5) / 111_000;
  const reach = degrees / Math.max(0.05, Math.cos((sample.latitude * Math.PI) / 180));
  const found = await rows<{ entity_id: number; sample_number: string }>(
    conn,
    `SELECT s.entity_id, s.sample_number
     FROM sample_collector c
     JOIN sample s ON s.entity_id = c.sample_id
     JOIN sample_location l ON l.sample_id = s.entity_id
     WHERE c.person_id = $1 AND c.position = 1
       -- the first collector as sample_primary_collector has it: exactly one at position 1
       AND (SELECT count(*) FROM sample_collector c2 WHERE c2.sample_id = s.entity_id AND c2.position = 1) = 1
       AND s.entity_id IS DISTINCT FROM $9::INTEGER
       AND ($10::INTEGER IS NULL OR NOT EXISTS (
             SELECT 1 FROM upload_sample_outcome o
             WHERE o.upload_id = $10 AND o.sample_id = s.entity_id AND o.outcome = 'created'))
       AND s.date_start <= $3::DATE AND s.date_end >= $2::DATE
       AND l.latitude BETWEEN $4 - $6 AND $4 + $6
       AND l.longitude BETWEEN $5 - $7 AND $5 + $7
       AND 2 * 6371000 * asin(sqrt(
             power(sin(radians(l.latitude - $4) / 2), 2) +
             cos(radians($4)) * cos(radians(l.latitude)) * power(sin(radians(l.longitude - $5) / 2), 2)
           )) <= $8
     ORDER BY s.entity_id`,
    [sample.firstCollectorId, sample.dateStart, sample.dateEnd, sample.latitude, sample.longitude, degrees, reach, LOOKALIKE_METRES, excluding.sampleId ?? null, excluding.uploadId ?? null],
  );
  return found.map((r) => ({ sampleId: r.entity_id, sampleNumber: r.sample_number }));
}

/**
 * Whether another trap sample has this number. Unique among trap samples
 * only (Peter, 2026-11-04): an OBAS- number is the program's, while a net
 * sample's number is its collector's for the day, so thousands of net
 * samples share "3". Asked once to answer the form, and again by the writers
 * inside the print runs' lock, which every trap write takes, so two saves of
 * the number the form offered both cannot pass (CodeRabbit).
 */
async function numberTaken(conn: DuckDBConnection, sampleNumber: string, sampleId: number | null): Promise<boolean> {
  const taken = await rows<{ entity_id: number }>(
    conn,
    `SELECT entity_id FROM sample WHERE kind = 'trap' AND sample_number = $1 AND entity_id IS DISTINCT FROM $2 LIMIT 1`,
    [sampleNumber, sampleId],
  );
  return taken.length > 0;
}

export const numberTakenProblem = (sampleNumber: string) => `Trap sample ${sampleNumber} is already in Beeline.`;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(s: string): string | null {
  const m = DATE.exec(s.trim());
  if (m === null) return null;
  const d = new Date(`${m[0]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[0] ? null : m[0];
}

function parseNumber(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Check a form and resolve its names. Problems are per field, worded for the
 * person at the form. `sampleId` is the sample being edited, whose own number
 * is not a clash.
 */
export async function checkTrapSample(
  conn: DuckDBConnection,
  form: TrapSampleForm,
  sampleId: number | null = null,
  /** Whoever is at the form is staff: a problem with a name then points at the staff pages that settle it. */
  {
    staff = false,
    people,
  }: {
    staff?: boolean;
    /** Everyone Beeline knows (readPeople, src/collector-match.ts), read once by a caller that checks many forms. */
    people?: readonly MatchedCollector[];
  } = {},
): Promise<{ sample: TrapSample } | { problems: FieldProblems }> {
  const problems: FieldProblems = {};
  const sampleNumber = form.sample_number.trim();
  if (sampleNumber === "") problems.sample_number = "A sample number is needed.";
  else {
    if (await numberTaken(conn, sampleNumber, sampleId)) problems.sample_number = numberTakenProblem(sampleNumber);
  }

  // Named as every list of collectors is named (src/collector-match.ts).
  const matched = await matchCollectors(conn, form.collectors, { staff, people });
  const collectorIds = "problem" in matched ? [] : matched.collectors.map((c) => c.person_id);
  if ("problem" in matched) problems.collectors = matched.problem;

  const start = parseDate(form.date_start);
  if (start === null) problems.date_start = "The day the traps were set is needed.";
  const end = form.date_end.trim() === "" ? start : parseDate(form.date_end);
  if (end === null) problems.date_end = "The day the traps were collected is not a date.";
  else if (start !== null && end < start) problems.date_end = "The traps were collected before they were set.";

  const method = form.method.trim();
  if (method === "") problems.method = "Say what kind of trap.";
  const trapCount = parseNumber(form.trap_count);
  if (form.trap_count.trim() !== "" && (trapCount === null || !Number.isInteger(trapCount) || trapCount < 1)) {
    problems.trap_count = "The number of traps is a whole number, 1 or more.";
  }
  const specimens = form.specimen_count.trim() === "" ? 0 : parseNumber(form.specimen_count);
  if (specimens === null || !Number.isInteger(specimens) || specimens < 0) {
    problems.specimen_count = "The number of specimens is a whole number, 0 until they are pinned.";
  }

  const latitude = parseNumber(form.latitude);
  const longitude = parseNumber(form.longitude);
  if (latitude === null || latitude < -90 || latitude > 90) problems.latitude = "A latitude in decimal degrees is needed.";
  if (longitude === null || longitude < -180 || longitude > 180) problems.longitude = "A longitude in decimal degrees is needed.";
  const uncertainty = parseNumber(form.uncertainty);
  if (form.uncertainty.trim() !== "" && (uncertainty === null || !Number.isInteger(uncertainty) || uncertainty < 1)) {
    problems.uncertainty = "The uncertainty is a whole number of metres.";
  }

  const country = form.country.trim();
  const state = form.state_province.trim().toUpperCase();
  if (country === "") problems.country = "A country is needed.";
  if (state === "") problems.state_province = "A state or province is needed.";

  if (Object.keys(problems).length > 0) return { problems };
  return {
    sample: {
      sample_number: sampleNumber,
      collector_ids: collectorIds,
      date_start: start!,
      date_end: end!,
      protocol: method,
      // Effort as the old records wrote it ('6 vane traps'), from its own field.
      sampling_effort: trapCount === null ? null : trapEffort(trapCount, method),
      specimen_count: specimens!,
      latitude: latitude!,
      longitude: longitude!,
      uncertainty_m: uncertainty,
      country,
      state_province: state,
      county: form.county.trim() === "" ? null : form.county.trim(),
      locality: form.locality.trim() === "" ? null : form.locality.trim(),
    },
  };
}

async function inTransaction<T>(conn: DuckDBConnection, fn: () => Promise<T>): Promise<T> {
  await conn.run("BEGIN TRANSACTION");
  try {
    const result = await fn();
    await conn.run("COMMIT");
    return result;
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}

async function writeParts(conn: DuckDBConnection, id: number, s: TrapSample, withAtlas = true): Promise<void> {
  for (const [i, personId] of s.collector_ids.entries()) {
    await conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES ($1, $2, $3)`, [id, personId, i + 1] as never);
  }
  await conn.run(
    `INSERT INTO sample_location (sample_id, latitude, longitude, coordinate_uncertainty_m, source)
     VALUES ($1, $2, $3, $4, 'staff_entry')`,
    [id, s.latitude, s.longitude, s.uncertainty_m] as never,
  );
  if (!withAtlas) return;
  // The atlas from the state, as minting assigns it (ingest/mint-samples.sql).
  await conn.run(
    `INSERT INTO sample_atlas (sample_id, atlas_id)
     SELECT $1, atlas_id FROM atlas_region WHERE state_province = $2 AND atlas_id IS NOT NULL LIMIT 1`,
    [id, s.state_province] as never,
  );
}

/**
 * Staff releasing a sample for printing as they save it (beeline-3vs.7): the
 * release is a row of its own, written in the save's own transaction unless
 * one already stands. It is written in an active season too, where it changes
 * nothing yet, so that a count staff set still prints if the sample is not
 * printed before its season settles on 1 March (Peter, 2026-11-19: a count
 * staff set prints whatever its season). `personId` is the staff member, who
 * may be no person (null).
 */
export interface StaffRelease {
  personId: number | null;
}

async function releaseByStaff(conn: DuckDBConnection, sampleId: number, by: StaffRelease): Promise<void> {
  await conn.run(
    `INSERT INTO sample_print_release_event (sample_id, action, person_id)
     SELECT s.entity_id, 'release', $2 FROM sample s
     WHERE s.entity_id = $1 AND NOT EXISTS (SELECT 1 FROM sample_print_release r WHERE r.sample_id = s.entity_id)`,
    [sampleId, by.personId] as never,
  );
}

/**
 * Write a new trap sample; its id. Behind the print runs' lock, on the print connection. `within` is run, with the
 * new id and its number, in the same transaction as the sample, so that whatever it writes stands or falls with the
 * sample: the apply-uploads job records the row's outcome there, so a crash cannot leave a sample that no upload row
 * names. With `anyKind` a series number that any other sample has, of any kind,
 * counts as taken (the upload path; the trap form counts trap samples only). With `staff`, staff entered it and
 * the release is written with it, in the same transaction and in any season: staff entering a sample is staff
 * saying its bees need labels. The upload path never passes `staff` (see src/app/samples-upload-apply.ts).
 */
export function createTrapSample(
  conn: DuckDBConnection,
  s: TrapSample,
  enteredBy: number | null,
  within?: (id: number, sampleNumber: string) => Promise<void>,
  options: { anyKind?: boolean; staff?: StaffRelease } = {},
): Promise<number | "taken"> {
  return withPrintRunLock(async () => {
    const number = s.sample_number;
    if (await numberTaken(conn, number, null)) return "taken";
    if (options.anyKind === true && (await seriesNumberHolder(conn, number)) !== null) return "taken";
    return inTransaction(conn, async () => {
      const created = await rows<{ entity_id: number }>(
        conn,
        `INSERT INTO sample (kind, sample_number, date_start, date_end, specimen_count, country, state_province, county, locality, protocol, sampling_effort)
         VALUES ('trap', $1, $2::DATE, $3::DATE, $4, $5, $6, $7, $8, $9, $10) RETURNING entity_id`,
        [number, s.date_start, s.date_end, s.specimen_count, s.country, s.state_province, s.county, s.locality, s.protocol, s.sampling_effort],
      );
      const id = created[0]!.entity_id;
      await conn.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES ($1, $2)`, [id, enteredBy] as never);
      await writeParts(conn, id, s);
      await within?.(id, number);
      if (options.staff !== undefined) await releaseByStaff(conn, id, options.staff);
      return id;
    });
  });
}

/** Why a trap sample cannot be deleted. */
export type DeleteRefusal = "not_found" | "not_entered" | "printed" | "in_print_run" | "has_specimens" | "has_other_records";

/**
 * The tables whose rows a delete removes with the sample: the satellites a trap sample entered in Beeline can have, each
 * keyed by `sample_id`. In the order they are deleted. A table that names a sample and is in neither this list nor
 * NEVER_DELETED is a decision nobody has made, and a test fails until somebody makes it.
 */
export const DELETED_WITH_SAMPLE = [
  "sample_area",
  "sample_area_derivation",
  "sample_atlas",
  "sample_collector",
  "sample_entry",
  "sample_hold",
  "sample_locality_candidate",
  "sample_locality_override",
  "sample_location",
  "sample_location_override",
  "sample_place_stamped",
  "sample_print_release_event",
  "sample_qc_waiver",
] as const;

/**
 * The tables that name a sample and are never deleted from: a sample with a row in one is not deleted, and says so
 * (`has_other_records`). Specimens are the first, with their own refusal; the other two are records of promotion, which
 * a sample entered in Beeline does not have.
 */
export const NEVER_DELETED = ["specimen", "sample_legacy_observation", "sample_promotion_finding"] as const;

/**
 * Delete a trap sample entered in Beeline that has never been printed, is in no print run and has no specimens, with
 * every row that names it. Behind the print runs' lock, so a freeze cannot take its labels between the check and the
 * delete. The caller takes the sample's turn in its queue (src/app/sample-queue.ts). What an upload recorded about it
 * stands: upload_sample_outcome names a sample without a foreign key. Returns the number the sample had.
 *
 * Two transactions, because DuckDB will not delete a referenced row in the transaction that removed its references
 * (the limit printing.md names for cancelling a run). The first removes the satellites and writes the sample's
 * `sample_deletion` row; the second removes the sample. A crash between them leaves a sample with no entry mark and
 * no collector, which `deletable` accepts because of that row, so deleting again finishes it. The row stays.
 */
export function deleteTrapSample(
  conn: DuckDBConnection,
  id: number,
  deletedBy: number,
  reason: string | null = null,
): Promise<{ deleted: string } | { refused: DeleteRefusal }> {
  return withPrintRunLock(async () => {
    const found = await deletable(conn, id);
    if ("refused" in found) return found;
    await inTransaction(conn, async () => {
      // A fresh deletion always writes a record of its own; finishing a cut-short one finds its record there already.
      if (!found.cutShort) {
        await conn.run(
          `INSERT INTO sample_deletion (sample_id, sample_number, deleted_by, deleted_at, reason) VALUES ($1, $2, $3, now(), $4)`,
          [id, found.number, deletedBy, reason] as never,
        );
      }
      for (const table of DELETED_WITH_SAMPLE) await conn.run(`DELETE FROM "${table}" WHERE sample_id = $1`, [id] as never);
    });
    await conn.run(`DELETE FROM sample WHERE entity_id = $1`, [id] as never);
    return { deleted: found.number };
  });
}

/**
 * Whether a trap sample may be deleted now, and its number if so. The same answer the delete gives, read without
 * writing. A sample whose deletion was cut short, so that it has a `sample_deletion` row and no entry mark and no
 * collector left, may be deleted again to finish it.
 */
export async function deletable(conn: DuckDBConnection, id: number): Promise<{ number: string; cutShort: boolean } | { refused: DeleteRefusal }> {
  const found = await rows<{ sample_number: string; kind: string; entered: boolean; cut_short: boolean; printed: boolean; in_run: boolean; specimens: number }>(
    conn,
    `SELECT s.sample_number, s.kind,
            EXISTS (SELECT 1 FROM sample_entry e WHERE e.sample_id = s.entity_id) AS entered,
            EXISTS (SELECT 1 FROM sample_deletion d WHERE d.sample_id = s.entity_id)
              AND NOT EXISTS (SELECT 1 FROM sample_entry e WHERE e.sample_id = s.entity_id)
              AND NOT EXISTS (SELECT 1 FROM sample_collector c WHERE c.sample_id = s.entity_id) AS cut_short,
            EXISTS (SELECT 1 FROM printed_sample p WHERE p.sample_id = s.entity_id) AS printed,
            EXISTS (SELECT 1 FROM sample_label_in_progress l WHERE l.sample_id = s.entity_id) AS in_run,
            (SELECT count(*)::INTEGER FROM specimen sp WHERE sp.sample_id = s.entity_id) AS specimens
     FROM sample s WHERE s.entity_id = $1`,
    [id],
  );
  const r = found[0];
  if (r === undefined) return { refused: "not_found" };
  // Only a trap sample is entered in Beeline; a net sample is never deleted here, whatever marks it carries.
  if ((!r.entered && !r.cut_short) || r.kind !== "trap") return { refused: "not_entered" };
  if (r.printed) return { refused: "printed" };
  if (r.in_run) return { refused: "in_print_run" };
  if (r.specimens > 0) return { refused: "has_specimens" };
  // Another table that names the sample is not ours to delete from: the sample stays, and the page says why, before the
  // button. The delete asks again under the print runs' lock, through this.
  for (const table of NEVER_DELETED.filter((t) => t !== "specimen")) {
    const kept = await rows<{ n: number }>(conn, `SELECT count(*)::INTEGER AS n FROM "${table}" WHERE sample_id = $1`, [id]);
    if ((kept[0]?.n ?? 0) > 0) return { refused: "has_other_records" };
  }
  return { number: r.sample_number, cutShort: r.cut_short };
}

/** A sample entered in Beeline, as its form shows it; null if it is not one. */
export async function loadTrapSample(conn: DuckDBConnection, id: number): Promise<(TrapSampleForm & { editable: boolean }) | null> {
  const found = await rows<Record<string, unknown>>(
    conn,
    `SELECT s.sample_number, strftime(s.date_start, '%Y-%m-%d') AS date_start, strftime(s.date_end, '%Y-%m-%d') AS date_end,
            s.protocol, s.sampling_effort, s.specimen_count, s.country, s.state_province, s.county, s.locality,
            l.latitude, l.longitude, l.coordinate_uncertainty_m,
            (SELECT list(p.display_name ORDER BY c.position) FROM sample_collector c JOIN person p ON p.entity_id = c.person_id
             WHERE c.sample_id = s.entity_id) AS collectors,
            NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)
              AND NOT EXISTS (SELECT 1 FROM sample_label_in_progress lp WHERE lp.sample_id = s.entity_id AND lp.printing_count > 0)
              AS editable
     FROM sample s JOIN sample_entry e ON e.sample_id = s.entity_id
     LEFT JOIN sample_location l ON l.sample_id = s.entity_id
     WHERE s.entity_id = $1`,
    [id],
  );
  const r = found[0];
  if (r === undefined) return null;
  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const effort = /^(\d+) /.exec(str(r.sampling_effort));
  return {
    sample_number: str(r.sample_number),
    collectors: (r.collectors as string[] | null) ?? [],
    date_start: str(r.date_start),
    date_end: str(r.date_end),
    method: str(r.protocol),
    trap_count: effort?.[1] ?? "",
    specimen_count: str(r.specimen_count),
    latitude: str(r.latitude),
    longitude: str(r.longitude),
    uncertainty: str(r.coordinate_uncertainty_m),
    country: str(r.country),
    state_province: str(r.state_province),
    county: str(r.county),
    locality: str(r.locality),
    editable: Boolean(r.editable),
  };
}

/**
 * Rewrite an entered sample from its form. Refused once its labels are on
 * paper or frozen into a run, since the run already holds the label text.
 */
export function updateTrapSample(conn: DuckDBConnection, id: number, s: TrapSample, staff?: StaffRelease): Promise<"saved" | "printed" | "taken"> {
  return withPrintRunLock(async () => {
    const current = await loadTrapSample(conn, id);
    if (current === null || !current.editable) return "printed";
    if (await numberTaken(conn, s.sample_number, id)) return "taken";
    return inTransaction(conn, async () => {
      // Staff changing a settled season's count release it, read here, inside the
      // lock and the transaction, against the count the save is replacing.
      const before = (await rows<{ specimen_count: number | null }>(conn, `SELECT specimen_count FROM sample WHERE entity_id = $1`, [id]))[0]?.specimen_count;
      // The satellites are replaced rather than updated: none is referenced,
      // and the sample row itself keeps its id (beeline-6e9).
      await conn.run(`DELETE FROM sample_collector WHERE sample_id = $1`, [id] as never);
      // The save rewrites the place and the point, so the nightly's stamp has
      // not looked at what is there now (sample_place_stamped, schema/038): a
      // released sample waits for it again before it prints.
      await conn.run(`DELETE FROM sample_place_stamped WHERE sample_id = $1`, [id] as never);
      // A point staff set from the sample's page goes with the location the
      // form is rewriting, whose point is the new one (beeline-kgyd.4.2).
      await conn.run(`DELETE FROM sample_location_override WHERE sample_id = $1`, [id] as never);
      await conn.run(`DELETE FROM sample_location WHERE sample_id = $1`, [id] as never);
      await conn.run(`DELETE FROM sample_atlas WHERE sample_id = $1 AND assigned_by IS NULL`, [id] as never);
      await conn.run(
        `UPDATE sample SET sample_number = $2, date_start = $3::DATE, date_end = $4::DATE, specimen_count = $5, country = $6,
                state_province = $7, county = $8, locality = $9, protocol = $10, sampling_effort = $11
         WHERE entity_id = $1`,
        [id, s.sample_number, s.date_start, s.date_end, s.specimen_count, s.country, s.state_province, s.county, s.locality, s.protocol, s.sampling_effort] as never,
      );
      // An atlas a person assigned stands; otherwise it follows the state.
      const assigned = await rows<{ n: number }>(conn, `SELECT count(*)::INTEGER AS n FROM sample_atlas WHERE sample_id = $1`, [id]);
      await writeParts(conn, id, s, (assigned[0]?.n ?? 0) === 0);
      if (staff !== undefined && before !== s.specimen_count) await releaseByStaff(conn, id, staff);
      return "saved" as const;
    });
  });
}

/**
 * Write an entered sample's locality, as the samples listing's Place cell
 * does (beeline-3vs.5): directly, since Beeline is its only record, and only
 * until its labels are printed or frozen into a run.
 */
export function setTrapSampleLocality(conn: DuckDBConnection, id: number, locality: string): Promise<"saved" | "printed"> {
  return withPrintRunLock(async () => {
    const current = await loadTrapSample(conn, id);
    if (current === null || !current.editable) return "printed";
    await conn.run(`UPDATE sample SET locality = $2 WHERE entity_id = $1`, [id, locality.trim() === "" ? null : locality.trim()] as never);
    return "saved";
  });
}
