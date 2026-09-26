import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import type { Database, PrintRunState } from "../model.js";
import { sha256, type LabelRow } from "../label-pdf.js";
import { renderLabelsPdfOffThread } from "../label-pdf-worker.js";

/**
 * The print-run screens' reads (beeline-1kb.2, beeline-1kb.4). Writes —
 * the freeze and the transitions — are src/print-run.ts, on the app's
 * dedicated print connection; everything here is a query the page draws.
 */

export interface RunListRow {
  print_run_id: number;
  state: PrintRunState;
  atlas_code: string | null;
  prepared_by: string;
  prepared_at: Date;
  approved_at: Date | null;
  printed_at: Date | null;
  mailed_at: Date | null;
  canceled_at: Date | null;
  label_count: number;
  sample_count: number;
  collector_count: number;
  sheet_count: number;
}

export async function listRuns(db: Kysely<Database>): Promise<RunListRow[]> {
  const rows = await db
    .selectFrom("print_run as r")
    .innerJoin("print_run_state as s", "s.print_run_id", "r.entity_id")
    .innerJoin("person as p", "p.entity_id", "r.prepared_by")
    .leftJoin("atlas as a", "a.entity_id", "r.atlas_id")
    .select([
      "r.entity_id as print_run_id",
      "s.state",
      "a.code as atlas_code",
      "p.display_name as prepared_by",
      "r.prepared_at",
      "r.approved_at",
      "r.printed_at",
      "r.mailed_at",
      "r.canceled_at",
      "s.label_count",
      "s.sample_count",
      "s.collector_count",
      "s.sheet_count",
    ])
    .orderBy("r.prepared_at", "desc")
    .orderBy("r.entity_id", "desc")
    .execute();
  return rows.map((r) => ({ ...r, print_run_id: Number(r.print_run_id) })) as RunListRow[];
}

/** What a Prepare would take, per scope, so the printer sees the size before committing. */
export interface ScopeOption {
  atlas_id: number;
  code: string;
  name: string;
  /** Prints its own labels: the unscoped run leaves it alone, and only such an atlas can be a run's scope. */
  own: boolean;
  samples: number;
  labels: number;
}

export interface ScopeCounts {
  program: { samples: number; labels: number };
  atlases: ScopeOption[];
}

export async function scopeCounts(db: Kysely<Database>): Promise<ScopeCounts> {
  const program = await db
    .selectFrom("print_scope_sample")
    .select(({ fn }) => [fn.countAll<number>().as("samples"), fn.sum<number>("pending_count").as("labels")])
    .executeTakeFirstOrThrow();
  const atlases = await sql<ScopeOption>`
    SELECT a.entity_id AS atlas_id, a.code, a.name,
           (ap.atlas_id IS NOT NULL) AS own,
           count(p.sample_id) AS samples,
           coalesce(sum(p.pending_count), 0) AS labels
    FROM atlas a
    LEFT JOIN atlas_printing ap ON ap.atlas_id = a.entity_id
    LEFT JOIN sample_atlas sa ON sa.atlas_id = a.entity_id
    LEFT JOIN pending_print_sample p ON p.sample_id = sa.sample_id
    GROUP BY a.entity_id, a.code, a.name, ap.atlas_id
    ORDER BY a.entity_id`.execute(db);
  return {
    program: { samples: Number(program.samples), labels: Number(program.labels ?? 0) },
    atlases: atlases.rows.map((r) => ({
      ...r,
      atlas_id: Number(r.atlas_id),
      own: Boolean(r.own),
      samples: Number(r.samples),
      labels: Number(r.labels),
    })),
  };
}

export interface RunDetail extends RunListRow {
  atlas_name: string | null;
  note: string | null;
  pdf_sha256: string | null;
  /** Samples in this run with labels in another live run too: split across mailings. */
  split_samples: number;
  /** Labels the proofer should look at. */
  warned: number;
}

export async function loadRun(db: Kysely<Database>, printRunId: number): Promise<RunDetail | null> {
  if (!Number.isSafeInteger(printRunId) || printRunId <= 0) return null;
  const row = await db
    .selectFrom("print_run as r")
    .innerJoin("print_run_state as s", "s.print_run_id", "r.entity_id")
    .innerJoin("person as p", "p.entity_id", "r.prepared_by")
    .leftJoin("atlas as a", "a.entity_id", "r.atlas_id")
    .where("r.entity_id", "=", printRunId)
    .select([
      "r.entity_id as print_run_id",
      "s.state",
      "a.code as atlas_code",
      "a.name as atlas_name",
      "p.display_name as prepared_by",
      "r.prepared_at",
      "r.approved_at",
      "r.printed_at",
      "r.mailed_at",
      "r.canceled_at",
      "r.note",
      "r.pdf_sha256",
      "s.label_count",
      "s.sample_count",
      "s.collector_count",
      "s.sheet_count",
      sql<number>`(SELECT count(*) FROM printed_label pl WHERE pl.print_run_id = r.entity_id AND pl.warnings IS NOT NULL)`.as(
        "warned",
      ),
      sql<number>`(
        SELECT count(DISTINCT sp.sample_id)
        FROM printed_label pl
        JOIN specimen sp ON sp.entity_id = pl.specimen_id
        WHERE pl.print_run_id = r.entity_id
          AND EXISTS (
            SELECT 1 FROM printed_label other
            JOIN specimen osp ON osp.entity_id = other.specimen_id
            JOIN print_run orun ON orun.entity_id = other.print_run_id
            WHERE osp.sample_id = sp.sample_id
              AND other.print_run_id <> r.entity_id
              AND orun.canceled_at IS NULL))`.as("split_samples"),
    ])
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    ...row,
    print_run_id: Number(row.print_run_id),
    warned: Number(row.warned),
    split_samples: Number(row.split_samples),
  } as RunDetail;
}

