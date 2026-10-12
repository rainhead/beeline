/**
 * `tsx bench/postgres/explain.ts <pages.json> <postgres-url> <query-prefix> [--page=name]`
 *
 * EXPLAIN ANALYZE, on Postgres, one query that bench/postgres/pages.ts
 * recorded: the first whose text starts with the prefix (whitespace
 * collapsed), on the named page if one is given.
 */
import pg from "pg";
import { readFile } from "node:fs/promises";
import { args } from "../lib.js";
import { toPostgres } from "../../src/postgres-port.js";

const { positional, flags } = args(process.argv.slice(2));
const [file, url, prefix] = positional;
const pages = JSON.parse(await readFile(file!, "utf8")) as {
  name: string;
  queries: { sql: string; params?: unknown[] }[];
}[];
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const query = pages
  .filter((p) => !flags.page || p.name === flags.page)
  .flatMap((p) => p.queries)
  .find((q) => squash(q.sql).startsWith(squash(prefix!)));
if (!query) throw new Error("no recorded query starts with that");

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("SET search_path = public, private");
let k = 0;
const ported = toPostgres(query.sql).replace(/\?/g, () => `$${++k}`);
if (flags.sql) console.log(ported, "\n", JSON.stringify(query.params ?? []));
const plan = await client.query({ text: `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${ported}`, values: query.params ?? [] });
for (const row of plan.rows) console.log(row["QUERY PLAN"]);
await client.end();
