import type { DuckDBConnection } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseCsv } from "./corrections.js";

/**
 * Carries over the old Beeline's records that a correction in git has made
 * whole (beeline-n7gt). Promotion held back every record it could not file
 * under a sample (/exports/held-back, src/app/held-back.ts), and production
 * is never promoted again (ADR 0006), so a record corrected afterwards would
 * stay held back for good. This brings production level with what promotion
 * would make of the corrected records, in one transaction:
 *
 * 1. Every row of `ingest/legacy-corrections.csv` the store's own correction
 *    table lacks is added to it (`legacy_correction`). Promotion reads that
 *    file only when it builds a store, so production never saw a row added
 *    since; `legacy_occurrence_corrected`, and every view promotion left over
 *    it, read the table. A record and field the table already corrects is
 *    left alone: an in-app correction wins over the file, as in promotion.
 *
 * 2. Every held-back record that no blocking finding holds back any more is
 *    made a specimen, in a new sample of its collector, number and start day
 *    (promotion's grouping), as promotion would make it: the record's place,
 *    method, dates and specimen count; its point as `legacy_import` with the
 *    old record's elevation and uncertainty; the atlas of its state; its
 *    collectors in recordedBy order; its field number as printed; and the
 *    `legacy_specimen_number` row that ties the record to its specimen, which
 *    the legacy-format export, the copy to old Beeline, the volunteer import
 *    and the held-back page read. Never `sample_entry`, which would mark it
 *    as entered in Beeline.
 *
 * A group is refused, and named in the result, rather than guessed at where
 * this would have to decide something promotion decided with more evidence:
 * a sample of that collector, number and day already exists (the records
 * may belong in it); any of its field numbers is already a specimen's; its
 * records disagree about the place, the point or the method; a record names
 * a plant, or carries an expert's or a volunteer's identification, which
 * this does not yet carry over; or a collector has no person in Beeline.
 *
 * The first records it was written for: Lincoln Best's trap sample
 * OBAS-01087 (18 records) and Paul Moschetti's sample 13 of 2019 (2), whose
 * end dates were written before their start (Peter, 2026-11-15). The sample
 * change log records the new samples at its next pass, as it did after the
 * earlier repair (src/repair-legacy-skipped.ts).
 */

export interface CarriedSample {
  sampleId: number;
  collector: string;
  sampleNumber: string;
  dateStart: string;
  dateEnd: string;
  fieldNumbers: string[];
}

export interface RefusedGroup {
  collector: string;
  sampleNumber: string;
  dateStart: string;
  fieldNumbers: string[];
  why: string;
}

export interface CarryOverResult {
  correctionsAdded: number;
  samples: CarriedSample[];
  refused: RefusedGroup[];
  dryRun: boolean;
}

export const LEGACY_CORRECTIONS = "ingest/legacy-corrections.csv";
const COLUMNS = ["_id", "field", "base_value", "new_value", "author", "reason"] as const;

const rowsOf = async (conn: DuckDBConnection, q: string, params?: unknown[]): Promise<Record<string, unknown>[]> =>
  (await conn.runAndReadAll(q, params as never)).getRowObjects();

