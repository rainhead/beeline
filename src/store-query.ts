import { pathToFileURL } from "node:url";
import { queryCopyPathFrom } from "./app/config.js";
import {
  createQueryCopy,
  DEFAULT_MAX_ROWS,
  DEFAULT_TIMEOUT_MS,
  QueryCopyError,
  type QueryCopy,
  type QueryResult,
} from "./query-copy.js";

/**
 * CLI: pnpm store:query [options] "<one SELECT>"      (or `-` to read it from standard input)
 *
 * Ask last night's copy of the store a question, on the machine that holds
 * it (beeline-pnqr.4). On production that is over `fly ssh`
 * (docs/runbooks/deploy-fly.md), with the app running: the query reads the
 * copy the nightly backup keeps, never the live store, in a child process
 * that is killed at a time limit and a memory ceiling (src/query-copy.ts says
 * why each of those is so). It is what a lookup used to download a backup for.
 *
 * A command and not an HTTP endpoint on purpose (Peter, 2026-11-13). A server
 * that accepts SQL from the internet has one key and one check between a
 * stranger and a copy of everything, and the only user of this is someone who
 * already has a shell on the machine.
 *
 * The answer goes to standard output: a tab-separated table with a header
 * row, or the whole result as JSON with --json. When the copy was made, how
 * many rows, and whether the answer was cut short go to standard error, so
 * that piping the output keeps only the rows.
 */

const USAGE = `usage: pnpm store:query [options] "<one SELECT>"
       pnpm store:query [options] -          (read the statement from standard input)

  --json           print the whole result as JSON, not a table
  --rows <n>       stop after n rows (default ${DEFAULT_MAX_ROWS}, at most 50000)
  --timeout <s>    stop after s seconds (default ${DEFAULT_TIMEOUT_MS / 1000}, at most 60)
  --explain        print the query plan; the statement is not run
  --copy <path>    the copy to read (default: BEELINE_QUERY_COPY, or query-copy/ beside BEELINE_DB)`;

export interface StoreQueryArgs {
  sql: string | "-";
  json: boolean;
  maxRows?: number;
  timeoutMs?: number;
  explain: boolean;
  copy?: string;
}

/** The arguments, or a sentence saying what is wrong with them. */
export function parseArgs(argv: readonly string[]): StoreQueryArgs | { problem: string } {
  const args: StoreQueryArgs = { sql: "", json: false, explain: false };
  const statements: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string | undefined => argv[++i];
    if (a === "--json") args.json = true;
    else if (a === "--explain") args.explain = true;
    else if (a === "--rows") {
      const v = value();
      if (v === undefined || !/^\d+$/.test(v)) return { problem: "--rows takes a whole number" };
      args.maxRows = Number(v);
    } else if (a === "--timeout") {
      const v = value();
      if (v === undefined || !/^\d+(\.\d+)?$/.test(v)) return { problem: "--timeout takes a number of seconds" };
      args.timeoutMs = Math.round(Number(v) * 1000);
    } else if (a === "--copy") {
      const v = value();
      if (v === undefined) return { problem: "--copy takes a path" };
      args.copy = v;
    } else if (a !== "-" && a.startsWith("--")) return { problem: `unknown option ${a}` };
    else statements.push(a);
  }
  if (statements.length !== 1) {
    return { problem: statements.length === 0 ? "give one statement, or - to read it from standard input" : "give one statement, in quotes" };
  }
  args.sql = statements[0]!;
  return args;
}

/**
 * One value as a table cell. Tabs and line breaks inside a value are written
 * as \t and \n so a row stays one line and a column stays one column; NULL is
 * the word, as DuckDB prints it; a list or struct is its JSON.
 */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}

/** The result as tab-separated lines: a header row of column names, then the rows. */
export function table(result: QueryResult): string {
  const lines = [result.columns.map((c) => cell(c.name)).join("\t")];
  for (const row of result.rows) lines.push(row.map(cell).join("\t"));
  return `${lines.join("\n")}\n`;
}

/** What standard error says about an answer: how many rows, whether it was cut short, and how old the copy is. */
export function summary(result: QueryResult, now = new Date()): string {
  const rows = `${result.rows.length} row${result.rows.length === 1 ? "" : "s"}`;
  const cut =
    result.truncatedBy === "rows"
      ? ` (cut short at the row limit of ${result.limits.maxRows}; raise it with --rows)`
      : result.truncatedBy === "bytes"
        ? ` (cut short at ${result.limits.maxBytes} bytes of result; select fewer or narrower columns)`
        : "";
  const hours = (now.getTime() - new Date(result.copiedAt).getTime()) / 3_600_000;
  const age = hours < 48 ? `${Math.max(0, Math.round(hours))} hours ago` : `${Math.round(hours / 24)} days ago`;
  // A copy more than a day and a half old means a night's backup did not replace it.
  const stale = hours > 36 ? " — older than one night: check the store-backup job on /jobs" : "";
  return `${rows}${cut} in ${result.elapsedMs} ms, from the copy made ${result.copiedAt} (${age})${stale}`;
}

export interface StoreQueryIo {
  env: Record<string, string | undefined>;
  stdin: () => Promise<string>;
  out: (text: string) => void;
  err: (text: string) => void;
  /** The runner; a test passes its own. */
  queries?: (path: string) => QueryCopy;
}

/** Run the command. Returns the exit status: 0 answered, 1 the query failed, 2 the arguments were wrong. */
export async function storeQuery(argv: readonly string[], io: StoreQueryIo): Promise<number> {
  const args = parseArgs(argv);
  if ("problem" in args) {
    io.err(`${args.problem}\n${USAGE}\n`);
    return 2;
  }
  const sql = args.sql === "-" ? await io.stdin() : args.sql;
  const path = args.copy ?? queryCopyPathFrom(io.env);
  const queries = (io.queries ?? ((p: string) => createQueryCopy({ path: p })))(path);
  try {
    const result = await queries.run(sql, {
      ...(args.maxRows === undefined ? {} : { maxRows: args.maxRows }),
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      explain: args.explain,
    });
    io.out(args.json ? `${JSON.stringify(result)}\n` : table(result));
    io.err(`${summary(result)}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof QueryCopyError)) throw e;
    const hint = e.code === "no-copy" ? ` (looked at ${path}; the nightly store-backup job makes it)` : "";
    io.err(`${e.code}: ${e.message}${hint}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const status = await storeQuery(process.argv.slice(2), {
    env: process.env,
    stdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
  process.exit(status);
}
