/**
 * `tsx bench/postgres/load.ts <store.duckdb> <postgres-url> [database]`
 *
 * Copies a DuckDB store into a fresh Postgres database with the ported schema
 * (src/postgres-port.ts), so the two engines can be asked the same questions
 * of the same rows. The database (default `beeline_spike`) is dropped and
 * recreated. The store must already match schema/*.sql (`pnpm db:migrate`).
 *
 * Each table goes through a CSV file in a temporary directory: DuckDB writes
 * it, Postgres reads it with a server-side COPY, so the server has to be on
 * this machine. Foreign keys are not checked during the load (they are
 * triggers in Postgres, off under `session_replication_role = replica`), so
 * tables load in any order; the store already satisfied them.
 */
import pg from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { applyPortedSchema } from "../../src/check-postgres.js";
import { args } from "../lib.js";

const { positional, flags } = args(process.argv.slice(2));
const [storePath, url, database = "beeline_spike"] = positional;
if (!storePath || !url) {
  console.error("usage: tsx bench/postgres/load.ts <store.duckdb> <postgres-url> [database] [--materialize=view,…]");
  process.exit(2);
}
// Views to create as materialized views instead, refreshed after the load
// and indexed on every …_id column: the experiment of storing a derived
// view's rows rather than computing them on every read.
const materialize = (flags.materialize ?? "").split(",").filter(Boolean);

const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${database}`);
await admin.query(`CREATE DATABASE ${database}`);
await admin.end();

const target = new URL(url);
target.pathname = `/${database}`;
const client = new pg.Client({ connectionString: target.toString() });
await client.connect();
const failure = await applyPortedSchema(client, (_file, sql) =>
  materialize.reduce(
    (text, view) =>
      text
        .replaceAll(`CREATE VIEW ${view} AS`, `CREATE MATERIALIZED VIEW ${view} AS`)
        .replaceAll(`COMMENT ON VIEW ${view} IS`, `COMMENT ON MATERIALIZED VIEW ${view} IS`),
    sql,
  ),
);
if (failure) throw new Error(`${failure.file}: ${failure.message}\n${failure.context ?? ""}`);
await client.query("SET search_path = public");

const instance = await DuckDBInstance.create(storePath, { access_mode: "READ_ONLY" });
const duck = await instance.connect();
const columns = (
  await duck.runAndReadAll(`
    SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t USING (table_catalog, table_schema, table_name)
    WHERE t.table_type = 'BASE TABLE' AND c.table_schema = 'main'
    ORDER BY c.table_name, c.ordinal_position`)
).getRowObjectsJS() as { table_name: string; column_name: string; data_type: string }[];

const tables = new Map<string, { column_name: string; data_type: string }[]>();
for (const c of columns) tables.set(c.table_name, [...(tables.get(c.table_name) ?? []), c]);

const dir = await mkdtemp(join(tmpdir(), "beeline-pg-load-"));
// Staging tables are made by ingestion (ingest/*.sql), not the schema, so
// they are created here with their columns and types and no constraints.
// Their names are folded to lower case, as unquoted DDL would fold them:
// DuckDB matches `r.firstName` to a column `firstName` in any case, and
// Postgres only if the column is `firstname`.
const pgType = (t: string): string =>
  t
    .replace(/^VARCHAR$/, "text")
    .replace(/^DOUBLE$/, "double precision")
    .replace(/^JSON$/, "jsonb")
    .replace(/^TIMESTAMP WITH TIME ZONE$/, "timestamptz")
    .replace(/^HUGEINT$/, "numeric")
    .replace(/^UBIGINT$/, "numeric")
    .replace(/^VARCHAR\[\]$/, "text[]");
const existing = new Set(
  (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map(
    (r) => r.table_name as string,
  ),
);
for (const [table, cols] of tables) {
  if (existing.has(table)) continue;
  await client.query(
    `CREATE TABLE "${table}" (${cols.map((c) => `"${c.column_name.toLowerCase()}" ${pgType(c.data_type)}`).join(", ")})`,
  );
  console.log(`created staging table ${table}`);
}

// The schema seeds some tables (ranks, QC rules, castes); the store's rows replace them.
await client.query(`TRUNCATE ${[...tables.keys()].map((t) => `"${t}"`).join(", ")}`);
await client.query("SET session_replication_role = replica");
let total = 0;
for (const [table, cols] of tables) {
  const started = performance.now();
  // A list is written `[1, 2]` and Postgres reads arrays as `{1,2}`. Numbers
  // need no quoting inside the braces; a list of text would, and none exists.
  const select = cols
    .map(({ column_name: c, data_type: t }) => {
      if (!t.endsWith("[]")) return `"${c}"`;
      if (!/^(TINYINT|SMALLINT|INTEGER|BIGINT|DOUBLE|FLOAT)\[\]$/.test(t)) {
        throw new Error(`${table}.${c} is ${t}; only lists of numbers are written as Postgres arrays`);
      }
      return `CASE WHEN "${c}" IS NULL THEN NULL ELSE concat('{', array_to_string("${c}", ','), '}') END AS "${c}"`;
    })
    .join(", ");
  const file = join(dir, `${table}.csv`);
  await duck.run(`COPY (SELECT ${select} FROM "${table}") TO '${file}' (HEADER, FORCE_QUOTE *)`);
  // FORCE_QUOTE writes every non-NULL value quoted, so '' stays an empty
  // string and only an unquoted empty field reads as NULL.
  const list = cols.map((c) => `"${existing.has(table) ? c.column_name : c.column_name.toLowerCase()}"`).join(", ");
  const result = await client.query(`COPY "${table}" (${list}) FROM '${file}' WITH (FORMAT csv, HEADER true)`);
  total += result.rowCount ?? 0;
  console.log(`${table.padEnd(40)} ${String(result.rowCount).padStart(9)} rows  ${Math.round(performance.now() - started)} ms`);
}
await client.query("SET session_replication_role = origin");

const max = (await duck.runAndReadAll("SELECT currval('entity_id_seq') AS v")).getRowObjectsJS()[0]?.v;
if (max != null) await client.query("SELECT setval('entity_id_seq', $1)", [String(max)]);
// Postgres indexes no foreign key by itself; DuckDB needed none.
const fkIndexes = await client.query(`
  SELECT format('CREATE INDEX ON %I (%s)', c.conrelid::regclass, string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)) AS ddl
  FROM pg_constraint c
  CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
    AND NOT EXISTS (SELECT 1 FROM pg_index i
                    WHERE i.indrelid = c.conrelid
                      AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey)
  GROUP BY c.oid, c.conrelid`);
for (const { ddl } of fkIndexes.rows as { ddl: string }[]) await client.query(ddl);
console.log(`${fkIndexes.rowCount} foreign-key indexes`);
await client.query("ANALYZE");
for (const view of materialize) {
  const started = performance.now();
  await client.query(`REFRESH MATERIALIZED VIEW ${view}`);
  const refreshed = performance.now() - started;
  const cols = await client.query(
    "SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND attname LIKE '%\\_id'",
    [view],
  );
  for (const { attname } of cols.rows as { attname: string }[]) await client.query(`CREATE INDEX ON ${view} (${attname})`);
  console.log(`materialized ${view}: refresh ${Math.round(refreshed)} ms, indexed on ${cols.rowCount} columns`);
}
await client.query("ANALYZE");
console.log(`${total} rows in ${tables.size} tables`);

duck.closeSync();
instance.closeSync();
await client.end();
await rm(dir, { recursive: true, force: true });