const isoDate = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export async function carryOverLegacyRecords(
  conn: DuckDBConnection,
  opts: { correctionsCsv?: string; dryRun?: boolean } = {},
): Promise<CarryOverResult> {
  const [head = [], ...body] = parseCsv(await readFile(opts.correctionsCsv ?? LEGACY_CORRECTIONS, "utf8"), { strict: true });
  if (COLUMNS.some((c, i) => head[i] !== c)) throw new Error(`corrections file: expected the header ${COLUMNS.join(",")}`);
  const events = body.filter((r) => r.length > 1 || (r[0] ?? "") !== "");

  await conn.run("BEGIN TRANSACTION");
  try {
    // 1. The file's corrections the store lacks, by record and field.
    await conn.run(`CREATE OR REPLACE TEMP TABLE carry_file (_id VARCHAR, field VARCHAR, base_value VARCHAR, new_value VARCHAR, author VARCHAR, reason VARCHAR)`);
    for (const e of events) await conn.run(`INSERT INTO temp.carry_file VALUES ($1, $2, $3, $4, $5, $6)`, e.slice(0, 6) as never);
    const [added] = await rowsOf(
      conn,
      `SELECT count(*)::INTEGER AS n FROM temp.carry_file f
       WHERE NOT EXISTS (SELECT 1 FROM legacy_correction c WHERE c._id = f._id AND c.field = f.field)`,
    );
    await conn.run(`
      INSERT INTO legacy_correction (_id, field, base_value, new_value, author, reason)
      SELECT f._id, f.field, f.base_value, f.new_value, f.author, f.reason FROM temp.carry_file f
      WHERE NOT EXISTS (SELECT 1 FROM legacy_correction c WHERE c._id = f._id AND c.field = f.field)`);

    // 2. Held-back records nothing holds back now, grouped as promotion
    // groups them: by collector, sample number and start day.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE carry_held AS
      SELECT r.*, m.person_id,
             r._id IN (SELECT _id FROM legacy_promotion_finding WHERE severity = 'blocking') AS blocked
      FROM legacy_parsed r
      LEFT JOIN legacy_person_map m ON m.fn IS NOT DISTINCT FROM r.fn AND m.ln IS NOT DISTINCT FROM r.ln
      WHERE r._id NOT IN (SELECT _id FROM legacy_specimen_number)
        AND r._id NOT IN (SELECT _id FROM legacy_duplicate_record)`);
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE carry_record AS
      SELECT * EXCLUDE (blocked) FROM temp.carry_held WHERE NOT blocked AND person_id IS NOT NULL`);
    // Each record's collectors, as promotion's legacy_row_collector reads them
    // (ingest/promote-legacy.sql), which promotion built only for the records
    // it took: recordedBy split on the pipe, or the name columns where it is
    // empty, through the curated aliases, to the person each name is.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE carry_collector AS
      WITH named AS (
        SELECT _id,
          CASE WHEN nullif(trim("recordedBy"), '') IS NULL THEN [concat_ws(' ', fn, ln)]
               ELSE list_transform(string_split("recordedBy", '|'), lambda x: trim(x)) END AS names
        FROM temp.carry_record
      ),
      exploded AS (
        SELECT n._id, g.i AS pos, n.names[g.i] AS recorded_name
        FROM named n, range(1, len(n.names) + 1) g(i)
        WHERE nullif(trim(n.names[g.i]), '') IS NOT NULL
      )
      SELECT e._id, e.pos, e.recorded_name, p.person_id
      FROM exploded e
      LEFT JOIN legacy_collector_alias a ON legacy_name_key(a.alias) = legacy_name_key(e.recorded_name)
      LEFT JOIN legacy_person_name p ON p.name = coalesce(a.person, e.recorded_name)`);
    const groups = await rowsOf(
      conn,
      `SELECT g.person_id, g.sid, g.p_date_start,
              (SELECT p.display_name FROM person p WHERE p.entity_id = g.person_id) AS collector,
              string_agg(g."fieldNumber", ',' ORDER BY g.p_specimen_number, g._id) AS field_numbers,
              CASE
                WHEN EXISTS (SELECT 1 FROM sample s JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
                             WHERE pc.person_id = g.person_id AND s.sample_number = g.sid AND s.date_start = g.p_date_start)
                  THEN 'a sample of this collector, number and day already exists'
                WHEN EXISTS (SELECT 1 FROM temp.carry_held h
                             WHERE h.blocked AND h.person_id = g.person_id AND h.sid = g.sid AND h.p_date_start = g.p_date_start)
                  THEN 'another record of this sample is still held back'
                WHEN bool_or(EXISTS (SELECT 1 FROM specimen sp WHERE sp.field_number = nullif(g."fieldNumber", '')))
                  THEN 'a field number is already a specimen''s'
                WHEN count(DISTINCT concat_ws('|', g.country, g.stateProvince, g.county, g.locality, g.p_lat, g.p_lon,
                                                  g.p_uncertainty, g.p_elevation, g.samplingProtocol, g.p_date_end, g.p_inat_obs_id)) > 1
                  THEN 'its records disagree about the place, the point, the method or the dates'
                WHEN bool_or(concat(g.genusPlant, g.speciesPlant, g.familyPlant, g.orderPlant, g.phylumPlant) <> '')
                  THEN 'a record names a plant, which this does not carry over yet'
                WHEN bool_or(concat(g.family, g.genus, g.specificEpithet, g.scientificName,
                                    g.familyVolDet, g.genusVolDet, g.speciesVolDet) <> '')
                  THEN 'a record carries an identification, which this does not carry over yet'
                WHEN bool_or(EXISTS (SELECT 1 FROM temp.carry_collector c WHERE c._id = g._id AND c.person_id IS NULL))
                  THEN 'a collector it names has no person in Beeline'
              END AS why
       FROM temp.carry_record g
       GROUP BY g.person_id, g.sid, g.p_date_start
       ORDER BY g.p_date_start, g.sid`,
    );

    const samples: CarriedSample[] = [];
    const refused: RefusedGroup[] = [];
    // Records nothing holds back but whose collector promotion never made a
    // person, because every record of theirs was held back: named, not made.
    for (const g of await rowsOf(
      conn,
      `SELECT concat_ws(' ', fn, ln) AS collector, sid, p_date_start,
              string_agg("fieldNumber", ',' ORDER BY p_specimen_number, _id) AS field_numbers
       FROM temp.carry_held WHERE NOT blocked AND person_id IS NULL
       GROUP BY fn, ln, sid, p_date_start ORDER BY p_date_start, sid`,
    )) {
      refused.push({
        collector: String(g.collector),
        sampleNumber: String(g.sid),
        dateStart: isoDate(g.p_date_start),
        fieldNumbers: String(g.field_numbers ?? "").split(",").filter((n) => n !== ""),
        why: "its collector has no person in Beeline",
      });
    }
    for (const g of groups) {
      const fieldNumbers = String(g.field_numbers ?? "").split(",").filter((n) => n !== "");
      const key = { collector: String(g.collector), sampleNumber: String(g.sid), dateStart: isoDate(g.p_date_start), fieldNumbers };
      if (g.why !== null) {
        refused.push({ ...key, why: String(g.why) });
        continue;
      }
      const params = [g.person_id, g.sid, isoDate(g.p_date_start)];
      // The sample, as promotion's legacy_sample_map makes it.
      const [made] = await rowsOf(
        conn,
        `INSERT INTO sample (kind, sample_number, date_start, date_end, specimen_count, inat_observation_id,
                             country, state_province, county, locality, protocol)
         SELECT CASE WHEN max(p_date_end) IS NOT NULL THEN 'trap' ELSE 'net' END,
                sid, p_date_start, coalesce(max(p_date_end), p_date_start), count(*), arg_min(p_inat_obs_id, _id),
                CASE nullif(arg_min(country, _id), '') WHEN 'CA' THEN 'CAN' WHEN 'NZ' THEN 'NZL' ELSE nullif(arg_min(country, _id), '') END,
                nullif(arg_min("stateProvince", _id), ''), nullif(arg_min(county, _id), ''),
                nullif(arg_min(locality, _id), ''), nullif(arg_min("samplingProtocol", _id), '')
         FROM temp.carry_record WHERE person_id = $1 AND sid = $2 AND p_date_start = $3::DATE
         GROUP BY sid, p_date_start
         RETURNING entity_id, CAST(date_end AS VARCHAR) AS date_end`,
        params,
      );
      const sampleId = Number(made!.entity_id);
      // The atlas of its state, as geography assigns it (schema/010).
      await conn.run(
        `INSERT INTO sample_atlas (sample_id, atlas_id)
         SELECT s.entity_id, reg.atlas_id FROM sample s JOIN atlas_region reg ON reg.state_province = s.state_province
         WHERE s.entity_id = $1 AND reg.atlas_id IS NOT NULL`,
        [sampleId] as never,
      );
      // Collectors in recordedBy order, each at their first place, the primary pinned first.
      await conn.run(
        `INSERT INTO sample_collector (sample_id, person_id, position)
         SELECT $1, person_id, row_number() OVER (ORDER BY is_primary DESC, first_pos, person_id)
         FROM (
           SELECT person_id, min(pos) AS first_pos, max(is_primary) AS is_primary
           FROM (
             SELECT c.person_id, c.pos, CASE WHEN c.person_id = $2 THEN 1 ELSE 0 END AS is_primary
             FROM temp.carry_record r
             JOIN temp.carry_collector c ON c._id = r._id
             WHERE r.person_id = $2 AND r.sid = $3 AND r.p_date_start = $4::DATE
             UNION ALL SELECT $2, 1, 1
           ) named
           GROUP BY person_id
         ) g`,
        [sampleId, ...params] as never,
      );
      // The old record's point, with its elevation read where it stood.
      await conn.run(
        `INSERT INTO sample_location (sample_id, latitude, longitude, coordinate_uncertainty_m, elevation_m,
                                      elevation_source_id, elevation_latitude, elevation_longitude, source)
         SELECT $1, lat, lon, uncertainty, elevation,
                CASE WHEN elevation IS NOT NULL
                     THEN (SELECT min(entity_id) FROM elevation_source WHERE description LIKE 'legacy verbatimElevation%') END,
                CASE WHEN elevation IS NOT NULL THEN lat END, CASE WHEN elevation IS NOT NULL THEN lon END, 'legacy_import'
         FROM (SELECT arg_min(p_lat, _id) AS lat, arg_min(p_lon, _id) AS lon, arg_min(p_uncertainty, _id) AS uncertainty,
                      arg_min(p_elevation, _id) AS elevation
               FROM temp.carry_record WHERE person_id = $2 AND sid = $3 AND p_date_start = $4::DATE)
         WHERE lat IS NOT NULL AND lon IS NOT NULL`,
        [sampleId, ...params] as never,
      );
      // Numbered 1..N in the old numbers' order, as promotion numbers them.
      await conn.run(
        `INSERT INTO legacy_specimen_number (_id, sample_id, specimen_number)
         SELECT _id, $1, CAST(row_number() OVER (ORDER BY p_specimen_number, _id) AS INTEGER)
         FROM temp.carry_record WHERE person_id = $2 AND sid = $3 AND p_date_start = $4::DATE`,
        [sampleId, ...params] as never,
      );
      await conn.run(
        `INSERT INTO specimen (sample_id, specimen_number, field_number)
         SELECT n.sample_id, n.specimen_number, nullif(r."fieldNumber", '')
         FROM legacy_specimen_number n JOIN temp.carry_record r ON r._id = n._id
         WHERE n.sample_id = $1`,
        [sampleId] as never,
      );
      samples.push({ ...key, sampleId, dateEnd: String(made!.date_end) });
    }
    await conn.run("DROP TABLE IF EXISTS temp.carry_file");
    await conn.run("DROP TABLE IF EXISTS temp.carry_record");
    await conn.run("DROP TABLE IF EXISTS temp.carry_held");
    await conn.run("DROP TABLE IF EXISTS temp.carry_collector");
    await conn.run(opts.dryRun ? "ROLLBACK" : "COMMIT");
    return { correctionsAdded: Number(added?.n ?? 0), samples, refused, dryRun: opts.dryRun ?? false };
  } catch (err) {
    await conn.run("ROLLBACK").catch(() => {});
    throw err;
  }
}

/** What it did, or would do, for the CLI. */
export function describeCarryOver(r: CarryOverResult): string {
  const verb = r.dryRun ? "would be" : "were";
  const lines = [`${r.correctionsAdded} correction(s) from ${LEGACY_CORRECTIONS} ${verb} added to the store`];
  lines.push(`${r.samples.length} sample(s) ${verb} made, with ${r.samples.reduce((n, s) => n + s.fieldNumbers.length, 0)} specimen(s)`);
  for (const s of r.samples) {
    lines.push(`  ${s.collector}, sample ${s.sampleNumber}, ${s.dateStart} to ${s.dateEnd}: ${s.fieldNumbers.join(", ")}${r.dryRun ? "" : ` (sample ${s.sampleId})`}`);
  }
  if (r.refused.length > 0) {
    lines.push(`${r.refused.length} group(s) left held back:`);
    for (const g of r.refused) lines.push(`  ${g.collector}, sample ${g.sampleNumber}, ${g.dateStart} (${g.fieldNumbers.join(", ")}): ${g.why}`);
  }
  return lines.join("\n");
}

// CLI: pnpm legacy:carry-over [db] [--dry-run]
// Against a store the app is not holding: production in maintenance mode, or a copy.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  for (const f of flags) if (f !== "--dry-run") throw new Error(`unknown option ${f}`);
  const dbPath = args.find((a) => !a.startsWith("--")) ?? process.env.BEELINE_DB ?? "beeline.duckdb";
  const { openDuckDb } = await import("./db.js");
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  try {
    const result = await carryOverLegacyRecords(conn, { dryRun: flags.has("--dry-run") });
    console.log(describeCarryOver(result));
    if (!flags.has("--dry-run")) await conn.run("CHECKPOINT");
  } finally {
    conn.closeSync();
  }
}
