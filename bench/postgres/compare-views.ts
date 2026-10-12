/**
 * `tsx bench/postgres/compare-views.ts <store.duckdb> <postgres-url> [view…]`
 *
 * Asks both engines for every view in the schema, over the same rows (loaded
 * by bench/postgres/load.ts), and reports whether they answer the same rows
 * and how long each took. The port is only faithful if the answers agree:
 * a rewrite that applies but means something else is the failure ADR 0001
 * fears most, and only data can show it.
 *
 * Rows are compared as multisets of canonical strings, every value rendered
 * the way both drivers can be made to agree on: text as is, numbers through
 * JavaScript's own formatting, booleans as true/false, lists as JSON, and
 * timestamps in UTC.
 */
import pg from "pg";
import { DuckDBInstance } from "@duckdb/node-api";

const [storePath, url, ...only] = process.argv.slice(2);
if (!storePath || !url) {
  console.error("usage: tsx bench/postgres/compare-views.ts <store.duckdb> <postgres-url> [view…]");
  process.exit(2);
}

// Every Postgres value as its text form; canonicalised below.
for (const oid of Object.values(pg.types.builtins)) pg.types.setTypeParser(oid as number, (v: string) => v);
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("SET TimeZone = 'UTC'");

const instance = await DuckDBInstance.create(storePath, { access_mode: "READ_ONLY" });
const duck = await instance.connect();
await duck.run("SET TimeZone = 'UTC'");

const views = (
  await duck.runAndReadAll(
    "SELECT view_name FROM duckdb_views() WHERE NOT internal AND schema_name = 'main' AND database_name = current_database() ORDER BY view_name",
  )
).getRowObjectsJS().map((r) => r.view_name as string);

function canonDuck(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return JSON.stringify(v.map(canonDuck));
  if (typeof v === "string") return timestampish(v);
  return JSON.stringify(v);
}

function canonPg(v: unknown, type: number): string {
  if (v === null || v === undefined) return "∅";
  const s = String(v);
  switch (type) {
    case pg.types.builtins.BOOL:
      return s === "t" ? "true" : "false";
    case pg.types.builtins.INT2:
    case pg.types.builtins.INT4:
    case pg.types.builtins.INT8:
    case pg.types.builtins.FLOAT4:
    case pg.types.builtins.FLOAT8:
    case pg.types.builtins.NUMERIC:
      return String(Number(s));
    case pg.types.builtins.JSONB:
    case pg.types.builtins.JSON:
      return canonJson(s);
    default:
      if (s.startsWith("{") && s.endsWith("}") && type !== pg.types.builtins.TEXT) {
        const inner = s.slice(1, -1);
        const items = inner === "" ? [] : inner.split(",").map((x) => x.replace(/^"(.*)"$/, "$1"));
        return JSON.stringify(items.map((x) => (x === "NULL" ? "∅" : /^-?\d+(\.\d+)?$/.test(x) ? String(Number(x)) : x)));
      }
      return timestampish(s);
  }
}

/** '2026-09-01 12:00:00+00' and '2026-09-01 12:00:00' both → one form. */
function timestampish(s: string): string {
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d(?:\.\d+)?)(?:\+00(?::00)?|Z)?$/.exec(s);
  // Fractions to the millisecond, the precision a JavaScript Date carries.
  if (!m) return s;
  const [hms, frac = ""] = m[2]!.split(".");
  const ms = frac.slice(0, 3).replace(/0+$/, "");
  return `${m[1]} ${hms}${ms ? `.${ms}` : ""}`;
}

interface Result {
  view: string;
  duckMs: number;
  pgMs: number;
  duckRows: number;
  pgRows: number;
  onlyDuck: string[];
  onlyPg: string[];
  error?: string;
}

// Views the ingest scripts create live in the store but not in the schema.
const pgViews = new Set(
  (await client.query("SELECT table_name FROM information_schema.views WHERE table_schema = 'public'")).rows.map(
    (r) => (r as string[])[0] ?? (r as { table_name: string }).table_name,
  ),
);

