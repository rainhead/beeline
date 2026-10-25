import type { DuckDBConnection } from "@duckdb/node-api";
import { pathToFileURL } from "node:url";
import { formatPoint, parsePoint, parseSampleRef, waivedRule, type OverlayPoint, type SampleOverlayRow } from "./sample-overlay.js";

/**
 * Apply staff decisions about samples to the store (src/sample-overlay.ts).
 * Runs at the end of observation promotion, after minting and the free link
 * have set every observation id a row can name, so a rebuilt store carries
 * every decision forward — and again in-process when the sample page records
 * one, so an edit is live without a rebuild.
 *
 * Nothing here guesses. A reference that names no sample, or two, is
 * returned as an unresolved row for a human to look at, never applied to the
 * nearest plausible one.
 */

export interface UnresolvedSampleRow {
  sample_ref: string;
  field: string;
  reason: string;
}

export interface ApplySampleResult {
  applied: number;
  unresolved: UnresolvedSampleRow[];
}

const rows = async (conn: DuckDBConnection, sql: string, params: unknown[] = []) =>
  (await (await conn.run(sql, params as never)).getRows()) as unknown[][];

/**
 * What the observation yields for this sample right now — the merge base a
 * new override records, and the value a removed override hands the sample
 * back to. Null where there is no observation, or it yields nothing.
 */
export async function observationLocalityOf(conn: DuckDBConnection, sampleId: number): Promise<string | null> {
  const r = await rows(
    conn,
    `SELECT loc.locality FROM sample s
     LEFT JOIN observation_locality loc ON loc.inat_id = s.inat_observation_id
     WHERE s.entity_id = $1`,
    [sampleId],
  );
  const v = r[0]?.[0];
  return v === null || v === undefined ? null : String(v);
}

/**
 * The one sample carrying an observation, or why there is not exactly one.
 * The store admits two samples on one observation (a legacy shape,
 * sample_multi_observation's inverse), and a decision keyed by that
 * observation then names nobody rather than both. The route asks this
 * before writing the file, so an ambiguous reference is refused at the
 * form rather than persisted as a row every nightly reports and never
 * applies.
 */
export async function resolveObservationSample(
  conn: DuckDBConnection,
  inatObservationId: bigint | number | string,
): Promise<{ sampleId: number } | { problem: string }> {
  const found = await rows(conn, `SELECT entity_id FROM sample WHERE inat_observation_id = $1`, [
    BigInt(inatObservationId),
  ]);
  if (found.length === 1) return { sampleId: Number(found[0]![0]) };
  return {
    problem:
      found.length === 0
        ? `no sample carries observation ${inatObservationId}`
        : `${found.length} samples carry observation ${inatObservationId}`,
  };
}

/**
 * The base a new coordinate override records, in the overlay's own grammar:
 * what removal will restore. Where an override already stands, its recorded
 * base — the row as it stood before any staff point — and not the current
 * row, which by then IS the earlier staff point; a second save must not make
 * the first save the thing removal goes back to (CodeRabbit on PR #99).
 * Otherwise the sample_location row as it stands. Empty where the sample
 * has no coordinates.
 */
export async function currentLocationOf(conn: DuckDBConnection, sampleId: number): Promise<string> {
  const prior = await rows(
    conn,
    `SELECT observed_latitude, observed_longitude, observed_uncertainty_m, observed_source
     FROM sample_location_override WHERE sample_id = $1`,
    [sampleId],
  );
  const p = prior[0];
  if (p !== undefined) {
    if (p[0] === null) return "";
    return formatPoint({
      latitude: Number(p[0]),
      longitude: Number(p[1]),
      coordinate_uncertainty_m: p[2] === null ? null : Number(p[2]),
      source: String(p[3]),
    });
  }
  const r = await rows(
    conn,
    `SELECT latitude, longitude, coordinate_uncertainty_m, source FROM sample_location WHERE sample_id = $1`,
    [sampleId],
  );
  const row = r[0];
  if (row === undefined) return "";
  return formatPoint({
    latitude: Number(row[0]),
    longitude: Number(row[1]),
    coordinate_uncertainty_m: row[2] === null ? null : Number(row[2]),
    source: String(row[3]),
  });
}

