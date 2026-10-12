import type { DuckDBConnection } from "@duckdb/node-api";
import { rm } from "node:fs/promises";
import { openMemoryDuckDb } from "./db.js";

/**
 * A consistent copy of a store, taken from inside the process that owns it
 * (ADR 0005: nothing else may open the file, so a backup cannot be a file
 * copy made from outside, and a file copy made from inside would race the
 * app's own writers). The copy is an ordinary DuckDB file the app can open
 * as it is: restoring is putting it back where the store was.
 *
 * Not `COPY FROM DATABASE … TO …`, which is the one-line version and cannot
 * copy this schema: DuckDB 1.5.5 inserts the tables' rows in name order, so a
 * table is filled before the table its foreign key names, and the copy stops
 * at the first one (`sample_collector` before `sample`, every time). So the
 * schema is copied by `COPY FROM DATABASE … (SCHEMA)` — which carries the
 * tables, constraints, indexes, comments, views, macros and the sequences
 * at their current values, so a restored store does not hand out an
 * `entity_id` it has already used — and the rows are inserted here, each
 * table after every table it refers to.
 *
 * A table that refers to itself (`animal.parent_id`) cannot be filled by one
 * INSERT even in the right order, because DuckDB checks the reference against
 * what is stored before the statement rather than what the statement has
 * already inserted. It is filled a level at a time: the rows whose parent is
 * already in the copy, until none are left.
 *
 * The whole copy is one transaction on the connection doing it, which is what
 * makes it consistent: every table is read as of the same moment however long
 * the copy takes, while the app goes on writing to the store. One store per
 * transaction, because DuckDB lets a transaction write to only one attached
 * database; the private store's copy is therefore a moment later than the
 * main store's, which costs nothing, since no reference crosses between them.
 */

const quoteIdent = (s: string) => `"${s.replaceAll('"', '""')}"`;
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

async function rowsOf(conn: DuckDBConnection, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  return (await (await conn.run(sql, params as never)).getRows()) as unknown[][];
}

/** Row counts by table, keyed `schema.table`. */
export type TableCounts = Record<string, number>;

/**
 * What a catalog holds besides rows, counted: the parts of a schema a copy
 * could lose without a single row going missing. All of them come across in
 * DuckDB 1.5.5 (compared against the real schema, every count equal). They
 * are compared on every copy, so a DuckDB upgrade that stops carrying one
 * is found on the night it is deployed, not at a restore.
 */
export interface CatalogShape {
  constraints: number;
  indexes: number;
  views: number;
  macros: number;
  sequences: number;
  comments: number;
}

/** What a copy is checked against. */
export interface Snapshot {
  tables: TableCounts;
  shape: CatalogShape;
}

