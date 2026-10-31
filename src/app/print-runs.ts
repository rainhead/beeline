import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import type { Database, PrintRunState, ReprintReason } from "../model.js";
import { sha256, type LabelRow } from "../label-pdf.js";
import { renderLabelsPdfOffThread } from "../label-pdf-worker.js";
import { REPRINT_BLOCKER, type ReprintBlocker } from "../print-run.js";

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
  /** Of label_count, how many are reprints (gh-218). */
  reprint_count: number;
}

export async function listRuns(db: Kysely<Database>): Promise<RunListRow[]> {
  const rows = await db
    .selectFrom("print_run as r")
    .innerJoin("print_run_state as s", "s.print_run_id", "r.entity_id")
    .innerJoin("person as p", "p.entity_id", "r.prepared_by")
    .leftJoin("program as a", "a.entity_id", "r.atlas_id")
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
      "s.reprint_count",
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
  /** Reprints a run would take, beside the new labels. */
  reprints: number;
}

export interface ScopeCounts {
  program: { samples: number; labels: number; reprints: number };
  atlases: ScopeOption[];
}

export async function scopeCounts(db: Kysely<Database>): Promise<ScopeCounts> {
  const program = await db
    .selectFrom("print_scope_sample")
    .select(({ fn }) => [fn.countAll<number>().as("samples"), fn.sum<number>("pending_count").as("labels")])
    .executeTakeFirstOrThrow();
  // A specimen asked for twice prints once, so reprints are counted by specimen.
  const programReprints = await db
    .selectFrom("print_scope_reprint")
    .select(sql<number>`count(DISTINCT specimen_id)`.as("n"))
    .executeTakeFirstOrThrow();
  const atlases = await sql<ScopeOption>`
    SELECT a.entity_id AS atlas_id, a.code, a.name,
           (ap.atlas_id IS NOT NULL) AS own,
           count(p.sample_id) AS samples,
           coalesce(sum(p.pending_count), 0) AS labels,
           (SELECT count(DISTINCT pr.specimen_id) FROM printable_reprint pr
              JOIN sample_atlas rsa ON rsa.sample_id = pr.sample_id
             WHERE rsa.atlas_id = a.entity_id) AS reprints
    FROM program a
    JOIN (SELECT DISTINCT atlas_id FROM atlas_region WHERE atlas_id IS NOT NULL) reg ON reg.atlas_id = a.entity_id
    LEFT JOIN atlas_printing ap ON ap.atlas_id = a.entity_id
    LEFT JOIN sample_atlas sa ON sa.atlas_id = a.entity_id
    LEFT JOIN pending_print_sample p ON p.sample_id = sa.sample_id
    GROUP BY a.entity_id, a.code, a.name, ap.atlas_id
    ORDER BY a.entity_id`.execute(db);
  return {
    program: {
      samples: Number(program.samples),
      labels: Number(program.labels ?? 0),
      reprints: Number(programReprints.n),
    },
    atlases: atlases.rows.map((r) => ({
      ...r,
      atlas_id: Number(r.atlas_id),
      own: Boolean(r.own),
      samples: Number(r.samples),
      labels: Number(r.labels),
      reprints: Number(r.reprints),
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
  /**
   * Samples in this unprinted run that staff have since held back
   * (beeline-plu), for the printer to decide on. Empty once it prints.
   */
  held: HeldInRun[];
}

export interface HeldInRun {
  sample_id: number;
  sample_number: string;
  /** Whose numbering it is: a run covers many collectors. */
  collector: string;
  reason: string;
}

export async function loadRun(db: Kysely<Database>, printRunId: number): Promise<RunDetail | null> {
  if (!Number.isSafeInteger(printRunId) || printRunId <= 0) return null;
  const row = await db
    .selectFrom("print_run as r")
    .innerJoin("print_run_state as s", "s.print_run_id", "r.entity_id")
    .innerJoin("person as p", "p.entity_id", "r.prepared_by")
    .leftJoin("program as a", "a.entity_id", "r.atlas_id")
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
      "s.reprint_count",
      sql<number>`(SELECT count(*) FROM printed_label pl WHERE pl.print_run_id = r.entity_id AND pl.warnings IS NOT NULL)`.as(
        "warned",
      ),
      // First prints only, on both sides: a reprint goes out in an envelope
      // of its own by nature, and counting it named every reprinted sample
      // as split between two mailings (gh-218).
      sql<number>`(
        SELECT count(DISTINCT sp.sample_id)
        FROM printed_label pl
        JOIN specimen sp ON sp.entity_id = pl.specimen_id
        WHERE pl.print_run_id = r.entity_id
          AND NOT EXISTS (SELECT 1 FROM printed_label_reprint rp
                          WHERE rp.print_run_id = pl.print_run_id AND rp.specimen_id = pl.specimen_id)
          AND EXISTS (
            SELECT 1 FROM printed_label other
            JOIN specimen osp ON osp.entity_id = other.specimen_id
            JOIN print_run orun ON orun.entity_id = other.print_run_id
            WHERE osp.sample_id = sp.sample_id
              AND other.print_run_id <> r.entity_id
              AND orun.canceled_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM printed_label_reprint orp
                              WHERE orp.print_run_id = other.print_run_id AND orp.specimen_id = other.specimen_id)))`.as(
        "split_samples",
      ),
    ])
    .executeTakeFirst();
  if (row === undefined) return null;
  // A hold placed after the freeze does not change the run: it is named
  // here and the printer decides whether to cancel and prepare again, which
  // leaves the held sample out (Peter, 2026-10-25). A past season's labels
  // print with the run regardless, so they are not named.
  const held =
    row.state === "prepared" || row.state === "approved"
      ? (
          await sql<HeldInRun>`
            SELECT DISTINCT s.entity_id AS sample_id, s.sample_number, p.display_name AS collector, h.reason
            FROM printed_label pl
            JOIN specimen sp ON sp.entity_id = pl.specimen_id
            JOIN sample s ON s.entity_id = sp.sample_id
            JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
            JOIN person p ON p.entity_id = pc.person_id
            JOIN sample_hold h ON h.sample_id = s.entity_id
            JOIN sample_season ss ON ss.sample_id = s.entity_id
            CROSS JOIN season
            WHERE pl.print_run_id = ${printRunId}
              AND ss.season >= season.current_season
            ORDER BY s.sample_number, s.entity_id`.execute(db)
        ).rows.map((h) => ({ ...h, sample_id: Number(h.sample_id) }))
      : [];
  return {
    ...row,
    print_run_id: Number(row.print_run_id),
    warned: Number(row.warned),
    split_samples: Number(row.split_samples),
    held,
  } as RunDetail;
}

export interface RunLabelRow extends LabelRow {
  specimen_id: number;
  sample_id: number;
  sample_number: string;
  warnings: string | null;
  /** A second print under a number minted before (gh-218); the reprints follow the new labels. */
  reprint: boolean;
}

/** The run's labels in sheet order — the proofing surface, and the renderer's input. */
export async function runLabels(db: Kysely<Database>, printRunId: number): Promise<RunLabelRow[]> {
  const rows = await db
    .selectFrom("printed_label as pl")
    .innerJoin("specimen as sp", "sp.entity_id", "pl.specimen_id")
    .innerJoin("sample as s", "s.entity_id", "sp.sample_id")
    .leftJoin("printed_label_reprint as rp", (join) =>
      join.onRef("rp.print_run_id", "=", "pl.print_run_id").onRef("rp.specimen_id", "=", "pl.specimen_id"),
    )
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
      sql<boolean>`rp.specimen_id IS NOT NULL`.as("reprint"),
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
    reprint: Boolean(r.reprint),
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
  /** The run's scope, for its name: an atlas's code, or null for the program's run. */
  atlas_code: string | null;
  /** A reprint, with the request it answered where one can be found (gh-218). */
  reprint: boolean;
  request: ReprintRequestRow | null;
}

/** Who asked for a label again, and why: the reason and note are both optional. */
export interface ReprintRequestRow {
  requested_by: string;
  requested_at: Date;
  reason: ReprintReason | null;
  note: string | null;
}

export async function specimenLabels(db: Kysely<Database>, specimenId: number): Promise<SpecimenLabelRow[]> {
  const rows = await db
    .selectFrom("specimen_label as l")
    .innerJoin("print_run as r", "r.entity_id", "l.print_run_id")
    .leftJoin("program as a", "a.entity_id", "r.atlas_id")
    .where("l.specimen_id", "=", specimenId)
    .select([
      "l.print_run_id",
      "l.number_text",
      "l.state",
      "l.sheet",
      "l.cell",
      "l.prepared_at",
      "l.printed_at",
      "l.mailed_at",
      "l.canceled_at",
      "a.code as atlas_code",
      "l.reprint",
    ])
    .orderBy("l.prepared_at", "desc")
    .orderBy("l.print_run_id", "desc")
    .execute();
  const requests = rows.some((r) => r.reprint) ? await reprintRequests(db, specimenId, false) : [];
  return rows.map((r) => ({
    ...r,
    print_run_id: Number(r.print_run_id),
    sheet: Number(r.sheet),
    cell: Number(r.cell),
    reprint: Boolean(r.reprint),
    // The request a reprint answered is the latest not withdrawn before the
    // run was prepared: pending_reprint's rule read the other way round.
    request: r.reprint ? (requests.find((q) => q.requested_at.getTime() <= new Date(r.prepared_at).getTime()) ?? null) : null,
  }));
}

/** A specimen's requests not withdrawn, newest first; with `pendingOnly`, the one no run has taken yet. */
async function reprintRequests(
  db: Kysely<Database>,
  specimenId: number,
  pendingOnly: boolean,
): Promise<ReprintRequestRow[]> {
  const from = pendingOnly
    ? sql`pending_reprint q`
    : sql`(SELECT * FROM reprint_request WHERE withdrawn_at IS NULL) q`;
  const result = await sql<ReprintRequestRow>`
    SELECT p.display_name AS requested_by, q.requested_at, q.reason, q.note
    FROM ${from}
    JOIN person p ON p.entity_id = q.requested_by
    WHERE q.specimen_id = ${specimenId}
    ORDER BY q.requested_at DESC`.execute(db);
  return result.rows.map((r) => ({ ...r, requested_at: new Date(r.requested_at) }));
}

/**
 * The reprint side of a specimen's page (gh-218): a request no run has taken
 * yet, whether a flag is holding it back from the next run, and whether a
 * new one can be made — the same three tests requestReprint makes, so the
 * form is offered exactly where pressing it would work.
 */
export interface SpecimenReprint {
  pending: (ReprintRequestRow & { waiting: boolean }) | null;
  /** Why a new request cannot be made, or null when it can (REPRINT_BLOCKER). */
  blocker: ReprintBlocker | null;
}

export async function specimenReprint(db: Kysely<Database>, specimenId: number): Promise<SpecimenReprint> {
  const [pending] = await reprintRequests(db, specimenId, true);
  const facts = await sql<{ blocker: ReprintBlocker | null; printable: boolean }>`
    SELECT ${sql.raw(REPRINT_BLOCKER)} AS blocker,
           EXISTS (SELECT 1 FROM printable_reprint p WHERE p.specimen_id = sp.entity_id) AS printable
    FROM specimen sp WHERE sp.entity_id = ${specimenId}`.execute(db);
  const f = facts.rows[0];
  return {
    pending: pending === undefined ? null : { ...pending, waiting: !f?.printable },
    blocker: f?.blocker ?? null,
  };
}

/** The sample page's form: how many of its specimens are asked for now, and how many more could be. */
export interface SampleReprints {
  pending: number;
  canRequest: number;
}

export async function sampleReprints(db: Kysely<Database>, sampleId: number): Promise<SampleReprints> {
  const counts = await sql<{ pending: number; can: number }>`
    SELECT count(*) FILTER (WHERE blocker = 'asked') AS pending,
           count(*) FILTER (WHERE blocker IS NULL) AS can
    FROM (SELECT ${sql.raw(REPRINT_BLOCKER)} AS blocker FROM specimen sp WHERE sp.sample_id = ${sampleId}) t`.execute(db);
  const c = counts.rows[0];
  return { pending: Number(c?.pending ?? 0), canRequest: Number(c?.can ?? 0) };
}
