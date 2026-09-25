import type { DuckDBConnection } from "@duckdb/node-api";
import { pathToFileURL } from "node:url";
import { parseSampleRef, type SampleOverlayRow } from "./sample-overlay.js";

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

export async function applySampleOverlay(
  conn: DuckDBConnection,
  overlay: readonly SampleOverlayRow[],
): Promise<ApplySampleResult> {
  const result: ApplySampleResult = { applied: 0, unresolved: [] };
  if (overlay.length === 0) return result;

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
    const found = await rows(conn, `SELECT entity_id FROM sample WHERE inat_observation_id = $1`, [
      BigInt(ref.inat_observation_id),
    ]);
    if (found.length !== 1) {
      result.unresolved.push({
        sample_ref: row.sample_ref,
        field: row.field,
        reason:
          found.length === 0
            ? `no sample carries observation ${ref.inat_observation_id}`
            : `${found.length} samples carry observation ${ref.inat_observation_id}`,
      });
      continue;
    }
    const sampleId = Number(found[0]![0]);

    if (row.value === "") {
      // Removal: the observation is the only writer again. Hand the sample
      // back what the follow rule would give it — now, rather than at the
      // next nightly, so the page does not show a value nobody stands
      // behind for a day. A printed sample keeps what it has, as it would
      // under the follow rule: the label is on paper.
      await conn.run(`DELETE FROM sample_locality_override WHERE sample_id = $1`, [sampleId] as never);
      await conn.run(
        `UPDATE sample SET locality = followed.locality
         FROM (SELECT s.entity_id AS sample_id, loc.locality
               FROM sample s
               LEFT JOIN observation_locality loc ON loc.inat_id = s.inat_observation_id
               WHERE s.entity_id = $1
                 AND NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)) followed
         WHERE sample.entity_id = followed.sample_id
           AND sample.locality IS DISTINCT FROM followed.locality`,
        [sampleId] as never,
      );
      result.applied++;
      continue;
    }

    const setBy = byLogin.get(row.author.toLowerCase()) ?? null;
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
  return result;
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