interface Reference {
  table: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

/** The base tables of a catalog, keyed `schema.table`. */
async function tablesOf(conn: DuckDBConnection, catalog: string): Promise<string[]> {
  const found = await rowsOf(
    conn,
    `SELECT schema_name, table_name FROM duckdb_tables()
      WHERE database_name = $1 AND NOT temporary ORDER BY schema_name, table_name`,
    [catalog],
  );
  return found.map(([schema, table]) => `${schema as string}.${table as string}`);
}

async function referencesOf(conn: DuckDBConnection, catalog: string): Promise<Reference[]> {
  const found = await rowsOf(
    conn,
    `SELECT schema_name, table_name, constraint_column_names, referenced_table, referenced_column_names
       FROM duckdb_constraints()
      WHERE database_name = $1 AND constraint_type = 'FOREIGN KEY'`,
    [catalog],
  );
  // A foreign key names its table without a schema, and DuckDB allows it only
  // within one schema, so the referenced table is in the referring one's.
  return found.map(([schema, table, columns, referenced, referencedColumns]) => ({
    table: `${schema as string}.${table as string}`,
    columns: (columns as { items: string[] }).items,
    referencedTable: `${schema as string}.${referenced as string}`,
    referencedColumns: (referencedColumns as { items: string[] }).items,
  }));
}

async function shapeOf(conn: DuckDBConnection, catalog: string): Promise<CatalogShape> {
  const count = async (sql: string) => {
    const [[n]] = (await rowsOf(conn, sql, [catalog])) as [[bigint]];
    return Number(n);
  };
  return {
    constraints: await count(`SELECT count(*) FROM duckdb_constraints() WHERE database_name = $1`),
    indexes: await count(`SELECT count(*) FROM duckdb_indexes() WHERE database_name = $1`),
    views: await count(`SELECT count(*) FROM duckdb_views() WHERE database_name = $1 AND NOT internal`),
    macros: await count(
      `SELECT count(*) FROM duckdb_functions()
        WHERE database_name = $1 AND function_type IN ('macro', 'table_macro') AND NOT internal`,
    ),
    sequences: await count(`SELECT count(*) FROM duckdb_sequences() WHERE database_name = $1`),
    comments: await count(
      `SELECT (SELECT count(*) FROM duckdb_tables() WHERE database_name = $1 AND comment IS NOT NULL)
            + (SELECT count(*) FROM duckdb_columns() WHERE database_name = $1 AND comment IS NOT NULL)
            + (SELECT count(*) FROM duckdb_views() WHERE database_name = $1 AND NOT internal AND comment IS NOT NULL)`,
    ),
  };
}

/** Every table after every other table it refers to; a reference to itself does not count. */
export function fillOrder(tables: string[], references: Reference[]): string[] {
  const needs = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const r of references) {
    if (r.table !== r.referencedTable) needs.get(r.table)?.add(r.referencedTable);
  }
  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < tables.length) {
    const ready = tables.filter((t) => !placed.has(t) && [...needs.get(t)!].every((n) => placed.has(n)));
    if (ready.length === 0) {
      const stuck = tables.filter((t) => !placed.has(t));
      throw new Error(`foreign keys form a cycle among ${stuck.join(", ")}: no order fills them`);
    }
    for (const t of ready) {
      order.push(t);
      placed.add(t);
    }
  }
  return order;
}

const qualified = (catalog: string, table: string) => {
  const [schema, name] = table.split(".") as [string, string];
  return `${quoteIdent(catalog)}.${quoteIdent(schema)}.${quoteIdent(name)}`;
};

const changed = (rows: unknown[][]) => Number(rows[0]?.[0] ?? 0);

/**
 * Copy one attached catalog into another, empty one, in one transaction.
 * Returns the row count of every table as the copy read it, and the
 * source's shape.
 */
