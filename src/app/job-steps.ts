import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";

/**
 * One night step as /jobs shows it (beeline-e1xg): its latest run, and the
 * most memory it held over the last week, month and three months, so a step
 * whose cost grows with the corpus can be seen growing. Peaks are the step's
 * own (job_step.peak_mb) and so are null wherever the store was written
 * somewhere other than Linux.
 */
export interface StepTrendRow {
  job_name: string;
  label: string;
  last_started_at: Date;
  last_duration_ms: number;
  last_failed: boolean;
  last_peak_mb: number | null;
  last_duckdb_mb: number | null;
  peak_7d_mb: number | null;
  peak_30d_mb: number | null;
  peak_90d_mb: number | null;
}

export async function stepTrend(db: Kysely<Database>): Promise<StepTrendRow[]> {
  const { rows } = await sql<StepTrendRow>`
    SELECT r.job_name, s.label,
           max(s.started_at) AS last_started_at,
           arg_max(s.duration_ms, s.started_at) AS last_duration_ms,
           arg_max(s.failed, s.started_at) AS last_failed,
           arg_max(s.peak_mb, s.started_at) AS last_peak_mb,
           arg_max(s.duckdb_mb, s.started_at) AS last_duckdb_mb,
           max(s.peak_mb) FILTER (WHERE s.started_at >= now() - INTERVAL 7 DAY) AS peak_7d_mb,
           max(s.peak_mb) FILTER (WHERE s.started_at >= now() - INTERVAL 30 DAY) AS peak_30d_mb,
           max(s.peak_mb) AS peak_90d_mb
    FROM job_step s
    JOIN job_run r ON r.entity_id = s.job_run_id
    WHERE s.started_at >= now() - INTERVAL 90 DAY
    GROUP BY r.job_name, s.label
    -- In the order the steps run: by job, then where the step fell in its latest run.
    ORDER BY r.job_name, arg_max(s.step_number, s.started_at), s.label`.execute(db);
  return rows.map((row) => ({
    ...row,
    last_started_at: new Date(row.last_started_at),
    last_duration_ms: Number(row.last_duration_ms),
    last_peak_mb: row.last_peak_mb === null ? null : Number(row.last_peak_mb),
    last_duckdb_mb: row.last_duckdb_mb === null ? null : Number(row.last_duckdb_mb),
    peak_7d_mb: row.peak_7d_mb === null ? null : Number(row.peak_7d_mb),
    peak_30d_mb: row.peak_30d_mb === null ? null : Number(row.peak_30d_mb),
    peak_90d_mb: row.peak_90d_mb === null ? null : Number(row.peak_90d_mb),
  }));
}
