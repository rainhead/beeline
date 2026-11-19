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
 * else's sample is not.
 */
export async function mayEditTrapSample(conn: DuckDBConnection, sampleId: number, personId: number | null, admin: boolean): Promise<boolean> {
  if (admin) return true;
  if (personId === null) return false;
  const found = await rows<{ n: number }>(
    conn,
    `SELECT count(*)::INTEGER AS n FROM sample_entry e
     WHERE e.sample_id = $1
       AND (e.entered_by = $2 OR EXISTS (SELECT 1 FROM sample_collector c WHERE c.sample_id = e.sample_id AND c.person_id = $2))`,
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
  const found = await rows<{ n: number | null }>(
    conn,
    `SELECT max(TRY_CAST(substr(sample_number, length($1) + 1) AS INTEGER))::INTEGER AS n
     FROM sample WHERE starts_with(sample_number, $1)`,
    [prefix],
  );
  return `${prefix}${String((found[0]?.n ?? 0) + 1).padStart(5, "0")}`;
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
 * Write a new trap sample; its id. Behind the print runs' lock, on the print
 * connection. Where `staff` says staff entered it, the release is written
 * with it, in the same transaction and in any season: staff entering a sample
 * is staff saying its bees need labels.
 */
export function createTrapSample(
  conn: DuckDBConnection,
  s: TrapSample,
  enteredBy: number | null,
  staff?: StaffRelease,
): Promise<number | "taken"> {
  return withPrintRunLock(async () => {
    if (await numberTaken(conn, s.sample_number, null)) return "taken";
    return inTransaction(conn, async () => {
      const created = await rows<{ entity_id: number }>(
        conn,
        `INSERT INTO sample (kind, sample_number, date_start, date_end, specimen_count, country, state_province, county, locality, protocol, sampling_effort)
         VALUES ('trap', $1, $2::DATE, $3::DATE, $4, $5, $6, $7, $8, $9, $10) RETURNING entity_id`,
        [s.sample_number, s.date_start, s.date_end, s.specimen_count, s.country, s.state_province, s.county, s.locality, s.protocol, s.sampling_effort],
      );
      const id = created[0]!.entity_id;
      await conn.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES ($1, $2)`, [id, enteredBy] as never);
      await writeParts(conn, id, s);
      if (staff !== undefined) await releaseByStaff(conn, id, staff);
      return id;
    });
  });
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
