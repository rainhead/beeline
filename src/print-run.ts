import type { DuckDBConnection } from "@duckdb/node-api";
import { composeLabel, layoutSheets, type LabelInput } from "./label-text.js";
import type { ReprintReason } from "./model.js";
import type { PersonNameParts } from "./person-name.js";

/**
 * Print runs (beeline-1kb.2; the tables are schema/035, their meaning
 * schema/155). Preparing a run is the freeze: it creates specimen rows for
 * every pending printable sample in scope, mints their field numbers, and
 * snapshots what each label will say. Everything after that is a guarded
 * timestamp. It mints no occurrenceID: a specimen gets that from the museum
 * database its record reaches (ADR 0008, amended 2026-10-23).
 *
 * Every writer here runs behind one in-process lock, and the caller gives the
 * freeze a connection of its own. The app shares a single connection whose
 * transactions are raw BEGIN/COMMIT, so two requests inside one transaction
 * would interleave statements; the lock keeps two Prepares from racing, and
 * the second then finds nothing pending, because the first created the
 * specimen rows that take a sample out of pending_print_sample. If anything
 * slips past both, the registry's PRIMARY KEY and specimen's UNIQUE
 * (sample_id, specimen_number) fail the transaction rather than mint twice —
 * safety from the model, not from one careful operator
 * (reference-implementation.md, requirement 9).
 */

let chain: Promise<unknown> = Promise.resolve();
/** Serialises every print-run write in this process. */
export function withPrintRunLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

/**
 * The store declining to do what was asked, for a reason the person asking
 * can act on: a pending sample that is not fit to freeze, a run that cannot
 * be canceled because somebody has already determined one of its specimens.
 * Typed and coded so a caller can answer with the reason rather than a bare
 * failure (CodeRabbit, #76: the cancel refusal reached the printer as a 500),
 * and so the words are the catalog's and not this module's. Anything else
 * thrown here is a fault, not a refusal.
 */
export type PrintRunRefusal =
  | { code: "no_location"; sampleId: number }
  | { code: "no_primary_collector"; sampleId: number }
  | { code: "determined"; printRunId: number; specimens: number }
  | { code: "atlas_not_printing"; atlasId: number }
  /**
   * Nothing the request named could be asked for. Of `specimens`, how many
   * have no number to print, are asked for already, or are in a run that
   * has not printed; one specimen is exactly one of the three.
   */
  | { code: "reprint_refused"; specimens: number; unnumbered: number; asked: number; printing: number };

export class PrintRunRefused extends Error {
  constructor(public readonly refusal: PrintRunRefusal) {
    super(
      refusal.code === "reprint_refused"
        ? `no reprint requested: of ${refusal.specimens} specimen(s), ${refusal.unnumbered} have no number, ${refusal.asked} are asked for already, ${refusal.printing} are in an unprinted run`
        : refusal.code === "atlas_not_printing"
        ? `atlas ${refusal.atlasId} does not print its own labels; a run scoped to it is refused`
        : refusal.code === "determined"
        ? `print run ${refusal.printRunId} has ${refusal.specimens} determined specimen(s); cancel refused`
        : refusal.code === "no_location"
          ? `sample ${refusal.sampleId} is pending print but has no location row`
          : `sample ${refusal.sampleId} is pending print but has no single primary collector`,
    );
  }
}

export interface PrepareOptions {
  /**
   * Null = every atlas that does not print its own labels (atlas_printing),
   * plus samples outside any atlas. Otherwise an atlas in atlas_printing: the
   * rest are the program's to print, so a run scoped to one is refused.
   */
  atlasId: number | null;
  personId: number;
  now?: Date;
}

export interface PrepareResult {
  printRunId: number;
  /** Every label in the run, reprints included. */
  labels: number;
  reprints: number;
  samples: number;
  sheets: number;
}

interface PendingRow {
  sample_id: number;
  kind: "net" | "trap";
  sample_number: string;
  date_start: Date;
  date_end: Date;
  specimen_count: number;
  country: string | null;
  state_province: string | null;
  county: string | null;
  locality: string | null;
  protocol: string | null;
  latitude: number | null;
  longitude: number | null;
  elevation_m: number | null;
  primary_id: number;
}

