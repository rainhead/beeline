import type { DuckDBConnection } from "@duckdb/node-api";
import { writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { csvCell } from "./app/listings.js";
import { DEFAULT_DB } from "./person-change.js";

/**
 * A staff inventory's verdict on each specimen, onto the specimen
 * (beeline-fud5): `specimen_disposition`, which the exports write as
 * dwc:disposition and dwc:occurrenceRemarks.
 *
 * The file is the old system's export with a remark column, as Andony wrote
 * one after going through the boxes for the 2025 season
 * (docs/research/2025-inventory.md): `LOST SPECIMEN: No specimen in complete
 * OR inventory ...`, `PHANTOM RECORD: Metadata for fieldNumber X duplicates
 * fieldNumber Y ...`, `PRINT REQUIRED: ...`, and so on, each remark opening
 * with its kind in capitals. A row with no remark is a record whose pin the
 * inventory found and had nothing to say about.
 *
 * A row reaches a specimen by its field number, and a remark on a row that
 * reached one is kept as written. Two things are corrected on the way:
 *
 * SURPLUS LABELS. The old system printed one bee under two or three numbers,
 * and the inventory, finding no pin under the later number, called that
 * record a lost specimen. It is not: the same bee, by collector, date, sample
 * and specimen number, stands elsewhere in the file under the number its pin
 * carries, and Beeline holds it under that number. So a lost row whose number
 * is no specimen, and whose twin by those five facts is one, becomes a
 * sentence on the twin saying that another label was printed and no pin
 * carries it (Andony, 3 November 2026, GitHub #244). A print date the old
 * system wrote before the bee was collected is not repeated.
 *
 * DISPOSITION. Darwin Core's word for whether the pin is there: a lost or
 * phantom record is `missing`, a record the inventory confirmed, or whose
 * surplus labels it explained, is `in collection`, and a remark about
 * something else (a label still to print, metadata rebuilt from a file)
 * says nothing about the pin and gets no disposition.
 *
 * What cannot be placed is held and listed, with the reason, in a CSV beside
 * the file: a number no specimen carries and no twin explains; a row that is
 * not a lost record but names a number Beeline lacks, which is a pin or a
 * record Beeline has yet to take in; a number on more than one specimen; and
 * two rows that remark differently on one specimen. Those are the worklist
 * for the rest of beeline-fud5, and nothing is guessed at.
 *
 * Loading again changes nothing where the store already says what the file
 * says, and replaces the row where the file now says something else.
 */

export const DISPOSITIONS = ["in collection", "missing"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** Why a row was not written, in the held list. */
export const HELD_REASONS = ["no_specimen", "number_unknown", "ambiguous_number", "ambiguous_twin", "conflicting_remarks"] as const;
export type HeldReason = (typeof HELD_REASONS)[number];

export interface DispositionLoadOptions {
  /** The inventory file: .xlsx (its first sheet, or `sheet`) or .csv, with the old export's columns and occurrenceRemarks. */
  file: string;
  sheet?: string;
  /** Whose statement it is, and the date it is good for. */
  statedBy: string;
  statedOn: string;
  /** Where the held rows go; beside the file by default. */
  heldPath?: string;
  dryRun?: boolean;
}

export interface DispositionLoadResult {
  file: string;
  /** Rows carrying a field number or a remark. */
  rows: number;
  remarked: number;
  /** Rows whose field number is one specimen. */
  matched: number;
  /** Lost rows read as a surplus label on the twin specimen. */
  surplusLabels: number;
  specimens: { written: number; inserted: number; updated: number; unchanged: number };
  held: Record<HeldReason, number>;
  byKind: Array<{ kind: string | null; rows: number; matched: number; surplus: number; held: number }>;
  heldPath: string;
}

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** The remark's kind: its opening words in capitals, before the colon or a date. */
export const KIND_SQL = `nullif(regexp_extract(remarks, '^([A-Z][A-Z ]*?[A-Z])(:| on \\d)', 1), '')`;

const MISSING_KINDS = ["LOST SPECIMEN", "PHANTOM RECORD"];
const PRESENT_KINDS = ["PRINTED", "RECOVERED"];
const inList = (xs: string[]) => xs.map(sqlString).join(", ");

export const HELD_COLUMNS = ["row", "field_number", "kind", "reason", "remarks"] as const;

/** The sheet or file as a relation, every value text. */
function sourceSql(file: string, sheet: string | undefined): string {
  if (extname(file).toLowerCase() === ".xlsx") {
    const sheetArg = sheet === undefined ? "" : `, sheet = ${sqlString(sheet)}`;
    return `read_xlsx(${sqlString(file)}, header = true, all_varchar = true, stop_at_empty = false${sheetArg})`;
  }
  return `read_csv(${sqlString(file)}, header = true, all_varchar = true)`;
}

export async function loadDispositions(conn: DuckDBConnection, opts: DispositionLoadOptions): Promise<DispositionLoadResult> {
  if (opts.statedBy.trim() === "") throw new Error("--by: whose statement the file is");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.statedOn)) throw new Error("--on: the date the inventory is good for, as YYYY-MM-DD");
  const heldPath = opts.heldPath ?? `${opts.file}.held.csv`;
  const source = sourceSql(opts.file, opts.sheet);
  if (extname(opts.file).toLowerCase() === ".xlsx") {
    // read_xlsx autoloads, but say so: a store opened offline without the
    // extension cached fails here with a clear message rather than later.
    await conn.run("INSTALL excel; LOAD excel");
  }
  const present = new Set(
    ((await (await conn.run(`DESCRIBE SELECT * FROM ${source}`)).getRows()) as [string, ...unknown[]][]).map((r) => r[0]),
  );
  for (const required of ["fieldNumber", "occurrenceRemarks"]) {
    if (!present.has(required)) throw new Error(`${opts.file}: no ${required} column`);
  }
  const col = (name: string) => (present.has(name) ? `nullif(trim("${name}"), '')` : "CAST(NULL AS VARCHAR)");

  await conn.run("BEGIN");
  try {
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE disp_row AS
      SELECT ordinality AS row_number,
             ${col("fieldNumber")} AS field_number,
             ${col("occurrenceRemarks")} AS remarks,
             ${col("recordedBy")} AS recorded_by,
             ${col("day")} AS day, ${col("month")} AS month, ${col("year")} AS year,
             ${col("sampleId")} AS sample_number, ${col("specimenId")} AS specimen_number,
             ${col("dateLabelPrint")} AS printed_raw
      FROM ${source} WITH ORDINALITY
      WHERE ${col("fieldNumber")} IS NOT NULL OR ${col("occurrenceRemarks")} IS NOT NULL`);
    await conn.run(`ALTER TABLE disp_row ADD COLUMN kind VARCHAR`);
    await conn.run(`UPDATE disp_row SET kind = ${KIND_SQL}`);

    // By number: the specimen a row's field number names, if exactly one does.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE disp_number AS
      SELECT r.row_number, any_value(sp.entity_id) AS specimen_id, count(*) AS n
      FROM disp_row r JOIN specimen sp ON sp.field_number = r.field_number
      GROUP BY r.row_number`);
    // By twin: for a row no specimen carries, the specimen of another row
    // with the same collector, date, sample and specimen number.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE disp_twin AS
      SELECT u.row_number, any_value(m.specimen_id) AS specimen_id, count(DISTINCT m.specimen_id) AS twins
      FROM disp_row u
      JOIN disp_row w ON w.row_number <> u.row_number
                     AND w.recorded_by = u.recorded_by AND w.day = u.day AND w.month = u.month AND w.year = u.year
                     AND w.sample_number = u.sample_number AND w.specimen_number = u.specimen_number
      JOIN disp_number m ON m.row_number = w.row_number AND m.n = 1
      -- A row with no number of its own names no label, so it can be
      -- nobody's twin (CodeRabbit on the first review).
      WHERE u.field_number IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM disp_number n WHERE n.row_number = u.row_number)
      GROUP BY u.row_number`);
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE disp_outcome AS
      SELECT r.row_number, r.field_number, r.kind, r.remarks, r.printed_raw,
             CASE WHEN n.n = 1 THEN 'matched'
                  WHEN n.n > 1 THEN 'ambiguous_number'
                  WHEN t.twins > 1 THEN 'ambiguous_twin'
                  WHEN t.twins = 1 AND r.kind = 'LOST SPECIMEN' THEN 'surplus_label'
                  WHEN t.twins = 1 THEN 'number_unknown'
                  ELSE 'no_specimen' END AS outcome,
             CASE WHEN n.n = 1 THEN n.specimen_id WHEN t.twins = 1 THEN t.specimen_id END AS specimen_id
      FROM disp_row r
      LEFT JOIN disp_number n ON n.row_number = r.row_number
      LEFT JOIN disp_twin t ON t.row_number = r.row_number`);
    // Two rows remarking differently on one specimen: nobody's reading wins.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE disp_conflict AS
      SELECT specimen_id FROM disp_outcome
      WHERE outcome = 'matched' AND remarks IS NOT NULL
      GROUP BY specimen_id HAVING count(DISTINCT remarks) > 1`);
    await conn.run(`
      UPDATE disp_outcome SET outcome = 'conflicting_remarks'
      WHERE specimen_id IN (SELECT specimen_id FROM disp_conflict)
        AND (outcome = 'surplus_label' OR (outcome = 'matched' AND remarks IS NOT NULL))`);

    // What each specimen is told: its own remark, as written, and a sentence
    // per surplus label. The print date is the old system's, repeated only
    // where it is after the bee was collected: a date before that is the
    // placeholder the old system wrote, not a day anything was printed.
    const printed = `coalesce(try_strptime(o.printed_raw, '%m/%d/%y'), try_strptime(o.printed_raw, '%d-%b-%y'),
                              try_strptime(o.printed_raw, '%Y-%m-%d'))::DATE`;
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE disp_final AS
      WITH own AS (
        SELECT specimen_id, any_value(remarks) AS remarks, any_value(kind) AS kind
        FROM disp_outcome WHERE outcome = 'matched' AND remarks IS NOT NULL GROUP BY specimen_id
      ), surplus AS (
        SELECT o.specimen_id,
               string_agg(concat('Another label numbered ', o.field_number, ' was printed for this specimen',
                                 CASE WHEN ${printed} IS NOT NULL AND ${printed} >= s.date_start
                                      THEN concat(' on ', strftime(${printed}, '%-d %B %Y')) ELSE '' END,
                                 '; no pin carries it, and the number is retired.'),
                          ' ' ORDER BY o.field_number) AS sentences
        FROM disp_outcome o
        JOIN specimen sp ON sp.entity_id = o.specimen_id
        JOIN sample s ON s.entity_id = sp.sample_id
        WHERE o.outcome = 'surplus_label'
        GROUP BY o.specimen_id
      )
      SELECT coalesce(w.specimen_id, x.specimen_id) AS specimen_id,
             CASE WHEN w.kind IN (${inList(MISSING_KINDS)}) THEN 'missing'
                  WHEN w.kind IN (${inList(PRESENT_KINDS)}) THEN 'in collection'
                  WHEN w.kind IS NULL AND x.specimen_id IS NOT NULL THEN 'in collection' END AS disposition,
             concat_ws(' ', w.remarks, x.sentences) AS remarks
      FROM own w FULL OUTER JOIN surplus x ON x.specimen_id = w.specimen_id`);

    const one = async (sql: string) => Number(((await (await conn.run(sql)).getRows()) as [[bigint | number]])[0]![0]);
    const unchanged = await one(`
      SELECT count(*) FROM disp_final f JOIN specimen_disposition d ON d.specimen_id = f.specimen_id
      WHERE d.remarks = f.remarks AND d.disposition IS NOT DISTINCT FROM f.disposition`);
    const updated = await one(`
      SELECT count(*) FROM disp_final f JOIN specimen_disposition d ON d.specimen_id = f.specimen_id
      WHERE d.remarks <> f.remarks OR d.disposition IS DISTINCT FROM f.disposition`);
    const inserted = await one(`
      SELECT count(*) FROM disp_final f WHERE NOT EXISTS (SELECT 1 FROM specimen_disposition d WHERE d.specimen_id = f.specimen_id)`);
    const stamp = `${sqlString(opts.statedBy.trim())}, DATE ${sqlString(opts.statedOn)}, ${sqlString(basename(opts.file))}`;
    if (!opts.dryRun) {
      await conn.run(`
        UPDATE specimen_disposition
        SET disposition = f.disposition, remarks = f.remarks, stated_by = ${sqlString(opts.statedBy.trim())},
            stated_on = DATE ${sqlString(opts.statedOn)}, source = ${sqlString(basename(opts.file))}, recorded_at = now()
        FROM disp_final f
        WHERE specimen_disposition.specimen_id = f.specimen_id
          AND (specimen_disposition.remarks <> f.remarks OR specimen_disposition.disposition IS DISTINCT FROM f.disposition)`);
      await conn.run(`
        INSERT INTO specimen_disposition (specimen_id, disposition, remarks, stated_by, stated_on, source)
        SELECT f.specimen_id, f.disposition, f.remarks, ${stamp}
        FROM disp_final f
        WHERE NOT EXISTS (SELECT 1 FROM specimen_disposition d WHERE d.specimen_id = f.specimen_id)`);
    }

    const heldRows = (await (
      await conn.run(`
        SELECT row_number, field_number, kind, outcome, remarks FROM disp_outcome
        WHERE outcome IN (${inList([...HELD_REASONS])}) AND NOT (outcome = 'no_specimen' AND remarks IS NULL)
        ORDER BY row_number`)
    ).getRows()) as [bigint, string | null, string | null, HeldReason, string | null][];
    const held = Object.fromEntries(HELD_REASONS.map((r) => [r, 0])) as Record<HeldReason, number>;
    for (const r of heldRows) held[r[3]] += 1;
    const byKind = (
      (await (
        await conn.run(`
          SELECT kind, count(*),
                 count(*) FILTER (WHERE outcome = 'matched'),
                 count(*) FILTER (WHERE outcome = 'surplus_label'),
                 count(*) FILTER (WHERE outcome IN (${inList([...HELD_REASONS])}) AND NOT (outcome = 'no_specimen' AND remarks IS NULL))
          FROM disp_outcome GROUP BY kind ORDER BY count(*) DESC, kind`)
      ).getRows()) as [string | null, bigint, bigint, bigint, bigint][]
    ).map(([kind, rows, matched, surplus, heldN]) => ({
      kind,
      rows: Number(rows),
      matched: Number(matched),
      surplus: Number(surplus),
      held: Number(heldN),
    }));
    const result: DispositionLoadResult = {
      file: opts.file,
      rows: await one("SELECT count(*) FROM disp_row"),
      remarked: await one("SELECT count(*) FROM disp_row WHERE remarks IS NOT NULL"),
      matched: await one("SELECT count(*) FROM disp_outcome WHERE outcome = 'matched'"),
      surplusLabels: await one("SELECT count(*) FROM disp_outcome WHERE outcome = 'surplus_label'"),
      specimens: { written: inserted + updated + unchanged, inserted, updated, unchanged },
      held,
      byKind,
      heldPath,
    };
    await conn.run(opts.dryRun ? "ROLLBACK" : "COMMIT");
    const heldCsv = [
      HELD_COLUMNS.join(","),
      ...heldRows.map((r) => [Number(r[0]), r[1], r[2], r[3], r[4]].map(csvCell).join(",")),
    ].join("\n");
    await writeFile(heldPath, `${heldCsv}\n`);
    return result;
  } catch (err) {
    await conn.run("ROLLBACK").catch(() => {});
    throw err;
  }
}

// CLI: pnpm disposition:load <file> [db] --by "<name>" --on <YYYY-MM-DD> [--sheet <name>] [--held <path>] [--dry-run]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const valued = ["--by", "--on", "--sheet", "--held"];
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1] ?? ""));
  const file = positional[0];
  if (file === undefined) {
    console.error("usage: pnpm disposition:load <file> [db] --by <name> --on <YYYY-MM-DD> [--sheet <name>] [--held <path>] [--dry-run]");
    process.exit(2);
  }
  const { openDuckDb } = await import("./db.js");
  const instance = await openDuckDb(positional[1] ?? process.env.BEELINE_DB ?? DEFAULT_DB);
  const conn = await instance.connect();
  try {
    const result = await loadDispositions(conn, {
      file,
      sheet: option("--sheet"),
      statedBy: option("--by") ?? "",
      statedOn: option("--on") ?? "",
      heldPath: option("--held"),
      dryRun: args.includes("--dry-run"),
    });
    await conn.run("CHECKPOINT");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    conn.closeSync();
  }
}