export async function copyCatalog(conn: DuckDBConnection, from: string, to: string): Promise<Snapshot> {
  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run(`COPY FROM DATABASE ${quoteIdent(from)} TO ${quoteIdent(to)} (SCHEMA)`);
    const tables = await tablesOf(conn, from);
    const references = await referencesOf(conn, from);
    const counts: TableCounts = {};
    for (const table of fillOrder(tables, references)) {
      const source = qualified(from, table);
      const target = qualified(to, table);
      const selfs = references.filter((r) => r.table === table && r.referencedTable === table);
      if (selfs.length === 0) {
        await conn.run(`INSERT INTO ${target} SELECT * FROM ${source}`);
      } else {
        // A level at a time. "Not copied yet" is judged on the referenced key,
        // which a foreign key requires to be unique.
        const key = selfs[0]!.referencedColumns;
        const notCopied = `NOT EXISTS (SELECT 1 FROM ${target} d WHERE ${key
          .map((k) => `d.${quoteIdent(k)} = s.${quoteIdent(k)}`)
          .join(" AND ")})`;
        const parentCopied = selfs
          .map(
            (r) =>
              `((${r.columns.map((c) => `s.${quoteIdent(c)} IS NULL`).join(" OR ")}) OR EXISTS (SELECT 1 FROM ${target} p WHERE ${r.columns
                .map((c, i) => `p.${quoteIdent(r.referencedColumns[i]!)} = s.${quoteIdent(c)}`)
                .join(" AND ")}))`,
          )
          .join(" AND ");
        while (changed(await rowsOf(conn, `INSERT INTO ${target} SELECT s.* FROM ${source} s WHERE ${notCopied} AND ${parentCopied}`)) > 0);
      }
      const [[read]] = (await rowsOf(conn, `SELECT count(*) FROM ${source}`)) as [[bigint]];
      const [[written]] = (await rowsOf(conn, `SELECT count(*) FROM ${target}`)) as [[bigint]];
      if (read !== written) {
        throw new Error(`${table}: ${written} of ${read} rows copied (a reference to a row that is not there?)`);
      }
      counts[table] = Number(read);
    }
    const shape = await shapeOf(conn, from);
    await conn.run("COMMIT");
    return { tables: counts, shape };
  } catch (err) {
    await conn.run("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

/**
 * Copy a catalog of this instance into a new file at `path`, encrypted with
 * `key` when one is given. Whatever was at the path is replaced; the copy is
 * detached afterwards, so nothing else in the process can see it.
 */
export async function snapshotCatalog(
  conn: DuckDBConnection,
  catalog: string,
  path: string,
  key: string | null,
): Promise<Snapshot> {
  const alias = `backup_${catalog.replace(/\W/g, "_")}`;
  await conn.run(`DETACH DATABASE IF EXISTS ${quoteIdent(alias)}`);
  await rm(path, { force: true });
  await rm(`${path}.wal`, { force: true });
  const options = key === null ? "" : ` (ENCRYPTION_KEY ${quote(key)})`;
  await conn.run(`ATTACH ${quote(path)} AS ${quoteIdent(alias)}${options}`);
  try {
    return await copyCatalog(conn, catalog, alias);
  } finally {
    // Detaching checkpoints the copy into its file, so what is on disk
    // afterwards is the whole of it, with no WAL beside it.
    await conn.run(`DETACH DATABASE IF EXISTS ${quoteIdent(alias)}`);
  }
}

/**
 * Open a copy afresh, the way a restore would, and count its tables and
 * the rest of its schema against what the copy said it wrote. On an
 * instance of its own, so it shares nothing with the store it was copied
 * from: a copy that only opens inside the process that wrote it would be no
 * backup.
 */
export async function verifySnapshot(path: string, key: string | null, expected: Snapshot): Promise<void> {
  const instance = await openMemoryDuckDb();
  const conn = await instance.connect();
  try {
    const options = [`READ_ONLY`, ...(key === null ? [] : [`ENCRYPTION_KEY ${quote(key)}`])].join(", ");
    await conn.run(`ATTACH ${quote(path)} AS copy (${options})`);
    const tables = await tablesOf(conn, "copy");
    const missing = Object.keys(expected.tables).filter((t) => !tables.includes(t));
    const extra = tables.filter((t) => !(t in expected.tables));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `${path} does not hold the tables copied into it` +
          (missing.length > 0 ? `; missing ${missing.join(", ")}` : "") +
          (extra.length > 0 ? `; unexpected ${extra.join(", ")}` : ""),
      );
    }
    for (const table of tables) {
      const [[n]] = (await rowsOf(conn, `SELECT count(*) FROM ${qualified("copy", table)}`)) as [[bigint]];
      if (Number(n) !== expected.tables[table]) {
        throw new Error(`${path}: ${table} holds ${n} rows, ${expected.tables[table]} were copied`);
      }
    }
    const shape = await shapeOf(conn, "copy");
    const lost = (Object.keys(shape) as (keyof CatalogShape)[]).filter((k) => shape[k] !== expected.shape[k]);
    if (lost.length > 0) {
      throw new Error(
        `${path} does not hold the schema it was copied from: ` +
          lost.map((k) => `${shape[k]} ${k} where the store has ${expected.shape[k]}`).join(", "),
      );
    }
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