export interface RunLabelRow extends LabelRow {
  specimen_id: number;
  sample_id: number;
  sample_number: string;
  warnings: string | null;
}

/** The run's labels in sheet order — the proofing surface, and the renderer's input. */
export async function runLabels(db: Kysely<Database>, printRunId: number): Promise<RunLabelRow[]> {
  const rows = await db
    .selectFrom("printed_label as pl")
    .innerJoin("specimen as sp", "sp.entity_id", "pl.specimen_id")
    .innerJoin("sample as s", "s.entity_id", "sp.sample_id")
    .where("pl.print_run_id", "=", printRunId)
    .select([
      "pl.specimen_id",
      "sp.sample_id",
      "s.sample_number",
      "pl.sheet",
      "pl.cell",
      "pl.location_text",
      "pl.coordinates_text",
      "pl.date_text",
      "pl.collector_text",
      "pl.method_text",
      "pl.number_text",
      "pl.warnings",
    ])
    .orderBy("pl.sheet")
    .orderBy("pl.cell")
    .execute();
  return rows.map((r) => ({
    ...r,
    specimen_id: Number(r.specimen_id),
    sample_id: Number(r.sample_id),
    sheet: Number(r.sheet),
    cell: Number(r.cell),
  }));
}

export const runPdfPath = (dir: string, printRunId: number) => join(dir, `run-${printRunId}.pdf`);

/**
 * The run's sheets, rendered once and kept: the first render is written
 * beside the other app-written data and its hash recorded on the run, and
 * later requests read the file — but only a file the run vouches for. The
 * cached bytes are served when they hash to the run's recorded pdf_sha256
 * and not otherwise: a file with no recorded hash is one whose write
 * succeeded and whose UPDATE did not, and on the sandbox a reseed restarts
 * the ids while data/print-runs survives, so `run-18.pdf` can be some other
 * run 18's labels (CodeRabbit, #76). Anything unvouched is re-rendered from
 * the snapshot, which is byte-identical by construction (src/label-pdf.ts).
 * If a re-render ever disagrees with a hash already recorded, the renderer
 * has changed under a run that may already be on paper: the fresh sheets
 * are served, the recorded hash is left as the record of what was first
 * rendered, and the disagreement is logged rather than hidden.
 */
export function runPdf(
  db: Kysely<Database>,
  printRunId: number,
  preparedAt: Date,
  recorded: string | null,
  dir: string,
): Promise<{ bytes: Uint8Array; sha256: string; cached: boolean }> {
  // Two people opening the same unrendered run at once would otherwise start
  // two workers on identical input and write the file twice. The entry is
  // dropped when the render settles, so this coalesces concurrent requests
  // and caches nothing: the file and its recorded hash are the cache.
  const inFlight = renderingRuns.get(printRunId);
  if (inFlight !== undefined) return inFlight;
  const render = runPdfUncoalesced(db, printRunId, preparedAt, recorded, dir).finally(() =>
    renderingRuns.delete(printRunId),
  );
  renderingRuns.set(printRunId, render);
  return render;
}

const renderingRuns = new Map<number, Promise<{ bytes: Uint8Array; sha256: string; cached: boolean }>>();

async function runPdfUncoalesced(
  db: Kysely<Database>,
  printRunId: number,
  preparedAt: Date,
  recorded: string | null,
  dir: string,
): Promise<{ bytes: Uint8Array; sha256: string; cached: boolean }> {
  const path = runPdfPath(dir, printRunId);
  if (recorded !== null) {
    try {
      const bytes = await readFile(path);
      if (sha256(bytes) === recorded) return { bytes, sha256: recorded, cached: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  const rows = await runLabels(db, printRunId);
  const bytes = await renderLabelsPdfOffThread(rows, { preparedAt });
  const digest = sha256(bytes);
  if (recorded !== null && digest !== recorded) {
    console.warn(`print run ${printRunId}: re-rendered sheets hash ${digest}, recorded ${recorded}`);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path, bytes);
  // Unindexed, so the UPDATE is allowed on a row the labels reference. Only
  // ever set once: the hash is of the first render.
  await db
    .updateTable("print_run")
    .set({ pdf_sha256: digest })
    .where("entity_id", "=", printRunId)
    .where("pdf_sha256", "is", null)
    .execute();
  return { bytes, sha256: digest, cached: false };
}

/** A specimen's labels across runs, for the specimen page and the proofing lookup. */
export interface SpecimenLabelRow {
  print_run_id: number;
  /** The number as it printed, or would have: a canceled run's is burned, and this is the only place it survives (beeline-1kb.21). */
  number_text: string;
  state: PrintRunState;
  sheet: number;
  cell: number;
  prepared_at: Date;
  printed_at: Date | null;
  mailed_at: Date | null;
  canceled_at: Date | null;
}

export async function specimenLabels(db: Kysely<Database>, specimenId: number): Promise<SpecimenLabelRow[]> {
  const rows = await db
    .selectFrom("specimen_label")
    .where("specimen_id", "=", specimenId)
    .select(["print_run_id", "number_text", "state", "sheet", "cell", "prepared_at", "printed_at", "mailed_at", "canceled_at"])
    .orderBy("prepared_at", "desc")
    .orderBy("print_run_id", "desc")
    .execute();
  return rows.map((r) => ({ ...r, print_run_id: Number(r.print_run_id), sheet: Number(r.sheet), cell: Number(r.cell) }));
}
