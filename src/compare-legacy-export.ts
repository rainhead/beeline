import type { DuckDBConnection } from "@duckdb/node-api";
import { pathToFileURL } from "node:url";
import { openDuckDb } from "./db.js";
import { LEGACY_EXPORT_COLUMNS, writeLegacyExport } from "./legacy-export.js";

/**
 * How far the legacy-format export is from what the legacy system itself
 * held (beeline-6q8): its done-test, and the thing to read before telling
 * anybody downstream that the file is ready.
 *
 * Rows are matched on fieldNumber — the identity printed on the pin, and the
 * key Andony's comparison joins on — counting only numbers that occur once on
 * each side, since a number the legacy file holds twice cannot be matched
 * honestly to either row. For every matched pair, each of the 63 columns is
 * compared as text and each difference counted, split by season as every
 * check in this repo is (CLAUDE.md): the open season against the settled
 * ones, on the record's own collecting date, using the store's own line
 * (`season.started_on`). A difference is not a defect by itself — Beeline
 * normalises Roman-numeral months, corrects names and families, and follows
 * staff edits — so the report names each column's commonest pairs to say
 * which kind it is.
 */

export interface ColumnDifference {
  column: string;
  open: number;
  settled: number;
  /** The commonest (exported, legacy) pairs, to say what kind of difference it is. */
  examples: { exported: string; legacy: string; n: number }[];
}

export interface ExportComparison {
  exported: number;
  legacy: number;
  matched: { open: number; settled: number };
  onlyExported: number;
  onlyLegacy: number;
  /** Numbers held more than once on either side, left out of the match. */
  duplicated: number;
  columns: ColumnDifference[];
}

/**
 * Compare the export at `exportPath` against the store's staged
 * legacy_occurrence. Values that could identify a person never appear in the
 * examples for the columns that name one; counts say enough there.
 */