interface CollectorRow extends PersonNameParts {
  sample_id: number;
  position: number;
}

const rows = async <T>(conn: DuckDBConnection, sql: string, params: unknown[] = []): Promise<T[]> =>
  (await (await conn.run(sql, params as never)).getRowObjectsJson()) as T[];

const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));

/**
 * One multi-row INSERT per chunk of rows, every value a bound parameter.
 * `casts` names a type per column where the engine cannot infer one from the
 * parameter (a timestamp or date passed as text, a column that is NULL in
 * the first row); "" leaves the parameter bare.
 */
async function insertMany(
  conn: DuckDBConnection,
  insertInto: string,
  casts: readonly string[],
  all: unknown[][],
  chunk = 500,
): Promise<void> {
  for (let at = 0; at < all.length; at += chunk) {
    const part = all.slice(at, at + chunk);
    let p = 0;
    const tuples = part.map(
      (row) => `(${row.map((_, i) => (casts[i] ? `CAST($${++p} AS ${casts[i]})` : `$${++p}`)).join(", ")})`,
    );
    await conn.run(`${insertInto} VALUES ${tuples.join(", ")}`, part.flat() as never);
  }
}

/**
 * The first number this run mints (ADR 0008 §7): one past the highest
 * eight-digit number anywhere — the imported corpus AND the registry, never
 * the registry alone, since a rebuilt store has an empty registry beside a
 * full corpus — floored at YY000001 for the current Pacific year, which is
 * the reference's convention of starting each year's block at the year. The
 * imported ceiling is 26072091, so a 2026 run starts at 26072092 and not at
 * 26000001. SIMILAR TO is standard SQL and a full match in both engines,
 * which `~` is not (CLAUDE.md).
 */
export async function nextFieldNumber(conn: DuckDBConnection, now: Date): Promise<number> {
  const [row] = await rows<{ ceiling: number | null }>(
    conn,
    `SELECT max(n) AS ceiling FROM (
       SELECT CAST(field_number AS BIGINT) AS n FROM specimen WHERE field_number SIMILAR TO '[0-9]{8}'
       UNION ALL
       SELECT CAST(field_number AS BIGINT) FROM minted_field_number WHERE field_number SIMILAR TO '[0-9]{8}'
     ) numbered`,
  );
  const ceiling = row?.ceiling === null || row?.ceiling === undefined ? 0 : Number(row.ceiling);
  const year = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "2-digit" }).format(now),
  );
  return Math.max(ceiling + 1, year * 1_000_000 + 1);
}

/** Natural order for sample numbers: 12 after 9, OBAS-00657 after OBAS-00099. */
function naturalKey(s: string): Array<string | number> {
  return s.split(/(\d+)/).filter((part) => part !== "").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}