const results: Result[] = [];
for (const view of views) {
  if (only.length && !only.includes(view)) continue;
  if (!pgViews.has(view)) continue;
  try {
    let t = performance.now();
    const d = await duck.runAndReadAll(`SELECT * FROM "${view}"`);
    const duckMs = performance.now() - t;
    // The JSON row form renders BIGINT/HUGEINT as strings; JS gives lists as arrays.

    const dRows = d.getRowsJS().map((row) => row.map((v) => (typeof v === "bigint" ? String(Number(v)) : v)));
    const duckSet = dRows.map((row) => row.map((v, k) => canonDuckTyped(v, d.columnType(k).toString())).join("|"));

    t = performance.now();
    const p = await client.query({ text: `SELECT * FROM "${view}"`, rowMode: "array" });
    const pgMs = performance.now() - t;
    const pgSet = (p.rows as unknown[][]).map((row) => row.map((v, k) => canonPg(v, p.fields[k]!.dataTypeID)).join("|"));

    const counts = new Map<string, number>();
    for (const r of duckSet) counts.set(r, (counts.get(r) ?? 0) + 1);
    const onlyPg: string[] = [];
    for (const r of pgSet) {
      const n = counts.get(r) ?? 0;
      if (n > 0) counts.set(r, n - 1);
      else onlyPg.push(r);
    }
    const onlyDuck = [...counts].flatMap(([r, n]) => Array<string>(n).fill(r));
    results.push({ view, duckMs, pgMs, duckRows: duckSet.length, pgRows: pgSet.length, onlyDuck, onlyPg });

  } catch (err) {
    results.push({ view, duckMs: 0, pgMs: 0, duckRows: 0, pgRows: 0, onlyDuck: [], onlyPg: [], error: (err as Error).message });
  }
  const r = results[results.length - 1]!;
  const verdict = r.error ? `ERROR ${r.error.split("\n")[0]}` : r.onlyDuck.length + r.onlyPg.length === 0 ? "same" : `DIFFER (${r.onlyDuck.length} only in DuckDB, ${r.onlyPg.length} only in Postgres)`;
  console.log(
    `${view.padEnd(46)} ${String(r.duckRows).padStart(7)} rows  duckdb ${fmt(r.duckMs)}  postgres ${fmt(r.pgMs)}  ${verdict}`,
  );
  if (!r.error && r.onlyDuck.length + r.onlyPg.length > 0) {
    for (const x of r.onlyDuck.slice(0, 2)) console.log(`    duckdb:   ${x.slice(0, 220)}`);
    for (const x of r.onlyPg.slice(0, 2)) console.log(`    postgres: ${x.slice(0, 220)}`);
  }
}

function canonDuckTyped(v: unknown, type: string): string {
  if (v instanceof Date) {
    const iso = v.toISOString();
    return type === "DATE" ? iso.slice(0, 10) : timestampish(iso.replace("T", " ").replace(/Z$/, ""));
  }
  if (type === "JSON" && typeof v === "string") return canonJson(v);
  if (v !== null && typeof v === "object" && !Array.isArray(v) && "items" in (v as object)) {
    return canonDuck((v as { items: unknown[] }).items);
  }
  return canonDuck(v);
}

/** JSON with its keys sorted, since jsonb stores keys in its own order. */
function canonJson(text: string): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sort(x)]))
        : v;
  return JSON.stringify(sort(JSON.parse(text)));
}

function fmt(ms: number): string {
  return `${ms.toFixed(0).padStart(6)} ms`;
}

const differ = results.filter((r) => r.error || r.onlyDuck.length + r.onlyPg.length > 0);
console.log(`\n${results.length} views, ${results.length - differ.length} the same, ${differ.length} differ or fail`);
duck.closeSync();
instance.closeSync();
await client.end();
