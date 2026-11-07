import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";

/**
 * One night step as /jobs shows it (beeline-e1xg): its latest run, and the
 * most memory it held this week, in the week a month ago and in the week three
 * months ago, so a step whose cost grows with the corpus can be seen growing.
 * Then beside now, not a maximum over ever longer windows: a growing step's
 * largest night is its newest, so those maxima would all read the same. A
 * week rather than one night, so one heavy night does not read as a trend.
 * Peaks are the step's own (job_step.peak_mb), and so are null wherever the
 * store was written somewhere other than Linux, or the step did not run then.
 */
export interface StepTrendRow {
  job_name: string;
  label: string;
  last_started_at: Date;
  last_duration_ms: number;
  last_failed: boolean;
  last_peak_mb: number | null;
  last_duckdb_mb: number | null;
  peak_week_mb: number | null;
  peak_month_ago_mb: number | null;
  peak_quarter_ago_mb: number | null;
}

export async function stepTrend(db: Kysely<Database>): Promise<StepTrendRow[]> {
  const { rows } = await sql<StepTrendRow>`
    SELECT r.job_name, s.label,
           max(s.started_at) AS last_started_at,
           arg_max(s.duration_ms, s.started_at) AS last_duration_ms,
           arg_max(s.failed, s.started_at) AS last_failed,
           arg_max(s.peak_mb, s.started_at) AS last_peak_mb,
           arg_max(s.duckdb_mb, s.started_at) AS last_duckdb_mb,
           max(s.peak_mb) FILTER (WHERE s.started_at >= now() - INTERVAL 7 DAY) AS peak_week_mb,
           max(s.peak_mb) FILTER (WHERE s.started_at >= now() - INTERVAL 35 DAY
                                    AND s.started_at < now() - INTERVAL 28 DAY) AS peak_month_ago_mb,
           max(s.peak_mb) FILTER (WHERE s.started_at >= now() - INTERVAL 98 DAY
                                    AND s.started_at < now() - INTERVAL 91 DAY) AS peak_quarter_ago_mb
    FROM job_step s
    JOIN job_run r ON r.entity_id = s.job_run_id
    WHERE s.started_at >= now() - INTERVAL 98 DAY
    GROUP BY r.job_name, s.label
    -- In the order the steps run: by job, then where the step fell in its latest run.
    ORDER BY r.job_name, arg_max(s.step_number, s.started_at), s.label`.execute(db);
  return rows.map((row) => ({
    ...row,
    last_started_at: new Date(row.last_started_at),
    last_duration_ms: Number(row.last_duration_ms),
    last_peak_mb: row.last_peak_mb === null ? null : Number(row.last_peak_mb),
    last_duckdb_mb: row.last_duckdb_mb === null ? null : Number(row.last_duckdb_mb),
    peak_week_mb: row.peak_week_mb === null ? null : Number(row.peak_week_mb),
    peak_month_ago_mb: row.peak_month_ago_mb === null ? null : Number(row.peak_month_ago_mb),
    peak_quarter_ago_mb: row.peak_quarter_ago_mb === null ? null : Number(row.peak_quarter_ago_mb),
  }));
}