function compareNatural(a: string, b: string): number {
  const ka = naturalKey(a);
  const kb = naturalKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const x = ka[i];
    const y = kb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/**
 * Freeze: one transaction on the connection given, which must be the
 * caller's own (see the module note). Returns null, and writes nothing, when
 * the scope has nothing pending.
 */
export function prepareRun(conn: DuckDBConnection, opts: PrepareOptions): Promise<PrepareResult | null> {
  return withPrintRunLock(() => prepareRunUnlocked(conn, opts));
}

async function prepareRunUnlocked(conn: DuckDBConnection, opts: PrepareOptions): Promise<PrepareResult | null> {
  const now = opts.now ?? new Date();
  const nowSql = now.toISOString();
  await conn.run("BEGIN TRANSACTION");
  try {
    // The scope, materialised once so the two reads below see the same set.
    // A LEFT JOIN on the location and a check afterwards rather than an inner
    // join: printability guarantees a location row (missing_location and
    // obscured_no_true_coordinates both block), so a pending sample without
    // one is an invariant broken somewhere else and should stop the run, not
    // be quietly left pending forever.
    await conn.run(`DROP TABLE IF EXISTS freeze_scope`);
    if (opts.atlasId === null) {
      await conn.run(
        `CREATE TEMP TABLE freeze_scope AS SELECT sample_id, pending_count FROM print_scope_sample`,
      );
    } else {
      // Checked here rather than only in the scope picker, so no caller can
      // print an atlas's labels that the unscoped run already covers.
      const [printing] = await rows<{ n: bigint }>(
        conn,
        `SELECT count(*) AS n FROM atlas_printing WHERE atlas_id = $1`,
        [opts.atlasId],
      );
      if (Number(printing?.n ?? 0) === 0) {
        throw new PrintRunRefused({ code: "atlas_not_printing", atlasId: opts.atlasId });
      }
      await conn.run(
        `CREATE TEMP TABLE freeze_scope AS
           SELECT p.sample_id, p.pending_count
           FROM pending_print_sample p
           JOIN sample_atlas sa ON sa.sample_id = p.sample_id
           WHERE sa.atlas_id = $1`,
        [opts.atlasId],
      );
    }
    // The reprints the same scope takes (gh-218), one row per specimen
    // however many requests name it, and every sample either list touches.
    await conn.run(`DROP TABLE IF EXISTS freeze_reprint`);
    await conn.run(`DROP TABLE IF EXISTS freeze_samples`);
    if (opts.atlasId === null) {
      await conn.run(
        `CREATE TEMP TABLE freeze_reprint AS SELECT DISTINCT specimen_id, sample_id FROM print_scope_reprint`,
      );
    } else {
      await conn.run(
        `CREATE TEMP TABLE freeze_reprint AS
           SELECT DISTINCT p.specimen_id, p.sample_id
           FROM printable_reprint p
           JOIN sample_atlas sa ON sa.sample_id = p.sample_id
           WHERE sa.atlas_id = $1`,
        [opts.atlasId],
      );
    }
    await conn.run(
      `CREATE TEMP TABLE freeze_samples AS
         SELECT sample_id FROM freeze_scope UNION SELECT sample_id FROM freeze_reprint`,
    );
    // The join below is on sample_primary_collector, which is "the row at
    // position 1": a sample with none would be skipped and stay pending
    // forever, and one with two would be frozen twice. The invariant is
    // checked, not enforced (schema/116), so it is checked here first, the
    // way the location row is checked after — an invariant broken somewhere
    // else stops the run rather than being quietly worked around.
    const [headless] = await rows<{ sample_id: number | null }>(
      conn,
      `SELECT min(i.sample_id) AS sample_id
       FROM sample_primary_collector_invalid i JOIN freeze_samples fs ON fs.sample_id = i.sample_id`,
    );
    if (headless?.sample_id !== null && headless?.sample_id !== undefined) {
      throw new PrintRunRefused({ code: "no_primary_collector", sampleId: Number(headless.sample_id) });
    }
    const samplesInRun = await rows<PendingRow & { pending: boolean }>(
      conn,
      `SELECT s.entity_id AS sample_id, s.kind, s.sample_number, s.date_start, s.date_end,
              s.specimen_count, s.country, s.state_province, s.county, s.locality, s.protocol,
              loc.latitude, loc.longitude, loc.elevation_m,
              pc.person_id AS primary_id,
              (scope.sample_id IS NOT NULL) AS pending
       FROM freeze_samples fs
       JOIN sample s ON s.entity_id = fs.sample_id
       LEFT JOIN freeze_scope scope ON scope.sample_id = s.entity_id
       LEFT JOIN sample_location loc ON loc.sample_id = s.entity_id
       JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id`,
    );
    if (samplesInRun.length === 0) {
      await conn.run("ROLLBACK");
      return null;
    }
    const pending = samplesInRun.filter((s) => s.pending);
    const sampleById = new Map(samplesInRun.map((s) => [Number(s.sample_id), s]));
    // Each reprint with its number and the last label it had, if Beeline
    // printed one, so the proofer is told where the reprint will read
    // differently. An imported specimen has no label to compare against.
    const reprintRows = await rows<{
      specimen_id: number;
      sample_id: number;
      specimen_number: number;
      field_number: string;
      location_text: string | null;
      coordinates_text: string | null;
      date_text: string | null;
      collector_text: string | null;
      method_text: string | null;
    }>(
      conn,
      `SELECT fr.specimen_id, fr.sample_id, sp.specimen_number, sp.field_number,
              last.location_text, last.coordinates_text, last.date_text, last.collector_text, last.method_text
       FROM freeze_reprint fr
       JOIN specimen sp ON sp.entity_id = fr.specimen_id
       LEFT JOIN (
         SELECT pl.specimen_id, pl.location_text, pl.coordinates_text, pl.date_text, pl.collector_text, pl.method_text,
                row_number() OVER (PARTITION BY pl.specimen_id ORDER BY r.prepared_at DESC, r.entity_id DESC) AS rn
         FROM printed_label pl
         JOIN print_run r ON r.entity_id = pl.print_run_id
         WHERE r.canceled_at IS NULL
       ) last ON last.specimen_id = fr.specimen_id AND last.rn = 1`,
    );
    // The specimen rows these samples already have: individuated ones keep
    // their place in 1..N and are skipped; the rest were left behind by a
    // canceled run and are re-adopted — same row, a fresh number — rather
    // than inserted beside (schema/117 says why
    // nothing is deleted).
    const existing = await rows<{ sample_id: number; specimen_id: number; specimen_number: number; individuated: boolean }>(
      conn,
      `SELECT sp.sample_id, sp.entity_id AS specimen_id, sp.specimen_number,
              EXISTS (SELECT 1 FROM individuated_specimen i WHERE i.specimen_id = sp.entity_id) AS individuated
       FROM freeze_scope fs JOIN specimen sp ON sp.sample_id = fs.sample_id`,
    );
    const taken = new Map<number, Set<number>>();
    const orphans = new Map<number, Map<number, number>>();
    for (const e of existing) {
      const sampleId = Number(e.sample_id);
      if (e.individuated) {
        if (!taken.has(sampleId)) taken.set(sampleId, new Set());
        taken.get(sampleId)!.add(Number(e.specimen_number));
      } else {
        if (!orphans.has(sampleId)) orphans.set(sampleId, new Map());
        orphans.get(sampleId)!.set(Number(e.specimen_number), Number(e.specimen_id));
      }
    }
    const collectors = await rows<CollectorRow>(
      conn,
      `SELECT sc.sample_id, sc.position, p.display_name, p.given_name, p.family_name, p.label_name
       FROM freeze_samples fs
       JOIN sample_collector sc ON sc.sample_id = fs.sample_id
       JOIN person p ON p.entity_id = sc.person_id
       ORDER BY sc.sample_id, sc.position`,
    );
    const collectorsOf = new Map<number, PersonNameParts[]>();
    for (const c of collectors) {
      if (!collectorsOf.has(c.sample_id)) collectorsOf.set(c.sample_id, []);
      collectorsOf.get(c.sample_id)!.push(c);
    }

    const inputFor = (sample: PendingRow, specimenNumber: number): LabelInput => ({
      country: sample.country,
      state_province: sample.state_province,
      county: sample.county,
      locality: sample.locality,
      latitude: Number(sample.latitude),
      longitude: Number(sample.longitude),
      elevation_m: sample.elevation_m === null ? null : Number(sample.elevation_m),
      date_start: asDate(sample.date_start),
      date_end: asDate(sample.date_end),
      sample_number: sample.sample_number,
      specimen_number: specimenNumber,
      kind: sample.kind,
      protocol: sample.protocol,
      collectors: collectorsOf.get(sample.sample_id) ?? [],
    });
    for (const sample of samplesInRun) {
      if (sample.latitude === null || sample.longitude === null) {
        throw new PrintRunRefused({ code: "no_location", sampleId: Number(sample.sample_id) });
      }
    }

    // One entry per label, in sheet order: collector, then date, then sample
    // number (natural), then specimen number — so a collector's numbers run
    // together, as the reference sorted them. The collector line is what the
    // sheet is cut apart by, so it is the primary key of the order; the
    // person id breaks a tie between two people whose lines read the same.
    // The new labels come first and the reprints after them in the same
    // order, a second series on the same sheets (gh-218).
    type Pending = {
      sample: PendingRow;
      input: LabelInput;
      specimen_number: number;
      collector: string;
      /** An existing row to re-adopt or reprint, or null to insert. */
      specimen_id: number | null;
      /** A reprint: the number it already carries, and the lines that read differently from its last label. */
      reprint: { field_number: string; differs: string[] } | null;
    };
    const toMint: Pending[] = [];
    for (const sample of pending) {
      const have = taken.get(Number(sample.sample_id)) ?? new Set<number>();
      for (let n = 1; n <= Number(sample.specimen_count); n++) {
        if (have.has(n)) continue;
        const input = inputFor(sample, n);
        // The collector line is composed once here and reused for the sort;
        // composeLabel below recomputes it identically for the snapshot.
        toMint.push({
          sample,
          input,
          specimen_number: n,
          collector: composeLabel(input, "").collector,
          specimen_id: orphans.get(Number(sample.sample_id))?.get(n) ?? null,
          reprint: null,
        });
      }
    }
    // A reprint is composed from the record as it stands, as a new label is
    // (Peter, 2026-10-30): for a lost label that is what printed, since a
    // printed sample stops following iNaturalist, and for a corrected record
    // it is the correction (gh-17). Where it reads differently from the last
    // label Beeline printed, the proofer is told which lines.
    const reprints: Pending[] = reprintRows.map((r) => {
      const sample = sampleById.get(Number(r.sample_id))!;
      const input = inputFor(sample, Number(r.specimen_number));
      const text = composeLabel(input, r.field_number);
      const lines = [
        ["location", text.location, r.location_text],
        ["coordinates", text.coordinates, r.coordinates_text],
        ["date", text.date, r.date_text],
        ["collector", text.collector, r.collector_text],
        ["method", text.method, r.method_text],
      ] as const;
      const differs =
        r.location_text === null ? [] : lines.filter(([, now, then]) => now !== then).map(([line]) => line);
      return {
        sample,
        input,
        specimen_number: Number(r.specimen_number),
        collector: text.collector,
        specimen_id: Number(r.specimen_id),
        reprint: { field_number: r.field_number, differs },
      };
    });
    const sheetOrder = (a: Pending, b: Pending) =>
      a.collector.localeCompare(b.collector) ||
      a.sample.primary_id - b.sample.primary_id ||
      a.input.date_start.getTime() - b.input.date_start.getTime() ||
      compareNatural(a.sample.sample_number, b.sample.sample_number) ||
      a.specimen_number - b.specimen_number;
    toMint.sort(sheetOrder);
    reprints.sort(sheetOrder);

    const [run] = await rows<{ entity_id: number }>(
      conn,
      `INSERT INTO print_run (atlas_id, prepared_by, prepared_at)
       VALUES ($1, $2, CAST($3 AS TIMESTAMPTZ)) RETURNING entity_id`,
      [opts.atlasId, opts.personId, nowSql],
    );
    const printRunId = Number(run!.entity_id);

    let number = await nextFieldNumber(conn, now);
    // The reprints are set off from the new labels by one blank cell, the gap
    // between two collectors, rather than a fresh sheet (Peter, 2026-10-30).
    const laidOut = layoutSheets([...toMint, ...reprints], (l) =>
      `${l.reprint === null ? "new" : "reprint"} ${l.collector}`,
    );

    // Written in bulk, not label by label: three statements per label was
    // seven seconds for 5,411 labels on a workstation and minutes on the
    // sandbox's two shared threads, all of it inside one transaction holding
    // the print lock (found demonstrating it, 2026-09-18). New specimens get
    // their ids drawn up front, so every row of all three tables is known
    // before anything is inserted and each table takes a handful of
    // multi-row statements.
    const fresh = laidOut.filter((l) => l.label.specimen_id === null).length;
    const drawn = (
      await rows<{ id: number }>(conn, `SELECT nextval('entity_id_seq') AS id FROM range(${fresh})`)
    ).map((r) => Number(r.id));
    let sheets = 0;
    const samples = new Set<number>();
    const specimenRows: unknown[][] = [];
    const adoptRows: unknown[][] = [];
    const registryRows: unknown[][] = [];
    const labelRows: unknown[][] = [];
    for (const { label, sheet, cell } of laidOut) {
      // A reprint carries the number it has; only a first print mints one,
      // and having no registry row in this run is what makes a label a
      // reprint (printed_label_reprint, schema/101).
      const fieldNumber = label.reprint?.field_number ?? String(number++).padStart(8, "0");
      const text = composeLabel(label.input, fieldNumber);
      const differs = label.reprint?.differs ?? [];
      const warnings =
        differs.length === 0
          ? text.warnings
          : [text.warnings, `reprint differs from its last label: ${differs.join(", ")}`]
              .filter((w) => w !== null)
              .join("; ");
      let specimenId: number;
      if (label.reprint !== null) {
        specimenId = label.specimen_id!;
      } else if (label.specimen_id === null) {
        specimenId = drawn.shift()!;
        specimenRows.push([specimenId, label.sample.sample_id, label.specimen_number, fieldNumber, nowSql]);
      } else {
        specimenId = label.specimen_id;
        adoptRows.push([specimenId, fieldNumber]);
      }
      if (label.reprint === null) registryRows.push([fieldNumber, printRunId, specimenId, nowSql]);
      labelRows.push([
        printRunId,
        specimenId,
        sheet,
        cell,
        text.location,
        text.coordinates,
        text.date,
        text.collector,
        text.method,
        text.number,
        label.input.latitude,
        label.input.longitude,
        label.input.elevation_m,
        label.input.date_start.toISOString().slice(0, 10),
        label.input.date_end.toISOString().slice(0, 10),
        label.input.locality,
        label.input.county,
        label.input.state_province,
        label.input.country,
        warnings,
      ]);
      sheets = Math.max(sheets, sheet);
      samples.add(label.sample.sample_id);
    }
    await insertMany(
      conn,
      `INSERT INTO specimen (entity_id, sample_id, specimen_number, field_number, created_at)`,
      ["", "", "", "", "TIMESTAMPTZ"],
      specimenRows,
    );
    if (adoptRows.length > 0) {
      await conn.run(`CREATE OR REPLACE TEMP TABLE freeze_adopt (specimen_id INTEGER, field_number TEXT)`);
      await insertMany(conn, `INSERT INTO freeze_adopt (specimen_id, field_number)`, ["", ""], adoptRows);
      await conn.run(
        `UPDATE specimen SET field_number = a.field_number FROM freeze_adopt a WHERE specimen.entity_id = a.specimen_id`,
      );
      await conn.run(`DROP TABLE freeze_adopt`);
    }
    await insertMany(
      conn,
      `INSERT INTO minted_field_number (field_number, print_run_id, specimen_id, minted_at)`,
      ["", "", "", "TIMESTAMPTZ"],
      registryRows,
    );
    await insertMany(
      conn,
      `INSERT INTO printed_label (
         print_run_id, specimen_id, sheet, cell,
         location_text, coordinates_text, date_text, collector_text, method_text, number_text,
         latitude, longitude, elevation_m, date_start, date_end,
         locality, county, state_province, country, warnings)`,
      ["", "", "", "", "", "", "", "", "", "", "", "", "INTEGER", "DATE", "DATE", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT"],
      labelRows,
    );
    await conn.run(`DROP TABLE IF EXISTS freeze_scope`);
    await conn.run(`DROP TABLE IF EXISTS freeze_reprint`);
    await conn.run(`DROP TABLE IF EXISTS freeze_samples`);
    await conn.run("COMMIT");
    return { printRunId, labels: laidOut.length, reprints: reprints.length, samples: samples.size, sheets };
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}

export type PrintRunState = "prepared" | "approved" | "printed" | "mailed" | "canceled";

export async function runState(conn: DuckDBConnection, printRunId: number): Promise<PrintRunState | null> {
  const [row] = await rows<{ state: PrintRunState }>(
    conn,
    `SELECT state FROM print_run_state WHERE print_run_id = $1`,
    [printRunId],
  );
  return row?.state ?? null;
}

export class PrintRunTransitionError extends Error {
  constructor(
    public readonly printRunId: number,
    public readonly from: PrintRunState | null,
    public readonly to: PrintRunState,
  ) {
    super(`print run ${printRunId} is ${from ?? "missing"}; cannot mark it ${to}`);
  }
}

interface TransitionOptions {
  personId: number;
  now?: Date;
  note?: string | null;
}

async function transition(
  conn: DuckDBConnection,
  printRunId: number,
  from: PrintRunState,
  to: Exclude<PrintRunState, "prepared" | "canceled">,
  opts: TransitionOptions,
): Promise<void> {
  const state = await runState(conn, printRunId);
  if (state !== from) throw new PrintRunTransitionError(printRunId, state, to);
  const nowSql = (opts.now ?? new Date()).toISOString();
  await conn.run(
    `UPDATE print_run SET ${to}_by = $1, ${to}_at = CAST($2 AS TIMESTAMPTZ),
                          note = coalesce($3, note)
      WHERE entity_id = $4`,
    [opts.personId, nowSql, opts.note ?? null, printRunId],
  );
}

/** Proofed and good to print. */
export const approveRun = (conn: DuckDBConnection, id: number, opts: TransitionOptions) =>
  withPrintRunLock(() => transition(conn, id, "prepared", "approved", opts));

/** The labels are on paper: from here the samples are locked (printed_sample). */
export const markPrinted = (conn: DuckDBConnection, id: number, opts: TransitionOptions) =>
  withPrintRunLock(() => transition(conn, id, "approved", "printed", opts));

/** The envelopes went out. */
export const markMailed = (conn: DuckDBConnection, id: number, opts: TransitionOptions) =>
  withPrintRunLock(() => transition(conn, id, "printed", "mailed", opts));

/**
 * Cancel an unprinted run. Nothing is deleted (schema/117 says why the
 * engine will not let it be, and why a half-done cancel would be worse than
 * none): the labels stay as the record of what was prepared and never
 * printed, the specimens keep their rows with the field number cleared, and
 * every number the run minted is burned — its registry row loses its
 * specimen and is never reissued. individuated_specimen takes the specimens
 * back out of the count, the samples are pending again, and the next run's
 * freeze re-adopts the rows. Refuses a run that has printed, and a run any
 * of whose specimens carries a determination, which should not happen before
 * printing and would be orphaned from its number if it had.
 */
export const cancelRun = (conn: DuckDBConnection, id: number, opts: TransitionOptions) =>
  withPrintRunLock(async () => {
    const state = await runState(conn, id);
    if (state !== "prepared" && state !== "approved") throw new PrintRunTransitionError(id, state, "canceled");
    await conn.run("BEGIN TRANSACTION");
    try {
      const [determinedRow] = await rows<{ determined: number }>(
        conn,
        `SELECT count(*) AS determined FROM determination d
          WHERE d.specimen_id IN (SELECT specimen_id FROM minted_field_number WHERE print_run_id = $1)`,
        [id],
      );
      const determined = Number(determinedRow?.determined ?? 0);
      if (determined > 0) {
        throw new PrintRunRefused({ code: "determined", printRunId: id, specimens: determined });
      }
      // field_number is unindexed, so this UPDATE is allowed on a row the
      // run's labels reference (duckdb/duckdb#20246); the registry rows are
      // referenced by nothing.
      await conn.run(
        `UPDATE specimen SET field_number = NULL
          WHERE entity_id IN (SELECT specimen_id FROM minted_field_number WHERE print_run_id = $1)`,
        [id],
      );
      await conn.run(`UPDATE minted_field_number SET specimen_id = NULL WHERE print_run_id = $1`, [id]);
      const nowSql = (opts.now ?? new Date()).toISOString();
      await conn.run(
        `UPDATE print_run SET canceled_by = $1, canceled_at = CAST($2 AS TIMESTAMPTZ), note = coalesce($3, note)
          WHERE entity_id = $4`,
        [opts.personId, nowSql, opts.note ?? null, id],
      );
      await conn.run("COMMIT");
    } catch (err) {
      await conn.run("ROLLBACK");
      throw err;
    }
  });

/**
 * What a reprint request names (gh-218): one specimen, from its page, or
 * every specimen of a sample, from the sample's page.
 */
export type ReprintTarget = { specimenId: number } | { sampleId: number };

export interface ReprintOptions {
  personId: number;
  /** Optional: a quick choice, or nothing (Peter, 2026-10-30). */
  reason?: ReprintReason | null;
  note?: string | null;
  now?: Date;
}

const targetWhere = (target: ReprintTarget) =>
  "specimenId" in target ? { sql: "sp.entity_id = $1", id: target.specimenId } : { sql: "sp.sample_id = $1", id: target.sampleId };

/**
 * Ask for labels to be printed again. A specimen can be asked for when it has
 * a number to print, nothing is already asked for it, and no run that has
 * not printed yet holds a label for it — that run is about to print one, and
 * if it is the wrong one the answer is to cancel it. For a sample, every
 * specimen that can be asked for is, and the rest are left as they are; the
 * refusal comes only when none can. Behind the print-run lock, so a request
 * is wholly before or wholly after any freeze: pending_reprint compares the
 * request's instant with the run's.
 */
export const requestReprint = (conn: DuckDBConnection, target: ReprintTarget, opts: ReprintOptions) =>
  withPrintRunLock(async () => {
    const where = targetWhere(target);
    const [counts] = await rows<{ total: bigint; unnumbered: bigint; asked: bigint; printing: bigint; can: bigint }>(
      conn,
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE NOT numbered) AS unnumbered,
              count(*) FILTER (WHERE numbered AND asked) AS asked,
              count(*) FILTER (WHERE numbered AND NOT asked AND printing) AS printing,
              count(*) FILTER (WHERE numbered AND NOT asked AND NOT printing) AS can
       FROM (
         SELECT sp.field_number IS NOT NULL AS numbered,
                EXISTS (SELECT 1 FROM pending_reprint p WHERE p.specimen_id = sp.entity_id) AS asked,
                EXISTS (SELECT 1 FROM printed_label pl JOIN print_run r ON r.entity_id = pl.print_run_id
                        WHERE pl.specimen_id = sp.entity_id AND r.canceled_at IS NULL AND r.printed_at IS NULL) AS printing
         FROM specimen sp WHERE ${where.sql}
       ) t`,
      [where.id],
    );
    const can = Number(counts?.can ?? 0);
    if (can === 0) {
      throw new PrintRunRefused({
        code: "reprint_refused",
        specimens: Number(counts?.total ?? 0),
        unnumbered: Number(counts?.unnumbered ?? 0),
        asked: Number(counts?.asked ?? 0),
        printing: Number(counts?.printing ?? 0),
      });
    }
    await conn.run(
      `INSERT INTO reprint_request (specimen_id, requested_by, requested_at, reason, note)
       SELECT sp.entity_id, $2, CAST($3 AS TIMESTAMPTZ), $4, $5
       FROM specimen sp
       WHERE ${where.sql}
         AND sp.field_number IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM pending_reprint p WHERE p.specimen_id = sp.entity_id)
         AND NOT EXISTS (SELECT 1 FROM printed_label pl JOIN print_run r ON r.entity_id = pl.print_run_id
                         WHERE pl.specimen_id = sp.entity_id AND r.canceled_at IS NULL AND r.printed_at IS NULL)`,
      [where.id, opts.personId, (opts.now ?? new Date()).toISOString(), opts.reason ?? null, opts.note ?? null],
    );
    return { requested: can };
  });

/**
 * Take back requests no run has taken yet. One a run has taken is answered:
 * to stop that label, cancel the run, which puts the request back here.
 * Withdrawing nothing is not an error — the request may have been taken or
 * withdrawn by someone else between the page and the press — and the count
 * says what happened.
 */
export const withdrawReprint = (conn: DuckDBConnection, target: ReprintTarget, opts: ReprintOptions) =>
  withPrintRunLock(async () => {
    const where = targetWhere(target);
    const [row] = await rows<{ n: bigint }>(
      conn,
      `SELECT count(*) AS n FROM pending_reprint p JOIN specimen sp ON sp.entity_id = p.specimen_id WHERE ${where.sql}`,
      [where.id],
    );
    await conn.run(
      `UPDATE reprint_request SET withdrawn_by = $2, withdrawn_at = CAST($3 AS TIMESTAMPTZ)
        WHERE entity_id IN (
          SELECT p.reprint_request_id FROM pending_reprint p JOIN specimen sp ON sp.entity_id = p.specimen_id
          WHERE ${where.sql})`,
      [where.id, opts.personId, (opts.now ?? new Date()).toISOString()],
    );
    return { withdrawn: Number(row?.n ?? 0) };
  });