export async function compareLegacyExport(conn: DuckDBConnection, exportPath: string): Promise<ExportComparison> {
  const q = (s: string) => s.replaceAll("'", "''");
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE cmp_export AS
    SELECT * FROM read_csv('${q(exportPath)}', header = true, all_varchar = true, quote = '"', escape = '"')`);
  // Staging keeps the columns load-legacy chose (STAGING_COLUMNS), which
  // predate coordinateSource; a column it lacks is compared as blank.
  const stagedColumns = new Set(
    ((await (await conn.run(`SELECT column_name FROM duckdb_columns() WHERE table_name = 'legacy_occurrence'`)).getRows()) as [string][]).map(
      ([c]) => c,
    ),
  );
  const legacyValue = (c: string) => (stagedColumns.has(c) ? `coalesce(l."${c}", '')` : "''");
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE cmp_pairs AS
    WITH e AS (SELECT * FROM cmp_export WHERE "fieldNumber" IN (
               SELECT "fieldNumber" FROM cmp_export GROUP BY 1 HAVING count(*) = 1)),
         l AS (SELECT * FROM legacy_occurrence WHERE "fieldNumber" IN (
               SELECT "fieldNumber" FROM legacy_occurrence WHERE nullif("fieldNumber", '') IS NOT NULL
               GROUP BY 1 HAVING count(*) = 1))
    SELECT ${LEGACY_EXPORT_COLUMNS.map((c) => `coalesce(e."${c}", '') AS "e_${c}", ${legacyValue(c)} AS "l_${c}"`).join(", ")},
           try_cast(concat(e."year", '-', e."month", '-', e."day") AS DATE) >= (SELECT started_on FROM season) AS open_season
    FROM e JOIN l ON l."fieldNumber" = e."fieldNumber"`);
  const one = async (sql: string) => Number(((await (await conn.run(sql)).getRows()) as [[bigint]])[0]![0]);
  const exported = await one("SELECT count(*) FROM cmp_export");
  const legacy = await one("SELECT count(*) FROM legacy_occurrence");
  const open = await one("SELECT count(*) FROM cmp_pairs WHERE open_season");
  const settled = await one("SELECT count(*) FROM cmp_pairs WHERE NOT coalesce(open_season, false)");
  const onlyExported = await one(`SELECT count(*) FROM cmp_export e WHERE NOT EXISTS
                                    (SELECT 1 FROM legacy_occurrence l WHERE l."fieldNumber" = e."fieldNumber")`);
  const onlyLegacy = await one(`SELECT count(*) FROM legacy_occurrence l WHERE nullif(l."fieldNumber", '') IS NOT NULL
                                  AND NOT EXISTS (SELECT 1 FROM cmp_export e WHERE e."fieldNumber" = l."fieldNumber")`);
  const duplicated = await one(`SELECT count(*) FROM (
      SELECT "fieldNumber" FROM cmp_export GROUP BY 1 HAVING count(*) > 1
      UNION SELECT "fieldNumber" FROM legacy_occurrence WHERE nullif("fieldNumber", '') IS NOT NULL
      GROUP BY 1 HAVING count(*) > 1)`);

  // Columns whose values are a person's name, login, id or a coordinate:
  // counted, never quoted, so the report can be pasted anywhere.
  const identifying = new Set([
    "userId", "userLogin", "firstName", "firstNameInitial", "lastName", "recordedBy", "identifiedBy",
    "decimalLatitude", "decimalLongitude", "locality", "url", "relatedResourceID",
  ]);
  const columns: ColumnDifference[] = [];
  for (const c of LEGACY_EXPORT_COLUMNS) {
    const differ = `"e_${c}" IS DISTINCT FROM "l_${c}"`;
    const counts = (await (await conn.run(`SELECT count(*) FILTER (WHERE ${differ} AND open_season),
                                                   count(*) FILTER (WHERE ${differ} AND NOT coalesce(open_season, false))
                                            FROM cmp_pairs`)).getRows()) as [[bigint, bigint]];
    const [o, s] = counts[0]!.map(Number) as [number, number];
    if (o + s === 0) continue;
    const examples = identifying.has(c)
      ? []
      : (((await (await conn.run(`SELECT "e_${c}", "l_${c}", count(*) FROM cmp_pairs WHERE ${differ}
                                     GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 3`)).getRows()) as [string, string, bigint][]).map(
          ([exported, legacy, n]) => ({ exported, legacy, n: Number(n) }),
        ));
    columns.push({ column: c, open: o, settled: s, examples });
  }
  columns.sort((a, b) => b.open + b.settled - (a.open + a.settled));
  return { exported, legacy, matched: { open, settled }, onlyExported, onlyLegacy, duplicated, columns };
}

// CLI: pnpm legacy:compare-export [db] [export.csv]
// With no export path, writes a fresh export to data/exports/ first.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? process.env.BEELINE_DB ?? "beeline.duckdb";
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  let exportPath = process.argv[3];
  if (exportPath === undefined) {
    // Inside data/, which git ignores: the file is every collector's name and
    // true coordinates, and the repository is public (Fable's review of #110).
    exportPath = "data/exports/compare-legacy-export.csv";
    const { rows } = await writeLegacyExport(conn, exportPath);
    console.error(`wrote ${rows} rows to ${exportPath}`);
  }
  const r = await compareLegacyExport(conn, exportPath);
  conn.closeSync();
  console.log(`exported ${r.exported} rows; legacy held ${r.legacy}`);
  console.log(`matched on fieldNumber: ${r.matched.open} open season, ${r.matched.settled} settled`);
  console.log(`only in the export: ${r.onlyExported}; only in legacy: ${r.onlyLegacy}; numbers held twice, left out: ${r.duplicated}`);
  console.log("\ncolumn differences (open / settled), commonest pairs as exported ← legacy:");
  for (const c of r.columns) {
    const eg = c.examples.map((e) => `'${e.exported}' ← '${e.legacy}' ×${e.n}`).join("; ");
    console.log(`  ${c.column.padEnd(30)} ${String(c.open).padStart(7)} / ${String(c.settled).padStart(7)}  ${eg}`);
  }
}