/** Write a point onto sample_location, keeping or inserting the row. */
async function writeLocation(conn: DuckDBConnection, sampleId: number, p: OverlayPoint, source: string): Promise<void> {
  const exists = (await rows(conn, `SELECT 1 FROM sample_location WHERE sample_id = $1`, [sampleId])).length > 0;
  if (exists) {
    // The elevation is left where it is: sample_elevation_stale notices the
    // move and the derive job re-reads it (schema/170, beeline-x5c).
    await conn.run(
      `UPDATE sample_location SET latitude = $1, longitude = $2, coordinate_uncertainty_m = $3, source = $4
       WHERE sample_id = $5`,
      [p.latitude, p.longitude, p.coordinate_uncertainty_m, source, sampleId] as never,
    );
  } else {
    await conn.run(
      `INSERT INTO sample_location (sample_id, latitude, longitude, coordinate_uncertainty_m, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [sampleId, p.latitude, p.longitude, p.coordinate_uncertainty_m, source] as never,
    );
  }
}

/**
 * Why a waiver on this flag cannot stand, or null if it can: the flag must be
 * a blocking rule, not one of the unwaivable (schema/050), and the waiver
 * needs a reason. The route asks this before writing the file, and the
 * applier again for rows that reach the file some other way.
 */
export async function waiverProblem(conn: DuckDBConnection, ruleName: string, reason: string): Promise<string | null> {
  const found = await rows(
    conn,
    `SELECT r.severity, EXISTS (SELECT 1 FROM qc_rule_unwaivable u WHERE u.name = r.name)
     FROM qc_rule r WHERE r.name = $1`,
    [ruleName],
  );
  const r = found[0];
  if (r === undefined) return `'${ruleName}' is not a flag`;
  if (r[0] !== "blocking") return `'${ruleName}' does not block printing, so there is nothing to waive`;
  if (r[1] === true) return `'${ruleName}' cannot be waived`;
  if (reason.trim() === "") return "a waiver needs a reason";
  return null;
}

export async function applySampleOverlay(
  conn: DuckDBConnection,
  overlay: readonly SampleOverlayRow[],
): Promise<ApplySampleResult> {
  const result: ApplySampleResult = { applied: 0, unresolved: [] };
  if (overlay.length === 0) {
    await refreshWaivers(conn);
    return result;
  }

  // Logins the way the roster resolves them: case-insensitively, since
  // iNaturalist logins are.
  const byLogin = new Map<string, number>();
  for (const [login, pid] of await rows(conn, `SELECT login, person_id FROM inat_account WHERE login IS NOT NULL`)) {
    byLogin.set(String(login).toLowerCase(), Number(pid));
  }

  for (const row of overlay) {
    const ref = parseSampleRef(row.sample_ref);
    if (ref === null) {
      result.unresolved.push({ sample_ref: row.sample_ref, field: row.field, reason: "not a sample reference" });
      continue;
    }
    const found = await resolveObservationSample(conn, ref.inat_observation_id);
    if ("problem" in found) {
      result.unresolved.push({ sample_ref: row.sample_ref, field: row.field, reason: found.problem });
      continue;
    }
    const { sampleId } = found;
    const setBy = byLogin.get(row.author.toLowerCase()) ?? null;

    // Holds and waivers (beeline-plu, beeline-1kb.9). Delete-then-insert, as
    // below; a standing one with no reason is refused rather than inserted,
    // since the CHECK would fail the whole promotion transaction around it.
    if (row.field === "hold") {
      await conn.run(`DELETE FROM sample_hold WHERE sample_id = $1`, [sampleId] as never);
      if (row.value !== "") {
        if (row.reason.trim() === "") {
          result.unresolved.push({ sample_ref: row.sample_ref, field: row.field, reason: "a hold needs a reason" });
          continue;
        }
        await conn.run(`INSERT INTO sample_hold (sample_id, reason, held_by) VALUES ($1, $2, $3)`, [
          sampleId,
          row.reason,
          setBy,
        ] as never);
      }
      result.applied++;
      continue;
    }
    const rule = waivedRule(row.field);
    if (rule !== null) {
      await conn.run(`DELETE FROM sample_qc_waiver WHERE sample_id = $1 AND rule_name = $2`, [sampleId, rule] as never);
      if (row.value !== "") {
        const problem = await waiverProblem(conn, rule, row.reason);
        if (problem !== null) {
          result.unresolved.push({ sample_ref: row.sample_ref, field: row.field, reason: problem });
          continue;
        }
        // in_force is settled by refreshWaivers once every row is applied.
        await conn.run(
          `INSERT INTO sample_qc_waiver (sample_id, rule_name, finding, reason, waived_by, in_force)
           VALUES ($1, $2, $3, $4, $5, false)`,
          [sampleId, rule, row.base_value, row.reason, setBy] as never,
        );
      }
      result.applied++;
      continue;
    }

    if (row.field === "coordinates") {
      if (row.value === "") {
        // Removal restores what the row held before the override — an
        // imported point as readily as an observation's — unless the labels
        // have printed since, in which case the point on paper stays. A
        // sample that had no coordinates goes back to having none; if the
        // observation yields some, the next promotion writes them.
        const base = await rows(conn, `SELECT observed_latitude, observed_longitude, observed_uncertainty_m, observed_source
                                       FROM sample_location_override WHERE sample_id = $1`, [sampleId]);
        await conn.run(`DELETE FROM sample_location_override WHERE sample_id = $1`, [sampleId] as never);
        const printed = (await rows(conn, `SELECT 1 FROM printed_sample WHERE sample_id = $1`, [sampleId])).length > 0;
        if (!printed) {
          const b = base[0];
          if (b === undefined || b[0] === null) {
            await conn.run(`DELETE FROM sample_location WHERE sample_id = $1`, [sampleId] as never);
          } else {
            await writeLocation(
              conn,
              sampleId,
              { latitude: Number(b[0]), longitude: Number(b[1]), coordinate_uncertainty_m: b[2] === null ? null : Number(b[2]), source: null },
              String(b[3]),
            );
          }
        }
        result.applied++;
        continue;
      }
      const p = parsePoint(row.value);
      if ("problem" in p) {
        result.unresolved.push({ sample_ref: row.sample_ref, field: row.field, reason: p.problem });
        continue;
      }
      const base = row.base_value === "" ? null : parsePoint(row.base_value);
      const observed = base !== null && !("problem" in base) ? base : null;
      await conn.run(`DELETE FROM sample_location_override WHERE sample_id = $1`, [sampleId] as never);
      await conn.run(
        `INSERT INTO sample_location_override (sample_id, latitude, longitude, coordinate_uncertainty_m,
           observed_latitude, observed_longitude, observed_uncertainty_m, observed_source, set_by, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          sampleId, p.latitude, p.longitude, p.coordinate_uncertainty_m,
          observed?.latitude ?? null, observed?.longitude ?? null, observed?.coordinate_uncertainty_m ?? null,
          observed?.source ?? (observed === null ? null : "legacy_import"),
          setBy, row.reason === "" ? null : row.reason,
        ] as never,
      );
      await writeLocation(conn, sampleId, p, "staff_entry");
      result.applied++;
      continue;
    }

    if (row.field !== "locality") {
      // A field this applier does not know must not fall through to the
      // locality branch, whose removal would drop the sample's override.
      result.unresolved.push({ sample_ref: row.sample_ref, field: row.field, reason: "not a field this applier knows" });
      continue;
    }

    if (row.value === "") {
      // Removal: the observation is the only writer again. Hand the sample
      // back what the follow rule would give it — now, rather than at the
      // next nightly, so the page does not show a value nobody stands
      // behind for a day. The follow rule's terms exactly: a printed sample
      // keeps what it has, since the label is on paper, and so does one
      // whose observation is gone from observation_field — the inner join
      // is what says so, and without it an absent observation reads as a
      // locality of nothing (CodeRabbit on PR #94).
      await conn.run(`DELETE FROM sample_locality_override WHERE sample_id = $1`, [sampleId] as never);
      await conn.run(
        `UPDATE sample SET locality = followed.locality
         FROM (SELECT s.entity_id AS sample_id, loc.locality
               FROM sample s
               JOIN observation_field f ON f.inat_id = s.inat_observation_id
               LEFT JOIN observation_locality loc ON loc.inat_id = f.inat_id
               WHERE s.entity_id = $1
                 AND NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)) followed
         WHERE sample.entity_id = followed.sample_id
           AND sample.locality IS DISTINCT FROM followed.locality`,
        [sampleId] as never,
      );
      result.applied++;
      continue;
    }

    // Delete-then-insert rather than an engine-specific upsert (ADR 0001);
    // nothing references this table, so the delete is unconditional.
    await conn.run(`DELETE FROM sample_locality_override WHERE sample_id = $1`, [sampleId] as never);
    await conn.run(
      `INSERT INTO sample_locality_override (sample_id, locality, observed_locality, set_by, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [sampleId, row.value, row.base_value === "" ? null : row.base_value, setBy, row.reason === "" ? null : row.reason] as never,
    );
    await conn.run(`UPDATE sample SET locality = $1 WHERE entity_id = $2 AND locality IS DISTINCT FROM $1`, [
      row.value,
      sampleId,
    ] as never);
    result.applied++;
  }
  await refreshWaivers(conn);
  return result;
}

/**
 * Settle whether each waiver still applies (schema/050): the flag fires on
 * the sample and says what it said when it was waived. Run after every
 * application of the overlay, which follows every promotion and every staff
 * decision, so a change to a sample's data that changes the flag lapses the
 * waiver. One pass over qc_finding, and only where a waiver exists.
 */
export async function refreshWaivers(conn: DuckDBConnection): Promise<void> {
  if ((await rows(conn, `SELECT 1 FROM sample_qc_waiver LIMIT 1`)).length === 0) return;
  await conn.run(
    `UPDATE sample_qc_waiver SET in_force = checked.in_force
     FROM (SELECT w.sample_id, w.rule_name,
                  EXISTS (SELECT 1 FROM qc_finding f
                          LEFT JOIN specimen sp ON sp.entity_id = f.specimen_id
                          WHERE coalesce(f.sample_id, sp.sample_id) = w.sample_id
                            AND f.rule_name = w.rule_name
                            AND concat_ws(' ', f.details, f.detail_taxon_name) = w.finding) AS in_force
           FROM sample_qc_waiver w) checked
     WHERE sample_qc_waiver.sample_id = checked.sample_id
       AND sample_qc_waiver.rule_name = checked.rule_name
       AND sample_qc_waiver.in_force IS DISTINCT FROM checked.in_force`,
  );
}

// CLI: pnpm sample:apply [db] [overlay] — replay the overlay onto a store
// that already exists. Observation promotion does this on every pass; this
// is the same step on its own, for a store promoted before the file existed.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { openDuckDb } = await import("./db.js");
  const { readSampleOverlay } = await import("./sample-overlay.js");
  const dbPath = process.argv[2] ?? process.env.BEELINE_DB ?? "beeline.duckdb";
  const overlayPath = process.argv[3] ?? process.env.BEELINE_SAMPLE_OVERLAY ?? "data/sample-overlay.csv";
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  const result = await applySampleOverlay(conn, await readSampleOverlay(overlayPath));
  await conn.run("CHECKPOINT");
  conn.closeSync();
  console.log(JSON.stringify(result, null, 2));
}
