import type { DuckDBConnection } from "@duckdb/node-api";
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

interface Person {
  entity_id: number;
  display_name: string;
}

async function rows<T>(conn: DuckDBConnection, sql: string, params: unknown[] = []): Promise<T[]> {
  const reader = await conn.runAndReadAll(sql, params as never);
  return reader.getRowObjectsJS() as T[];
}

const fold = (s: string) => s.normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

/**
 * Who may enter trap samples: staff, and anyone who is a collector on a trap
 * sample already (Peter, 2026-11-04). Derived rather than granted, so nobody
 * has to be set up first; a grant for someone new to trapping is beeline-3vs.1.
 */
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
 * A person by name, as a form names them: the whole name folded to letters
 * and digits, as promotion identifies people. Two people with one name are
 * refused rather than guessed between.
 */
async function personByName(conn: DuckDBConnection, name: string): Promise<Person | string> {
  const target = fold(name);
  const people = await rows<Person>(conn, `SELECT entity_id, display_name FROM person`);
  const matches = people.filter((p) => fold(p.display_name) === target);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) return `Beeline has nobody called ${name}`;
  return `${matches.length} people are called ${name}; choose one on their page and ask staff to tell them apart`;
}

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
): Promise<{ sample: TrapSample } | { problems: FieldProblems }> {
  const problems: FieldProblems = {};
  const sampleNumber = form.sample_number.trim();
  if (sampleNumber === "") problems.sample_number = "A sample number is needed.";
  else {
    const taken = await rows<{ entity_id: number }>(
      conn,
      `SELECT entity_id FROM sample WHERE sample_number = $1 AND entity_id IS DISTINCT FROM $2 LIMIT 1`,
      [sampleNumber, sampleId],
    );
    if (taken.length > 0) problems.sample_number = `Sample ${sampleNumber} is already in Beeline.`;
  }

  const names = form.collectors.map((n) => n.trim()).filter((n) => n !== "");
  const collectorIds: number[] = [];
  if (names.length === 0) problems.collectors = "At least one collector is needed.";
  for (const name of names) {
    const found = await personByName(conn, name);
    if (typeof found === "string") {
      problems.collectors = `${found}.`;
      break;
    }
    if (collectorIds.includes(found.entity_id)) {
      problems.collectors = `${found.display_name} is named twice.`;
      break;
    }
    collectorIds.push(found.entity_id);
  }

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
      sampling_effort: trapCount === null ? null : `${trapCount} ${method}${trapCount === 1 ? "" : "s"}`,
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

/** Write a new trap sample; its id. Behind the print runs' lock, on the print connection. */
export function createTrapSample(conn: DuckDBConnection, s: TrapSample, enteredBy: number | null): Promise<number> {
  return withPrintRunLock(() =>
    inTransaction(conn, async () => {
      const created = await rows<{ entity_id: number }>(
        conn,
        `INSERT INTO sample (kind, sample_number, date_start, date_end, specimen_count, country, state_province, county, locality, protocol, sampling_effort)
         VALUES ('trap', $1, $2::DATE, $3::DATE, $4, $5, $6, $7, $8, $9, $10) RETURNING entity_id`,
        [s.sample_number, s.date_start, s.date_end, s.specimen_count, s.country, s.state_province, s.county, s.locality, s.protocol, s.sampling_effort],
      );
      const id = created[0]!.entity_id;
      await conn.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES ($1, $2)`, [id, enteredBy] as never);
      await writeParts(conn, id, s);
      return id;
    }),
  );
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
export function updateTrapSample(conn: DuckDBConnection, id: number, s: TrapSample): Promise<"saved" | "printed"> {
  return withPrintRunLock(async () => {
    const current = await loadTrapSample(conn, id);
    if (current === null || !current.editable) return "printed";
    return inTransaction(conn, async () => {
      // The satellites are replaced rather than updated: none is referenced,
      // and the sample row itself keeps its id (beeline-6e9).
      await conn.run(`DELETE FROM sample_collector WHERE sample_id = $1`, [id] as never);
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
      return "saved" as const;
    });
  });
}
